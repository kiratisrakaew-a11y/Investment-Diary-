"use client";

import { useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { explainValuation } from "@/lib/valuation-explain";
import { valuationInput, type ValuationInput } from "@/lib/valuation-schemas";
import { MODEL_VERSION, timestampFlags } from "@/lib/governance";
import { deleteValuationAction } from "@/app/(app)/valuation/actions";
import { CalculationDetail } from "./CalculationDetail";
import { ConfirmButton } from "./ConfirmButton";
import { Badge } from "./ui";
import { METHOD_LABEL, fmtNum, fmtPct, signClass } from "@/lib/format";

export interface SavedValuationRow {
  id: number;
  date: string;
  method: string;
  title: string;
  note: string;
  source: string;
  intrinsicValue: number | null;
  priceAtValuation: number | null;
  assumptions: unknown;
  /** Formula version the stored value was computed with (absent before PR 5). */
  modelVersion?: string;
  isLatestForMethod: boolean;
}

/** Every saved valuation of one stock; each row expands into its full calculation. */
export function SavedValuationList({ rows, currentPrice }: { rows: SavedValuationRow[]; currentPrice: number | null }) {
  const [open, setOpen] = useState<number | null>(rows[0]?.id ?? null);
  return (
    <div className="divide-y divide-border">
      {rows.map((v) => {
        const isOpen = open === v.id;
        const upThen = v.intrinsicValue && v.priceAtValuation ? v.intrinsicValue / v.priceAtValuation - 1 : null;
        const upNow = v.intrinsicValue && currentPrice ? v.intrinsicValue / currentPrice - 1 : null;
        let explanation = null;
        try {
          // Parse so fields added after the valuation was saved get their defaults.
          const raw = { method: v.method, assumptions: v.assumptions };
          const parsed = valuationInput.safeParse(raw);
          explanation = explainValuation(parsed.success ? parsed.data : (raw as ValuationInput));
        } catch {
          explanation = null;
        }
        const oldVersion = v.modelVersion !== MODEL_VERSION;
        const changed =
          explanation != null && v.intrinsicValue != null && (explanation.value == null || Math.abs(explanation.value - v.intrinsicValue) > 1e-6 * Math.max(1, Math.abs(v.intrinsicValue)));
        const inputsAsOf = (v.assumptions as { inputMeta?: { asOf?: string } } | null)?.inputMeta?.asOf;
        const tsFlags = timestampFlags({ valuationDate: v.date, inputsAsOf });
        return (
          <div key={v.id} className={clsx(!v.isLatestForMethod && "opacity-70")}>
            <button type="button" onClick={() => setOpen(isOpen ? null : v.id)} className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 py-3 text-left text-sm">
              <span className="w-4 text-muted">{isOpen ? "▾" : "▸"}</span>
              <span className="w-24 tabular-nums text-muted">{v.date}</span>
              <Badge className="border-accent/40 text-accent">{METHOD_LABEL[v.method] ?? v.method}</Badge>
              <span className="min-w-32 flex-1 truncate">
                {v.title || <span className="text-muted">ไม่มีชื่อ scenario</span>}
                {!v.isLatestForMethod && <span className="ml-2 text-[11px] text-muted">(ฉบับเก่า)</span>}
                {v.source !== "web" && <Badge className="ml-2">via {v.source}</Badge>}
                {oldVersion &&
                  (changed ? (
                    <Badge className="ml-2 border-neg/40 text-neg">สูตรเวอร์ชันก่อน · ค่าเปลี่ยน</Badge>
                  ) : (
                    <Badge className="ml-2" title="คำนวณใหม่ด้วยสูตรปัจจุบันได้ค่าเท่าเดิม">
                      สูตรเวอร์ชันก่อน · ค่าเท่าเดิม
                    </Badge>
                  ))}
                {tsFlags.length > 0 && (
                  <Badge className="ml-2 border-warn/40 text-warn" title={tsFlags.join("\n")}>
                    วันที่ข้อมูลไม่ตรง
                  </Badge>
                )}
              </span>
              <span className="text-right">
                <span className="font-semibold tabular-nums">{fmtNum(v.intrinsicValue)}</span>
                <span className="block text-[11px] text-muted">
                  ราคาวันประเมิน {fmtNum(v.priceAtValuation)} ({fmtPct(upThen, 1)}) · ตอนนี้ <span className={signClass(upNow)}>{fmtPct(upNow, 1)}</span>
                </span>
              </span>
            </button>
            {isOpen && (
              <div className="mb-4 ml-8 space-y-3">
                <div className="flex flex-wrap items-center gap-3 text-xs print:hidden">
                  <Link href={`/valuation/${v.id}`} className="btn-ghost text-xs">แก้ไขสมมติฐาน</Link>
                  <ConfirmButton onConfirm={deleteValuationAction.bind(null, v.id)} label="ลบ valuation นี้" />
                </div>
                {tsFlags.map((f) => (
                  <p key={f} className="text-xs text-warn">⚠️ {f}</p>
                ))}
                {changed && (
                    <p className="rounded-lg bg-bg p-3 text-xs text-neg">
                      ค่าที่บันทึกไว้ {fmtNum(v.intrinsicValue)} คำนวณด้วยสูตรเวอร์ชันก่อน — สูตรปัจจุบันได้ {fmtNum(explanation?.value)} (เช่น การคิดลด terminal value แบบ mid-year หรือการตรวจ r &gt; g) กด “แก้ไขสมมติฐาน” แล้วบันทึกเพื่ออัปเดต
                    </p>
                  )}
                <p className="text-[11px] text-muted">สูตรเวอร์ชัน {v.modelVersion ?? "ก่อน 2026.10-pr5 (ไม่ได้บันทึก)"} · ปัจจุบัน {MODEL_VERSION}</p>
                {v.note && <p className="rounded-lg bg-bg p-3 text-xs whitespace-pre-wrap">📝 {v.note}</p>}
                {explanation ? <CalculationDetail e={explanation} compact /> : <p className="text-xs text-muted">ไม่สามารถแสดงวิธีคำนวณของ valuation นี้</p>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
