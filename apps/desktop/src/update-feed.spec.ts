import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchVerifiedLinuxManifest } from './update-feed.js'
import { MAX_MANIFEST_BYTES } from './update-manifest.js'

const feed = {
  feedUrl: 'https://updates.example/openalice/',
  publicKeyPem: 'unused-in-error-paths',
  keyId: 'test-key',
}
const release = { version: '1.2.3', files: [] }

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchVerifiedLinuxManifest', () => {
  it('rejects a non-HTTPS feed before fetching', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(fetchVerifiedLinuxManifest({
      feed: { ...feed, feedUrl: 'http://updates.example/openalice/' },
      channel: 'latest',
      appId: 'com.traderalice.openalice',
      release,
    })).rejects.toThrow(/HTTPS/)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects an oversized manifest even when content-length is honest', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', {
      status: 200,
      headers: { 'content-length': String(MAX_MANIFEST_BYTES + 1) },
    })))
    await expect(fetchVerifiedLinuxManifest({
      feed,
      channel: 'latest',
      appId: 'com.traderalice.openalice',
      release,
    })).rejects.toThrow(/64 KiB/)
  })

  it('keeps a feed query token on the manifest and signature URLs', async () => {
    const fetch = vi.fn(async (_url: URL) => new Response('not found', { status: 404 }))
    vi.stubGlobal('fetch', fetch)
    await expect(fetchVerifiedLinuxManifest({
      feed: { ...feed, feedUrl: 'https://updates.example/openalice/?token=abc' },
      channel: 'beta',
      appId: 'com.traderalice.openalice',
      release,
    })).rejects.toThrow(/HTTP 404/)
    expect(fetch.mock.calls.map(call => String(call[0]))).toEqual([
      'https://updates.example/openalice/beta-linux-update.json?token=abc',
      'https://updates.example/openalice/beta-linux-update.json.sig?token=abc',
    ])
  })

  it('maps an HTTP failure to a feed error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })))
    await expect(fetchVerifiedLinuxManifest({
      feed,
      channel: 'beta',
      appId: 'com.traderalice.openalice',
      release,
    })).rejects.toThrow(/HTTP 404/)
  })
})
