const ABORT_MESSAGE = /\b(?:the|this) operation was aborted\b/i

/**
 * Cancellation is a control-flow signal, not a user-facing failure. Browser
 * fetches reject with a DOMException named `AbortError`; the backend forwards
 * the same condition as a plain message, so both shapes are recognized here.
 */
export function isAbortError(error: unknown): boolean {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    return error.name === 'AbortError'
  }
  if (error instanceof Error) {
    return error.name === 'AbortError' || ABORT_MESSAGE.test(error.message)
  }
  return false
}

/** Snapshot errors cross the wire as strings, without the DOMException name. */
export function isAbortMessage(message: string | null | undefined): boolean {
  return typeof message === 'string' && ABORT_MESSAGE.test(message)
}

/** Replaces the raw cancellation copy in surfaces the user actually reads. */
export const INTERRUPTED_MESSAGE = 'The request was interrupted. Try again.'
