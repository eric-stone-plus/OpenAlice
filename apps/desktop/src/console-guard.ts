import type { EventEmitter } from 'node:events'

type ConsoleMethod = 'log' | 'info' | 'warn' | 'error' | 'debug'

export type ConsoleSink = Pick<Console, ConsoleMethod>

function isEpipe(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && (error as NodeJS.ErrnoException).code === 'EPIPE'
}

/**
 * A terminal that launched the desktop app can disappear while the guardian
 * keeps running (closing the terminal window is the common case). The next
 * console write then hits a broken pipe: Node raises EPIPE, and because the
 * stream error is unhandled Electron renders it as a fatal main-process
 * dialog. Swallow EPIPE for stdout/stderr only — every other stream or write
 * error still surfaces.
 */
export function installConsoleEpipeGuard(
  streams: readonly EventEmitter[] = [process.stdout, process.stderr],
  target: ConsoleSink = console,
): () => void {
  const onStreamError = (error: NodeJS.ErrnoException) => {
    if (!isEpipe(error)) throw error
  }
  for (const stream of streams) stream.on('error', onStreamError)

  const originals = new Map<ConsoleMethod, ConsoleSink[ConsoleMethod]>()
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const original = target[method]
    const bound = original.bind(target) as (...args: unknown[]) => void
    originals.set(method, original)
    target[method] = (...args: unknown[]) => {
      try {
        bound(...args)
      } catch (error) {
        if (!isEpipe(error)) throw error
      }
    }
  }

  return () => {
    for (const stream of streams) stream.off('error', onStreamError)
    for (const [method, original] of originals) {
      target[method] = original as ConsoleSink[typeof method]
    }
  }
}
