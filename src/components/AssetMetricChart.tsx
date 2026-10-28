"use client";

/**
 * Custom-metric charts: always one independent chart card per metric, in every mode. Each chart has
 * its own y-axis scaled from that metric only, its own threshold bands (actual mode only) and a
 * tooltip for that metric only. Real date x-axis, raw observations only (gaps stay gaps). Threshold
 * status is a ring on each point and text in the tooltip — never the line colour.
 */
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type {
  MetricStatus,
  ThresholdVersion,
} from "@/lib/asset-metrics/thresholds";
import { STATUS_LABEL } from "@/lib/asset-metrics/thresholds";
import {
  singleMetricChart,
  thresholdSegments,
  type ChartMode,
  type ChartRow,
  type MetricSeries,
  type SingleMetricChart,
} from "@/lib/asset-metrics/series";
import { StatusBadge } from "./AssetMetricStatus";

export interface ChartMetric extends MetricSeries {
  color: string;
  decimals: number;
  frequency: string;
  /** All observations of the metric, not only those in the window. */
  observationCount: number;
  /** Latest raw observation overall and its status (card header). */
  latest: { date: string; value: number } | null;
  status: MetricStatus;
  statusExplanation: string;
  thresholds: ThresholdVersion[];
  statusByDate: Record<string, MetricStatus>;
}

const axis = {
  stroke: "var(--muted)",
  fontSize: 11,
  tickLine: false,
  axisLine: false,
} as const;
const STATUS_RING: Partial<Record<MetricStatus, string>> = {
  GREEN: "var(--pos)",
  YELLOW: "var(--warn)",
  RED: "var(--neg)",
};
const dateTick = (t: number) => new Date(t).toISOString().slice(0, 7);
const ts = (d: string) => Date.parse(`${d}T00:00:00Z`);
/** Axis ticks: whole numbers for large magnitudes, short decimals otherwise. */
const tick = (v: number) =>
  Math.abs(v) >= 1000
    ? Math.round(v).toLocaleString("en-US")
    : Number(v.toPrecision(3)).toString();
const fmt = (v: number, d: number) =>
  v.toLocaleString("en-US", {
    minimumFractionDigits: Math.min(d, 2),
    maximumFractionDigits: d,
  });

function StatusDot(props: {
  cx?: number;
  cy?: number;
  payload?: ChartRow;
  m: ChartMetric;
}) {
  const { cx, cy, payload, m } = props;
  if (cx == null || cy == null || payload?.value == null) return null;
  const st = m.statusByDate[payload.date];
  const ring = st ? STATUS_RING[st] : undefined;
  return (
    <g>
      {ring && (
        <circle
          cx={cx}
          cy={cy}
          r={6}
          fill="none"
          stroke={ring}
          strokeWidth={1.5}
        />
      )}
      <circle cx={cx} cy={cy} r={3} fill={m.color} />
    </g>
  );
}

/** Tooltip for one metric: its value in the chart's mode, the raw value and the status of that date. */
function Tip({
  active,
  payload,
  m,
  mode,
}: {
  active?: boolean;
  payload?: { payload: ChartRow }[];
  m: ChartMetric;
  mode: ChartMode;
}) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  if (row.gap || row.raw == null) return null;
  const st = m.statusByDate[row.date];
  const raw = `${fmt(row.raw, m.decimals)} ${m.unit}`;
  return (
    <div className="rounded-lg border border-border bg-panel-solid px-3 py-2 text-xs shadow-lg">
      <div className="mb-1 font-medium">{row.date}</div>
      <div className="flex items-center gap-2">
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={{ background: m.color }}
        />
        <span>{m.name}:</span>
        <span className="tabular-nums">
          {mode === "actual"
            ? raw
            : row.value == null
              ? `– (ค่าจริง ${raw})`
              : mode === "indexed"
                ? `${fmt(row.value, 1)} (ค่าจริง ${raw})`
                : `${row.value >= 0 ? "+" : ""}${fmt(row.value, 1)}% (ค่าจริง ${raw})`}
        </span>
      </div>
      {row.value == null && row.reason && (
        <div className="mt-0.5 text-muted">{row.reason}</div>
      )}
      {st && (
        <div className="mt-0.5 text-muted">
          สถานะตามเกณฑ์ ณ วันนั้น: {STATUS_LABEL[st]}
        </div>
      )}
    </div>
  );
}

/** Green / yellow / red bands of each threshold version of THIS metric, only over the dates that version applied. */
function bands(
  m: ChartMetric,
  from: string,
  to: string,
  yMin: number,
  yMax: number,
) {
  const out: React.ReactNode[] = [];
  for (const { version: v, x1, x2 } of thresholdSegments(
    m.thresholds,
    from,
    to,
  )) {
    const n = (x: unknown) => (x == null || x === "" ? null : Number(x));
    const zones: [number, number, string][] = [];
    if (v.ruleType === "lower_is_better") {
      const g = n(v.greenBound)!;
      const y = n(v.yellowBound)!;
      zones.push(
        [yMin, g, "var(--pos)"],
        [g, y, "var(--warn)"],
        [y, yMax, "var(--neg)"],
      );
    } else if (v.ruleType === "higher_is_better") {
      const g = n(v.greenBound)!;
      const y = n(v.yellowBound)!;
      zones.push(
        [yMin, y, "var(--neg)"],
        [y, g, "var(--warn)"],
        [g, yMax, "var(--pos)"],
      );
    } else {
      const [a, b, c, d] = [
        n(v.yellowMin)!,
        n(v.greenMin)!,
        n(v.greenMax)!,
        n(v.yellowMax)!,
      ];
      zones.push(
        [yMin, a, "var(--neg)"],
        [a, b, "var(--warn)"],
        [b, c, "var(--pos)"],
        [c, d, "var(--warn)"],
        [d, yMax, "var(--neg)"],
      );
    }
    zones.forEach(([lo, hi, color], k) => {
      const y1 = Math.max(lo, yMin);
      const y2 = Math.min(hi, yMax);
      if (y2 > y1)
        out.push(
          <ReferenceArea
            key={`${v.effectiveFrom}-${k}`}
            x1={ts(x1)}
            x2={ts(x2)}
            y1={y1}
            y2={y2}
            fill={color}
            fillOpacity={0.08}
            stroke="none"
            ifOverflow="hidden"
          />,
        );
    });
    if (v.effectiveFrom > from)
      out.push(
        <ReferenceLine
          key={`start-${v.effectiveFrom}`}
          x={ts(v.effectiveFrom)}
          stroke="var(--muted)"
          strokeDasharray="2 3"
          label={{
            value: "เกณฑ์ใหม่",
            fontSize: 10,
            fill: "var(--muted)",
            position: "insideTopLeft",
          }}
        />,
      );
  }
  return out;
}

/** Numeric bounds of this metric's own threshold versions (actual-mode y domain). */
export function thresholdBounds(m: { thresholds: ThresholdVersion[] }) {
  return m.thresholds
    .flatMap((v) => [
      v.greenBound,
      v.yellowBound,
      v.greenMin,
      v.greenMax,
      v.yellowMin,
      v.yellowMax,
    ])
    .filter((x) => x != null && x !== "")
    .map(Number)
    .filter(Number.isFinite);
}

const UNIT_LABEL: Record<ChartMode, (unit: string) => string> = {
  actual: (u) => u,
  indexed: () => "ดัชนี (ฐาน 100)",
  change: () => "% เปลี่ยนจากค่าก่อนหน้า",
};

function MetricChartCard({
  m,
  chart,
  mode,
  from,
  to,
  connect,
}: {
  m: ChartMetric;
  chart: SingleMetricChart;
  mode: ChartMode;
  from: string | null;
  to: string;
  connect: boolean;
}) {
  const showBands = chart.bands && m.thresholds.length > 0;
  const span = from ?? chart.rows[0]?.date ?? to;
  return (
    <figure
      className="min-w-0 rounded-xl border border-border bg-panel/60 p-3"
      data-metric-chart={m.id}
      aria-label={`กราฟ ${m.name}`}
    >
      <figcaption className="mb-1 flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-xs font-medium">
            <span
              className="inline-block h-2 w-2 shrink-0 rounded-full"
              style={{ background: m.color }}
              aria-hidden
            />
            <span className="truncate">{m.name}</span>
            <span className="shrink-0 font-normal text-muted">({m.unit})</span>
          </div>
          <div className="mt-0.5 text-sm font-semibold tabular-nums">
            {m.latest ? (
              <>
                {fmt(m.latest.value, m.decimals)}{" "}
                <span className="text-xs font-normal text-muted">
                  {m.unit} · ณ {m.latest.date}
                </span>
              </>
            ) : (
              <span className="text-xs font-normal text-muted">
                ยังไม่มีค่า
              </span>
            )}
          </div>
        </div>
        <StatusBadge status={m.status} title={m.statusExplanation} />
      </figcaption>
      {chart.empty ? (
        <p className="flex h-[200px] items-center justify-center rounded-lg border border-dashed border-border px-3 text-center text-xs text-muted">
          {chart.empty}
        </p>
      ) : (
        <>
          <div className="text-[10px] text-muted">
            {UNIT_LABEL[mode](m.unit)}
            {mode === "indexed" && chart.baseDate && (
              <>
                {" "}
                · ฐาน {chart.baseDate} ={" "}
                {fmt(chart.baseValue!, m.decimals)} {m.unit}
              </>
            )}
          </div>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart
              data={chart.rows}
              margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
            >
              <CartesianGrid stroke="var(--grid)" vertical={false} />
              <XAxis
                dataKey="t"
                type="number"
                scale="time"
                domain={["dataMin", "dataMax"]}
                tickFormatter={dateTick}
                {...axis}
                minTickGap={40}
              />
              <YAxis
                {...axis}
                width={58}
                domain={chart.domain ?? [0, 1]}
                tickFormatter={(v) => tick(Number(v))}
              />
              {chart.reference != null && (
                <ReferenceLine
                  y={chart.reference}
                  stroke="var(--muted)"
                  strokeDasharray="3 3"
                />
              )}
              {showBands &&
                chart.domain &&
                bands(m, span, to, chart.domain[0], chart.domain[1])}
              <Tooltip content={<Tip m={m} mode={mode} />} />
              <Line
                type="linear"
                dataKey="value"
                name={m.name}
                stroke={m.color}
                strokeWidth={2}
                connectNulls={connect}
                isAnimationActive={false}
                dot={(p: object) => (
                  <StatusDot
                    key={`${m.id}-${(p as { index?: number }).index}`}
                    {...(p as object)}
                    m={m}
                  />
                )}
                activeDot={{ r: 5 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </>
      )}
      <div className="mt-1 space-y-0.5 text-[11px] text-muted">
        {!chart.empty && (
          <div>
            {showBands
              ? "แถบสี = เกณฑ์ของตัวชี้วัดนี้ที่มีผลในแต่ละช่วงเวลา · "
              : mode !== "actual" && m.thresholds.length
                ? "ไม่แสดงแถบเกณฑ์บนค่าที่แปลงแล้ว (เกณฑ์ใช้กับค่าจริง) · "
                : ""}
            วงรอบจุด = สถานะตามเกณฑ์ในวันนั้น
          </div>
        )}
        {chart.notes.map((n) => (
          <div key={n} className="text-warn">
            ⚠ {n}
          </div>
        ))}
      </div>
    </figure>
  );
}

/** One chart card per metric, stacked vertically, in every mode — metrics are never combined. */
export function AssetMetricChart({
  metrics,
  mode,
  from,
  to,
  connect,
}: {
  metrics: ChartMetric[];
  mode: ChartMode;
  from: string | null;
  to: string;
  connect: boolean;
}) {
  return (
    <div className="space-y-3">
      {metrics.map((m) => (
        <MetricChartCard
          key={m.id}
          m={m}
          chart={singleMetricChart(
            {
              id: m.id,
              points: m.points,
              observationCount: m.observationCount,
              frequency: m.frequency,
              thresholdBounds: thresholdBounds(m),
            },
            mode,
          )}
          mode={mode}
          from={from}
          to={to}
          connect={connect}
        />
      ))}
    </div>
  );
}
