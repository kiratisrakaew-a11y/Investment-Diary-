"use client";

/** Custom metrics on the asset page: summary, chart (actual / indexed / % change), management and history. */
import { useMemo, useState, useTransition } from "react";
import clsx from "clsx";
import type { MetricOverview } from "@/server/services/asset-metrics";
import { MODE_HELP, MODE_LABEL, inWindow, windowStart, type ChartMode } from "@/lib/asset-metrics/series";
import { RULE_LABEL, STATUS_LABEL, type MetricStatus } from "@/lib/asset-metrics/thresholds";
import { deleteObservationAction, updateMetricAction } from "@/app/(app)/holdings/metric-actions";
import { AssetMetricChart, type ChartMetric } from "./AssetMetricChart";
import { DeleteMetricForm, FREQ_LABEL, MetricForm, Modal, ObservationForm, ThresholdForm, describeRule, type ThresholdLite } from "./AssetMetricForm";

const STATUS_STYLE: Record<MetricStatus, { dot: string; text: string; icon: string }> = {
  GREEN: { dot: "bg-pos", text: "text-pos", icon: "●" },
  YELLOW: { dot: "bg-warn", text: "text-warn", icon: "▲" },
  RED: { dot: "bg-neg", text: "text-neg", icon: "■" },
  NO_THRESHOLD: { dot: "bg-muted/40", text: "text-muted", icon: "○" },
  NO_DATA: { dot: "bg-muted/40", text: "text-muted", icon: "–" },
};

export function StatusBadge({ status, title }: { status: MetricStatus; title?: string }) {
  const s = STATUS_STYLE[status];
  return (
    <span className={clsx("inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-border px-2 py-0.5 text-[11px]", s.text)} title={title}>
      <span aria-hidden>{s.icon}</span>
      {STATUS_LABEL[status]}
    </span>
  );
}

const fmt = (v: number | null | undefined, d: number) => (v == null || !Number.isFinite(v) ? "–" : v.toLocaleString("en-US", { minimumFractionDigits: Math.min(d, 2), maximumFractionDigits: d }));
const colorOf = (m: { chartColor: string | null }, i: number) => `var(--${m.chartColor ?? `series-${(i % 6) + 1}`})`;
type Dialog =
  | { kind: "metric"; metricId?: number }
  | { kind: "obs"; metricId?: number; observationId?: number }
  | { kind: "threshold"; metricId: number }
  | { kind: "delete"; metricId: number }
  | null;

export function AssetMetricsPanel({ assetId, metrics, archived, today }: { assetId: number; metrics: MetricOverview[]; archived: MetricOverview[]; today: string }) {
  const [range, setRange] = useState<"1Y" | "3Y" | "5Y" | "All">("All");
  const [mode, setMode] = useState<ChartMode>("actual");
  const [connect, setConnect] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [histFilter, setHistFilter] = useState<number | "all">("all");
  const [page, setPage] = useState(0);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const close = () => setDialog(null);
  const all = [...metrics, ...archived];
  const byId = (id?: number) => all.find((m) => m.id === id);
  const from = windowStart(range, today);

  const chartMetrics: ChartMetric[] = useMemo(
    () =>
      metrics
        .map((m, i) => ({ m, color: colorOf(m, i) }))
        .filter(({ m }) => m.showInChart)
        .map(({ m, color }) => ({
          id: m.id,
          name: m.name,
          unit: m.unit,
          color,
          decimals: m.decimals,
          thresholds: m.thresholds,
          statusByDate: Object.fromEntries(m.observations.map((o) => [o.observedOn, o.status])),
          points: inWindow(m.observations.map((o) => ({ date: o.observedOn, value: o.value })), from),
        })),
    [metrics, from],
  );

  const history = useMemo(() => {
    const rows = metrics.flatMap((m) => m.observations.map((o) => ({ m, o })));
    return rows.filter((r) => histFilter === "all" || r.m.id === histFilter).sort((a, b) => b.o.observedOn.localeCompare(a.o.observedOn) || a.m.name.localeCompare(b.m.name));
  }, [metrics, histFilter]);
  const PAGE = 25;
  const pages = Math.max(1, Math.ceil(history.length / PAGE));

  const toggle = (m: MetricOverview, patch: Record<string, unknown>, done?: string) =>
    start(async () => {
      const r = await updateMetricAction(assetId, m.id, patch);
      setMsg(r.ok ? (done ?? null) : r.error);
    });

  const obsForDialog = dialog?.kind === "obs" && dialog.observationId ? byId(dialog.metricId)?.observations.find((o) => o.id === dialog.observationId) : undefined;
  const dm = dialog && "metricId" in dialog ? byId(dialog.metricId) : undefined;

  return (
    <div className="space-y-4">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn text-xs" onClick={() => setDialog({ kind: "metric" })}>
          + เพิ่ม Metric
        </button>
        <button type="button" className="btn-ghost text-xs" disabled={!metrics.length} onClick={() => setDialog({ kind: "obs" })}>
          บันทึกค่า
        </button>
        <div role="group" aria-label="ช่วงเวลา" className="ml-auto flex rounded-lg border border-border p-0.5 text-xs">
          {(["1Y", "3Y", "5Y", "All"] as const).map((r) => (
            <button key={r} type="button" aria-pressed={range === r} className={clsx("rounded-md px-2 py-0.5", range === r ? "bg-panel-2 font-medium text-text" : "text-muted")} onClick={() => setRange(r)}>
              {r}
            </button>
          ))}
        </div>
        <div role="group" aria-label="โหมดกราฟ" className="flex rounded-lg border border-border p-0.5 text-xs">
          {(["actual", "indexed", "change"] as const).map((k) => (
            <button key={k} type="button" aria-pressed={mode === k} title={MODE_HELP[k]} className={clsx("rounded-md px-2 py-0.5", mode === k ? "bg-panel-2 font-medium text-text" : "text-muted")} onClick={() => setMode(k)}>
              {k === "actual" ? "Actual" : k === "indexed" ? "Indexed 100" : "% Change"}
            </button>
          ))}
        </div>
      </div>
      {msg && (
        <p role="status" className="text-xs text-muted">
          {msg}
        </p>
      )}

      {!metrics.length ? (
        <div className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted">
          ยังไม่มีตัวชี้วัดของสินทรัพย์นี้ — กด “+ เพิ่ม Metric” เพื่อเริ่มติดตาม เช่น NPL Ratio, Coverage Ratio หรือกำไรรายไตรมาส
          {archived.length > 0 && <div className="mt-1 text-xs">มีตัวชี้วัดที่เก็บถาวร {archived.length} รายการด้านล่าง</div>}
        </div>
      ) : (
        <>
          {/* summary */}
          <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {metrics.map((m, i) => {
              const ch = m.change;
              return (
                <li key={m.id} className="min-w-0 rounded-xl border border-border bg-panel/60 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 truncate text-xs font-medium">
                        <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: colorOf(m, i) }} aria-hidden />
                        {m.name}
                      </div>
                      <div className="mt-0.5 text-[22px] font-semibold tabular-nums leading-tight">
                        {m.latest ? fmt(m.latest.value, m.decimals) : "–"} <span className="text-xs font-normal text-muted">{m.unit}</span>
                      </div>
                    </div>
                    <StatusBadge status={m.status} title={m.statusExplanation} />
                  </div>
                  <div className="mt-1 text-[11px] text-muted">
                    {m.latest ? `ณ ${m.latest.observedOn}` : "ยังไม่มีค่า"}
                    {ch.delta != null && (
                      <span className={clsx("ml-2 tabular-nums", ch.delta > 0 ? "text-text" : "")}>
                        {ch.delta >= 0 ? "+" : ""}
                        {fmt(ch.delta, m.decimals)} {ch.deltaLabel === "pp" ? "pp" : m.unit}
                        {ch.relative != null && ` (${ch.relative >= 0 ? "+" : ""}${(ch.relative * 100).toFixed(1)}%)`} จาก {ch.previous?.date}
                      </span>
                    )}
                    {m.freshness.stale && (
                      <span className="ml-2 text-warn" title={`ความถี่${FREQ_LABEL[m.frequency]} — ค่าล่าสุดเก่า ${m.freshness.ageDays} วัน (เกิน ${m.freshness.limitDays})`}>
                        · ข้อมูลเก่า
                      </span>
                    )}
                  </div>
                  <div className="mt-1 truncate text-[11px] text-muted" title={m.currentThreshold ? describeRule(m.currentThreshold as unknown as ThresholdLite, m.unit) : undefined}>
                    {m.currentThreshold ? `${RULE_LABEL[m.currentThreshold.ruleType]} · ${describeRule(m.currentThreshold as unknown as ThresholdLite, m.unit)}` : "ยังไม่ตั้งเกณฑ์สี"}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
                    <button type="button" className="btn-ghost px-2 py-0.5 text-[11px]" onClick={() => setDialog({ kind: "obs", metricId: m.id })}>
                      + ค่า
                    </button>
                    <button type="button" className="btn-ghost px-2 py-0.5 text-[11px]" onClick={() => setDialog({ kind: "threshold", metricId: m.id })}>
                      เกณฑ์สี
                    </button>
                    <button type="button" className="btn-ghost px-2 py-0.5 text-[11px]" onClick={() => setDialog({ kind: "metric", metricId: m.id })}>
                      แก้ไข
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>

          {/* chart */}
          <div className="min-w-0 rounded-xl border border-border p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-muted">
              <span className="font-medium text-text">{MODE_LABEL[mode]}</span>
              <span>· {MODE_HELP[mode]}</span>
              <label className="ml-auto inline-flex items-center gap-1">
                <input type="checkbox" checked={connect} onChange={(e) => setConnect(e.target.checked)} />
                ลากเส้นข้ามวันที่ไม่มีข้อมูล (ไม่ได้สร้างค่าใหม่)
              </label>
            </div>
            {chartMetrics.length ? <AssetMetricChart metrics={chartMetrics} mode={mode} from={from} to={today} connect={connect} /> : <p className="py-6 text-center text-xs text-muted">ไม่มีตัวชี้วัดที่เลือกให้แสดงในกราฟ — ติ๊ก “กราฟ” ในตารางด้านล่าง</p>}
          </div>

          {/* management */}
          <div className="overflow-x-auto">
            <table className="table min-w-[720px] text-xs">
              <thead>
                <tr>
                  <th>กราฟ</th>
                  <th>ตัวชี้วัด</th>
                  <th>หน่วย</th>
                  <th className="text-right">ค่าล่าสุด</th>
                  <th>วันที่</th>
                  <th>สถานะ</th>
                  <th>ความถี่</th>
                  <th className="text-right">จำนวนค่า</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {metrics.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <input type="checkbox" aria-label={`แสดง ${m.name} ในกราฟ`} checked={m.showInChart} disabled={pending} onChange={(e) => toggle(m, { showInChart: e.target.checked })} />
                    </td>
                    <td className="font-medium">{m.name}</td>
                    <td>{m.unit}</td>
                    <td className="text-right tabular-nums">{m.latest ? fmt(m.latest.value, m.decimals) : "–"}</td>
                    <td>
                      {m.latest?.observedOn ?? "–"}
                      {m.freshness.stale && <span className="ml-1 text-warn">(เก่า)</span>}
                    </td>
                    <td>
                      <StatusBadge status={m.status} title={m.statusExplanation} />
                    </td>
                    <td>{FREQ_LABEL[m.frequency]}</td>
                    <td className="text-right tabular-nums">{m.observationCount}</td>
                    <td className="whitespace-nowrap text-right">
                      <button type="button" className="text-accent hover:underline" onClick={() => setDialog({ kind: "metric", metricId: m.id })}>
                        แก้ไข
                      </button>
                      <button type="button" className="ml-2 text-muted hover:underline" disabled={pending} onClick={() => toggle(m, { isActive: false }, `เก็บถาวร ${m.name} แล้ว — ค่าและเกณฑ์ยังอยู่ครบ`)}>
                        เก็บถาวร
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* history */}
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-medium">ประวัติค่าที่บันทึก</span>
              <select
                aria-label="กรองตามตัวชี้วัด"
                className="input w-auto py-0.5 text-xs"
                value={histFilter}
                onChange={(e) => {
                  setHistFilter(e.target.value === "all" ? "all" : Number(e.target.value));
                  setPage(0);
                }}
              >
                <option value="all">ทุกตัวชี้วัด</option>
                {metrics.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
              <span className="text-muted">{history.length} รายการ · วันที่ = วันของข้อมูล ไม่ใช่วันที่บันทึก</span>
            </div>
            <div className="overflow-x-auto">
              <table className="table min-w-[680px] text-xs">
                <thead>
                  <tr>
                    <th>วันที่ข้อมูล</th>
                    <th>ตัวชี้วัด</th>
                    <th className="text-right">ค่า</th>
                    <th>สถานะ (เกณฑ์ในวันนั้น)</th>
                    <th>แหล่งข้อมูล</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {history.slice(page * PAGE, page * PAGE + PAGE).map(({ m, o }) => (
                    <tr key={o.id}>
                      <td className="whitespace-nowrap">
                        {o.observedOn}
                        {o.publishedOn && <span className="block text-[10px] text-muted">เผยแพร่ {o.publishedOn}</span>}
                      </td>
                      <td>{m.name}</td>
                      <td className="text-right tabular-nums">
                        {fmt(o.value, m.decimals)} <span className="text-muted">{m.unit}</span>
                      </td>
                      <td>
                        <StatusBadge status={o.status} title={o.explanation} />
                      </td>
                      <td className="max-w-[14rem] truncate" title={[o.source, o.note].filter(Boolean).join(" · ")}>
                        {o.source ?? "–"}
                        {o.note && <span className="text-muted"> · {o.note}</span>}
                      </td>
                      <td className="whitespace-nowrap text-right">
                        <button type="button" className="text-accent hover:underline" onClick={() => setDialog({ kind: "obs", metricId: m.id, observationId: o.id })}>
                          แก้ไข
                        </button>
                        <button
                          type="button"
                          className="ml-2 text-neg hover:underline"
                          disabled={pending}
                          onClick={() => {
                            if (!window.confirm(`ลบค่า ${m.name} วันที่ ${o.observedOn} (${o.valueText} ${m.unit})?`)) return;
                            start(async () => {
                              const r = await deleteObservationAction(assetId, m.id, o.id);
                              setMsg(r.ok ? `ลบค่า ${m.name} ${o.observedOn} แล้ว` : r.error);
                            });
                          }}
                        >
                          ลบ
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {pages > 1 && (
              <div className="flex items-center gap-2 text-xs">
                <button type="button" className="btn-ghost px-2 py-0.5 text-xs" disabled={page === 0} onClick={() => setPage(page - 1)}>
                  ก่อนหน้า
                </button>
                <span className="text-muted">
                  หน้า {page + 1} / {pages}
                </span>
                <button type="button" className="btn-ghost px-2 py-0.5 text-xs" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>
                  ถัดไป
                </button>
              </div>
            )}
          </div>
        </>
      )}

      {archived.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted">ตัวชี้วัดที่เก็บถาวร ({archived.length})</summary>
          <ul className="mt-2 space-y-1">
            {archived.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-2 rounded border border-border px-2 py-1">
                <span className="font-medium">{m.name}</span>
                <span className="text-muted">
                  {m.unit} · {m.observationCount} ค่า
                </span>
                <button type="button" className="ml-auto text-accent hover:underline" disabled={pending} onClick={() => toggle(m, { isActive: true }, `นำ ${m.name} กลับมาแล้ว`)}>
                  นำกลับมา
                </button>
                <button type="button" className="text-neg hover:underline" onClick={() => setDialog({ kind: "delete", metricId: m.id })}>
                  ลบถาวร…
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}

      <Modal open={dialog?.kind === "metric"} onClose={close} title={dm ? `แก้ไขตัวชี้วัด ${dm.name}` : "เพิ่มตัวชี้วัด"}>
        <MetricForm assetId={assetId} metric={dialog?.kind === "metric" ? dm : undefined} onDone={close} />
      </Modal>
      <Modal open={dialog?.kind === "obs"} onClose={close} title={obsForDialog ? `แก้ค่า ${dm?.name} · ${obsForDialog.observedOn}` : "บันทึกค่า"}>
        <ObservationForm
          key={`${dialog?.kind}-${dialog && "metricId" in dialog ? dialog.metricId : ""}-${obsForDialog?.id ?? "new"}`}
          assetId={assetId}
          metrics={metrics.map((m) => ({ id: m.id, name: m.name, unit: m.unit, sourceDefault: m.sourceDefault }))}
          metricId={dialog?.kind === "obs" ? dialog.metricId : undefined}
          observation={obsForDialog}
          today={today}
          onDone={close}
          onEditExisting={(metricId, observationId) => setDialog({ kind: "obs", metricId, observationId })}
        />
      </Modal>
      <Modal open={dialog?.kind === "threshold"} onClose={close} title={`เกณฑ์สี · ${dm?.name ?? ""}`} wide>
        {dm && <ThresholdForm assetId={assetId} metric={dm} versions={dm.thresholds as unknown as ThresholdLite[]} today={today} onDone={close} />}
      </Modal>
      <Modal open={dialog?.kind === "delete"} onClose={close} title={`ลบตัวชี้วัด ${dm?.name ?? ""} ถาวร`}>
        {dm && <DeleteMetricForm assetId={assetId} metric={dm} onDone={close} />}
      </Modal>
    </div>
  );
}
