"use client";

/** Dialogs for custom metrics: definition, observation, threshold version (with impact preview). */
import { useEffect, useRef, useState, useTransition } from "react";
import clsx from "clsx";
import {
  addObservationAction,
  addThresholdAction,
  createMetricAction,
  deleteMetricAction,
  previewThresholdAction,
  updateMetricAction,
  updateObservationAction,
  type MetricActionResult,
} from "@/app/(app)/holdings/metric-actions";
import { RULE_LABEL, STATUS_LABEL, validateRule, type MetricStatus, type RuleType } from "@/lib/asset-metrics/thresholds";
import { CHART_COLORS, FREQUENCIES } from "@/lib/asset-metrics/schemas";

export const FREQ_LABEL: Record<string, string> = { daily: "รายวัน", monthly: "รายเดือน", quarterly: "รายไตรมาส", annual: "รายปี", irregular: "ไม่แน่นอน" };

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: React.ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      // Focus the first field (not the close button) so keyboard users can type straight away.
      requestAnimationFrame(() => d.querySelector<HTMLElement>("input:not([type=hidden]), select, textarea")?.focus());
    }
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-label={title}
      className={clsx("m-auto max-h-[90vh] overflow-y-auto rounded-2xl border border-border bg-panel-solid p-5 text-text backdrop:bg-black/50", wide ? "w-[min(40rem,94vw)]" : "w-[min(28rem,94vw)]")}
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <h2 className="text-[15px] font-semibold">{title}</h2>
        <button type="button" aria-label="ปิด" className="text-muted hover:text-text" onClick={onClose}>
          ×
        </button>
      </div>
      {open && children}
    </dialog>
  );
}

function Msg({ r }: { r: MetricActionResult | null }) {
  if (!r) return null;
  return (
    <p role={r.ok ? "status" : "alert"} className={clsx("text-xs", r.ok ? "text-pos" : "text-neg")}>
      {r.ok ? "บันทึกแล้ว" : r.error}
    </p>
  );
}

const Field = ({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) => (
  <label className="block">
    <span className="label">{label}</span>
    {children}
    {hint && <span className="mt-0.5 block text-[11px] text-muted">{hint}</span>}
  </label>
);

export interface MetricLite {
  id: number;
  name: string;
  unit: string;
  description: string | null;
  frequency: string;
  decimals: number;
  chartColor: string | null;
  sourceDefault: string | null;
  observationCount: number;
}

export function MetricForm({ assetId, metric, onDone }: { assetId: number; metric?: MetricLite; onDone: () => void }) {
  const [f, setF] = useState({
    name: metric?.name ?? "",
    unit: metric?.unit ?? "",
    description: metric?.description ?? "",
    frequency: metric?.frequency ?? "quarterly",
    decimals: metric?.decimals ?? 2,
    chartColor: metric?.chartColor ?? "",
    sourceDefault: metric?.sourceDefault ?? "",
  });
  const [res, setRes] = useState<MetricActionResult | null>(null);
  const [needConfirm, setNeedConfirm] = useState(false);
  const [pending, start] = useTransition();
  const set = (k: keyof typeof f, v: string | number) => setF((x) => ({ ...x, [k]: v }));
  const submit = (confirmUnitChange = false) =>
    start(async () => {
      const payload = { ...f, chartColor: (f.chartColor || null) as never, frequency: f.frequency as never, description: f.description || null, sourceDefault: f.sourceDefault || null };
      const r = metric ? await updateMetricAction(assetId, metric.id, { ...payload, confirmUnitChange }) : await createMetricAction(assetId, payload);
      setRes(r);
      if (!r.ok && r.code === "UNIT_CHANGE_NEEDS_CONFIRMATION") setNeedConfirm(true);
      if (r.ok) onDone();
    });
  return (
    <form
      className="space-y-3 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Field label="ชื่อตัวชี้วัด *">
        <input className="input" required maxLength={80} value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="เช่น NPL Ratio" autoFocus />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="หน่วย *" hint="เช่น %, THB million, times, count">
          <input className="input" required maxLength={30} value={f.unit} onChange={(e) => set("unit", e.target.value)} list="metric-units" />
          <datalist id="metric-units">
            {["%", "THB million", "times", "count", "ratio", "THB"].map((u) => (
              <option key={u} value={u} />
            ))}
          </datalist>
        </Field>
        <Field label="ความถี่ของข้อมูล">
          <select className="input" value={f.frequency} onChange={(e) => set("frequency", e.target.value)}>
            {FREQUENCIES.map((x) => (
              <option key={x} value={x}>
                {FREQ_LABEL[x]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="ทศนิยมที่แสดง">
          <input className="input" type="number" min={0} max={8} value={f.decimals} onChange={(e) => set("decimals", Math.max(0, Math.min(8, Number(e.target.value) || 0)))} />
        </Field>
        <Field label="สีเส้นกราฟ">
          <select className="input" value={f.chartColor} onChange={(e) => set("chartColor", e.target.value)}>
            <option value="">อัตโนมัติ</option>
            {CHART_COLORS.map((c, i) => (
              <option key={c} value={c}>
                ชุดสี {i + 1}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="แหล่งข้อมูลเริ่มต้น">
        <input className="input" maxLength={200} value={f.sourceDefault} onChange={(e) => set("sourceDefault", e.target.value)} placeholder="เช่น รายงาน 56-1 / งบการเงิน" />
      </Field>
      <Field label="คำอธิบาย">
        <textarea className="input" rows={2} maxLength={500} value={f.description} onChange={(e) => set("description", e.target.value)} />
      </Field>
      {needConfirm && (
        <div className="rounded-lg border border-warn/40 p-2 text-xs text-warn" role="alert">
          {res && !res.ok && res.error}
          <button type="button" className="btn-ghost mt-2 text-xs" onClick={() => submit(true)} disabled={pending}>
            ยืนยันเปลี่ยนหน่วย (ค่าเดิมไม่ถูกแปลง)
          </button>
        </div>
      )}
      {!needConfirm && <Msg r={res} />}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={onDone}>
          ยกเลิก
        </button>
        <button type="submit" className="btn" disabled={pending}>
          {pending ? "กำลังบันทึก…" : metric ? "บันทึกการแก้ไข" : "เพิ่มตัวชี้วัด"}
        </button>
      </div>
    </form>
  );
}

export interface ObsLite {
  id: number;
  observedOn: string;
  valueText: string;
  source: string | null;
  note: string | null;
  publishedOn: string | null;
}

export function ObservationForm({
  assetId,
  metrics,
  metricId: initialMetric,
  observation,
  today,
  onDone,
  onEditExisting,
}: {
  assetId: number;
  metrics: { id: number; name: string; unit: string; sourceDefault: string | null }[];
  metricId?: number;
  observation?: ObsLite;
  today: string;
  onDone: () => void;
  onEditExisting?: (metricId: number, observationId: number) => void;
}) {
  const [metricId, setMetricId] = useState(initialMetric ?? metrics[0]?.id);
  const m = metrics.find((x) => x.id === metricId);
  const [f, setF] = useState({ observedOn: observation?.observedOn ?? today, value: observation?.valueText ?? "", source: observation?.source ?? "", note: observation?.note ?? "", publishedOn: observation?.publishedOn ?? "" });
  const [res, setRes] = useState<MetricActionResult | null>(null);
  const [pending, start] = useTransition();
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  if (!m) return <p className="text-xs text-muted">ยังไม่มีตัวชี้วัด — เพิ่มตัวชี้วัดก่อน</p>;
  const dup = res && !res.ok && res.code === "DUPLICATE_OBSERVATION" ? (res.detail as { observationId?: number } | undefined) : undefined;
  return (
    <form
      className="space-y-3 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const payload = { observedOn: f.observedOn, value: f.value.trim(), source: f.source || null, note: f.note || null, publishedOn: f.publishedOn || null };
          const r = observation ? await updateObservationAction(assetId, m.id, observation.id, payload) : await addObservationAction(assetId, m.id, payload);
          setRes(r);
          if (r.ok) onDone();
        });
      }}
    >
      {!observation && (
        <Field label="ตัวชี้วัด">
          <select className="input" value={metricId} onChange={(e) => setMetricId(Number(e.target.value))}>
            {metrics.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name} ({x.unit})
              </option>
            ))}
          </select>
        </Field>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label="วันที่ของข้อมูล *" hint="วันสิ้นงวด / วันที่ค่านี้หมายถึง (ไม่ใช่วันที่บันทึก)">
          <input className="input" type="date" required value={f.observedOn} max="2100-12-31" onChange={(e) => set("observedOn", e.target.value)} />
        </Field>
        <Field label={`ค่า (${m.unit}) *`}>
          <input className="input" required inputMode="decimal" value={f.value} onChange={(e) => set("value", e.target.value)} placeholder="เช่น 3.10" />
        </Field>
        <Field label="วันที่เผยแพร่ (ถ้าทราบ)">
          <input className="input" type="date" value={f.publishedOn} onChange={(e) => set("publishedOn", e.target.value)} />
        </Field>
        <Field label="แหล่งข้อมูล">
          <input className="input" maxLength={200} value={f.source} onChange={(e) => set("source", e.target.value)} placeholder={m.sourceDefault ?? ""} />
        </Field>
      </div>
      <Field label="หมายเหตุ">
        <input className="input" maxLength={1000} value={f.note} onChange={(e) => set("note", e.target.value)} />
      </Field>
      <Msg r={res} />
      {dup?.observationId && onEditExisting && (
        <button type="button" className="btn-ghost text-xs" onClick={() => onEditExisting(m.id, dup.observationId!)}>
          แก้ค่าเดิมของวันที่ {f.observedOn}
        </button>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={onDone}>
          ยกเลิก
        </button>
        <button type="submit" className="btn" disabled={pending}>
          {pending ? "กำลังบันทึก…" : observation ? "บันทึกการแก้ไข" : "บันทึกค่า"}
        </button>
      </div>
    </form>
  );
}

export interface ThresholdLite {
  id: number;
  ruleType: RuleType;
  effectiveFrom: string;
  effectiveTo: string | null;
  greenBound: string | null;
  yellowBound: string | null;
  greenMin: string | null;
  greenMax: string | null;
  yellowMin: string | null;
  yellowMax: string | null;
  reason: string | null;
  source: string | null;
}

export function describeRule(t: Pick<ThresholdLite, "ruleType" | "greenBound" | "yellowBound" | "greenMin" | "greenMax" | "yellowMin" | "yellowMax">, unit: string) {
  if (t.ruleType === "lower_is_better") return `เขียว ≤ ${t.greenBound} · เหลือง ≤ ${t.yellowBound} · แดง > ${t.yellowBound} ${unit}`;
  if (t.ruleType === "higher_is_better") return `เขียว ≥ ${t.greenBound} · เหลือง ≥ ${t.yellowBound} · แดง < ${t.yellowBound} ${unit}`;
  return `เขียว ${t.greenMin}–${t.greenMax} · เหลือง ${t.yellowMin}–${t.yellowMax} · นอกนั้นแดง (${unit})`;
}

export function ThresholdForm({ assetId, metric, versions, today, onDone }: { assetId: number; metric: { id: number; name: string; unit: string }; versions: ThresholdLite[]; today: string; onDone: () => void }) {
  const latest = versions[versions.length - 1];
  const [f, setF] = useState({
    ruleType: (latest?.ruleType ?? "lower_is_better") as RuleType,
    effectiveFrom: latest && latest.effectiveFrom >= today ? latest.effectiveFrom : today,
    greenBound: latest?.greenBound ?? "",
    yellowBound: latest?.yellowBound ?? "",
    greenMin: latest?.greenMin ?? "",
    greenMax: latest?.greenMax ?? "",
    yellowMin: latest?.yellowMin ?? "",
    yellowMax: latest?.yellowMax ?? "",
    reason: "",
    source: "",
  });
  const [res, setRes] = useState<MetricActionResult | null>(null);
  const [preview, setPreview] = useState<{ affected: number; changed: number; rows: { observedOn: string; value: number; before: MetricStatus; after: MetricStatus }[] } | null>(null);
  const [pending, start] = useTransition();
  const set = (k: keyof typeof f, v: string) => {
    setF((x) => ({ ...x, [k]: v }));
    setPreview(null);
  };
  const payload = () => ({
    ruleType: f.ruleType,
    effectiveFrom: f.effectiveFrom,
    ...(f.ruleType === "target_range" ? { greenMin: f.greenMin, greenMax: f.greenMax, yellowMin: f.yellowMin, yellowMax: f.yellowMax } : { greenBound: f.greenBound, yellowBound: f.yellowBound }),
    reason: f.reason || null,
    source: f.source || null,
  });
  const errs = validateRule({ ruleType: f.ruleType, greenBound: f.greenBound, yellowBound: f.yellowBound, greenMin: f.greenMin, greenMax: f.greenMax, yellowMin: f.yellowMin, yellowMax: f.yellowMax });
  const num = (k: keyof typeof f, label: string) => (
    <Field label={`${label} (${metric.unit})`}>
      <input className="input" inputMode="decimal" value={f[k]} onChange={(e) => set(k, e.target.value)} />
    </Field>
  );
  const backdated = latest && f.effectiveFrom < latest.effectiveFrom;
  return (
    <div className="space-y-4 text-sm">
      {versions.length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs font-medium text-accent">ประวัติเกณฑ์ ({versions.length} ฉบับ)</summary>
          <ul className="mt-2 space-y-1 text-xs">
            {versions.map((v) => (
              <li key={v.id} className="rounded border border-border px-2 py-1">
                <b>
                  {v.effectiveFrom} → {v.effectiveTo ?? "ปัจจุบัน"}
                </b>{" "}
                · {RULE_LABEL[v.ruleType]} · {describeRule(v, metric.unit)}
                {v.reason && <span className="block text-muted">เหตุผล: {v.reason}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          start(async () => {
            const r = await addThresholdAction(assetId, metric.id, payload());
            setRes(r);
            if (r.ok) onDone();
          });
        }}
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="รูปแบบเกณฑ์">
            <select className="input" value={f.ruleType} onChange={(e) => set("ruleType", e.target.value)}>
              {(Object.keys(RULE_LABEL) as RuleType[]).map((r) => (
                <option key={r} value={r}>
                  {RULE_LABEL[r]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="มีผลตั้งแต่ *" hint={latest ? `ต้องไม่ก่อน ${latest.effectiveFrom} (เกณฑ์ล่าสุด)` : "ค่าที่บันทึกก่อนวันนี้จะไม่มีเกณฑ์"}>
            <input className="input" type="date" required value={f.effectiveFrom} onChange={(e) => set("effectiveFrom", e.target.value)} />
          </Field>
          {f.ruleType === "target_range" ? (
            <>
              {num("yellowMin", "เหลืองต่ำสุด")}
              {num("greenMin", "เขียวต่ำสุด")}
              {num("greenMax", "เขียวสูงสุด")}
              {num("yellowMax", "เหลืองสูงสุด")}
            </>
          ) : f.ruleType === "lower_is_better" ? (
            <>
              {num("greenBound", "เขียวถ้า ≤")}
              {num("yellowBound", "เหลืองถ้า ≤ (เกินนี้แดง)")}
            </>
          ) : (
            <>
              {num("greenBound", "เขียวถ้า ≥")}
              {num("yellowBound", "เหลืองถ้า ≥ (ต่ำกว่านี้แดง)")}
            </>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="เหตุผล">
            <input className="input" maxLength={500} value={f.reason} onChange={(e) => set("reason", e.target.value)} />
          </Field>
          <Field label="แหล่งอ้างอิง">
            <input className="input" maxLength={200} value={f.source} onChange={(e) => set("source", e.target.value)} />
          </Field>
        </div>
        {errs.length > 0 && (f.greenBound || f.yellowBound || f.greenMin) && (
          <p className="text-xs text-neg" role="alert">
            {errs[0]}
          </p>
        )}
        {backdated && (
          <p className="text-xs text-neg" role="alert">
            วันเริ่มต้องไม่ก่อน {latest.effectiveFrom} — ระบบไม่ย้อนแก้สถานะของค่าในอดีต
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn-ghost text-xs"
            disabled={pending || errs.length > 0 || !!backdated}
            onClick={() =>
              start(async () => {
                const r = await previewThresholdAction(assetId, metric.id, payload());
                if (r.ok) setPreview(r.data as typeof preview);
                else setRes(r);
              })
            }
          >
            ดูผลกระทบก่อนบันทึก
          </button>
          {preview && (
            <span className="text-xs text-muted" role="status">
              ค่าตั้งแต่ {f.effectiveFrom}: {preview.affected} รายการ · เปลี่ยนสถานะ {preview.changed} รายการ · ค่าก่อนหน้านั้นคงใช้เกณฑ์เดิม
            </span>
          )}
        </div>
        {preview && preview.rows.length > 0 && (
          <div className="max-h-40 overflow-y-auto rounded border border-border">
            <table className="table text-xs">
              <thead>
                <tr>
                  <th>วันที่</th>
                  <th className="text-right">ค่า</th>
                  <th>เดิม</th>
                  <th>ใหม่</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r) => (
                  <tr key={r.observedOn} className={clsx(r.before !== r.after && "font-medium")}>
                    <td>{r.observedOn}</td>
                    <td className="text-right tabular-nums">{r.value}</td>
                    <td>{STATUS_LABEL[r.before]}</td>
                    <td>{STATUS_LABEL[r.after]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Msg r={res} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onDone}>
            ยกเลิก
          </button>
          <button type="submit" className="btn" disabled={pending || errs.length > 0 || !!backdated}>
            {pending ? "กำลังบันทึก…" : "บันทึกเกณฑ์"}
          </button>
        </div>
      </form>
    </div>
  );
}

export function DeleteMetricForm({ assetId, metric, onDone }: { assetId: number; metric: { id: number; name: string; observationCount: number }; onDone: () => void }) {
  const [confirm, setConfirm] = useState("");
  const [res, setRes] = useState<MetricActionResult | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="space-y-3 text-sm">
      <p className="text-xs text-muted">
        ลบตัวชี้วัด <b>{metric.name}</b> พร้อมค่าที่บันทึก {metric.observationCount} รายการและเกณฑ์ทั้งหมด (บันทึกใน audit) — ถ้าแค่ไม่อยากเห็น ให้ใช้ “เก็บถาวร” แทน
      </p>
      <Field label={`พิมพ์ ${metric.name} เพื่อยืนยัน`}>
        <input className="input" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
      </Field>
      <Msg r={res} />
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={onDone}>
          ยกเลิก
        </button>
        <button
          type="button"
          className="inline-flex items-center rounded-lg bg-neg px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
          disabled={pending || confirm.trim() !== metric.name}
          onClick={() =>
            start(async () => {
              const r = await deleteMetricAction(assetId, metric.id, confirm);
              setRes(r);
              if (r.ok) onDone();
            })
          }
        >
          ลบถาวร
        </button>
      </div>
    </div>
  );
}
