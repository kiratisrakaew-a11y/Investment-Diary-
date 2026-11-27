"use client";

import { TX_TYPE_LABEL, fmtQty, fmtThb, formatNumber } from "@/lib/format";
import { ConfirmButton } from "./ConfirmButton";
import { Badge } from "./ui";
import { DataTable, type Column } from "./ui-client";

export interface TxHistoryRow {
  id: number;
  date: string;
  type: string;
  symbol: string | null;
  quantity: number;
  price: number;
  currency: string | null;
  fee: number | null;
  valueThb: number;
  source: string;
  memo: string | null;
}

export function TxHistoryTable({ rows, deleteAction }: { rows: TxHistoryRow[]; deleteAction: (id: number) => Promise<void> }) {
  const columns: Column<TxHistoryRow>[] = [
    { key: "date", header: "วันที่", className: "whitespace-nowrap", sortValue: (r) => r.date, render: (r) => r.date },
    { key: "type", header: "ประเภท", sortValue: (r) => TX_TYPE_LABEL[r.type] ?? r.type, render: (r) => TX_TYPE_LABEL[r.type] ?? r.type },
    { key: "symbol", header: "สินทรัพย์", sortValue: (r) => r.symbol ?? "", render: (r) => <span className="font-medium">{r.symbol ?? "เงินสด"}</span> },
    { key: "qty", header: "จำนวน", numeric: true, sortValue: (r) => r.quantity, render: (r) => (r.type === "split" ? `×${fmtQty(r.quantity)}` : r.quantity ? fmtQty(r.quantity) : "—") },
    {
      key: "price",
      header: "ราคา / จำนวนเงิน",
      unit: "ต่อหน่วย",
      numeric: true,
      sortValue: (r) => r.price,
      render: (r) => (
        <>
          {formatNumber(r.price, 2)} <span className="text-xs text-text-muted">{r.currency ?? "THB"}</span>
        </>
      ),
    },
    { key: "fee", header: "ค่าธรรมเนียม", numeric: true, sortValue: (r) => r.fee, render: (r) => (r.fee ? formatNumber(r.fee, 2) : "—") },
    { key: "value", header: "มูลค่า", unit: "บาท", numeric: true, sortValue: (r) => r.valueThb, render: (r) => fmtThb(r.valueThb).replace("฿", "") },
    {
      key: "memo",
      header: "หมายเหตุ",
      className: "max-w-48 truncate text-xs text-text-muted",
      render: (r) => (
        <>
          {r.source !== "web" && <Badge className="mr-1">{r.source}</Badge>}
          {r.memo}
        </>
      ),
    },
    { key: "del", header: <span className="sr-only">ลบ</span>, render: (r) => <ConfirmButton onConfirm={() => deleteAction(r.id)} /> },
  ];
  return <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} defaultSort={{ key: "date", dir: "desc" }} maxHeight={560} caption="ประวัติรายการซื้อขาย" />;
}
