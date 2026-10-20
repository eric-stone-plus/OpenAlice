import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
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
    expect(result.args.at(-2)).toMatch(/(?:^|\/)node(?:-\d+)?$/)
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
    expect(env.NPM_CONFIG_REGISTRY).toBe('https://registry.example/')
  })

  it('strips scheme-less proxy credentials but keeps the endpoint', async () => {
    const { buildHarnessEnv } = await import('./harness-sandbox.js')
    const env = buildHarnessEnv({
      PATH: '/usr/bin',
      HTTP_PROXY: 'user:pass@proxy:3128',
      HTTPS_PROXY: 'proxy:3128',
    })
    expect(env.HTTP_PROXY).toBe('proxy:3128')
    expect(env.HTTP_PROXY).not.toContain('user')
    expect(env.HTTP_PROXY).not.toContain('pass')
    expect(env.HTTPS_PROXY).toBe('proxy:3128')
  })

  it('strips query-string credentials but keeps benign query names and the endpoint', async () => {
    const { buildHarnessEnv } = await import('./harness-sandbox.js')
    const env = buildHarnessEnv({
      PATH: '/usr/bin',
      HTTP_PROXY: 'http://proxy:3128/?password=secret',
      HTTPS_PROXY: 'http://proxy:3128/?keyword=value',
      ALL_PROXY: 'http://proxy:3128/?token=secret',
      NODE_USE_ENV_PROXY: '1',
    })
    expect(env.HTTP_PROXY).toBe('http://proxy:3128/')
    expect(env.ALL_PROXY).toBe('http://proxy:3128/')
    expect(env.HTTPS_PROXY).toBe('http://proxy:3128/?keyword=value')
    expect(env.NODE_USE_ENV_PROXY).toBe('1')
  })

  it.skipIf(!hasBwrap)('binds custom CA files and directories under the hidden home', async () => {
    const home = await mkdtemp(join(tmpdir(), 'oa-harness-ca-'))
    try {
      const certDir = join(home, 'certs')
      await mkdir(certDir, { recursive: true })
      const certFile = join(certDir, 'ca.pem')
      await writeFile(certFile, 'test-ca')
      const result = sandboxHarnessCommand({
        file: '/bin/sh',
        args: [],
        cwd: join(home, 'workspace'),
        home,
        env: {
          PATH: '/usr/bin:/bin',
          NODE_EXTRA_CA_CERTS: certFile,
          SSL_CERT_DIR: certDir,
        },
      })
      expect(result.args).toContain(certFile)
      expect(result.args).toEqual(expect.arrayContaining(['--ro-bind', certFile, certFile]))
      expect(result.args).toEqual(expect.arrayContaining(['--ro-bind', certDir, certDir]))
      expect(result.args).toEqual(expect.arrayContaining(['--dir', certDir]))
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it.skipIf(!hasBwrap)('does not rebind a hidden root as a CA directory', async () => {
    const home = await mkdtemp(join(tmpdir(), 'oa-harness-ca-root-'))
    try {
      const result = sandboxHarnessCommand({
        file: '/bin/sh',
        args: [],
        cwd: '/workspace',
        home,
        env: { PATH: '/usr/bin:/bin', SSL_CERT_DIR: home },
      })
      const bindPairs = result.args
        .map((arg, index) => arg === '--ro-bind' ? [result.args[index + 1], result.args[index + 2]] : null)
        .filter((pair): pair is string[] => pair !== null)
      expect(bindPairs).not.toContainEqual([home, home])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it.skipIf(!hasBwrap)('binds only an executable that lives directly in the data home', async () => {
    const home = await mkdtemp(join(tmpdir(), 'oa-harness-data-exe-'))
    try {
      const dataHome = join(home, '.openalice')
      await mkdir(dataHome, { recursive: true })
      const executable = join(dataHome, 'harness')
      await writeFile(executable, '#!/bin/sh\n', { mode: 0o700 })
      const result = sandboxHarnessCommand({
        file: executable,
        args: [],
        cwd: '/workspace',
        home,
        dataHome,
        env: { PATH: '/usr/bin:/bin' },
      })
      expect(result.args).toEqual(expect.arrayContaining(['--ro-bind', executable, executable]))
      const bindPairs = result.args
        .map((arg, index) => arg === '--ro-bind' ? [result.args[index + 1], result.args[index + 2]] : null)
        .filter((pair): pair is string[] => pair !== null)
      expect(bindPairs).not.toContainEqual([dataHome, dataHome])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('rewrites PATH to canonical targets so symlinked entries survive the home tmpfs', async () => {
    const home = await mkdtemp(join(tmpdir(), 'oa-harness-path-'))
    try {
      const bin = join(home, 'bin')
      const link = join(home, 'link-bin')
      await mkdir(bin, { recursive: true })
      await symlink(bin, link)
      const { buildHarnessEnv } = await import('./harness-sandbox.js')
      const env = buildHarnessEnv({ PATH: `${link}:/usr/bin` })
      expect(env.PATH).toBe(`${realpathSync(bin)}:/usr/bin`)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it.skipIf(!hasBwrap)('rejects an absolute directory as the harness executable', async () => {
    const home = await mkdtemp(join(tmpdir(), 'oa-harness-dir-'))
    try {
      const workspace = join(home, 'workspace')
      await mkdir(workspace, { recursive: true })
      expect(() => sandboxHarnessCommand({
        file: home,
        args: [],
        cwd: workspace,
        home,
        env: {},
      })).toThrow(/regular file/)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it.skipIf(!hasBwrap)('leaves a missing absolute executable for spawn to report', () => {
    const result = sandboxHarnessCommand({
      file: '/nonexistent/openalice-harness',
      args: [],
      cwd: '/workspace',
      home: '/home/alice',
      env: {},
    })
    expect(result.args.at(-1)).toBe('/nonexistent/openalice-harness')
  })

  it.skipIf(!hasBwrap)('rejects a workspace symlink that resolves to HOME or /', async () => {
    const home = await mkdtemp(join(tmpdir(), 'oa-harness-link-'))
    try {
      const homeLink = join(home, 'link-to-home')
      await symlink(home, homeLink)
      expect(() => sandboxHarnessCommand({
        file: '/bin/sh',
        args: [],
        cwd: homeLink,
        home,
        env: { PATH: '/usr/bin:/bin' },
      })).toThrow(/home directory/i)

      const rootLink = join(home, 'link-to-root')
      await symlink('/', rootLink)
      expect(() => sandboxHarnessCommand({
        file: '/bin/sh',
        args: [],
        cwd: rootLink,
        home,
        env: { PATH: '/usr/bin:/bin' },
      })).toThrow(/\/ or the home directory/i)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it.skipIf(!hasBwrap)('resolves a harness executable symlink to its target', async () => {
    const home = await mkdtemp(join(tmpdir(), 'oa-harness-exe-'))
    try {
      const bin = join(home, 'bin')
      await mkdir(bin, { recursive: true })
      const link = join(bin, 'tool')
      await symlink('/bin/echo', link)
      const result = sandboxHarnessCommand({
        file: link,
        args: ['hello'],
        cwd: join(home, 'workspace'),
        home,
        env: { PATH: '/usr/bin:/bin' },
      })
      // The lexical shim path is argv[0]; the canonical target is bound too.
      expect(result.args.at(-2)).toBe(link)
      expect(result.args.at(-1)).toBe('hello')
      // The lexical shim path must exist for argv[0]; only its parent chain
      // and the file itself are created, not the directory contents.
      expect(result.args).toContain(link)
      expect(result.args).toContain(bin)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
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
