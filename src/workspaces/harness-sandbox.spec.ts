import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { sandboxHarnessCommand } from './harness-sandbox.js'

const bwrap = '/usr/bin/bwrap'
const hasBwrap = existsSync(bwrap)

describe('sandboxHarnessCommand', () => {
  it('can be explicitly disabled', () => {
    const result = sandboxHarnessCommand({
      file: 'node',
      args: ['server.js'],
      cwd: '/workspace',
      home: '/home/alice',
      env: { OPENALICE_HARNESS_SANDBOX: 'off' },
      bwrapPath: bwrap,
    })
    expect(result).toEqual({ file: 'node', args: ['server.js'], mode: 'none' })
  })

  it('binds only the workspace and hides the home', () => {
    const result = sandboxHarnessCommand({
      file: 'node',
      args: ['server.js'],
      cwd: '/home/alice/.openalice/workspaces/ws1',
      home: '/home/alice',
      env: {},
      bwrapPath: bwrap,
    })
    expect(result.mode).toBe('bwrap')
    expect(result.file).toBe(bwrap)
    expect(result.args).toContain('--tmpfs')
    expect(result.args).toContain('/home/alice')
    expect(result.args).toContain('--bind')
    expect(result.args).toContain('/home/alice/.openalice/workspaces/ws1')
    expect(result.args.at(-2)).toMatch(/(?:^|\/)node$/)
    expect(result.args.at(-1)).toBe('server.js')
  })

  it('hides the data home outside HOME and rejects an unknown mode', () => {
    const result = sandboxHarnessCommand({
      file: 'node',
      args: [],
      cwd: '/srv/workspace',
      home: '/home/alice',
      dataHome: '/var/tmp',
      env: { OPENALICE_HARNESS_SANDBOX: 'required' },
      bwrapPath: bwrap,
    })
    expect(result.args).toEqual(expect.arrayContaining(['--tmpfs', '/var/tmp']))
    expect(() => sandboxHarnessCommand({
      file: 'node',
      args: [],
      cwd: '/srv/workspace',
      home: '/home/alice',
      env: { OPENALICE_HARNESS_SANDBOX: 'require' },
      bwrapPath: bwrap,
    })).toThrow(/invalid OPENALICE_HARNESS_SANDBOX/)
  })

  it.skipIf(!hasBwrap)('treats an empty bwrap override as the default binary', () => {
    expect(sandboxHarnessCommand({
      file: 'node',
      args: [],
      cwd: '/srv/workspace',
      home: '/home/alice',
      env: { OPENALICE_BWRAP_PATH: '' },
    }).mode).toBe('bwrap')
  })

  it('scrubs credential-bearing parent env from the harness', async () => {
    const { buildHarnessEnv } = await import('./harness-sandbox.js')
    const env = buildHarnessEnv({
      HOME: '/home/alice',
      PATH: '/usr/bin',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      GITHUB_TOKEN: 'gh-secret',
      OPENALICE_LOCAL_TOKEN: 'oa1_secret',
      OPENALICE_HOME: '/data',
      HARNESS_PORTS: '{}',
      HARNESS_SANDBOX: 'required',
      BUN_AUTH_TOKEN: 'bun-registry-secret',
      PNPM_TOKEN: 'pnpm-registry-secret',
      NPM_CONFIG_REGISTRY: 'https://user:secret@registry.example/',
      LANG: 'C.UTF-8',
    })
    expect(env).toMatchObject({ HOME: '/home/alice', PATH: '/usr/bin', HARNESS_PORTS: '{}', LANG: 'C.UTF-8' })
    expect(env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY')
    expect(env).not.toHaveProperty('GITHUB_TOKEN')
    expect(env).not.toHaveProperty('OPENALICE_LOCAL_TOKEN')
    expect(env).not.toHaveProperty('OPENALICE_HOME')
    expect(env).not.toHaveProperty('HARNESS_SANDBOX')
    expect(env).not.toHaveProperty('BUN_AUTH_TOKEN')
    expect(env).not.toHaveProperty('PNPM_TOKEN')
    expect(env).not.toHaveProperty('NPM_CONFIG_REGISTRY')
  })

  it('fails closed when required and bwrap is missing', () => {
    expect(() => sandboxHarnessCommand({
      file: 'node',
      args: [],
      cwd: '/workspace',
      home: '/home/alice',
      env: { OPENALICE_HARNESS_SANDBOX: 'required' },
      bwrapPath: '/nonexistent/bwrap',
    })).toThrow(/not installed/)
  })

  it.skipIf(!hasBwrap)('runs a command with no access to the home directory', async () => {
    const home = await mkdtemp(join(tmpdir(), 'oa-harness-home-'))
    const workspace = join(home, 'workspaces', 'ws1')
    try {
      await mkdir(join(home, '.ssh'), { recursive: true })
      await writeFile(join(home, '.ssh', 'id_test'), 'secret')
      await mkdir(workspace, { recursive: true })
      await writeFile(join(workspace, 'ok.txt'), 'workspace')
      const sandboxed = sandboxHarnessCommand({
        file: '/bin/sh',
        args: ['-c', 'test ! -e "$HOME/.ssh/id_test" && test -f ./ok.txt && echo sandbox-ok'],
        cwd: workspace,
        home,
        env: {},
        bwrapPath: bwrap,
      })
      const result = spawnSync(sandboxed.file, sandboxed.args, {
        cwd: workspace,
        env: { HOME: home, PATH: process.env['PATH'] ?? '/usr/bin:/bin' },
        encoding: 'utf8',
      })
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('sandbox-ok')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
