"use client";

/**
 * Asset page: price chart + "ความผิดปกติการซื้อขาย" section (Thai stocks only).
 * Data comes from GET /api/v1/assets/{id}/abnormal — the same service as the MCP tools — fetched after
 * the page renders so the price chart never waits for it. Charts share the price chart's dates and
 * syncId, so the cursor follows the same day everywhere. Display only; nothing is recomputed here.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import Link from "next/link";
import {
  Bar,
  Cell,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  CartesianGrid,
} from "recharts";
import { Empty, Section } from "./ui";
import { PriceMetricChart, type OverlayMetric } from "./PriceMetricChart";
import {
  EVENT_LABEL,
  LEVEL_COLOR,
  RANGES,
  chartRows,
  flagRows,
  fmtPct,
  fmtT,
  markers as markersOf,
  qualityNotes,
  rangeDomain,
  statusBadge,
  viewState,
  type AbnormalOverview,
  type ChartRow,
  type RangeKey,
} from "@/lib/finance/abnormal/view";

const SYNC = "asset-price";
const axis = {
  stroke: "var(--muted)",
  fontSize: 11,
  tickLine: false,
  axisLine: false,
} as const;
const dateTick = (t: number) => new Date(t).toISOString().slice(0, 7);
const DISCLAIMER = "เป็นสัญญาณทางสถิติ ไม่ใช่หลักฐานการกระทำผิด";

function useStored<T extends string>(
  key: string,
  initial: T,
  allowed: readonly T[],
) {
  const [v, setV] = useState<T>(initial);
  useEffect(() => {
    try {
      const s = localStorage.getItem(key) as T | null;
      if (s && allowed.includes(s)) setV(s);
    } catch {
      /* storage unavailable */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const set = (x: T) => {
    setV(x);
    try {
      localStorage.setItem(key, x);
    } catch {
      /* ignore */
    }
  };
  return [v, set] as const;
}

export function AssetPriceWithAbnormal({
  assetId,
  symbol,
  isThaiStock,
  prices,
  currency,
  metrics,
  children,
}: {
  assetId: number;
  symbol: string;
  isThaiStock: boolean;
  prices: { date: string; close: number }[];
  currency: string;
  metrics: OverlayMetric[];
  children?: React.ReactNode;
}) {
  const [range, setRange] = useStored<RangeKey>("price-range", "ALL", [
    "1Y",
    "3Y",
    "5Y",
    "ALL",
  ]);
  const [markersOn, setMarkersOn] = useStored<"on" | "off">(
    "abnormal-markers",
    "on",
    ["on", "off"],
  );
  const [rightAxis, setRightAxis] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [data, setData] = useState<AbnormalOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(isThaiStock);
  const [thresholds, setThresholds] = useState<{
    notable: number;
    abnormal: number;
  } | null>(null);

  const load = useCallback(async () => {
    if (!isThaiStock) return;
    setLoading(true);
    setError(null);
    try {
      const q = thresholds
        ? `?notable=${thresholds.notable}&abnormal=${thresholds.abnormal}`
        : "";
      const r = await fetch(`/api/v1/assets/${assetId}/abnormal${q}`, {
        cache: "no-store",
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setData(j as AbnormalOverview);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [assetId, isThaiStock, thresholds]);
  useEffect(() => {
    void load();
  }, [load]);

  const priceDates = useMemo(() => prices.map((p) => p.date).sort(), [prices]);
  const domain = useMemo(
    () => rangeDomain(priceDates, range),
    [priceDates, range],
  );
  const marks = useMemo(
    () => (data && markersOn === "on" ? markersOf(data, domain) : []),
    [data, markersOn, domain],
  );
  const pick = (date: string) => {
    setHighlight(date);
    const d = Date.parse(`${date}T00:00:00Z`);
    if (domain && (d < domain[0] || d > domain[1])) setRange("ALL");
  };

  return (
    <>
      <Section
        title={`ราคา (${currency})`}
        action={
          prices.length > 1 && (
            <div className="flex flex-wrap items-center gap-2">
              {isThaiStock && (
                <label className="inline-flex items-center gap-1.5 text-xs text-muted">
                  <input
                    type="checkbox"
                    checked={markersOn === "on"}
                    onChange={(e) =>
                      setMarkersOn(e.target.checked ? "on" : "off")
                    }
                    aria-label="แสดง event และวันที่ผิดปกติบนกราฟราคา"
                  />
                  Event / วันผิดปกติ
                </label>
              )}
              <div
                role="group"
                aria-label="ช่วงเวลา"
                className="inline-flex rounded-lg border border-border p-0.5 text-xs"
              >
                {RANGES.map((r) => (
                  <button
                    key={r.key}
                    type="button"
                    aria-pressed={range === r.key}
                    className={clsx(
                      "rounded-md px-2 py-0.5",
                      range === r.key
                        ? "bg-panel-2 font-medium text-text"
                        : "text-muted",
                    )}
                    onClick={() => setRange(r.key)}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            </div>
          )
        }
      >
        {prices.length > 1 ? (
          <PriceMetricChart
            assetId={assetId}
            prices={prices}
            currency={currency}
            metrics={metrics}
            link={{
              syncId: SYNC,
              xDomain: domain,
              markers: marks,
              highlight,
              onRightAxis: setRightAxis,
            }}
          />
        ) : (
          <Empty>ยังไม่มีประวัติราคา</Empty>
        )}
        {isThaiStock && marks.length > 0 && (
          <p className="mt-2 text-[11px] text-muted">
            <span style={{ color: "var(--accent)" }}>┆</span> event ·{" "}
            <span style={{ color: LEVEL_COLOR["ผิดปกติ"] }}>●</span> ผิดปกติ ·{" "}
            <span style={{ color: LEVEL_COLOR["น่าสังเกต"] }}>●</span> น่าสังเกต
          </p>
        )}
        {children && <div className="mt-4">{children}</div>}
      </Section>
      {isThaiStock && (
        <AbnormalTradingSection
          symbol={symbol}
          data={data}
          error={error}
          loading={loading}
          priceDates={priceDates}
          domain={domain}
          rightAxis={rightAxis}
          highlight={highlight}
          onPick={pick}
          onThresholds={setThresholds}
          reload={load}
        />
      )}
    </>
  );
}

function Badge({
  level,
  children,
}: {
  level: string;
  children: React.ReactNode;
}) {
  const color =
    LEVEL_COLOR[level as keyof typeof LEVEL_COLOR] ?? "var(--muted)";
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium"
      style={{
        borderColor: color,
        color: level === "ปกติ" ? "var(--text)" : color,
      }}
    >
      <span
        className="inline-block h-2 w-2 rounded-full"
        style={{ background: level === "ปกติ" ? "var(--pos)" : color }}
        aria-hidden
      />
      {children}
    </span>
  );
}

function RowTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: { payload: ChartRow }[];
}) {
  if (!active || !payload?.length) return null;
  const r = payload[0].payload;
  return (
    <div className="rounded-lg border border-border bg-panel-solid px-3 py-2 text-xs shadow-lg">
      <div className="mb-1 font-medium">{r.date}</div>
      <div>
        AR:{" "}
        <span className="tabular-nums">
          {r.arPct == null ? "– (ไม่มีข้อมูลตลาด)" : `${r.arPct.toFixed(2)}%`}
        </span>
      </div>
      <div>
        CAR 5 วัน:{" "}
        <span className="tabular-nums">
          {r.car5Pct == null ? "–" : `${r.car5Pct.toFixed(2)}%`}
        </span>
      </div>
      <div>
        Volume z:{" "}
        <span className="tabular-nums">
          {r.z == null ? "–" : r.z.toFixed(2)}
        </span>
        {r.volume != null && (
          <span className="text-muted">
            {" "}
            · {r.volume.toLocaleString("en-US")} หุ้น
          </span>
        )}
      </div>
      {r.level !== "ปกติ" && (
        <div style={{ color: LEVEL_COLOR[r.level] }}>● {r.level}</div>
      )}
    </div>
  );
}

function AbnormalTradingSection({
  symbol,
  data,
  error,
  loading,
  priceDates,
  domain,
  rightAxis,
  highlight,
  onPick,
  onThresholds,
  reload,
}: {
  symbol: string;
  data: AbnormalOverview | null;
  error: string | null;
  loading: boolean;
  priceDates: string[];
  domain: [number, number] | null;
  rightAxis: boolean;
  highlight: string | null;
  onPick: (date: string) => void;
  onThresholds: (t: { notable: number; abnormal: number }) => void;
  reload: () => void;
}) {
  const state = viewState(data, error, loading);
  const rows = useMemo(
    () => (data ? chartRows(priceDates, data.stock.days, domain) : []),
    [data, priceDates, domain],
  );
  const margin = { top: 8, right: rightAxis ? 52 : 8, left: 0, bottom: 0 };
  const hl = highlight ? Date.parse(`${highlight}T00:00:00Z`) : null;

  return (
    <Section
      title="ความผิดปกติการซื้อขาย"
      subtitle="Abnormal return (market model) + abnormal volume · รายวัน"
      className="min-w-0"
    >
      <div
        data-testid="abnormal-section"
        data-state={state.kind}
        className="space-y-4"
      >
        {state.kind === "loading" && (
          <p className="text-sm text-muted" role="status">
            กำลังคำนวณ…
          </p>
        )}
        {state.kind === "error" && (
          <div
            className="rounded-xl border border-neg/40 p-3 text-sm"
            role="alert"
          >
            <p className="font-medium text-neg">โหลดข้อมูลไม่สำเร็จ</p>
            <p className="mt-1 text-muted">{state.message}</p>
            <button type="button" className="btn-ghost mt-2" onClick={reload}>
              ลองอีกครั้ง
            </button>
          </div>
        )}
        {state.kind === "insufficient" && (
          <div className="rounded-xl border border-border p-3 text-sm">
            <p className="font-medium">ข้อมูลยังไม่พอสำหรับวิเคราะห์</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted">
              {state.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
            <Link href="/holdings" className="btn-ghost mt-2 inline-block">
              ไปดึงราคาย้อนหลัง (sync)
            </Link>
          </div>
        )}
        {data && (state.kind === "flags" || state.kind === "no_flags") && (
          <>
            <StatusLine data={data} domain={domain} />
            {state.limits.map((l) => (
              <p
                key={l}
                className="rounded-lg border border-warn/40 px-3 py-2 text-xs text-warn"
              >
                {l}
              </p>
            ))}
            <div>
              <div className="mb-1 flex justify-between text-[10px] text-muted">
                <span>
                  Abnormal return (แท่ง, %) · CAR 5 วัน (เส้น, %) · แถบ ±2σ(ε)
                </span>
              </div>
              <ResponsiveContainer width="100%" height={170}>
                <ComposedChart
                  data={rows}
                  syncId={SYNC}
                  syncMethod="value"
                  margin={margin}
                >
                  <CartesianGrid stroke="var(--grid)" vertical={false} />
                  <XAxis
                    dataKey="t"
                    type="number"
                    scale="time"
                    domain={domain ?? ["dataMin", "dataMax"]}
                    tickFormatter={dateTick}
                    {...axis}
                    minTickGap={48}
                  />
                  <YAxis
                    {...axis}
                    width={56}
                    tickFormatter={(v) => `${Number(v).toFixed(0)}%`}
                  />
                  <Tooltip content={<RowTooltip />} />
                  <ReferenceLine y={0} stroke="var(--border)" />
                  <Line
                    dataKey="bandPct"
                    stroke="var(--muted)"
                    strokeDasharray="2 3"
                    strokeWidth={1}
                    dot={false}
                    isAnimationActive={false}
                    connectNulls={false}
                  />
                  <Line
                    dataKey="negBandPct"
                    stroke="var(--muted)"
                    strokeDasharray="2 3"
                    strokeWidth={1}
                    dot={false}
                    isAnimationActive={false}
                    connectNulls={false}
                  />
                  <Bar dataKey="arPct" isAnimationActive={false}>
                    {rows.map((r) => (
                      <Cell
                        key={r.t}
                        fill={
                          r.level !== "ปกติ"
                            ? LEVEL_COLOR[r.level]
                            : "var(--series-1)"
                        }
                      />
                    ))}
                  </Bar>
                  <Line
                    dataKey="car5Pct"
                    stroke="var(--series-3)"
                    strokeWidth={1.5}
                    dot={false}
                    isAnimationActive={false}
                    connectNulls={false}
                  />
                  {hl && <ReferenceLine x={hl} stroke="var(--text)" />}
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <div>
              <div className="mb-1 text-[10px] text-muted">
                Volume z-score (
                {data.stock.volumeBasis === "turnover"
                  ? "log turnover"
                  : "log raw volume"}
                ) · เส้นประ = เกณฑ์ {data.thresholds.notable} /{" "}
                {data.thresholds.abnormal}
              </div>
              <ResponsiveContainer width="100%" height={140}>
                <ComposedChart
                  data={rows}
                  syncId={SYNC}
                  syncMethod="value"
                  margin={margin}
                >
                  <CartesianGrid stroke="var(--grid)" vertical={false} />
                  <XAxis
                    dataKey="t"
                    type="number"
                    scale="time"
                    domain={domain ?? ["dataMin", "dataMax"]}
                    tickFormatter={dateTick}
                    {...axis}
                    minTickGap={48}
                  />
                  <YAxis
                    {...axis}
                    width={56}
                    tickFormatter={(v) => Number(v).toFixed(0)}
                  />
                  <Tooltip content={<RowTooltip />} />
                  <ReferenceLine
                    y={data.thresholds.notable}
                    stroke="var(--warn)"
                    strokeDasharray="3 3"
                  />
                  <ReferenceLine
                    y={data.thresholds.abnormal}
                    stroke="var(--neg)"
                    strokeDasharray="3 3"
                  />
                  <ReferenceLine y={0} stroke="var(--border)" />
                  <Bar dataKey="z" isAnimationActive={false}>
                    {rows.map((r) => (
                      <Cell
                        key={r.t}
                        fill={
                          r.z != null && r.z > data.thresholds.abnormal
                            ? LEVEL_COLOR["ผิดปกติ"]
                            : r.z != null && r.z > data.thresholds.notable
                              ? LEVEL_COLOR["น่าสังเกต"]
                              : "var(--series-2)"
                        }
                      />
                    ))}
                  </Bar>
                  {hl && <ReferenceLine x={hl} stroke="var(--text)" />}
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <FlagTable
              data={data}
              domain={domain}
              highlight={highlight}
              onPick={onPick}
            />
          </>
        )}
        {data && state.kind !== "error" && (
          <>
            <EventStudyPanel symbol={symbol} data={data} onRecorded={reload} />
            <SettingsPanel data={data} onApply={onThresholds} />
          </>
        )}
        <p className="text-[11px] text-muted">
          <strong>{DISCLAIMER}</strong> —
          ราคาและปริมาณผิดปกติเกิดได้จากหลายสาเหตุ ที่ |t| &gt; 2
          คาดว่าจะมีวันถูก flag โดยบังเอิญราว 5% ของวัน · รายละเอียด
          docs/abnormal-trading.md
        </p>
      </div>
    </Section>
  );
}

function StatusLine({
  data,
  domain,
}: {
  data: AbnormalOverview;
  domain: [number, number] | null;
}) {
  const b = statusBadge(data, domain);
  return (
    <div
      className="flex flex-wrap items-center gap-2 text-xs"
      data-testid="abnormal-status"
    >
      <Badge level={b.worst}>
        {b.worst === "ปกติ" ? "ไม่พบความผิดปกติ" : b.worst}
      </Badge>
      <span className="text-muted">{b.text}</span>
      {b.latestDate && (
        <span className="text-muted">
          · ล่าสุด {b.latestDate}:{" "}
          <span
            style={{
              color:
                b.latestLevel && b.latestLevel !== "ปกติ"
                  ? LEVEL_COLOR[b.latestLevel]
                  : undefined,
            }}
          >
            {b.latestLevel}
          </span>
        </span>
      )}
      <span className="text-muted">· เทียบ {data.stock.benchmark.label}</span>
    </div>
  );
}

function FlagTable({
  data,
  domain,
  highlight,
  onPick,
}: {
  data: AbnormalOverview;
  domain: [number, number] | null;
  highlight: string | null;
  onPick: (d: string) => void;
}) {
  const { rows, hidden } = flagRows(data, domain);
  if (!data.stock.flagged.length)
    return (
      <p className="text-sm text-muted" data-testid="no-flags">
        ไม่พบวันที่ผิดปกติตามเกณฑ์ ({data.criteria["น่าสังเกต"]})
      </p>
    );
  return (
    <div className="min-w-0">
      <div className="mb-1 text-xs font-medium">
        วันที่ถูก flag ({rows.length}
        {hidden ? ` · อีก ${hidden} วันอยู่นอกช่วงที่แสดง` : ""}) —
        คลิกเพื่อดูบนกราฟ
      </div>
      <div className="max-h-80 overflow-auto">
        <table className="table text-xs" data-testid="flag-table">
          <thead>
            <tr>
              <th>วันที่</th>
              <th>ระดับ</th>
              <th className="num">AR</th>
              <th className="num">t</th>
              <th className="num">Vol z</th>
              <th className="num">CAR 5 วัน</th>
              <th className="num">t</th>
              <th>หมายเหตุ</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((f) => (
              <tr
                key={f.date}
                onClick={() => onPick(f.date)}
                className={clsx(
                  "cursor-pointer",
                  highlight === f.date && "bg-panel-2",
                )}
                tabIndex={0}
                onKeyDown={(e) => e.key === "Enter" && onPick(f.date)}
              >
                <td className="whitespace-nowrap">{f.date}</td>
                <td
                  style={{ color: LEVEL_COLOR[f.level] }}
                  className="whitespace-nowrap"
                >
                  ● {f.level}
                </td>
                <td className="num">{fmtPct(f.ar)}</td>
                <td className="num">{fmtT(f.tAR)}</td>
                <td className="num">{fmtT(f.z)}</td>
                <td className="num">{fmtPct(f.car5)}</td>
                <td className="num">{fmtT(f.tCAR5)}</td>
                <td className="min-w-48 text-muted">
                  {f.preEventLabel && (
                    <div className="font-medium text-text">
                      {f.preEventLabel}
                    </div>
                  )}
                  {[...f.reasons, ...f.warnings].join(" · ")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

type EsResult = {
  ok: boolean;
  code?: string;
  reason?: string;
  modelLabel: string;
  day0?: string;
  benchmark: { label: string };
  estimation?: { from: string; to: string; n: number };
  fit?: {
    alpha: number;
    beta: number;
    sigma: number;
    r2: number | null;
    n: number;
    betas?: number[];
  };
  days?: {
    rel: number;
    date: string;
    ar: number | null;
    t: number | null;
    car: number | null;
    carT: number | null;
    warnings: string[];
  }[];
  cars?: {
    label: string;
    t1: number;
    t2: number;
    value: number;
    t: number | null;
    days: number;
  }[];
  volume?: {
    ok: boolean;
    reason?: string;
    days?: { rel: number; z: number }[];
  };
  warnings: string[];
  error?: string;
};

function EventStudyPanel({
  symbol,
  data,
  onRecorded,
}: {
  symbol: string;
  data: AbnormalOverview;
  onRecorded: () => void;
}) {
  const [date, setDate] = useState(data.events[0]?.eventDate ?? "");
  const [model, setModel] = useState("market");
  const [res, setRes] = useState<EsResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const run = async () => {
    if (!date) return;
    setBusy(true);
    try {
      const r = await fetch(
        `/api/v1/abnormal/event-study?symbol=${encodeURIComponent(symbol)}&eventDate=${date}&model=${model}`,
        { cache: "no-store" },
      );
      const j = (await r.json()) as EsResult;
      setRes(
        r.ok
          ? j
          : {
              ...j,
              ok: false,
              reason: j.error ?? `HTTP ${r.status}`,
              warnings: [],
            },
      );
    } finally {
      setBusy(false);
    }
  };
  const record = async (f: FormData) => {
    setMsg(null);
    const body = {
      symbol,
      eventDate: String(f.get("eventDate")),
      eventType: String(f.get("eventType")),
      description: String(f.get("description") ?? ""),
      source: String(f.get("source") ?? "") || undefined,
    };
    const r = await fetch("/api/v1/stock-events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!r.ok) setMsg(`บันทึกไม่สำเร็จ: ${j.error ?? r.status}`);
    else {
      setMsg(`บันทึก event ${body.eventDate} แล้ว`);
      onRecorded();
    }
  };
  const vz = new Map((res?.volume?.days ?? []).map((d) => [d.rel, d.z]));
  return (
    <details
      className="rounded-xl border border-border p-3"
      data-testid="event-study-panel"
    >
      <summary className="cursor-pointer text-sm font-medium">
        Event study (AR / CAR รอบวันข่าว)
      </summary>
      <div className="mt-3 space-y-3 text-xs">
        <div className="flex flex-wrap items-end gap-2">
          <label className="grid gap-1">
            <span className="text-muted">Event ที่บันทึกไว้</span>
            <select
              className="input w-auto"
              value={data.events.some((e) => e.eventDate === date) ? date : ""}
              onChange={(e) => setDate(e.target.value)}
            >
              <option value="">— เลือก —</option>
              {data.events.map((e) => (
                <option
                  key={`${e.eventDate}-${e.id ?? "xd"}`}
                  value={e.eventDate}
                >
                  {e.eventDate} · {EVENT_LABEL[e.eventType] ?? e.eventType}{" "}
                  {e.description}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1">
            <span className="text-muted">หรือวันที่ข่าว</span>
            <input
              className="input w-auto"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
          <label className="grid gap-1">
            <span className="text-muted">Model</span>
            <select
              className="input w-auto"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            >
              <option value="market">Market model (OLS)</option>
              <option value="dimson">Dimson (หุ้นซื้อขายไม่ต่อเนื่อง)</option>
              <option value="market_adjusted">Market-adjusted</option>
            </select>
          </label>
          <button
            type="button"
            className="btn"
            disabled={!date || busy}
            onClick={run}
          >
            {busy ? "กำลังคำนวณ…" : "คำนวณ"}
          </button>
        </div>
        {res && !res.ok && (
          <p className="text-warn" role="alert">
            คำนวณไม่ได้: {res.reason}
          </p>
        )}
        {res?.ok && res.fit && (
          <div className="space-y-2" data-testid="event-study-result">
            <p className="text-muted">
              {res.modelLabel} · {res.benchmark.label} · วัน 0 = {res.day0} ·
              estimation {res.estimation?.from} → {res.estimation?.to} (n ={" "}
              {res.fit.n}) · α {res.fit.alpha.toFixed(5)} · β{" "}
              {res.fit.beta.toFixed(3)}
              {res.fit.betas &&
                ` (${res.fit.betas.map((b) => b.toFixed(2)).join(" / ")})`}{" "}
              · σ(ε) {(res.fit.sigma * 100).toFixed(2)}% · R²{" "}
              {res.fit.r2 == null ? "–" : res.fit.r2.toFixed(3)}
            </p>
            <table className="table">
              <thead>
                <tr>
                  <th>ช่วง</th>
                  <th className="num">วัน</th>
                  <th className="num">CAR</th>
                  <th className="num">t</th>
                </tr>
              </thead>
              <tbody>
                {res.cars?.map((c) => (
                  <tr key={c.label}>
                    <td>
                      {c.label} [{c.t1}, {c.t2}]
                    </td>
                    <td className="num">{c.days}</td>
                    <td className="num">{fmtPct(c.value)}</td>
                    <td
                      className="num"
                      style={{
                        color:
                          c.t != null && Math.abs(c.t) > 2
                            ? "var(--warn)"
                            : undefined,
                      }}
                    >
                      {fmtT(c.t)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="max-h-72 overflow-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th className="num">วัน</th>
                    <th>วันที่</th>
                    <th className="num">AR</th>
                    <th className="num">t</th>
                    <th className="num">CAR</th>
                    <th className="num">Vol z</th>
                  </tr>
                </thead>
                <tbody>
                  {res.days?.map((d) => (
                    <tr
                      key={d.rel}
                      className={clsx(d.rel === 0 && "font-medium")}
                    >
                      <td className="num">{d.rel > 0 ? `+${d.rel}` : d.rel}</td>
                      <td>{d.date}</td>
                      <td className="num">{fmtPct(d.ar)}</td>
                      <td
                        className="num"
                        style={{
                          color:
                            d.t != null && Math.abs(d.t) > 2
                              ? "var(--warn)"
                              : undefined,
                        }}
                      >
                        {fmtT(d.t)}
                      </td>
                      <td className="num">{fmtPct(d.car)}</td>
                      <td className="num">{fmtT(vz.get(d.rel) ?? null)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {res && (res.warnings.length > 0 || (res.volume && !res.volume.ok)) && (
          <ul className="list-disc pl-5 text-muted">
            {res.volume && !res.volume.ok && (
              <li>Volume: {res.volume.reason}</li>
            )}
            {res.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}
        <form
          className="flex flex-wrap items-end gap-2 border-t border-border pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            void record(new FormData(e.currentTarget));
          }}
        >
          <span className="w-full text-muted">
            บันทึก event (วันที่ข่าวออกจริง — ไม่เดาวันที่)
          </span>
          <input
            className="input w-auto"
            name="eventDate"
            type="date"
            required
            aria-label="วันที่ event"
          />
          <select
            className="input w-auto"
            name="eventType"
            defaultValue="news"
            aria-label="ประเภท event"
          >
            {Object.entries(EVENT_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <input
            className="input w-auto min-w-40 flex-1"
            name="description"
            placeholder="รายละเอียด"
            maxLength={500}
            aria-label="รายละเอียด"
          />
          <input
            className="input w-auto"
            name="source"
            placeholder="แหล่งที่มา"
            maxLength={200}
            aria-label="แหล่งที่มา"
          />
          <button type="submit" className="btn-ghost">
            บันทึก
          </button>
          {msg && <span className="w-full text-muted">{msg}</span>}
        </form>
      </div>
    </details>
  );
}

function SettingsPanel({
  data,
  onApply,
}: {
  data: AbnormalOverview;
  onApply: (t: { notable: number; abnormal: number }) => void;
}) {
  const notes = qualityNotes(data);
  const [n, setN] = useState(String(data.thresholds.notable));
  const [a, setA] = useState(String(data.thresholds.abnormal));
  const valid = Number(n) > 0 && Number(a) >= Number(n);
  return (
    <details
      className="rounded-xl border border-border p-3"
      data-testid="settings-panel"
    >
      <summary className="cursor-pointer text-sm font-medium">
        ตั้งค่า / คุณภาพข้อมูล{" "}
        {notes.length > 0 && (
          <span className="text-warn">({notes.length} คำเตือน)</span>
        )}
      </summary>
      <div className="mt-3 space-y-3 text-xs">
        <div className="flex flex-wrap items-end gap-2">
          <label className="grid gap-1">
            <span className="text-muted">เกณฑ์ น่าสังเกต (|t|, z)</span>
            <input
              className="input w-24"
              type="number"
              step="0.1"
              min="0.1"
              value={n}
              onChange={(e) => setN(e.target.value)}
            />
          </label>
          <label className="grid gap-1">
            <span className="text-muted">เกณฑ์ ผิดปกติ</span>
            <input
              className="input w-24"
              type="number"
              step="0.1"
              min="0.1"
              value={a}
              onChange={(e) => setA(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="btn-ghost"
            disabled={!valid}
            onClick={() => onApply({ notable: Number(n), abnormal: Number(a) })}
          >
            ใช้เกณฑ์นี้
          </button>
          {!valid && (
            <span className="text-warn">
              ต้องเป็นบวก และ ผิดปกติ ≥ น่าสังเกต
            </span>
          )}
        </div>
        <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[auto_1fr]">
          <dt className="text-muted">Model</dt>
          <dd>
            {data.modelLabel} · estimation [{data.estimationWindow.join(", ")}]
            วันซื้อขาย
          </dd>
          <dt className="text-muted">Benchmark</dt>
          <dd>{data.stock.benchmark.label}</dd>
          <dt className="text-muted">Volume</dt>
          <dd>
            {data.stock.volumeBasis === "turnover"
              ? "turnover (volume ÷ จำนวนหุ้น)"
              : "raw volume (ยังไม่มีจำนวนหุ้น)"}
          </dd>
          <dt className="text-muted">ครอบคลุม</dt>
          <dd>
            {data.stock.coverage.days} วัน · คำนวณ AR ได้{" "}
            {data.stock.coverage.withAR} วัน · volume z{" "}
            {data.stock.coverage.withVolumeZ} วัน
          </dd>
          <dt className="text-muted">จำนวนหุ้น</dt>
          <dd>
            {data.sharesOutstanding.length
              ? data.sharesOutstanding
                  .map(
                    (s) =>
                      `${s.shares.toLocaleString("en-US")} (ตั้งแต่ ${s.effectiveDate}, ${s.source})`,
                  )
                  .join(" · ")
              : "ยังไม่ได้บันทึก — ใช้ set_shares_outstanding พร้อมแหล่งที่มา"}
          </dd>
          <dt className="text-muted">เกณฑ์</dt>
          <dd>
            ผิดปกติ: {data.criteria["ผิดปกติ"]} · น่าสังเกต:{" "}
            {data.criteria["น่าสังเกต"]} · {data.criteria.preEvent}
          </dd>
        </dl>
        {notes.length > 0 && (
          <ul
            className="list-disc space-y-0.5 pl-5 text-warn"
            data-testid="quality-notes"
          >
            {notes.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}
        {data.stock.volumeOnly.length > 0 && (
          <p className="text-muted">
            Volume สูงในวันที่ไม่มีข้อมูลตลาด (ไม่นับเป็น flag):{" "}
            {data.stock.volumeOnly
              .slice(0, 10)
              .map((v) => `${v.date} (z=${v.z.toFixed(1)})`)
              .join(", ")}
            {data.stock.volumeOnly.length > 10 ? " …" : ""}
          </p>
        )}
      </div>
    </details>
  );
}
