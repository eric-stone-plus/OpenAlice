import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { scrubText } from '../core/scrub.js';
import type { Logger } from './logger.js';

/** Max scrollback bytes persisted per shell pause. Anything older is truncated. */
const SCROLLBACK_CAP_BYTES = 1 * 1024 * 1024; // 1 MiB

/**
 * V3.S5 — small per-record scrollback persistence for shell sessions.
 *
 * Lives at `${stateRoot}/scrollback/<wsId>/<sessionId>.bin`. On shell pause
 * the launcher dumps the in-memory `ReplayBuffer`'s tail (last 1 MiB) here;
 * on resume the bytes are read back and prepended to the fresh PTY's buffer
 * via `PersistentSession`'s `initialReplayBytes` option so the user sees
 * what was on screen before, with the new prompt below.
 *
 * For agent sessions (claude / codex) this isn't needed — the agent itself
 * persists its conversation in its own transcript store and re-renders the
 * UI on resume. We only run this for the `shell` adapter where the launcher
 * is the only thing that knows about scrollback.
 */
export class ScrollbackStore {
  private readonly dir: string;

  constructor(stateRoot: string, private readonly logger: Logger) {
    this.dir = join(stateRoot, 'scrollback');
  }

  /**
   * Truncate `bytes` to the tail (last `SCROLLBACK_CAP_BYTES`) and write to
   * `<dir>/<wsId>/<sessionId>.bin`. Returns the path relative to `dir` so
   * callers can stash it in the SessionRecord.
   */
  async dump(wsId: string, sessionId: string, bytes: Buffer): Promise<string> {
    const rel = `${wsId}/${sessionId}.bin`;
    const abs = join(this.dir, rel);
    await mkdir(dirname(abs), { recursive: true, mode: 0o700 });
    const tail =
      bytes.length > SCROLLBACK_CAP_BYTES ? bytes.subarray(bytes.length - SCROLLBACK_CAP_BYTES) : bytes;
    // A shell command that prints a provider token would otherwise persist it
    // in scrollback. Scrub known token formats before the bytes hit disk.
    // latin1 is a lossless byte↔string mapping: binary PTY output survives,
    // while the ASCII token patterns are still matched.
    const scrubbed = Buffer.from(scrubText(tail.toString('latin1')), 'latin1');
    // Atomic write: write to tmp, rename. Crash mid-write doesn't leave a
    // half-flushed scrollback file (and prevents readers from racing).
    const tmp = `${abs}.tmp`;
    await writeFile(tmp, scrubbed, { mode: 0o600 });
    // `mode` only applies on creation; a stale tmp from an older build may be
    // 0644 and would carry that mode through the rename.
    await chmod(tmp, 0o600).catch(() => undefined);
    const { rename } = await import('node:fs/promises');
    await rename(tmp, abs);
    this.logger.info('scrollback.dumped', {
      wsId,
      sessionId,
      original: bytes.length,
      written: tail.length,
    });
    return rel;
  }

  async read(rel: string): Promise<Buffer | null> {
    try {
      const abs = join(this.dir, rel);
      const bytes = await readFile(abs);
      await chmod(abs, 0o600).catch(() => undefined);
      // Older scrollback files predate the write-side scrub.
      return Buffer.from(scrubText(bytes.toString('latin1')), 'latin1');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn('scrollback.read_failed', { rel, err });
      }
      return null;
    }
  }

  async remove(rel: string): Promise<void> {
    try {
      await rm(join(this.dir, rel), { force: true });
    } catch (err) {
      this.logger.warn('scrollback.remove_failed', { rel, err });
    }
  }

  /** Drop the entire scrollback subtree for a workspace (workspace deletion). */
  async removeAllFor(wsId: string): Promise<void> {
    try {
      await rm(join(this.dir, wsId), { recursive: true, force: true });
    } catch (err) {
      this.logger.warn('scrollback.remove_all_failed', { wsId, err });
    }
  }
}
