import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Round-trip tests for the redacted-section PUT merge. config.ts resolves
 * CONFIG_DIR at import, so each test re-imports under a fresh temp home.
 */
let home: string
let savedHome: string | undefined
let savedBackend: string | undefined

async function loadConfig() {
  vi.resetModules()
  process.env['OPENALICE_HOME'] = home
  process.env['OPENALICE_SEALING_BACKEND'] = 'file'
  return import('./config.js')
}

beforeEach(async () => {
  savedHome = process.env['OPENALICE_HOME']
  savedBackend = process.env['OPENALICE_SEALING_BACKEND']
  home = await mkdtemp(join(tmpdir(), 'oa-config-merge-'))
})

afterEach(async () => {
  if (savedHome === undefined) delete process.env['OPENALICE_HOME']
  else process.env['OPENALICE_HOME'] = savedHome
  if (savedBackend === undefined) delete process.env['OPENALICE_SEALING_BACKEND']
  else process.env['OPENALICE_SEALING_BACKEND'] = savedBackend
  vi.resetModules()
  await rm(home, { recursive: true, force: true })
})

describe('redacted config PUT merge', () => {
  it('preserves market-data keys and the hub when the redacted section is saved back', async () => {
    const config = await loadConfig()
    await config.writeConfigSection('marketData', {
      providerKeys: { fmp: 'stored-fmp', fred: 'stored-fred' },
      hub: { enabled: true, baseUrl: 'https://hub.example' },
    })

    // The API redaction is tested separately; emulate its shape here.
    await config.writeConfigSection('marketData', {
      providerKeys: {},
      providerKeyStatus: { fmp: true, fred: true },
      hub: { enabled: true, baseUrl: 'https://hub.example' },
    })

    const after = await config.readMarketDataConfig()
    expect(after.providerKeys).toMatchObject({ fmp: 'stored-fmp', fred: 'stored-fred' })
    expect(after.hub.baseUrl).toBe('https://hub.example')
  })

  it('applies an explicit clearProviderKeys list without touching other keys', async () => {
    const config = await loadConfig()
    await config.writeConfigSection('marketData', {
      providerKeys: { fmp: 'stored-fmp', fred: 'stored-fred' },
    })
    await config.writeConfigSection('marketData', { clearProviderKeys: ['fred'] })

    const after = await config.readMarketDataConfig()
    expect(after.providerKeys.fmp).toBe('stored-fmp')
    expect(after.providerKeys.fred).toBeUndefined()
  })

  it('preserves broker secrets and nested options across a redacted PUT', async () => {
    const config = await loadConfig()
    await config.writeConfigSection('crypto', {
      provider: {
        type: 'ccxt',
        exchange: 'okx',
        apiKey: 'stored-key',
        apiSecret: 'stored-secret',
        password: 'stored-pass',
        options: { passphrase: 'stored-passphrase', safe: 1 },
      },
    })

    await config.writeConfigSection('crypto', {
      provider: {
        type: 'ccxt',
        exchange: 'okx',
        hasApiKey: true,
        hasApiSecret: true,
        hasPassword: true,
        options: { hasPassphrase: true, safe: 2 },
      },
    })

    const after = (await config.loadConfig()).crypto
    expect(after.provider).toMatchObject({
      type: 'ccxt',
      exchange: 'okx',
      apiKey: 'stored-key',
      apiSecret: 'stored-secret',
      password: 'stored-pass',
      options: { passphrase: 'stored-passphrase', safe: 2 },
    })
  })

  it('does not carry broker keys to a different exchange', async () => {
    const config = await loadConfig()
    await config.writeConfigSection('crypto', {
      provider: { type: 'ccxt', exchange: 'okx', apiKey: 'okx-key', apiSecret: 'okx-secret' },
    })
    await config.writeConfigSection('crypto', {
      provider: { type: 'ccxt', exchange: 'binance', apiKey: '', apiSecret: '' },
    })

    const after = (await config.loadConfig()).crypto
    expect(after.provider).toMatchObject({ type: 'ccxt', exchange: 'binance' })
    expect((after.provider as Record<string, unknown>)['apiKey']).toBeUndefined()
    expect((after.provider as Record<string, unknown>)['apiSecret']).toBeUndefined()
  })

  it('preserves the AI vault when a redacted section is saved back', async () => {
    const config = await loadConfig()
    await config.writeConfigSection('aiProvider', {
      credentials: {
        primary: {
          vendor: 'deepseek',
          authType: 'api-key',
          apiKey: 'stored-ai-key',
        },
      },
      workspaceDefaultAgent: 'opencode',
    })

    await config.writeConfigSection('aiProvider', {
      apiKeys: {},
      credentials: {},
      workspaceCredentialDefaults: {},
      workspaceDefaultAgent: 'opencode',
    })

    const after = await config.readAIProviderConfig()
    expect(after.credentials.primary?.apiKey).toBe('stored-ai-key')
    expect(after.workspaceDefaultAgent).toBe('opencode')
  })
})
