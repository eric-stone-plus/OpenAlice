import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { revokeWorkspaceCredentials } from './workspace-credentials.js'

describe('revokeWorkspaceCredentials', () => {
  it('removes known credential files and keeps settings, extensions, and source', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oa-revoke-'))
    try {
      await mkdir(join(dir, 'config'), { recursive: true })
      await mkdir(join(dir, '.pi', 'extensions'), { recursive: true })
      await mkdir(join(dir, 'src', 'credentials'), { recursive: true })
      await writeFile(join(dir, '.env'), 'OPENALICE_FIXTURE=secret\n')
      await writeFile(join(dir, '.env.local'), 'OPENALICE_FIXTURE=secret\n')
      await writeFile(join(dir, '.env.example'), 'OPENALICE_FIXTURE=example\n')
      await writeFile(join(dir, 'config', '.env'), 'OPENALICE_FIXTURE=secret\n')
      await writeFile(join(dir, '.pi', 'openalice-provider.json'), '{"apiKey":"secret"}\n')
      await writeFile(join(dir, '.pi', 'settings.json'), '{"theme":"dark"}\n')
      await writeFile(join(dir, '.pi', 'extensions', 'openalice-provider.ts'), 'export const ok = true\n')
      await writeFile(join(dir, 'wallet.json'), '{"privateKey":"secret"}\n')
      await writeFile(join(dir, 'cert.pem'), '-----BEGIN PRIVATE KEY-----\nsecret\n')
      await writeFile(join(dir, 'src', 'index.ts'), 'export const ok = true\n')
      await writeFile(join(dir, 'src', 'credentials', 'index.ts'), 'export const ok = true\n')
      await writeFile(join(dir, 'src', 'credentials', 'alpaca.json'), '{"apiKey":"secret"}\n')

      await revokeWorkspaceCredentials(dir)

      for (const removed of [
        '.env',
        '.env.local',
        'config/.env',
        '.pi/openalice-provider.json',
        'wallet.json',
        'cert.pem',
        'src/credentials/alpaca.json',
      ]) {
        await expect(readFile(join(dir, ...removed.split('/')))).rejects.toThrow()
      }
      await expect(readFile(join(dir, '.env.example'), 'utf8')).resolves.toContain('example')
      await expect(readFile(join(dir, '.pi', 'settings.json'), 'utf8')).resolves.toContain('dark')
      await expect(readFile(join(dir, '.pi', 'extensions', 'openalice-provider.ts'), 'utf8')).resolves.toContain('ok')
      await expect(readFile(join(dir, 'src', 'index.ts'), 'utf8')).resolves.toContain('ok')
      await expect(readFile(join(dir, 'src', 'credentials', 'index.ts'), 'utf8')).resolves.toContain('ok')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
