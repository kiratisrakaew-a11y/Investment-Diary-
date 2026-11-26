/**
 * spec-lookback-window acceptance on the real local database (TEST-LOCAL PBW-* data, always removed; other
 * prices must stay byte-identical). Run: npm run check:window
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";
import { getDb, schema } from "../db";
import { expectedReturnsDetailed, loadUniverse, optimizePortfolio, previewOptimizeWindow } from "../server/services/optimizer";
import { getMptAnalysis } from "../server/services/portfolio";
import { WindowError } from "../lib/finance/window";
import { windowChecksLater } from "./window-check-later";

const db = getDb();
let failures = 0;
export const check = (name: string, ok: boolean, detail = "") => {
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
          .where(sql`${schema.prices.assetId} not in (select id from assets where symbol like 'PBW-%')`)
          .orderBy(schema.prices.assetId, schema.prices.date),
      ),
    )
    .digest("hex");

async function cleanup() {
  const ids = (await db.select({ id: schema.assets.id }).from(schema.assets).where(like(schema.assets.symbol, "PBW-%"))).map((r) => r.id);
  for (const id of ids) {
    await db.delete(schema.prices).where(eq(schema.prices.assetId, id));
    await db.delete(schema.transactions).where(eq(schema.transactions.assetId, id));
    await db.delete(schema.assets).where(eq(schema.assets.id, id));
  }
  await db.delete(schema.transactions).where(like(schema.transactions.memo, "PBW-%"));
  await db.delete(schema.valuations).where(like(schema.valuations.symbol, "PBW-%"));
  return ids.length;
}

const err = async (f: () => Promise<unknown>) => {
  try {
    await f();
    return null;
  } catch (e) {
    return e instanceof WindowError ? e.code : String(e);
  }
};

async function main() {
  await cleanup();
  const before = await othersHash();
  try {
    const [{ last }] = (await db.execute(sql`select max(date)::text as last from prices`)) as unknown as { last: string }[];
    // Business days for 11 years back from the last stored date (TEST-LOCAL, THB, Thai market).
    const days: string[] = [];
    for (let t = Date.parse(`${last}T00:00:00Z`) - 11 * 366 * 86_400_000; t <= Date.parse(`${last}T00:00:00Z`); t += 86_400_000) {
      const d = new Date(t);
      if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) days.push(d.toISOString().slice(0, 10));
    }
    const mk = async (symbol: string, k: number, fromIdx = 0) => {
      const [a] = await db
        .insert(schema.assets)
        .values({ symbol, name: `TEST-LOCAL ${symbol} (sample)`, assetClass: "thai_stock", priceSource: "manual", sector: `S${k}` })
        .returning();
      let v = 20 + k * 5;
      let s = 7 + k;
      const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647 - 0.5;
      const rows = days.map((d) => ({ date: d, close: (v *= 1 + 0.0002 * k + rnd() * 0.025) }));
      for (let i = fromIdx; i < rows.length; i += 2000)
        await db.insert(schema.prices).values(rows.slice(i, Math.min(rows.length, i + 2000)).map((r) => ({ assetId: a.id, date: r.date, close: +r.close.toFixed(4) })));
      return a;
    };
    const A = await mk("PBW-A", 1);
    await mk("PBW-B", 2);
    await mk("PBW-C", 3);
    const ipoStart = days.length - 260; // about one year ago
    await mk("PBW-IPO", 4, ipoStart);
    const base = ["PBW-A", "PBW-B", "PBW-C"];
    const withIpo = [...base, "PBW-IPO"];

    // 1. 3y weekly, every asset has ≥ 3 years → ~156 periods, nothing limits, quality ok.
    const u1 = await loadUniverse(undefined, base, { window: { preset: "3y" }, frequency: "weekly" });
    const w1 = u1.windowInfo!;
    check(
      "1. 3y weekly with full histories → ~156 periods, limitedBy empty, quality ok",
      u1.ok && Math.abs(w1.effective!.observations - 156) <= 2 && w1.limitedBy.length === 0 && w1.quality === "ok",
      `${w1.effective?.observations} periods, ${w1.quality}`,
    );
    // 2. + a one-year listing, common → the period starts at the listing; limitedBy names it; < 50% warning.
    const u2 = await loadUniverse(undefined, withIpo, { window: { preset: "3y" }, frequency: "weekly", historyPolicy: "common" });
    const w2 = u2.windowInfo!;
    check(
      "2. a late listing shortens the period → limitedBy with its first date, < 50% warning, quality from obs/asset",
      w2.effective!.startDate >= days[ipoStart] &&
        w2.limitedBy.some((l) => l.symbol === "PBW-IPO" && l.firstDate === days[ipoStart]) &&
        w2.warnings.some((x) => x.includes("PBW-IPO") && x.includes("ใช้จริง")) &&
        w2.obsPerAsset === w2.effective!.observations / 4,
      `${w2.effective?.startDate} · ${w2.quality} · ${w2.obsPerAsset.toFixed(1)}/asset`,
    );
    // 3. drop_short → the listing is dropped and the period is back to ~156.
    const u3 = await loadUniverse(undefined, withIpo, { window: { preset: "3y" }, frequency: "weekly", historyPolicy: "drop_short" });
    check(
      "3. drop_short → listing in dropped, ~156 periods",
      u3.windowInfo!.dropped.some((d) => d.symbol === "PBW-IPO") && Math.abs(u3.windowInfo!.effective!.observations - 156) <= 2,
    );
    // 4. lookbackDays 1825 = custom 5 years; both together = WINDOW_CONFLICT.
    const endD = u1.windowInfo!.requested.endDate;
    const s5 = new Date(Date.parse(`${endD}T00:00:00Z`) - 1825 * 86_400_000).toISOString().slice(0, 10);
    const l = await optimizePortfolio({ symbols: base, lookbackDays: 1825 });
    const c = await optimizePortfolio({ symbols: base, window: { preset: "custom", startDate: s5 } });
    const strip = (o: unknown) => JSON.stringify(o, (k, v) => (k === "windowInfo" || k === "requested" ? undefined : v));
    check("4. lookbackDays 1825 == window custom 5 years", strip(l) === strip(c));
    check("4. window + lookbackDays → WINDOW_CONFLICT", (await err(() => optimizePortfolio({ symbols: base, lookbackDays: 365, window: { preset: "1y" } })) === "WINDOW_CONFLICT"));
    // 5. endDate in the past → nothing after it.
    const past = days[days.length - 330];
    const u5 = await loadUniverse(undefined, base, { window: { preset: "2y", endDate: past }, withSeries: true });
    check(
      "5. endDate in the past → effective period and every series end by then",
      u5.ok && u5.to! <= past && u5.series!.dates.every((d) => d <= past) && u5.windowInfo!.requested.endDate === past,
      `${u5.from} → ${u5.to}`,
    );
    // 5b. Black–Litterman views as of an explicit past endDate: a valuation saved after it is invisible.
    const val = (createdAt: Date) => ({
      assetId: A.id,
      symbol: "PBW-A",
      date: createdAt.toISOString().slice(0, 10),
      method: "dcf_fcff" as const,
      assumptions: {},
      result: { value: 50 },
      intrinsicValue: 50,
      createdAt,
    });
    await db.insert(schema.valuations).values(val(new Date(`${past}T00:00:00Z`)));
    const blAt = async (endDate?: string) => {
      const r = await optimizePortfolio({
        symbols: base,
        window: { preset: "2y", ...(endDate ? { endDate } : {}) },
        returnMethod: "black_litterman",
        blackLitterman: { marketWeights: { "PBW-A": 1, "PBW-B": 1, "PBW-C": 1 }, views: [], viewsFromValuations: true, valuationMaxAgeDays: 730 },
      });
      return r.ok ? ((r.blackLitterman as { valuationViews?: unknown[] } | null)?.valuationViews ?? []).length : -1;
    };
    const earlier = days[days.length - 400];
    check(
      "5. explicit past endDate → valuations saved after it are not used (BL views)",
      (await blAt(earlier)) === 0 && (await blAt(past)) === 1 && (await blAt()) === 1,
    );
    await db.delete(schema.valuations).where(eq(schema.valuations.symbol, "PBW-A"));

    // 6. INVALID_WINDOW.
    check(
      "6. start after end / future end → INVALID_WINDOW",
      (await err(() => optimizePortfolio({ symbols: base, window: { preset: "custom", startDate: "2026-01-01", endDate: "2025-01-01" } }))) === "INVALID_WINDOW" &&
        (await err(() => optimizePortfolio({ symbols: base, window: { preset: "1y", endDate: "2099-01-01" } }))) === "INVALID_WINDOW",
    );
    // 7. optimize and get_portfolio_optimization report the same windowInfo for the same input (held assets).
    await db.insert(schema.transactions).values([
      { date: days[days.length - 100], assetId: null, type: "deposit", price: 30000, memo: "PBW-TEST" },
      { date: days[days.length - 100], assetId: A.id, type: "buy", quantity: 100, price: 10, memo: "PBW-TEST" },
    ]);
    const mpt = await getMptAnalysis(undefined, undefined, { window: { preset: "2y" }, frequency: "weekly" });
    const heldSyms = mpt.ok ? mpt.symbols : [];
    const opt = await previewOptimizeWindow({ symbols: [...heldSyms, ...mpt.skipped], window: { preset: "2y" }, frequency: "weekly" });
    check(
      "7. windowInfo of optimize == get_portfolio_optimization (same input)",
      mpt.ok && JSON.stringify(mpt.windowInfo) === JSON.stringify(opt.windowInfo),
      mpt.ok ? `${mpt.windowInfo?.effective?.observations} periods` : (mpt as { reason?: string }).reason,
    );
    // 8. muWindow 10y + window 3y → muYears ≈ 10, sigmaYears ≈ 3; blend weight from muYears (full 50/50).
    const u8 = await loadUniverse(undefined, base, { window: { preset: "3y", muWindow: { preset: "10y" } }, frequency: "weekly" });
    const est = expectedReturnsDetailed(u8, "blend");
    check(
      "8. muWindow 10y → muYears ≈ 10, sigmaYears ≈ 3, blend without the < 3 years note",
      Math.abs(u8.windowInfo!.muYears - 10) < 0.1 && Math.abs(u8.windowInfo!.sigmaYears - 3) < 0.1 && !est.notes.some((n) => n.includes("< 3 ปี")),
      `mu ${u8.windowInfo!.muYears.toFixed(2)} / sigma ${u8.windowInfo!.sigmaYears.toFixed(2)}`,
    );
    // 9. dryRun → windowInfo + coverage only.
    const dry = await previewOptimizeWindow({ symbols: withIpo, window: { preset: "3y" }, frequency: "weekly" });
    check(
      "9. dryRun → windowInfo + coverage (limits_window for the listing), no allocations",
      dry.dryRun && !("allocations" in dry) && dry.coverage!.find((c2) => c2.symbol === "PBW-IPO")?.status === "limits_window",
    );
    // 10. effective end ≤ the last actual price date (weekly labels are period ends).
    check(
      "10. effective.endDate ≤ last actual price date",
      u1.windowInfo!.effective!.endDate <= last && u1.to! <= last,
      `${u1.to} vs ${last}`,
    );

    await windowChecksLater(check, { days, base, withIpo, ipoStart });

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
