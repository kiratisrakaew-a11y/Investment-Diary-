/**
 * spec-mpt-selected-universe on the real local database: an asset outside the checked set must have zero
 * influence on μ, Σ, β, the period, the frequency, the warnings or the weights. TEST-LOCAL PBU-* assets only,
 * always removed; other prices must stay byte-identical. Run: npm run check:universe
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";
import { getDb, schema } from "../db";
import { loadUniverse, optimizePortfolio, previewOptimizeWindow } from "../server/services/optimizer";
import { backtestPortfolio } from "../server/services/backtest";
import { comparePortfolioModels } from "../server/services/model-comparison";

const db = getDb();
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const othersHash = async () =>
  createHash("sha256")
    .update(
      JSON.stringify(
        await db
          .select()
          .from(schema.prices)
          .where(sql`${schema.prices.assetId} not in (select id from assets where symbol like 'PBU-%')`)
          .orderBy(schema.prices.assetId, schema.prices.date),
      ),
    )
    .digest("hex");

async function cleanup() {
  const ids = (await db.select({ id: schema.assets.id }).from(schema.assets).where(like(schema.assets.symbol, "PBU-%"))).map((r) => r.id);
  for (const id of ids) {
    await db.delete(schema.prices).where(eq(schema.prices.assetId, id));
    await db.delete(schema.assets).where(eq(schema.assets.id, id));
  }
  await db.delete(schema.dividendEvents).where(like(schema.dividendEvents.symbol, "PBU-%"));
  return ids.length;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const err = async (f: () => Promise<unknown>) => {
  try {
    await f();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
};

async function main() {
  await cleanup();
  const before = await othersHash();
  try {
    const days = (
      await db.select({ d: schema.benchmarkPrices.date }).from(schema.benchmarkPrices).where(eq(schema.benchmarkPrices.symbol, "^SET.BK")).orderBy(schema.benchmarkPrices.date)
    ).map((r) => r.d);
    if (days.length < 300) throw new Error("seed the local database first");
    const S = ["PTT", "CPALL", "K-FIXED"];
    const win = { preset: "2y" as const };
    const opts = { window: win, returnBasis: "total_return" as const, withSeries: true };

    // Baseline BEFORE any extra asset exists.
    const base = await loadUniverse(undefined, S, opts);
    check("baseline: 3 checked assets, 2y, daily, quality ok", base.ok && base.frequency === "daily" && base.windowInfo!.quality === "ok", `${base.windowInfo?.effective?.years.toFixed(2)}y ${base.frequency}`);

    // Unchecked extras that would each change a whole-universe result: a late listing, a USD (US-time) asset
    // without Thai trading hours, a dividend payer without adj_close.
    const mk = async (symbol: string, o: { currency?: "THB" | "USD"; fromIdx?: number; cls?: "thai_stock" | "us_stock" }) => {
      const [a] = await db
        .insert(schema.assets)
        .values({ symbol, name: `TEST-LOCAL ${symbol} (sample)`, assetClass: o.cls ?? "thai_stock", currency: o.currency ?? "THB", priceSource: "manual", sector: "TestSector" })
        .returning();
      const rows = days.slice(o.fromIdx ?? 0).map((d, i) => ({ assetId: a.id, date: d, close: 20 + Math.sin(i / 9) * 3 + i * 0.004 }));
      await db.insert(schema.prices).values(rows);
      return a;
    };
    await mk("PBU-LATE", { fromIdx: days.length - 120 });
    await mk("PBU-USD", { currency: "USD", cls: "us_stock" });
    const D = await mk("PBU-DIV", {});
    await db.insert(schema.dividendEvents).values({ symbol: "PBU-DIV", assetId: D.id, exDate: days[days.length - 100], dividendPerShare: 0.5, source: "test", sourceEventId: "PBU-DIV-1" });

    const after = await loadUniverse(undefined, S, opts);
    check("adding unchecked assets (late listing, USD, dividend payer w/o adj_close) changes nothing for the same checked set", same(base, after));
    const text = JSON.stringify([after.windowInfo, after.covarianceWarnings, after.skipped, after.priceBasis]);
    check("no unchecked symbol appears in windowInfo / warnings / skipped / priceBasis", !/PBU-|GOLD|AAPL/.test(text));

    // Same as the dry-run an MCP user would run.
    const dry = await previewOptimizeWindow({ symbols: S, window: win, returnBasis: "total_return" });
    check(
      "page universe == optimize_portfolio({ symbols, window, returnBasis, dryRun }) (windowInfo, coverage, frequency)",
      same(dry.windowInfo, after.windowInfo) && same(dry.coverage, after.coverage) && dry.frequency === after.frequency,
    );

    // Whole-universe behaviour for contrast: selecting the late listing really does shorten the window; removing restores.
    const withLate = await loadUniverse(undefined, [...S, "PBU-LATE"], opts);
    check(
      "checking the late listing shortens the window; unchecking it restores the full requested window",
      withLate.windowInfo!.effective!.years < 1 && withLate.windowInfo!.limitedBy.some((l) => l.symbol === "PBU-LATE") && same(await loadUniverse(undefined, S, opts), base),
      `${withLate.windowInfo!.effective!.years.toFixed(2)}y → ${base.windowInfo!.effective!.years.toFixed(2)}y`,
    );
    const withUsd = await loadUniverse(undefined, [...S, "PBU-USD"], opts);
    check("checking the USD asset switches to weekly; the checked-only set stays daily", withUsd.frequency === "weekly" && after.frequency === "daily");

    // Optimize outputs identical with 3 vs 6+3 assets in the database.
    const o1 = await optimizePortfolio({ symbols: S, window: win, returnBasis: "total_return" });
    check("optimize_portfolio result for the checked set is unaffected by the unchecked assets", o1.ok && same(o1.windowInfo, after.windowInfo));

    // Empty selection is an error everywhere — never "every asset".
    check("loadUniverse symbols [] → error", !!(await err(() => loadUniverse(undefined, [], {}))));
    check("optimize_portfolio symbols [] → error", !!(await err(() => optimizePortfolio({ symbols: [] }))));
    check("backtest_portfolio symbols [] → error", /symbols ว่าง/.test((await err(() => backtestPortfolio({ strategy: "equal_weight", symbols: [] }))) ?? ""));
    check("compare_portfolio_models symbols [] → error (at least 2 required)", !!(await err(() => comparePortfolioModels({ symbols: [] }))));

    // Backtest / compare compute only the checked set.
    const bt = await backtestPortfolio({ strategy: "equal_weight", symbols: ["PTT", "CPALL"], window: win });
    check("backtest universe = the checked symbols only", same([...bt.universe].sort(), ["CPALL", "PTT"]));
    const cmp = await comparePortfolioModels({ symbols: S, window: win, models: ["equal_weight", "min_variance"] } as never);
    check("compare universe = the checked symbols only", same([...cmp.symbols].sort(), [...S].sort()));

    check("other prices byte-identical", (await othersHash()) === before);
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
