"use client";

/**
 * Custom-metric charts. Real date x-axis, raw observations only (gaps stay gaps), at most two
 * independently scaled axes; three or more scales become small multiples. Series colour identifies
 * the metric; threshold status is a ring on each point and text in the tooltip — never the line colour.
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
  actualLayout,
  baseDateWarning,
  indexSeries,
  pctChangeSeries,
  thresholdSegments,
  unionRows,
  type ChartMode,
  type MetricSeries,
} from "@/lib/asset-metrics/series";

export interface ChartMetric extends MetricSeries {
  color: string;
  decimals: number;
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
  payload?: Record<string, unknown>;
  dataKey?: string;
  color: string;
  m: ChartMetric;
}) {
  const { cx, cy, payload, color, m } = props;
  if (cx == null || cy == null || payload?.[m.id] == null) return null;
  const st = m.statusByDate[String(payload.date)];
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
      <circle cx={cx} cy={cy} r={3} fill={color} />
    </g>
  );
}

function Tip({
  active,
  payload,
  metrics,
  mode,
  raw,
}: {
  active?: boolean;
  payload?: { payload: Record<string, number | string | null> }[];
  metrics: ChartMetric[];
  mode: ChartMode;
  raw: Map<string, Map<string, number>>;
}) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  const date = String(row.date);
  return (
    <div className="rounded-lg border border-border bg-panel-solid px-3 py-2 text-xs shadow-lg">
      <div className="mb-1 font-medium">{date}</div>
      {metrics.map((m) => {
        const v = row[m.id];
        if (v == null) return null;
        const r = raw.get(String(m.id))?.get(date);
        const st = m.statusByDate[date];
        return (
          <div key={m.id} className="flex items-center gap-2">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: m.color }}
            />
            <span>{m.name}:</span>
            <span className="tabular-nums">
              {mode === "actual"
                ? `${fmt(Number(v), m.decimals)} ${m.unit}`
                : mode === "indexed"
                  ? `${fmt(Number(v), 1)} (ค่าจริง ${r != null ? fmt(r, m.decimals) : "–"} ${m.unit})`
                  : `${Number(v) >= 0 ? "+" : ""}${fmt(Number(v), 1)}% (ค่าจริง ${r != null ? fmt(r, m.decimals) : "–"} ${m.unit})`}
            </span>
            {st && <span className="text-muted">· {STATUS_LABEL[st]}</span>}
          </div>
        );
      })}
    </div>
  );
}

/** Green / yellow / red bands of each threshold version, only over the dates that version applied. */
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
            yAxisId="left"
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
          yAxisId="left"
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

function boundsOf(m: ChartMetric) {
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
    .map(Number);
}

function OneChart({
  metrics,
  rows,
  mode,
  connect,
  yAxes,
  height = 260,
  withBands,
  from,
  to,
  raw,
}: {
  metrics: ChartMetric[];
  rows: Record<string, string | number | null>[];
  mode: ChartMode;
  connect: boolean;
  yAxes: Record<number, "left" | "right">;
  height?: number;
  withBands: boolean;
  from: string;
  to: string;
  raw: Map<string, Map<string, number>>;
}) {
  const valsFor = (side: "left" | "right") =>
    metrics
      .filter((m) => yAxes[m.id] === side)
      .flatMap((m) =>
        rows
          .map((r) => r[m.id])
          .filter((v): v is number => typeof v === "number"),
      );
  const domain = (side: "left" | "right") => {
    const v = valsFor(side);
    const extra = withBands && side === "left" ? metrics.flatMap(boundsOf) : [];
    const all = [...v, ...extra];
    if (!all.length) return [0, 1] as [number, number];
    const lo = Math.min(...all);
    const hi = Math.max(...all);
    const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.1 || 1;
    return [lo - pad, hi + pad] as [number, number];
  };
  const left = domain("left");
  const hasRight = metrics.some((m) => yAxes[m.id] === "right");
  const unitOf = (side: "left" | "right") =>
    [
      ...new Set(
        metrics.filter((m) => yAxes[m.id] === side).map((m) => m.unit),
      ),
    ].join(", ");
  return (
    <>
      {mode === "actual" && (
        <div className="flex justify-between text-[10px] text-muted">
          <span>{unitOf("left")}</span>
          {hasRight && <span>{unitOf("right")} →</span>}
        </div>
      )}
      <ResponsiveContainer width="100%" height={height}>
        <LineChart
          data={rows}
          margin={{ top: 8, right: hasRight ? 4 : 12, left: 0, bottom: 0 }}
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
            yAxisId="left"
            {...axis}
            width={58}
            domain={left}
            tickFormatter={(v) => tick(Number(v))}
          />
          {hasRight && (
            <YAxis
              yAxisId="right"
              orientation="right"
              {...axis}
              width={58}
              domain={domain("right")}
              tickFormatter={(v) => tick(Number(v))}
            />
          )}
          {mode === "indexed" && (
            <ReferenceLine
              yAxisId="left"
              y={100}
              stroke="var(--muted)"
              strokeDasharray="3 3"
            />
          )}
          {mode === "change" && (
            <ReferenceLine
              yAxisId="left"
              y={0}
              stroke="var(--muted)"
              strokeDasharray="3 3"
            />
          )}
          {withBands &&
            metrics.length === 1 &&
            bands(metrics[0], from, to, left[0], left[1])}
          <Tooltip content={<Tip metrics={metrics} mode={mode} raw={raw} />} />
          {metrics.map((m) => (
            <Line
              key={m.id}
              yAxisId={yAxes[m.id]}
              type="linear"
              dataKey={String(m.id)}
              name={m.name}
              stroke={m.color}
              strokeWidth={2}
              connectNulls={connect}
              isAnimationActive={false}
              dot={(p: object) => (
                <StatusDot
                  key={`${m.id}-${(p as { index?: number }).index}`}
                  {...(p as object)}
                  color={m.color}
                  m={m}
                />
              )}
              activeDot={{ r: 5 }}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </>
  );
}

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
  const withData = metrics.filter((m) => m.points.length);
  if (!withData.length)
    return (
      <p className="py-8 text-center text-xs text-muted">
        ไม่มีค่าที่บันทึกในช่วงเวลาที่เลือก — ไม่มีการสร้างข้อมูลแทน
      </p>
    );
  const span = {
    from:
      from ?? withData.flatMap((m) => m.points.map((p) => p.date)).sort()[0],
    to,
  };
  const raw = new Map(
    withData.map((m) => [
      String(m.id),
      new Map(m.points.map((p) => [p.date, p.value])),
    ]),
  );
  const notes: string[] = [];

  if (mode === "actual") {
    const layout = actualLayout(withData);
    if (layout.kind === "small_multiples") {
      return (
        <div className="space-y-2">
          <p className="text-[11px] text-muted">{layout.reason}</p>
          <div className="grid gap-3 md:grid-cols-2">
            {withData.map((m) => (
              <figure
                key={m.id}
                className="min-w-0 rounded-lg border border-border p-2"
              >
                <figcaption className="text-xs font-medium">
                  <span
                    className="mr-1 inline-block h-2 w-2 rounded-full"
                    style={{ background: m.color }}
                  />
                  {m.name} <span className="text-muted">({m.unit})</span>
                </figcaption>
                <OneChart
                  metrics={[m]}
                  rows={unionRows([{ key: String(m.id), points: m.points }])}
                  mode="actual"
                  connect
                  yAxes={{ [m.id]: "left" }}
                  height={170}
                  withBands
                  from={span.from}
                  to={span.to}
                  raw={raw}
                />
              </figure>
            ))}
          </div>
        </div>
      );
    }
    const yAxes: Record<number, "left" | "right"> = Object.fromEntries(
      withData.map((m) => [
        m.id,
        layout.kind === "dual" && layout.right.includes(m.id)
          ? "right"
          : "left",
      ]),
    );
    const rows = unionRows(
      withData.map((m) => ({ key: String(m.id), points: m.points })),
    );
    return (
      <figure className="min-w-0">
        <OneChart
          metrics={withData}
          rows={rows}
          mode="actual"
          connect={connect || withData.length === 1}
          yAxes={yAxes}
          withBands={withData.length === 1}
          from={span.from}
          to={span.to}
          raw={raw}
        />
        <Legend
          metrics={withData}
          notes={
            layout.kind === "dual"
              ? [
                  "สองแกน: ซ้าย/ขวาคนละหน่วยหรือสเกล — อย่าเทียบความสูงของเส้นตรง ๆ",
                ]
              : withData.length === 1
                ? ["แถบสี = เกณฑ์ที่มีผลในแต่ละช่วงเวลา"]
                : []
          }
        />
      </figure>
    );
  }

  const transformed = withData.map((m) => {
    if (mode === "indexed") {
      const r = indexSeries(m.points);
      if (!r.ok) notes.push(`${m.name}: ${r.reason}`);
      return {
        m,
        base: r.ok ? r.baseDate : null,
        points: r.ok
          ? r.points.map((p) => ({ date: p.date, value: p.value }))
          : [],
      };
    }
    const c = pctChangeSeries(m.points);
    const skipped = c.filter((p, i) => i > 0 && p.value == null);
    if (skipped.length)
      notes.push(
        `${m.name}: ${skipped.length} จุดคำนวณ % ไม่ได้ (${skipped[0].reason})`,
      );
    return {
      m,
      base: null,
      points: c.map((p) => ({ date: p.date, value: p.value })),
    };
  });
  if (mode === "indexed") {
    const w = baseDateWarning(
      transformed
        .filter((t) => t.base)
        .map((t) => ({ name: t.m.name, baseDate: t.base })),
    );
    if (w) notes.push(w);
  }
  const shown = transformed.filter((t) =>
    t.points.some((p) => p.value != null),
  );
  const rows = unionRows(
    shown.map((t) => ({ key: String(t.m.id), points: t.points })),
  );
  return (
    <figure className="min-w-0">
      {shown.length ? (
        <OneChart
          metrics={shown.map((t) => t.m)}
          rows={rows}
          mode={mode}
          connect={connect}
          yAxes={Object.fromEntries(shown.map((t) => [t.m.id, "left"]))}
          withBands={false}
          from={span.from}
          to={span.to}
          raw={raw}
        />
      ) : (
        <p className="py-8 text-center text-xs text-muted">
          ไม่มีตัวชี้วัดที่แสดงในโหมดนี้ได้
        </p>
      )}
      <Legend metrics={shown.map((t) => t.m)} notes={notes} />
    </figure>
  );
}

function Legend({
  metrics,
  notes,
}: {
  metrics: ChartMetric[];
  notes: string[];
}) {
  return (
    <figcaption className="mt-1 space-y-1 text-[11px] text-muted">
      <div className="flex flex-wrap gap-3">
        {metrics.map((m) => (
          <span key={m.id} className="inline-flex items-center gap-1">
            <span
              className="inline-block h-2 w-3 rounded-sm"
              style={{ background: m.color }}
            />
            {m.name} ({m.unit})
          </span>
        ))}
        <span>· วงรอบจุด: เขียว/เหลือง/แดง = สถานะตามเกณฑ์ในวันนั้น</span>
      </div>
      {notes.map((n) => (
        <div key={n} className="text-warn">
          ⚠ {n}
        </div>
      ))}
    </figcaption>
  );
}
