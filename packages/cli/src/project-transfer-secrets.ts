/** Secret-plane helpers for AliceProject transfer.
 *
 * Secret values are deliberately kept out of the ordinary file manifest.
 * They may exist only in source-process memory, the authenticated SSH stdin
 * stream, and a freshly sealed destination file.
 */
import {
  randomBytes,
} from 'node:crypto'
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  isSealedEnvelope,
  sealAt,
  SEALING_ALG,
  unsealAt,
} from '@traderalice/sealing-key'

import {
  readAiProviderVault,
  type AiProviderVault,
} from './ai-credential-copy.ts'

export interface ProjectTransferCredentialBundle {
  ai: ProjectTransferAiVault
  brokerAccounts: unknown[]
  connectors: Record<string, unknown>
  providerKeys: Record<string, string>
  /** Non-secret market-data settings, with providerKeys moved into the map above. */
  marketData: Record<string, unknown>
}

export interface ProjectTransferAiVault extends AiProviderVault {
  apiKeys: Record<string, string>
}

export interface ProjectTransferCredentialSummary {
  ai: { count: number; vendors: string[] }
  broker: { count: number; presets: string[] }
  connector: { count: number; adapters: string[] }
  providerKeys: { count: number; vendors: string[] }
}

export async function readProjectTransferCredentialBundle(
  home: string,
): Promise<ProjectTransferCredentialBundle> {
  const [aiVault, brokerValue, connectorValue, globalProviderKeys, marketData] = await Promise.all([
    readAiProviderVault(home),
    readOptionalSecretJson(home, join('data', 'config', 'accounts.json')),
    readOptionalSecretJson(home, join('data', 'config', 'connectors.json')),
    readOptionalSecretJson(home, 'provider-keys.json'),
    readOptionalSecretJson(home, join('data', 'config', 'market-data.json')),
  ])
  const marketDataRecord = recordValue(marketData)
  const marketDataSettings = { ...marketDataRecord }
  delete marketDataSettings['providerKeys']
  return {
    ai: normalizeProjectTransferAiVault(aiVault),
    brokerAccounts: Array.isArray(brokerValue) ? brokerValue : [],
    connectors: recordValue(connectorValue),
    providerKeys: stringMap({
      ...recordValue(globalProviderKeys),
      ...recordValue(marketDataRecord['providerKeys']),
    }),
    marketData: marketDataSettings,
  }
}

export function summarizeProjectTransferCredentials(
  bundle: ProjectTransferCredentialBundle,
): ProjectTransferCredentialSummary {
  const aiVendors = new Set<string>()
  for (const value of Object.values(bundle.ai.credentials)) {
    if (typeof value.vendor === 'string' && value.vendor.trim()) aiVendors.add(value.vendor)
  }
  for (const vendor of Object.keys(bundle.ai.apiKeys)) aiVendors.add(vendor)
  const brokerPresets = new Set<string>()
  for (const value of bundle.brokerAccounts) {
    const record = recordValue(value)
    const preset = record['presetId'] ?? record['type'] ?? record['id']
    if (typeof preset === 'string' && preset.trim()) brokerPresets.add(preset)
  }
  const connectorRoot = recordValue(bundle.connectors['adapters'])
  return {
    ai: {
      count: Object.keys(bundle.ai.credentials).length + Object.keys(bundle.ai.apiKeys).length,
      vendors: [...aiVendors].sort(),
    },
    broker: {
      count: bundle.brokerAccounts.length,
      presets: [...brokerPresets].sort(),
    },
    connector: {
      count: Object.keys(connectorRoot).length,
      adapters: Object.keys(connectorRoot).sort(),
    },
    providerKeys: {
      count: Object.keys(bundle.providerKeys).length,
      vendors: Object.keys(bundle.providerKeys).sort(),
    },
  }
}

/**
 * Legacy flat API keys are still a supported read shape. Normalize them into
 * an explicit string-only map before they enter the private transfer bundle so
 * they are counted, transported only on SSH stdin, and never left behind in
 * the portable AI configuration file.
 */
export function normalizeProjectTransferAiVault(vault: AiProviderVault): ProjectTransferAiVault {
  return {
    ...vault,
    apiKeys: stringMap(recordValue(vault['apiKeys'])),
  }
}

export async function sealProjectTransferJson(
  home: string,
  relativePath: string,
  value: unknown,
): Promise<void> {
  const envelope = await sealAt(home, value)
  await writePrivateJson(join(home, relativePath), envelope)
}

async function readOptionalSecretJson(home: string, relativePath: string): Promise<unknown> {
  const value = await readOptionalJson(join(home, relativePath))
  return unsealProjectTransferJson(home, value, relativePath)
}

/**
 * Decrypt a sealed JSON value with the Home's machine key. Exported because
 * portable-file transforms run on raw bytes and must unseal before stripping
 * credentials; copying the envelope verbatim would ship ciphertext that the
 * destination cannot decrypt and would defeat the strip transform.
 */
export async function unsealProjectTransferJson(
  home: string,
  value: unknown,
  label = 'credential configuration',
): Promise<unknown> {
  if (!isSealedMarker(value)) return value
  if (!isSealedEnvelope(value)) {
    throw transferSecretError(`${label} is a malformed sealed envelope.`)
  }
  if (value.alg !== SEALING_ALG) {
    throw transferSecretError(`${label} uses unsupported sealing algorithm "${value.alg}".`)
  }
  try {
    // Transfer must not migrate or delete keys in the source home.
    return await unsealAt(home, value, process.env, { migrate: false })
  } catch (error: unknown) {
    // Keep CLI output free of internal key paths and systemd stderr; the
    // cause is retained for the caller's diagnostic log.
    throw transferSecretError(`${label} could not be unsealed with the source home's sealing key.`, error)
  }
}

async function readOptionalJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch (error: unknown) {
    if (isNodeError(error, 'ENOENT')) return undefined
    throw transferSecretError(`Could not read credential configuration at ${path}.`, error)
  }
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    await rename(temporary, path)
    await chmod(path, 0o600).catch(() => undefined)
  } catch (error: unknown) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

function isSealedMarker(value: unknown): value is Record<string, unknown> {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as Record<string, unknown>)['$sealed'] === 1
}

function stringMap(value: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function transferSecretError(message: string, cause?: unknown): Error & { code: string; exitCode: number } {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), {
    code: 'ETRANSFERSECRET',
    exitCode: 1,
  })
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}
