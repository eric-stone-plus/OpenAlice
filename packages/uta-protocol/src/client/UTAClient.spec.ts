import { describe, expect, it, vi } from 'vitest'

import { createUTAClient, isLoopbackHost } from './UTAClient.js'

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

  it('refuses to send the local token to a non-loopback UTA URL', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    const client = createUTAClient({
      baseUrl: 'http://192.168.1.50:47333',
      token: 'oa1_test',
      fetch: fetchMock,
    })
    await expect(client.get('/__uta/health')).rejects.toThrow(/non-loopback/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('builds a client in lite mode even with a stale non-loopback URL', () => {
    // Startup must not abort before the first request; the guard is at request
    // time, so a stale config only fails when trading actually calls UTA.
    expect(() => createUTAClient({
      baseUrl: 'http://192.168.1.50:47333',
      token: 'oa1_test',
    })).not.toThrow()
  })

  it('does not treat hostnames beginning with 127. as loopback', async () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('127.1')).toBe(false) // URL normalizes this before the check
    expect(isLoopbackHost('[::1]')).toBe(true)
    expect(isLoopbackHost('[::ffff:7f00:1]')).toBe(true)
    expect(isLoopbackHost('[::ffff:127.0.0.1]')).toBe(true)
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('127.evil.com')).toBe(false)
    expect(isLoopbackHost('127.0.0.1.attacker.tld')).toBe(false)
    const fetchMock = vi.fn<typeof fetch>()
    const client = createUTAClient({
      baseUrl: 'http://127.evil.com:47333',
      token: 'oa1_test',
      fetch: fetchMock,
    })
    await expect(client.get('/__uta/health')).rejects.toThrow(/non-loopback/)
    expect(fetchMock).not.toHaveBeenCalled()
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
