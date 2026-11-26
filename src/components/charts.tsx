"use client";

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  Pie,
  PieChart,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useId, useRef, useState } from "react";
import { ASSET_CLASS_COLOR, ASSET_CLASS_LABEL, fmtThb, fmtNum, fmtPct } from "@/lib/format";
import type { AssetClass } from "@/db/schema";

/** Vertical fill under a line: strong colour at the top fading to transparent (optionally via a second colour). */
export function AreaGradient({ id, color, via, top = 0.55 }: { id: string; color: string; via?: string; top?: number }) {
  const stops = [
    { o: "0%", c: color, a: top },
    ...(via ? [{ o: "50%", c: via, a: top * 0.6 }] : []),
    { o: "100%", c: via ?? color, a: 0.06 },
  ];
  return (
    <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
      {stops.map((x) => (
        <stop key={x.o} offset={x.o} stopColor={x.c} stopOpacity={x.a} />
      ))}
    </linearGradient>
  );
}

const gid = (raw: string, name: string) => `${name}-${raw.replace(/[^a-zA-Z0-9_-]/g, "")}`;

const axis = { stroke: "var(--muted)", fontSize: 11, tickLine: false, axisLine: false } as const;
const tooltipStyle = {
  contentStyle: { background: "var(--panel-solid)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12, color: "var(--text)" },
  labelStyle: { color: "var(--muted)" },
};
const compactThb = (v: number) => (Math.abs(v) >= 1e6 ? `${fmtNum(v / 1e6, 1)}M` : Math.abs(v) >= 1e3 ? `${fmtNum(v / 1e3, 0)}k` : `${v}`);
const pct = (v: number) => `${fmtPct(v, 0)}`;

export function AllocationDonut({ rows }: { rows: { assetClass: AssetClass; value: number; actualPct: number }[] }) {
  const data = rows.filter((r) => r.value > 0);
  return (
    <ResponsiveContainer width="100%" height={260}>
      <PieChart>
        <Pie data={data} dataKey="value" nameKey="assetClass" innerRadius="58%" outerRadius="92%" paddingAngle={1} stroke="var(--panel-solid)" strokeWidth={2} isAnimationActive={false}>
          {data.map((r) => (
            <Cell key={r.assetClass} fill={ASSET_CLASS_COLOR[r.assetClass]} />
          ))}
        </Pie>
        <Legend
          wrapperStyle={{ fontSize: 12 }}
          formatter={(v) => <span style={{ color: "var(--text)" }}>{ASSET_CLASS_LABEL[v as AssetClass]}</span>}
        />
        <Tooltip
          {...tooltipStyle}
          formatter={(v, _n, item) => [`${fmtThb(Number(v))} (${fmtNum((item.payload as { actualPct: number }).actualPct, 1)}%)`, ASSET_CLASS_LABEL[(item.payload as { assetClass: AssetClass }).assetClass]]}
        />
      </PieChart>
    </ResponsiveContainer>
  );
}

/** Growth of 1 THB: portfolio (TWR) vs benchmark — indexed to a common base, one axis. */
export function GrowthChart({ data, benchmark }: { data: { date: string; portfolio: number; benchmark: number | null }[]; benchmark?: string }) {
  const rows = data.map((d) => ({ date: d.date, portfolio: d.portfolio - 1, benchmark: d.benchmark == null ? null : d.benchmark - 1 }));
  const id = useId();
  const gp = gid(id, "gp");
  const gb = gid(id, "gb");
  return (
    <ResponsiveContainer width="100%" height={260}>
      <ComposedChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <defs>
          <AreaGradient id={gp} color="var(--series-1)" via="var(--series-6)" top={0.75} />
          <AreaGradient id={gb} color="var(--series-2)" via="var(--accent-2)" top={0.5} />
        </defs>
        <CartesianGrid stroke="var(--grid)" vertical={false} />
        <XAxis dataKey="date" {...axis} minTickGap={48} />
        <YAxis {...axis} tickFormatter={pct} width={44} />
        <Tooltip {...tooltipStyle} formatter={(v, n) => [fmtPct(Number(v), 2), n]} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        {benchmark && <Area type="monotone" dataKey="benchmark" name={benchmark} stroke="var(--series-2)" fill={`url(#${gb})`} strokeWidth={2} connectNulls isAnimationActive={false} />}
        <Area type="monotone" dataKey="portfolio" name="พอร์ต (TWR)" stroke="var(--series-1)" fill={`url(#${gp})`} strokeWidth={2.5} isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

export function ValueChart({ data }: { data: { date: string; value: number; contributed: number }[] }) {
  const g = gid(useId(), "gv");
  return (
    <ResponsiveContainer width="100%" height={240}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <defs>
          <AreaGradient id={g} color="var(--series-1)" via="var(--series-5)" top={0.9} />
        </defs>
        <CartesianGrid stroke="var(--grid)" vertical={false} />
        <XAxis dataKey="date" {...axis} minTickGap={48} />
        <YAxis {...axis} tickFormatter={compactThb} width={48} />
        <Tooltip {...tooltipStyle} formatter={(v, n) => [fmtThb(Number(v)), n]} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Area type="monotone" dataKey="value" name="มูลค่าพอร์ต" stroke="var(--series-1)" fill={`url(#${g})`} strokeWidth={2.5} isAnimationActive={false} />
        <Line type="stepAfter" dataKey="contributed" name="เงินลงทุนสุทธิ" stroke="var(--series-2)" strokeWidth={2} dot={false} isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function PriceChart({ data, currency }: { data: { date: string; close: number }[]; currency: string }) {
  const g = gid(useId(), "gpr");
  return (
    <ResponsiveContainer width="100%" height={240}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <defs>
          <AreaGradient id={g} color="var(--series-1)" via="var(--series-6)" top={0.8} />
        </defs>
        <CartesianGrid stroke="var(--grid)" vertical={false} />
        <XAxis dataKey="date" {...axis} minTickGap={48} />
        <YAxis {...axis} domain={["auto", "auto"]} width={56} />
        <Tooltip {...tooltipStyle} formatter={(v) => [`${fmtNum(Number(v), 2)} ${currency}`, "ราคา"]} />
        <Area type="monotone" dataKey="close" stroke="var(--series-1)" fill={`url(#${g})`} baseValue="dataMin" strokeWidth={2} isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

type Pt = { volatility: number; expectedReturn: number };

/** Risk/return plane: random portfolios, efficient frontier, CML and key portfolios. */
export function FrontierChart({
  cloud,
  frontier,
  assets,
  current,
  tangency,
  minVariance,
  cml,
}: {
  cloud: Pt[];
  frontier: Pt[];
  assets: (Pt & { symbol: string })[];
  current: Pt;
  tangency: Pt | null;
  minVariance: Pt;
  cml: { intercept: number; slope: number } | null;
}) {
  const maxVol = Math.max(...assets.map((a) => a.volatility), current.volatility, tangency?.volatility ?? 0) * 1.1;
  const cmlLine = cml ? [0, maxVol].map((v) => ({ volatility: v, expectedReturn: cml.intercept + cml.slope * v })) : [];
  const fmt = (v: number) => `${fmtPct(v, 1)}`;
  return (
    <ResponsiveContainer width="100%" height={360}>
      <ComposedChart margin={{ top: 8, right: 16, left: 0, bottom: 16 }}>
        <CartesianGrid stroke="var(--grid)" />
        <XAxis type="number" dataKey="volatility" name="ความเสี่ยง (σ)" {...axis} tickFormatter={pct} domain={[0, maxVol]} label={{ value: "ความเสี่ยง σ (ต่อปี)", position: "insideBottom", offset: -8, fontSize: 11, fill: "var(--muted)" }} />
        <YAxis type="number" dataKey="expectedReturn" name="ผลตอบแทนคาดหวัง" {...axis} tickFormatter={pct} width={48} domain={["auto", "auto"]} />
        <Tooltip
          {...tooltipStyle}
          cursor={{ strokeDasharray: "3 3" }}
          formatter={(v, n) => [fmt(Number(v)), n === "volatility" ? "σ" : n === "expectedReturn" ? "E[R]" : n]}
          labelFormatter={() => ""}
        />
        <Legend wrapperStyle={{ fontSize: 12, paddingTop: 12 }} />
        <Scatter name="พอร์ตสุ่ม" data={cloud} fill="var(--muted)" fillOpacity={0.18} shape="circle" legendType="circle" isAnimationActive={false} />
        <Line name="Efficient frontier" data={frontier} dataKey="expectedReturn" stroke="var(--series-1)" strokeWidth={2} dot={false} isAnimationActive={false} />
        {cml && <Line name="Capital Market Line" data={cmlLine} dataKey="expectedReturn" stroke="var(--series-3)" strokeDasharray="5 4" strokeWidth={2} dot={false} isAnimationActive={false} />}
        <Scatter name="สินทรัพย์รายตัว" data={assets} fill="var(--series-4)" stroke="var(--panel-solid)" strokeWidth={2} isAnimationActive={false} />
        <Scatter name="พอร์ตปัจจุบัน" data={[current]} fill="var(--series-2)" stroke="var(--panel-solid)" strokeWidth={2} shape="diamond" isAnimationActive={false} />
        {tangency && <Scatter name="Max Sharpe" data={[tangency]} fill="var(--series-3)" stroke="var(--panel-solid)" strokeWidth={2} shape="star" isAnimationActive={false} />}
        <Scatter name="Min variance" data={[minVariance]} fill="var(--series-5)" stroke="var(--panel-solid)" strokeWidth={2} shape="triangle" isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

type Pt2 = { volatility: number; expectedReturn: number };

/** Details shown when an asset point of the bullet chart is hovered / tapped. */
export interface AssetPointDetail {
  name: string;
  assetClass: string;
  sector: string | null;
  beta: number | null;
  historicalReturn: number;
  capmReturn: number | null;
  /** Where the E[R] used comes from (method or "แก้เอง"). */
  muSource: string;
  currentWeight: number | null;
  recommendedWeight: number | null;
}

/** Default tooltip (lines / portfolio points); hidden while an asset point shows its own box. */
function BulletTip({
  active,
  payload,
  hideFor,
}: {
  active?: boolean;
  payload?: { name?: string; payload?: Pt2 }[];
  hideFor?: unknown;
}) {
  const p = payload?.[0]?.payload;
  if (hideFor || !active || !p) return null;
  const f = (v: number) => `${fmtPct(v, 1)}`;
  return (
    <div style={{ ...tooltipStyle.contentStyle, padding: "8px 10px" }}>
      {payload?.[0]?.name && <div style={{ color: "var(--muted)" }}>{payload[0].name}</div>}
      <div>
        σ {f(p.volatility)} · E[R] {f(p.expectedReturn)}
      </div>
    </div>
  );
}

/** Asset point details (hover on desktop, tap on mobile). */
function AssetTipBox({ p, rf }: { p: Pt2 & { symbol: string; detail?: AssetPointDetail }; rf: number }) {
  const f = (v: number | null | undefined, d = 1) => fmtPct(v, d);
  const d = p.detail;
  const sharpe = p.volatility > 0 ? (p.expectedReturn - rf) / p.volatility : null;
  const row = (k: string, v: string) => (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
      <span style={{ color: "var(--muted)" }}>{k}</span>
      <span style={{ fontVariantNumeric: "tabular-nums", textAlign: "right" }}>{v}</span>
    </div>
  );
  return (
    <div style={{ ...tooltipStyle.contentStyle, padding: "8px 10px", width: 250, boxShadow: "0 4px 16px rgba(0,0,0,.25)" }} data-testid="bullet-asset-tip">
      <div style={{ fontWeight: 600 }}>
        {p.symbol} {d && <span style={{ fontWeight: 400, color: "var(--muted)" }}>{d.name}</span>}
      </div>
      {d && (
        <div style={{ color: "var(--muted)", marginBottom: 4 }}>
          {d.assetClass} · {d.sector ?? "ยังไม่ระบุหมวด"}
        </div>
      )}
      {row("ความเสี่ยง σ ต่อปี", f(p.volatility))}
      {row(`E[R] ที่ใช้${d ? ` (${d.muSource})` : ""}`, f(p.expectedReturn))}
      {row("Sharpe (รายตัว)", sharpe == null ? "—" : fmtNum(sharpe, 2))}
      {d && (
        <>
          {row("β", d.beta == null ? "—" : fmtNum(d.beta, 2))}
          {row("μ ในอดีต / CAPM", `${f(d.historicalReturn)} / ${f(d.capmReturn)}`)}
          {row("น้ำหนัก ถือ → แนะนำ", `${d.currentWeight ? f(d.currentWeight) : "ไม่ได้ถือ"} → ${f(d.recommendedWeight)}`)}
        </>
      )}
    </div>
  );
}

/**
 * The Markowitz "bullet": minimum-variance set in risk/return space. Upper arm
 * (solid) is efficient, lower arm (dashed) inefficient. Shows both the
 * short-sales-allowed hyperbola and the constrained (e.g. long-only) set.
 */
export function BulletChart({
  unconstrained,
  constrained,
  assets,
  current,
  recommended,
  gmv,
  tangency,
  rf,
}: {
  unconstrained: (Pt2 & { efficient: boolean })[];
  constrained: (Pt2 & { efficient: boolean })[];
  assets: (Pt2 & { symbol: string; detail?: AssetPointDetail })[];
  current: Pt2 | null;
  recommended: Pt2;
  gmv: Pt2;
  tangency: Pt2 | null;
  rf: number;
}) {
  const maxVol = Math.max(...assets.map((a) => a.volatility), ...constrained.map((p) => p.volatility), recommended.volatility, current?.volatility ?? 0) * 1.15;
  // Keep the short-sales hyperbola to a return band around the assets so the bullet shape stays readable.
  const rets = assets.map((a) => a.expectedReturn);
  const band = Math.max(Math.max(...rets) - Math.min(...rets), 0.02) * 0.35;
  const lo = Math.min(...rets) - band;
  const hi = Math.max(...rets) + band;
  unconstrained = unconstrained.filter((p) => p.expectedReturn >= lo && p.expectedReturn <= hi);
  const clip = (pts: (Pt2 & { efficient: boolean })[], eff: boolean) => pts.filter((p) => p.efficient === eff && p.volatility <= maxVol);
  // Join the two arms at the GMV point so the curve is continuous.
  const arm = (pts: (Pt2 & { efficient: boolean })[], eff: boolean, join: Pt2) => {
    const a = clip(pts, eff).map(({ volatility, expectedReturn }) => ({ volatility, expectedReturn }));
    return eff ? [join, ...a] : [...a, join];
  };
  const slope = tangency && tangency.volatility > 0 ? (tangency.expectedReturn - rf) / tangency.volatility : null;
  const cml =
    slope != null
      ? [
          { volatility: 0, expectedReturn: rf },
          { volatility: maxVol, expectedReturn: rf + slope * maxVol },
        ]
      : [];
  const [hover, setHover] = useState<{ symbol: string; x: number; y: number } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const hoverAsset = hover ? (assets.find((a) => a.symbol === hover.symbol) ?? null) : null;
  const hoverAt = hover ? { x: hover.x, y: hover.y } : null;
  // Recharts passes the point with its pixel position (cx, cy) inside the chart.
  const pick = (d: unknown) => {
    const q = d as { symbol?: string; cx?: number; cy?: number; payload?: { symbol?: string } };
    const symbol = q.symbol ?? q.payload?.symbol;
    setHover(symbol && q.cx != null && q.cy != null ? { symbol, x: q.cx, y: q.cy } : null);
  };
  const uncGmv = unconstrained.reduce((m, p) => (p.volatility < m.volatility ? p : m), unconstrained[0] ?? gmv);
  return (
    <div className="relative" ref={boxRef}>
    <ResponsiveContainer width="100%" height={420}>
      <ComposedChart margin={{ top: 8, right: 16, left: 0, bottom: 16 }}>
        <CartesianGrid stroke="var(--grid)" />
        <XAxis type="number" dataKey="volatility" {...axis} tickFormatter={pct} domain={[0, maxVol]} allowDataOverflow label={{ value: "ความเสี่ยง σ (ต่อปี)", position: "insideBottom", offset: -8, fontSize: 11, fill: "var(--muted)" }} />
        <YAxis type="number" dataKey="expectedReturn" {...axis} tickFormatter={pct} width={48} domain={["auto", "auto"]} allowDataOverflow />
        <Tooltip cursor={{ strokeDasharray: "3 3" }} content={<BulletTip hideFor={hoverAsset} />} />
        <Legend wrapperStyle={{ fontSize: 12, paddingTop: 12 }} />
        {unconstrained.length > 0 && (
          <>
            <Line name="Frontier ขายชอร์ตได้ (สูตรปิด — ลงทุนจริงไม่ได้ถ้าห้าม short)" data={arm(unconstrained, true, uncGmv)} dataKey="expectedReturn" stroke="var(--muted)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
            <Line name="ส่วนไม่มีประสิทธิภาพ (ขายชอร์ตได้)" data={arm(unconstrained, false, uncGmv)} dataKey="expectedReturn" stroke="var(--muted)" strokeWidth={1.5} strokeDasharray="4 4" dot={false} isAnimationActive={false} legendType="none" />
          </>
        )}
        <Line name="Efficient frontier ตามข้อจำกัด (ลงทุนได้จริง)" data={arm(constrained, true, gmv)} dataKey="expectedReturn" stroke="var(--series-1)" strokeWidth={2.5} dot={false} isAnimationActive={false} />
        <Line name="ส่วนไม่มีประสิทธิภาพ" data={arm(constrained, false, gmv)} dataKey="expectedReturn" stroke="var(--series-1)" strokeWidth={2} strokeDasharray="5 4" dot={false} isAnimationActive={false} />
        {cml.length > 0 && <Line name="Capital Market Line (จาก Rf)" data={cml} dataKey="expectedReturn" stroke="var(--series-3)" strokeWidth={2} strokeDasharray="6 4" dot={false} isAnimationActive={false} />}
        {/* Scatter points do not drive this composed chart's tooltip: track the hovered / tapped asset ourselves. */}
        <Scatter
          name="สินทรัพย์"
          data={assets}
          fill="var(--series-4)"
          stroke="var(--panel-solid)"
          strokeWidth={2}
          isAnimationActive={false}
          onMouseEnter={(d) => pick(d)}
          onMouseLeave={() => setHover(null)}
          onClick={(d) => pick(d)}
          style={{ cursor: "pointer" }}
        />
        {current && <Scatter name="พอร์ตปัจจุบัน" data={[current]} fill="var(--series-2)" stroke="var(--panel-solid)" strokeWidth={2} shape="diamond" isAnimationActive={false} />}
        <Scatter name="Min variance" data={[gmv]} fill="var(--series-5)" stroke="var(--panel-solid)" strokeWidth={2} shape="triangle" isAnimationActive={false} />
        {tangency && <Scatter name="Max Sharpe (tangency)" data={[tangency]} fill="var(--series-3)" stroke="var(--panel-solid)" strokeWidth={2} shape="star" isAnimationActive={false} />}
        <Scatter name="Rf" data={[{ volatility: 0, expectedReturn: rf }]} fill="var(--series-3)" stroke="var(--panel-solid)" strokeWidth={2} isAnimationActive={false} legendType="none" />
        <Scatter name="แนะนำ" data={[recommended]} fill="var(--series-6)" stroke="var(--panel-solid)" strokeWidth={2} shape="square" isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer>
      {hoverAsset && hoverAt && (
        <div
          className="pointer-events-none absolute z-10"
          style={{
            top: Math.max(4, Math.min(hoverAt.y - 20, 420 - 210)),
            ...(hoverAt.x < (boxRef.current?.clientWidth ?? 0) / 2 ? { left: hoverAt.x + 14 } : { right: (boxRef.current?.clientWidth ?? 0) - hoverAt.x + 14 }),
          }}
        >
          <AssetTipBox p={hoverAsset} rf={rf} />
        </div>
      )}
    </div>
  );
}

export function DrawdownChart({ data }: { data: { date: string; drawdown: number }[] }) {
  const g = gid(useId(), "gdd");
  return (
    <ResponsiveContainer width="100%" height={180}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <defs>
          {/* The fill hangs just below the zero line, so the strong end of the gradient sits at the top. */}
          <AreaGradient id={g} color="var(--neg)" via="var(--series-5)" top={0.75} />
        </defs>
        <CartesianGrid stroke="var(--grid)" vertical={false} />
        <XAxis dataKey="date" {...axis} minTickGap={48} />
        <YAxis {...axis} tickFormatter={pct} width={44} />
        <Tooltip {...tooltipStyle} formatter={(v) => [fmtPct(Number(v), 2), "Drawdown"]} />
        <Area type="monotone" dataKey="drawdown" name="Drawdown" stroke="var(--neg)" fill={`url(#${g})`} strokeWidth={1.5} isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

const SERIES = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)", "var(--series-5)", "var(--series-6)"];

/** Stacked weights at each rebalance (after trading), cash on top. Colors repeat beyond six series. */
export function WeightsChart({ data, symbols }: { data: Record<string, number | string>[]; symbols: string[] }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} stackOffset="expand">
        <CartesianGrid stroke="var(--grid)" vertical={false} />
        <XAxis dataKey="date" {...axis} minTickGap={48} />
        <YAxis {...axis} tickFormatter={pct} width={44} />
        <Tooltip {...tooltipStyle} formatter={(v, n) => [fmtPct(Number(v), 1), n]} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        {symbols.map((s, i) => (
          <Area key={s} type="stepAfter" dataKey={s} stackId="w" stroke={SERIES[i % SERIES.length]} fill={SERIES[i % SERIES.length]} fillOpacity={0.65} isAnimationActive={false} />
        ))}
        <Area type="stepAfter" dataKey="เงินสด" stackId="w" stroke="var(--muted)" fill="var(--muted)" fillOpacity={0.25} isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/**
 * Several models on one shared scale (same unit, compared on purpose): one 2px line per model in a
 * fixed colour order, the benchmark as a dashed neutral line. `percent` formats values as % (drawdown).
 */
export function ModelLinesChart({ data, series, benchmark, percent = false, height = 280 }: { data: Record<string, number | string | null>[]; series: { key: string; name: string }[]; benchmark?: string | null; percent?: boolean; height?: number }) {
  const f = (v: number) => (percent ? `${fmtPct(v, 1)}` : fmtNum(v, 1));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid stroke="var(--grid)" vertical={false} />
        <XAxis dataKey="date" {...axis} minTickGap={48} />
        <YAxis {...axis} width={48} domain={["auto", "auto"]} tickFormatter={(v) => (percent ? pct(Number(v)) : fmtNum(Number(v), 0))} />
        <Tooltip {...tooltipStyle} formatter={(v, n) => [f(Number(v)), n]} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        {benchmark && <Line type="linear" dataKey="benchmark" name={benchmark} stroke="var(--muted)" strokeDasharray="4 3" strokeWidth={1.5} dot={false} connectNulls isAnimationActive={false} />}
        {series.map((m, i) => (
          <Line key={m.key} type="linear" dataKey={m.key} name={m.name} stroke={SERIES[i % SERIES.length]} strokeWidth={2} dot={false} isAnimationActive={false} />
        ))}
      </ComposedChart>
    </ResponsiveContainer>
  );
}

const INCOME_SERIES = [
  { key: "received", name: "ได้รับแล้ว (บัญชี)", color: "var(--pos)" },
  { key: "missing_confirmation", name: "ถึงกำหนดแต่ยังไม่บันทึก", color: "var(--warn)" },
  { key: "announced", name: "ประกาศแล้ว", color: "var(--info)" },
  { key: "estimated", name: "ประมาณการ", color: "var(--series-5)" },
] as const;

/** Monthly dividend income (THB, net of withholding) stacked by status. */
export function IncomeChart({ data }: { data: { period: string; received: number; announced: number; missing_confirmation: number; estimated: number }[] }) {
  const id = useId();
  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <defs>
          {INCOME_SERIES.map((sr) => (
            <linearGradient key={sr.key} id={gid(id, sr.key)} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={sr.color} stopOpacity={0.95} />
              <stop offset="100%" stopColor={sr.color} stopOpacity={0.45} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid stroke="var(--grid)" vertical={false} />
        <XAxis dataKey="period" {...axis} minTickGap={16} />
        <YAxis {...axis} tickFormatter={compactThb} width={48} />
        <Tooltip {...tooltipStyle} formatter={(v, n) => [fmtThb(Number(v)), n]} cursor={{ fill: "var(--panel-2)" }} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        {INCOME_SERIES.map((sr) => (
          <Bar key={sr.key} dataKey={sr.key} name={sr.name} stackId="i" fill={`url(#${gid(id, sr.key)})`} isAnimationActive={false} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Yearly ladder cashflows: coupons vs principal returned (THB). */
export function LadderCashflowChart({ data }: { data: { year: string; coupon: number; principal: number }[] }) {
  const id = useId();
  const series = [
    { key: "coupon", name: "ดอกเบี้ย (คูปอง)", color: "var(--series-3)" },
    { key: "principal", name: "เงินต้นครบกำหนด", color: "var(--series-1)" },
  ];
  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <defs>
          {series.map((sr) => (
            <linearGradient key={sr.key} id={gid(id, sr.key)} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={sr.color} stopOpacity={0.95} />
              <stop offset="100%" stopColor={sr.color} stopOpacity={0.45} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid stroke="var(--grid)" vertical={false} />
        <XAxis dataKey="year" {...axis} />
        <YAxis {...axis} tickFormatter={compactThb} width={48} />
        <Tooltip {...tooltipStyle} formatter={(v, n) => [fmtThb(Number(v)), n]} cursor={{ fill: "var(--panel-2)" }} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        {series.map((sr) => (
          <Bar key={sr.key} dataKey={sr.key} name={sr.name} stackId="c" fill={`url(#${gid(id, sr.key)})`} isAnimationActive={false} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Residual-income waterfall: B₀, each year's PV(RI), PV(continuing value), stacked on an invisible base. */
export function RiWaterfallChart({ steps }: { steps: { label: string; delta: number; kind: "book" | "ri" | "cv" | "total" }[] }) {
  let run = 0;
  const data = steps.map((s) => {
    const start = s.kind === "total" || s.kind === "book" ? 0 : run;
    const end = s.kind === "total" ? s.delta : start + s.delta;
    if (s.kind !== "total") run = end;
    return { label: s.label, base: Math.min(start, end), size: Math.abs(end - start), delta: s.delta, kind: s.kind };
  });
  const color = (k: string, d: number) => (k === "book" ? "var(--series-1)" : k === "cv" ? "var(--series-5)" : k === "total" ? "var(--series-6)" : d >= 0 ? "var(--series-3)" : "var(--series-2)");
  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid stroke="var(--grid)" vertical={false} />
        <XAxis dataKey="label" {...axis} interval={0} fontSize={10} />
        <YAxis {...axis} width={44} tickFormatter={(v) => fmtNum(Number(v), 0)} />
        <Tooltip {...tooltipStyle} cursor={{ fill: "var(--panel-2)" }} formatter={(_v, _n, p) => [fmtNum((p.payload as { delta: number }).delta, 2), "ต่อหุ้น"]} />
        <Bar dataKey="base" stackId="w" fill="transparent" isAnimationActive={false} />
        <Bar dataKey="size" stackId="w" radius={[4, 4, 0, 0]} isAnimationActive={false}>
          {data.map((d, i) => (
            <Cell key={i} fill={color(d.kind, d.delta)} fillOpacity={0.85} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/** ROE by forecast year against the cost of equity: the gap is what creates residual income. */
export function RoeKeChart({ data, ke }: { data: { year: string; roe: number }[]; ke: number }) {
  const id = useId();
  return (
    <ResponsiveContainer width="100%" height={220}>
      <ComposedChart data={data.map((d) => ({ ...d, ke }))} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <defs>
          <AreaGradient id={gid(id, "roe")} color="var(--series-3)" />
        </defs>
        <CartesianGrid stroke="var(--grid)" vertical={false} />
        <XAxis dataKey="year" {...axis} />
        <YAxis {...axis} width={44} tickFormatter={pct} domain={[0, "auto"]} />
        <Tooltip {...tooltipStyle} formatter={(v, n) => [fmtPct(Number(v), 2), n]} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Area type="monotone" dataKey="roe" name="ROE" stroke="var(--series-3)" strokeWidth={2} fill={`url(#${gid(id, "roe")})`} isAnimationActive={false} />
        <Line type="stepAfter" dataKey="ke" name="Ke" stroke="var(--series-2)" strokeDasharray="5 4" dot={false} strokeWidth={2} isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
