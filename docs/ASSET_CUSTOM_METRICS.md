# Asset custom metrics and threshold monitoring

Location: **Assets → (asset) → "Custom Metrics / ตัวชี้วัดที่ติดตาม"**, between Price and Transactions. Starts empty; no sample data is shipped.

## Data (migration `0016_asset_custom_metrics`, additive)
| Table | Purpose |
|---|---|
| `asset_metric_definitions` | per-asset metric: name, immutable normalised `key` (unique per asset), unit, frequency, decimals, chart colour token, `show_in_chart`, `is_active` (soft archive). FK `assets` ON DELETE RESTRICT |
| `asset_metric_observations` | `observed_on` (period date) + `value numeric` (exact, entered precision kept), source, note, `published_on` (never inferred), `recorded_at`. Unique (metric, observed_on) |
| `asset_metric_threshold_versions` | `rule_type`, bounds (`numeric`), `[effective_from, effective_to)`, reason, source. Unique (metric, effective_from); check `effective_to > effective_from` |
| `asset_metric_events` | audit: object, action, before/after JSON |

Values never feed P&L, prices, risk-free rates, statements, performance or valuations.

## Threshold semantics (`src/lib/asset-metrics/thresholds.ts`)
- `lower_is_better` (G < Y): v ≤ G green · G < v ≤ Y yellow · v > Y red — e.g. NPL 2.5/3.5: 2.5 green, 3.1 and 3.5 yellow, 3.6 red.
- `higher_is_better` (Y < G): v < Y red · Y ≤ v < G yellow · v ≥ G green.
- `target_range` (yMin < gMin ≤ gMax < yMax): inside green range green · inside yellow range yellow · else red.
- No rule on that date → `NO_THRESHOLD`; no value → `NO_DATA` (never green). Staleness (≈1.5 reporting periods; irregular never) is a separate marker.
- Each observation is evaluated with the version in effect on **its own date**. A new version must start after the latest one (the open one is closed at that date); a version already in effect is never rewritten; a future version can be replaced. The metric row is locked during the write, so concurrent writes serialise. Preview shows status changes before saving.

## Charts (`src/lib/asset-metrics/series.ts`)
- **Actual**: same unit and ≤ 10× magnitude → one axis; two scale groups → two axes (warned); 3+ → small multiples. Single-metric charts show green/yellow/red bands per threshold version over the dates it applied.
- **Indexed 100**: base = first observation in the window, only if > 0; different base dates are warned; tooltip shows raw values.
- **% Change**: vs the previous *actual* observation; null with a reason when the previous value is 0, negative or the sign changes. Summary uses **pp** for % units.
- Union of observed dates; gaps stay null (optional, labelled line-joining only draws between real points).

## REST (API key or session; JSON bodies ≤ 16 KB)
`GET/POST /api/v1/assets/:id/metrics` · `PATCH/DELETE /api/v1/assets/:id/metrics/:metricId` (DELETE needs `?confirmName=`) ·
`GET/POST …/:metricId/observations` · `PATCH/DELETE …/observations/:observationId` ·
`GET/POST …/:metricId/thresholds` (`?preview=1`) · `GET /api/v1/assets/:id/metric-series?metricIds=&from=&to=&mode=`.
Every metric / observation is checked to belong to the asset in the path (404 otherwise); 409 for duplicate keys, duplicate dates, overlapping or back-dated thresholds and unconfirmed unit changes.

## Lifecycle
Custom metrics count as dependencies: permanent asset delete is blocked while any exist (hide / archive keep everything). A metric can be soft-archived and restored; hard delete needs the exact metric name and is audited.

## Not included (follow-up)
CSV import, scheduled refresh, MCP / AI-advisor tools, OpenAPI entries for the new routes.
