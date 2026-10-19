import { appendFileSync, chmodSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'

const DEFAULT_MAX_LOG_BYTES = 512 * 1024

// Mirrors src/core/scrub.ts. The desktop tsconfig has a src-rooted rootDir,
// so it cannot import the server module directly; keep the patterns in sync.
const SCRUB_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
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

function scrubText(text: string): string {
  let output = text
  for (const [pattern, replacement] of SCRUB_PATTERNS) output = output.replace(pattern, replacement)
  return output
}

export class BoundedTextTail {
  private value = ''

  constructor(private readonly maxCharacters = 12_000) {}

  append(chunk: string | Uint8Array): void {
    this.value += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    if (this.value.length > this.maxCharacters) {
      this.value = this.value.slice(-this.maxCharacters)
    }
  }

  text(): string {
    return this.value
  }
}

export class DesktopDiagnostics {
  constructor(
    readonly path: string,
    private readonly maxLogBytes = DEFAULT_MAX_LOG_BYTES,
  ) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    try {
      if (statSync(path).size > maxLogBytes) {
        try { unlinkSync(`${path}.previous`) } catch { /* no previous log */ }
        renameSync(path, `${path}.previous`)
      }
    } catch {
      // A missing or concurrently rotated log starts fresh.
    }
  }

  write(source: string, message: string | Uint8Array): void {
    const text = typeof message === 'string' ? message : Buffer.from(message).toString('utf8')
    const normalized = text.endsWith('\n') ? text : `${text}\n`
    try {
      appendFileSync(
        this.path,
        `[${new Date().toISOString()}] [${source}] ${scrubText(normalized)}`,
        { encoding: 'utf8', mode: 0o600 },
      )
      chmodSync(this.path, 0o600)
    } catch {
      // Diagnostics must never become a new startup failure.
    }
  }
}

export function conciseDiagnosticTail(raw: string, maxLines = 8): string {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-maxLines)
    .join('\n')
}
