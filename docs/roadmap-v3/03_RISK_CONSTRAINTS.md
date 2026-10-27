# Phase 3 — Risk-aware portfolio constraints

## What the existing solver supported
`solveBoxQP` is a primal active-set QP for min ½wᵀQw + cᵀw s.t. Σw = 1, min ≤ wᵢ ≤ max with **one shared box**. It cannot take Aw ≤ b.

## Change: one pipeline, one router
- `solveGeneralQP` (`optimizer.ts`) is a dual active-set QP (Goldfarb–Idnani). It handles Σw = 1, per-asset bounds and linear rows lo ≤ aᵀw ≤ hi.
  - No feasible start is needed. An empty set → `INFEASIBLE_CONSTRAINTS` naming the conflicting constraints (symbols and group names).
  - Rounding-safe dependence tests are relative to ‖G⁻¹n⁺‖, and a final KKT polish on the active set is accepted only if feasible with valid multipliers.
- `solveLambda` / `feasibleReturnRange` / `validateBounds` / `checkWeights` route to it **only** when `Bounds` has per-asset bounds or linear rows (`isGeneral`); box-only problems use the old solver unchanged.
- LP range: min ½‖w‖² ∓ K·μᵀw with K doubled until the solution stops moving (piecewise-linear path reaching the LP vertex; well conditioned).
- Black–Litterman, max Sharpe (golden section on λ), target return/risk, frontier, robust bootstrap and the rebalance panel all use the same `recommend`, so the constraints apply everywhere.

## Exposure definitions (`exposure.ts`, shared by server and web)
- Issuer: `assets.issuer` (user-maintained economic issuer; one issuer's stock and bonds are aggregated).
- Sector: `assets.sector` with `sectorSource` and `sectorAsOf` (rejected without them). **Unclassified assets are listed and not assigned.**
- Rating bucket: from the credit profile; bonds without a rating are `unrated`.
- Duration: Σ wᵢDᵢ, with Dᵢ the bond modified duration from the last stored price (same convention as the bond page), 0 for other assets unless `durationOverride` (disclosed).
- DV01 (THB) = Σ wᵢ·W·Dᵢ·0.0001, with W = THB value of the risky sleeve.
- Constraint input (`optimize_portfolio.constraints`): `assetBounds`, `maxPerIssuer`, `maxPerSector`, `maxPerRating`, `groups[{name, symbols, min, max}]`, `maxDuration`, `maxDv01Thb`, `durationOverride`.
- `maxExpectedShortfall` and `maxTurnover` → `UNSUPPORTED_CONSTRAINT` (nonlinear; turnover is handled by `rebalance_portfolio`).
- Cash: the constraints apply to the risky sleeve (Σw = 1); the risk-free share stays as today (`useRiskFree`).
- Output: `exposure.recommended` / `current` (by issuer, sector, rating, asset class; duration; DV01), `constraintsApplied` (each value vs its limit) and `unclassified`.

## Surfaces
- Optimizer page: inputs for maximum per issuer, per sector and portfolio duration, with concentration summary and warnings; infeasibility shown with the constraint names.
- Holding page: issuer/sector editor (`AssetProfileForm`).
- MCP/REST/OpenAPI: `optimize_portfolio.constraints`; `update_asset_profile` (Phase 2).

## Tests
- `constraints.test.ts` (9):
  - The general QP equals the box solver on box-only problems (λ = 0…10, KKT < 1e-9).
  - A binding group cap is exact, and the result beats 500 random feasible points.
  - Group minimum + duration limit; infeasible constraints named; LP range.
  - Degenerate vertex across λ = 10…1e12 (regression for a found rounding issue).
  - `recommend` with an issuer cap; infeasibility as `{ ok: false }`; box-only results unchanged.
- `exposure.test.ts` (6):
  - Issuer aggregation (and a truly infeasible 3 × 30% case).
  - Unclassified reported; unrated bucket.
  - Duration and DV01 scaling; exact binding; infeasible caps explained; unsupported ES/turnover; per-asset bounds.

## Local verification (test classifications, removed afterwards)
- Without constraints the weights are identical to before.
- Sector cap 15% binds exactly (CPALL 15.0%, Government 15.0%).
- Infeasible group minimums return `INFEASIBLE_CONSTRAINTS` with the group names.
- ES limit → `UNSUPPORTED_CONSTRAINT`.

## Risk parity
Not implemented (Phase 5, optional). Risk contributions are already reported.
