import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import {
  LOCAL_TOKEN_BYTES,
  LOCAL_TOKEN_PATTERN,
  LOCAL_TOKEN_PREFIX,
  localTokenPath as packageLocalTokenPath,
  localTokenTempName,
  sweepStaleSealingTemps,
} from '@traderalice/sealing-key'
import type { Context, MiddlewareHandler } from 'hono'

import { userDataHome } from '../core/paths.js'

export async function resolveLocalToken(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return env['OPENALICE_LOCAL_TOKEN']?.trim() || await ensureLocalToken()
}

export function localTokenPath(home = userDataHome): string {
  return packageLocalTokenPath(home)
}

/** Validate type/owner/mode and read through the same descriptor. */
async function readPrivateToken(path: string): Promise<string> {
  const before = await lstat(path)
  if (before.isSymbolicLink()) throw new Error(`${path} must not be a symlink`)
  if (!before.isFile()) throw new Error(`${path} must be a regular file`)
  if (process.platform !== 'win32' && typeof process.getuid === 'function'
    && before.uid !== process.getuid()) {
    throw new Error(`${path} is not owned by the current user; refusing to use it`)
  }
  if (process.platform === 'win32') return (await readFile(path, 'utf8')).trim()
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
  const handle = await open(path, flags)
  try {
    const info = await handle.stat()
    if (info.dev !== before.dev || info.ino !== before.ino) {
      throw new Error(`${path} changed while it was being read`)
    }
    if ((info.mode & 0o077) !== 0) {
      await handle.chmod(0o600)
      const after = await handle.stat()
      if ((after.mode & 0o077) !== 0) {
        throw new Error(`${path} could not be made private; refusing to use it`)
      }
    }
    return (await handle.readFile('utf8')).trim()
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/** Read the local bearer token, or null when none has been provisioned. */
export async function readLocalToken(home = userDataHome): Promise<string | null> {
  const path = localTokenPath(home)
  try {
    // Validate and read through one descriptor: a path swap between the
    // checks and a separate readFile() could redirect the read to a FIFO.
    const raw = await readPrivateToken(path)
    if (!isValidToken(raw)) {
      throw new Error(`local auth token at ${path} is malformed; delete it and restart`)
    }
    return raw
  } catch (error: unknown) {
    if (isNodeError(error, 'ENOENT')) return null
    throw error
  }
}

/** Read a token that another process may have just published, then enforce
 *  its mode before returning it. A raced read must not bypass the private-mode
 *  check that the winning writer may not have completed yet. */
async function readRacedToken(home: string): Promise<string | null> {
  // readLocalToken validates and reads through one descriptor.
  return readLocalToken(home)
}

/** Atomically provision the local token. Concurrent first callers converge on
 *  the same value (O_EXCL create; the loser reads the winner's file). */
export async function ensureLocalToken(home = userDataHome): Promise<string> {
  // Token provisioning does not call readKey(); sweep crash-left plaintext
  // token temps here so an install that never reads a sealed config still
  // cleans them up.
  await sweepStaleSealingTemps(home)
  const existing = await readLocalToken(home)
  if (existing) {
    // A token restored from a backup or written by an older build may be
    // group/world-readable. Tighten it before returning it to any caller, but
    // do not abort startup when the mount is read-only and the mode is already
    // private.
    const existingPath = localTokenPath(home)
    await ensurePrivateMode(existingPath, 0o600, 'file')
    await ensurePrivateMode(dirname(existingPath), 0o700, 'dir')
    return existing
  }
  const path = localTokenPath(home)
  const authDir = dirname(path)
  await mkdir(authDir, { recursive: true, mode: 0o700 })
  await ensurePrivateMode(authDir, 0o700, 'dir')
  const token = LOCAL_TOKEN_PREFIX + randomBytes(LOCAL_TOKEN_BYTES).toString('base64url')
  const temp = localTokenTempName(path, process.pid, randomBytes(6).toString('hex'))
  try {
    await writeFile(temp, `${token}\n`, { mode: 0o600, flag: 'wx' })
    // link() is create-if-absent; rename() would let two first-run processes
    // replace each other's token and leave clients with a dead credential.
    await link(temp, path)
    await rm(temp, { force: true }).catch(() => undefined)
    await ensurePrivateMode(path, 0o600, 'file')
    return token
  } catch (error: unknown) {
    await rm(temp, { force: true }).catch(() => undefined)
    if (isNodeError(error, 'EEXIST') || isNodeError(error, 'ENOTEMPTY')) {
      const raced = await readRacedToken(home)
      if (raced) return raced
    }
    if (isLinkUnsupported(error)) {
      // exFAT/FAT32 and some SMB/NFS mounts reject hard links. Fall back to
      // O_EXCL create, which has the same create-if-absent semantics.
      try {
        await writeFile(path, `${token}\n`, { mode: 0o600, flag: 'wx' })
        await ensurePrivateMode(path, 0o600, 'file')
        return token
      } catch (writeError: unknown) {
        if (isNodeError(writeError, 'EEXIST')) {
          const raced = await readRacedToken(home)
          if (raced) return raced
        }
        throw writeError
      }
    }
    // A concurrent writer may have linked first; read and mode-check it.
    let raced: string | null = null
    try {
      raced = await readRacedToken(home)
    } catch (readError: unknown) {
      // Do not replace the original link/write failure with a secondary read
      // error; the original explains why this process could not provision.
      console.warn(`could not read the raced local token: ${readError instanceof Error ? readError.message : String(readError)}`)
    }
    if (raced) return raced
    throw error
  }
}

/** Constant-time check of the `Authorization: Bearer` or local header. */
export function hasValidLocalToken(c: Context, expected: string): boolean {
  const header = c.req.header('authorization')
  const match = header?.match(/^Bearer\s+(.+)$/i)
  const supplied = match?.[1]?.trim() || c.req.header('x-openalice-local-token')?.trim()
  if (!supplied) return false
  const a = Buffer.from(supplied)
  const b = Buffer.from(expected)
  if (a.length !== b.length) {
    // Keep the comparison time independent of length.
    timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest())
    return false
  }
  return timingSafeEqual(a, b)
}

export function localAuthMiddleware(expected: string): MiddlewareHandler {
  return async (c, next) => {
    if (!hasValidLocalToken(c, expected)) {
      return c.json({ error: 'unauthorized', message: 'local authentication required' }, 401)
    }
    await next()
  }
}

/** Headers for server-to-server loopback calls (broker-pack status, UTA). */
export async function localAuthHeaders(
  home = userDataHome,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, string>> {
  const token = env['OPENALICE_LOCAL_TOKEN']?.trim() || await readLocalToken(home)
  return token ? { authorization: `Bearer ${token}` } : {}
}

function isValidToken(value: string): boolean {
  return LOCAL_TOKEN_PATTERN.test(value)
}

/** Tighten a file/directory mode, but accept an already-private mode when the
 *  mount is read-only (a chmod failure must not abort startup).
 *
 *  Files must have no group/other bits; directories may be 0755 because the
 *  token inside is 0600, but must not be group/other writable. On Windows
 *  `stat().mode` is synthesized and cannot express ACLs, so accept the file
 *  after confirming it exists. A failed stat rethrows the original chmod
 *  error instead of masking the cause.
 *
 *  Deliberately local rather than reusing sealing-key's `ensureOwnerOnly`:
 *  this path tolerates read-only mounts with an already-private mode and has
 *  Windows-specific mode semantics, while sealing-key must always fail closed
 *  on a chmod error. */
async function ensurePrivateMode(path: string, mode: number, kind: 'file' | 'dir'): Promise<void> {
  // lstat, not stat: chmod/stat follow a symlink, so a symlinked token path
  // would let the caller validate and tighten an unrelated target. The token
  // path is app-owned; a symlink there is always a configuration error.
  const linkInfo = await lstat(path)
  if (linkInfo.isSymbolicLink()) throw new Error(`${path} must not be a symlink`)
  if (kind === 'file' && !linkInfo.isFile()) throw new Error(`${path} must be a regular file`)
  if (kind === 'dir' && !linkInfo.isDirectory()) throw new Error(`${path} must be a directory`)
  if (process.platform !== 'win32' && typeof process.getuid === 'function'
    && linkInfo.uid !== process.getuid()) {
    throw new Error(`${path} is not owned by the current user; refusing to use it`)
  }
  if (process.platform === 'win32') return
  // chmod(path) follows a symlink; operate on an open descriptor and verify it
  // is the same inode lstat just checked. A path swap after lstat then cannot
  // redirect the chmod/verification to another file.
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
  const handle = await open(path, flags)
  try {
    const opened = await handle.stat()
    if (opened.dev !== linkInfo.dev || opened.ino !== linkInfo.ino) {
      throw new Error(`${path} changed while it was being made private`)
    }
    const forbidden = kind === 'dir' ? 0o022 : 0o077
    if (kind === 'dir' ? (opened.mode & 0o777) === (mode & 0o777) : (opened.mode & forbidden) === 0) return
    let chmodError: unknown
    try {
      await handle.chmod(mode)
    } catch (error: unknown) {
      chmodError = error
    }
    // Always verify the resulting mode: some network filesystems accept chmod
    // and ignore it. Preserve the chmod error if stat fails.
    const info = await handle.stat().catch((statError: unknown) => { throw chmodError ?? statError })
    if ((info.mode & forbidden) !== 0) {
      // exFAT/NTFS mounts commonly ignore chmod. Name the mount option so the
      // failure is actionable instead of an unexplained startup refusal.
      const remediation = kind === 'file'
        ? 'Use a filesystem that supports POSIX file modes, or mount it with fmask=0077,dmask=0077.'
        : 'Use a filesystem that supports POSIX directory modes, or mount it with dmask=0077.'
      if (chmodError !== undefined) {
        throw new Error(
          `${path} could not be made private (${chmodError instanceof Error ? chmodError.message : String(chmodError)}); refusing to use it. ${remediation}`,
          { cause: chmodError },
        )
      }
      throw new Error(`${path} is still group/world accessible after chmod; refusing to use it. ${remediation}`)
    }
  } finally {
    await handle.close().catch(() => undefined)
  }
}

function isLinkUnsupported(error: unknown): boolean {
  return isNodeError(error, 'EPERM')
    || isNodeError(error, 'EOPNOTSUPP')
    || isNodeError(error, 'ENOTSUP')
    || isNodeError(error, 'ENOSYS')
    || isNodeError(error, 'EXDEV')
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}
