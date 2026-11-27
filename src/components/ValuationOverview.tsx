"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { CONSENSUS_SOURCE_LABEL } from "@/lib/consensus";
import { Badge, Card, KpiCard } from "./ui";
import { DataTable, type Column } from "./ui-client";
import { IconChip } from "./icons";
import { fmtNum, formatChange, formatNumber } from "@/lib/format";

export interface OverviewRow {
  symbol: string;
  count: number;
  methods: { id: number; label: string; value: number | null }[];
  low: number | null;
  high: number | null;
  average: number | null;
  median: number | null;
  price: number | null;
  priceDate: string | null;
  /** Days since the last stored price (null = no stored price; the valuation-time price is shown instead). */
  priceAgeDays: number | null;
  upside: number | null;
  lastDate: string;
  /** Latest valuations whose value would change under today's formulas. */
  changedCount: number;
  /** Latest analyst consensus found (other people's opinion; not part of the averages). */
  consensus: { target: number; upside: number | null; asOf: string; ageDays: number; stale: boolean; source: string } | null;
}

const num = (n: number | null | undefined) => formatNumber(n, 2);

/** KPI row + search + sortable table of the valued stocks. */
export function ValuationOverview({ rows, staleAfterDays }: { rows: OverviewRow[]; staleAfterDays: number }) {
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const term = q.trim().toUpperCase();
    return rows.filter((r) => !term || r.symbol.includes(term) || r.methods.some((m) => m.label.toUpperCase().includes(term)));
  }, [rows, q]);
  const stale = rows.filter((r) => r.priceAgeDays == null || r.priceAgeDays > staleAfterDays).length;
  const positive = rows.filter((r) => (r.upside ?? 0) > 0).length;
  const changed = rows.filter((r) => r.changedCount > 0).length;

  const columns: Column<OverviewRow>[] = [
    {
      key: "symbol",
      header: "หุ้น",
      sortValue: (g) => g.symbol,
      render: (g) => (
        <>
          <Link href={`/valuation/stock/${encodeURIComponent(g.symbol)}`} className="font-medium text-primary">
            {g.symbol}
          </Link>
          <div className="text-xs text-text-muted">{g.count} valuation</div>
        </>
      ),
    },
    {
      key: "methods",
      header: "วิธีที่ใช้ (มูลค่าล่าสุด)",
      className: "whitespace-normal",
      render: (g) => (
        <div className="flex flex-wrap gap-1">
          {g.methods.map((m) => (
            <Badge key={m.id}>
              {m.label} {num(m.value)}
            </Badge>
          ))}
          {g.changedCount > 0 && (
            <Badge status="red" title="คำนวณใหม่ด้วยสูตรปัจจุบันได้ค่าต่างจากที่บันทึก — เปิดแล้วบันทึกใหม่">
              ค่าเปลี่ยนตามสูตรใหม่ {g.changedCount}
            </Badge>
          )}
        </div>
      ),
    },
    {
      key: "range",
      header: "ช่วงมูลค่าเทียบราคา",
      className: "min-w-48",
      render: (g) => (
        <>
          <RangeBar values={g.methods.map((m) => ({ label: m.label, v: m.value }))} price={g.price} />
          <div className="mt-1 text-xs text-text-muted tabular-nums">{g.low != null ? `${num(g.low)} – ${num(g.high)}` : "—"}</div>
        </>
      ),
    },
    {
      key: "avg",
      header: "เฉลี่ย / มัธยฐาน",
      unit: "ต่อหุ้น",
      numeric: true,
      sortValue: (g) => g.average,
      render: (g) => (
        <>
          <span className="font-semibold">{num(g.average)}</span>
          <div className="text-xs text-text-muted">มัธยฐาน {num(g.median)}</div>
        </>
      ),
    },
    {
      key: "price",
      header: "ราคา",
      numeric: true,
      sortValue: (g) => g.price,
      render: (g) => {
        const isStale = g.priceAgeDays == null || g.priceAgeDays > staleAfterDays;
        return (
          <>
            {num(g.price)}
            <div className={clsx("text-xs", isStale ? "text-warning" : "text-text-muted")}>{g.priceDate ? `ณ ${g.priceDate}${isStale ? ` · ${g.priceAgeDays} วัน` : ""}` : "ราคาวันประเมิน (ไม่มีราคาในระบบ)"}</div>
          </>
        );
      },
    },
    {
      key: "upside",
      header: "Upside (มัธยฐาน)",
      numeric: true,
      sortValue: (g) => g.upside,
      render: (g) => {
        const c = formatChange(g.upside);
        return <span className={c.className}>{c.text}</span>;
      },
    },
    {
      key: "consensus",
      header: "Consensus",
      unit: "ราคาเป้าหมาย",
      numeric: true,
      sortValue: (g) => g.consensus?.target,
      render: (g) => {
        if (!g.consensus) return <span className="text-text-muted">—</span>;
        const c = formatChange(g.consensus.upside);
        return (
          <span title={`${CONSENSUS_SOURCE_LABEL[g.consensus.source] ?? g.consensus.source} · ณ ${g.consensus.asOf} (${g.consensus.ageDays} วันก่อน)`}>
            {num(g.consensus.target)}
            <div className={clsx("text-xs", g.consensus.stale ? "text-warning" : c.className)}>
              {c.text}
              {g.consensus.stale && " · เก่า"}
            </div>
          </span>
        );
      },
    },
    {
      key: "last",
      header: "ประเมินล่าสุด",
      sortValue: (g) => g.lastDate,
      render: (g) => (
        <>
          {g.lastDate}{" "}
          <Link href={`/valuation/stock/${encodeURIComponent(g.symbol)}`} className="ml-2 text-xs text-primary">
            ดูทั้งหมด →
          </Link>
        </>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <KpiCard label="หุ้นที่ประเมินแล้ว" value={String(rows.length)} icon={<IconChip category="valuation" label="หุ้นที่ประเมินแล้ว" />} />
        <KpiCard label="มูลค่ามัธยฐานสูงกว่าราคา" value={`${positive} / ${rows.length}`} note="จำนวนหุ้นที่ upside เป็นบวก" />
        <KpiCard label={`ราคาเก่ากว่า ${staleAfterDays} วัน`} value={String(stale)} valueClassName={stale ? "text-warning" : undefined} note={stale ? "ควรอัปเดตราคาก่อนอ่าน upside" : "ราคาทุกตัวเป็นปัจจุบัน"} />
        <KpiCard label="ค่าเปลี่ยนตามสูตรใหม่" value={String(changed)} valueClassName={changed ? "text-negative" : undefined} note={changed ? "เปิดแล้วบันทึกใหม่เพื่ออัปเดต" : "ไม่มีรายการที่ต้องคำนวณใหม่"} />
      </div>
      <Card className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="block min-w-48 flex-1">
            <span className="label">ค้นหาหุ้น / วิธี</span>
            <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="เช่น PTT หรือ DCF" />
          </label>
          <span className="pb-2 text-xs text-text-muted" aria-live="polite">
            แสดง {shown.length} จาก {rows.length}
          </span>
        </div>
        <DataTable
          columns={columns}
          rows={shown}
          rowKey={(g) => g.symbol}
          defaultSort={{ key: "upside", dir: "desc" }}
          caption="สรุป valuation ของหุ้นที่ประเมินแล้ว"
          empty={{ title: `ไม่พบหุ้นที่ตรงกับ “${q}”`, description: "ลองค้นด้วยชื่อหุ้นหรือชื่อวิธีอื่น" }}
        />
        <p className="text-xs text-text-muted">ราคาเป็นราคาปิดล่าสุดที่บันทึกในระบบ ไม่ใช่ราคาเรียลไทม์ · เกณฑ์ราคาเก่าตั้งได้ในหน้าตั้งค่า (เกณฑ์วันที่ข้อมูล)</p>
      </Card>
    </div>
  );
}

/** Latest value of each method as dots on one line, with the market price as a vertical marker. */
function RangeBar({ values, price }: { values: { label: string; v: number | null }[]; price: number | null }) {
  const vs = values.filter((x): x is { label: string; v: number } => x.v != null && Number.isFinite(x.v));
  if (!vs.length) return <span className="text-text-muted">—</span>;
  const all = [...vs.map((x) => x.v), ...(price != null ? [price] : [])];
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const pos = (v: number) => (hi === lo ? 50 : ((v - lo) / (hi - lo)) * 100);
  const vmin = Math.min(...vs.map((x) => x.v));
  const vmax = Math.max(...vs.map((x) => x.v));
  return (
    <div className="relative h-5" role="img" aria-label={`ช่วงมูลค่า ${fmtNum(vmin)} ถึง ${fmtNum(vmax)}${price != null ? ` ราคา ${fmtNum(price)}` : ""}`}>
      <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-panel-2" />
      <div className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-primary/70" style={{ left: `${pos(vmin)}%`, width: `${Math.max(1, pos(vmax) - pos(vmin))}%` }} />
      {vs.map((x) => (
        <span key={x.label} title={`${x.label} ${fmtNum(x.v)}`} className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-panel-solid bg-primary" style={{ left: `${pos(x.v)}%` }} />
      ))}
      {price != null && <span title={`ราคา ${fmtNum(price)}`} className="absolute top-0 h-5 w-0.5 -translate-x-1/2 rounded-md bg-text" style={{ left: `${pos(price)}%` }} />}
    </div>
  );
}
