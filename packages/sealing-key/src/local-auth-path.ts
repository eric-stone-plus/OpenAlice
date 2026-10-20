import { basename, join } from 'node:path'

/**
 * Relative path of the per-home local bearer token. Kept beside the sealing
 * key helpers so the server, CLI, and connector do not grow independent
 * copies of the same security-sensitive path.
 */
export const LOCAL_TOKEN_RELATIVE_PATH = join('auth', 'local.token')

/** Shared token contract: server minting and every reader must agree. */
export const LOCAL_TOKEN_PREFIX = 'oa1_'
export const LOCAL_TOKEN_BYTES = 32

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export const LOCAL_TOKEN_PATTERN = new RegExp(
  `^${escapeRegExp(LOCAL_TOKEN_PREFIX)}[A-Za-z0-9_-]{${Math.ceil((LOCAL_TOKEN_BYTES * 4) / 3)}}$`,
)

/** Temp id is 6 random bytes hex-encoded; the exact width lets the sweeper
 *  distinguish app temp files from user backups with similar names. */
const LOCAL_TOKEN_TEMP_ID = '[0-9a-f]{12}'
const LOCAL_TOKEN_TEMP_ID_RE = new RegExp(`^${LOCAL_TOKEN_TEMP_ID}$`)

export function localTokenTempName(path: string, pid: number, id: string): string {
  if (basename(path) !== basename(LOCAL_TOKEN_RELATIVE_PATH)) {
    throw new Error(`local token temp path must end with ${LOCAL_TOKEN_RELATIVE_PATH}`)
  }
  if (!LOCAL_TOKEN_TEMP_ID_RE.test(id)) {
    throw new Error('local token temp id must be 12 lowercase hex characters')
  }
  return `${path}.${pid}.${id}.tmp`
}

export function localTokenTempPid(name: string): number | null {
  const match = new RegExp(
    `^${escapeRegExp(basename(LOCAL_TOKEN_RELATIVE_PATH))}\\.(\\d+)\\.${LOCAL_TOKEN_TEMP_ID}\\.tmp$`,
  ).exec(name)
  return match ? Number(match[1]) : null
}

export function localTokenPath(home: string): string {
  return join(home, LOCAL_TOKEN_RELATIVE_PATH)
}
