"use client";

import Link from "next/link";
import { ASSET_CLASS_COLOR, ASSET_CLASS_LABEL, formatChange, fmtPctRaw, fmtQty, fmtThb, formatNumber, signClass } from "@/lib/format";
import type { AssetClass } from "@/db/schema";
import { DataTable, type Column } from "./ui-client";

export interface HoldingRow {
  assetId: number;
  symbol: string;
  name: string;
  assetClass: AssetClass;
  quantity: number;
  avgCostThb: number;
  lastPrice: number | null;
  currency: string;
  lastPriceDate: string | null;
  badges: string[];
  marketValueThb: number;
  unrealizedPnlThb: number;
  unrealizedPnlPct: number | null;
  realizedIncomeThb: number;
  weightPct: number;
  valuation: { average: number; count: number } | null;
}

const baht = (n: number) => fmtThb(n).replace("฿", "");

export function HoldingsTable({ rows }: { rows: HoldingRow[] }) {
  const columns: Column<HoldingRow>[] = [
    {
      key: "symbol",
      header: "สินทรัพย์",
      sortValue: (r) => r.symbol,
      render: (r) => (
        <>
          <Link href={`/holdings/${r.assetId}`} className="font-medium text-primary">
            {r.symbol}
          </Link>
          <div className="max-w-32 truncate text-xs text-text-muted" title={r.name}>
            {r.name}
          </div>
        </>
      ),
    },
    {
      key: "class",
      header: "ประเภท",
      sortValue: (r) => ASSET_CLASS_LABEL[r.assetClass],
      render: (r) => (
        <span className="flex items-center gap-2 text-xs whitespace-nowrap">
          <span aria-hidden className="inline-block size-2 rounded-full" style={{ background: ASSET_CLASS_COLOR[r.assetClass] }} />
          {ASSET_CLASS_LABEL[r.assetClass]}
        </span>
      ),
    },
    { key: "qty", header: "จำนวน", numeric: true, sortValue: (r) => r.quantity, render: (r) => fmtQty(r.quantity) },
    { key: "cost", header: "ต้นทุนเฉลี่ย", unit: "บาท", numeric: true, sortValue: (r) => r.avgCostThb, render: (r) => formatNumber(r.avgCostThb, 2) },
    {
      key: "price",
      header: "ราคาล่าสุด",
      unit: "สกุลสินทรัพย์",
      numeric: true,
      sortValue: (r) => r.lastPrice,
      render: (r) => (
        <>
          {formatNumber(r.lastPrice, 2)} <span className="text-xs text-text-muted">{r.currency}</span>
          <div className="text-xs text-text-muted">{r.lastPriceDate ?? "ราคาซื้อ"}</div>
          {r.badges.length > 0 && (
            <div className="mt-1 flex flex-wrap justify-end gap-1">
              {r.badges.map((b) => (
                <span key={b} className="rounded-md bg-negative/10 px-1 text-xs text-negative">
                  {b}
                </span>
              ))}
            </div>
          )}
        </>
      ),
    },
    { key: "mv", header: "มูลค่า", unit: "บาท", numeric: true, sortValue: (r) => r.marketValueThb, render: (r) => baht(r.marketValueThb) },
    {
      key: "unreal",
      header: "กำไรยังไม่รับรู้",
      unit: "บาท",
      numeric: true,
      sortValue: (r) => r.unrealizedPnlThb,
      render: (r) => {
        const c = formatChange(r.unrealizedPnlPct == null ? null : r.unrealizedPnlPct / 100);
        return (
          <span className={signClass(r.unrealizedPnlThb)}>
            {baht(r.unrealizedPnlThb)}
            <div className="text-xs">{c.text}</div>
          </span>
        );
      },
    },
    { key: "real", header: "รับรู้แล้ว + ปันผล", unit: "บาท", numeric: true, sortValue: (r) => r.realizedIncomeThb, render: (r) => <span className={signClass(r.realizedIncomeThb)}>{baht(r.realizedIncomeThb)}</span> },
    { key: "w", header: "น้ำหนัก", numeric: true, sortValue: (r) => r.weightPct, render: (r) => fmtPctRaw(r.weightPct) },
    {
      key: "fv",
      header: "มูลค่าที่เหมาะสม",
      unit: "ต่อหุ้น",
      numeric: true,
      sortValue: (r) => r.valuation?.average,
      render: (r) => {
        if (r.valuation) {
          const up = r.lastPrice ? r.valuation.average / r.lastPrice - 1 : null;
          const c = formatChange(up);
          return (
            <Link href={`/valuation/stock/${r.symbol}`} className="hover:underline" title={`เฉลี่ยจาก ${r.valuation.count} valuation`}>
              {formatNumber(r.valuation.average, 2)}
              <div className={`text-xs ${c.className}`}>{up != null ? c.text : ""}</div>
            </Link>
          );
        }
        if (r.assetClass === "thai_stock" || r.assetClass === "us_stock") return <Link href={`/valuation/new?symbol=${r.symbol}`} className="text-xs text-primary">ประเมิน →</Link>;
        if (r.assetClass === "bond") return <Link href="/bonds" className="text-xs text-primary">YTM →</Link>;
        return <span className="text-text-muted">—</span>;
      },
    },
  ];
  return <DataTable columns={columns} rows={rows} rowKey={(r) => r.assetId} defaultSort={{ key: "mv", dir: "desc" }} caption="สินทรัพย์ที่ถืออยู่" />;
}
