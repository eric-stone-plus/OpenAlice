import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'

import { AcpTransport, ACP_CANCEL_WATCHDOG_MS, ACP_RELEASED_PROMPT_FENCE_MS } from './acp-transport.js'
import type { JsonObject } from './model.js'
import type { Logger } from '../logger.js'
import { WebSessionState, type JsonlChannel, type WebTransportContext } from './transport.js'

class FakeChannel implements JsonlChannel {
  closed = false
  readonly sent: JsonObject[] = []
  private handler: ((value: JsonObject) => void) | null = null

  onMessage(handler: (value: JsonObject) => void): void {
    this.handler = handler
  }

  async send(value: unknown): Promise<void> {
    this.sent.push(value as JsonObject)
  }

  receive(value: JsonObject): void {
    this.handler?.(value)
  }
}

function makeTransport(options: { onFatal?: (message: string) => void } = {}): {
  transport: AcpTransport
  state: WebSessionState
  channel: FakeChannel
  warn: Mock<Logger['warn']>
} {
  const warn = vi.fn<Logger['warn']>()
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn,
    error: () => undefined,
    event: () => undefined,
    child: () => logger,
  }
  const state = new WebSessionState()
  const channel = new FakeChannel()
  const ctx: WebTransportContext = {
    input: {
      recordId: 'record',
      wsId: 'ws',
      resumeId: 'resume',
      agent: 'opencode',
      wire: 'acp',
      command: [],
      cwd: '/tmp',
      env: {},
      nativeSessionId: 'native-1',
      configPin: { model: 'pinned-model' },
    },
    state,
    channel,
    logger,
    onFatal: options.onFatal ?? (() => undefined),
  }
  const transport = new AcpTransport(ctx)
  // The transport normally gets this from start()/session/load; these tests
  // exercise the post-start guard paths directly.
  ;(transport as unknown as { sessionId: string | null }).sessionId = 'native-1'
  return { transport, state, channel, warn }
}

async function waitForFrame(channel: FakeChannel, method: string): Promise<JsonObject> {
  const deadline = Date.now() + 1_000
  for (;;) {
    const frame = channel.sent.find((message) => message['method'] === method)
    if (frame) return frame
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${method}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const promptFrames = (channel: FakeChannel): JsonObject[] =>
  channel.sent.filter((message) => message['method'] === 'session/prompt')

describe('AcpTransport pin guards', () => {
  it('answers the pending permission before failing the drifted turn', async () => {
    const { transport, state } = makeTransport()
    const request = (transport as unknown as {
      onRequest(method: string, params: unknown, id: number): Promise<unknown>
    }).onRequest('session/request_permission', {
      toolCall: { title: 'Bash' },
      options: [{ optionId: 'allow', name: 'Allow' }],
    }, 7)
    expect(state.requests.map((entry) => entry.id)).toEqual(['acp-7'])

    vi.spyOn(
      transport as unknown as { ensureConfigPin(): Promise<void> },
      'ensureConfigPin',
    ).mockRejectedValue(new Error('pin failed'))

    await expect(transport.respond('acp-7', 'allow')).rejects.toThrow('pin failed')
    expect(state.requests).toEqual([])
    // The runtime must not stay blocked on a permission while the pin restore
    // times out; the turn is aborted instead.
    await expect(request).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } })
  })

  it('claims the turn before awaiting the pin restore', async () => {
    const { transport, channel } = makeTransport()
    let release!: () => void
    const pin = new Promise<void>((resolve) => { release = resolve })
    vi.spyOn(
      transport as unknown as { ensureConfigPin(): Promise<void> },
      'ensureConfigPin',
    ).mockReturnValue(pin)

    const first = transport.prompt('first')
    await expect(transport.prompt('second')).rejects.toThrow(/still working on the previous prompt/)
    release()
    await first

    const frame = await waitForFrame(channel, 'session/prompt')
    channel.receive({ jsonrpc: '2.0', id: frame['id'], result: { stopReason: 'end_turn' } })
  })

  it('does not fence a turn released before its prompt was sent', async () => {
    const { transport, channel } = makeTransport()
    let release!: () => void
    const pin = new Promise<void>((resolve) => { release = resolve })
    vi.spyOn(
      transport as unknown as { ensureConfigPin(): Promise<void> },
      'ensureConfigPin',
    ).mockReturnValueOnce(pin).mockResolvedValue(undefined)
    const restore = vi.spyOn(
      transport as unknown as { restoreConfigPin(): Promise<void> },
      'restoreConfigPin',
    ).mockRejectedValue(new Error('drift'))

    const first = transport.prompt('first')
    // A runtime config notification lands while the prompt waits for the pin;
    // its restore fails and releases the turn before session/prompt was sent.
    ;(transport as unknown as { onNotification(method: string, params: unknown): void })
      .onNotification('session/update', { update: { sessionUpdate: 'config_option_update', configOptions: [] } })
    await vi.waitFor(() => expect(restore).toHaveBeenCalled())

    // No session/prompt is outstanding, so there is nothing to fence and the
    // next prompt is accepted immediately.
    await transport.prompt('second')
    expect(promptFrames(channel)).toHaveLength(1)

    release()
    await expect(first).rejects.toThrow(/cancelled before the prompt was sent/)
  })

  it('releases the turn claim when the pin restore fails', async () => {
    const { transport, channel } = makeTransport()
    const ensure = vi.spyOn(
      transport as unknown as { ensureConfigPin(): Promise<void> },
      'ensureConfigPin',
    ).mockRejectedValueOnce(new Error('pin failed'))

    await expect(transport.prompt('first')).rejects.toThrow('pin failed')

    ensure.mockResolvedValue(undefined)
    const second = transport.prompt('second')
    await second
    const frame = await waitForFrame(channel, 'session/prompt')
    channel.receive({ jsonrpc: '2.0', id: frame['id'], result: { stopReason: 'end_turn' } })
  })
})

describe('AcpTransport cancellation', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  const watchdog = (transport: AcpTransport): unknown =>
    (transport as unknown as { cancelWatchdog: unknown }).cancelWatchdog

  it('releases a turn cancelled while the pin restore is still pending', async () => {
    const { transport, channel } = makeTransport()
    let release!: () => void
    const pin = new Promise<void>((resolve) => { release = resolve })
    vi.spyOn(
      transport as unknown as { ensureConfigPin(): Promise<void> },
      'ensureConfigPin',
    ).mockReturnValueOnce(pin).mockResolvedValue(undefined)

    const first = transport.prompt('first')
    await transport.abort()
    expect(channel.sent.some((message) => message['method'] === 'session/cancel')).toBe(true)
    // No prompt was sent yet, so there is nothing for the runtime to
    // acknowledge and no watchdog to fire; the turn is released immediately.
    expect(watchdog(transport)).toBeNull()
    expect((transport as unknown as { cancelRequested: boolean }).cancelRequested).toBe(false)

    await transport.prompt('second')
    expect(promptFrames(channel)).toHaveLength(1)

    release()
    await expect(first).rejects.toThrow(/cancelled before the prompt was sent/)
    expect(promptFrames(channel)).toHaveLength(1)
  })

  it('rejects a second prompt after cancel until the first turn settles', async () => {
    const { transport, channel } = makeTransport()
    vi.spyOn(
      transport as unknown as { ensureConfigPin(): Promise<void> },
      'ensureConfigPin',
    ).mockResolvedValue(undefined)

    await transport.prompt('first')
    const first = promptFrames(channel)[0]
    await transport.abort()
    await expect(transport.prompt('second')).rejects.toThrow(/still working on the previous prompt/)

    channel.receive({ jsonrpc: '2.0', id: first['id'], result: { stopReason: 'cancelled' } })
    await vi.waitFor(() => expect(watchdog(transport)).toBeNull())
    await transport.prompt('second')
    expect(promptFrames(channel)).toHaveLength(2)
  })

  it('does not mark a cancel while idle', async () => {
    const { transport, state, channel } = makeTransport()
    await transport.abort()
    expect((transport as unknown as { cancelRequested: boolean }).cancelRequested).toBe(false)

    channel.receive({
      jsonrpc: '2.0',
      id: 43,
      method: 'session/request_permission',
      params: { toolCall: { title: 'Bash' }, options: [{ optionId: 'allow', name: 'Allow' }] },
    })
    expect(state.requests).toHaveLength(1)
  })

  it('refuses to answer a permission request after cancel', async () => {
    const { transport, state, channel } = makeTransport()
    vi.spyOn(
      transport as unknown as { ensureConfigPin(): Promise<void> },
      'ensureConfigPin',
    ).mockResolvedValue(undefined)

    await transport.prompt('first')
    channel.receive({
      jsonrpc: '2.0',
      id: 42,
      method: 'session/request_permission',
      params: { toolCall: { title: 'Bash' }, options: [{ optionId: 'allow', name: 'Allow' }] },
    })
    expect(state.requests).toHaveLength(1)

    await transport.abort()
    await expect(transport.respond(state.requests[0].id, 'allow')).rejects.toThrow(/cancelling/)
  })

  it('fences a released turn until the runtime settles it', async () => {
    vi.useFakeTimers()
    const { transport, state, channel } = makeTransport()
    vi.spyOn(
      transport as unknown as { ensureConfigPin(): Promise<void> },
      'ensureConfigPin',
    ).mockResolvedValue(undefined)

    await transport.prompt('first')
    const first = promptFrames(channel)[0]
    await transport.abort()
    await expect(transport.prompt('second')).rejects.toThrow(/still working on the previous prompt/)

    await vi.advanceTimersByTimeAsync(ACP_CANCEL_WATCHDOG_MS)
    expect(state.error).toMatch(/did not acknowledge session\/cancel/)
    // The composer stays usable, but the replacement prompt waits for the
    // released turn to settle instead of mixing its frames into a new turn.
    expect(state.phase).toBe('idle')
    expect(watchdog(transport)).toBeNull()
    await expect(transport.prompt('second')).rejects.toThrow(/still settling the previous turn/)

    channel.receive({ jsonrpc: '2.0', id: first['id'], result: { stopReason: 'end_turn' } })
    await vi.advanceTimersByTimeAsync(0)
    await transport.prompt('second')
    const frames = promptFrames(channel)
    expect(frames).toHaveLength(2)

    channel.receive({ jsonrpc: '2.0', id: frames[1]['id'], result: { stopReason: 'end_turn' } })
    await vi.advanceTimersByTimeAsync(0)
    await transport.prompt('third')
    expect(promptFrames(channel)).toHaveLength(3)
  })

  it('fences turn content and permission requests from a cancelled turn', async () => {
    vi.useFakeTimers()
    const { transport, state, channel, warn } = makeTransport()
    vi.spyOn(
      transport as unknown as { ensureConfigPin(): Promise<void> },
      'ensureConfigPin',
    ).mockResolvedValue(undefined)

    await transport.prompt('first')
    const first = promptFrames(channel)[0]
    await transport.abort()
    // A permission request during the 10s cancel window already belongs to a
    // cancelled turn and must not become actionable.
    channel.receive({
      jsonrpc: '2.0',
      id: 40,
      method: 'session/request_permission',
      params: { toolCall: { title: 'Bash' }, options: [{ optionId: 'allow', name: 'Allow' }] },
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(state.requests).toHaveLength(0)
    expect(channel.sent.find((message) => message['id'] === 40)).toMatchObject({
      result: { outcome: { outcome: 'cancelled' } },
    })

    await vi.advanceTimersByTimeAsync(ACP_CANCEL_WATCHDOG_MS)

    // The runtime ignored cancel, so any turn content it emits now belongs to
    // the released turn and must not enter the next transcript.
    channel.receive({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'zombie' } } },
    })
    expect(state.streamingMessage).toBeNull()

    // A permission request from the released turn must not become actionable.
    channel.receive({
      jsonrpc: '2.0',
      id: 41,
      method: 'session/request_permission',
      params: { toolCall: { title: 'Bash' }, options: [{ optionId: 'allow', name: 'Allow' }] },
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(state.requests).toHaveLength(0)
    expect(channel.sent.find((message) => message['id'] === 41)).toMatchObject({
      result: { outcome: { outcome: 'cancelled' } },
    })
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/requested permission for a cancelled turn/))

    // Settling the released prompt ends the fence; later updates are applied.
    channel.receive({ jsonrpc: '2.0', id: first['id'], result: { stopReason: 'cancelled' } })
    await vi.advanceTimersByTimeAsync(0)
    channel.receive({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'fresh' } } },
    })
    const streaming = state.streamingMessage
    expect(streaming?.role).toBe('assistant')
    if (streaming?.role === 'assistant') {
      expect(streaming.content).toEqual([{ type: 'text', text: 'fresh' }])
    }
  })

  it('fails the session when the released turn never settles', async () => {
    vi.useFakeTimers()
    const onFatal = vi.fn<(message: string) => void>()
    const { transport, state, channel } = makeTransport({ onFatal })
    vi.spyOn(
      transport as unknown as { ensureConfigPin(): Promise<void> },
      'ensureConfigPin',
    ).mockResolvedValue(undefined)

    await transport.prompt('first')
    const first = promptFrames(channel)[0]
    await transport.abort()
    await vi.advanceTimersByTimeAsync(ACP_CANCEL_WATCHDOG_MS)
    expect(state.phase).toBe('idle')
    await expect(transport.prompt('second')).rejects.toThrow(/still settling the previous turn/)

    await vi.advanceTimersByTimeAsync(ACP_RELEASED_PROMPT_FENCE_MS)
    expect(state.phase).toBe('failed')
    expect(state.error).toMatch(/did not settle the cancelled turn/)
    expect(onFatal).toHaveBeenCalledWith(expect.stringMatching(/did not settle the cancelled turn/))

    // The transport is disposed: the session must be restarted, and a late
    // settlement cannot revive it.
    await expect(transport.prompt('second')).rejects.toThrow(/ACP session is not established/)
    channel.receive({ jsonrpc: '2.0', id: first['id'], result: { stopReason: 'cancelled' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(state.phase).toBe('failed')
  })

  it('clears the watchdog when the cancelled turn settles in time', async () => {
    vi.useFakeTimers()
    const { transport, state, channel } = makeTransport()
    vi.spyOn(
      transport as unknown as { ensureConfigPin(): Promise<void> },
      'ensureConfigPin',
    ).mockResolvedValue(undefined)

    await transport.prompt('first')
    const first = promptFrames(channel)[0]
    await transport.abort()
    channel.receive({ jsonrpc: '2.0', id: first['id'], result: { stopReason: 'cancelled' } })
    await vi.advanceTimersByTimeAsync(0)

    expect(watchdog(transport)).toBeNull()
    await vi.advanceTimersByTimeAsync(ACP_CANCEL_WATCHDOG_MS)
    expect(state.error).toBeNull()
    expect(state.phase).toBe('idle')
  })
})
