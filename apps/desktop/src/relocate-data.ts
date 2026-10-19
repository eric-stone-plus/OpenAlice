/**
 * One-time relocation of the packaged app's user data store.
 *
 * Until the global-root change, the packaged backend kept user data under
 * Electron's userData dir (~/Library/Application Support/OpenAlice/data on
 * macOS). The user-data home is now ~/.openalice — shared with `pnpm dev`
 * and bare `pnpm start` — so an existing store must move once, before the
 * shell reads ports.json from the new root or spawns the backend (which
 * would run migrations against an empty store).
 *
 * Scope: `<userData>/data` plus the machine-bound key files that live beside
 * it. userData also holds Electron's browser-profile state (Cache, Local
 * Storage, …) which must stay.
 *
 * Crash safety:
 *   - same-volume: a single rename — atomic, nothing to clean up.
 *   - cross-volume (EXDEV): copy into `<newRoot>/.data.relocating`, then
 *     rename into place. A crash mid-copy leaves only the tmp dir, which is
 *     swept and re-copied on next boot; a crash after the commit rename is
 *     absorbed by the idempotency guard. The legacy dir is kept as
 *     `data.relocated` — never deleted, it's the user's trading history.
 *   - key files are copied to a unique temp path and linked into place, so a
 *     crash cannot leave a half-written key at the final path.
 */

import { existsSync } from 'node:fs'
import { chmod, cp, link, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'

import {
  readKey,
  sealingKeyCredentialPath,
  sealingKeyFingerprintPath,
  sealingKeyPath,
} from '@traderalice/sealing-key'

export async function relocateLegacyData(legacyRoot: string, newRoot: string): Promise<'moved' | 'skipped'> {
  if (resolve(legacyRoot) === resolve(newRoot)) return 'skipped'
  try {
    if (await realpath(legacyRoot) === await realpath(newRoot)) return 'skipped'
  } catch {
    // One side may not exist yet; the lexical check above is enough.
  }
  const legacyData = join(legacyRoot, 'data')
  const newData = join(newRoot, 'data')
  let moved = false
  let dataMoved = false
  let keysMoved = false
  const keyFiles = [
    [sealingKeyPath(legacyRoot), sealingKeyPath(newRoot)],
    [sealingKeyCredentialPath(legacyRoot), sealingKeyCredentialPath(newRoot)],
  ] as const
  const fingerprintFiles = [
    [sealingKeyFingerprintPath(legacyRoot), sealingKeyFingerprintPath(newRoot)],
  ] as const
  const keyTargetExists = keyFiles.some(([, to]) => existsSync(to))
  const legacyKeyPresent = keyFiles.some(([from]) => existsSync(from))
    || fingerprintFiles.some(([from]) => existsSync(from))
  if (!existsSync(legacyData) && !legacyKeyPresent && !existsSync(join(legacyRoot, 'provider-keys.json'))) {
    return 'skipped'
  }
  await sweepStaleRelocationTemps(newRoot)
  const failures: string[] = []

  // The destination may already have a key (a dev/pnpm-start session, or a
  // previous relocation). Moving sealed data under a different key would make
  // every sealed store unreadable, so compare the keys before touching data.
  let keysCompatible = !keyTargetExists
  let keyComparisonError: string | null = null
  if (keyTargetExists) {
    try {
      const destinationKey = await readKey(newRoot, process.env, { migrate: false })
      let legacyKey: Buffer | null = null
      try {
        legacyKey = await readKey(legacyRoot, process.env, { migrate: false })
      } catch (error: unknown) {
        keyComparisonError = error instanceof Error ? error.message : String(error)
      }
      if (!legacyKey) {
        // The key was already moved by an earlier run and the data followed
        // it; the destination key is authoritative. If legacy data is still
        // present, only the marker written after a successful key move proves
        // that the destination key is the one that belongs to it.
        const keyMoved = existsSync(join(legacyRoot, 'KEY-MOVED.txt'))
        const dataAlreadyMoved = existsSync(newData) && !existsSync(legacyData)
        if ((dataAlreadyMoved || keyMoved) && destinationKey) {
          keysCompatible = true
        } else {
          keysCompatible = false
          keyComparisonError ??= 'the legacy sealing key is missing'
        }
      } else {
        keysCompatible = !!destinationKey && legacyKey.equals(destinationKey)
        if (!keysCompatible) keyComparisonError ??= 'the legacy and destination keys differ'
      }
    } catch (error: unknown) {
      keysCompatible = false
      keyComparisonError = error instanceof Error ? error.message : String(error)
    }
    for (const [, to] of keyFiles) {
      try {
        if ((await lstat(to)).isSymbolicLink()) {
          keysCompatible = false
          keyComparisonError = `${to} is a symbolic link, not a regular key file`
          failures.push(keyComparisonError)
        }
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          failures.push(`${to}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
  }

  // The machine key lives beside data/, not inside it. Move the legacy
  // plaintext key and encrypted credential with the store so sealed files
  // remain readable. The two key forms are one unit: if the destination
  // already has either form, do not add the other form beside it (that would
  // create an ambiguous key pair). Provider keys are independent.
  if (!keyTargetExists) {
    for (const [from, to] of keyFiles) {
      try {
        if (await moveIfAbsent(from, to)) {
          moved = true
          keysMoved = true
        }
      } catch (error: unknown) {
        failures.push(`${from}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (keysMoved && failures.length === 0) {
      await writeFile(
        join(legacyRoot, 'KEY-MOVED.txt'),
        `OpenAlice moved the sealing key to ${newRoot} on ${new Date().toISOString()}\n`,
      ).catch(() => undefined)
    }
    for (const [from, to] of fingerprintFiles) {
      try {
        if (await moveIfAbsent(from, to)) moved = true
      } catch (error: unknown) {
        // The fingerprint is a verifier, not key material; a failure must not
        // block the key/data move, and the next read recreates it.
        console.warn(`[relocate] could not move ${from}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  } else {
    // If the destination key is the same, a legacy plaintext copy is
    // redundant; remove it instead of leaving a readable copy in the old
    // userData directory. If anything is ambiguous, keep it and write the
    // marker below.
    if (keysCompatible) {
      // A crash during a previous copy may have left the destination key
      // group/other-readable. Fix the mode before removing the legacy copy.
      let destinationModesOk = true
      for (const [, to] of keyFiles) {
        if (!existsSync(to)) continue
        try {
          await ensurePrivateMode(to)
        } catch (error: unknown) {
          destinationModesOk = false
          failures.push(`${to}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (destinationModesOk) {
        let keysRemoved = false
        for (const [from] of keyFiles) {
          if (!existsSync(from)) continue
          try {
            await rm(from, { force: true })
            keysRemoved = true
            console.warn(`[relocate] removed the redundant legacy key at ${from}`)
          } catch (error: unknown) {
            failures.push(`${from}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        if (keysRemoved && failures.length === 0) {
          await writeFile(
            join(legacyRoot, 'KEY-MOVED.txt'),
            `OpenAlice verified the destination key at ${newRoot} on ${new Date().toISOString()}\n`,
          ).catch(() => undefined)
        }
        for (const [from, to] of fingerprintFiles) {
          if (!existsSync(from)) continue
          try {
            if (!existsSync(to)) await moveIfAbsent(from, to)
            else await rm(from, { force: true })
          } catch (error: unknown) {
            console.warn(`[relocate] could not remove ${from}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      }
    }
    const leftovers = keyFiles.map(([from]) => from).filter((from) => existsSync(from))
    if (leftovers.length > 0) {
      console.warn(`[relocate] destination already has a sealing key; leaving legacy key at ${leftovers.join(', ')}`)
      await writeFile(
        join(legacyRoot, 'KEY-NOT-MOVED.txt'),
        'OpenAlice found a sealing key in the destination home and did not move this legacy key:\n' +
        `${leftovers.join('\n')}\n\n` +
        'Do not delete it until you have verified that the destination key opens the sealed files.\n',
      ).catch(() => undefined)
    }
  }
  // Move the sealed store only after the key handling has finished. A key
  // that could not be moved or a key pair that does not match would leave the
  // moved data unreadable.
  if (existsSync(legacyData) && !existsSync(newData)) {
    if (failures.length > 0) {
      console.warn('[relocate] sealing key handling failed; leaving legacy data in place')
      await writeFile(
        join(legacyRoot, 'DATA-NOT-MOVED.txt'),
        `OpenAlice could not relocate the sealing key, so it did not move the legacy data at ${legacyData}.\n` +
        `Reason: ${failures.join('; ')}\n`,
      ).catch(() => undefined)
    } else if (!keysCompatible) {
      // Do not abort startup on every launch: the destination store is
      // usable, and the legacy data can be merged after the user verifies
      // which key owns it. Mark the legacy root instead.
      console.warn(`[relocate] sealing keys differ; leaving legacy data at ${legacyData}`)
      await writeFile(
        join(legacyRoot, 'DATA-NOT-MOVED.txt'),
        `OpenAlice could not verify that the legacy sealing key opens ${legacyData}, so it did not move that data.\n` +
        `Destination: ${newRoot}.${keyComparisonError ? ` Reason: ${keyComparisonError}.` : ''}\n` +
        'Verify which key opens the sealed files before merging or deleting either store.\n',
      ).catch(() => undefined)
    } else {
      await mkdir(newRoot, { recursive: true })
      const tmp = join(newRoot, '.data.relocating')
      await rm(tmp, { recursive: true, force: true }) // sweep a stale partial copy

      try {
        await rename(legacyData, newData) // atomic same-volume fast path
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
        await cp(legacyData, tmp, { recursive: true })
        await rename(tmp, newData) // atomic commit
        await rename(legacyData, `${legacyData}.relocated`) // keep as backup
      }
      moved = true
      dataMoved = true
    }
  }

  if (keysCompatible && failures.length === 0) {
    const providerFrom = join(legacyRoot, 'provider-keys.json')
    const providerTo = join(newRoot, 'provider-keys.json')
    try {
      if (existsSync(providerFrom) && existsSync(providerTo) && !(await sameContents(providerFrom, providerTo))) {
        console.warn(`[relocate] destination already has a different provider-keys.json; leaving ${providerFrom}`)
      }
      if (await moveIfAbsent(providerFrom, providerTo)) moved = true
    } catch (error: unknown) {
      failures.push(`provider-keys.json: ${error instanceof Error ? error.message : String(error)}`)
    }
  } else if (existsSync(join(legacyRoot, 'provider-keys.json'))) {
    console.warn('[relocate] sealing keys differ; leaving the sealed legacy provider-keys.json in place')
    await writeFile(
      join(legacyRoot, 'PROVIDER-KEYS-NOT-MOVED.txt'),
      'OpenAlice did not move provider-keys.json because the sealing keys could not be verified.\n' +
      'Do not copy it into the destination until you have verified which key opens it.\n',
    ).catch(() => undefined)
  }

  if (dataMoved) {
    await writeFile(
      join(legacyRoot, 'DATA-MOVED.txt'),
      `OpenAlice user data moved to ${newData} on ${new Date().toISOString()}\n`,
    )
  }
  if (failures.length > 0) {
    throw new Error(`These files could not be relocated: ${failures.join('; ')}`)
  }
  return moved ? 'moved' : 'skipped'
}

async function sweepStaleRelocationTemps(root: string): Promise<void> {
  const cutoff = Date.now() - 60 * 60 * 1000
  for (const dir of [root, join(root, 'state')]) {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.startsWith('.relocate-') || !name.endsWith('.tmp')) continue
      const path = join(dir, name)
      try {
        const info = await stat(path)
        if (info.mtimeMs < cutoff) {
          await rm(path, { force: true })
          console.warn(`[relocate] removed a stale temporary key file at ${path}`)
        }
      } catch {
        // Another process may have removed it first.
      }
    }
  }
}

async function moveIfAbsent(from: string, to: string): Promise<boolean> {
  if (!existsSync(from)) return false
  if (resolve(from) === resolve(to)) return false
  try {
    if (await realpath(from) === await realpath(to)) return false
  } catch {
    // The destination may not exist yet; the lexical check above is enough.
  }
  if (existsSync(to)) {
    if (await sameContents(from, to)) {
      await ensurePrivateMode(to)
      await removeSource(from)
    }
    return false
  }
  await mkdir(dirname(to), { recursive: true, mode: 0o700 })
  const temporary = join(dirname(to), `.relocate-${basename(to)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    // Create the temp with 0600 from the first byte; copyFile would create it
    // under the process umask and leave a window where a crash exposes a
    // world-readable key.
    const data = await readFile(from)
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(data)
    } finally {
      await handle.close()
    }
    // The key is only as private as its mode; a chmod failure is a failed
    // move, not a warning.
    await ensurePrivateMode(temporary)
    try {
      await link(temporary, to)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        if (await sameContents(from, to)) {
          await ensurePrivateMode(to)
          await removeSource(from)
        }
        return false
      }
      // Some filesystems reject hard links. Rename the already-private temp
      // into place instead of copyFile(): copyFile creates the final path
      // under the process umask and a crash mid-copy leaves a truncated key
      // that the next boot would trust. The existence check above is repeated
      // here because the window is the only remaining race on such filesystems.
      if (!['EPERM', 'EOPNOTSUPP', 'ENOTSUP', 'EXDEV', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      if (existsSync(to)) {
        if (await sameContents(from, to)) {
          await ensurePrivateMode(to)
          await removeSource(from)
        }
        return false
      }
      try {
        await rename(temporary, to)
        await ensurePrivateMode(to)
      } catch (renameError: unknown) {
        if ((renameError as NodeJS.ErrnoException).code === 'EEXIST') {
          if (await sameContents(from, to)) {
            await ensurePrivateMode(to)
            await removeSource(from)
          }
          return false
        }
        throw renameError
      }
    }
    await removeSource(from)
    return true
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

/** A key or credential file must never be group/other readable. If chmod is
 *  rejected, accept an already-private mode and fail otherwise. */
async function ensurePrivateMode(path: string): Promise<void> {
  try {
    await chmod(path, 0o600)
  } catch (error: unknown) {
    const info = await stat(path)
    if ((info.mode & 0o077) === 0) return
    throw error
  }
}

async function removeSource(from: string): Promise<void> {
  try {
    await rm(from, { force: true })
  } catch (error: unknown) {
    // The destination is already complete; a stale source is a cleanup
    // residue, not a failed move. Report it without exposing key material.
    console.warn(`[relocate] moved ${from}, but could not remove the legacy copy: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function sameContents(a: string, b: string): Promise<boolean> {
  try {
    const [left, right] = await Promise.all([readFile(a), readFile(b)])
    return left.equals(right)
  } catch {
    return false
  }
}
