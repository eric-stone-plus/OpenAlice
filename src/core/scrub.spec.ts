import { describe, expect, it } from 'vitest'
import { scrubText, scrubValue } from './scrub.js'

describe('scrubText', () => {
  it('redacts provider token formats', () => {
    const text = [
      'openai sk-proj-abcdefghijklmnopqrstuvwxyz123456',
      'anthropic sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
      'aws AKIAIOSFODNN7EXAMPLE',
      'github ghp_abcdefghijklmnopqrstuvwxyz012345',
      'slack xoxb-1234567890-abcdefghij',
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456',
    ].join('\n')
    const scrubbed = scrubText(text)
    for (const fragment of ['abcdefghijklmnopqrstuvwxyz123456', 'AKIAIOSFODNN7EXAMPLE', 'ghp_abcdefghijklmnopqrstuvwxyz012345', 'xoxb-1234567890-abcdefghij']) {
      expect(scrubbed).not.toContain(fragment)
    }
    expect(scrubbed).toContain('[redacted]')
  })

  it('redacts key assignments and private-key blocks', () => {
    const text = [
      'apiKey: "sk-live-abcdefghijklmnopqrstuvwxyz"',
      'password = super-secret-password-value',
      '-----BEGIN PRIVATE KEY-----',
      'synthetic-private-key-material-not-a-secret',
      '-----END PRIVATE KEY-----',
    ].join('\n')
    const scrubbed = scrubText(text)
    expect(scrubbed).not.toContain('super-secret-password-value')
    expect(scrubbed).not.toContain('synthetic-private-key-material-not-a-secret')
    expect(scrubbed).toContain('[redacted private key]')
  })

  it('leaves ordinary log text and resume ids intact', () => {
    expect(scrubText('workspace ws-123 started in 42ms')).toBe('workspace ws-123 started in 42ms')
    // `brisk-...` contains the substring `sk-`; it is not a provider token.
    expect(scrubText('resume-brisk-saffron-ridge-bxjitj')).toBe('resume-brisk-saffron-ridge-bxjitj')
  })
})

describe('scrubValue', () => {
  it('scrubs nested strings without changing the shape', () => {
    const value = {
      message: 'request failed for sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
      nested: { apiKey: 'sk-live-abcdefghijklmnopqrstuvwxyz', count: 2 },
      list: ['ghp_abcdefghijklmnopqrstuvwxyz012345'],
    }
    const scrubbed = scrubValue(value)
    expect(scrubbed.nested.count).toBe(2)
    expect(JSON.stringify(scrubbed)).not.toContain('abcdefghijklmnopqrstuvwxyz')
  })
})
