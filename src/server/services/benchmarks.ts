/**
 * PRICE_BASIS_BENCHMARK_SPEC D4: the benchmark registry (benchmark_meta) and the resolver every
 * return-based feature uses to pick its index (see lib/finance/benchmark-resolve.ts for the rules).
 */
import { sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import {
  benchmarkKindOf,
  resolveBenchmarkWith,
  type BenchmarkContext,
  type BenchmarkInfo,
  type BenchmarkKind,
  type FeatureBenchmarkDefault,
} from "@/lib/finance/benchmark-resolve";
import type { BenchmarkBasis } from "@/lib/finance/benchmark-basis";
import { getSettings } from "./settings";
import { loadBenchmark } from "./prices";

async function loadRegistry(): Promise<
  Map<string, { kind: BenchmarkKind; label: string | null }>
> {
  const rows = await getDb().select().from(schema.benchmarkMeta);
  return new Map(rows.map((r) => [r.symbol, { kind: r.kind, label: r.label }]));
}

/** Every index the app knows: stored series (with range and days) plus registered symbols without data yet. */
export async function listBenchmarks(): Promise<BenchmarkInfo[]> {
  const settings = await getSettings();
  const reg = await loadRegistry();
  const rows = (await getDb().execute(
    sql`select symbol, min(date)::text as "from", max(date)::text as "to", count(*)::int as days from benchmark_prices group by symbol order by symbol`,
  )) as unknown as { symbol: string; from: string; to: string; days: number }[];
  const ctx = {
    settings: {
      benchmarkSymbol: settings.benchmarkSymbol,
      benchmarkKind: settings.benchmarkKind,
    },
    registry: new Map([...reg].map(([s, r]) => [s, r.kind])),
  };
  const out: BenchmarkInfo[] = rows.map((r) => ({
    symbol: r.symbol,
    kind: benchmarkKindOf(r.symbol, ctx),
    label: reg.get(r.symbol)?.label ?? null,
    from: r.from,
    to: r.to,
    days: Number(r.days),
  }));
  for (const [symbol, r] of reg)
    if (!out.some((b) => b.symbol === symbol))
      out.push({
        symbol,
        kind: benchmarkKindOf(symbol, ctx),
        label: r.label,
        from: null,
        to: null,
        days: 0,
      });
  return out;
}

/**
 * Register an index's kind. For Settings' own benchmark the Settings kind is updated too, so the two never
 * disagree (Settings' kind is what the "default" rule reads).
 */
export async function setBenchmarkKind(
  symbol: string,
  kind: BenchmarkKind,
  source = "settings",
  label?: string | null,
) {
  const s = symbol.trim().toUpperCase();
  if (!s) throw new Error("ต้องระบุสัญลักษณ์ดัชนี");
  const db = getDb();
  await db
    .insert(schema.benchmarkMeta)
    .values({ symbol: s, kind, source, ...(label !== undefined ? { label } : {}) })
    .onConflictDoUpdate({
      target: schema.benchmarkMeta.symbol,
      set: {
        kind,
        source,
        updatedAt: new Date(),
        ...(label !== undefined ? { label } : {}),
      },
    });
  const settings = await getSettings();
  if (settings.benchmarkSymbol === s && settings.benchmarkKind !== kind) {
    const { saveSettings } = await import("./settings");
    await saveSettings({
      riskFreeRate: settings.riskFreeRate,
      benchmarkSymbol: settings.benchmarkSymbol,
      benchmarkKind: kind,
    });
  }
}

export async function benchmarkContext(): Promise<BenchmarkContext> {
  const settings = await getSettings();
  const reg = await loadRegistry();
  return {
    settings: {
      benchmarkSymbol: settings.benchmarkSymbol,
      benchmarkKind: settings.benchmarkKind,
    },
    registry: new Map([...reg].map(([s, r]) => [s, r.kind])),
    list: await listBenchmarks(),
    load: (symbol, from) => loadBenchmark(symbol, from),
  };
}

/**
 * Resolve a feature's benchmark. `request` undefined → Settings' defaultBenchmark (unless the feature opts out
 * with useSettingsDefault: false, as abnormal trading does).
 */
export async function resolveBenchmark(opts: {
  request?: string | null;
  wanted: BenchmarkBasis;
  from?: string;
  featureDefault: FeatureBenchmarkDefault;
  useSettingsDefault?: boolean;
}) {
  const settings = await getSettings();
  const request =
    opts.request ??
    (opts.useSettingsDefault === false ? null : settings.defaultBenchmark);
  return resolveBenchmarkWith(
    { ...opts, request },
    await benchmarkContext(),
  );
}
