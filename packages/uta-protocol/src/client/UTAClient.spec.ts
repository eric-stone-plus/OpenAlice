import { describe, expect, it, vi } from 'vitest'

import { createUTAClient } from './UTAClient.js'

describe('createUTAClient', () => {
  it('carries the local bearer token on every request', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const client = createUTAClient({
      baseUrl: 'http://127.0.0.1:47333',
      token: 'oa1_test',
      fetch: fetchMock,
    })
    await client.get('/__uta/health')
    const init = fetchMock.mock.calls[0]?.[1]
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer oa1_test')
  })

  it('does not send an Authorization header without a token', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }))
    const client = createUTAClient({
      baseUrl: 'http://127.0.0.1:47333',
      fetch: fetchMock,
    })
    await client.get('/__uta/health')
    const init = fetchMock.mock.calls[0]?.[1]
    expect((init?.headers as Record<string, string>).authorization).toBeUndefined()
  })
})
