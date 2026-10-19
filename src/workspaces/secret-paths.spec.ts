import { describe, expect, it } from 'vitest'
import { isSecretWorkspacePath } from './secret-paths.js'

describe('isSecretWorkspacePath', () => {
  it.each([
    '.env',
    'config/.env',
    'config/.env.local',
    '.pi/openalice-provider.json',
    '.codex/env.json',
    '.claude/settings.local.json',
    '.opencode/openalice-provider.json',
    'secrets/api.txt',
    'credentials/broker.json',
    'provider-keys.json',
    'accounts.json',
    'auth.json',
    'wallet.json',
    'id_rsa',
    'id_ed25519',
    'cert.pem',
    'private.key',
    'bundle.p12',
    'bundle.pfx',
    'store.keystore',
  ])('treats %s as secret', path => {
    expect(isSecretWorkspacePath(path)).toBe(true)
  })

  it.each([
    'research/new.md',
    'README.md',
    'src/index.ts',
    'config/agent.json',
    '.alice/settings.json',
    'docs/security.md',
  ])('allows %s', path => {
    expect(isSecretWorkspacePath(path)).toBe(false)
  })
})
