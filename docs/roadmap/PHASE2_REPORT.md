# Phase 2 — SOTP valuation: report

## Gap mapping (from Phase 0)
| Requirement | Done in | Reuse |
|---|---|---|
| `method: "sotp"` in value_security / save_valuation | `valuationInput` union (`valuation-schemas.ts`), `evaluate` dispatch | Same tools, REST and OpenAPI; no new tool |
| Segment submodels | `measureSegment` → `evaluateCore` | DCF FCFF/FCFE, DDM, RI, Multiples engines unchanged |
| Bridge, ownership, minorities, holdco discount | new pure module `src/lib/finance/sotp.ts` | — (no composite engine existed) |
| Double-counting controls | `sotp.ts` (errors vs warnings by severity) | — |
| Saved valuations | `saveValuation` (assumptions + segment results + reconciliation in `result`) | `valuations` table; migration `0007_phase2_sotp.sql` only adds the enum value `sotp` |
| Editor (segments, bridge, waterfall, sensitivity, save/edit/reload, JSON export/import) | `SotpEditor.tsx`, routed from `/valuation/new?method=sotp` and `/valuation/[id]` | `evaluate`, `saveValuationAction`, valuation file format |

Not changed: formulas of existing models, `MODEL_VERSION` (existing valuations are not flagged as stale).

## Verification
- 15 new tests (`src/lib/finance/sotp.test.ts`), 232 in total pass. tsc, lint and build are clean.
  - A hand-computed holdco case (928 → 9.28 per share).
  - Derived and missing minorities, debt double counting, EV-without-debt cases, duplicate entity / investment, cash warning, fx, eliminations, required manual source, sensitivity.
  - Reuse: a one-division SOTP with the group net debt equals the standalone DCF-FCFF value per share, and so does the segment-level debt treatment; the DDM segment equals per-share value × shares × ownership; a failing sub-model gives no value; a JSON round trip gives the same result.
- Local Postgres:
  - MCP `value_security` (sotp) returned 9.28.
  - `save_valuation` stored the 3 segments and the reconciliation; a double-counting input was refused with the reason.
  - The web editor reopened the saved valuation at the same value (9.28); a DCF segment was added, saved and reloaded unchanged; the stock page offers "+ SOTP".
  - Test rows were deleted.
