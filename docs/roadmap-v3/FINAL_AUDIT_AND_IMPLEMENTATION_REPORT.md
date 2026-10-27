# Investment Diary — Gap Remediation v3: final audit and implementation report

| | |
|---|---|
| Branch | `claude/vigilant-fermi-tf3wq7` (pushed) |
| SHA audited (baseline) | `1c0ab342…` (`1c0ab34`, "Stock splits: …") |
| Final code SHA | `2b22a0f` (Phase 4). This report is committed on top |
| Diff vs baseline (code + docs, before the report) | 52 files, +3,827 / −82 |
| Deployment | **NO.** Nothing was deployed. No real orders were placed, and no proposed trade was written as a transaction |

## 1. Inventory (spec requirement → state)

| Requirement | Class | Result |
|---|---|---|
| Canonical return series (price/total, FX, provenance) | EXTEND | `return-series.ts`, adopted in `loadUniverse` and the backtest (Phase 1) |
| Benchmark forward-fill (FIX-2) | FIX | `alignWithBenchmark` uses actual prints only. Repro: β 1.412 → 1.5 (true) |
| Total-return option | NEW (data-limited) | Uses provider `adj_close`, otherwise a typed `unavailable`. Never combined with distributions |
| Bond clean/dirty basis | EXTEND | `priceBasis: "clean_assumed"` is labelled. Coupons stay in ledger NAV and are excluded from analytic returns (disclosed) |
| Credit PD/LGD/EL, survival, PV(EL) | NEW | `credit-risk.ts`, from a user-entered credit profile. Nothing is fabricated |
| Spread DV01 / spread duration | EXTEND | Bump-and-reprice with the existing `priceFromCurve`. Needs a user curve |
| Credit-spread stress | EXTEND | `creditSpreadShockBp` (global and per symbol). The legacy payload is unchanged |
| Issuer / sector / rating metadata | NEW | Additive columns. Sector requires a source and an as-of date |
| Linear risk constraints | NEW | General QP (dual active set) is used only when constraints are given. The box path is unchanged |
| ES / turnover constraints | NOT SUPPORTED | Rejected with `UNSUPPORTED_CONSTRAINT` |
| VaR/ES 95 & 99, horizon | EXTEND | `varTable` with min-obs policy and a reliability flag. √10 is labelled an approximation |
| VaR coverage backtests | NEW | `var-backtesting.ts`: Kupiec, Christoffersen (when the sample allows), conditional coverage |
| Slow fractional backtest (FIX-1) | FIX | Fractional fast path in `rebalance()`: 5.1 s → ~18 ms |
| Backtest dividends / coupons / look-ahead / survivorship | EXTEND | `returnBasis: total_return`; disclosures include the static Black–Litterman weights look-ahead |
| Monte Carlo DCF | **DEFER** (Phase 5) | No verified need. Deterministic scenarios already exist in `valuation.ts` |
| Risk parity / risk budgeting | **DEFER** (Phase 5) | No verified need. Risk contribution already exists (`risk-contribution.ts`) |
| OAS, FRN, embedded options, premium data feeds | **DEFER** (Phase 6) | Not implemented. Fixed-coupon duration is not OAS (disclosed) |
| Already present and verified | EXISTS | Historical VaR/ES 95%, YTM/duration/convexity/Z-spread/KRD, SOTP, Black–Litterman, rebalance, risk contribution, robust optimization, stress test, backtest, splits. None were recreated |

## 2. Commits per phase

| Phase | Commit | Contents | Docs |
|---|---|---|---|
| 0 Audit | `b58fa45` | Gap audit and baseline results (no code changes) | `00_CURRENT_GAP_AUDIT.md`, `00_BASELINE_TEST_RESULTS.md` |
| 1 Return conventions | `36c68b3` | `return-series.ts`; `loadUniverse` and backtest use it; FIX-2; `returnBasis` | `01_RETURN_CONVENTIONS.md`, MODEL_DOCUMENTATION §1c |
| 2 Credit risk | `b6ce6ff` | `credit-risk.ts`; credit on bond holdings; spread stress; migration 0010; profile and yield-curve forms | `02_CREDIT_RISK_MODEL.md`, §5b |
| 3 Risk constraints | `bd06d79` | `exposure.ts`; general QP; optimizer `constraints`; exposure report; UI inputs | `03_RISK_CONSTRAINTS.md`, §4a |
| 4 VaR / backtest | `2b22a0f` | `var-backtesting.ts`; `varTable` / `varBacktest`; analytics rows; FIX-1 | `04_VAR_AND_BACKTEST.md`, §2 |
| 5 / 6 | — | DEFERRED (see §1) | — |

## 3. Migrations

| File | Change | Nature |
|---|---|---|
| `drizzle/0010_v3_risk_metadata.sql` (v3) | `assets` gains `issuer`, `sector`, `sector_source`, `sector_as_of`, `credit` (jsonb). `settings` gains `yield_curve` (jsonb) | Additive, all nullable. No data is rewritten |
| `0008_phase4_trading_costs.sql`, `0009_split_tx_type.sql` (earlier in this branch) | Trading costs and lot size; `split` value added to `tx_type` | Additive |

Note: the `vercel-build` script runs `db:migrate` first, so a future deploy would apply 0010 automatically. It is additive and safe on existing data. No deploy was made here.

## 4. Verification (final, on `2b22a0f`)

| Command | Result |
|---|---|
| `npm test` (`vitest run`) | **PASS** — 31 files, 330 / 330 tests (baseline 277 / 278 with 1 timeout) |
| `npm run typecheck` (`tsc --noEmit`) | **PASS** |
| `npm run lint` (`next lint`) | **PASS** — no warnings or errors |
| `npm run build` (`next build`) | **PASS** |

Runtime checks were done locally (PG16 with `next start -p 3100`) through REST, MCP and the browser (Playwright) for each phase:
- Unchanged without the new inputs: optimizer weights and β; equal-weight backtest return (+25.08%); legacy stress payload; `var95` / `cvar95`.
- Phase 4 on local data (514 daily periods):

| Level | VaR | ES | Exceptions / expected | Kupiec p | Christoffersen |
|---|---|---|---|---|---|
| 95% | 2.06% | 2.59% | 13 / 13.2 | 0.955 | p = 0.245 |
| 99% | 3.00% | 3.21% | 4 / 2.6 | 0.434 | unavailable (too few exceptions) |

Test data entered for the checks (credit profiles, yield curve, issuer/sector) was cleared afterwards.

## 5. Tool, API and connector changes

| Surface | Change |
|---|---|
| MCP / advisor `update_asset_profile` | **NEW** — issuer, sector (with source and date), credit profile |
| `optimize_portfolio` | + `returnBasis`, + `constraints` (assetBounds, maxPerIssuer, maxPerSector, maxPerRating, groups, maxDuration, maxDv01Thb, durationOverride). Output + `exposure`. New errors `INFEASIBLE_CONSTRAINTS` and `UNSUPPORTED_CONSTRAINT` |
| `backtest_portfolio` | + `returnBasis` (`price_return` / `total_return`). `total_return` together with `useLots` is rejected |
| `stress_test_portfolio` | + `creditSpreadShockBp`, `creditSpreadShockBpBySymbol`, `spreadDurationOverride`; presets `credit_widening` and `rates_and_credit`; `pnl.credit`, `exposure.byIssuer` / `byRating` |
| `get_bond_holdings` | + `credit` and `priceBasis` per bond |
| `get_performance_metrics` | + `varTable`, `varBacktest` (additive; existing fields unchanged) |
| REST | + `POST /api/v1/assets/profile`, `GET/PUT /api/v1/settings/yield-curve`. OpenAPI regenerates from the same zod schemas |

**Connectors: refresh needed.** Tool schemas changed, and one tool was added. Reconnect or refresh the Investment Diary connector in Claude so the client sees `update_asset_profile` and the new parameters. All changes are additive, so existing calls stay valid.

## 6. Known constraints

- **Credit:** credit figures exist only when the user enters a PD/LGD profile. Spread DV01 also needs a saved yield curve. There is no rating-transition or default-correlation model, and stress does not include default losses.
- **Total return:** depends on provider `adj_close` coverage, which is absent locally (a typed unavailable was verified). Dividend-tax effects are excluded.
- **Constraints:**
  - Exposure groups come only from user metadata; unclassified assets are listed and stay outside the caps.
  - Assets other than bonds have duration 0 unless overridden (disclosed).
  - ES and turnover constraints are not supported.
- **VaR:**
  - Historical estimates over one observation period.
  - The 99% backtest has low power with about 2 years of data.
  - The √10 figure is an approximation.
- **Backtest:**
  - Survivorship bias from today's asset list (always disclosed).
  - Coupons are excluded.
  - Black–Litterman market weights are current values (look-ahead, disclosed).
- **Deferred:** Phase 5 (Monte Carlo DCF, risk parity) and Phase 6 (OAS, FRN, optionality, premium feeds).

## 7. Invariants check

| Invariant | Status |
|---|---|
| No deletion or mutation of ledger data, trades, saved valuations or user assumptions | Held; migrations are additive |
| Decimal rates in the engine; pure, deterministic functions | Held |
| No fabricated prices, PDs, ratings, curves, dividends or constituents | Held; unknown inputs → `unavailable`, validation errors, or "unrated" / "unclassified" |
| No double counting | Held (`adj_close` XOR distributions; one combined rate-plus-spread repricing) |
| No future information in backtests; never claimed survivorship-free | Held (rolling VaR uses prior data only; disclosures kept) |
| Reuse over new tools | Held; one new tool (`update_asset_profile`) |
| Production deploy / orders | None |
