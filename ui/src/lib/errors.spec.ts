import { describe, expect, it } from 'vitest'

import { INTERRUPTED_MESSAGE, isAbortError, isAbortMessage } from './errors'

describe('abort errors', () => {
  it('recognizes a DOMException AbortError', () => {
    expect(isAbortError(new DOMException('The operation was aborted.', 'AbortError'))).toBe(true)
  })

  it('recognizes named and message-shaped aborts', () => {
    const named = new Error('cancelled')
    named.name = 'AbortError'
    expect(isAbortError(named)).toBe(true)
    expect(isAbortError(new Error('The operation was aborted.'))).toBe(true)
    expect(isAbortMessage('This operation was aborted')).toBe(true)
  })

  it('keeps real failures visible', () => {
    expect(isAbortError(new Error('network down'))).toBe(false)
    expect(isAbortError('aborted')).toBe(false)
    expect(isAbortMessage('network down')).toBe(false)
    expect(isAbortMessage(null)).toBe(false)
  })

  it('does not leak the raw cancellation copy', () => {
    expect(INTERRUPTED_MESSAGE).not.toMatch(/aborted/i)
  })
})
