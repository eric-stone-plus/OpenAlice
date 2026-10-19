/**
 * Best-effort credential scrubbing for logs, diagnostics, and scrollback.
 *
 * This is a backstop, not a substitute for never logging secrets. It catches
 * the token formats that appear in provider errors and shell output; it does
 * not try to be a full secret scanner.
 */
const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{20,}/g, '[redacted]'],
  [/(?<![A-Za-z0-9_-])sk-(?:proj-|live-)?[A-Za-z0-9_-]{20,}/g, '[redacted]'],
  [/AKIA[0-9A-Z]{16}/g, '[redacted]'],
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, '[redacted]'],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, '[redacted]'],
  [/Authorization:\s*Bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, 'Authorization: Bearer [redacted]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted private key]'],
  [
    /((?:api[_-]?key|api[_-]?secret|secret[_-]?key|passphrase|password|authorization|bearer|access[_-]?token|refresh[_-]?token|admin[_-]?token|bootstrap[_-]?token)\s*[:=]\s*["']?)[A-Za-z0-9_\-./+]{16,}/gi,
    '$1[redacted]',
  ],
]

export function scrubText(text: string): string {
  let output = text
  for (const [pattern, replacement] of PATTERNS) {
    output = output.replace(pattern, replacement)
  }
  return output
}

/** Recursively scrub string values while preserving the object shape. */
export function scrubValue<T>(value: T): T {
  if (typeof value === 'string') return scrubText(value) as T
  if (Array.isArray(value)) return value.map(item => scrubValue(item)) as T
  if (value instanceof Error) {
    const out: Record<string, unknown> = {
      name: value.name,
      message: scrubText(value.message),
      ...(value.stack ? { stack: scrubText(value.stack) } : {}),
    }
    if ('cause' in value && value.cause !== undefined) out['cause'] = scrubValue(value.cause)
    return out as T
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = scrubValue(child)
    }
    return out as T
  }
  return value
}
