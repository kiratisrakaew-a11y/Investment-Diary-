import { describe, expect, it } from "vitest";
import { decideLifecycle, dependencySummary, type LifecycleState } from "./asset-lifecycle";

const none = { transactions: 0, prices: 0, valuations: 0, financialStatements: 0, statementUploads: 0, dividendEvents: 0, notes: 0, customMetrics: 0 };
const base: LifecycleState = { exists: true, symbol: "AP", hiddenAt: null, archivedAt: null, heldQuantity: 0, dependencies: none };
const now = new Date("2026-10-27T00:00:00Z");

describe("PR9 asset lifecycle decisions", () => {
  it("hide → restore round trip; repeats are idempotent (no write)", () => {
    const h = decideLifecycle("hide", base, { now });
    expect(h).toMatchObject({ status: "HIDDEN", change: { hiddenInHoldingsAt: now } });
    const again = decideLifecycle("hide", { ...base, hiddenAt: now }, { now });
    expect(again).toMatchObject({ status: "HIDDEN", unchanged: true });
    expect(again.change).toBeUndefined();
    expect(decideLifecycle("unhide", { ...base, hiddenAt: now })).toMatchObject({ status: "RESTORED", change: { hiddenInHoldingsAt: null } });
    expect(decideLifecycle("unhide", base)).toMatchObject({ status: "RESTORED", unchanged: true });
  });
  it("a held position cannot be hidden, archived or deleted", () => {
    const held = { ...base, heldQuantity: 100 };
    expect(decideLifecycle("hide", held).status).toBe("FORBIDDEN");
    expect(decideLifecycle("archive", held).status).toBe("FORBIDDEN");
    expect(decideLifecycle("delete", held, { confirmSymbol: "AP" }).status).toBe("BLOCKED_HAS_DEPENDENCIES");
  });
  it("archive / unarchive are reversible and idempotent", () => {
    expect(decideLifecycle("archive", base, { now })).toMatchObject({ status: "ARCHIVED", change: { archivedAt: now } });
    expect(decideLifecycle("archive", { ...base, archivedAt: now })).toMatchObject({ status: "ARCHIVED", unchanged: true });
    expect(decideLifecycle("unarchive", { ...base, archivedAt: now })).toMatchObject({ status: "RESTORED", change: { archivedAt: null } });
  });
  it("delete needs the exact symbol typed (case-insensitive) — no single-click delete", () => {
    expect(decideLifecycle("delete", base).status).toBe("FORBIDDEN");
    expect(decideLifecycle("delete", base, { confirmSymbol: "AQ" }).status).toBe("FORBIDDEN");
    expect(decideLifecycle("delete", base, { confirmSymbol: " ap " })).toMatchObject({ status: "DELETED", change: { delete: true } });
  });
  it("any dependency blocks delete with sanitized counts and suggests hide / archive (never cascades)", () => {
    const d = decideLifecycle("delete", { ...base, dependencies: { ...none, valuations: 3, transactions: 2 } }, { confirmSymbol: "AP" });
    expect(d.status).toBe("BLOCKED_HAS_DEPENDENCIES");
    expect(d.change).toBeUndefined();
    expect(d.dependencies).toEqual({ valuations: 3, transactions: 2 });
    expect(d.message).toMatch(/ซ่อน.*เก็บถาวร/);
    expect(dependencySummary({ ...none, prices: 520 }).text).toBe("ราคาย้อนหลัง 520");
  });
  it("custom metrics alone block a permanent delete (spec test 11)", () => {
    const d = decideLifecycle("delete", { ...base, dependencies: { ...none, customMetrics: 2 } }, { confirmSymbol: "AP" });
    expect(d.status).toBe("BLOCKED_HAS_DEPENDENCIES");
    expect(d.message).toMatch(/ตัวชี้วัดที่ติดตาม 2/);
    expect(decideLifecycle("hide", { ...base, dependencies: { ...none, customMetrics: 2 } }, { now }).status).toBe("HIDDEN");
  });
  it("unknown id → NOT_FOUND", () => {
    expect(decideLifecycle("hide", { ...base, exists: false }).status).toBe("NOT_FOUND");
  });
  it("web delete with cascade: held or referenced assets are deleted once the symbol is typed", () => {
    const busy = { ...base, heldQuantity: 100, dependencies: { ...none, transactions: 12, prices: 800, notes: 2, customMetrics: 1 } };
    const d = decideLifecycle("delete", busy, { confirmSymbol: "ap", cascade: true });
    expect(d).toMatchObject({ status: "DELETED", change: { delete: true }, dependencies: { transactions: 12, prices: 800, notes: 2, customMetrics: 1 } });
    expect(d.message).toMatch(/รายการซื้อขาย 12/);
    expect(d.message).toMatch(/บันทึก 2 รายการถูกตัดการผูก/);
    expect(d.message).not.toMatch(/พร้อม.*บันทึก 2 ·/);
    // The typed symbol is still required.
    expect(decideLifecycle("delete", busy, { confirmSymbol: "AQ", cascade: true }).status).toBe("FORBIDDEN");
    expect(decideLifecycle("delete", busy, { cascade: true }).status).toBe("FORBIDDEN");
    // Without cascade (REST / MCP) the old guard is unchanged.
    expect(decideLifecycle("delete", busy, { confirmSymbol: "AP" }).status).toBe("BLOCKED_HAS_DEPENDENCIES");
  });
});
