/**
 * PR9/PR10 integration check against the real database (self-cleaning). Covers the roadmap's regression
 * table: hide/restore, sold-out hide keeps accounting, delete blocked by dependencies, guarded delete of an
 * unused asset, held asset cannot be hidden, archived excluded from the optimizer universe while hidden is
 * not, no-short policy after lifecycle changes, archived bond keeps its history, repeated / concurrent clicks.
 * Run: npm run check:asset-lifecycle
 */
import "dotenv/config";
import { eq, inArray, like } from "drizzle-orm";
import { getDb, schema } from "../db";
import { changeAssetLifecycle } from "../server/services/asset-lifecycle";
import { editAssetBasics } from "../server/services/assets";
import { addObservation, addThresholdVersion, createMetric } from "../server/services/asset-metrics";
import { sql } from "drizzle-orm";
import { createTransaction, deleteTransaction } from "../server/services/transactions";
import { getPerformance, getPortfolioSummary } from "../server/services/portfolio";
import { loadUniverse, optimizePortfolio } from "../server/services/optimizer";
import { bondReturnInputs } from "../lib/finance/bond-returns";

const db = getDb();
let failed = 0;
const check = (name: string, ok: boolean, extra = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
};
const txIds: number[] = [];

async function makeAsset(symbol: string, cls: "thai_stock" | "bond", copyFrom?: string, extra: Record<string, unknown> = {}) {
  const [a] = await db.insert(schema.assets).values({ symbol, name: `TEST-LOCAL ${symbol}`, assetClass: cls, ...extra }).returning();
  if (copyFrom) {
    const [src] = await db.select().from(schema.assets).where(eq(schema.assets.symbol, copyFrom));
    const rows = await db.select().from(schema.prices).where(eq(schema.prices.assetId, src.id));
    if (rows.length) await db.insert(schema.prices).values(rows.map(({ id: _i, assetId: _a, ...r }) => ({ ...r, assetId: a.id })));
  }
  return a;
}

try {
  // 1. Never purchased → hide → restore; master record and prices unchanged.
  const never = await makeAsset("TLC-NEVER", "thai_stock", "PTT");
  const pricesBefore = (await db.select().from(schema.prices).where(eq(schema.prices.assetId, never.id))).length;
  const h = await changeAssetLifecycle({ assetId: never.id, action: "hide" });
  const r = await changeAssetLifecycle({ assetId: never.id, action: "unhide" });
  const after = (await db.select().from(schema.prices).where(eq(schema.prices.assetId, never.id))).length;
  const [row] = await db.select().from(schema.assets).where(eq(schema.assets.id, never.id));
  check("never purchased: hide → restore", h.status === "HIDDEN" && r.status === "RESTORED" && !row.hiddenInHoldingsAt && after === pricesBefore, `${pricesBefore} prices kept`);

  // 2. Hidden (not archived) stays an optimizer candidate; archived is excluded with a reason; restored is back.
  await changeAssetLifecycle({ assetId: never.id, action: "hide" });
  const u1 = await loadUniverse(365 * 2);
  check("hidden asset still in the optimizer universe", u1.assets.some((a) => a.symbol === "TLC-NEVER"));
  await changeAssetLifecycle({ assetId: never.id, action: "archive" });
  const u2 = await loadUniverse(365 * 2);
  check("archived asset excluded with a reason", !u2.assets.some((a) => a.symbol === "TLC-NEVER") && u2.skipped.some((s) => s.symbol === "TLC-NEVER" && s.reason.includes("เก็บถาวร")));
  const off = await optimizePortfolio({ objective: "max_sharpe", maxWeight: 1, lookbackDays: 730 });
  check("short selling OFF after archive: all weights ≥ 0", off.ok && off.allocations.every((a) => a.weight >= -1e-9));
  await changeAssetLifecycle({ assetId: never.id, action: "unarchive" });
  await changeAssetLifecycle({ assetId: never.id, action: "unhide" });
  const u3 = await loadUniverse(365 * 2);
  check("restored asset selectable again", u3.assets.some((a) => a.symbol === "TLC-NEVER"));

  // 3. Asset with dependencies → delete blocked, nothing removed.
  const blocked = await changeAssetLifecycle({ assetId: never.id, action: "delete", confirmSymbol: "TLC-NEVER" });
  const stillThere = (await db.select().from(schema.prices).where(eq(schema.prices.assetId, never.id))).length;
  check("delete with dependencies is blocked (no cascade)", blocked.status === "BLOCKED_HAS_DEPENDENCIES" && stillThere === pricesBefore, JSON.stringify(blocked.dependencies));

  // 4. Fully sold asset → hide: realized P&L, cash and TWR unchanged.
  const sold = await makeAsset("TLC-SOLD", "thai_stock", "PTT");
  const lastPrice = (await db.select().from(schema.prices).where(eq(schema.prices.assetId, sold.id))).at(-1)!;
  txIds.push((await createTransaction({ type: "deposit", date: "2026-10-01", price: 100_000, quantity: 0, fee: 0, memo: "TEST-LOCAL" } as never)).id);
  txIds.push((await createTransaction({ type: "buy", symbol: "TLC-SOLD", date: "2026-10-02", quantity: 100, price: lastPrice.close, fee: 0, memo: "TEST-LOCAL" } as never)).id);
  txIds.push((await createTransaction({ type: "sell", symbol: "TLC-SOLD", date: "2026-10-05", quantity: 100, price: lastPrice.close * 1.05, fee: 0, memo: "TEST-LOCAL" } as never)).id);
  const s1 = await getPortfolioSummary();
  const p1 = await getPerformance();
  const hs = await changeAssetLifecycle({ assetId: sold.id, action: "hide" });
  const s2 = await getPortfolioSummary();
  const p2 = await getPerformance();
  const pos = (s: typeof s1) => s.positions.find((p) => p.symbol === "TLC-SOLD");
  check(
    "sold-out hide keeps realized P&L, cash, NAV and TWR",
    hs.status === "HIDDEN" && pos(s1)!.realizedPnlThb === pos(s2)!.realizedPnlThb && s1.cashThb === s2.cashThb && s1.totalValueThb === s2.totalValueThb && JSON.stringify(p1) === JSON.stringify(p2),
    `realized ${pos(s2)!.realizedPnlThb.toFixed(2)}`,
  );

  // 5. Held asset → hide is refused; exposure unchanged.
  const held = s1.positions.find((p) => p.quantity > 0 && !p.symbol.startsWith("TLC-"))!;
  const hh = await changeAssetLifecycle({ assetId: held.assetId, action: "hide" });
  const s3 = await getPortfolioSummary();
  check(`held ${held.symbol}: hide refused, still in current portfolio`, hh.status === "FORBIDDEN" && s3.positions.some((p) => p.assetId === held.assetId && p.quantity === held.quantity));

  // 6. Unused asset → delete needs the typed symbol, then deletes only that row.
  const [bare] = await db.insert(schema.assets).values({ symbol: "TLC-BARE", name: "TEST-LOCAL bare", assetClass: "thai_stock" }).returning();
  const countBefore = (await db.select().from(schema.assets)).length;
  const noConfirm = await changeAssetLifecycle({ assetId: bare.id, action: "delete" });
  const del = await changeAssetLifecycle({ assetId: bare.id, action: "delete", confirmSymbol: "TLC-BARE" });
  const countAfter = (await db.select().from(schema.assets)).length;
  check("unused asset: no confirm → FORBIDDEN; confirmed → DELETED, exactly one row removed", noConfirm.status === "FORBIDDEN" && del.status === "DELETED" && countAfter === countBefore - 1);

  // 7. Repeated / concurrent clicks are idempotent or typed.
  const [twice] = await db.insert(schema.assets).values({ symbol: "TLC-TWICE", name: "TEST-LOCAL twice", assetClass: "thai_stock" }).returning();
  const [a, b] = await Promise.all([changeAssetLifecycle({ assetId: twice.id, action: "hide" }), changeAssetLifecycle({ assetId: twice.id, action: "hide" })]);
  const [d1, d2] = await Promise.all([
    changeAssetLifecycle({ assetId: twice.id, action: "delete", confirmSymbol: "TLC-TWICE" }),
    changeAssetLifecycle({ assetId: twice.id, action: "delete", confirmSymbol: "TLC-TWICE" }),
  ]);
  check("concurrent hide: both HIDDEN, one unchanged", a.status === "HIDDEN" && b.status === "HIDDEN" && (!!a.unchanged !== !!b.unchanged));
  check("concurrent delete: one DELETED, the other NOT_FOUND (no partial delete)", [d1.status, d2.status].sort().join() === "DELETED,NOT_FOUND");

  // 8. Archived bond keeps prices and its coupon/total-return history.
  const bond = await makeAsset("TLC-BOND", "bond", "LB29DA", { couponRate: 2.4, maturityDate: "2029-12-17", faceValue: 1000, couponFrequency: 2, dayCount: "ACT/365F" });
  const bp = (await db.select().from(schema.prices).where(eq(schema.prices.assetId, bond.id))).map((p) => ({ date: p.date, close: p.close }));
  const before = bondReturnInputs(bond, bp);
  await changeAssetLifecycle({ assetId: bond.id, action: "archive" });
  const bp2 = (await db.select().from(schema.prices).where(eq(schema.prices.assetId, bond.id))).map((p) => ({ date: p.date, close: p.close }));
  const after2 = bondReturnInputs(bond, bp2);
  check("archived bond keeps prices and coupon history", bp2.length === bp.length && before.ok && after2.ok && JSON.stringify(before.distributions) === JSON.stringify(after2.distributions), `${bp2.length} prices`);

  // 10. Web delete with cascade: a held asset with every kind of related record goes; notes stay unlinked.
  const casc = await makeAsset("TLC-CASC", "thai_stock", "PTT");
  const cp = await db.select().from(schema.prices).where(eq(schema.prices.assetId, casc.id));
  const cascTx = await createTransaction({ type: "buy", symbol: "TLC-CASC", date: "2026-10-02", quantity: 10, price: cp[cp.length - 1].close, fee: 0, memo: "TEST-LOCAL" } as never);
  await db.insert(schema.valuations).values({ assetId: casc.id, symbol: "TLC-CASC", date: "2026-10-01", method: "multiples", assumptions: {}, result: {} } as never);
  await db.insert(schema.financialStatements).values({ symbol: "tlc-casc", fiscalYear: 2025, data: {} } as never);
  await db.insert(schema.dividendEvents).values({ symbol: "TLC-CASC", assetId: casc.id, dividendPerShare: 0.5, source: "test-local", sourceEventId: "tlc-casc-1" } as never);
  await db.insert(schema.statementUploads).values({ symbol: "TLC-CASC", filename: "x.pdf", mimeType: "application/pdf", size: 1, status: "ok" });
  const [note] = await db.insert(schema.notes).values({ date: "2026-10-01", title: "TEST-LOCAL note", assetIds: [casc.id, never.id] }).returning();
  const m = await createMetric(casc.id, { name: "TLC metric", unit: "%" });
  await addObservation(casc.id, m.id, { observedOn: "2026-01-01", value: 1 });
  await addThresholdVersion(casc.id, m.id, { ruleType: "lower_is_better", effectiveFrom: "2026-01-01", greenBound: 1, yellowBound: 2 });
  const otherPrices = (await db.select({ c: sql<number>`count(*)::int` }).from(schema.prices))[0].c - cp.length;
  const noCascade = await changeAssetLifecycle({ assetId: casc.id, action: "delete", confirmSymbol: "TLC-CASC" });
  check("API / MCP delete without cascade still blocked", noCascade.status === "BLOCKED_HAS_DEPENDENCIES");
  const wrong = await changeAssetLifecycle({ assetId: casc.id, action: "delete", confirmSymbol: "TLC", cascade: true });
  check("cascade delete still needs the typed symbol", wrong.status === "FORBIDDEN");
  const gone = await changeAssetLifecycle({ assetId: casc.id, action: "delete", confirmSymbol: "tlc-casc", cascade: true, source: "web" });
  const left = async (t: typeof schema.valuations | typeof schema.financialStatements | typeof schema.dividendEvents) =>
    (await db.select({ c: sql<number>`count(*)::int` }).from(t).where(sql`upper(${t.symbol}) = 'TLC-CASC' or ${t.assetId} = ${casc.id}`))[0].c;
  const remaining = {
    asset: (await db.select().from(schema.assets).where(eq(schema.assets.id, casc.id))).length,
    tx: (await db.select().from(schema.transactions).where(eq(schema.transactions.id, cascTx.id))).length,
    prices: (await db.select().from(schema.prices).where(eq(schema.prices.assetId, casc.id))).length,
    valuations: await left(schema.valuations),
    statements: await left(schema.financialStatements),
    dividends: await left(schema.dividendEvents),
    uploads: (await db.select().from(schema.statementUploads).where(eq(schema.statementUploads.symbol, "TLC-CASC"))).length,
    metrics: (await db.select().from(schema.assetMetricDefinitions).where(eq(schema.assetMetricDefinitions.id, m.id))).length,
    observations: (await db.select().from(schema.assetMetricObservations).where(eq(schema.assetMetricObservations.metricId, m.id))).length,
    thresholds: (await db.select().from(schema.assetMetricThresholdVersions).where(eq(schema.assetMetricThresholdVersions.metricId, m.id))).length,
  };
  check("cascade delete removes the held asset and every related record", gone.status === "DELETED" && Object.values(remaining).every((v) => v === 0), JSON.stringify(remaining));
  const [noteAfter] = await db.select().from(schema.notes).where(eq(schema.notes.id, note.id));
  check("note kept, unlinked from the deleted asset only", !!noteAfter && JSON.stringify(noteAfter.assetIds) === JSON.stringify([never.id]));
  await db.delete(schema.notes).where(eq(schema.notes.id, note.id));
  const otherAfter = (await db.select({ c: sql<number>`count(*)::int` }).from(schema.prices))[0].c;
  check("other assets' prices untouched", otherAfter === otherPrices);

  // 11. Edit basics: rename (case-normalised), follow-up of symbol-keyed rows, clash refused, class change guarded.
  const ren = await makeAsset("TLC-REN", "thai_stock", "PTT");
  await db.insert(schema.valuations).values({ assetId: ren.id, symbol: "TLC-REN", date: "2026-10-01", method: "multiples", assumptions: {}, result: {} } as never);
  await db.insert(schema.financialStatements).values({ symbol: "TLC-REN", fiscalYear: 2025, data: {} } as never);
  await db.insert(schema.dividendEvents).values({ symbol: "TLC-REN", dividendPerShare: 0.5, source: "test-local", sourceEventId: "tlc-ren-1" } as never);
  const renPrices = (await db.select().from(schema.prices).where(eq(schema.prices.assetId, ren.id))).length;
  const base = { name: "TEST-LOCAL renamed", assetClass: "thai_stock" as const, currency: "THB" as const, priceSource: "yahoo" as const };
  const r1 = await editAssetBasics(ren.id, { ...base, symbol: " tlc-ren.bk ", providerSymbol: "PTT.BK" });
  const follow = async (t: typeof schema.valuations | typeof schema.financialStatements | typeof schema.dividendEvents) => (await db.select().from(t).where(eq(t.symbol, "TLC-REN.BK"))).length;
  check("rename normalises to upper case and keeps id", r1.id === ren.id && r1.symbol === "TLC-REN.BK" && r1.providerSymbol === "PTT.BK" && r1.name === "TEST-LOCAL renamed");
  check("valuations / statements / dividends follow the new symbol", (await follow(schema.valuations)) === 1 && (await follow(schema.financialStatements)) === 1 && (await follow(schema.dividendEvents)) === 1);
  check("prices stay attached after rename", (await db.select().from(schema.prices).where(eq(schema.prices.assetId, ren.id))).length === renPrices);
  const clash = await editAssetBasics(ren.id, { ...base, symbol: "TLC-NEVER" }).then(() => "OK", (e: Error) => e.message);
  check("rename onto an existing symbol refused", clash.includes("มีสินทรัพย์ symbol TLC-NEVER อยู่แล้ว"), clash);
  const cls = await editAssetBasics(ren.id, { ...base, symbol: "TLC-REN.BK", assetClass: "fund" }).then(() => "OK", (e: Error) => e.message);
  const cls2 = await editAssetBasics(ren.id, { ...base, symbol: "TLC-REN.BK", assetClass: "fund", confirmChange: true });
  check("class change with prices needs confirmation", cls.includes("ติ๊กยืนยัน") && cls2.assetClass === "fund", cls);
  const cleared = await editAssetBasics(ren.id, { ...base, symbol: "TLC-REN.BK", assetClass: "fund", providerSymbol: "" });
  check("empty price code clears it", cleared.providerSymbol === null);
  const editEv = await db.select().from(schema.assetLifecycleEvents).where(eq(schema.assetLifecycleEvents.assetId, ren.id));
  check("edits audited with before / after", editEv.filter((e) => e.action === "edit").length === 3);
  await db.delete(schema.valuations).where(eq(schema.valuations.assetId, ren.id));
  await db.delete(schema.financialStatements).where(eq(schema.financialStatements.symbol, "TLC-REN.BK"));
  await db.delete(schema.dividendEvents).where(eq(schema.dividendEvents.symbol, "TLC-REN.BK"));

  // 9. Audit trail.
  const events = await db.select().from(schema.assetLifecycleEvents).where(like(schema.assetLifecycleEvents.symbol, "TLC-%"));
  check("lifecycle events logged (incl. blocked and deleted)", events.some((e) => e.result === "BLOCKED_HAS_DEPENDENCIES") && events.some((e) => e.result === "DELETED"), `${events.length} events`);
} finally {
  for (const id of txIds) await deleteTransaction(id).catch(() => {});
  const test = await db.select({ id: schema.assets.id }).from(schema.assets).where(like(schema.assets.symbol, "TLC-%"));
  if (test.length) {
    await db.delete(schema.prices).where(inArray(schema.prices.assetId, test.map((t) => t.id)));
    await db.delete(schema.assets).where(inArray(schema.assets.id, test.map((t) => t.id)));
  }
  await db.delete(schema.assetLifecycleEvents).where(like(schema.assetLifecycleEvents.symbol, "TLC-%"));
  console.log(`cleaned up ${test.length} test assets and ${txIds.length} transactions`);
}
console.log(failed ? `${failed} FAILED` : "ALL PASSED");
process.exit(failed ? 1 : 0);
