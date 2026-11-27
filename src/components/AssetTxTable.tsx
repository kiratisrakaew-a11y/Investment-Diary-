"use client";

import Link from "next/link";

import { TX_TYPE_LABEL, fmtQty, formatNumber } from "@/lib/format";
import { DataTable, type Column } from "./ui-client";

export interface TxRow {
  id: number;
  date: string;
  type: string;
  quantity: number | null;
  price: number | null;
}

const COLUMNS: Column<TxRow>[] = [
  { key: "date", header: "วันที่", sortValue: (r) => r.date, render: (r) => r.date },
  { key: "type", header: "ประเภท", sortValue: (r) => TX_TYPE_LABEL[r.type] ?? r.type, render: (r) => TX_TYPE_LABEL[r.type] ?? r.type },
  { key: "qty", header: "จำนวน", numeric: true, sortValue: (r) => r.quantity, render: (r) => (r.quantity ? fmtQty(r.quantity) : "—") },
  { key: "price", header: "ราคา", unit: "ต่อหน่วย", numeric: true, sortValue: (r) => r.price, render: (r) => formatNumber(r.price, 2) },
];

export function AssetTxTable({ rows }: { rows: TxRow[] }) {
  return <DataTable columns={COLUMNS} rows={rows} rowKey={(r) => r.id} defaultSort={{ key: "date", dir: "desc" }} maxHeight={360} caption="รายการซื้อขายของสินทรัพย์นี้" empty={{ title: "ยังไม่มีรายการ", description: "บันทึกการซื้อขายเพื่อดูประวัติและกำไรขาดทุนของสินทรัพย์นี้", action: <Link href="/transactions" className="btn-ghost">ไปที่รายการ</Link> }} />;
}
