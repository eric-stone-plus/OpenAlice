/**
 * Secret redaction for API responses.
 *
 * The on-disk stores are sealed, but the HTTP surface must never hand a
 * credential back to a renderer, a HAR capture, or a browser cache. These
 * helpers are deliberately structural rather than schema-specific: every
 * section passes through them, so a future provider field named `apiKey` or
 * `passphrase` is covered without another route change.
 *
 * They are also used by `writeConfigSection` to preserve existing secret
 * fields when a client PUTs a redacted section back. Redacted values are
 * omitted (plus a `has<Field>` boolean), never written as a mask.
 */

const SECRET_FIELD_NAMES: ReadonlySet<string> = new Set([
  'apikey',
  'apisecret',
  'secretkey',
  'secret',
  'password',
  'passphrase',
  'privatekey',
  'token',
  'accesstoken',
  'refreshtoken',
  'authtoken',
  'authorization',
  'bearer',
  'clientsecret',
  'webhooksecret',
  'mnemonic',
  'seedphrase',
  'credential',
])

const SECRET_CONTAINER_NAMES: ReadonlySet<string> = new Set([
  'apikeys',
  'credentials',
  'providerkeys',
])

/** Fields whose names look secret-adjacent but are ordinary limits/identifiers. */
const NON_SECRET_NAMES: ReadonlySet<string> = new Set([
  'maxtokens',
  'tokenbudget',
  'tokenlimit',
  'publickey',
  'keyboard',
  'tokenizer',
])

function normalizeName(name: string): string {
  return name.replace(/[_-]/g, '').toLowerCase()
}

export function isSecretFieldName(name: string): boolean {
  const normalized = normalizeName(name)
  return !NON_SECRET_NAMES.has(normalized) && SECRET_FIELD_NAMES.has(normalized)
}

export function isSecretContainerName(name: string): boolean {
  return SECRET_CONTAINER_NAMES.has(normalizeName(name))
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== ''
}

function presenceName(name: string): string {
  return `has${name.charAt(0).toUpperCase()}${name.slice(1)}`
}

/**
 * Recursively remove secret values, replacing each non-empty one with a
 * `has<Field>` boolean. Arrays keep their shape so list indices stay stable.
 */
export function redactSecretValues(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecretValues)
  if (!isPlainObject(value)) return value
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    if (isSecretFieldName(key)) {
      if (hasValue(child)) out[presenceName(key)] = true
      continue
    }
    if (isSecretContainerName(key)) {
      // A container of credentials (aiProvider.apiKeys, providerKeys) is
      // replaced wholesale: its child names are provider identifiers, not
      // field names the generic matcher can classify.
      out[key] = {}
      if (isPlainObject(child) && Object.keys(child).length > 0) {
        out[`has${key.charAt(0).toUpperCase()}${key.slice(1)}`] = true
      }
      continue
    }
    out[key] = redactSecretValues(child)
  }
  return out
}

/** Redact the ai-provider vault while keeping its non-secret selection fields. */
export function redactAIProviderConfig<T extends Record<string, unknown>>(config: T): T {
  return {
    ...config,
    apiKeys: {},
    credentials: {},
    workspaceCredentialDefaults: {},
  }
}

/**
 * Redact one config section for a GET/PUT response.
 *
 * `marketData` is special because its `providerKeys` map is the Market Data
 * editor's payload. Returning the map would leak every vendor key; returning
 * only `providerKeyStatus` lets the UI say "configured" while a PUT merge
 * preserves the values.
 */
export function redactConfigSection(section: string, value: unknown): unknown {
  if (!isPlainObject(value)) return value
  switch (section) {
    case 'marketData': {
      const { providerKeys, ...rest } = value
      const status: Record<string, true> = {}
      if (isPlainObject(providerKeys)) {
        for (const [key, child] of Object.entries(providerKeys)) {
          if (typeof child === 'string' && child.trim() !== '') status[key] = true
        }
      }
      return { ...rest, providerKeys: {}, providerKeyStatus: status }
    }
    case 'aiProvider':
      return redactAIProviderConfig(value)
    default:
      return redactSecretValues(value)
  }
}

/**
 * Preserve an existing secret when a client PUTs a redacted object back.
 * Absent, null, or empty-string secret fields keep the stored value; a new
 * non-empty value replaces it. Secret containers are merged rather than
 * replaced so an empty redacted container cannot erase the vault.
 */
export function preserveSecretFields(existing: unknown, incoming: unknown): unknown {
  if (Array.isArray(incoming)) {
    if (!Array.isArray(existing)) return incoming
    return incoming.map((item, index) => preserveSecretFields(existing[index], item))
  }
  if (!isPlainObject(incoming)) return incoming
  const out: Record<string, unknown> = { ...incoming }
  // Presence flags are response-only. Never let `hasApiKey: true` become a
  // stored option when a redacted section is PUT back.
  for (const key of Object.keys(out)) {
    if (key.startsWith('has') && out[key] === true) delete out[key]
  }
  if (!isPlainObject(existing)) return out
  for (const [key, oldValue] of Object.entries(existing)) {
    if (isSecretFieldName(key)) {
      const newValue = out[key]
      if (newValue === undefined || newValue === null || newValue === '') out[key] = oldValue
      continue
    }
    if (isSecretContainerName(key)) {
      if (isPlainObject(oldValue) && isPlainObject(out[key])) {
        out[key] = { ...oldValue, ...(out[key] as Record<string, unknown>) }
      }
      continue
    }
    const newValue = out[key]
    if (isPlainObject(oldValue) && isPlainObject(newValue)) {
      out[key] = preserveSecretFields(oldValue, newValue)
    } else if (Array.isArray(oldValue) && Array.isArray(newValue)) {
      out[key] = preserveSecretFields(oldValue, newValue)
    }
  }
  return out
}
