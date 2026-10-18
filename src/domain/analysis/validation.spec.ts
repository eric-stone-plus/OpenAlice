import { describe, expect, it } from 'vitest'
import {
  applyTransactionCosts,
  deflatedSharpeRatio,
  expectedMaxSharpe,
  normalCdf,
  normalInverse,
  outOfSampleReturns,
  outOfSampleSeries,
  probabilityOfBacktestOverfitting,
  probabilisticSharpeRatio,
  sharpeRatio,
  walkForwardSplits,
} from './validation'

const positive = [0.01, -0.005, 0.012, 0.003, -0.008, 0.015, 0.002, -0.004, 0.009, 0.006]
const negative = positive.map((value) => -value)

describe('walk-forward splits', () => {
  it('creates non-overlapping test windows with an embargo', () => {
    const splits = walkForwardSplits(100, { trainSize: 30, testSize: 10, embargo: 2, step: 10 })
    expect(splits[0]).toEqual({ trainStart: 0, trainEnd: 30, testStart: 32, testEnd: 42 })
    expect(splits[1]).toEqual({ trainStart: 10, trainEnd: 40, testStart: 42, testEnd: 52 })
    expect(splits).toHaveLength(6)
    for (let i = 1; i < splits.length; i++) {
      expect(splits[i].testStart).toBeGreaterThanOrEqual(splits[i - 1].testEnd)
    }
    expect(splits[splits.length - 1].testEnd).toBeLessThanOrEqual(100)
  })

  it('rejects overlapping test windows and impossible windows', () => {
    expect(() => walkForwardSplits(10, { trainSize: 0, testSize: 5 })).toThrow('trainSize')
    expect(() => walkForwardSplits(10, { trainSize: 5, testSize: 5, embargo: -1 })).toThrow('embargo')
    expect(() =>
      walkForwardSplits(100, { trainSize: 30, testSize: 10, step: 5 }),
    ).toThrow('step must be >=')
    expect(walkForwardSplits(10, { trainSize: 8, testSize: 5 })).toEqual([])
  })
})

describe('out-of-sample series', () => {
  it('uses the prior close position to avoid lookahead', () => {
    const closes = [100, 110, 121, 133.1]
    const positions = [0, 1, 1, 0]
    const splits = [{ trainStart: 0, trainEnd: 1, testStart: 1, testEnd: 4 }]
    const series = outOfSampleSeries(closes, positions, splits)
    expect(series.returns).toHaveLength(3)
    expect(series.returns[0]).toBeCloseTo(0, 12)
    expect(series.returns[1]).toBeCloseTo(0.1, 12)
    expect(series.returns[2]).toBeCloseTo(0.1, 12)
    expect(series.positions).toEqual([0, 1, 1])
    expect(outOfSampleReturns(closes, positions, splits)).toEqual(series.returns)
  })

  it('counts a bar once when splits overlap', () => {
    const closes = [100, 101, 102, 103, 104, 105]
    const positions = [1, 1, 1, 1, 1, 1]
    const splits = [
      { trainStart: 0, trainEnd: 1, testStart: 1, testEnd: 4 },
      { trainStart: 0, trainEnd: 1, testStart: 2, testEnd: 5 },
    ]
    expect(outOfSampleSeries(closes, positions, splits).returns).toHaveLength(4)
  })

  it('rejects misaligned inputs and invalid splits', () => {
    expect(() => outOfSampleSeries([1, 2], [1], [])).toThrow('must align')
    expect(() =>
      outOfSampleSeries([1, 2, 3], [1, 1, 1], [
        { trainStart: 0, trainEnd: 2, testStart: 1, testEnd: 3 },
      ]),
    ).toThrow('invalid split')
  })
})

describe('transaction costs', () => {
  it('charges one-way turnover at the start of each return period', () => {
    const net = applyTransactionCosts([0.01, 0.01, 0.01], [0, 1, 0], 10)
    expect(net).toHaveLength(3)
    expect(net[0]).toBeCloseTo(0.01, 12)
    expect(net[1]).toBeCloseTo(0.009, 12)
    expect(net[2]).toBeCloseTo(0.009, 12)
  })

  it('charges a flip from long to short twice', () => {
    const one = applyTransactionCosts([0.02], [1], 10)
    expect(one[0]).toBeCloseTo(0.019, 12)
    const flip = applyTransactionCosts([0.02, 0.02], [1, -1], 10)
    expect(flip[0]).toBeCloseTo(0.019, 12)
    expect(flip[1]).toBeCloseTo(0.018, 12)
  })

  it('does not charge an entry that happened before the window', () => {
    const net = applyTransactionCosts([0.01, 0.01], [1, 1], 10, 1)
    expect(net[0]).toBeCloseTo(0.01, 12)
    expect(net[1]).toBeCloseTo(0.01, 12)
  })

  it('rejects negative or non-finite costs', () => {
    expect(() => applyTransactionCosts([0.01], [1], -1)).toThrow('costBps')
    expect(() => applyTransactionCosts([0.01], [1], Number.NaN)).toThrow('costBps')
  })
})

describe('probabilistic Sharpe ratio', () => {
  it('matches the published formula on the reference series', () => {
    expect(probabilisticSharpeRatio(positive)).toBeCloseTo(0.9248728816, 6)
    expect(probabilisticSharpeRatio(negative)).toBeLessThan(0.5)
  })

  it('is undefined for a flat series or fewer than four observations', () => {
    expect(probabilisticSharpeRatio([0, 0, 0, 0])).toBeNaN()
    expect(probabilisticSharpeRatio([0.01])).toBeNaN()
    expect(probabilisticSharpeRatio([0.01, 0.02])).toBeNaN()
    expect(probabilisticSharpeRatio([0.01, 0.02, 0.03])).toBeNaN()
  })

  it('normal CDF and inverse agree with reference values', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 7)
    expect(normalCdf(1.96)).toBeCloseTo(0.9750021049, 6)
    expect(normalInverse(0.975)).toBeCloseTo(1.9599639845, 6)
    expect(normalInverse(0.5)).toBeCloseTo(0, 10)
  })
})

describe('deflated Sharpe ratio', () => {
  it('equals the PSR for a single trial and falls as trials grow', () => {
    const base = probabilisticSharpeRatio(positive)
    expect(deflatedSharpeRatio(positive, 1)).toBeCloseTo(base, 10)
    const ten = deflatedSharpeRatio(positive, 10)
    const hundred = deflatedSharpeRatio(positive, 100)
    expect(ten).toBeCloseTo(0.4884332607, 6)
    expect(ten).toBeLessThan(deflatedSharpeRatio(positive, 1))
    expect(hundred).toBeLessThan(ten)
  })

  it('expected maximum Sharpe matches the reference values', () => {
    expect(expectedMaxSharpe(1, 0.01)).toBe(0)
    expect(expectedMaxSharpe(2, 0.01)).toBeCloseTo(0.0519755344, 6)
    expect(expectedMaxSharpe(10, 0.01)).toBeCloseTo(0.1574598301, 6)
    expect(expectedMaxSharpe(100, 0.01)).toBeCloseTo(0.2530602893, 6)
  })

  it('rejects invalid trial counts and variances', () => {
    expect(() => expectedMaxSharpe(0, 0.01)).toThrow('trials')
    expect(() => expectedMaxSharpe(1.1, 0.01)).toThrow('trials')
    expect(() => expectedMaxSharpe(10, 0)).toThrow('varianceOfSharpe')
    expect(() => expectedMaxSharpe(10, -0.1)).toThrow('varianceOfSharpe')
    expect(() => deflatedSharpeRatio(positive, 0)).toThrow('trials')
    expect(() => deflatedSharpeRatio(positive, 10, -0.1)).toThrow('varianceOfSharpe')
  })
})

describe('probability of backtest overfitting', () => {
  it('is low when one strategy dominates every period', () => {
    const dominant = [
      Array.from({ length: 16 }, (_, i) => 0.02 + (i % 3) * 0.001),
      Array.from({ length: 16 }, (_, i) => 0.001 * Math.sin(i)),
      Array.from({ length: 16 }, (_, i) => 0.0005 * Math.cos(i)),
    ]
    expect(probabilityOfBacktestOverfitting(dominant, 8)).toBeLessThan(0.2)
  })

  it('is high when the in-sample winner reverses out of sample', () => {
    const overfit = [
      [2, 1, 2, 1, 2, 1, -1, -2, -1, -2, -1, -2],
      [-1, -2, -1, -2, -1, -2, 2, 1, 2, 1, 2, 1],
    ]
    expect(probabilityOfBacktestOverfitting(overfit, 6)).toBe(1)
  })

  it('does not call identical strategies overfit', () => {
    const identical = Array.from({ length: 4 }, () =>
      Array.from({ length: 16 }, (_, i) => 0.01 * Math.sin(i)),
    )
    expect(probabilityOfBacktestOverfitting(identical, 8)).toBe(0)
  })

  it('uses the columns beyond the first 16 when the edge is there', () => {
    const noise = (i: number) => 0.001 * Math.sin(i * 1.7)
    const edge = (i: number) => 0.05 + 0.01 * ((i % 3) - 1)
    const performance = [
      Array.from({ length: 31 }, (_, i) => (i >= 16 ? edge(i) : noise(i))),
      Array.from({ length: 31 }, (_, i) => noise(i + 1)),
      Array.from({ length: 31 }, (_, i) => noise(i + 2)),
    ]
    expect(probabilityOfBacktestOverfitting(performance, 16)).toBeLessThan(0.5)
  })

  it('rejects degenerate matrices and invalid split counts', () => {
    expect(probabilityOfBacktestOverfitting([[1, 2, 3, 4]])).toBeNaN()
    expect(probabilityOfBacktestOverfitting([[1, 2], [3, 4]])).toBeNaN()
    expect(() => probabilityOfBacktestOverfitting([[1, 2, 3, 4], [5, 6, 7, 8]], 5)).toThrow(
      'splits',
    )
    expect(() => probabilityOfBacktestOverfitting([[1, 2, 3, 4], [5, 6, 7, 8]], 22)).toThrow(
      'splits',
    )
  })
})

describe('sharpe ratio', () => {
  it('matches the reference value and annualises by sqrt(periods)', () => {
    expect(sharpeRatio(positive)).toBeCloseTo(0.5144957554, 6)
    expect(sharpeRatio(positive, 252)).toBeCloseTo(sharpeRatio(positive) * Math.sqrt(252), 10)
    expect(sharpeRatio(negative)).toBeLessThan(0)
    expect(sharpeRatio([0, 0, 0])).toBeNaN()
  })
})
