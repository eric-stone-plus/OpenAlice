import { describe, expect, it } from 'vitest'

import { MACD } from './technical'

/**
 * Reference implementation: recompute each EMA from the prefix, which is the
 * behavior MACD had before the O(n) refactor. Kept intentionally naive so the
 * test catches a change in the EMA seed or the history window.
 */
function naiveEma(values: number[], period: number): number {
  let ema = values.slice(0, period).reduce((acc, value) => acc + value, 0) / period
  const multiplier = 2 / (period + 1)
  for (let i = period; i < values.length; i++) {
    ema = (values[i] - ema) * multiplier + ema
  }
  return ema
}

function naiveMacd(values: number[], fastPeriod: number, slowPeriod: number, signalPeriod: number) {
  const macdValue = naiveEma(values, fastPeriod) - naiveEma(values, slowPeriod)
  const history: number[] = []
  for (let i = slowPeriod; i <= values.length; i++) {
    const slice = values.slice(0, i)
    history.push(naiveEma(slice, fastPeriod) - naiveEma(slice, slowPeriod))
  }
  const signalValue = naiveEma(history, signalPeriod)
  return { macd: macdValue, signal: signalValue, histogram: macdValue - signalValue }
}

describe('MACD', () => {
  it('matches the per-prefix EMA reference', () => {
    const values = Array.from({ length: 120 }, (_, i) => 100 + Math.sin(i / 7) * 3 + i * 0.01)
    const expected = naiveMacd(values, 12, 26, 9)
    const actual = MACD(values, 12, 26, 9)
    expect(actual.macd).toBeCloseTo(expected.macd, 10)
    expect(actual.signal).toBeCloseTo(expected.signal, 10)
    expect(actual.histogram).toBeCloseTo(expected.histogram, 10)
  })

  it('rejects series shorter than the slow and signal windows', () => {
    expect(() => MACD([1, 2, 3], 12, 26, 9)).toThrow(/MACD requires/)
  })
})
