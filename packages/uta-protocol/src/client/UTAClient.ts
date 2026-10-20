/**
 * UTA client SDK — HTTP transport from Alice to the UTA service.
 *
 * `createUTAClient({ baseUrl })` returns a low-level HTTP helper. Higher-
 * level adapters (`UTAManagerSDK`, `UTAAccountSDK` in
 * `src/services/uta-client/`) layer typed domain operations on top.
 *
 * Errors are normalized into JS Errors. Future iterations may add zod-
 * validation per endpoint and `WireBrokerError` round-trip for typed
 * downstream error handling in the AI tool layer.
 */

export interface UTAClientOptions {
  /** UTA service base URL, e.g. `http://127.0.0.1:47333`. */
  baseUrl: string
  /** Optional fetch override (for testing). Defaults to global fetch. */
  fetch?: typeof globalThis.fetch
  /** Request timeout in ms. Default 15s. */
  timeoutMs?: number
  /** Local bearer token. When set, every request carries
   *  `Authorization: Bearer <token>`. UTA rejects unauthenticated requests. */
  token?: string
}

export interface UTAClient {
  readonly baseUrl: string
  request<T = unknown>(method: string, path: string, opts?: RequestOpts): Promise<T>
  get<T = unknown>(path: string, params?: Record<string, string | number | undefined>): Promise<T>
  post<T = unknown>(path: string, body?: unknown): Promise<T>
  put<T = unknown>(path: string, body?: unknown): Promise<T>
  delete<T = unknown>(path: string): Promise<T>
}

export interface RequestOpts {
  body?: unknown
  params?: Record<string, string | number | undefined>
  signal?: AbortSignal
}

export class UTAHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    message: string,
  ) {
    super(message)
    this.name = 'UTAHttpError'
  }
}

/** Strict loopback check for a URL hostname.
 *
 *  WHATWG `URL` normalizes legacy IPv4 forms (`127.1` -> `127.0.0.1`), so a
 *  literal dotted quad is enough. Never use a prefix match here:
 *  `127.evil.com` and `127.0.0.1.attacker.tld` are hostnames, not loopback. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  if (
    host === 'localhost'
    || host === '[::1]'
    || host === '[::ffff:127.0.0.1]'
    || host === '[::ffff:7f00:1]'
  ) return true
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!match) return false
  const [a, b, c, d] = match.slice(1).map(Number) as [number, number, number, number]
  return a === 127 && b <= 255 && c <= 255 && d <= 255
}

/** Refuse to attach the local bearer token to a non-loopback base URL.
 *  Callers that build their own fetch (the BFF proxy, broker-pack probe) use
 *  this too, so the SDK is not the only guard. */
export function assertLoopbackForLocalToken(baseUrl: string): void {
  let hostname: string
  try {
    hostname = new URL(baseUrl).hostname
  } catch {
    throw new Error('UTA base URL is not a valid URL')
  }
  if (!isLoopbackHost(hostname)) {
    throw new Error('refusing to send the local bearer token to a non-loopback UTA URL')
  }
}

export function createUTAClient(options: UTAClientOptions): UTAClient {
  const baseUrl = options.baseUrl.replace(/\/$/, '')
  const fetchImpl = options.fetch ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? 15_000

  function buildUrl(path: string, params?: Record<string, string | number | undefined>): string {
    const url = new URL(`${baseUrl}${path.startsWith('/') ? path : `/${path}`}`)
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) url.searchParams.set(k, String(v))
      }
    }
    return url.toString()
  }

  async function request<T>(method: string, path: string, opts: RequestOpts = {}): Promise<T> {
    // Validate at request time, not construction time: lite mode still builds
    // a client, and a stale non-loopback URL must not abort startup before the
    // first request. No request is sent with the token when this throws.
    if (options.token) assertLoopbackForLocalToken(baseUrl)
    const url = buildUrl(path, opts.params)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const signal = opts.signal ?? controller.signal
    const init: RequestInit = {
      method,
      headers: {
        'content-type': 'application/json',
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      signal,
    }
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body)
    try {
      const res = await fetchImpl(url, init)
      const text = await res.text()
      const body = text ? safeJSON(text) : undefined
      if (!res.ok) {
        const msg = typeof body === 'object' && body && 'error' in body
          ? String((body as { error: unknown }).error)
          : `UTA ${method} ${path} returned ${res.status}`
        throw new UTAHttpError(res.status, body, msg)
      }
      return body as T
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    baseUrl,
    request,
    get: <T>(path: string, params?: Record<string, string | number | undefined>) =>
      request<T>('GET', path, { params }),
    post: <T>(path: string, body?: unknown) => request<T>('POST', path, { body }),
    put: <T>(path: string, body?: unknown) => request<T>('PUT', path, { body }),
    delete: <T>(path: string) => request<T>('DELETE', path),
  }
}

function safeJSON(text: string): unknown {
  try { return JSON.parse(text) } catch { return text }
}
