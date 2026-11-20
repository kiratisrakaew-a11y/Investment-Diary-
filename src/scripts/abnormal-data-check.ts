/**
 * Abnormal trading — phase 1 data layer on the real (local) database: volume via sync (stubbed Yahoo)
 * and import, benchmark import (TRI), shares outstanding as-of, events (incl. XD from dividend data),
 * cascade delete / rename. Existing prices must be byte-identical. Uses TEST-LOCAL symbols TLA-* only.
 * Run: npm run check:abnormal-data
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import { and, eq, like, sql } from "drizzle-orm";
import { getDb, schema } from "../db";
import {
  dbDeps,
  importPrices,
  syncHistoricalPrices,
  type SyncDeps,
} from "../server/services/price-sync";
import {
  listEvents,
  recordEvent,
  setSharesOutstanding,
  sharesAsOf,
} from "../server/services/stock-data";
import { editAssetBasics } from "../server/services/assets";
import {
  assetDependencies,
  changeAssetLifecycle,
} from "../server/services/asset-lifecycle";

const db = getDb();
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`,
  );
};
const pricesHash = async (where = sql`true`) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        await db
          .select({
            a: schema.prices.assetId,
            d: schema.prices.date,
            c: schema.prices.close,
            j: schema.prices.adjClose,
          })
          .from(schema.prices)
          .where(where)
          .orderBy(schema.prices.assetId, schema.prices.date),
      ),
    )
    .digest("hex");

async function cleanup() {
  const ids = (
    await db
      .select({ id: schema.assets.id })
      .from(schema.assets)
      .where(like(schema.assets.symbol, "TLA-%"))
  ).map((r) => r.id);
  for (const id of ids) {
    await db.delete(schema.prices).where(eq(schema.prices.assetId, id));
    await db.delete(schema.assets).where(eq(schema.assets.id, id));
  }
  await db
    .delete(schema.benchmarkPrices)
    .where(like(schema.benchmarkPrices.symbol, "TLA-%"));
  await db
    .delete(schema.stockEvents)
    .where(like(schema.stockEvents.symbol, "TLA-%"));
  await db
    .delete(schema.sharesOutstanding)
    .where(like(schema.sharesOutstanding.symbol, "TLA-%"));
  await db
    .delete(schema.dividendEvents)
    .where(like(schema.dividendEvents.symbol, "TLA-%"));
  await db
    .delete(schema.assetLifecycleEvents)
    .where(like(schema.assetLifecycleEvents.symbol, "TLA-%"));
  return ids.length;
}

const day = (i: number) =>
  new Date(Date.UTC(2026, 0, 5) + i * 86_400_000).toISOString().slice(0, 10);

async function main() {
  await cleanup();
  const othersBefore = await pricesHash(
    sql`${schema.prices.assetId} not in (select id from assets where symbol like 'TLA-%')`,
  );
  try {
    const [a] = await db
      .insert(schema.assets)
      .values({
        symbol: "TLA-PX",
        name: "TEST-LOCAL abnormal (sample)",
        assetClass: "thai_stock",
        priceSource: "yahoo",
        providerSymbol: "TLA-PX.BK",
      })
      .returning();
    // Stored prices for days 0–4 without volume (as before this feature).
    await db
      .insert(schema.prices)
      .values(
        [0, 1, 2, 3, 4].map((i) => ({
          assetId: a.id,
          date: day(i),
          close: 10 + i,
        })),
      );
    const ownBefore = await pricesHash(eq(schema.prices.assetId, a.id));

    // Provider: days 0–6 with volume; day 2 close differs (must be kept), day 3 volume 0 (no trading).
    const provider = [0, 1, 2, 3, 4, 5, 6].map((i) => ({
      date: day(i),
      close: i === 2 ? 99 : 10 + i,
      adjClose: null,
      volume: i === 3 ? 0 : 1000 * (i + 1),
    }));
    const deps: SyncDeps = {
      ...dbDeps,
      today: () => day(10),
      fetchHistory: async () => ({ rows: provider, splits: [], dividends: [] }),
    };
    const dry = await syncHistoricalPrices(
      {
        symbols: ["TLA-PX"],
        startDate: day(0),
        endDate: day(6),
        dryRun: true,
        includeBenchmark: false,
        includeFx: false,
      },
      deps,
    );
    const dryVol = await db
      .select()
      .from(schema.prices)
      .where(
        and(
          eq(schema.prices.assetId, a.id),
          sql`${schema.prices.volume} is not null`,
        ),
      );
    check(
      "dry run reports volume fills and writes nothing",
      dry.results[0].volumeFilled === 5 &&
        dry.results[0].inserted === 2 &&
        dryVol.length === 0 &&
        (await pricesHash(eq(schema.prices.assetId, a.id))) === ownBefore,
    );

    const r1 = await syncHistoricalPrices(
      {
        symbols: ["TLA-PX"],
        startDate: day(0),
        endDate: day(6),
        includeBenchmark: false,
        includeFx: false,
      },
      deps,
    );
    const rows = await db
      .select()
      .from(schema.prices)
      .where(eq(schema.prices.assetId, a.id))
      .orderBy(schema.prices.date);
    check(
      "sync fills volume on stored rows and inserts new dates with volume",
      r1.results[0].volumeFilled === 5 &&
        r1.results[0].inserted === 2 &&
        rows.map((r) => r.volume).join() === "1000,2000,3000,0,5000,6000,7000",
      rows.map((r) => r.volume).join(),
    );
    check(
      "stored prices unchanged (day 2 keeps 12, not the provider's 99)",
      rows.find((r) => r.date === day(2))!.close === 12 &&
        (await pricesHash(
          sql`${schema.prices.assetId} = ${a.id} and ${schema.prices.date} <= ${day(4)}`,
        )) === ownBefore,
    );

    // A second sync with different volumes never replaces a stored volume.
    const deps2: SyncDeps = {
      ...deps,
      fetchHistory: async () => ({
        rows: provider.map((p) => ({ ...p, volume: 777 })),
        splits: [],
        dividends: [],
      }),
    };
    const r2 = await syncHistoricalPrices(
      {
        symbols: ["TLA-PX"],
        startDate: day(0),
        endDate: day(6),
        includeBenchmark: false,
        includeFx: false,
      },
      deps2,
    );
    const rows2 = await db
      .select({ v: schema.prices.volume })
      .from(schema.prices)
      .where(eq(schema.prices.assetId, a.id))
      .orderBy(schema.prices.date);
    check(
      "stored volume is never replaced",
      r2.results[0].volumeFilled === 0 &&
        rows2.map((r) => r.v).join() === "1000,2000,3000,0,5000,6000,7000",
    );

    // MPT_FIX_SPEC P0-A1 on the real write path: adjusted_close sync fills adj_close on stored rows, close untouched.
    const closesBefore = (
      await db
        .select({ c: schema.prices.close })
        .from(schema.prices)
        .where(eq(schema.prices.assetId, a.id))
        .orderBy(schema.prices.date)
    )
      .map((r) => r.c)
      .join();
    const depsAdj: SyncDeps = {
      ...deps,
      fetchHistory: async () => ({
        rows: provider.map((p) => ({ ...p, adjClose: p.close * 0.9 })),
        splits: [],
        dividends: [],
      }),
    };
    const ra = await syncHistoricalPrices(
      {
        symbols: ["TLA-PX"],
        startDate: day(0),
        endDate: day(6),
        priceType: "adjusted_close",
        includeBenchmark: false,
        includeFx: false,
      },
      depsAdj,
    );
    const adjRows = await db
      .select({ c: schema.prices.close, j: schema.prices.adjClose })
      .from(schema.prices)
      .where(eq(schema.prices.assetId, a.id))
      .orderBy(schema.prices.date);
    check(
      "P0-A1: adjusted_close sync fills adj_close on every stored row, close unchanged, coverage 100%",
      adjRows.every((r) => r.j != null) &&
        adjRows.map((r) => r.c).join() === closesBefore &&
        ra.results[0].adjCloseFilled === 7 &&
        ra.results[0].adjCloseCoverage?.ratio === 1,
      JSON.stringify({
        filled: ra.results[0].adjCloseFilled,
        cov: ra.results[0].adjCloseCoverage,
      }),
    );

    // Import: rows with volume for a new date; CSV with a volume column; benchmark (TRI) target.
    const imp = await importPrices(
      { rows: [{ symbol: "tla-px", date: day(7), close: 18, volume: 4200 }] },
      { ...dbDeps, today: () => day(10) },
    );
    const d7 = await db
      .select()
      .from(schema.prices)
      .where(
        and(eq(schema.prices.assetId, a.id), eq(schema.prices.date, day(7))),
      );
    check(
      "import rows store volume",
      imp.results[0].inserted === 1 && d7[0]?.volume === 4200,
    );
    const csv = await importPrices(
      { csv: `Date,Close,Volume\n${day(8)},19,"8,800"`, symbol: "TLA-PX" },
      { ...dbDeps, today: () => day(10) },
    );
    const d8 = await db
      .select()
      .from(schema.prices)
      .where(
        and(eq(schema.prices.assetId, a.id), eq(schema.prices.date, day(8))),
      );
    check(
      "import CSV volume column",
      csv.results[0].inserted === 1 && d8[0]?.volume === 8800,
    );
    const unknown = await importPrices(
      { rows: [{ symbol: "TLA-TRI", date: day(1), close: 1000 }] },
      { ...dbDeps, today: () => day(10) },
    );
    check(
      "index symbol as asset → unknown with a hint to use target benchmark",
      unknown.results[0].status === "unknown_asset" &&
        /target: "benchmark"/.test(unknown.results[0].message ?? ""),
    );
    const tri = await importPrices(
      {
        rows: [0, 1, 2].map((i) => ({
          symbol: "TLA-TRI",
          date: day(i),
          close: 1000 + i,
          volume: 5,
        })),
        target: "benchmark",
      },
      { ...dbDeps, today: () => day(10) },
    );
    const triRows = await db
      .select()
      .from(schema.benchmarkPrices)
      .where(eq(schema.benchmarkPrices.symbol, "TLA-TRI"));
    check(
      "benchmark import (TRI) stores the index series; volume ignored with a warning",
      tri.target === "benchmark" &&
        tri.results[0].inserted === 3 &&
        triRows.length === 3 &&
        tri.results[0].warnings.some((w) => /volume/.test(w)),
    );
    const tri2 = await importPrices(
      {
        rows: [{ symbol: "TLA-TRI", date: day(0), close: 5555 }],
        target: "benchmark",
      },
      { ...dbDeps, today: () => day(10) },
    );
    const tri0 = await db
      .select()
      .from(schema.benchmarkPrices)
      .where(
        and(
          eq(schema.benchmarkPrices.symbol, "TLA-TRI"),
          eq(schema.benchmarkPrices.date, day(0)),
        ),
      );
    check(
      "benchmark import keeps stored values unless overwriteExisting",
      tri2.results[0].inserted === 0 && tri0[0].close === 1000,
    );

    // Shares outstanding: value effective on each date, none before the first, future refused.
    await setSharesOutstanding({
      symbol: "TLA-PX",
      effectiveDate: day(0),
      shares: 1_000_000,
      source: "sample",
    });
    await setSharesOutstanding({
      symbol: "tla-px",
      effectiveDate: day(5),
      shares: 1_200_000,
      source: "sample (capital increase)",
    });
    const s4 = await sharesAsOf("TLA-PX", day(4));
    const s6 = await sharesAsOf("TLA-PX", day(6));
    const sBefore = await sharesAsOf("TLA-PX", "2025-12-31");
    const sNone = await sharesAsOf("TLA-NONE", day(4));
    check(
      "shares as of a date",
      s4.shares === 1_000_000 &&
        s6.shares === 1_200_000 &&
        sBefore.shares === null &&
        sNone.shares === null &&
        "reason" in sNone &&
        /ยังไม่ได้บันทึก/.test(sNone.reason),
    );
    const fut = await setSharesOutstanding({
      symbol: "TLA-PX",
      effectiveDate: "2999-01-01",
      shares: 1,
      source: "x",
    }).then(
      () => "OK",
      (e: Error & { code?: string }) => e.code,
    );
    check("future effective date refused", fut === "VALIDATION_ERROR");

    // Events: recorded + XD from dividend_events (read-only, not duplicated when also recorded).
    await recordEvent({
      symbol: "TLA-PX",
      eventDate: day(6),
      eventType: "news",
      description: "sample news",
      source: "sample",
    });
    await db
      .insert(schema.dividendEvents)
      .values({
        symbol: "TLA-PX",
        exDate: day(3),
        dividendPerShare: 0.2,
        source: "test-local",
        sourceEventId: "tla-xd-1",
      } as never);
    const ev = await listEvents({ symbol: "tla-px" });
    check(
      "events list includes recorded and XD from dividend data",
      ev.length === 2 &&
        ev[0].eventType === "news" &&
        ev[1].eventType === "xd" &&
        ev[1].origin === "dividend_events",
    );
    await recordEvent({
      symbol: "TLA-PX",
      eventDate: day(3),
      eventType: "xd",
      description: "recorded XD",
    });
    const ev2 = await listEvents({ symbol: "TLA-PX", types: ["xd"] });
    check(
      "a recorded XD on the same date replaces the dividend-data one (no duplicate)",
      ev2.length === 1 && ev2[0].origin === "stock_events",
    );

    // Rename carries the new rows; delete (cascade) removes them.
    await editAssetBasics(a.id, {
      symbol: "TLA-PX2",
      name: a.name,
      assetClass: "thai_stock",
      currency: "THB",
      priceSource: "yahoo",
      providerSymbol: "TLA-PX.BK",
    });
    const moved =
      (
        await db
          .select()
          .from(schema.stockEvents)
          .where(eq(schema.stockEvents.symbol, "TLA-PX2"))
      ).length +
      (
        await db
          .select()
          .from(schema.sharesOutstanding)
          .where(eq(schema.sharesOutstanding.symbol, "TLA-PX2"))
      ).length;
    check("rename moves events and shares outstanding", moved === 4);
    const deps3 = await assetDependencies(a.id);
    check(
      "dependency counts include the new tables",
      deps3?.stockEvents === 2 && deps3?.sharesOutstanding === 2,
    );
    const del = await changeAssetLifecycle({
      assetId: a.id,
      action: "delete",
      confirmSymbol: "TLA-PX2",
      cascade: true,
    });
    const left =
      (
        await db
          .select()
          .from(schema.stockEvents)
          .where(like(schema.stockEvents.symbol, "TLA-PX%"))
      ).length +
      (
        await db
          .select()
          .from(schema.sharesOutstanding)
          .where(like(schema.sharesOutstanding.symbol, "TLA-PX%"))
      ).length;
    check(
      "cascade delete removes events and shares outstanding",
      del.status === "DELETED" && left === 0,
    );

    check(
      "other assets' prices byte-identical",
      (await pricesHash(
        sql`${schema.prices.assetId} not in (select id from assets where symbol like 'TLA-%')`,
      )) === othersBefore,
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
