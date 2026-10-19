import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, link, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { Context, MiddlewareHandler } from 'hono'

import { userDataHome } from '../core/paths.js'

const TOKEN_BYTES = 32
const TOKEN_PREFIX = 'oa1_'
const TOKEN_FILE = join('auth', 'local.token')
const TOKEN_PATTERN = new RegExp(`^${TOKEN_PREFIX}[A-Za-z0-9_-]{${Math.ceil((TOKEN_BYTES * 4) / 3)}}$`)

export async function resolveLocalToken(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return env['OPENALICE_LOCAL_TOKEN']?.trim() || await ensureLocalToken()
}

export function localTokenPath(home = userDataHome): string {
  return join(home, TOKEN_FILE)
}

/** Read the local bearer token, or null when none has been provisioned. */
export async function readLocalToken(home = userDataHome): Promise<string | null> {
  try {
    const raw = (await readFile(localTokenPath(home), 'utf8')).trim()
    if (!isValidToken(raw)) {
      throw new Error(`local auth token at ${localTokenPath(home)} is malformed; delete it and restart`)
    }
    return raw
  } catch (error: unknown) {
    if (isNodeError(error, 'ENOENT')) return null
    throw error
  }
}

/** Atomically provision the local token. Concurrent first callers converge on
 *  the same value (O_EXCL create; the loser reads the winner's file). */
export async function ensureLocalToken(home = userDataHome): Promise<string> {
  const existing = await readLocalToken(home)
  if (existing) {
    // A token restored from a backup or written by an older build may be
    // group/world-readable. Tighten it before returning it to any caller.
    await chmod(localTokenPath(home), 0o600)
    return existing
  }
  const path = localTokenPath(home)
  await mkdir(join(home, 'auth'), { recursive: true, mode: 0o700 })
  await chmod(join(home, 'auth'), 0o700)
  const token = TOKEN_PREFIX + randomBytes(TOKEN_BYTES).toString('base64url')
  const temp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temp, `${token}\n`, { mode: 0o600, flag: 'wx' })
    // link() is create-if-absent; rename() would let two first-run processes
    // replace each other's token and leave clients with a dead credential.
    await link(temp, path)
    await rm(temp, { force: true }).catch(() => undefined)
    await chmod(path, 0o600)
    return token
  } catch (error: unknown) {
    await rm(temp, { force: true }).catch(() => undefined)
    if (isNodeError(error, 'EEXIST') || isNodeError(error, 'ENOTEMPTY')) {
      const raced = await readLocalToken(home)
      if (raced) return raced
    }
    if (isLinkUnsupported(error)) {
      // exFAT/FAT32 and some SMB/NFS mounts reject hard links. Fall back to
      // O_EXCL create, which has the same create-if-absent semantics.
      try {
        await writeFile(path, `${token}\n`, { mode: 0o600, flag: 'wx' })
        await chmod(path, 0o600)
        return token
      } catch (writeError: unknown) {
        if (isNodeError(writeError, 'EEXIST')) {
          const raced = await readLocalToken(home)
          if (raced) return raced
        }
        throw writeError
      }
    }
    // A concurrent writer may have linked first; read it.
    const raced = await readLocalToken(home).catch(() => null)
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
  return TOKEN_PATTERN.test(value)
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
