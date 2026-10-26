import type { LedgerIssue, Reconciliation } from "@/lib/finance/portfolio";
import type { XirrResult } from "@/lib/finance/returns";
import { fmtPct, fmtThb } from "@/lib/format";

export const XIRR_STATUS_LABEL: Record<XirrResult["status"], string> = {
  ok: "ACT/365",
  no_sign_change: "กระแสเงินไม่เปลี่ยนเครื่องหมาย — คำนวณไม่ได้",
  no_root: "หาคำตอบไม่ได้ในช่วง −99% ถึง +1000%",
  multiple_roots: "มีหลายคำตอบ — ไม่รายงานค่าเดียว",
};

export function xirrText(x: XirrResult) {
  if (x.rate != null) return fmtPct(x.rate);
  return "–";
}

export function xirrNote(x: XirrResult) {
  if (x.status === "multiple_roots") return `${XIRR_STATUS_LABEL.multiple_roots}: ${x.candidates.map((c) => fmtPct(c)).join(", ")}`;
  return XIRR_STATUS_LABEL[x.status];
}

/** Warnings from the ledger replay, valuation and metric sample checks. Renders nothing when clean. */
export function DataQualityPanel({ issues = [], warnings = [], reconciliation }: { issues?: LedgerIssue[]; warnings?: string[]; reconciliation?: Reconciliation }) {
  const errors = issues.filter((i) => i.severity === "error");
  const warns = issues.filter((i) => i.severity !== "error");
  if (!errors.length && !warns.length && !warnings.length && (!reconciliation || reconciliation.navMatches)) return null;
  return (
    <details className="card border-l-4 border-l-neg" open={errors.length > 0}>
      <summary className="cursor-pointer text-sm font-medium">
        ⚠️ คุณภาพข้อมูล: {errors.length > 0 && `${errors.length} ข้อผิดพลาด · `}
        {warns.length + warnings.length} คำเตือน
        {reconciliation && reconciliation.inferredContributionsThb > 0 && ` · เงินฝากที่ระบบอนุมาน ${fmtThb(reconciliation.inferredContributionsThb)}`}
      </summary>
      <ul className="mt-2 space-y-1 text-xs">
        {reconciliation && !reconciliation.navMatches && (
          <li className="text-neg">NAV ไม่ตรงกับ เงินสด + Σ(จำนวน × ราคา × FX) — โปรดตรวจสอบรายการ</li>
        )}
        {errors.map((i, k) => (
          <li key={`e${k}`} className="text-neg">
            {i.date} · {i.message}
          </li>
        ))}
        {warns.map((i, k) => (
          <li key={`w${k}`}>
            {i.date} · {i.message}
          </li>
        ))}
        {warnings.map((w, k) => (
          <li key={`m${k}`}>{w}</li>
        ))}
      </ul>
      <a href="/data-quality" className="mt-2 inline-block text-xs text-accent">
        รายงานคุณภาพข้อมูลทั้งหมด →
      </a>
      {reconciliation && reconciliation.inferredContributionsThb > 0 && (
        <p className="mt-2 text-xs text-muted">
          รายการเก่าที่ซื้อโดยไม่มีเงินสดพอ ระบบไม่ได้แก้ข้อมูล แต่ถือส่วนที่ขาดเป็น “เงินฝากอนุมาน” ในการคำนวณผลตอบแทน — บันทึกรายการฝากเงินจริงเพื่อให้ตัวเลขแม่นยำ
        </p>
      )}
    </details>
  );
}
