import { describe, expect, it, vi } from 'vitest'

import { AcpTransport } from './acp-transport.js'
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

function makeTransport(): { transport: AcpTransport; state: WebSessionState; channel: FakeChannel } {
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
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
  }
  const transport = new AcpTransport(ctx)
  // The transport normally gets this from start()/session/load; these tests
  // exercise the post-start guard paths directly.
  ;(transport as unknown as { sessionId: string | null }).sessionId = 'native-1'
  return { transport, state, channel }
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
