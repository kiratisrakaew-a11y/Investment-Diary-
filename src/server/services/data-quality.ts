import {
  assessDataQuality,
  fxGapsFor,
  marketInputProvenance,
  priceDateAt,
  readTimestampPolicy,
  statementsAsOfAt,
  timestampFlags,
} from "@/lib/governance";
import { getDb, schema } from "@/db";
import { isHorizonSnapshot } from "@/lib/valuation-schemas";
import { today } from "@/lib/validation";
import { detectUnrecordedSplits } from "@/lib/finance/price-coverage";
import { listAssets } from "./assets";
import { allTransactions } from "./transactions";
import { getPortfolioSummary } from "./portfolio";
import { loadBenchmark, loadPriceHistory } from "./prices";
import { getSettings } from "./settings";
import { listValuations, valueChangedSinceSave } from "./valuations";
import { abnormalDataQuality } from "@/lib/finance/abnormal/quality";
import { adjReadiness } from "@/lib/finance/adj-check";
import { loadAdjCheckInput, loadFxHistory } from "./prices";
import { listBenchmarks } from "./benchmarks";
import { DEFAULT_TRI_SYMBOL } from "./abnormal";
import { sql } from "drizzle-orm";

/** Readiness of non-archived Thai stocks for abnormal-trading analysis (one aggregate query per table). */
export async function abnormalReadiness(benchmarkSymbol: string) {
  const db = getDb();
  const rows = (await db.execute(sql`
      select a.symbol,
             count(p.date)::int as price_days,
             count(p.volume)::int as volume_days,
             count(*) filter (where p.volume = 0)::int as zero_days,
             exists (select 1 from shares_outstanding s where s.symbol = upper(a.symbol)) as shares
      from assets a left join prices p on p.asset_id = a.id
      where a.asset_class = 'thai_stock' and a.archived_at is null
      group by a.id, a.symbol order by a.symbol`)) as unknown as {
    symbol: string;
    price_days: number;
    volume_days: number;
    zero_days: number;
    shares: boolean;
  }[];
  const bench = (await db.execute(
    sql`select symbol, count(*)::int as n from benchmark_prices where symbol in (${DEFAULT_TRI_SYMBOL}, ${benchmarkSymbol}) group by symbol`,
  )) as unknown as { symbol: string; n: number }[];
  const days = (s: string) => bench.find((b) => b.symbol === s)?.n ?? 0;
  return abnormalDataQuality(
    rows.map((r) => ({
      symbol: r.symbol,
      priceDays: r.price_days,
      volumeDays: r.volume_days,
      zeroVolumeDays: r.zero_days,
      sharesRecorded: r.shares,
    })),
    {
      triSymbol: DEFAULT_TRI_SYMBOL,
      triDays: days(DEFAULT_TRI_SYMBOL),
      indexSymbol: benchmarkSymbol,
      indexDays: days(benchmarkSymbol),
    },
  );
}

/** Everything that can make a number in the app unreliable, in one list (UI, MCP and REST). */
export async function dataQualityReport() {
  const [settings, summary, assets, valuations, prices, txs, fiscal] =
    await Promise.all([
      getSettings(),
      getPortfolioSummary(),
      listAssets(),
      listValuations({ limit: 2000 }),
      loadPriceHistory(),
      allTransactions(),
      getDb()
        .select({
          symbol: schema.financialStatements.symbol,
          fiscalYear: schema.financialStatements.fiscalYear,
        })
        .from(schema.financialStatements),
    ]);
  const policy = readTimestampPolicy(settings.timestampPolicy);
  // Latest valuation per symbol and method (rows are newest first), checked as of its own date.
  const seen = new Set<string>();
  const latest = valuations.filter(
    (v) =>
      v.method !== "bond" &&
      !isHorizonSnapshot(v.assumptions) &&
      !seen.has(`${v.symbol}|${v.method}`) &&
      seen.add(`${v.symbol}|${v.method}`),
  );
  const valuationDates = latest.map((v) => {
    const dates = v.assetId
      ? (prices.get(v.assetId) ?? []).map(([d]) => d)
      : [];
    const st = statementsAsOfAt(
      fiscal.filter((f) => f.symbol === v.symbol).map((f) => f.fiscalYear),
      v.date,
    );
    return {
      symbol: v.symbol,
      method: v.method,
      date: v.date,
      flags: timestampFlags(
        {
          valuationDate: v.date,
          inputsAsOf: (
            v.assumptions as { inputMeta?: { asOf?: string } } | null
          )?.inputMeta?.asOf,
          priceDate: dates.length ? priceDateAt(dates, v.date) : null,
          statementsAsOf: st?.asOf,
          statementsLabel: st?.label,
        },
        policy,
      ),
    };
  });
  const since = new Date(Date.now() - 365 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const bench = await loadBenchmark(settings.benchmarkSymbol);
  const abnormal = await abnormalReadiness(settings.benchmarkSymbol);
  // adj_close coverage / consistency over the optimizer's default look-back (3 years), non-archived assets.
  const adjFrom = new Date(Date.now() - 365 * 3 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const adjInput = await loadAdjCheckInput(
    assets.filter((a) => !a.archivedAt && a.assetClass !== "cash"),
    adjFrom,
  );
  const adjClose = adjReadiness(adjInput);
  const held = new Set(
    summary.positions.filter((p) => p.quantity > 0).map((p) => p.assetId),
  );
  // F10: every index with its kind and range; adj_close coverage per asset (3-year window).
  const benchmarks = await listBenchmarks();
  const adjCoverage = adjInput.map((a) => {
    const withAdj = a.obs.filter((o) => o.adjClose != null && o.adjClose > 0).length;
    return {
      symbol: a.symbol,
      assetClass: a.assetClass,
      held: assets.some((x) => x.symbol === a.symbol && held.has(x.id)),
      days: a.obs.length,
      withAdjClose: withAdj,
      ratio: a.obs.length ? withAdj / a.obs.length : 0,
    };
  });
  // MPT B2: USDTHB gaps over the 3-year price history of every non-archived USD asset.
  const fxHist = await loadFxHistory();
  const fxGaps = assets
    .filter((a) => !a.archivedAt && a.currency === "USD" && a.assetClass !== "cash")
    .map((a) =>
      fxGapsFor(
        a.symbol,
        (prices.get(a.id) ?? []).filter(([d]) => d >= adjFrom).map(([d]) => d),
        fxHist,
      ),
    );
  const defaultBench = settings.defaultBenchmark;
  const priceBasisDefaults = {
    defaultReturnBasis: settings.defaultReturnBasis,
    heldWithoutAdj: adjCoverage
      .filter((a) => a.held && (a.assetClass === "thai_stock" || a.assetClass === "us_stock") && a.ratio < 1)
      .map((a) => a.symbol),
    defaultBenchmark: defaultBench,
    defaultBenchmarkLastDate:
      benchmarks.find((b) => b.symbol === defaultBench.toUpperCase())?.to ?? null,
  };
  const report = assessDataQuality({
    provenance: marketInputProvenance(settings),
    positions: summary.positions
      .filter((p) => p.quantity > 0)
      .map((p) => ({
        symbol: p.symbol,
        priceStatus: p.priceStatus,
        priceAgeDays: p.priceAgeDays,
        fxStatus: p.fxStatus,
      })),
    reconciliation: summary.reconciliation,
    ledgerIssues: summary.issues,
    benchmark: {
      symbol: settings.benchmarkSymbol,
      lastDate: bench[bench.length - 1]?.[0] ?? null,
      kind: settings.benchmarkKind,
    },
    today: today(),
    valuationDates,
    valuations: valuations.map((v) => ({
      id: v.id,
      symbol: v.symbol,
      modelVersion: (v.result as { modelVersion?: string } | null)
        ?.modelVersion,
      valueChanged: valueChangedSinceSave(v),
    })),
    bonds: assets
      .filter((a) => a.assetClass === "bond" && held.has(a.id))
      .map((a) => ({
        symbol: a.symbol,
        conventionsSet: a.couponFrequency != null && a.dayCount != null,
      })),
    splits: assets
      .filter((a) => held.has(a.id) && a.assetClass !== "cash")
      .flatMap((a) =>
        detectUnrecordedSplits(
          prices.get(a.id) ?? [],
          txs
            .filter((t) => t.assetId === a.id && t.type === "split")
            .map((t) => t.date),
        ).map((s) => ({ symbol: a.symbol, date: s.date, factor: s.factor })),
      ),
    abnormal,
    adjClose,
    priceBasisDefaults,
    fxGaps,
    history: assets
      .filter((a) => held.has(a.id) && a.assetClass !== "cash")
      .map((a) => ({
        symbol: a.symbol,
        observations: (prices.get(a.id) ?? []).filter(([d]) => d >= since)
          .length,
        lookbackDays: 365,
      })),
  });
  // Per-stock detail behind the abnormal-trading check (MCP / REST readers).
  return {
    ...report,
    abnormalTrading: abnormal,
    adjClose,
    benchmarks,
    adjCoverage,
    priceBasisDefaults,
  };
}
