/**
 * Demo data: a small THB portfolio with synthetic daily prices so the
 * dashboard and analytics have something to show.
 *   npm run db:seed            # only if the database is empty
 *   npm run db:seed -- --reset # wipe everything first
 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { getDb, schema } from "./index";
import { DEFAULT_DCF, dcf } from "../lib/finance/valuation";

const db = getDb();
const reset = process.argv.includes("--reset");

const [{ count }] = await db.execute<{ count: number }>(sql`select count(*)::int as count from assets`);
if (count > 0 && !reset) {
  console.log("Database already has data — pass --reset to wipe it and load demo data.");
  process.exit(0);
}
if (reset) {
  await db.execute(
    sql`truncate valuations, advisor_threads, transactions, notes, prices, benchmark_prices, fx_rates, allocation_targets, settings, assets restart identity cascade`,
  );
}

// Deterministic pseudo-random normal numbers.
let s = 7;
const rand = () => ((s = (s * 1664525 + 1013904223) % 4294967296), s / 4294967296);
const normal = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());

const DAYS = 520;
const dates: string[] = [];
for (let d = new Date(); dates.length < DAYS; d = new Date(d.getTime() - 86_400_000)) {
  if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) dates.unshift(d.toISOString().slice(0, 10));
}

/** Market factor shared by Thai equities (one-factor model so beta is meaningful). */
const market = dates.map(() => normal());
function path(start: number, annualMu: number, annualSigma: number, betaToMarket: number) {
  const dt = 1 / 252;
  let p = start;
  return dates.map((_, i) => {
    const idio = Math.sqrt(Math.max(0, 1 - betaToMarket ** 2)) * normal();
    const shock = betaToMarket * market[i] + idio;
    p *= Math.exp((annualMu - 0.5 * annualSigma ** 2) * dt + annualSigma * Math.sqrt(dt) * shock);
    return Math.round(p * 100) / 100;
  });
}

const assets = await db
  .insert(schema.assets)
  .values([
    { symbol: "PTT", name: "PTT Public Company", assetClass: "thai_stock", currency: "THB", priceSource: "yahoo", providerSymbol: "PTT.BK" },
    { symbol: "CPALL", name: "CP ALL", assetClass: "thai_stock", currency: "THB", priceSource: "yahoo", providerSymbol: "CPALL.BK" },
    { symbol: "AAPL", name: "Apple Inc.", assetClass: "us_stock", currency: "USD", priceSource: "yahoo", providerSymbol: "AAPL" },
    { symbol: "GOLD", name: "Thai gold bar 96.5%", assetClass: "gold", currency: "THB", priceSource: "yahoo", providerSymbol: "GOLD_TH" },
    { symbol: "K-FIXED", name: "K Fixed Income Fund", assetClass: "fund", currency: "THB", priceSource: "manual" },
    { symbol: "LB29DA", name: "Thai Government Bond 2029", assetClass: "bond", currency: "THB", priceSource: "manual", couponRate: 2.4, maturityDate: "2029-12-17", faceValue: 1000 },
  ])
  .returning();
const id = Object.fromEntries(assets.map((a) => [a.symbol, a.id]));

const series: Record<string, number[]> = {
  PTT: path(34, 0.06, 0.22, 0.75),
  CPALL: path(60, 0.09, 0.25, 0.7),
  AAPL: path(170, 0.14, 0.28, 0.3),
  GOLD: path(33000, 0.1, 0.14, -0.05),
  "K-FIXED": path(12.5, 0.025, 0.02, 0),
  LB29DA: path(1000, -0.005, 0.025, -0.1),
};
const setIndex = path(1450, 0.04, 0.16, 1);
const fx = path(35.5, 0, 0.06, -0.2);

const priceRows = Object.entries(series).flatMap(([sym, closes]) =>
  closes.map((close, i) => ({ assetId: id[sym], date: dates[i], close })),
);
for (let i = 0; i < priceRows.length; i += 1000) await db.insert(schema.prices).values(priceRows.slice(i, i + 1000));
await db.insert(schema.benchmarkPrices).values(dates.map((date, i) => ({ symbol: "^SET.BK", date, close: setIndex[i] })));
await db.insert(schema.fxRates).values(dates.map((date, i) => ({ pair: "USDTHB", date, rate: fx[i] })));

const at = (sym: string, i: number) => series[sym][i];
const [n1, n2, n3] = await db
  .insert(schema.notes)
  .values([
    {
      date: dates[5],
      title: "Core allocation plan",
      body: "Target **60/25/15** risk assets / fixed income / gold.\n\n- Thai dividend stocks for income\n- US tech for growth\n- Gold as a hedge vs. THB weakness",
      type: "thesis",
      tags: ["allocation", "plan"],
      conviction: 4,
      source: "web",
    },
    {
      date: dates[10],
      title: "PTT: cheap vs. book, dividend yield ~6%",
      body: "P/BV < 1, oil price stabilising. **Risk:** government price caps. Exit if dividend is cut.",
      type: "idea",
      tags: ["dividend", "energy"],
      assetIds: [id.PTT],
      conviction: 3,
      source: "claude",
    },
    {
      date: dates[200],
      title: "Took partial profit on AAPL",
      body: "Position grew above 20% of portfolio — trimmed back toward target weight.",
      type: "review",
      tags: ["rebalance"],
      assetIds: [id.AAPL],
      conviction: 3,
      source: "chatgpt",
    },
  ])
  .returning();
await db.insert(schema.notes).values({
  date: dates[400],
  title: "Lesson: don't chase after earnings gaps",
  body: "Bought CPALL after a gap-up and gave back the gain within two weeks. Wait for a pullback.",
  type: "lesson",
  tags: ["behavior"],
  assetIds: [id.CPALL],
  source: "web",
});

const tx = (i: number, sym: string | null, type: schema.TxType, quantity: number, price: number, extra: Partial<typeof schema.transactions.$inferInsert> = {}) => ({
  date: dates[i],
  assetId: sym ? id[sym] : null,
  type,
  quantity,
  price,
  fee: type === "buy" || type === "sell" ? Math.round(quantity * price * 0.0017 * 100) / 100 : 0,
  fxRate: sym === "AAPL" ? fx[i] : 1,
  ...extra,
});

await db.insert(schema.transactions).values([
  tx(6, null, "deposit", 0, 2_200_000),
  tx(11, "PTT", "buy", 3000, at("PTT", 11), { noteId: n2.id }),
  tx(12, "CPALL", "buy", 1500, at("CPALL", 12)),
  tx(12, "AAPL", "buy", 300, at("AAPL", 12)),
  tx(13, "GOLD", "buy", 2, at("GOLD", 13), { noteId: n1.id }),
  tx(14, "K-FIXED", "buy", 6000, at("K-FIXED", 14)),
  tx(15, "LB29DA", "buy", 50, at("LB29DA", 15)),
  tx(120, "PTT", "dividend", 0, 3000 * 1.0),
  tx(150, null, "deposit", 0, 100_000),
  tx(151, "CPALL", "buy", 500, at("CPALL", 151)),
  tx(170, "LB29DA", "coupon", 0, 50 * 1000 * 0.012),
  tx(201, "AAPL", "sell", 60, at("AAPL", 201), { noteId: n3.id }),
  tx(240, "PTT", "dividend", 0, 3000 * 0.9),
  tx(300, "GOLD", "buy", 1, at("GOLD", 300)),
  tx(350, "LB29DA", "coupon", 0, 50 * 1000 * 0.012),
  tx(401, "CPALL", "buy", 300, at("CPALL", 401)),
  tx(450, "K-FIXED", "buy", 4000, at("K-FIXED", 450)),
]);

await db.insert(schema.allocationTargets).values([
  { assetClass: "thai_stock", targetPct: 35 },
  { assetClass: "us_stock", targetPct: 20 },
  { assetClass: "bond", targetPct: 15 },
  { assetClass: "fund", targetPct: 15 },
  { assetClass: "gold", targetPct: 10 },
  { assetClass: "cash", targetPct: 5 },
]);
await db.insert(schema.settings).values({ id: 1, riskFreeRate: 1.9, benchmarkSymbol: "^SET.BK", equityRiskPremium: 6.5 });

// A sample DCF so the valuation page has something to open (THB million, million shares).
const pttPrice = series.PTT[series.PTT.length - 1];
const dcfAssumptions = {
  ...DEFAULT_DCF,
  revenue0: 3_100_000,
  years: 5,
  growthStart: 0.03,
  growthEnd: 0.02,
  terminalGrowth: 0.015,
  ebitMarginStart: 0.05,
  ebitMarginEnd: 0.053,
  taxRate: 0.22,
  daPct: 0.04,
  capexPct: 0.05,
  nwcPct: 0.03,
  debt: 1_100_000,
  cash: 450_000,
  otherClaims: 380_000,
  sharesOutstanding: 28_563,
  currentPrice: pttPrice,
  riskFree: 0.019,
  beta: 1.1,
  equityRiskPremium: 0.065,
  costOfDebt: 0.035,
  targetDebtWeight: 0.4,
};
const r = dcf(dcfAssumptions, "fcff");
await db.insert(schema.valuations).values({
  assetId: id.PTT,
  symbol: "PTT",
  date: dates[dates.length - 1],
  method: "dcf_fcff",
  title: "Base case (ตัวอย่าง)",
  assumptions: dcfAssumptions,
  result: { value: r.valuePerShare, price: pttPrice, upside: r.upside },
  intrinsicValue: r.valuePerShare,
  priceAtValuation: pttPrice,
  note: "ตัวเลขตัวอย่างเพื่อสาธิต — แก้ไขให้ตรงกับงบการเงินล่าสุด",
});

console.log(`Seeded ${assets.length} assets, ${priceRows.length} prices, ${dates.length} days.`);
process.exit(0);
