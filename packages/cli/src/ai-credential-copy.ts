/**
 * Copy AI vault credentials between AliceProject complete homes.
 *
 * The vault is `<home>/data/config/ai-provider-manager.json`. Broker
 * accounts and sealing keys stay untouched. Secrets are never logged.
 */
import { chmod, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'

const ALG = 'aes-256-gcm'
const KEY_BYTES = 32
const IV_BYTES = 12

interface SealedEnvelope {
  $sealed: 1
  alg: string
  iv: string
  tag: string
  data: string
}

export const AI_PROVIDER_FILE_REL = join('data', 'config', 'ai-provider-manager.json')

export interface AiCredentialRecord {
  vendor: string
  authType?: string
  apiKey?: string
  label?: string
  wires?: Record<string, string>
  baseUrl?: string
  wireShape?: string
  lastModel?: string
}

export interface AiProviderVault {
  credentials: Record<string, AiCredentialRecord>
  [key: string]: unknown
}

export interface AiCredentialCopyPlan {
  copied: string[]
  skipped: string[]
  renamed: Array<{ from: string; to: string }>
}

export interface AiCredentialCopyResult extends AiCredentialCopyPlan {
  fromKey: string
  toKey: string
  fromHome: string
  toHome: string
}

export function credentialIdentity(credential: AiCredentialRecord): string {
  return `${credential.vendor}\0${credential.authType ?? ''}\0${credential.apiKey ?? ''}`
}

export function allocateCredentialSlug(vendor: string, taken: Set<string>): string {
  const prefix = vendor.trim() || 'custom'
  let n = 1
  while (taken.has(`${prefix}-${n}`)) n += 1
  return `${prefix}-${n}`
}

export function mergeAiCredentials(
  source: Record<string, AiCredentialRecord>,
  dest: Record<string, AiCredentialRecord>,
): { credentials: Record<string, AiCredentialRecord> } & AiCredentialCopyPlan {
  const destByIdentity = new Map(
    Object.entries(dest).map(([slug, credential]) => [credentialIdentity(credential), slug]),
  )
  const taken = new Set(Object.keys(dest))
  const credentials = { ...dest }
  const copied: string[] = []
  const skipped: string[] = []
  const renamed: Array<{ from: string; to: string }> = []

  for (const [slug, credential] of Object.entries(source)) {
    if (!isCopyableCredential(credential)) continue
    const existing = destByIdentity.get(credentialIdentity(credential))
    if (existing) {
      skipped.push(slug)
      continue
    }
    let destSlug = slug
    if (taken.has(destSlug)) {
      destSlug = allocateCredentialSlug(credential.vendor, taken)
      renamed.push({ from: slug, to: destSlug })
    }
    credentials[destSlug] = { ...credential }
    taken.add(destSlug)
    destByIdentity.set(credentialIdentity(credential), destSlug)
    copied.push(destSlug)
  }
  return { credentials, copied, skipped, renamed }
}

export async function readAiProviderVault(home: string): Promise<AiProviderVault> {
  const path = join(home, AI_PROVIDER_FILE_REL)
  try {
    return parseAiProviderVault(await readSealedJson(home, path))
  } catch (error: unknown) {
    if (isNodeError(error, 'ENOENT')) return { credentials: {} }
    throw Object.assign(
      new Error(`Could not read AI credentials at ${path}: ${errorMessage(error)}`),
      { code: 'EAIVAULT', exitCode: 1 },
    )
  }
}

export async function writeAiProviderVault(home: string, vault: AiProviderVault): Promise<void> {
  const path = join(home, AI_PROVIDER_FILE_REL)
  try {
    await writeSealedJson(home, path, vault)
  } catch (error: unknown) {
    throw Object.assign(
      new Error(`Could not write AI credentials at ${path}: ${errorMessage(error)}`),
      { code: 'EAIVAULT', exitCode: 1 },
    )
  }
}

function isSealedMarker(value: unknown): value is Record<string, unknown> {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as Record<string, unknown>)['$sealed'] === 1
}

function isSealedEnvelope(value: unknown): value is SealedEnvelope {
  if (!isSealedMarker(value)) return false
  return typeof value['alg'] === 'string'
    && typeof value['iv'] === 'string'
    && typeof value['tag'] === 'string'
    && typeof value['data'] === 'string'
}

async function readKey(home: string): Promise<Buffer | undefined> {
  try {
    const key = Buffer.from((await readFile(join(home, 'sealing.key'), 'utf8')).trim(), 'base64')
    if (key.length !== KEY_BYTES) throw new Error(`sealing key at ${join(home, 'sealing.key')} is malformed`)
    return key
  } catch (error: unknown) {
    if (isNodeError(error, 'ENOENT')) return undefined
    throw error
  }
}

async function loadOrCreateKey(home: string): Promise<Buffer> {
  const existing = await readKey(home)
  if (existing) return existing
  const path = join(home, 'sealing.key')
  const key = randomBytes(KEY_BYTES)
  await mkdir(join(home), { recursive: true, mode: 0o700 })
  try {
    await writeFile(path, `${key.toString('base64')}\n`, { mode: 0o600, flag: 'wx' })
    await chmod(path, 0o600).catch(() => undefined)
    return key
  } catch (error: unknown) {
    if (isNodeError(error, 'EEXIST')) {
      const raced = await readKey(home)
      if (raced) return raced
    }
    throw error
  }
}

async function readSealedJson(home: string, path: string): Promise<unknown> {
  const value = JSON.parse(await readFile(path, 'utf8')) as unknown
  if (!isSealedMarker(value)) return value
  if (!isSealedEnvelope(value)) {
    throw new Error(`sealed file at ${path} is malformed`)
  }
  if (value.alg !== ALG) {
    throw new Error(`sealed file at ${path} uses unsupported algorithm "${value.alg}"`)
  }
  const key = await readKey(home)
  if (!key) throw new Error(`sealed file requires the machine key at ${join(home, 'sealing.key')}`)
  const decipher = createDecipheriv(ALG, key, Buffer.from(value.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(value.tag, 'base64'))
  const plaintext = Buffer.concat([decipher.update(Buffer.from(value.data, 'base64')), decipher.final()])
  return JSON.parse(plaintext.toString('utf8')) as unknown
}

async function writeSealedJson(home: string, path: string, value: unknown): Promise<void> {
  const dir = dirname(path)
  const key = await loadOrCreateKey(home)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALG, key, iv)
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8')
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const envelope: SealedEnvelope = {
    $sealed: 1,
    alg: ALG,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  }
  const temporary = join(dir, `.ai-provider-manager.${process.pid}.${randomUUID()}.tmp`)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  try {
    await writeFile(temporary, `${JSON.stringify(envelope, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await rename(temporary, path)
    await chmod(path, 0o600).catch(() => undefined)
  } catch (error: unknown) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

export async function copyAiCredentials(input: {
  fromKey: string
  toKey: string
  fromHome: string
  toHome: string
}): Promise<AiCredentialCopyResult> {
  if (input.fromKey === input.toKey) {
    throw Object.assign(new Error('Source and destination AliceProjects must be different.'), {
      code: 'EUSAGE',
      exitCode: 2,
    })
  }
  if (await sameHome(input.fromHome, input.toHome)) {
    throw Object.assign(new Error('Source and destination use the same complete home.'), {
      code: 'EUSAGE',
      exitCode: 2,
    })
  }
  const source = await readAiProviderVault(input.fromHome)
  const dest = await readAiProviderVault(input.toHome)
  const merged = mergeAiCredentials(source.credentials, dest.credentials)
  if (merged.copied.length > 0) {
    await writeAiProviderVault(input.toHome, {
      ...dest,
      credentials: merged.credentials,
    })
  }
  return {
    fromKey: input.fromKey,
    toKey: input.toKey,
    fromHome: input.fromHome,
    toHome: input.toHome,
    copied: merged.copied,
    skipped: merged.skipped,
    renamed: merged.renamed,
  }
}

export function formatAiCredentialCopyResult(result: AiCredentialCopyResult): string {
  const lines = [
    `Copied AI credentials from ${result.fromKey} to ${result.toKey}.`,
    `Added ${result.copied.length}, skipped ${result.skipped.length} already present.`,
  ]
  if (result.renamed.length > 0) {
    lines.push(
      `Renamed colliding slugs: ${result.renamed.map((entry) => `${entry.from} → ${entry.to}`).join(', ')}.`,
    )
  }
  if (result.copied.length === 0 && result.skipped.length === 0) {
    return `No AI credentials in ${result.fromKey} to copy.\n`
  }
  return `${lines.join('\n')}\n`
}

export function parseAiProviderVault(value: unknown): AiProviderVault {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { credentials: {} }
  }
  const root = value as Record<string, unknown>
  const credentials: Record<string, AiCredentialRecord> = {}
  if (root.credentials && typeof root.credentials === 'object' && !Array.isArray(root.credentials)) {
    for (const [slug, raw] of Object.entries(root.credentials as Record<string, unknown>)) {
      if (!slug || typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
      const record = raw as Record<string, unknown>
      if (typeof record.vendor !== 'string' || !record.vendor.trim()) continue
      credentials[slug] = {
        ...(record as unknown as AiCredentialRecord),
        vendor: record.vendor,
      }
    }
  }
  return {
    ...root,
    credentials,
  }
}

function isCopyableCredential(credential: AiCredentialRecord): boolean {
  return typeof credential.vendor === 'string' && credential.vendor.trim().length > 0
}

async function sameHome(left: string, right: string): Promise<boolean> {
  try {
    return await realpath(left) === await realpath(right)
  } catch {
    return join(left) === join(right)
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
