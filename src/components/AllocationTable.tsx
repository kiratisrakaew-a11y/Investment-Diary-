"use client";

import { ASSET_CLASS_COLOR, ASSET_CLASS_LABEL, formatChange, fmtPctRaw, fmtThb } from "@/lib/format";
import type { AllocationRow } from "@/lib/finance/allocation";
import { DataTable, type Column } from "./ui-client";

const COLUMNS: Column<AllocationRow>[] = [
  {
    key: "assetClass",
    header: "ประเภท",
    sortValue: (r) => ASSET_CLASS_LABEL[r.assetClass],
    render: (r) => (
      <span className="flex items-center gap-2 whitespace-nowrap">
        <span aria-hidden className="inline-block size-2 rounded-full" style={{ background: ASSET_CLASS_COLOR[r.assetClass] }} />
        {ASSET_CLASS_LABEL[r.assetClass]}
      </span>
    ),
  },
  { key: "value", header: "มูลค่า", unit: "บาท", numeric: true, sortValue: (r) => r.value, render: (r) => fmtThb(r.value).replace("฿", "") },
  { key: "actual", header: "จริง", unit: "%", numeric: true, sortValue: (r) => r.actualPct, render: (r) => fmtPctRaw(r.actualPct).replace("%", "") },
  {
    key: "bar",
    header: "จริง vs เป้า",
    className: "min-w-16",
    render: (r) => (
      /* Bar = actual share; tick = target. */
      <div className="relative h-2 rounded-full bg-panel-2">
        <div className="h-2 rounded-full" style={{ width: `${Math.min(100, r.actualPct)}%`, background: ASSET_CLASS_COLOR[r.assetClass] }} />
        <div className="absolute -top-1 h-4 w-0.5 bg-text/70" style={{ left: `calc(${Math.min(100, r.targetPct)}% - 1px)` }} title={`เป้า ${fmtPctRaw(r.targetPct)}`} />
      </div>
    ),
  },
  { key: "target", header: "เป้า", unit: "%", numeric: true, sortValue: (r) => r.targetPct, render: (r) => fmtPctRaw(r.targetPct).replace("%", "") },
  {
    key: "drift",
    header: "ส่วนต่าง",
    unit: "จุด %",
    numeric: true,
    sortValue: (r) => r.driftPct,
    render: (r) => {
      const c = formatChange(r.driftPct, "number", 1);
      return <span className={Math.abs(r.driftPct) > 5 ? c.className : undefined}>{c.text}</span>;
    },
  },
  {
    key: "rebalance",
    header: "ปรับสมดุล",
    unit: "บาท",
    numeric: true,
    sortValue: (r) => r.rebalanceAmount,
    render: (r) => (Math.abs(r.rebalanceAmount) < 1 ? "—" : `${r.rebalanceAmount > 0 ? "ซื้อ" : "ขาย"} ${fmtThb(Math.abs(r.rebalanceAmount)).replace("฿", "")}`),
  },
];

export function AllocationTable({ rows }: { rows: AllocationRow[] }) {
  return <DataTable columns={COLUMNS} rows={rows} rowKey={(r) => r.assetClass} caption="สัดส่วนจริงเทียบเป้าหมายตามประเภทสินทรัพย์" empty={{ title: "ยังไม่มีสินทรัพย์", description: "เพิ่มสินทรัพย์เพื่อดูสัดส่วน" }} />;
}
