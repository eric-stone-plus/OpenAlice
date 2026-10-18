# Algorithm research: what the literature actually says

Status: research note, 2026-10-18. This document is the evidence base for the
analysis-engine work. It deliberately presents the **disagreements** in the
literature, because the previous reference material (a private quant-analysis
repository) is a single practitioner's view and is partly stale. An adversarial
review of the first draft corrected several claims about that repository; those
corrections are incorporated below.

## Method

- Source: the OpenAlex API (no API key; free daily budget), 20 exact-title
  queries for seminal works, forward citation chains for 8 of them, and 12
  topic queries restricted to the Finance subfield (`primary_topic.subfield.id:2003`).
- 212 works were returned by the targeted sweep; the broad discovery sweep
  returned 480 entries across 24 topics. The targeted set is the evidence base;
  the broad set was used for discovery and is not separately synthesized.
- Abstracts were reconstructed from `abstract_inverted_index`. The 2026
  trend-regime paper was read in full; the remaining conclusions rely on
  abstracts and the papers' stated results.
- This is a targeted review, not a PRISMA-style systematic review. It is broad
  enough to identify the consensus and the live disputes, not to settle them.
  Section 13 lists the topics it does not cover.
- Query artifacts: `/tmp/opencode/openalex-research.md` (broad) and
  `/tmp/opencode/openalex-targeted.md` (seminal + topics). They are scratch
  files and are removed after the session.

## Executive summary

1. **The evidence for standalone technical indicators is mixed and fragile.**
   Early studies find profits in FX and futures but not stocks; among 95 modern
   studies, 56 report positive results, 20 negative, and 19 mixed, with the
   positive results concentrated before the early 1990s (Park & Irwin, 2007).
   Individual RSI/MACD/Bollinger directional accuracy in a recent 500-bar study
   is near 50%; a combined signal reaches 66.7% on 15 signals with p = 0.302.
   The older positive results (Brock et al., 1992) are exactly the ones the
   data-snooping literature was built to challenge (White, 2000; Sullivan et
   al., 1999).
2. **After data integrity, the highest-leverage discipline is honest
   evaluation.** Backtest overfitting, multiple testing, and transaction costs
   can dominate the out-of-sample result. The Deflated Sharpe Ratio, PBO/CSCV,
   walk-forward with an embargo, and cost-aware evaluation are the tools that
   separate a real edge from a search artifact.
3. **The factor zoo is contested, not settled.** Hou, Xue & Zhang (2020) find
   65% of 452 anomalies fail a single test and 82% fail a multiple-test hurdle.
   Jensen, Kelly & Pedersen (2023) estimate a Bayesian replication model and
   conclude the majority of factors replicate in a 93-country data set. Both are
   credible; the disagreement is partly about test design. The practical reading
   is "a small set of robust factors with a multiple-testing budget", not "101
   alphas".
4. **Trend/momentum is one of the most implementable families, but the
   time-series-momentum evidence is disputed.** Moskowitz et al. (2012) find
   significant TSM across 58 instruments; Huang, Li, Wang & Zhou (2020) find
   little TSM evidence in- and out-of-sample in a longer sample, with
   performance close to a historical-mean strategy. The prior repository's own
   12-month OOS trend test failed after 2 bps slippage (PBO = 1.0), and the
   trend family was archived.
5. **Volatility targeting reliably changes risk; whether it adds alpha is
   disputed.** Moreira & Muir (2017) report large alphas; Cederburg et al.
   (2020) find the alphas are sensitive to implementation and do not hold up
   uniformly out of sample; Bongaerts et al. (2020) find conventional volatility
   targeting fails and only conditional targeting helps; Akula (2026) finds a
   mean Sharpe change of +0.01 across 31 ETFs, none significant, with the gains
   concentrated in 2008–2013.
6. **Machine learning finds ordering information, not necessarily implementable
   alpha.** A 2026 Nasdaq study reports NDCG 0.495–0.504 vs a random baseline
   near 0.45, but net CAGR of 4.8% at 5 bp per leg and a Deflated Sharpe
   probability of 0.462. A 2026 Brazilian study reports gross DSR ≈ 0.41 but a
   net Sharpe of −1.1 at ten-day rebalancing; turnover × cost is the binding
   constraint. Both are single-market, unreplicated studies.
7. **The prior quant-analysis repository is a useful engineering reference, not
   a validated strategy library.** Its dual-MA/TSMOM and paper-trading substrate
   are reasonable; its own 12-month OOS trend test failed after 2 bps slippage
   (PBO = 1.0). Its "CCI" is the China Commodity Futures Index, not the
   Commodity Channel Index; its factorlab already applies a pre-registered
   |t| ≥ 3.0 hurdle. The real gaps are a trials log, a full CPCV/embargo, and an
   impact model.

## 1. Technical analysis: mixed, fragile, and regime-dependent

The canonical positive result is Brock, Lakonishok & LeBaron (1992): moving-
average and trading-range-break rules on the Dow Jones index, 1897–1986, with
bootstrap inference, "provide strong support for the technical strategies"; buy
signals outperform sell signals and are less volatile. This is a real result on
a real sample, and it is the reason technical analysis cannot simply be dismissed.

The critique is equally canonical:

- Sullivan, Timmermann & White (1999) apply White's Reality Check to the Brock
  et al. universe and a much larger rule set, quantifying the data-snooping bias.
- White (2000) formalises the problem: when the same history is reused for
  inference and model selection, the best result may be chance.
- Park & Irwin (2007) survey the field: early studies find profits in FX and
  futures but not stocks; among 95 modern studies, 56 report positive results,
  20 negative, and 19 mixed, concentrated in speculative markets and largely
  before the early 1990s.
- Qi & Wu (2006) test 2,127 FX rules: full-sample data-snooping does not overturn
  the basic conclusion, but the problem is more serious in the second half of the
  sample and profitability weakens substantially in the recent period.
- Krpálek (2016) tests momentum/technical rules on US futures 2004–2016 with the
  Reality Check, Hansen's SPA, and PBO: after correcting for data snooping, the
  rules are not profitable.
- Bee & Gazzini (2004) find most simple rules profitable and significant on the
  Italian market, but explicitly caution about data snooping.

There are also credible positive modern results of a different kind:

- Neely, Rapach, Tu & Zhou (2014) find that technical indicators have
  statistically and economically significant in-sample and out-of-sample
  predictive power for the **US equity risk premium**, matching or exceeding
  macro variables and providing complementary information. This is forecasting
  the premium, not a mechanical trading rule.
- Lo, Mamaysky & Wang (2000) build a systematic pattern-recognition procedure
  and report incremental information for some patterns; that is information
  content, not a profitable standalone system (the latter is this note's
  interpretation, not the paper's wording).
- The 2026 breakout study (Magner et al.) finds the breakout composite has
  significant momentum exposure and a factor-adjusted alpha indistinguishable
  from zero; the signal only adds value conditionally, e.g. when VIX is low
  (1.13 percentage points over six months in that subsample). It is one S&P 500
  sample, not a general result.

The recent 2026 regime study is a useful calibration of how weak the standalone
signal is. On 500 daily observations split into 260 stable and 240 high-
volatility days by a GARCH(1,1) conditional variance, individual indicators are
near 50% directional accuracy; a combined RSI + Bollinger + MACD signal reaches
66.7% (10 of 15 signals) but is not statistically significant (p = 0.302,
95% CI 41.7–84.8%). Every indicator is more accurate in the stable regime, but
none of the regime differences is significant. The authors explicitly warn that
directional accuracy is not profitability and that the signal count is tiny.
The p-value and confidence interval are from the full text; they are not in the
OpenAlex abstract.

**Reading for OpenAlice:** the indicator library is a feature-computation layer.
It is legitimate to compute and display RSI/MACD/Bollinger/ATR; it is not
legitimate to present them as a validated edge. The interesting uses are
conditional/regime features and inputs to a trend or risk model, not standalone
buy/sell triggers.

## 2. Backtest overfitting, data snooping, and multiple testing

This is the strongest and most consistent part of the literature.

- Bailey, Borwein, López de Prado & Zhu (2014) show that a backtest selected
  from many trials can look excellent in-sample and perform at chance out of
  sample; they call the practice pseudo-mathematics.
- Bailey et al. (2016) introduce the **Probability of Backtest Overfitting
  (PBO)** via combinatorially symmetric cross-validation (CSCV): split the
  performance matrix into in-sample and out-of-sample halves, pick the in-sample
  winner, and measure how often its out-of-sample rank is below the median.
- Bailey & López de Prado (2014) introduce the **Deflated Sharpe Ratio (DSR)**:
  the probabilistic Sharpe ratio evaluated against the expected maximum Sharpe
  from the number of independent trials, correcting for selection bias,
  non-normality, and track-record length.
- Harvey, Liu & Zhu (2016) argue that a new factor should clear a t-statistic
  hurdle of about 3.0, not 2.0, because of the cumulative multiple testing in
  asset pricing; Harvey & Liu (2021) extend the argument with "lucky factors".
- Novy-Marx (2015) shows that combining multiple signals creates severe
  overfitting bias; the appropriate critical values can be several times the
  standard levels.
- White (2000) and Hansen (2005) provide the Reality Check / SPA bootstrap
  machinery for the "best of many rules" problem.
- Chordia, Goyal & Saretto (2020) estimate that with a 5% single-test threshold,
  about 45% of the discovered anomalies are false rejections; their suggested
  t-thresholds are around 3.8–3.4 depending on the procedure.
- Witzany (2021) proposes a Bayesian correction for the PBO; Koshiyama &
  Firoozye (2018/2019) propose covariance penalties.

Two 2026 studies show what honest evaluation looks like in practice. Both are
single-market and unreplicated, so treat their numbers as illustrations, not
constants:

- **stockprecog** (Barbosa, 2026, Brazilian B3 equities): triple-barrier labels,
  Combinatorial Purged CV with a trading-day embargo, DSR/PSR with an honest
  trials log, sample-uniqueness weights, fractional differentiation, and
  square-root market impact. Price-derived signals have a gross DSR ≈ 0.41 —
  below any conventional skill threshold — and are economically sub-marginal
  after one-way costs (net Sharpe −1.1 at ten-day rebalancing). The binding
  constraint is turnover × cost, not signal strength. A pre-registered linear
  value/quality tilt is the only net-positive configuration (net Sharpe +0.18,
  PSR 0.92, DSR 0.72 over 18 trials), still below the conventional 0.95 skill
  threshold. LightGBM LambdaRank overfits; TabPFN v2 only ties a zero-parameter
  linear composite.
- **Daily adaptive ML rankings** (Kottas, 2026, Nasdaq 2021–2026): chronological
  walk-forward, four XGBoost objectives. Test NDCG 0.495–0.504 vs a random
  baseline near 0.45 — detectable but modest ordering information. The best
  configuration has a 34.9% gross CAGR but 89.5% volatility and an 86.5% max
  drawdown; net CAGR falls to 4.8% at 5 bp per leg; DSR probability 0.462;
  Hansen SPA p = 0.207; net alpha vs SPY p = 0.436. The 34.9% is a total-return
  figure with a risk-free credit; the zero-cash CAGR is the 4.8% number.

**Reading for OpenAlice:** the evaluation harness is the highest-leverage
product after data integrity. A backtest without a trials log, costs, an
out-of-sample split, and a multiple-testing adjustment is marketing, not
analysis.

## 3. The factor zoo and the replication debate

- Hou, Xue & Zhang (2020): with NYSE breakpoints and value-weighted returns,
  65% of 452 anomalies fail |t| = 1.96; the multiple-test hurdle of 2.78 raises
  the failure rate to 82%; even replicated anomalies have smaller economic
  magnitudes.
- Jensen, Kelly & Pedersen (2023): a Bayesian replication model concludes that
  the majority of factors replicate, cluster into 13 themes, work out-of-sample
  in a 93-country data set, and are strengthened rather than weakened by the
  large number of factors.
- McLean & Pontiff (2015): anomaly returns fall about 26% out-of-sample and 58%
  after publication; the 26% is an upper bound on the expected data-mining
  effect because it includes publication-informed trading.
- Jacobs & Müller (2019): the title-level claim is that anomalies across the
  globe cease to exist once public; the OpenAlex record has no abstract, so this
  note cites the title, not a measured effect.
- Hollstein (2022): the title asks whether the world of anomalies is smaller
  than we think; again title-level, no abstract in OpenAlex.
- Fama & French (1992, 2015, 2018) and Hou, Xue & Zhang (2015) provide the
  competing factor-model baselines (size/value, five-factor, q-factor).

**Reading for OpenAlice:** the factor layer should start with a small, well-
understood set (market, size, value, momentum, profitability, investment, low
risk) and a multiple-testing budget. Alpha101-style formula collections are a
research playground, not a validated factor library.

## 4. Momentum, trend following, and volatility targeting

- Jegadeesh & Titman (1993): 3–12 month cross-sectional momentum.
- Moskowitz, Ooi & Pedersen (2012): time-series momentum is significant in 58
  liquid futures across equity indices, currencies, commodities, and bonds;
  returns persist for 1–12 months and partially reverse; a diversified TSMOM
  portfolio has little exposure to standard factors and performs best in
  extreme markets.
- Huang, Li, Wang & Zhou (2020): a direct challenge. With a longer sample, they
  find little evidence of TSM in- and out-of-sample; the TSM strategy's
  performance is virtually the same as a historical-mean strategy. This is the
  strongest published counterpoint to Moskowitz et al., and it is why
  "trend/momentum is the most defensible family" is too strong.
- Hurst, Ooi & Pedersen (2017): a century of evidence that trend following has
  worked across asset classes; the strategy is not explained by traditional
  risk factors and provides crisis alpha. This is AQR's simulated century-long
  backtest — industry research, not an independent replication.
- Daniel & Moskowitz (2016): momentum crashes are partly forecastable; they
  occur in panic states after market declines and high volatility, and are
  contemporaneous with market rebounds. A dynamic momentum strategy based on
  forecasts of mean and variance approximately doubles the Sharpe ratio.
- Moreira & Muir (2017): volatility-managed portfolios produce large alphas and
  higher Sharpe ratios across the market, value, momentum, profitability, ROE,
  investment, BAB, and carry.
- Cederburg, O'Doherty, Wang & Yan (2020): the volatility-managed portfolios do
  not systematically outperform out of sample; the alphas are sensitive to the
  volatility estimator and implementation choices. This is the peer-reviewed
  counterweight to Moreira & Muir.
- Bongaerts, Kang & van Dijk (2020): conventional volatility targeting fails to
  consistently improve performance in global equity markets and can increase
  drawdowns; **conditional** volatility targeting, which adjusts only in the
  extremes, improves Sharpe and reduces drawdowns with low turnover.
- Akula (2026): causal daily volatility targeting on 31 liquid ETFs, 2008–2026,
  net of costs and leverage financing: mean Sharpe change +0.01, median 0.00;
  16 of 31 improve; none significant at 5% under the Ledoit–Wolf test. The
  gains are concentrated in 2008–2013; spanning alphas are significant for only
  2 of 31 strategies and none after FF5 + momentum. This is a Zenodo self-audit
  with an AI-code disclosure, not a peer-reviewed paper.

**Reading for OpenAlice:** trend/momentum is one of the most implementable
families, not a consensus edge. Volatility targeting belongs in the risk layer,
and should be conditional rather than a blanket inverse-vol rule; momentum crash
risk and transaction costs are part of the strategy, not an afterthought.

## 5. Machine learning and regime models

- Gu, Kelly & Xiu (2020): machine learning produces large economic gains for
  measuring risk premiums; trees and neural networks win; the gains come from
  nonlinear predictor interactions; all methods agree on a set of dominant
  predictors (price trends/momentum, liquidity, volatility).
- Drobetz & Otto (2021): European evidence; interactions and nonlinearities
  help, but tuning and overfitting are the central problems.
- Leippold, Wang & Zhou (2021): Chinese market; machine learning gains are
  sensitive to liquidity and transaction costs.
- The 2026 cost-aware studies find a different pattern from Gu et al.'s large
  gross gains: modest ordering information, weak net performance.
- Hamilton (1989): Markov switching of growth rates; the foundation of regime-
  switching models. Ang & Bekaert (2002), Guidolin & Timmermann (2006), and
  Gatumel & Ielpo (2011) extend regime models to asset allocation and more than
  two states.
- The regime literature is not uniformly positive: Dacco & Satchell (1999) ask
  why regime-switching models forecast so badly, and Ang & Timmermann (2012)
  survey the mixed out-of-sample evidence.
- The 2026 trend-regime study finds no statistically significant regime
  differences in indicator accuracy; the regime classification is a useful
  conditioning variable, not a proven signal.

**Reading for OpenAlice:** ML and regime models are later-stage research. The
first question is whether a simple, cost-aware trend/risk model beats a
benchmark after costs; the second is whether ML adds anything on top.

## 6. Alpha101 and formulaic factor libraries

Kakushadze (2016) presents 101 real-life alpha formulas. The paper is explicit
about the properties: average holding period 0.6–6.4 days, average pairwise
correlation 15.9%, returns strongly correlated with volatility, and no
significant dependence on turnover. The last point is about the correlation of
alpha returns with turnover, not net-of-cost profitability; the short holding
period still implies high turnover and cost sensitivity. These are **formulas**,
not a validated model, and the factor-zoo/replication literature applies
directly.

**Reading for OpenAlice:** an Alpha101-style library can be a research tool, but
it should not be shipped as a signal set without a trials log, cost model, and
out-of-sample evidence. The engineering cost of computing 101 formulas is low;
the evidential cost of selecting among them is high.

## 7. Transaction costs

The 2026 studies reviewed here make costs binding, but the point is older than
they are:

- Novy-Marx & Velikov (2016) show that anomaly profitability is substantially
  reduced by trading costs and that high-turnover anomalies are the most
  vulnerable.
- Frazzini, Israel & Moskowitz (2018) estimate real trading costs from a large
  institutional manager and find that many strategies remain profitable net of
  costs, but the estimates are strategy- and size-dependent.
- The ML-ranking study: gross 34.9% CAGR becomes 4.8% net at 5 bp per leg.
- stockprecog: gross signal, net Sharpe −1.1; turnover × cost is the binding
  constraint.
- The evolution survey (Feng, Cardozo & Xia, 2026) lists the implementation
  boundaries a predictor must survive: point-in-time reconstruction, model
  selection, portfolio translation, turnover, transaction costs, shorting
  frictions, capacity, latency, regime change, and governance. It argues that
  sustainable advantage is more likely to come from information transformation,
  economic structure, cost-aware portfolio construction, execution, and
  organizational memory than from a generic model class.

**Reading for OpenAlice:** any backtest that does not subtract realistic costs
is not a backtest. The first cost model can be bps per turnover; the better one
is square-root impact with participation and spread (Almgren & Chriss, 2001).

## 8. Consensus and live disputes

| Question | Consensus | Live dispute |
| --- | --- | --- |
| Do technical indicators predict? | Weak standalone; data-snooping and costs erode the early profits; regime-dependent; some incremental information for the equity premium | Brock/Neely/Lo vs Sullivan/White/Krpálek; how much survives costs and multiple testing |
| Are published factors real? | Many fail replication; economic magnitudes shrink; multiple testing matters | Hou et al. (65–82% fail) vs Jensen et al. (majority replicate) |
| Is momentum real? | Cross-sectional momentum is robust; TSM is significant in Moskowitz et al.'s sample but disputed by Huang et al. (2020); crashes are real | Whether TSM is a distinct premium or a historical-mean artifact; how to time/size it |
| Does volatility targeting add alpha? | It changes risk; the alpha claim is fragile | Moreira & Muir (large alphas) vs Cederburg et al. (not robust out of sample) and Akula (+0.01, not significant) |
| Does ML add value? | Detectable predictive information; net alpha is hard | Gu et al. (large gross gains) vs the 2026 cost-aware studies (weak net) |
| Do regimes help? | Regime models are useful descriptions | Whether regime conditioning improves out-of-sample risk-adjusted returns (Dacco & Satchell, 1999; Ang & Timmermann, 2012) |

## 9. Re-evaluating the prior quant-analysis repository

The private `quant-analysis` repository is an engineering reference, not an
authority. It is also more disciplined than a first reading suggested; the
earlier version of this note misread several parts, corrected here:

- `futures/galahad_futures`: the separation of strategy (target leverage),
  risk layer, and paper fills is good architecture. The dual-MA/TSMOM strategy
  is a trend baseline; the repo's own 12-month OOS test with 2 bps slippage
  produced PBO = 1.0 and the trend family was archived
  (`futures/docs/findings-20260915.md`). `walkforward.py` has an optional purge
  gap (`purge: int = 0`) but no post-test embargo. The standalone module has no
  DSR/PBO or cost model, while the surrounding `validate_walkforward.py` imports
  DSR/PBO and the paper book charges 4 bps fees plus optional slippage
  (`book.py:76-77`). The DSR call uses `n_trials=1` for a pre-specified rule;
  that is defensible for a single rule but not for the repo's 4×5 matrix or
  parameter search, and there is no trials log. The missing piece is a realistic
  impact model. The repo has no volatility-targeting rule; if one is added,
  conditional targeting is better supported than a blanket inverse-vol rule.
- The repo's "CCI" is the China Commodity Futures Index (中证商品期货指数), not
  the Commodity Channel Index. `cci.py` is an index adapter;
  `run_cci_tsmom.py` runs a pre-specified TSMOM-120 on seven commodity sector
  indices. Only precious metals (000103) has a positive OOS Sharpe (1.93); the
  other six are ≤0.1. That is a single-sector result, not a broad
  technical-indicator claim.
- `stocks/factor_digging/factorlab`: the factor-health report sets a
  pre-registered |t| ≥ 3.0 hurdle (HLZ 2016) and a Harvey–Liu haircut;
  `composite_v1.py` discloses the in-sample selection bias and includes a
  half-sample OOS section. That is the right discipline. The remaining gaps are
  neutralization, unadjusted prices, and survivorship; the Alpha101 formulas are
  a research collection, not a validated factor set.
- `crypto/scripts/crypto_backtest.py`: the repo's own 9-variant robustness test
  finds all DSR ≤ 0.58 and high PBO for the SMA variants
  (`crypto/docs/robustness-20260916.md`); the positive technical-rule literature
  (Gerritsen et al., 2019) does not transfer to this implementation without
  cost/liquidity evidence.
- `tools/nautilus_trader`: the Rust indicators are a production-grade reference;
  a Rust port is a later optimization.

## 10. Implications for OpenAlice

### 10.1 Indicator engine (implemented in this pass)

- `src/domain/analysis/indicator/functions/statistics.ts`: `MAX`, `MIN`,
  `HIGHEST`, `LOWEST` use loops instead of `Math.max(...values)`. Spreading a
  long history over the argument limit throws `RangeError`; the loop version is
  safe for 200k+ points.
- `src/domain/analysis/indicator/calculator.ts`: a per-`calculate()` data
  cache memoizes `getHistoricalData(symbol, interval)` with a nested map (no
  separator collision). A formula that references `CLOSE('AAPL','1d')` three
  times fetches once. Concurrent `calculate()` calls on one instance are
  serialized so the shared `dataSources`/`activeContext` cannot mix.
- `src/domain/analysis/indicator/calculator.ts`: `MEDIAN`, `ROC`, `ZSCORE`,
  `SLOPE`, `CORRELATION`, `HIGHEST`, `LOWEST` are reachable from formulas, with
  arity validation. They were implemented in `statistics.ts` but missing from
  the dispatcher.
- `src/domain/analysis/simulate.ts`: the `ma_break` exit precomputes the SMA
  with a rolling sum (O(n)) instead of rebuilding the window at every bar
  (O(n·period)). A relative tolerance preserves the old exact-equality
  behaviour against floating-point drift, and a non-integer/non-positive
  period is rejected.
- The MACD fix from the previous pass (`technical.ts`, `emaSeries`) is
  retained: the O(n²) EMA recomputation is gone.

### 10.2 Validation harness (new)

`src/domain/analysis/validation.ts` provides evaluation primitives with
documented assumptions:

- `walkForwardSplits` with an embargo and non-overlapping test windows
  (`step >= testSize` is enforced).
- `outOfSampleSeries` / `outOfSampleReturns`, using the prior bar's position to
  avoid lookahead; overlapping split coverage is counted once; invalid splits
  throw.
- `applyTransactionCosts` on one-way turnover, with an explicit
  `initialPosition` (default flat).
- `sharpeRatio`, `probabilisticSharpeRatio` (requires at least 4 observations),
  `expectedMaxSharpe`, `deflatedSharpeRatio` (requires an integer trial count
  ≥ 1 and a positive variance; the default `1/(n-1)` is a null-iid assumption,
  not a general conservative choice).
- `probabilityOfBacktestOverfitting` via CSCV with the Sharpe ratio as the
  performance statistic, average ranks for ties, a strict below-median test,
  and a block count chosen to minimise the discarded trailing columns.

The tests cover the split geometry, the no-lookahead position, overlap dedupe,
cost accounting (including the initial position), numerical anchors for
PSR/DSR/expected-max-Sharpe/normal CDF, invalid-input rejection, and
deterministic PBO cases (dominant strategy, identical strategies, reversal, and
an edge in columns beyond the first 16).

### 10.3 What should come next

1. Integrate the validation harness into `simulate.ts` / the strategy tools:
   walk-forward folds, costs, DSR, and a trials log. A single-entry simulation
   is a scenario tool, not a strategy backtest.
2. Add a purged/embargoed combinatorial CV with triple-barrier labels for the
   cross-sectional strategies (`sector-rotation.ts`), following the stockprecog
   pipeline.
3. Add a square-root impact cost model (participation, spread, volatility) on
   top of the bps model.
4. Add the Harvey t > 3 hurdle and a Reality Check/SPA-style bootstrap for
   "best of many rules" selection.
5. Keep the strategy layer to a few robust families (trend/momentum, value,
   profitability, low risk) with conditional risk management; do not add more
   indicators in the hope that they become alpha. The trend family itself is
   contested (Huang et al., 2020).
6. Treat Alpha101/factor libraries as research; require a trials log and
   out-of-sample evidence before any factor is exposed as a signal.
7. Defer the Rust/N-API port until profiling shows the TypeScript engine is the
   bottleneck; the O(n) fixes remove the obvious algorithmic problems.

## 11. Checks

- `pnpm exec vitest run src/domain/analysis` → 9 files, 158 tests passed.
- `pnpm exec tsc --noEmit` → exit 0.
- `pnpm test` → 7788 passed, 1 failed, 6 skipped. The only failure is
  `tests/integration/git-process/git-execution.spec.ts` ("preserves dugite for
  Electron and source"), caused by the pre-existing `src/workspaces/
  git-execution.ts` change from the earlier Linux packaging pass. It is
  unrelated to the analysis changes and is reported, not reverted, because it
  belongs to that pass's behavior.
- The repository defines no lint script; `pnpm test` is the full vitest suite.

## 12. References

Seminal and survey works:

1. Brock, Lakonishok & LeBaron (1992), "Simple Technical Trading Rules and the
   Stochastic Properties of Stock Returns", *Journal of Finance*.
   doi:10.1111/j.1540-6261.1992.tb04681.x
2. Sullivan, Timmermann & White (1999), "Data-Snooping, Technical Trading Rule
   Performance, and the Bootstrap", *Journal of Finance*.
   doi:10.1111/0022-1082.00163
3. White (2000), "A Reality Check for Data Snooping", *Econometrica*.
   doi:10.1111/1468-0262.00152
4. Park & Irwin (2007), "What Do We Know About the Profitability of Technical
   Analysis?", *Journal of Economic Surveys*. doi:10.1111/j.1467-6419.2007.00519.x
5. Qi & Wu (2006), "Technical Trading-Rule Profitability, Data Snooping, and
   Reality Check: Evidence from the Foreign Exchange Market", *Journal of Money,
   Credit and Banking*. doi:10.1353/mcb.2007.0006
6. Neely, Rapach, Tu & Zhou (2014), "Forecasting the Equity Risk Premium: The
   Role of Technical Indicators", *Management Science*.
   doi:10.1287/mnsc.2013.1838
7. Lo, Mamaysky & Wang (2000), "Foundations of Technical Analysis",
   *Journal of Finance*. doi:10.1111/0022-1082.00265
8. Menkhoff & Taylor (2006), "The Obstinate Passion of Foreign Exchange
   Professionals: Technical Analysis", *Journal of Economic Literature*.
9. Bee & Gazzini (2004), "Testing the Profitability of Simple Technical Trading
   Rules in the Italian Stock Market".
10. Bailey, Borwein, López de Prado & Zhu (2014), "Pseudo-Mathematics and
    Financial Charlatanism", *Notices of the AMS*. doi:10.1090/noti1105
11. Bailey, Borwein, López de Prado & Zhu (2016), "The Probability of Backtest
    Overfitting", *Journal of Computational Finance*. doi:10.21314/jcf.2016.322
12. Bailey & López de Prado (2014), "The Deflated Sharpe Ratio", *Journal of
    Portfolio Management*. doi:10.3905/jpm.2014.40.5.094
13. Harvey, Liu & Zhu (2016), "…and the Cross-Section of Expected Returns",
    *Review of Financial Studies*. doi:10.1093/rfs/hhv059
14. Harvey & Liu (2021), "Lucky Factors", *Journal of Financial Economics*.
    doi:10.1016/j.jfineco.2021.04.014
15. Hou, Xue & Zhang (2020), "Replicating Anomalies", *Review of Financial
    Studies*. doi:10.1093/rfs/hhy131
16. Jensen, Kelly & Pedersen (2023), "Is There a Replication Crisis in Finance?",
    *Journal of Finance*. doi:10.1111/jofi.13249
17. McLean & Pontiff (2015), "Does Academic Research Destroy Stock Return
    Predictability?", *Journal of Finance*. doi:10.1111/jofi.12365
18. Jacobs & Müller (2019), "Anomalies across the Globe: Once Public, No Longer
    Existent?", *Journal of Financial Economics*.
    doi:10.1016/j.jfineco.2019.06.004
19. Hollstein (2022), "The World of Anomalies: Smaller Than We Think?",
    *Journal of International Money and Finance*.
    doi:10.1016/j.jimonfin.2022.102741
20. Jegadeesh & Titman (1993), "Returns to Buying Winners and Selling Losers",
    *Journal of Finance*. doi:10.1111/j.1540-6261.1993.tb04702.x
21. Moskowitz, Ooi & Pedersen (2012), "Time Series Momentum", *Journal of
    Financial Economics*. doi:10.1016/j.jfineco.2011.11.003
22. Huang, Li, Wang & Zhou (2020), "Time Series Momentum: Is It There?",
    *Journal of Financial Economics*. doi:10.1016/j.jfineco.2019.08.004
23. Daniel & Moskowitz (2016), "Momentum Crashes", *Journal of Financial
    Economics*. doi:10.1016/j.jfineco.2015.12.002
24. Moreira & Muir (2017), "Volatility-Managed Portfolios", *Journal of
    Finance*. doi:10.1111/jofi.12513
25. Cederburg, O'Doherty, Wang & Yan (2020), "On the Performance of
    Volatility-Managed Portfolios", *Journal of Financial Economics*.
    doi:10.1016/j.jfineco.2020.04.015
26. Bongaerts, Kang & van Dijk (2020), "Conditional Volatility Targeting",
    *Financial Analysts Journal*. doi:10.1080/0015198X.2020.1790853
27. Hurst, Ooi & Pedersen (2017), "A Century of Evidence on Trend-Following
    Investing", *Journal of Portfolio Management*. doi:10.2139/ssrn.2993026
28. Gu, Kelly & Xiu (2020), "Empirical Asset Pricing via Machine Learning",
    *Review of Financial Studies*. doi:10.1093/rfs/hhaa009
29. Kakushadze (2016), "101 Formulaic Alphas", *Wilmott*.
    doi:10.1002/wilm.10525
30. Hamilton (1989), "A New Approach to the Economic Analysis of Nonstationary
    Time Series and the Business Cycle", *Econometrica*. doi:10.2307/1912559
31. Fama & French (1992), "The Cross-Section of Expected Stock Returns",
    *Journal of Finance*. doi:10.1111/j.1540-6261.1992.tb04398.x
32. Fama & French (2015), "A Five-Factor Asset Pricing Model", *Journal of
    Financial Economics*. doi:10.1016/j.jfineco.2014.10.010
33. Fama & French (2018), "Choosing Factors", *Journal of Financial Economics*.
    doi:10.1016/j.jfineco.2018.02.012
34. Hou, Xue & Zhang (2015), "Digesting Anomalies: An Investment Approach",
    *Review of Financial Studies*. doi:10.1093/rfs/hhu068
35. Novy-Marx (2015), "Backtesting Strategies Based on Multiple Signals", NBER
    Working Paper 21329. doi:10.3386/w21329
36. Hansen (2005), "A Test for Superior Predictive Ability", *Journal of
    Business & Economic Statistics*. doi:10.1198/073500105000000063
37. Chordia, Goyal & Saretto (2020), "Anomalies and False Rejections", *Review
    of Financial Studies*. doi:10.1093/rfs/hhaa018
38. Novy-Marx & Velikov (2016), "A Taxonomy of Anomalies and Their Trading
    Costs", *Review of Financial Studies*.
39. Frazzini, Israel & Moskowitz (2018), "Trading Costs".
    doi:10.2139/ssrn.3229719
40. Almgren & Chriss (2001), "Optimal Execution of Portfolio Transactions",
    *Journal of Risk*. doi:10.21314/JOR.2001.041
41. Witzany (2021), "A Bayesian Approach to Measurement of Backtest
    Overfitting", *Risks*. doi:10.3390/risks9010018
42. Drobetz & Otto (2021), "Empirical Asset Pricing via Machine Learning:
    Evidence from the European Stock Market", *Journal of Asset Management*.
    doi:10.1057/s41260-021-00237-x
43. Leippold, Wang & Zhou (2021), "Machine Learning in the Chinese Stock
    Market", *Journal of Financial Economics*.
    doi:10.1016/j.jfineco.2021.08.017
44. Dacco & Satchell (1999), "Why Do Regime-Switching Models Forecast So
    Badly?", *Journal of Forecasting*.
45. Ang & Timmermann (2012), "Regime Changes and Financial Markets", *Annual
    Review of Financial Economics*. doi:10.1146/annurev-financial-110311-101808
46. Gatumel & Ielpo (2011), "The Role of Regime Switching in Asset Allocation".
47. Gerritsen, Bouri, Ramezanifar & Roubaud (2019), "The Profitability of
    Technical Trading Rules in the Bitcoin Market", *Finance Research Letters*.
    doi:10.1016/j.frl.2019.08.011

Recent evidence (2026, not yet replicated):

48. Loubaris & Koraich (2026), "Trend-Following Indicators Under Stable and
    High-Volatility Market Regimes", *Journal of Risk and Financial Management*.
    doi:10.3390/jrfm19100780
49. Magner, Sanhueza & Lavín (2026), "When is a Breakout Informative? Market
    Conditions and Technical Signals", *Finance Research Letters*.
    doi:10.1016/j.frl.2026.110774
50. Kottas (2026), "Do Daily Adaptive Machine Learning Stock Rankings Survive
    Trading Costs?", *Economies*. doi:10.3390/economies14090393
51. Barbosa (2026), "stockprecog: An Honest-Invalidation Study of Cross-Sectional
    Return Prediction on the Brazilian Equity Market (B3)".
    doi:10.5281/zenodo.20706701
52. Akula (2026), "Volatility Targeting Is Risk Management, Not Alpha".
    doi:10.5281/zenodo.23271926
53. Feng, Cardozo & Xia (2026), "The Evolution of Quantitative Equity
    Investing", *Journal of Economic Surveys*. doi:10.1111/joes.70178
54. Alahmadi & Basingab (2026), "A Systematic Review of Innovative Financial
    Modeling for Weak-Form Market Efficiency Testing", *Journal of Risk and
    Financial Management*. doi:10.3390/jrfm19100768

## 13. Coverage, limitations, and open questions

**Coverage.** The targeted sweep is 212 works, not a systematic review. It does
not cover execution/capacity in depth, shorting frictions and financing,
survivorship and point-in-time data construction, LLM-based strategies, or the
crypto asset-pricing literature beyond one technical-rule paper. The 2026
papers are recent and mostly single-market; their numbers illustrate the
discipline, not settled constants. The 2026 weak-form review (Alahmadi &
Basingab) is a useful entry point for the broader testing-method literature.

**Open questions.**

- The DSR needs the variance of the trial Sharpe ratios; the default
  (`1/(n-1)`) assumes independent null trials and is not generally conservative.
  A real trials log should estimate the variance from the actual attempts.
- The PBO implementation uses the Sharpe ratio as the performance statistic;
  the choice can change the rank ordering when strategy volatilities differ.
  Ties use average ranks; the strict below-median convention is documented.
- The PSR is asymptotic; fewer than 4 observations return NaN, and tens are
  needed before the number is meaningful.
- The purged combinatorial CV with triple-barrier labels and sample-uniqueness
  weights is not implemented; walk-forward + embargo is the first step.
- The cost model is one-way bps per turnover; square-root impact and
  participation are not implemented.
- The Reality Check / SPA bootstrap is not implemented; DSR/PBO cover part of
  the multiple-testing problem, not all of it.
- The strategy layer (trend/momentum, conditional volatility targeting) is not
  integrated with the validation harness yet.
- The factor layer and the Rust port remain out of scope for this pass.
