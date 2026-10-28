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

## Charts (`src/lib/asset-metrics/series.ts` → `singleMetricChart`, `src/components/AssetMetricChart.tsx`)
- **One metric = one chart card, in every mode.** Metrics are never combined, whether they share a unit or a scale; there are no dual axes. Each card shows the name, unit, latest raw value, its date and status, its own y-axis scaled from that metric only, and a tooltip for that metric only. The number of cards equals the number of active metrics ticked "กราฟ". A metric with no data, or none in the selected range, still gets a card with an empty state.
- **Actual**: raw values with the metric's own green/yellow/red bands per threshold version, over the dates each version applied. The y-axis also covers the metric's own bounds.
- **Indexed 100**: base = this metric's first observation in the window, only if > 0. Otherwise that card alone shows the reason. The tooltip shows raw values, and raw threshold bands are not drawn.
- **% Change**: vs the previous *actual* observation; null with a reason when the previous value is 0, negative or the sign changes. When nothing is computable, the card shows the reason. Raw bands are not drawn. The summary uses **pp** for % units.
- Status rings on points are always evaluated on the raw value under the version in force on that date.
- Range (1Y/3Y/5Y/All), mode and "connect missing dates" apply to every card. A gap longer than the metric's frequency allows (the same limits as freshness) breaks the line, unless "connect" is on. Connecting only draws a line between real readings and never adds values.

## REST (API key or session; JSON bodies ≤ 16 KB)
`GET/POST /api/v1/assets/:id/metrics` · `PATCH/DELETE /api/v1/assets/:id/metrics/:metricId` (DELETE needs `?confirmName=`) ·
`GET/POST …/:metricId/observations` · `PATCH/DELETE …/observations/:observationId` ·
`GET/POST …/:metricId/thresholds` (`?preview=1`) · `GET /api/v1/assets/:id/metric-series?metricIds=&from=&to=&mode=`.
Every metric / observation is checked to belong to the asset in the path (404 otherwise); 409 for duplicate keys, duplicate dates, overlapping or back-dated thresholds and unconfirmed unit changes.

## MCP (`src/server/mcp-asset-metrics.ts`)
There are 12 tools over the same service, with source `mcp`. The asset is resolved by `symbol` and never auto-created; metrics and observations are targeted by id. Errors are coded as `[CODE]`. Setup and usage are in [AI_SETUP.md](AI_SETUP.md#custom-metrics-ผ่าน-mcp), and the end-to-end check is `npm run check:mcp-asset-metrics`.

## Lifecycle
Custom metrics count as dependencies: permanent asset delete is blocked while any exist (hide / archive keep everything). A metric can be soft-archived and restored; hard delete needs the exact metric name and is audited.

## Not included (follow-up)
CSV import, scheduled refresh, AI-advisor (in-app) tools, OpenAPI entries for the metric routes (ChatGPT Custom GPT Actions).
