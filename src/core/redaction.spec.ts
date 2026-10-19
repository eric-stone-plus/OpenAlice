import { describe, expect, it } from 'vitest'
import { preserveSecretFields, redactConfigSection, redactSecretValues } from './redaction.js'

describe('redactConfigSection', () => {
  it('replaces market-data keys with presence flags', () => {
    const redacted = redactConfigSection('marketData', {
      enabled: true,
      providerKeys: { fmp: 'secret-fmp', fred: '', finnhub: 'secret-finnhub' },
      hub: { enabled: true, baseUrl: 'https://traderhub.openalice.ai' },
    }) as Record<string, unknown>

    expect(JSON.stringify(redacted)).not.toContain('secret-fmp')
    expect(JSON.stringify(redacted)).not.toContain('secret-finnhub')
    expect(redacted['providerKeys']).toEqual({})
    expect(redacted['providerKeyStatus']).toEqual({ fmp: true, finnhub: true })
    expect(redacted['hub']).toEqual({ enabled: true, baseUrl: 'https://traderhub.openalice.ai' })
  })

  it('redacts broker provider fields and nested guard options', () => {
    const redacted = redactConfigSection('crypto', {
      provider: {
        type: 'ccxt',
        exchange: 'okx',
        apiKey: 'secret-key',
        apiSecret: 'secret-secret',
        password: 'secret-pass',
        options: { passphrase: 'secret-option', safe: 1 },
      },
      guards: [{ type: 'max-order', options: { token: 'secret-token', limit: 10 } }],
    }) as Record<string, unknown>

    const text = JSON.stringify(redacted)
    for (const secret of ['secret-key', 'secret-secret', 'secret-pass', 'secret-option', 'secret-token']) {
      expect(text).not.toContain(secret)
    }
    const provider = redacted['provider'] as Record<string, unknown>
    expect(provider['hasApiKey']).toBe(true)
    expect(provider['hasApiSecret']).toBe(true)
    expect(provider['hasPassword']).toBe(true)
    expect((provider['options'] as Record<string, unknown>)['safe']).toBe(1)
    expect((redacted['guards'] as Array<Record<string, unknown>>)[0]?.['options']).toMatchObject({ limit: 10 })
  })

  it('empties the AI vault without dropping non-secret selection fields', () => {
    const redacted = redactConfigSection('aiProvider', {
      apiKeys: { deepseek: 'secret-ai' },
      credentials: { primary: { apiKey: 'secret-vault' } },
      workspaceCredentialDefaults: { opencode: { credentialSlug: 'primary' } },
      workspaceDefaultAgent: 'opencode',
    }) as Record<string, unknown>

    expect(redacted['apiKeys']).toEqual({})
    expect(redacted['credentials']).toEqual({})
    expect(redacted['workspaceCredentialDefaults']).toEqual({})
    expect(redacted['workspaceDefaultAgent']).toBe('opencode')
    expect(JSON.stringify(redacted)).not.toContain('secret-ai')
    expect(JSON.stringify(redacted)).not.toContain('secret-vault')
  })

  it('does not treat ordinary token limits as secrets', () => {
    const redacted = redactSecretValues({ maxTokens: 4096, tokenBudget: 10, apiKey: 'secret' }) as Record<string, unknown>
    expect(redacted['maxTokens']).toBe(4096)
    expect(redacted['tokenBudget']).toBe(10)
    expect(redacted['apiKey']).toBeUndefined()
    expect(redacted['hasApiKey']).toBe(true)
  })
})

describe('preserveSecretFields', () => {
  it('keeps stored secrets when a redacted object is written back', () => {
    const existing = {
      provider: {
        type: 'ccxt',
        exchange: 'okx',
        apiKey: 'stored-key',
        apiSecret: 'stored-secret',
        password: '',
        options: { passphrase: 'stored-passphrase', safe: 1 },
      },
    }
    const incoming = {
      provider: {
        type: 'ccxt',
        exchange: 'okx',
        hasApiKey: true,
        hasApiSecret: true,
        options: { hasPassphrase: true, safe: 2 },
      },
    }
    const merged = preserveSecretFields(existing, incoming) as typeof existing
    expect(merged.provider.apiKey).toBe('stored-key')
    expect(merged.provider.apiSecret).toBe('stored-secret')
    expect(merged.provider.options.passphrase).toBe('stored-passphrase')
    expect(merged.provider.options.safe).toBe(2)
    expect('hasApiKey' in merged.provider).toBe(false)
    expect('hasPassphrase' in merged.provider.options).toBe(false)
  })

  it('lets a new non-empty value replace the stored secret', () => {
    const merged = preserveSecretFields(
      { apiKey: 'old', password: 'old-pass' },
      { apiKey: 'new' },
    ) as Record<string, unknown>
    expect(merged['apiKey']).toBe('new')
    expect(merged['password']).toBe('old-pass')
  })
})
