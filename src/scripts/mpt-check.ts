/**
 * MPT_FIX_SPEC remaining items on the real local database (phases M3–M5). TEST-LOCAL symbols PBM-* only,
 * always removed; other prices must stay byte-identical. Run: npm run check:mpt
 *  M3  B2 FX gaps in data quality · B3 historyPolicy (named limiting assets, drop_short, pairwise PSD) ·
 *      B4 weekly default for mixed-market universes · P2 unclassified sector bucket.
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";
import { getDb, schema } from "../db";
import { loadUniverse, optimizePortfolio } from "../server/services/optimizer";
import { dataQualityReport } from "../server/services/data-quality";
import { covarianceDiagnostics } from "../lib/finance/mpt";
import { laterChecks } from "./mpt-check-later";

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
          .where(sql`${schema.prices.assetId} not in (select id from assets where symbol like 'PBM-%')`)
          .orderBy(schema.prices.assetId, schema.prices.date),
      ),
    )
    .digest("hex");

export async function cleanup() {
  const ids = (await db.select({ id: schema.assets.id }).from(schema.assets).where(like(schema.assets.symbol, "PBM-%"))).map((r) => r.id);
  for (const id of ids) {
    await db.delete(schema.priceAdjustmentMeta).where(eq(schema.priceAdjustmentMeta.assetId, id));
    await db.delete(schema.prices).where(eq(schema.prices.assetId, id));
    await db.delete(schema.valuations).where(sql`${schema.valuations.symbol} like 'PBM-%'`);
    await db.delete(schema.assets).where(eq(schema.assets.id, id));
  }
  await db.delete(schema.dividendEvents).where(like(schema.dividendEvents.symbol, "PBM-%"));
  await db.delete(schema.valuations).where(like(schema.valuations.symbol, "PBM-%"));
  return ids.length;
}

async function main() {
  await cleanup();
  const before = await othersHash();
  try {
    const days = (
      await db.select({ d: schema.benchmarkPrices.date }).from(schema.benchmarkPrices).where(eq(schema.benchmarkPrices.symbol, "^SET.BK")).orderBy(schema.benchmarkPrices.date)
    ).map((r) => r.d);
    if (days.length < 300) throw new Error("seed the local database first");

    // ---------------------------------------------------------------- B4 frequency
    const th = await loadUniverse(730, ["PTT", "CPALL", "GOLD"]);
    const mixed = await loadUniverse(730, ["PTT", "CPALL", "AAPL"]);
    const forced = await loadUniverse(730, ["PTT", "CPALL", "AAPL"], { frequency: "daily" });
    check("B4 Thai-market only → daily", th.frequency === "daily" && !th.covarianceWarnings.some((w) => w.includes("รายสัปดาห์อัตโนมัติ")));
    check(
      "B4 Thai + USD asset, no frequency → weekly with a note; explicit daily respected",
      mixed.frequency === "weekly" && mixed.covarianceWarnings.some((w) => w.includes("รายสัปดาห์อัตโนมัติ")) && forced.frequency === "daily",
      `${mixed.frequency} / ${forced.frequency}`,
    );

    // ---------------------------------------------------------------- B3 history policy
    const n = days.length;
    const ipoFrom = n - 150;
    const [ipo] = await db
      .insert(schema.assets)
      .values({ symbol: "PBM-IPO", name: "TEST-LOCAL PBM-IPO (sample)", assetClass: "thai_stock", priceSource: "manual", sector: "Tech" })
      .returning();
    await db.insert(schema.prices).values(days.slice(ipoFrom).map((d, i) => ({ assetId: ipo.id, date: d, close: 10 * (1 + 0.01 * Math.sin(i / 5) + 0.0005 * i) })));
    const syms = ["PTT", "CPALL", "GOLD", "PBM-IPO"];
    const common = await loadUniverse(730, syms);
    check(
      "B3 a late listing shortens the calendar → warning names it and its first date",
      common.covarianceWarnings.some((w) => w.includes("PBM-IPO") && w.includes(days[ipoFrom])) && common.from! >= days[ipoFrom],
      common.covarianceWarnings.find((w) => w.includes("PBM-IPO"))?.slice(0, 120),
    );
    const dropped = await loadUniverse(730, syms, { historyPolicy: "drop_short" });
    check(
      "B3 drop_short → longer period, the late asset listed in skipped",
      dropped.ok && dropped.from! < common.from! && dropped.skipped.some((s) => s.symbol === "PBM-IPO" && s.reason.includes("drop_short")),
      `${common.from} → ${dropped.from}`,
    );
    const pw = await loadUniverse(730, syms, { historyPolicy: "pairwise" });
    const d = covarianceDiagnostics(pw.cov);
    check(
      "B3 pairwise → covariance PSD (min eigenvalue ≥ 0); μ of long assets from their own window",
      pw.ok && d.minEigenvalue >= -1e-12 && pw.assets.find((a) => a.symbol === "PTT")!.historicalReturn !== common.assets.find((a) => a.symbol === "PTT")!.historicalReturn,
      `minEig ${d.minEigenvalue.toExponential(2)}`,
    );
    const viaOpt = await optimizePortfolio({ symbols: syms, lookbackDays: 730, historyPolicy: "drop_short" });
    check("B3 historyPolicy reaches optimize_portfolio", viaOpt.ok && viaOpt.skipped.some((s) => s.symbol === "PBM-IPO"));

    // ---------------------------------------------------------------- P2 unclassified sector bucket
    const sec = await optimizePortfolio({ symbols: ["PTT", "CPALL", "GOLD", "PBM-IPO"], lookbackDays: 120, constraints: { maxPerSector: 0.6 } });
    check(
      "P2 assets without a sector share one capped bucket (constraintsApplied ≤ cap)",
      sec.ok && sec.exposure.constraintsApplied.some((c) => c.name === "หมวด (ยังไม่ระบุ)" && c.value <= 0.6 + 1e-9),
      sec.ok ? JSON.stringify(sec.exposure.constraintsApplied.map((c) => [c.name, +c.value.toFixed(3)])) : sec.reason,
    );

    // ---------------------------------------------------------------- B2 FX gaps over the price history
    const [usd] = await db
      .insert(schema.assets)
      .values({ symbol: "PBM-USD", name: "TEST-LOCAL PBM-USD (sample)", assetClass: "us_stock", currency: "USD", priceSource: "manual" })
      .returning();
    // Prices from 30 days before the first USDTHB fixing: those dates have no rate.
    const first = Date.parse(days[0]);
    const early = Array.from({ length: 20 }, (_, i) => new Date(first - (30 - i) * 86_400_000).toISOString().slice(0, 10));
    await db.insert(schema.prices).values([...early, ...days].map((d2, i) => ({ assetId: usd.id, date: d2, close: 50 + (i % 7) })));
    const dq = await dataQualityReport();
    const fx = dq.checks.find((c) => c.area === "อัตราแลกเปลี่ยน");
    check(
      "B2 data quality scans FX over the price history (not only today's rate)",
      fx?.status === "warn" && fx.message.includes("PBM-USD") && fx.message.includes("20 วัน"),
      fx?.message.slice(0, 140),
    );
    const uUsd = await loadUniverse(800, ["PTT", "CPALL", "PBM-USD"], { frequency: "daily" });
    check(
      "B2 optimizer never forward-fills a missing USDTHB (asset skipped with the reason)",
      uUsd.skipped.some((s) => s.symbol === "PBM-USD" && /USDTHB|อัตรา/.test(s.reason)),
      uUsd.skipped.find((s) => s.symbol === "PBM-USD")?.reason,
    );

    await laterChecks(check, days);

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
