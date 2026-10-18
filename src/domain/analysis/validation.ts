/**
 * Out-of-sample validation primitives for the analysis layer.
 *
 * The literature is consistent that in-sample backtests overstate performance
 * and that the overstatement grows with the number of trials:
 *
 * - Bailey, Borwein, López de Prado & Zhu (2014), "Pseudo-Mathematics and
 *   Financial Charlatanism", Notices of the AMS — backtest overfitting.
 * - Bailey, Borwein, López de Prado & Zhu (2016), "The Probability of Backtest
 *   Overfitting", Journal of Computational Finance — CSCV / PBO.
 * - Bailey & López de Prado (2014), "The Deflated Sharpe Ratio", Journal of
 *   Portfolio Management — selection bias under multiple testing.
 * - Harvey, Liu & Zhu (2016), "…and the Cross-Section of Expected Returns",
 *   Review of Financial Studies — t > 3 hurdle for new factors.
 * - White (2000), "A Reality Check for Data Snooping", Econometrica.
 *
 * These are evaluation primitives, not a strategy. The caller owns model
 * fitting; the splits, costs, and metrics make leakage and selection explicit
 * instead of implicit.
 *
 * Documented assumptions:
 * - Returns are per-period and match the frequency of the bars; do not
 *   annualise before passing them to PSR/DSR.
 * - PSR/DSR are asymptotic normal approximations; they need a long track
 *   record (tens of observations at least) and they assume i.i.d. returns.
 * - `costBps` is a one-way cost per unit of turnover; a position flip from
 *   +1 to -1 pays two units.
 * - The DSR's default variance 1/(n-1) is a null-iid assumption, not a
 *   generally conservative choice; pass the empirical variance of the trial
 *   Sharpe ratios when it is available.
 * - The PBO uses the Sharpe ratio of the selected submatrix as the
 *   performance statistic (matching Bailey et al.); ties use average ranks
 *   and the strict below-median test.
 */

export interface WalkForwardSplit {
  /** Inclusive start of the training window. */
  trainStart: number
  /** Exclusive end of the training window. */
  trainEnd: number
  /** Inclusive start of the test window. */
  testStart: number
  /** Exclusive end of the test window. */
  testEnd: number
}

export interface WalkForwardOptions {
  trainSize: number
  testSize: number
  /** Bars skipped between train and test to break serial dependence. */
  embargo?: number
  /**
   * Bars the training window advances per fold. Defaults to `testSize`.
   * Must be at least `testSize` so the test windows do not overlap.
   */
  step?: number
}

export interface OutOfSampleSeries {
  /** Per-bar returns earned in the test windows. */
  returns: number[]
  /** Position held during each return (aligned with `returns`). */
  positions: number[]
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got ${value}`)
  }
}

/**
 * Rolling walk-forward folds with an optional embargo.
 *
 * The test windows are non-overlapping: `step` must be at least `testSize`
 * (the default is `testSize`). The training window always ends before the test
 * window starts, and `embargo` bars are skipped in between so that overlapping
 * labels cannot leak across the boundary.
 */
export function walkForwardSplits(length: number, options: WalkForwardOptions): WalkForwardSplit[] {
  assertPositiveInteger(length, 'length')
  assertPositiveInteger(options.trainSize, 'trainSize')
  assertPositiveInteger(options.testSize, 'testSize')
  const embargo = options.embargo ?? 0
  if (!Number.isInteger(embargo) || embargo < 0) {
    throw new Error(`embargo must be a non-negative integer, got ${embargo}`)
  }
  const step = options.step ?? options.testSize
  assertPositiveInteger(step, 'step')
  if (step < options.testSize) {
    throw new Error(
      `step must be >= testSize to keep test windows non-overlapping, got step=${step} testSize=${options.testSize}`,
    )
  }

  const splits: WalkForwardSplit[] = []
  for (let trainStart = 0; ; trainStart += step) {
    const trainEnd = trainStart + options.trainSize
    const testStart = trainEnd + embargo
    const testEnd = testStart + options.testSize
    if (testEnd > length) break
    splits.push({ trainStart, trainEnd, testStart, testEnd })
  }
  return splits
}

/**
 * Build the out-of-sample return/position series for a position series.
 *
 * `positions[i]` is the target position decided at the close of bar `i`; the
 * return from bar `i-1` to bar `i` is therefore earned by `positions[i-1]`.
 * Using the prior bar's position is what prevents lookahead when the signal is
 * computed from the same close.
 *
 * Bars covered by more than one split are counted once (the first split wins).
 * A zero prior close is skipped because the return is undefined; that is a
 * data-quality signal the caller should handle before the metrics.
 */
export function outOfSampleSeries(
  closes: number[],
  positions: number[],
  splits: WalkForwardSplit[],
): OutOfSampleSeries {
  if (closes.length !== positions.length) {
    throw new Error(`closes and positions must align: ${closes.length} vs ${positions.length}`)
  }
  const returns: number[] = []
  const held: number[] = []
  const seen = new Set<number>()
  for (const split of splits) {
    if (
      split.testStart < 0 ||
      split.testEnd > closes.length ||
      split.testStart > split.testEnd ||
      split.testStart < split.trainEnd
    ) {
      throw new Error(
        `invalid split [${split.testStart}, ${split.testEnd}) for ${closes.length} bars`,
      )
    }
    for (let i = split.testStart; i < split.testEnd; i++) {
      if (i <= 0 || seen.has(i)) continue
      seen.add(i)
      const prev = closes[i - 1]
      if (prev === 0) continue
      returns.push(((closes[i] - prev) / prev) * (positions[i - 1] ?? 0))
      held.push(positions[i - 1] ?? 0)
    }
  }
  return { returns, positions: held }
}

/** Convenience wrapper when only the returns are needed. */
export function outOfSampleReturns(
  closes: number[],
  positions: number[],
  splits: WalkForwardSplit[],
): number[] {
  return outOfSampleSeries(closes, positions, splits).returns
}

/**
 * Subtract one-way transaction costs from gross returns.
 *
 * `positions` must align with `returns` and represent the position held during
 * each return. Cost is charged on |position change| at the start of the period;
 * a position flip from +1 to -1 therefore pays two units of turnover.
 *
 * The first position is charged from `initialPosition` (default flat). Pass the
 * position held before the window when the entry happened outside it.
 */
export function applyTransactionCosts(
  returns: number[],
  positions: number[],
  costBps: number,
  initialPosition = 0,
): number[] {
  if (returns.length !== positions.length) {
    throw new Error(`returns and positions must align: ${returns.length} vs ${positions.length}`)
  }
  if (!Number.isFinite(costBps) || costBps < 0) {
    throw new Error(`costBps must be a finite non-negative number, got ${costBps}`)
  }
  let previous = initialPosition
  return returns.map((gross, i) => {
    const current = positions[i] ?? 0
    const turnover = Math.abs(current - previous)
    previous = current
    return gross - (turnover * costBps) / 10_000
  })
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function sampleStd(values: number[], average: number): number {
  if (values.length < 2) return 0
  const variance =
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1)
  return Math.sqrt(variance)
}

/** Annualised (or per-period when `periodsPerYear` = 1) Sharpe ratio. */
export function sharpeRatio(returns: number[], periodsPerYear = 1): number {
  if (returns.length < 2) return Number.NaN
  const average = mean(returns)
  const sd = sampleStd(returns, average)
  if (sd === 0) return Number.NaN
  return (average / sd) * Math.sqrt(periodsPerYear)
}

function skewness(values: number[], average: number): number {
  const n = values.length
  if (n < 3) return 0
  const m2 = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / n
  const m3 = values.reduce((sum, value) => sum + (value - average) ** 3, 0) / n
  if (m2 === 0) return 0
  return m3 / m2 ** 1.5
}

/** Raw (non-excess) kurtosis; a normal distribution returns 3. */
function kurtosis(values: number[], average: number): number {
  const n = values.length
  if (n < 4) return 3
  const m2 = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / n
  const m4 = values.reduce((sum, value) => sum + (value - average) ** 4, 0) / n
  if (m2 === 0) return 3
  return m4 / m2 ** 2
}

/** Abramowitz & Stegun 7.1.26; absolute error below 1.5e-7. */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1
  const ax = Math.abs(x)
  const t = 1 / (1 + 0.3275911 * ax)
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax)
  return sign * y
}

/** Standard normal CDF; max absolute error is about 7e-8. */
export function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2))
}

/**
 * Acklam's inverse normal CDF. Relative error is about 1e-9 for practical
 * inputs; the extreme tail (|p| near 0 or 1) is slightly worse.
 */
export function normalInverse(p: number): number {
  if (p <= 0) return Number.NEGATIVE_INFINITY
  if (p >= 1) return Number.POSITIVE_INFINITY

  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
    -3.066479806614716e1, 2.506628277459239,
  ]
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ]
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ]
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416]
  const plow = 0.02425
  const phigh = 1 - plow

  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p))
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    )
  }
  if (p > phigh) {
    const q = Math.sqrt(-2 * Math.log(1 - p))
    return (
      -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    )
  }
  const q = p - 0.5
  const r = q * q
  return (
    ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  )
}

/**
 * Probabilistic Sharpe Ratio: P(true SR > benchmark SR) given the observed
 * track record, correcting for sample length, skewness, and fat tails.
 *
 * The normal approximation is asymptotic. Fewer than 4 observations return
 * NaN; tens of observations are needed before the number is meaningful.
 */
export function probabilisticSharpeRatio(returns: number[], benchmarkSharpe = 0): number {
  const n = returns.length
  if (n < 4) return Number.NaN
  const average = mean(returns)
  const sd = sampleStd(returns, average)
  if (sd === 0) return Number.NaN
  const sr = average / sd
  const skew = skewness(returns, average)
  const kurt = kurtosis(returns, average)
  const denominator = Math.sqrt(Math.max(1e-12, 1 - skew * sr + ((kurt - 1) / 4) * sr * sr))
  return normalCdf(((sr - benchmarkSharpe) * Math.sqrt(n - 1)) / denominator)
}

/**
 * Expected maximum Sharpe ratio under the null across `trials` independent
 * strategies, given the variance of their Sharpe estimates.
 *
 * The expression is asymptotic; it is approximate for very small `trials`.
 */
export function expectedMaxSharpe(trials: number, varianceOfSharpe: number): number {
  if (!Number.isInteger(trials) || trials < 1) {
    throw new Error(`trials must be a positive integer, got ${trials}`)
  }
  if (trials === 1) return 0
  if (!Number.isFinite(varianceOfSharpe) || varianceOfSharpe <= 0) {
    throw new Error(
      `varianceOfSharpe must be a finite positive number for more than one trial, got ${varianceOfSharpe}`,
    )
  }
  const gamma = 0.5772156649015329
  const z1 = normalInverse(1 - 1 / trials)
  const z2 = normalInverse(1 - 1 / (trials * Math.E))
  return Math.sqrt(varianceOfSharpe) * ((1 - gamma) * z1 + gamma * z2)
}

/**
 * Deflated Sharpe Ratio: PSR evaluated against the expected maximum Sharpe
 * produced by `trials` attempts. This is the number to report when a strategy
 * was chosen after a search over parameters or universes and the trial count
 * and variance are honestly recorded.
 *
 * `varianceOfSharpe` is the variance of the trial Sharpe ratios. When it is
 * omitted, the null-iid variance 1/(n-1) is used. That default assumes the
 * trials were independent null draws; it is not a general conservative choice.
 */
export function deflatedSharpeRatio(
  returns: number[],
  trials: number,
  varianceOfSharpe?: number,
): number {
  const n = returns.length
  if (n < 4) return Number.NaN
  if (!Number.isInteger(trials) || trials < 1) {
    throw new Error(`trials must be a positive integer, got ${trials}`)
  }
  const variance = varianceOfSharpe ?? 1 / (n - 1)
  if (!Number.isFinite(variance) || variance <= 0) {
    throw new Error(`varianceOfSharpe must be a finite positive number, got ${variance}`)
  }
  return probabilisticSharpeRatio(returns, expectedMaxSharpe(trials, variance))
}

function combinations(n: number, k: number): number[][] {
  const result: number[][] = []
  const current: number[] = []
  const walk = (start: number): void => {
    if (current.length === k) {
      result.push([...current])
      return
    }
    for (let i = start; i <= n - (k - current.length); i++) {
      current.push(i)
      walk(i + 1)
      current.pop()
    }
  }
  walk(0)
  return result
}

function submatrixSharpe(row: number[], columns: number[]): number {
  const values = columns.map((column) => row[column])
  const average = mean(values)
  const sd = sampleStd(values, average)
  return sd === 0 ? 0 : average / sd
}

/**
 * Choose the largest even block count that keeps at least two columns per
 * block and minimises the discarded trailing columns. The default 16 on a
 * 31-column matrix would otherwise use only the first 16 columns.
 */
function chooseSplits(cols: number, requested: number): number {
  let best = 0
  let bestRemainder = Number.POSITIVE_INFINITY
  for (let s = Math.min(requested, 20); s >= 4; s -= 2) {
    const chunk = Math.floor(cols / s)
    if (chunk < 2) continue
    const remainder = cols - s * chunk
    if (remainder < bestRemainder || (remainder === bestRemainder && s > best)) {
      best = s
      bestRemainder = remainder
    }
  }
  return best
}

/**
 * Probability of Backtest Overfitting via combinatorially symmetric
 * cross-validation (Bailey et al., 2016).
 *
 * `performance` is a strategy × period matrix (rows are trials, columns are
 * returns). The function repeatedly splits the columns into equal halves,
 * selects the best strategy in-sample by its Sharpe ratio, and records its
 * out-of-sample Sharpe rank. A PBO near 0.5 means the in-sample winner is no
 * better than a coin flip out of sample; a low PBO is evidence the selection
 * carries information.
 *
 * `splits` must be an even integer in [4, 20]; the default 16 gives
 * C(16,8)=12870 combinations. The effective block count is reduced when
 * needed so that every block has at least two columns and the discarded
 * trailing columns are minimised. Ties use average ranks; exactly the median
 * out-of-sample rank is not counted as overfitting.
 */
export function probabilityOfBacktestOverfitting(
  performance: number[][],
  splits = 16,
): number {
  const rows = performance.length
  const cols = performance[0]?.length ?? 0
  if (rows < 2) return Number.NaN
  if (performance.some((row) => row.length !== cols)) {
    throw new Error('performance matrix rows must have equal length')
  }
  if (!Number.isInteger(splits) || splits < 4 || splits % 2 !== 0) {
    throw new Error(`splits must be an even integer >= 4, got ${splits}`)
  }
  if (splits > 20) {
    throw new Error(`splits must be <= 20 to keep the CSCV tractable, got ${splits}`)
  }

  const s = chooseSplits(cols, splits)
  if (s < 4) return Number.NaN
  const chunk = Math.floor(cols / s)
  const chunks = Array.from({ length: s }, (_, i) =>
    Array.from({ length: chunk }, (_, j) => i * chunk + j),
  )
  const logits: number[] = []

  for (const inSample of combinations(s, s / 2)) {
    const inSampleSet = new Set(inSample)
    const inSampleCols = inSample.flatMap((index) => chunks[index])
    const outSampleCols = chunks
      .filter((_, index) => !inSampleSet.has(index))
      .flatMap((columns) => columns)

    const inSamplePerf = performance.map((row) => submatrixSharpe(row, inSampleCols))
    const outSamplePerf = performance.map((row) => submatrixSharpe(row, outSampleCols))

    let best = 0
    for (let r = 1; r < rows; r++) {
      if (inSamplePerf[r] > inSamplePerf[best]) best = r
    }

    const bestOutSample = outSamplePerf[best]
    const below = outSamplePerf.filter((value) => value < bestOutSample).length
    const equal = outSamplePerf.filter((value) => value === bestOutSample).length
    const rank = below + (equal - 1) / 2
    const omega = (rank + 1) / (rows + 1)
    logits.push(Math.log(omega / (1 - omega)))
  }

  return logits.filter((logit) => logit < 0).length / logits.length
}
