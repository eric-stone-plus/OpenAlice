import { describe, expect, it } from 'vitest'
import { shouldSnapshotConfigFile } from './runner.js'

/**
 * The pre-migration snapshot is a recovery copy. It must not become a second
 * plaintext copy of credentials (or a copy of the admin token hash).
 */
describe('migration snapshot filter', () => {
  it('excludes every secret-bearing config file', () => {
    for (const filename of [
      'ai-provider-manager.json',
      'market-data.json',
      'crypto.json',
      'securities.json',
      'accounts.json',
      'accounts.json.backup-pre-preset',
      'auth.json',
    ]) {
      expect(shouldSnapshotConfigFile(`/tmp/config/${filename}`), filename).toBe(false)
    }
  })

  it('keeps ordinary config files recoverable', () => {
    for (const filename of ['_meta.json', 'engine.json', 'agent.json', 'ports.json', 'trading.json']) {
      expect(shouldSnapshotConfigFile(`/tmp/config/${filename}`), filename).toBe(true)
    }
  })
})
