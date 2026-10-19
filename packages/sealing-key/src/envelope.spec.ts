import { describe, expect, it } from 'vitest'

import {
  hasSealedMarker,
  isSealedEnvelope,
  sealWithKey,
  unsealWithKey,
  UnsealError,
} from './index.js'

const key = Buffer.alloc(32, 3)

describe('sealed envelope markers', () => {
  it('separates the marker check from full envelope validation', () => {
    expect(hasSealedMarker({ $sealed: 1 })).toBe(true)
    expect(isSealedEnvelope({ $sealed: 1 })).toBe(false)
    expect(hasSealedMarker({ $sealed: 2 })).toBe(false)
    expect(isSealedEnvelope([])).toBe(false)
  })

  it('rejects a malformed envelope instead of treating it as plaintext', () => {
    expect(() => unsealWithKey(key, { $sealed: 1 })).toThrow(UnsealError)
    expect(() => unsealWithKey(key, { $sealed: 1, alg: '', iv: '', tag: '', data: '' }))
      .toThrow(UnsealError)
  })

  it('round-trips a sealed value', () => {
    const envelope = sealWithKey(key, { secret: 'value' })
    expect(isSealedEnvelope(envelope)).toBe(true)
    expect(unsealWithKey(key, envelope)).toEqual({ secret: 'value' })
  })
})
