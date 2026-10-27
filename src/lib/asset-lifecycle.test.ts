import { describe, expect, it } from "vitest";
import { decideLifecycle, dependencySummary, type LifecycleState } from "./asset-lifecycle";

const none = { transactions: 0, prices: 0, valuations: 0, financialStatements: 0, statementUploads: 0, dividendEvents: 0, notes: 0 };
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
  it("unknown id → NOT_FOUND", () => {
    expect(decideLifecycle("hide", { ...base, exists: false }).status).toBe("NOT_FOUND");
  });
});
