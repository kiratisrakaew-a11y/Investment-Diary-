"use client";

/**
 * Asset price with optional custom metrics on a second (right) axis, to look at how the price moved
 * around each reading. One unit on the right axis at a time; readings are dots on their own dates
 * (never filled). The correlation box quantifies the relationship so nobody has to read it off two
 * independently scaled axes.
 */
import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { LEVEL_COLOR, type Marker } from "@/lib/finance/abnormal/view";
import {
  STATUS_LABEL,
  type MetricStatus,
} from "@/lib/asset-metrics/thresholds";
import { metricColor } from "@/lib/asset-metrics/series";
import {
  metricPriceCorrelation,
  priceMetricRows,
  type CorrelationBasis,
  type MetricReading,
} from "@/lib/asset-metrics/price-relation";
import { fmtNum } from "@/lib/format";

export interface OverlayMetric {
  id: number;
  name: string;
  unit: string;
  decimals: number;
  chartColor: string | null;
  readings: (MetricReading & { status: MetricStatus })[];
}

const axis = {
  stroke: "var(--muted)",
  fontSize: 11,
  tickLine: false,
  axisLine: false,
} as const;
const RING: Partial<Record<MetricStatus, string>> = {
  GREEN: "var(--pos)",
  YELLOW: "var(--warn)",
  RED: "var(--neg)",
};
const dateTick = (t: number) => new Date(t).toISOString().slice(0, 7);
const tick = (v: number) =>
  Math.abs(v) >= 1000
    ? fmtNum(v, 0)
    : Number(v.toPrecision(3)).toString();
const key = (id: number) => `m${id}`;

export interface PriceChartLink {
  /** Shared with the charts below so the cursor / tooltip follow the same date (syncMethod "value"). */
  syncId: string;
  /** Visible x range [from, to] in ms; rows outside are not drawn (correlation still uses every price). */
  xDomain: [number, number] | null;
  /** Event lines and abnormal-day dots (empty = none). */
  markers: Marker[];
  /** Date picked in the flag table, drawn as a vertical line. */
  highlight: string | null;
  /** Tells the charts below whether a right axis is shown, so their plot areas line up. */
  onRightAxis?: (on: boolean) => void;
}

export function PriceMetricChart({
  assetId,
  prices,
  currency,
  metrics,
  link,
}: {
  assetId: number;
  prices: { date: string; close: number }[];
  currency: string;
  metrics: OverlayMetric[];
  link?: PriceChartLink;
}) {
  const usable = metrics.filter((m) => m.readings.length > 0);
  const storeKey = `price-metrics:${assetId}`;
  const [selected, setSelected] = useState<number[]>([]);
  const [basis, setBasis] = useState<CorrelationBasis>("observed");

  useEffect(() => {
    try {
      const saved = JSON.parse(
        localStorage.getItem(storeKey) ?? "[]",
      ) as number[];
      const ok = saved.filter((id) => usable.some((m) => m.id === id));
      const first = usable.find((m) => m.id === ok[0]);
      const big = (m: OverlayMetric) =>
        Math.max(...m.readings.map((o) => Math.abs(o.value)), 1e-12);
      setSelected(
        ok.filter((id) => {
          const m = usable.find((x) => x.id === id)!;
          return (
            first &&
            m.unit === first.unit &&
            Math.max(big(m), big(first)) / Math.min(big(m), big(first)) <= 10
          );
        }),
      );
    } catch {
      /* storage unavailable: start empty */
    }
    // Only on mount / asset change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeKey]);
  const save = (ids: number[]) => {
    setSelected(ids);
    try {
      localStorage.setItem(storeKey, JSON.stringify(ids));
    } catch {
      /* ignore */
    }
  };

  const chosen = usable.filter((m) => selected.includes(m.id));
  const rightUnit = chosen[0]?.unit ?? null;
  // One right axis: same unit and a comparable magnitude (≤ 10×), otherwise the smaller series is flattened.
  const mag = (m: OverlayMetric) =>
    Math.max(...m.readings.map((o) => Math.abs(o.value)), 1e-12);
  const why = (m: OverlayMetric): string | null => {
    if (!chosen.length || selected.includes(m.id)) return null;
    if (m.unit !== rightUnit)
      return `แกนขวาใช้หน่วย ${rightUnit} อยู่ — เลือกได้ทีละหน่วย (เอาตัวที่เลือกออกก่อน)`;
    const far = chosen.find(
      (c) => Math.max(mag(c), mag(m)) / Math.min(mag(c), mag(m)) > 10,
    );
    return far
      ? `ขนาดตัวเลขต่างจาก ${far.name} เกิน 10 เท่า — บนแกนเดียวกันเส้นหนึ่งจะแบนจนอ่านไม่ออก ดูทีละตัว`
      : null;
  };
  const colorFor = (m: OverlayMetric) =>
    metricColor(
      m,
      metrics.findIndex((x) => x.id === m.id),
    );
  const { rows, outside } = useMemo(
    () =>
      priceMetricRows(
        prices,
        chosen.map((m) => ({ key: key(m.id), readings: m.readings })),
      ),
    [prices, chosen],
  );
  const statusBy = useMemo(
    () =>
      new Map(
        chosen.map((m) => [
          key(m.id),
          new Map(m.readings.map((o) => [o.observedOn, o.status])),
        ]),
      ),
    [chosen],
  );
  const corr = useMemo(
    () =>
      chosen.map((m) => ({
        m,
        c: metricPriceCorrelation(prices, m.readings, m.unit, { basis }),
      })),
    [chosen, prices, basis],
  );
  const outsideTotal = Object.values(outside).reduce((a, b) => a + b, 0);
  const dom = link?.xDomain ?? null;
  const shown = useMemo(
    () =>
      dom
        ? rows.filter(
            (r) => (r.t as number) >= dom[0] && (r.t as number) <= dom[1],
          )
        : rows,
    [rows, dom],
  );
  const priceAt = useMemo(
    () => new Map(rows.map((r) => [r.t as number, r.price as number | null])),
    [rows],
  );
  const markersAt = useMemo(() => {
    const m = new Map<string, Marker[]>();
    for (const k of link?.markers ?? [])
      m.set(k.date, [...(m.get(k.date) ?? []), k]);
    return m;
  }, [link?.markers]);
  const onRightAxis = link?.onRightAxis;
  const rightOn = chosen.length > 0;
  useEffect(() => onRightAxis?.(rightOn), [onRightAxis, rightOn]);

  return (
    <div className="space-y-3">
      {usable.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-2"
          role="group"
          aria-label="เพิ่ม Metric ลงกราฟราคา"
        >
          <span className="text-xs text-muted">+ เพิ่ม Metric ลงกราฟ:</span>
          {usable.map((m) => {
            const on = selected.includes(m.id);
            const blocked = why(m);
            return (
              <button
                key={m.id}
                type="button"
                aria-pressed={on}
                disabled={!!blocked}
                title={blocked ?? `${m.readings.length} ค่า`}
                className={clsx(
                  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs disabled:cursor-not-allowed disabled:opacity-40",
                  on
                    ? "border-accent/60 bg-panel-2 font-medium text-text"
                    : "border-border text-muted",
                )}
                onClick={() =>
                  save(
                    on
                      ? selected.filter((x) => x !== m.id)
                      : [...selected, m.id],
                  )
                }
              >
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ background: colorFor(m) }}
                  aria-hidden
                />
                {m.name} <span className="text-muted">({m.unit})</span>
              </button>
            );
          })}
        </div>
      )}

      {chosen.length > 0 && (
        <div className="flex justify-between text-xs text-muted">
          <span>ราคา ({currency}) · แกนซ้าย</span>
          <span>แกนขวา · {rightUnit}</span>
        </div>
      )}
      <ResponsiveContainer width="100%" height={chosen.length ? 280 : 240}>
        <ComposedChart
          data={shown}
          margin={{ top: 8, right: chosen.length ? 0 : 8, left: 0, bottom: 0 }}
          {...(link
            ? { syncId: link.syncId, syncMethod: "value" as const }
            : {})}
        >
          <defs>
            <linearGradient id={`gpm-${assetId}`} x1="0" y1="0" x2="0" y2="1">
              <stop
                offset="0%"
                stopColor={chosen.length ? "var(--muted)" : "var(--series-1)"}
                stopOpacity={chosen.length ? 0.18 : 0.45}
              />
              <stop
                offset="100%"
                stopColor={chosen.length ? "var(--muted)" : "var(--series-6)"}
                stopOpacity={0}
              />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--grid)" vertical={false} />
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={dom ?? ["dataMin", "dataMax"]}
            tickFormatter={dateTick}
            {...axis}
            minTickGap={48}
          />
          <YAxis
            yAxisId="price"
            {...axis}
            domain={["auto", "auto"]}
            width={56}
            tickFormatter={(v) => tick(Number(v))}
          />
          {chosen.length > 0 && (
            <YAxis
              yAxisId="metric"
              orientation="right"
              {...axis}
              domain={["auto", "auto"]}
              width={52}
              tickFormatter={(v) => tick(Number(v))}
            />
          )}
          <Tooltip
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const r = payload[0].payload as Record<
                string,
                number | string | null
              >;
              const date = String(r.date);
              return (
                <div className="rounded-lg border border-border bg-panel-solid px-3 py-2 text-xs shadow-lg">
                  <div className="mb-1 font-medium">{date}</div>
                  <div>
                    ราคา:{" "}
                    <span className="tabular-nums">
                      {r.price != null
                        ? `${fmtNum(Number(r.price), 2)} ${currency}`
                        : "– (ไม่มีราคาวันนี้)"}
                    </span>
                  </div>
                  {(markersAt.get(date) ?? []).map((k, i) => (
                    <div
                      key={i}
                      className="max-w-72"
                      style={{
                        color:
                          k.kind === "flag"
                            ? LEVEL_COLOR[k.level ?? "ปกติ"]
                            : undefined,
                      }}
                    >
                      {k.kind === "flag" ? `● ${k.level}: ` : "┆ Event: "}
                      {k.label}
                    </div>
                  ))}
                  {chosen.map((m) => {
                    const v = r[key(m.id)];
                    if (v == null) return null;
                    const st = statusBy.get(key(m.id))?.get(date);
                    return (
                      <div key={m.id} className="flex items-center gap-1.5">
                        <span
                          className="inline-block h-2 w-2 rounded-full"
                          style={{ background: colorFor(m) }}
                        />
                        {m.name}:{" "}
                        <span className="tabular-nums">
                          {fmtNum(Number(v), m.decimals)} {m.unit}
                        </span>
                        {st && (
                          <span className="text-muted">
                            · {STATUS_LABEL[st]}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            }}
          />
          {chosen.length > 0 && <Legend wrapperStyle={{ fontSize: 12 }} />}
          <Area
            yAxisId="price"
            type="monotone"
            dataKey="price"
            name={`ราคา (แกนซ้าย, ${currency})`}
            stroke={chosen.length ? "var(--text)" : "var(--series-1)"}
            strokeWidth={chosen.length ? 1.5 : 2}
            fill={`url(#gpm-${assetId})`}
            baseValue="dataMin"
            connectNulls
            dot={false}
            isAnimationActive={false}
          />
          {link?.markers
            .filter((k) => k.kind === "event")
            .map((k) => (
              <ReferenceLine
                key={`e-${k.date}-${k.label}`}
                yAxisId="price"
                x={k.t}
                stroke="var(--accent)"
                strokeDasharray="2 3"
                strokeOpacity={0.8}
              />
            ))}
          {link?.markers
            .filter((k) => k.kind === "flag" && priceAt.get(k.t) != null)
            .map((k) => (
              <ReferenceDot
                key={`f-${k.date}`}
                yAxisId="price"
                x={k.t}
                y={priceAt.get(k.t)!}
                r={k.level === "ผิดปกติ" ? 5 : 4}
                fill={LEVEL_COLOR[k.level ?? "ปกติ"]}
                stroke="var(--panel-solid)"
                strokeWidth={1.5}
              />
            ))}
          {link?.highlight && (
            <ReferenceLine
              yAxisId="price"
              x={Date.parse(`${link.highlight}T00:00:00Z`)}
              stroke="var(--text)"
              strokeWidth={1}
            />
          )}
          {chosen.map((m) => (
            <Line
              key={m.id}
              yAxisId="metric"
              type="linear"
              dataKey={key(m.id)}
              name={`${m.name} (แกนขวา, ${m.unit})`}
              stroke={colorFor(m)}
              strokeWidth={1.5}
              strokeDasharray="4 3"
              connectNulls
              isAnimationActive={false}
              dot={(p: {
                cx?: number;
                cy?: number;
                index?: number;
                payload?: Record<string, unknown>;
              }) => {
                const v = p.payload?.[key(m.id)];
                if (p.cx == null || p.cy == null || v == null)
                  return <g key={`${m.id}-${p.index}`} />;
                const st = statusBy
                  .get(key(m.id))
                  ?.get(String(p.payload?.date));
                const ring = st ? RING[st] : undefined;
                return (
                  <g key={`${m.id}-${p.index}`}>
                    {ring && (
                      <circle
                        cx={p.cx}
                        cy={p.cy}
                        r={7}
                        fill="none"
                        stroke={ring}
                        strokeWidth={1.5}
                      />
                    )}
                    <circle
                      cx={p.cx}
                      cy={p.cy}
                      r={4}
                      fill={colorFor(m)}
                      stroke="var(--panel-solid)"
                      strokeWidth={1.5}
                    />
                  </g>
                );
              }}
              activeDot={{ r: 5 }}
            />
          ))}
        </ComposedChart>
      </ResponsiveContainer>

      {chosen.length > 0 && (
        <div className="space-y-2 text-xs">
          <p className="text-xs text-muted">
            สองแกนมีสเกลต่างกัน — อย่าตีความจากจุดตัดหรือความชันของเส้น ใช้ค่า
            correlation ด้านล่างแทน · จุด = วันที่มีค่าจริง (เส้นประแค่เชื่อมจุด
            ไม่ใช่ค่าระหว่างกลาง) · วงสี = สถานะตามเกณฑ์ ณ วันนั้น
            {outsideTotal > 0 &&
              ` · ${outsideTotal} ค่าอยู่นอกช่วงที่มีราคา จึงไม่แสดง`}
          </p>
          <div className="rounded-xl border border-border p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="font-medium">
                ความสัมพันธ์ระหว่างราคากับ Metric (correlation)
              </span>
              <div
                role="group"
                aria-label="วันที่ใช้จับคู่ราคา"
                className="ml-auto inline-flex rounded-lg border border-border p-0.5"
              >
                {(
                  [
                    ["observed", "วันของข้อมูล"],
                    ["published", "วันประกาศ"],
                  ] as const
                ).map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    aria-pressed={basis === k}
                    className={clsx(
                      "rounded-md px-2 py-0.5",
                      basis === k
                        ? "bg-panel-2 font-medium text-text"
                        : "text-muted",
                    )}
                    onClick={() => setBasis(k)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <ul className="space-y-1.5">
              {corr.map(({ m, c }) => (
                <li
                  key={m.id}
                  className="flex flex-wrap items-baseline gap-x-2"
                >
                  <span className="inline-flex items-center gap-1.5 font-medium">
                    <span
                      className="inline-block h-2 w-2 rounded-full"
                      style={{ background: colorFor(m) }}
                      aria-hidden
                    />
                    {m.name}
                  </span>
                  {c.r != null ? (
                    <span>
                      r ={" "}
                      <span className="font-semibold tabular-nums">
                        {fmtNum(c.r, 2)}
                      </span>{" "}
                      ({c.strength}
                      {c.r > 0 ? " · ไปทางเดียวกัน" : " · สวนทางกัน"}) · {c.n}{" "}
                      ช่วง
                    </span>
                  ) : (
                    <span className="text-muted">{c.reason}</span>
                  )}
                  {c.warnings.map((w) => (
                    <span key={w} className="text-warn">
                      · {w}
                    </span>
                  ))}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-muted">
              วัดจากการเปลี่ยนแปลงระหว่างค่าที่บันทึกติดกัน: % เปลี่ยนของราคา
              เทียบกับการเปลี่ยนของ metric (
              {rightUnit && /%/.test(rightUnit)
                ? "จุดเปอร์เซ็นต์"
                : "% เปลี่ยนแปลง"}
              ) · ใช้ราคาปิดล่าสุดไม่เกิน 10 วันก่อนวันนั้น · “วันประกาศ”
              ใช้วันที่ข้อมูลเผยแพร่ (ตลาดรู้จริง) ·
              ความสัมพันธ์ไม่ได้แปลว่าเป็นเหตุและผล
              และข้อมูลรายไตรมาสมีจำนวนจุดน้อย
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
