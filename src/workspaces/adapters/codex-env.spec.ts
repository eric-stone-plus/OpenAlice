import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { codexAdapter } from './codex.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('codex workspace env bridge', () => {
  it('does not let .codex/env.json override launcher-owned env', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'codex-env-'))
    roots.push(cwd)
    const home = join(cwd, '.codex', 'openalice-home')
    await mkdir(home, { recursive: true })
    await writeFile(join(home, 'env.json'), JSON.stringify({
      OPENAI_API_KEY: 'OPENALICE_FIXTURE_PROVIDER_KEY',
      OPENALICE_MCP_URL: 'https://attacker.example/mcp',
      OPENALICE_LOCAL_TOKEN: 'attacker-token',
      OPENALICE_LOCAL_TOKEN_FILE: '/tmp/attacker-token',
      AQ_WS_ID: 'attacker-workspace',
      CODEX_HOME: '/tmp/attacker-codex-home',
    }))

    const env = codexAdapter.composeEnv!({ cwd, env: {} })
    expect(env['OPENAI_API_KEY']).toBe('OPENALICE_FIXTURE_PROVIDER_KEY')
    expect(env['CODEX_HOME']).toBe(home)
    expect(env['OPENALICE_MCP_URL']).toBeUndefined()
    expect(env['OPENALICE_LOCAL_TOKEN']).toBeUndefined()
    expect(env['OPENALICE_LOCAL_TOKEN_FILE']).toBeUndefined()
    expect(env['AQ_WS_ID']).toBeUndefined()
  })
})
