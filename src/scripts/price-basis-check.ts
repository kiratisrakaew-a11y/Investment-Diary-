/**
 * PRICE_BASIS_BENCHMARK_SPEC checks on the real local database (no network; provider stubbed).
 *  P0  the daily updater stores adj_close for a new day and adj coverage never drops.
 *  P1  benchmarkForBasis == the previous rule exactly; resolver default/auto/explicit/errors; registry round
 *      trip; import_prices kind registration.
 * Later phases append feature checks (6.1 regression: no new option == explicit defaults).
 * TEST-LOCAL symbols PBT-* only, always removed; other prices must stay byte-identical.
 * Run: npm run check:price-basis
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import { and, asc, eq, isNotNull, like, sql } from "drizzle-orm";
import { getDb, schema } from "../db";
import { dbDeps, importPrices, type SyncDeps } from "../server/services/price-sync";
import { updateAllPrices } from "../server/services/price-updater";
import { benchmarkForBasis, loadBenchmark } from "../server/services/prices";
import {
  listBenchmarks,
  resolveBenchmark,
  setBenchmarkKind,
} from "../server/services/benchmarks";
import { getSettings } from "../server/services/settings";
import { chooseBenchmarkBasis } from "../lib/finance/benchmark-basis";
import { BenchmarkError } from "../lib/finance/benchmark-resolve";
import { featureChecks } from "./price-basis-features";

const db = getDb();
let failures = 0;
export const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const othersHash = async () =>
  createHash("sha256")
    .update(
      JSON.stringify([
        await db
          .select()
          .from(schema.prices)
          .where(
            sql`${schema.prices.assetId} not in (select id from assets where symbol like 'PBT-%')`,
          )
          .orderBy(schema.prices.assetId, schema.prices.date),
        await db
          .select()
          .from(schema.benchmarkPrices)
          .where(sql`${schema.benchmarkPrices.symbol} not like 'PBT-%'`)
          .orderBy(schema.benchmarkPrices.symbol, schema.benchmarkPrices.date),
      ]),
    )
    .digest("hex");

async function cleanup() {
  const ids = (
    await db
      .select({ id: schema.assets.id })
      .from(schema.assets)
      .where(like(schema.assets.symbol, "PBT-%"))
  ).map((r) => r.id);
  for (const id of ids) {
    await db.delete(schema.priceAdjustmentMeta).where(eq(schema.priceAdjustmentMeta.assetId, id));
    await db.delete(schema.prices).where(eq(schema.prices.assetId, id));
    await db.delete(schema.assets).where(eq(schema.assets.id, id));
  }
  await db.delete(schema.dividendEvents).where(like(schema.dividendEvents.symbol, "PBT-%"));
  // Cash movements of the TEST holdings (asset rows cascade; deposits have no asset).
  await db.delete(schema.transactions).where(like(schema.transactions.memo, "PBT-%"));
  await db.delete(schema.benchmarkPrices).where(like(schema.benchmarkPrices.symbol, "PBT-%"));
  await db.delete(schema.benchmarkMeta).where(like(schema.benchmarkMeta.symbol, "PBT-%"));
  return ids.length;
}

/** The rule benchmarkForBasis had before it became a resolver wrapper (copied verbatim for the regression). */
async function previousBenchmarkForBasis(
  wanted: "price" | "total_return",
  from: string,
  settings: { benchmarkSymbol: string; benchmarkKind: "price_index" | "total_return" },
) {
  const own = settings.benchmarkKind === "total_return" ? "total_return" : "price";
  const seen = new Set<string>();
  const cands = [
    { symbol: settings.benchmarkSymbol, basis: own },
    { symbol: "SETTRI", basis: "total_return" },
    { symbol: "^SET.BK", basis: "price" },
  ].filter((c) => !seen.has(c.symbol) && seen.add(c.symbol)) as {
    symbol: string;
    basis: "price" | "total_return";
  }[];
  const loaded = await Promise.all(
    cands.map(async (c) => ({ ...c, series: await loadBenchmark(c.symbol, from) })),
  );
  return chooseBenchmarkBasis(wanted, loaded, from);
}

async function main() {
  await cleanup();
  const before = await othersHash();
  const settings = await getSettings();
  try {
    const bench = await db
      .select({ date: schema.benchmarkPrices.date })
      .from(schema.benchmarkPrices)
      .where(eq(schema.benchmarkPrices.symbol, "^SET.BK"))
      .orderBy(asc(schema.benchmarkPrices.date));
    const days = bench.map((b) => b.date);
    if (days.length < 300) throw new Error("seed the local database first (^SET.BK)");

    // ------------------------------------------------------------------ P0: daily updater keeps adj_close
    const [A] = await db
      .insert(schema.assets)
      .values({
        symbol: "PBT-A",
        name: "TEST-LOCAL PBT-A (sample)",
        assetClass: "thai_stock",
        priceSource: "yahoo",
        providerSymbol: "PBT-A.BK",
      })
      .returning();
    const close = days.map((_, i) => 50 + Math.sin(i / 9) * 3 + i * 0.01);
    // Stored up to the day before the provider's last day; the provider has one more (the "new day").
    const all = days.slice(-31);
    const newDay = all[30];
    const px = (i: number) => +close[days.length - 31 + i].toFixed(4);
    await db.insert(schema.prices).values(
      all.slice(0, -1).map((d, i) => ({
        assetId: A.id,
        date: d,
        close: px(i),
        adjClose: +(px(i) * 0.97).toFixed(6),
      })),
    );
    const adjCount = async () =>
      (
        await db
          .select({ n: sql<number>`count(*)::int` })
          .from(schema.prices)
          .where(and(eq(schema.prices.assetId, A.id), isNotNull(schema.prices.adjClose)))
      )[0].n;
    const before0 = await adjCount();
    const stub: SyncDeps = {
      ...dbDeps,
      fetchHistory: async (p, range) =>
        p === "PBT-A.BK"
          ? {
              rows: all
                .map((d, i) => ({ date: d, close: px(i), adjClose: +(px(i) * 0.97).toFixed(6) }))
                .filter((r) => r.date >= range.from && r.date <= range.to),
              splits: [],
              dividends: [],
            }
          : { rows: [], splits: [], dividends: [] },
      fetchFundNav: async () => null,
      saveDividendEvents: undefined,
    };
    const res = await updateAllPrices(stub);
    const [nd] = await db
      .select()
      .from(schema.prices)
      .where(and(eq(schema.prices.assetId, A.id), eq(schema.prices.date, newDay)));
    check(
      "P0 daily updater: the new day has adj_close (Yahoo stock)",
      nd?.adjClose != null && Math.abs(nd.adjClose - px(30) * 0.97) < 1e-6,
      JSON.stringify(res.find((r) => r.symbol === "PBT-A")),
    );
    check("P0 adj_close coverage does not drop", (await adjCount()) === before0 + 1);
    const [meta] = await db
      .select()
      .from(schema.priceAdjustmentMeta)
      .where(eq(schema.priceAdjustmentMeta.assetId, A.id));
    check("P0 adjustment base recorded by the daily run", !!meta?.adjBaseDate);

    // ------------------------------------------------------------------ P1: benchmarkForBasis unchanged
    const s = { benchmarkSymbol: settings.benchmarkSymbol, benchmarkKind: settings.benchmarkKind };
    let same = true;
    for (const wanted of ["price", "total_return"] as const)
      for (const from of [days[0], days[100], days[days.length - 50]]) {
        const a = await benchmarkForBasis(wanted, from, s);
        const b = await previousBenchmarkForBasis(wanted, from, s);
        if (JSON.stringify(a) !== JSON.stringify(b)) same = false;
      }
    check("P1 benchmarkForBasis == previous rule (6 cases, byte-identical)", same);

    // resolver on the real registry
    const def = await resolveBenchmark({ wanted: "price", featureDefault: "settings" });
    check(
      "P1 resolveBenchmark default (Settings rule) = Settings' series",
      def?.symbol === settings.benchmarkSymbol &&
        JSON.stringify(def.series) === JSON.stringify(await loadBenchmark(settings.benchmarkSymbol)),
    );
    const nf = await resolveBenchmark({
      request: "PBT-NOPE",
      wanted: "price",
      featureDefault: "settings",
    }).catch((e) => e);
    check(
      "P1 unknown index → BENCHMARK_NOT_FOUND with the list",
      nf instanceof BenchmarkError && nf.available.includes(settings.benchmarkSymbol),
    );

    // import_prices kind registration + registry edit
    const imp = await importPrices({
      target: "benchmark",
      kind: "total_return",
      rows: days.slice(-40).map((d, i) => ({ symbol: "PBT-TRI", date: d, close: 1000 + i })),
    });
    const list = await listBenchmarks();
    const tri = list.find((b) => b.symbol === "PBT-TRI");
    check(
      "P1 import_prices kind → registry (total_return, 40 days)",
      imp.summary.ok === 1 && tri?.kind === "total_return" && tri.days === 40,
    );
    const auto = await resolveBenchmark({
      request: "PBT-TRI",
      wanted: "total_return",
      from: days[days.length - 40],
      featureDefault: "settings",
    });
    check("P1 explicit TRI with total_return → no warning", auto?.warning === null);
    const cov = await resolveBenchmark({
      request: "PBT-TRI",
      wanted: "total_return",
      from: days[0],
      featureDefault: "settings",
    }).catch((e) => e);
    check("P1 short TRI for a long period → BENCHMARK_COVERAGE", cov?.code === "BENCHMARK_COVERAGE");
    await setBenchmarkKind("PBT-TRI", "price_index");
    check(
      "P1 registry edit changes the kind",
      (await listBenchmarks()).find((b) => b.symbol === "PBT-TRI")?.kind === "price_index",
    );
    const after = await getSettings();
    check(
      "P1 Settings untouched by registry edits of other indexes",
      after.benchmarkKind === settings.benchmarkKind &&
        after.benchmarkSymbol === settings.benchmarkSymbol &&
        after.defaultBenchmark === settings.defaultBenchmark,
    );

    await featureChecks(check, days);

    check("other prices and indexes byte-identical", (await othersHash()) === before);
  } finally {
    console.log(`cleaned up ${await cleanup()} test assets`);
  }
  console.log(failures ? `${failures} FAILED` : "ALL PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await cleanup().catch(() => 0);
  process.exit(1);
});
