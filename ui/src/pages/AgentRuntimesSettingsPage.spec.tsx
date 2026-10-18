// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentInfo } from '../components/workspace/api'
import { i18n } from '../i18n'
import { AgentRuntimesSettingsPage } from './AgentRuntimesSettingsPage'

const mocks = vi.hoisted(() => ({
  saveQuickAccess: vi.fn(),
  refresh: vi.fn(),
  quickAccessIds: ['pi', 'opencode'] as string[],
  catalog: [
    {
      id: 'opencode',
      displayName: 'OpenCode',
      kind: 'agent',
      installed: true,
      binPath: '/usr/local/bin/opencode',
      capabilities: {
        parallelPerCwd: true,
        resumeLast: true,
        resumeById: true,
        transcriptDiscovery: 'none',
      },
    },
    {
      id: 'pi',
      displayName: 'Pi',
      kind: 'agent',
      installed: true,
      binPath: '/usr/bin/pi',
      capabilities: {
        parallelPerCwd: true,
        resumeLast: true,
        resumeById: true,
        transcriptDiscovery: 'none',
      },
    },
    {
      id: 'codex',
      displayName: 'Codex',
      kind: 'agent',
      installed: false,
      capabilities: {
        parallelPerCwd: true,
        resumeLast: true,
        resumeById: true,
        transcriptDiscovery: 'none',
      },
    },
    {
      id: 'claude',
      displayName: 'Claude Code',
      kind: 'agent',
      installed: true,
      capabilities: {
        parallelPerCwd: true,
        resumeLast: true,
        resumeById: true,
        transcriptDiscovery: 'none',
      },
    },
  ] as AgentInfo[],
}))

vi.mock('../hooks/useAgentRuntimes', () => ({
  useAgentRuntimes: () => ({
    catalog: mocks.catalog,
    primary: mocks.catalog.filter((agent) => mocks.quickAccessIds.includes(agent.id)),
    others: mocks.catalog.filter((agent) => !mocks.quickAccessIds.includes(agent.id)),
    installed: mocks.catalog.filter((agent) => agent.installed !== false),
    notInstalled: mocks.catalog.filter((agent) => agent.installed === false),
    readiness: {
      overallReady: true,
      checkedAt: '2026-08-18T00:00:00.000Z',
      agents: {
        opencode: {
          agent: 'opencode',
          displayName: 'OpenCode',
          installed: true,
          binPath: '/usr/local/bin/opencode',
          status: 'ready',
          ready: true,
          source: 'global-login',
          checkedAt: '2026-08-18T00:00:00.000Z',
          durationMs: 9,
        },
      },
    },
    quickAccessIds: mocks.quickAccessIds,
    recentAgentIds: [],
    loading: false,
    refreshing: false,
    error: null,
    refresh: mocks.refresh,
    saveQuickAccess: mocks.saveQuickAccess,
    recordSuccessfulUse: vi.fn(),
  }),
}))

beforeEach(async () => {
  await i18n.changeLanguage('en')
  mocks.quickAccessIds = ['pi', 'opencode']
  mocks.saveQuickAccess.mockReset()
  mocks.refresh.mockReset()
  mocks.saveQuickAccess.mockResolvedValue(undefined)
  mocks.refresh.mockResolvedValue(undefined)
})

afterEach(cleanup)

describe('AgentRuntimesSettingsPage', () => {
  it('shows only the visible runtime with its path and readiness', async () => {
    render(<AgentRuntimesSettingsPage />)

    expect(screen.getByRole('heading', { name: 'Agent runtimes' })).toBeTruthy()
    expect(screen.getByText('/usr/local/bin/opencode')).toBeTruthy()
    expect(screen.getAllByText(/Installed/).length).toBeGreaterThan(0)
    expect(screen.queryByText('/usr/bin/pi')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledWith())
  })

  it('never offers hidden runtimes even when they are installed', () => {
    render(<AgentRuntimesSettingsPage />)

    expect(screen.queryByRole('switch', { name: /Claude/ })).toBeNull()
    expect(screen.queryByRole('switch', { name: /^Pi/ })).toBeNull()
    expect(screen.queryByRole('switch', { name: /Codex/ })).toBeNull()
    expect(screen.getAllByRole('switch', { name: 'Remove OpenCode from quick access' }).length).toBeGreaterThan(0)
  })

  it('drops stale hidden pins when the visible pin is removed', async () => {
    render(<AgentRuntimesSettingsPage />)

    fireEvent.click(screen.getAllByRole('switch', { name: 'Remove OpenCode from quick access' })[0]!)
    await waitFor(() => expect(mocks.saveQuickAccess).toHaveBeenCalledWith([]))
  })

  it('adds the visible runtime to quick access when it is unpinned', async () => {
    mocks.quickAccessIds = []
    render(<AgentRuntimesSettingsPage />)

    fireEvent.click(screen.getByRole('switch', { name: 'Add OpenCode to quick access' }))
    await waitFor(() => expect(mocks.saveQuickAccess).toHaveBeenCalledWith(['opencode']))
  })
})
