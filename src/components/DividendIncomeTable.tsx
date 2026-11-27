"use client";

import { fmtThb, formatNumber, formatPercent } from "@/lib/format";
import { Badge, type BadgeStatus } from "./ui";
import { DataTable, type Column } from "./ui-client";

export interface DividendRow {
  month: string;
  symbol: string;
  status: "received" | "missing_confirmation" | "announced" | "estimated";
  exDate: string | null;
  paymentDate: string | null;
  units: number;
  dps: number;
  currency: string;
  gross: number;
  withholdingRate: number;
  netThb: number | null;
  receivedThb: number | null;
  notes: string[];
}

const STATUS: Record<DividendRow["status"], { label: string; status: BadgeStatus }> = {
  received: { label: "ได้รับแล้ว", status: "green" },
  missing_confirmation: { label: "ถึงกำหนด ยังไม่บันทึก", status: "yellow" },
  announced: { label: "ประกาศแล้ว", status: "info" },
  estimated: { label: "ประมาณการ", status: "neutral" },
};
const baht = (n: number | null) => (n == null ? "—" : fmtThb(n).replace("฿", ""));

const COLUMNS: Column<DividendRow>[] = [
  { key: "month", header: "เดือน", sortValue: (r) => r.month, render: (r) => <span title={r.notes.join(" · ")}>{r.month}</span> },
  { key: "symbol", header: "หุ้น", sortValue: (r) => r.symbol, render: (r) => <span className="font-medium">{r.symbol}</span> },
  { key: "status", header: "สถานะ", sortValue: (r) => r.status, render: (r) => <Badge status={STATUS[r.status].status}>{STATUS[r.status].label}</Badge> },
  { key: "ex", header: "ex-date", className: "whitespace-nowrap", sortValue: (r) => r.exDate, render: (r) => r.exDate ?? "—" },
  { key: "pay", header: "วันจ่าย", sortValue: (r) => r.paymentDate, render: (r) => r.paymentDate ?? <span className="text-text-muted">ไม่ทราบ</span> },
  { key: "units", header: "หุ้นที่มีสิทธิ์", numeric: true, sortValue: (r) => r.units, render: (r) => formatNumber(r.units, 0) },
  { key: "dps", header: "ต่อหุ้น", unit: "สกุลเดิม", numeric: true, sortValue: (r) => r.dps, render: (r) => `${formatNumber(r.dps, 4)}${r.currency !== "THB" ? ` ${r.currency}` : ""}` },
  { key: "gross", header: "ก่อนภาษี", numeric: true, sortValue: (r) => r.gross, render: (r) => formatNumber(r.gross, 2) },
  { key: "tax", header: "ภาษี", numeric: true, sortValue: (r) => r.withholdingRate, render: (r) => <span className="text-text-muted">{formatPercent(r.withholdingRate, 0)}</span> },
  { key: "net", header: "สุทธิ", unit: "บาท", numeric: true, sortValue: (r) => r.netThb, render: (r) => baht(r.netThb) },
  { key: "recv", header: "รับจริง", unit: "บาท", numeric: true, sortValue: (r) => r.receivedThb, render: (r) => baht(r.receivedThb) },
];

export function DividendIncomeTable({ rows }: { rows: DividendRow[] }) {
  return <DataTable columns={COLUMNS} rows={rows} rowKey={(r) => `${r.month}-${r.symbol}-${r.exDate ?? ""}-${r.status}`} defaultSort={{ key: "month", dir: "asc" }} maxHeight={448} caption="รายการปันผลที่คาดว่าจะได้รับและได้รับแล้ว" empty={{ title: "ยังไม่มีรายการปันผล", description: "เพิ่มเหตุการณ์ปันผลในแท็บด้านล่าง" }} />;
}
