# Roadmap v2.0 — final report

| Phase | Commit(s) | Main deliverables | Migration |
|---|---|---|---|
| 0 Gap analysis | f587841 | `PHASE0_GAP_ANALYSIS.md` | — |
| 1 Historical prices | 32fbfed | `sync_historical_prices`, adj_close, coverage/eligibility | 0006 (additive) |
| — Bulk price import | 3687fb0 | `import_prices`, CSV/Excel upload | — |
| 2 SOTP | fb65334 | `method: "sotp"` in value/save valuation, SOTP editor | 0007 (enum value) |
| 3 Optimization | 493a1ba | Black–Litterman `returnMethod`; one QP engine (projected-gradient solver removed) | — |
| 4 Rebalancing & risk | 0718057, 235da44 | `rebalance_portfolio`, `stress_test_portfolio`, risk contribution, robust diagnostics, trading-cost settings | 0008 (additive) |
| 5 Backtesting | 8bc48a2 | `backtest_portfolio`, `/backtest` page | — |

## MCP tools
- Extended: `value_security` / `save_valuation` (SOTP), `optimize_portfolio` (Black–Litterman, robust, risk).
- New: `sync_historical_prices`, `import_prices`, `rebalance_portfolio`, `stress_test_portfolio`, `backtest_portfolio`.
- All of them are in the MCP contract test.

## Release gates (each phase)
- Unit and financial reference tests: 270 pass.
- End-to-end workflow: `src/lib/e2e-roadmap.test.ts` covers import → BL → optimizer → rebalance → risk/stress → backtest, plus SOTP.
- TypeScript, lint and `next build` are clean.
- Migrations 0006–0008 are additive and applied locally. Existing transactions and saved valuations are unchanged; read-only tools were verified not to write transactions.

## Known limitations / deferred
- No sector data: sector limits and sector shocks use user-defined groups only.
- No split transaction type: holdings are not split-adjusted, but splits are warned about.
- Backtests use closes without dividends and today's asset list (survivorship).
- Per-asset lot size has a database field but no UI yet. Bond funds need a duration override for rate shocks.
- Live Yahoo fetches could not be verified in the sandbox (no internet). They were verified with a stand-in provider.

## Deployment
Not deployed by this work. After deploying the branch, `vercel-build` runs the migrations. Then:
1. Check `GET /api/v1/version` or MCP `get_server_info`.
2. Refresh the ChatGPT/Claude connector so the new tools are discovered.
3. Enter the broker costs in Settings.
