import {
  bindVerifiedRelease,
  verifyUpdateManifest,
  MAX_MANIFEST_BYTES,
  type LinuxUpdateManifest,
} from './update-manifest.js'
import type { SignedLinuxFeed } from './update-signing-keys.js'

const FEED_TIMEOUT_MS = 15_000

export type { SignedLinuxFeed }

export interface FeedRelease {
  readonly version: string
  readonly files: ReadonlyArray<{ readonly url: string; readonly sha512?: string; readonly size?: number }>
}

/**
 * Fetch the detached-signed Linux manifest for `release` and bind it to the
 * feed metadata electron-updater selected. The signature is verified over the
 * exact bytes before any field is used.
 */
export async function fetchVerifiedLinuxManifest(input: {
  readonly feed: SignedLinuxFeed
  readonly channel: string
  readonly appId: string
  readonly release: FeedRelease
}, fetchImpl: typeof fetch = fetch): Promise<LinuxUpdateManifest> {
  const feedBase = new URL(ensureSlash(input.feed.feedUrl))
  const manifestUrl = new URL(feedBase.href)
  // Resolve beside the feed path, not with a relative URL, so a feed URL with
  // a query token keeps that query on both the manifest and its signature.
  manifestUrl.pathname = `${feedBase.pathname}${input.channel}-linux-update.json`
  if (manifestUrl.protocol !== 'https:') throw new Error('Signed Linux update feed must use HTTPS')
  const signatureUrl = new URL(manifestUrl.href)
  signatureUrl.pathname = `${manifestUrl.pathname}.sig`
  const [manifestBytes, signature] = await Promise.all([
    fetchBytes(manifestUrl, fetchImpl),
    fetchJson(signatureUrl, fetchImpl),
  ])
  if (manifestBytes.byteLength > MAX_MANIFEST_BYTES) {
    throw new Error('Update manifest exceeds the 64 KiB limit')
  }
  const manifest = verifyUpdateManifest({
    manifestBytes,
    signature,
    publicKeyPem: input.feed.publicKeyPem,
    expectedKeyId: input.feed.keyId,
    expected: {
      product: 'open-alice',
      appId: input.appId,
      channel: input.channel,
    },
  })
  bindVerifiedRelease(manifest, input.release)
  return manifest
}

async function fetchBytes(url: URL, fetchImpl: typeof fetch): Promise<Buffer> {
  const response = await fetchImpl(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
    headers: { accept: 'application/json' },
  })
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`Update manifest request failed: HTTP ${response.status}`)
  }
  const length = Number(response.headers.get('content-length') ?? '0')
  if (Number.isFinite(length) && length > MAX_MANIFEST_BYTES) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error('Update manifest exceeds the 64 KiB limit')
  }
  const reader = response.body?.getReader()
  if (!reader) {
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.byteLength > MAX_MANIFEST_BYTES) throw new Error('Update manifest exceeds the 64 KiB limit')
    return bytes
  }
  const chunks: Buffer[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      // Enforce the cap on bytes actually received; content-length can be
      // absent or understated by a hostile feed.
      if (total > MAX_MANIFEST_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new Error('Update manifest exceeds the 64 KiB limit')
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, total)
}

async function fetchJson(url: URL, fetchImpl: typeof fetch): Promise<unknown> {
  const bytes = await fetchBytes(url, fetchImpl)
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown
  } catch {
    throw new Error('Update manifest signature is not valid JSON')
  }
}

function ensureSlash(value: string): string {
  // Use the URL parser so a feed URL with a query string keeps the query
  // after the path slash instead of appending `/` to the whole string.
  const url = new URL(value)
  if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`
  return url.toString()
}
