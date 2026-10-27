"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { Badge } from "./ui";
import { fmtNum, fmtPct, signClass } from "@/lib/format";

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
}

type SortKey = "upside" | "date" | "symbol";
const SORTS: { key: SortKey; label: string }[] = [
  { key: "upside", label: "Upside (มัธยฐาน) มาก → น้อย" },
  { key: "date", label: "ประเมินล่าสุดก่อน" },
  { key: "symbol", label: "ชื่อหุ้น A → Z" },
];

/** One continuous glass surface: compact text metrics, search / sort, and the valued stocks. */
export function ValuationOverview({ rows, staleAfterDays }: { rows: OverviewRow[]; staleAfterDays: number }) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<SortKey>("upside");
  const shown = useMemo(() => {
    const term = q.trim().toUpperCase();
    const list = rows.filter((r) => !term || r.symbol.includes(term) || r.methods.some((m) => m.label.toUpperCase().includes(term)));
    const cmp: Record<SortKey, (a: OverviewRow, b: OverviewRow) => number> = {
      // Rows without an upside go last rather than being treated as zero.
      upside: (a, b) => (b.upside ?? -Infinity) - (a.upside ?? -Infinity),
      date: (a, b) => b.lastDate.localeCompare(a.lastDate),
      symbol: (a, b) => a.symbol.localeCompare(b.symbol),
    };
    return [...list].sort(cmp[sort]);
  }, [rows, q, sort]);
  const stale = rows.filter((r) => r.priceAgeDays == null || r.priceAgeDays > staleAfterDays).length;
  const positive = rows.filter((r) => (r.upside ?? 0) > 0).length;
  const changed = rows.filter((r) => r.changedCount > 0).length;

  return (
    <section className="card space-y-4">
      <dl className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
        <Metric k="หุ้นที่ประเมินแล้ว" v={String(rows.length)} />
        <Metric k="มูลค่ามัธยฐานสูงกว่าราคา" v={`${positive} / ${rows.length}`} />
        <Metric k={`ราคาเก่ากว่า ${staleAfterDays} วัน`} v={String(stale)} tone={stale ? "text-warn" : undefined} />
        <Metric k="ค่าเปลี่ยนตามสูตรใหม่" v={String(changed)} tone={changed ? "text-neg" : undefined} />
      </dl>
      <div className="flex flex-wrap items-end gap-3">
        <label className="block min-w-48 flex-1">
          <span className="label">ค้นหาหุ้น / วิธี</span>
          <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="เช่น PTT หรือ DCF" />
        </label>
        <label className="block">
          <span className="label">เรียงตาม</span>
          <select className="input w-auto" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
            {SORTS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <span className="pb-2 text-xs text-muted" aria-live="polite">
          แสดง {shown.length} จาก {rows.length}
        </span>
      </div>
      {shown.length === 0 ? (
        <p className="text-sm text-muted">ไม่พบหุ้นที่ตรงกับ “{q}”</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="data-grid table">
            <thead>
              <tr>
                <th>หุ้น</th>
                <th>วิธีที่ใช้ (มูลค่าล่าสุด)</th>
                <th className="min-w-56">ช่วงมูลค่าเทียบราคา</th>
                <th className="num">เฉลี่ย / มัธยฐาน</th>
                <th className="num">ราคา</th>
                <th className="num" title="เทียบมัธยฐาน — ไม่ถูกดึงด้วยค่าโดดของวิธีเดียว">
                  Upside (มัธยฐาน)
                </th>
                <th>ประเมินล่าสุด</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((g) => {
                const isStale = g.priceAgeDays == null || g.priceAgeDays > staleAfterDays;
                return (
                  <tr key={g.symbol}>
                    <td>
                      <Link href={`/valuation/stock/${encodeURIComponent(g.symbol)}`} className="font-medium text-accent">
                        {g.symbol}
                      </Link>
                      <div className="text-[11px] text-muted">{g.count} valuation</div>
                    </td>
                    <td className="whitespace-normal">
                      <div className="flex flex-wrap gap-1">
                        {g.methods.map((m) => (
                          <Badge key={m.id}>
                            {m.label} {fmtNum(m.value)}
                          </Badge>
                        ))}
                        {g.changedCount > 0 && (
                          <Badge className="border-neg/40 text-neg" title="คำนวณใหม่ด้วยสูตรปัจจุบันได้ค่าต่างจากที่บันทึก — เปิดแล้วบันทึกใหม่">
                            ค่าเปลี่ยนตามสูตรใหม่ {g.changedCount}
                          </Badge>
                        )}
                      </div>
                    </td>
                    <td>
                      <RangeBar values={g.methods.map((m) => ({ label: m.label, v: m.value }))} price={g.price} />
                      <div className="mt-1 text-[11px] text-muted tabular-nums">{g.low != null ? `${fmtNum(g.low)} – ${fmtNum(g.high)}` : "–"}</div>
                    </td>
                    <td className="num">
                      <span className="font-semibold">{fmtNum(g.average)}</span>
                      <div className="text-[11px] text-muted">มัธยฐาน {fmtNum(g.median)}</div>
                    </td>
                    <td className="num">
                      {fmtNum(g.price)}
                      <div className={clsx("text-[11px]", isStale ? "text-warn" : "text-muted")}>
                        {g.priceDate ? `ณ ${g.priceDate}${isStale ? ` · ${g.priceAgeDays} วัน` : ""}` : "ราคาวันประเมิน (ไม่มีราคาในระบบ)"}
                      </div>
                    </td>
                    <td className={`num ${signClass(g.upside)}`}>{fmtPct(g.upside, 1)}</td>
                    <td>
                      {g.lastDate}{" "}
                      <Link href={`/valuation/stock/${encodeURIComponent(g.symbol)}`} className="ml-2 text-xs text-accent">
                        ดูทั้งหมด →
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-[11px] text-muted">ราคาเป็นราคาปิดล่าสุดที่บันทึกในระบบ ไม่ใช่ราคาเรียลไทม์ · เกณฑ์ราคาเก่าตั้งได้ในหน้าตั้งค่า (เกณฑ์วันที่ข้อมูล)</p>
    </section>
  );
}

function Metric({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return (
    <div>
      <dt className="text-xs text-muted">{k}</dt>
      <dd className={clsx("text-lg font-semibold tabular-nums", tone)}>{v}</dd>
    </div>
  );
}

/** Latest value of each method as dots on one line, with the market price as a vertical marker. */
function RangeBar({ values, price }: { values: { label: string; v: number | null }[]; price: number | null }) {
  const vs = values.filter((x): x is { label: string; v: number } => x.v != null && Number.isFinite(x.v));
  if (!vs.length) return <span className="text-muted">–</span>;
  const all = [...vs.map((x) => x.v), ...(price != null ? [price] : [])];
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const pos = (v: number) => (hi === lo ? 50 : ((v - lo) / (hi - lo)) * 100);
  const vmin = Math.min(...vs.map((x) => x.v));
  const vmax = Math.max(...vs.map((x) => x.v));
  return (
    <div className="relative h-5" role="img" aria-label={`ช่วงมูลค่า ${fmtNum(vmin)} ถึง ${fmtNum(vmax)}${price != null ? ` ราคา ${fmtNum(price)}` : ""}`}>
      <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-panel-2" />
      <div className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-linear-to-r from-accent/70 to-accent-2/70" style={{ left: `${pos(vmin)}%`, width: `${Math.max(1, pos(vmax) - pos(vmin))}%` }} />
      {vs.map((x) => (
        <span key={x.label} title={`${x.label} ${fmtNum(x.v)}`} className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-panel-solid bg-accent" style={{ left: `${pos(x.v)}%` }} />
      ))}
      {price != null && <span title={`ราคา ${fmtNum(price)}`} className="absolute top-0 h-5 w-0.5 -translate-x-1/2 rounded bg-text" style={{ left: `${pos(price)}%` }} />}
    </div>
  );
}
