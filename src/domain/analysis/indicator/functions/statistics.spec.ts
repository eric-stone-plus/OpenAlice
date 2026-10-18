import { describe, expect, it } from 'vitest'
import { HIGHEST, LOWEST, MAX, MIN } from './statistics'

describe('statistics large-series safety', () => {
  it('handles 200k points without spreading the array', () => {
    const values = Array.from({ length: 200_000 }, (_, i) => i)
    expect(MAX(values)).toBe(199_999)
    expect(MIN(values)).toBe(0)
    expect(HIGHEST(values, 200_000)).toBe(199_999)
    expect(LOWEST(values, 200_000)).toBe(0)
  })

  it('returns the extreme of the trailing window', () => {
    expect(HIGHEST([5, 1, 9, 3], 2)).toBe(9)
    expect(LOWEST([5, 1, 9, 3], 2)).toBe(3)
  })

  it('still rejects empty input', () => {
    expect(() => MAX([])).toThrow('MAX requires at least 1 data point')
    expect(() => MIN([])).toThrow('MIN requires at least 1 data point')
    expect(() => HIGHEST([], 5)).toThrow('HIGHEST requires at least 1 data point')
    expect(() => LOWEST([], 5)).toThrow('LOWEST requires at least 1 data point')
  })

  it('propagates NaN regardless of its position', () => {
    expect(MAX([1, Number.NaN, 3])).toBeNaN()
    expect(MAX([Number.NaN, 1, 3])).toBeNaN()
    expect(MIN([1, Number.NaN, 3])).toBeNaN()
    expect(HIGHEST([1, Number.NaN, 3], 3)).toBeNaN()
    expect(LOWEST([1, Number.NaN, 3], 3)).toBeNaN()
  })
})
