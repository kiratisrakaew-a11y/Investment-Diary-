/**
 * MPT_FIX_SPEC phase 2 on the real local database: A2 (one adj_close base, whole-series rebase in one
 * transaction), A3 (total-return source per asset class), A4/A5 (adj_close vs dividends, data quality).
 * The provider is stubbed (no network). TEST-LOCAL symbols TLT-* only, always removed; other prices
 * must stay byte-identical. Run: npm run check:total-return
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import { asc, eq, like, sql } from "drizzle-orm";
import { getDb, schema } from "../db";
import {
  dbDeps,
  syncHistoricalPrices,
  type SyncDeps,
} from "../server/services/price-sync";
import { optimizePortfolio } from "../server/services/optimizer";
import { dataQualityReport } from "../server/services/data-quality";
import { changeAssetLifecycle } from "../server/services/asset-lifecycle";

const db = getDb();
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`,
  );
};
const othersHash = async () =>
  createHash("sha256")
    .update(
      JSON.stringify(
        await db
          .select()
          .from(schema.prices)
          .where(
            sql`${schema.prices.assetId} not in (select id from assets where symbol like 'TLT-%')`,
          )
          .orderBy(schema.prices.assetId, schema.prices.date),
      ),
    )
    .digest("hex");

async function cleanup() {
  const ids = (
    await db
      .select({ id: schema.assets.id })
      .from(schema.assets)
      .where(like(schema.assets.symbol, "TLT-%"))
  ).map((r) => r.id);
  for (const id of ids) {
    await db
      .delete(schema.priceAdjustmentMeta)
      .where(eq(schema.priceAdjustmentMeta.assetId, id));
    await db.delete(schema.prices).where(eq(schema.prices.assetId, id));
    await db
      .delete(schema.assetLifecycleEvents)
      .where(eq(schema.assetLifecycleEvents.assetId, id));
    await db.delete(schema.assets).where(eq(schema.assets.id, id));
  }
  await db
    .delete(schema.dividendEvents)
    .where(like(schema.dividendEvents.symbol, "TLT-%"));
  return ids.length;
}

async function main() {
  await cleanup();
  const before = await othersHash();
  try {
    const bench = await db
      .select({ date: schema.benchmarkPrices.date })
      .from(schema.benchmarkPrices)
      .where(eq(schema.benchmarkPrices.symbol, "^SET.BK"))
      .orderBy(asc(schema.benchmarkPrices.date));
    const days = bench.map((b) => b.date);
    if (days.length < 300)
      throw new Error("seed the local database first (^SET.BK)");
    let s = 3;
    const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647 - 0.5;
    const closeOf = (k: number) => {
      const p: number[] = [];
      let v = 40 + k * 7;
      for (let i = 0; i < days.length; i++)
        p.push(i === 0 ? v : (v *= 1 + rnd() * 0.03));
      return p;
    };
    const mk = async (
      symbol: string,
      k: number,
      opts: { assetClass?: "thai_stock" | "gold"; adj?: boolean } = {},
    ) => {
      const [a] = await db
        .insert(schema.assets)
        .values({
          symbol,
          name: `TEST-LOCAL ${symbol} (sample)`,
          assetClass: opts.assetClass ?? "thai_stock",
          priceSource: "yahoo",
          providerSymbol: `${symbol}.BK`,
        })
        .returning();
      const c = closeOf(k);
      await db
        .insert(schema.prices)
        .values(
          days.map((d, i) => ({
            assetId: a.id,
            date: d,
            close: +c[i].toFixed(4),
            adjClose: opts.adj ? +(c[i] * 0.9).toFixed(6) : null,
          })),
        );
      return { a, c };
    };

    // ------------------------------------------------------------------ A2: rebase on the real write path
    const { a: R, c: rc } = await mk("TLT-R", 1);
    const provider = {
      factor: 0.95,
      dividends: [] as { date: string; amount: number }[],
      today: days[days.length - 1],
    };
    const stub: SyncDeps = {
      ...dbDeps,
      today: () => provider.today,
      fetchHistory: async (_p, range) => ({
        rows: days
          .map((d, i) => ({
            date: d,
            close: +rc[i].toFixed(4),
            adjClose: +(rc[i] * provider.factor).toFixed(6),
          }))
          .filter((r) => r.date >= range.from && r.date <= range.to),
        splits: [],
        dividends: provider.dividends.filter(
          (x) => x.date >= range.from && x.date <= range.to,
        ),
      }),
      saveDividendEvents: undefined,
    };
    const tail = days.slice(-20);
    const r1 = (
      await syncHistoricalPrices(
        {
          symbols: ["TLT-R"],
          startDate: tail[0],
          endDate: tail[19],
          priceType: "adjusted_close",
          includeBenchmark: false,
          includeFx: false,
        },
        stub,
      )
    ).results[0];
    const [m1] = await db
      .select()
      .from(schema.priceAdjustmentMeta)
      .where(eq(schema.priceAdjustmentMeta.assetId, R.id));
    check(
      "A2 first adjusted sync records the base (adjBaseDate)",
      r1.adjRebase?.rebased === false && m1?.adjBaseDate === provider.today,
      JSON.stringify(r1.adjRebase),
    );
    // The provider rescales the whole adjusted history after a new dividend.
    provider.factor = 0.9;
    provider.dividends = [{ date: tail[15], amount: 1 }];
    const r2 = (
      await syncHistoricalPrices(
        {
          symbols: ["TLT-R"],
          startDate: tail[10],
          endDate: tail[19],
          priceType: "adjusted_close",
          includeBenchmark: false,
          includeFx: false,
        },
        stub,
      )
    ).results[0];
    const rows = await db
      .select({
        d: schema.prices.date,
        c: schema.prices.close,
        a: schema.prices.adjClose,
      })
      .from(schema.prices)
      .where(eq(schema.prices.assetId, R.id))
      .orderBy(asc(schema.prices.date));
    const [m2] = await db
      .select()
      .from(schema.priceAdjustmentMeta)
      .where(eq(schema.priceAdjustmentMeta.assetId, R.id));
    check(
      "A2 new dividend → EVERY stored row (whole history, not just the range) carries the new fetch's adj_close; close untouched",
      r2.adjRebase?.rebased === true &&
        rows.length === days.length &&
        rows.every(
          (x, i) =>
            x.a != null &&
            Math.abs(x.a - +(rc[i] * 0.9).toFixed(6)) < 1e-9 &&
            x.c === +rc[i].toFixed(4),
        ),
      JSON.stringify(r2.adjRebase),
    );
    check(
      "A2 metadata moves to the new base and event",
      m2?.adjLastEventDate === tail[15],
    );
    const ret = (k: number) => rows[k].a! / rows[k - 1].a! - 1;
    const cret = (k: number) => rows[k].c / rows[k - 1].c - 1;
    const seam = days.indexOf(tail[10]);
    check(
      "A2 no jump at the seam between the two syncs",
      Math.abs(ret(seam) - cret(seam)) < 1e-6,
    );
    // A failed rebase leaves everything as it was (one transaction).
    const snap = JSON.stringify(rows);
    const bad = await dbDeps.rebaseAdj!(
      `asset:${R.id}`,
      new Map([[days[0], "not-a-number" as unknown as number]]),
      { adjBaseDate: "2099-01-01", adjLastEventDate: null },
    ).then(
      () => "OK",
      () => "ERR",
    );
    const after = JSON.stringify(
      await db
        .select({
          d: schema.prices.date,
          c: schema.prices.close,
          a: schema.prices.adjClose,
        })
        .from(schema.prices)
        .where(eq(schema.prices.assetId, R.id))
        .orderBy(asc(schema.prices.date)),
    );
    const [m3] = await db
      .select()
      .from(schema.priceAdjustmentMeta)
      .where(eq(schema.priceAdjustmentMeta.assetId, R.id));
    check(
      "A2 a rebase that fails mid-way changes nothing (prices and metadata)",
      bad === "ERR" && after === snap && m3?.adjBaseDate === m2?.adjBaseDate,
    );

    // ------------------------------------------------------------------ A3: optimize on total return
    await mk("TLT-ADJ", 2, { adj: true });
    await mk("TLT-NODIV", 3);
    const { a: DIV } = await mk("TLT-DIV", 4);
    await mk("TLT-GOLD", 5, { assetClass: "gold" });
    await db
      .insert(schema.dividendEvents)
      .values({
        symbol: "TLT-DIV",
        assetId: DIV.id,
        exDate: days[days.length - 60],
        dividendPerShare: 1,
        currency: "THB",
        kind: "final",
        cashOrStock: "cash",
        source: "test-local",
        sourceEventId: "tlt-1",
      } as never);
    const o = await optimizePortfolio({
      symbols: ["TLT-ADJ", "TLT-NODIV", "TLT-DIV", "TLT-GOLD"],
      returnBasis: "total_return",
      objective: "min_variance",
    } as never);
    const by =
      (o as { returnBasisByAsset?: Record<string, string> })
        .returnBasisByAsset ?? {};
    const skipped =
      (o as { skipped?: { symbol: string; reason: string }[] }).skipped ?? [];
    check(
      "A3 gold is not skipped: close_no_dividend",
      by["TLT-GOLD"] === "close_no_dividend",
      JSON.stringify(by),
    );
    check(
      "A3 stock without dividends → close_no_dividend; full adj → adj_close",
      by["TLT-NODIV"] === "close_no_dividend" && by["TLT-ADJ"] === "adj_close",
    );
    check(
      "A3 stock with a dividend but no adj_close → skipped with the reason (not silently on close)",
      !by["TLT-DIV"] &&
        skipped.some(
          (x) => x.symbol === "TLT-DIV" && /ปันผล 1 ครั้ง/.test(x.reason),
        ),
      JSON.stringify(skipped.find((x) => x.symbol === "TLT-DIV")),
    );

    // ------------------------------------------------------------------ A5: data quality
    const dq1 = await dataQualityReport();
    const row1 = dq1.adjClose.assets.find((x) => x.symbol === "TLT-DIV");
    const c1 = dq1.checks.find((c) => c.area === "ราคาปรับปันผล");
    check(
      "A5 missing adj_close → warn listing the asset with the sync command",
      c1?.status === "warn" &&
        !!row1 &&
        row1.coverage === 0 &&
        /TLT-DIV/.test(c1.message) &&
        /adjusted_close/.test(c1.message),
    );
    check(
      "A5 gold / no-dividend stocks are not required to have adj_close",
      !dq1.adjClose.assets.some(
        (x) => x.symbol === "TLT-GOLD" || x.symbol === "TLT-NODIV",
      ),
    );
    // Fill TLT-DIV's adj_close consistently with its dividend (factor steps by D / P on the ex-date).
    const dc = await db
      .select({ d: schema.prices.date, c: schema.prices.close })
      .from(schema.prices)
      .where(eq(schema.prices.assetId, DIV.id))
      .orderBy(asc(schema.prices.date));
    const ex = dc.findIndex((x) => x.d === days[days.length - 60]);
    const f = 1 - 1 / dc[ex - 1].c;
    for (const [i, x] of dc.entries())
      await db
        .update(schema.prices)
        .set({ adjClose: x.c * (i < ex ? f : 1) })
        .where(
          sql`${schema.prices.assetId} = ${DIV.id} and ${schema.prices.date} = ${x.d}`,
        );
    const dq2 = await dataQualityReport();
    const row2 = dq2.adjClose.assets.find((x) => x.symbol === "TLT-DIV");
    check(
      "A5/A4 after a consistent adj_close fill: coverage 100%, no flag",
      row2?.coverage === 1 && row2.flags.length === 0,
      JSON.stringify(row2?.flags.slice(0, 2)),
    );
    await db
      .update(schema.dividendEvents)
      .set({ dividendPerShare: 1.3 })
      .where(eq(schema.dividendEvents.symbol, "TLT-DIV"));
    const row3 = (await dataQualityReport()).adjClose.assets.find(
      (x) => x.symbol === "TLT-DIV",
    );
    check(
      "A4 recorded DPS 30% off → ADJ_DIVIDEND_MISMATCH in data quality",
      row3?.flags.some((x) => x.code === "ADJ_DIVIDEND_MISMATCH") === true,
    );

    // Deleting an asset removes its adjustment metadata (FK cascade).
    await changeAssetLifecycle({
      assetId: R.id,
      action: "delete",
      confirmSymbol: "TLT-R",
      cascade: true,
    });
    const left = await db
      .select()
      .from(schema.priceAdjustmentMeta)
      .where(eq(schema.priceAdjustmentMeta.assetId, R.id));
    check("cascade delete removes price_adjustment_meta", left.length === 0);

    check(
      "other assets' prices byte-identical",
      (await othersHash()) === before,
    );
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
