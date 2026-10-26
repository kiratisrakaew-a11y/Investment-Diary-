"use client";

import { useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { explainValuation } from "@/lib/valuation-explain";
import type { ValuationInput } from "@/lib/valuation-schemas";
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
        if (isOpen) {
          try {
            explanation = explainValuation({ method: v.method, assumptions: v.assumptions } as ValuationInput);
          } catch {
            explanation = null;
          }
        }
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
