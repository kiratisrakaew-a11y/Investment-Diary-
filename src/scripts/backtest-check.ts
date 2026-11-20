/**
 * backtest_portfolio (BACKTEST_SPEC BT-1/2/3/5/9) + compare_portfolio_models on the real local database:
 * dividend payment-date assumption and uncounted dividends in warnings, benchmark basis, archived assets,
 * limiting assets / drop_short, risk-free resolver. TEST-LOCAL symbols TLB-* (and a temporary SETTRI
 * series only when none exists) are always removed. Other prices must stay byte-identical.
 * Run: npm run check:backtest
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import { asc, eq, like, sql } from "drizzle-orm";
import { getDb, schema } from "../db";
import { backtestPortfolio } from "../server/services/backtest";
import { comparePortfolioModels } from "../server/services/model-comparison";

const db = getDb();
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`,
  );
};
const errOf = async (p: Promise<unknown>) =>
  p.then(
    () => "OK",
    (e: Error) => e.message,
  );
const othersHash = async () =>
  createHash("sha256")
    .update(
      JSON.stringify(
        await db
          .select()
          .from(schema.prices)
          .where(
            sql`${schema.prices.assetId} not in (select id from assets where symbol like 'TLB-%')`,
          )
          .orderBy(schema.prices.assetId, schema.prices.date),
      ),
    )
    .digest("hex");
let addedTri = false;

async function cleanup() {
  const ids = (
    await db
      .select({ id: schema.assets.id })
      .from(schema.assets)
      .where(like(schema.assets.symbol, "TLB-%"))
  ).map((r) => r.id);
  for (const id of ids) {
    await db.delete(schema.prices).where(eq(schema.prices.assetId, id));
    await db
      .delete(schema.assetLifecycleEvents)
      .where(eq(schema.assetLifecycleEvents.assetId, id));
    await db.delete(schema.assets).where(eq(schema.assets.id, id));
  }
  await db
    .delete(schema.dividendEvents)
    .where(like(schema.dividendEvents.symbol, "TLB-%"));
  if (addedTri)
    await db
      .delete(schema.benchmarkPrices)
      .where(eq(schema.benchmarkPrices.symbol, "SETTRI"));
  return ids.length;
}

async function main() {
  await cleanup();
  const before = await othersHash();
  const triBefore = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(schema.benchmarkPrices)
    .where(eq(schema.benchmarkPrices.symbol, "SETTRI"));
  if (triBefore[0].c > 0) {
    console.log(
      "STOP  SETTRI already exists locally — this check adds and removes its own SETTRI series; not touching yours",
    );
    process.exit(1);
  }
  try {
    const bench = await db
      .select({
        date: schema.benchmarkPrices.date,
        close: schema.benchmarkPrices.close,
      })
      .from(schema.benchmarkPrices)
      .where(eq(schema.benchmarkPrices.symbol, "^SET.BK"))
      .orderBy(asc(schema.benchmarkPrices.date));
    if (bench.length < 400)
      throw new Error(
        `^SET.BK has ${bench.length} rows locally; seed the database first`,
      );
    let s = 5;
    const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647 - 0.5;
    const mk = async (symbol: string, from: number, archived = false) => {
      const [a] = await db
        .insert(schema.assets)
        .values({
          symbol,
          name: `TEST-LOCAL ${symbol} (sample)`,
          assetClass: "thai_stock",
          priceSource: "manual",
          ...(archived ? { archivedAt: new Date() } : {}),
        })
        .returning();
      let p = 30;
      await db.insert(schema.prices).values(
        bench.slice(from).map((b, i) => {
          if (i > 0)
            p *=
              1 +
              0.9 * (b.close / bench[from + i - 1].close - 1) +
              rnd() * 0.02;
          return { assetId: a.id, date: b.date, close: +p.toFixed(4) };
        }),
      );
      return a;
    };
    await mk("TLB-A", 0);
    await mk("TLB-B", 0);
    await mk("TLB-IPO", bench.length - 120);
    await mk("TLB-ARC", 0, true);
    // Dividends of TLB-A: three without a payment date (as Yahoo provides), one with a real payment date.
    const exAt = (i: number) => bench[i].date;
    const ev = (i: number, dps: number, pay: string | null, id: string) => ({
      symbol: "TLB-A",
      exDate: exAt(i),
      paymentDate: pay,
      dividendPerShare: dps,
      currency: "THB",
      kind: "final",
      cashOrStock: "cash",
      source: "test-local",
      sourceEventId: id,
    });
    await db
      .insert(schema.dividendEvents)
      .values([
        ev(300, 0.6, null, "tlb-1"),
        ev(360, 0.5, null, "tlb-2"),
        ev(420, 0.7, null, "tlb-3"),
        ev(480, 0.4, exAt(495), "tlb-4"),
      ] as never);
    const AB = ["TLB-A", "TLB-B"];

    // BT-1: omitted paymentLagDays → Settings assumption (21 days); real payment date wins.
    const r1 = await backtestPortfolio({
      strategy: "equal_weight",
      symbols: AB,
      dividendCashflows: true,
    });
    check(
      "BT-1 omitted paymentLagDays → events credited at ex-date + Settings lag, assumedPaymentDates reported",
      r1.assumedPaymentDates?.count === 3 &&
        r1.assumedPaymentDates.lagDays === 21 &&
        r1.dividends!.events === 4 &&
        r1.dividends!.uncredited.events === 0,
      JSON.stringify(r1.assumedPaymentDates),
    );
    check(
      "BT-1 the event with a real payment date is not counted as assumed",
      r1.assumedPaymentDates?.bySymbol["TLB-A"] === 3,
    );
    const r1n = await backtestPortfolio({
      strategy: "equal_weight",
      symbols: AB,
      dividendCashflows: true,
      paymentLagDays: null,
    });
    const w1 = r1n.warnings.find((w) => w.includes("ไม่ถูกนับ")) ?? "";
    check(
      "BT-1 paymentLagDays: null → not credited, warnings give count and THB value",
      r1n.dividends!.uncredited.events === 3 &&
        /3 เหตุการณ์/.test(w1) &&
        /บาท/.test(w1) &&
        r1n.dividends!.uncredited.netThb > 0,
      w1.slice(0, 160),
    );
    check(
      "BT-1 assumed payments raise the result vs not crediting",
      r1.metrics.cumulativeReturn != null &&
        r1n.metrics.cumulativeReturn != null &&
        r1.metrics.cumulativeReturn > r1n.metrics.cumulativeReturn,
    );

    // BT-2: benchmark basis.
    check(
      "BT-2 dividend cash flows without SETTRI → ^SET.BK with a basis warning",
      r1.benchmark?.basis === "price" &&
        r1.benchmark.wanted === "total_return" &&
        r1.warnings.some((w) => /basis ไม่ตรง/.test(w)),
    );
    const r2p = await backtestPortfolio({
      strategy: "equal_weight",
      symbols: AB,
    });
    check(
      "BT-2 price_return without dividends → price index, no basis warning",
      r2p.benchmark?.basis === "price" &&
        !r2p.warnings.some((w) => /basis ไม่ตรง/.test(w)),
    );
    await db
      .insert(schema.benchmarkPrices)
      .values(
        bench.map((b, i) => ({
          symbol: "SETTRI",
          date: b.date,
          close: b.close * 6 * 1.0001 ** i,
        })),
      );
    addedTri = true;
    const r2t = await backtestPortfolio({
      strategy: "equal_weight",
      symbols: AB,
      dividendCashflows: true,
    });
    check(
      "BT-2 dividend cash flows + SETTRI → benchmark.basis total_return, no basis warning",
      r2t.benchmark?.symbol === "SETTRI" &&
        r2t.benchmark.basis === "total_return" &&
        !r2t.warnings.some((w) => /basis ไม่ตรง/.test(w)),
    );

    // BT-3: archived not in the default universe; the limiting asset is named; drop_short works.
    const e3 = await errOf(
      backtestPortfolio({ strategy: "max_sharpe", windowDays: 252 }),
    );
    check(
      "BT-3 default universe: error names the IPO asset, its first date and the max windowDays",
      /TLB-IPO \(ราคาเริ่ม/.test(e3) &&
        /windowDays สูงสุดที่รันได้/.test(e3) &&
        /drop_short/.test(e3),
      e3.slice(0, 220),
    );
    const r3 = await backtestPortfolio({
      strategy: "max_sharpe",
      windowDays: 252,
      historyPolicy: "drop_short",
      maxWeight: 0.6,
    });
    check(
      "BT-3 drop_short runs and lists the IPO asset in excluded",
      r3.ok &&
        r3.excluded.some(
          (e) => e.symbol === "TLB-IPO" && /drop_short/.test(e.reason),
        ) &&
        !r3.universe.includes("TLB-IPO"),
      r3.universe.join(","),
    );
    check(
      "BT-3 archived asset is not in the default universe (listed in excluded)",
      !r3.universe.includes("TLB-ARC") &&
        r3.excluded.some((e) => e.symbol === "TLB-ARC"),
    );

    // BT-5: risk-free resolver.
    const r5 = await backtestPortfolio({
      strategy: "equal_weight",
      symbols: AB,
      riskFree: {
        source: "manual",
        manual: { rate: 0.01205, reason: "test-local sample" },
      },
    });
    check(
      "BT-5 riskFree manual 0.01205 → riskFreeInfo, cash accrual and methodology use it; no illustrative-Rf warning",
      r5.riskFreeInfo.rate === 0.01205 &&
        r5.methodology.some((m) => m.includes("Rf 1.21%")) &&
        !r5.warnings.some((w) => /ค่าตัวอย่าง/.test(w)),
    );
    check(
      "BT-5 Settings Rf without a source → warning",
      r2p.riskFreeInfo.source === "settings" &&
        r2p.warnings.some((w) => /ค่าตัวอย่าง/.test(w)),
    );
    check(
      "BT-9 limitations no longer carry the uncounted-dividend note (moved to warnings)",
      !r1n.limitations.some((l) => /ไม่ถูกนับ/.test(l)),
    );

    // Compare uses the same data loader: archived skipped, Rf / benchmark from the same helpers.
    const c = await comparePortfolioModels({
      symbols: [...AB, "TLB-ARC"],
      models: ["equal_weight", "min_variance"],
      windowDays: 120,
      riskFree: {
        source: "manual",
        manual: { rate: 0.01205, reason: "test-local" },
      },
    });
    check(
      "compare: archived skipped, riskFreeInfo manual, benchmark basis given",
      c.excluded.some((e) => e.symbol === "TLB-ARC") &&
        c.riskFreeRate === 0.01205 &&
        c.benchmark?.basis === "price",
    );

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
