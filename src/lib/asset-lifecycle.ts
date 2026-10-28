/**
 * Asset lifecycle decisions (PR9). Pure: the server service loads the state inside a transaction,
 * calls `decideLifecycle`, applies the returned change and logs it.
 *
 *   hide / unhide     — presentation only (holdings "other assets" chips); never accounting, prices,
 *                       valuations or optimizer eligibility. Not for a position still held.
 *   archive / unarchive — reversible inactivity: excluded by default from new selections (optimizer
 *                       universe, pickers); all history stays. Not for a position still held.
 *   delete            — only with zero dependent records and the exact symbol typed as confirmation.
 *                       Never cascades; otherwise BLOCKED_HAS_DEPENDENCIES with the counts.
 * There is no watchlist module, so "remove from watchlist" does not exist here.
 */
export type LifecycleAction = "hide" | "unhide" | "archive" | "unarchive" | "delete";
export type LifecycleStatus = "HIDDEN" | "ARCHIVED" | "RESTORED" | "DELETED" | "BLOCKED_HAS_DEPENDENCIES" | "FORBIDDEN" | "NOT_FOUND";

export interface AssetDependencies {
  transactions: number;
  prices: number;
  valuations: number;
  financialStatements: number;
  statementUploads: number;
  dividendEvents: number;
  notes: number;
  /** User-defined custom metric definitions (their observations and thresholds go with them). */
  customMetrics: number;
}

export interface LifecycleState {
  exists: boolean;
  symbol: string;
  hiddenAt: Date | string | null;
  archivedAt: Date | string | null;
  /** Units currently held (from the ledger). */
  heldQuantity: number;
  dependencies: AssetDependencies;
}

export interface LifecycleDecision {
  status: LifecycleStatus;
  /** Column changes to apply (absent = nothing to write, e.g. idempotent repeat or refusal). */
  change?: { hiddenInHoldingsAt?: Date | null; archivedAt?: Date | null; delete?: true };
  /** True when the asset was already in the requested state (idempotent). */
  unchanged?: boolean;
  message: string;
  dependencies?: Partial<AssetDependencies>;
}

const DEP_LABEL: Record<keyof AssetDependencies, string> = {
  transactions: "รายการซื้อขาย",
  prices: "ราคาย้อนหลัง",
  valuations: "valuation",
  financialStatements: "งบการเงิน",
  statementUploads: "ไฟล์งบที่อัปโหลด",
  dividendEvents: "เหตุการณ์ปันผล",
  notes: "บันทึก",
  customMetrics: "ตัวชี้วัดที่ติดตาม",
};

export function dependencySummary(d: AssetDependencies): { total: number; nonZero: Partial<AssetDependencies>; text: string } {
  const nonZero = Object.fromEntries(Object.entries(d).filter(([, v]) => v > 0)) as Partial<AssetDependencies>;
  const total = Object.values(d).reduce((a, b) => a + b, 0);
  return { total, nonZero, text: Object.entries(nonZero).map(([k, v]) => `${DEP_LABEL[k as keyof AssetDependencies]} ${v}`).join(" · ") };
}

export function decideLifecycle(action: LifecycleAction, s: LifecycleState, opts: { confirmSymbol?: string; now?: Date } = {}): LifecycleDecision {
  const now = opts.now ?? new Date();
  if (!s.exists) return { status: "NOT_FOUND", message: "ไม่พบสินทรัพย์นี้" };
  const held = Math.abs(s.heldQuantity) > 1e-12;
  switch (action) {
    case "hide":
      if (held) return { status: "FORBIDDEN", message: `${s.symbol} ยังถืออยู่ — ซ่อนไม่ได้ (การซ่อนใช้กับรายการที่ขายหมด/ยังไม่ได้ซื้อเท่านั้น และไม่กระทบบัญชีพอร์ต)` };
      return s.hiddenAt ? { status: "HIDDEN", unchanged: true, message: `${s.symbol} ซ่อนอยู่แล้ว` } : { status: "HIDDEN", change: { hiddenInHoldingsAt: now }, message: `ซ่อน ${s.symbol} จากหน้าสินทรัพย์แล้ว — ดู/คืนได้ที่ "ซ่อนไว้"` };
    case "unhide":
      return s.hiddenAt ? { status: "RESTORED", change: { hiddenInHoldingsAt: null }, message: `แสดง ${s.symbol} อีกครั้ง` } : { status: "RESTORED", unchanged: true, message: `${s.symbol} แสดงอยู่แล้ว` };
    case "archive":
      if (held) return { status: "FORBIDDEN", message: `${s.symbol} ยังถืออยู่ — เก็บถาวรได้หลังขายหมดเท่านั้น` };
      return s.archivedAt
        ? { status: "ARCHIVED", unchanged: true, message: `${s.symbol} เก็บถาวรอยู่แล้ว` }
        : { status: "ARCHIVED", change: { archivedAt: now }, message: `เก็บถาวร ${s.symbol} แล้ว — ไม่ถูกเลือกในการจัดพอร์ตโดยค่าเริ่มต้น ประวัติทั้งหมดยังอยู่` };
    case "unarchive":
      return s.archivedAt ? { status: "RESTORED", change: { archivedAt: null }, message: `นำ ${s.symbol} กลับมาใช้งาน` } : { status: "RESTORED", unchanged: true, message: `${s.symbol} ไม่ได้เก็บถาวร` };
    case "delete": {
      if ((opts.confirmSymbol ?? "").trim().toUpperCase() !== s.symbol.toUpperCase())
        return { status: "FORBIDDEN", message: `ยืนยันการลบถาวรต้องพิมพ์สัญลักษณ์ ${s.symbol} ให้ตรง` };
      if (held) return { status: "BLOCKED_HAS_DEPENDENCIES", message: `${s.symbol} ยังถืออยู่ — ลบไม่ได้`, dependencies: s.dependencies };
      const d = dependencySummary(s.dependencies);
      if (d.total > 0)
        return {
          status: "BLOCKED_HAS_DEPENDENCIES",
          message: `ลบถาวรไม่ได้ — ${s.symbol} มีข้อมูลที่อ้างถึง: ${d.text} · ใช้ "ซ่อน" หรือ "เก็บถาวร" แทน (ระบบไม่ลบข้อมูลที่เกี่ยวข้องให้)`,
          dependencies: d.nonZero,
        };
      return { status: "DELETED", change: { delete: true }, message: `ลบ ${s.symbol} ถาวรแล้ว (ไม่มีข้อมูลอื่นอ้างถึง)` };
    }
  }
}
