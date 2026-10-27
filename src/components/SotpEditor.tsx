"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { DEFAULT_DCF } from "@/lib/finance/valuation";
import type { SotpIssue, SotpResult } from "@/lib/finance/sotp";
import { evaluate, valuationInput, type ValuationInput } from "@/lib/valuation-schemas";
import { saveValuationAction } from "@/app/(app)/valuation/actions";
import { ScenarioWorkbench } from "./ScenarioWorkbench";
import type { ScenarioSet } from "@/lib/valuation-scenario-schema";
import { exportValuationFile, parseValuationImport } from "@/lib/governance";
import { fmtNum, fmtPct, signClass } from "@/lib/format";
import { NumField, SelectField } from "./fields";
import type { EditorDefaults } from "./ValuationEditor";

type Sotp = Extract<ValuationInput, { method: "sotp" }>["assumptions"];
type Segment = Sotp["segments"][number];
type Source = Segment["source"];
type SegModel = Extract<Source, { type: "model" }>["valuation"];
type ModelMethod = SegModel["method"];
type Details = Omit<SotpResult, "warnings"> & { warnings: string[]; warningDetails: SotpIssue[]; valueUnit: string | null };

const ROLES: { value: Segment["role"]; label: string }[] = [
  { value: "division", label: "ส่วนงานภายใน (100%)" },
  { value: "subsidiary", label: "บริษัทย่อย (รวมงบ)" },
  { value: "associate", label: "บริษัทร่วม / JV" },
  { value: "investment", label: "เงินลงทุนอื่น" },
];
const SOURCES: { value: Source["type"]; label: string }[] = [
  { value: "multiple", label: "ตัวคูณ (เช่น EBITDA × EV/EBITDA)" },
  { value: "model", label: "โมเดลเดิม (DCF / DDM / RI / Multiples)" },
  { value: "market", label: "ราคาตลาด (บริษัทจดทะเบียน)" },
  { value: "manual", label: "มูลค่าที่ตรวจสอบแล้ว (ระบุที่มา)" },
];
const MODEL_METHODS: { value: ModelMethod; label: string }[] = [
  { value: "dcf_fcff", label: "DCF – FCFF" },
  { value: "dcf_fcfe", label: "DCF – FCFE" },
  { value: "ddm", label: "DDM" },
  { value: "residual_income", label: "Residual income" },
  { value: "multiples", label: "Multiples (ต่อหุ้น)" },
];

/** Editable fields per sub-model (the full model editor covers the rest; values stay in the saved JSON). */
const MODEL_FIELDS: Record<ModelMethod, { k: string; l: string; pct?: boolean }[]> = {
  dcf_fcff: [
    { k: "revenue0", l: "รายได้ปีล่าสุด" },
    { k: "years", l: "ปีประมาณการ" },
    { k: "growthStart", l: "Growth ปีแรก", pct: true },
    { k: "growthEnd", l: "Growth ปีสุดท้าย", pct: true },
    { k: "ebitMarginStart", l: "EBIT margin ปีแรก", pct: true },
    { k: "ebitMarginEnd", l: "EBIT margin ปีสุดท้าย", pct: true },
    { k: "taxRate", l: "ภาษี", pct: true },
    { k: "daPct", l: "D&A / รายได้", pct: true },
    { k: "capexPct", l: "Capex / รายได้", pct: true },
    { k: "nwcPct", l: "NWC / รายได้", pct: true },
    { k: "riskFree", l: "Risk-free", pct: true },
    { k: "beta", l: "Beta" },
    { k: "equityRiskPremium", l: "ERP", pct: true },
    { k: "costOfDebt", l: "ต้นทุนหนี้ก่อนภาษี", pct: true },
    { k: "targetDebtWeight", l: "Target D/(D+E)", pct: true },
    { k: "terminalGrowth", l: "Terminal growth", pct: true },
    { k: "exitMultiple", l: "Exit multiple" },
    { k: "debt", l: "หนี้ของส่วนงาน" },
    { k: "cash", l: "เงินสดของส่วนงาน" },
  ],
  dcf_fcfe: [],
  ddm: [
    { k: "d0", l: "เงินปันผลต่อหุ้นล่าสุด" },
    { k: "highGrowth", l: "Growth ช่วงสูง", pct: true },
    { k: "highGrowthYears", l: "จำนวนปีช่วงสูง" },
    { k: "terminalGrowth", l: "Growth ระยะยาว", pct: true },
    { k: "riskFree", l: "Risk-free", pct: true },
    { k: "beta", l: "Beta" },
    { k: "equityRiskPremium", l: "ERP", pct: true },
  ],
  residual_income: [
    { k: "bookValuePerShare", l: "Book value ต่อหุ้น" },
    { k: "roe", l: "ROE", pct: true },
    { k: "payoutRatio", l: "Payout", pct: true },
    { k: "terminalGrowth", l: "Growth ระยะยาว", pct: true },
    { k: "riskFree", l: "Risk-free", pct: true },
    { k: "beta", l: "Beta" },
    { k: "equityRiskPremium", l: "ERP", pct: true },
  ],
  multiples: [
    { k: "eps", l: "EPS" },
    { k: "bookValuePerShare", l: "BVPS" },
    { k: "ebitda", l: "EBITDA" },
    { k: "netDebt", l: "หนี้สุทธิ" },
    { k: "sharesOutstanding", l: "จำนวนหุ้น" },
    { k: "targetPE", l: "Target P/E" },
    { k: "targetPBV", l: "Target P/BV" },
    { k: "targetEvEbitda", l: "Target EV/EBITDA" },
  ],
};
MODEL_FIELDS.dcf_fcfe = MODEL_FIELDS.dcf_fcff.filter((f) => !["costOfDebt", "targetDebtWeight"].includes(f.k));

function defaultModel(m: ModelMethod, d: EditorDefaults): SegModel {
  const disc = { riskFree: d.riskFree, beta: 1, equityRiskPremium: d.equityRiskPremium, extraPremium: 0 };
  switch (m) {
    case "dcf_fcff":
    case "dcf_fcfe":
      // Segment DCF: totals matter, not per-share — one "share", no market price, target capital structure.
      return { method: m, assumptions: { ...DEFAULT_DCF, ...disc, revenue0: 10_000, debt: 0, cash: 0, sharesOutstanding: 1, currentPrice: 0, targetDebtWeight: 0.3 } };
    case "ddm":
      return { method: m, assumptions: { d0: 1, currentPrice: 0, ...disc, model: "two_stage", highGrowth: 0.05, highGrowthYears: 5, terminalGrowth: 0.025 } };
    case "residual_income":
      return { method: m, assumptions: { bookValuePerShare: 10, roe: 0.12, payoutRatio: 0.5, currentPrice: 0, ...disc, terminalGrowth: 0.03 } };
    case "multiples":
      return { method: m, assumptions: { eps: 1, bookValuePerShare: 10, ebitda: 1_000, netDebt: 0, sharesOutstanding: 1_000, currentPrice: 0, targetPE: 12, targetPBV: 1.2, targetEvEbitda: 8 } };
  }
}

function defaultSource(t: Source["type"], d: EditorDefaults): Source {
  if (t === "model") return { type: "model", valuation: defaultModel("dcf_fcff", d) };
  if (t === "market") return { type: "market", price: 10, shares: 100 };
  if (t === "manual") return { type: "manual", value: 1_000, basis: "equity", source: "" };
  return { type: "multiple", metric: 1_000, multiple: 8, metricLabel: "EBITDA", basis: "enterprise" };
}

const newSegment = (n: number, d: EditorDefaults): Segment => ({ name: `ส่วนงาน ${n}`, role: "division", ownership: 1, fx: 1, source: defaultSource("multiple", d) });

export function SotpEditor({
  id,
  symbol: initialSymbol,
  symbols,
  assumptions,
  title: initialTitle,
  note: initialNote,
  defaults,
  saved,
}: {
  id?: number;
  symbol: string;
  symbols: string[];
  assumptions?: unknown;
  title?: string;
  note?: string;
  defaults: EditorDefaults;
  saved?: { inputHash?: string; savedAt?: string } | null;
}) {
  const router = useRouter();
  const [symbol, setSymbol] = useState(initialSymbol);
  const [title, setTitle] = useState(initialTitle ?? "");
  const [note] = useState(initialNote ?? "");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const [a, setA] = useState<Sotp>(() => {
    const parsed = assumptions ? valuationInput.safeParse({ method: "sotp", assumptions }) : null;
    if (parsed?.success && parsed.data.method === "sotp") return parsed.data.assumptions;
    return {
      sharesOutstanding: 1_000,
      currentPrice: defaults.currentPrice || 10,
      valueUnit: "ล้านบาท",
      segments: [newSegment(1, defaults)],
      netDebt: 0,
      netDebtBasis: "consolidated",
      nonOperatingAssets: [],
      otherClaims: [],
      eliminations: [],
      holdingDiscount: 0,
      holdingDiscountBase: "all_segments",
      inputMeta: defaults.inputMeta,
    };
  });

  const result = useMemo(() => {
    try {
      const r = evaluate({ method: "sotp", assumptions: a });
      return { value: r.value, upside: r.upside, d: r.details as unknown as Details, error: null };
    } catch (e) {
      return { value: null, upside: null, d: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [a]);

  const set = <K extends keyof Sotp>(k: K, v: Sotp[K]) => setA((x) => ({ ...x, [k]: v }));
  const scenarioInput = useMemo(() => ({ method: "sotp" as const, assumptions: a }), [a]);
  // Scenarios address segments by a stable id: give segments without one an id from entity / name.
  const setScenarioSet = (scenarioSet: ScenarioSet | undefined) =>
    setA((x) => {
      const used = new Set(x.segments.map((s) => s.id).filter(Boolean));
      const segments = x.segments.map((s) => {
        if (s.id) return s;
        let id = (s.entity || s.name).toLowerCase().replace(/[^a-z0-9ก-๙_-]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "seg";
        while (used.has(id)) id += "-2";
        used.add(id);
        return { ...s, id };
      });
      return { ...x, segments, scenarioSet };
    });
  const setSeg = (i: number, patch: Partial<Segment>) => setA((x) => ({ ...x, segments: x.segments.map((s, k) => (k === i ? { ...s, ...patch } : s)) }));

  function save() {
    setMsg(null);
    start(async () => {
      const r = await saveValuationAction({ id, symbol, title, note, valuation: { method: "sotp", assumptions: a } });
      if (!r.ok) return setMsg({ ok: false, text: r.error });
      setMsg({ ok: true, text: "บันทึกแล้ว" });
      router.push(`/valuation/stock/${encodeURIComponent(symbol)}`);
    });
  }

  function exportJson() {
    const file = exportValuationFile({ symbol, title, note, valuation: { method: "sotp", assumptions: a } });
    const blob = new Blob([JSON.stringify(file, null, 2)], { type: "application/json" });
    const el = document.createElement("a");
    el.href = URL.createObjectURL(blob);
    el.download = `${symbol || "valuation"}-sotp-${new Date().toISOString().slice(0, 10)}.json`;
    el.click();
    URL.revokeObjectURL(el.href);
  }

  async function importJson(file: File) {
    const r = parseValuationImport(await file.text());
    if (!r.ok) return setMsg({ ok: false, text: r.error });
    if (r.valuation.method !== "sotp") return setMsg({ ok: false, text: "ไฟล์นี้ไม่ใช่ SOTP — นำเข้าในหน้าประเมินมูลค่าปกติ" });
    setA(r.valuation.assumptions);
    if (r.symbol) setSymbol(r.symbol);
    if (r.title) setTitle(r.title);
    setMsg({ ok: true, text: "นำเข้าแล้ว — ตรวจแล้วกดบันทึก" });
  }

  const d = result.d;
  const unit = a.valueUnit || "";
  return (
    <div className="space-y-6">
      <div className="card grid gap-3 sm:grid-cols-4">
        <label className="block">
          <span className="label">สินทรัพย์ (บริษัทแม่)</span>
          <input className="input" list="symbols" value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} />
          <datalist id="symbols">
            {symbols.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </label>
        <label className="block sm:col-span-3">
          <span className="label">ชื่อ / scenario</span>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="เช่น SOTP Base case 2026" />
        </label>
        <div className="flex flex-wrap items-center gap-2 sm:col-span-4">
          <button type="button" className="btn" onClick={save} disabled={pending || !symbol || result.value == null}>
            {pending ? "กำลังบันทึก…" : id ? "บันทึกการแก้ไข" : "บันทึก SOTP"}
          </button>
          <button type="button" className="btn-ghost" onClick={exportJson}>ส่งออก JSON</button>
          <label className="btn-ghost cursor-pointer">
            นำเข้า JSON
            <input type="file" accept="application/json,.json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) importJson(f); e.target.value = ""; }} />
          </label>
          {msg && <span className={clsx("text-sm", msg.ok ? "text-pos" : "text-neg")}>{msg.text}</span>}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        <section className="space-y-4 lg:col-span-3">
          <div className="card space-y-3">
            <h2 className="text-[15px] font-semibold">บริษัทแม่</h2>
            <div className="grid gap-3 sm:grid-cols-3">
              <NumField label="จำนวนหุ้น (หน่วยเดียวกับมูลค่า)" value={a.sharesOutstanding} onChange={(v) => set("sharesOutstanding", v ?? 0)} hint="เช่น มูลค่าเป็นล้านบาท → หุ้นเป็นล้านหุ้น" />
              <NumField label="ราคาปัจจุบัน" value={a.currentPrice} onChange={(v) => set("currentPrice", v ?? 0)} />
              <label className="block">
                <span className="label">หน่วยมูลค่า</span>
                <input className="input" value={a.valueUnit ?? ""} onChange={(e) => set("valueUnit", e.target.value || undefined)} />
              </label>
              <NumField label="หนี้สุทธิ (หนี้ − เงินสด)" value={a.netDebt} onChange={(v) => set("netDebt", v ?? 0)} />
              <SelectField
                label="หนี้สุทธินี้เป็นของ"
                value={a.netDebtBasis}
                options={[{ value: "consolidated", label: "งบรวม (รวมบริษัทย่อย)" }, { value: "holdco", label: "บริษัทแม่อย่างเดียว" }]}
                onChange={(v) => set("netDebtBasis", v)}
              />
              <NumField label="ส่วนของผู้ถือหุ้นส่วนน้อย" nullable value={a.minorityInterest ?? null} onChange={(v) => set("minorityInterest", v ?? undefined)} hint="ว่าง = คำนวณจาก (1 − สัดส่วนถือหุ้น) × (EV − หนี้สุทธิของส่วนงาน) สำหรับบริษัทย่อยที่นับ EV เต็ม" />
              <NumField label="Holding discount" pct value={a.holdingDiscount} onChange={(v) => set("holdingDiscount", v ?? 0)} />
              <SelectField
                label="หัก discount จาก"
                value={a.holdingDiscountBase}
                options={[{ value: "all_segments", label: "ทุกส่วนงาน" }, { value: "investments_only", label: "เฉพาะบริษัทย่อย/ร่วม/เงินลงทุน" }]}
                onChange={(v) => set("holdingDiscountBase", v)}
              />
            </div>
          </div>

          {a.segments.map((s, i) => (
            <SegmentCard
              key={i}
              s={s}
              row={d?.segments[i]}
              unit={unit}
              defaults={defaults}
              onChange={(p) => setSeg(i, p)}
              onRemove={a.segments.length > 1 ? () => set("segments", a.segments.filter((_, k) => k !== i)) : undefined}
            />
          ))}
          <button type="button" className="btn-ghost" onClick={() => set("segments", [...a.segments, newSegment(a.segments.length + 1, defaults)])}>
            + เพิ่มส่วนงาน
          </button>

          <div className="card space-y-4">
            <h2 className="text-[15px] font-semibold">รายการปรับ (EV → Equity bridge)</h2>
            <LineItems title="บวก: สินทรัพย์นอกการดำเนินงาน (ที่ดิน, เงินลงทุนที่ไม่ได้แยกเป็นส่วนงาน)" items={a.nonOperatingAssets} onChange={(v) => set("nonOperatingAssets", v)} />
            <LineItems title="หัก: ภาระผูกพันอื่น (หุ้นบุริมสิทธิ, ภาระผูกพันพนักงาน)" items={a.otherClaims} onChange={(v) => set("otherClaims", v)} />
            <LineItems title="หัก: ตัดรายการระหว่างกัน (มูลค่าที่นับซ้ำในหลายส่วนงาน)" items={a.eliminations} onChange={(v) => set("eliminations", v)} />
          </div>
        </section>

        <section className="space-y-4 lg:col-span-2">
          <div className="card space-y-2">
            <h2 className="text-[15px] font-semibold">มูลค่าต่อหุ้น (SOTP)</h2>
            <div className="text-3xl font-semibold tabular-nums">{fmtNum(result.value)}</div>
            <div className="text-sm text-muted">
              ราคา {fmtNum(a.currentPrice)} · Upside <span className={signClass(result.upside)}>{fmtPct(result.upside, 1)}</span>
            </div>
            {result.error && <p className="text-sm text-neg">{result.error}</p>}
            {d?.errors.map((e, i) => (
              <p key={i} className="text-sm text-neg">✕ {e.message}</p>
            ))}
            {d?.warnings.map((w, i) => (
              <p key={i} className="text-xs text-warn">⚠ {w}</p>
            ))}
          </div>
          {d && d.waterfall.length > 0 && <Waterfall steps={d.waterfall} unit={unit} />}
          {d?.reconciliation && (
            <div className="card space-y-1 text-sm">
              <h3 className="font-semibold">EV-to-Equity reconciliation ({unit})</h3>
              <Row k="รวมมูลค่าส่วนงาน" v={d.reconciliation.sumOfParts} />
              <Row k="− Holding discount" v={-d.reconciliation.holdingDiscount} />
              <Row k="+ สินทรัพย์นอกการดำเนินงาน" v={d.reconciliation.nonOperatingAssets} />
              <Row k="− หนี้สุทธิที่รายงาน" v={-d.reconciliation.netDebtReported} />
              <Row k="+ หนี้สุทธิที่หักในส่วนงานแล้ว" v={d.reconciliation.netDebtCountedInSegments} />
              <Row k={`− ส่วนของผู้ถือหุ้นส่วนน้อย${d.reconciliation.minoritySource === "derived" ? " (คำนวณ)" : ""}`} v={-d.reconciliation.minorityInterest} />
              <Row k="− ภาระผูกพันอื่น" v={-d.reconciliation.otherClaims} />
              <Row k="− ตัดรายการระหว่างกัน" v={-d.reconciliation.eliminations} />
              <div className="border-t border-[var(--border)] pt-1">
                <Row k="= มูลค่าส่วนของผู้ถือหุ้นบริษัทแม่" v={d.reconciliation.equityValue} bold />
              </div>
              <p className="text-xs text-muted">ส่วนต่างการกระทบยอด: {fmtNum(d.reconciliation.difference, 6)}</p>
            </div>
          )}
          {d?.sensitivity && (
            <div className="card space-y-3 text-sm">
              <h3 className="font-semibold">Sensitivity (มูลค่าต่อหุ้น)</h3>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-muted">
                    <th className="text-left">ส่วนงาน</th>
                    <th className="text-right">−{d.sensitivity.step * 100}%</th>
                    <th className="text-right">+{d.sensitivity.step * 100}%</th>
                  </tr>
                </thead>
                <tbody>
                  {d.sensitivity.segments.map((x) => (
                    <tr key={x.name} className="border-t border-[var(--border)]">
                      <td>{x.name}</td>
                      <td className="text-right tabular-nums">{fmtNum(x.down)}</td>
                      <td className="text-right tabular-nums">{fmtNum(x.up)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="flex flex-wrap gap-2 text-xs">
                {d.sensitivity.holdingDiscount.map((x) => (
                  <span key={x.discount} className={clsx("rounded border border-[var(--border)] px-2 py-1", x.discount === a.holdingDiscount && "font-semibold")}>
                    discount {fmtPct(x.discount, 0)} → {fmtNum(x.value)}
                  </span>
                ))}
              </div>
            </div>
          )}
        </section>
      </div>
      <ScenarioWorkbench input={scenarioInput} onChange={setScenarioSet} saved={saved} />
    </div>
  );
}

function Row({ k, v, bold }: { k: string; v: number; bold?: boolean }) {
  return (
    <div className={clsx("flex justify-between", bold && "font-semibold")}>
      <span className="text-muted">{k}</span>
      <span className="tabular-nums">{fmtNum(v + 0)}</span>
    </div>
  );
}

function SegmentCard({
  s,
  row,
  unit,
  defaults,
  onChange,
  onRemove,
}: {
  s: Segment;
  row?: SotpResult["segments"][number];
  unit: string;
  defaults: EditorDefaults;
  onChange: (p: Partial<Segment>) => void;
  onRemove?: () => void;
}) {
  const src = s.source;
  const setSrc = (p: Record<string, unknown>) => onChange({ source: { ...src, ...p } as Source });
  return (
    <div className="card space-y-3">
      <div className="flex items-start gap-3">
        <input className="input font-semibold" value={s.name} onChange={(e) => onChange({ name: e.target.value })} />
        {onRemove && (
          <button type="button" className="btn-ghost shrink-0 text-xs" onClick={onRemove}>
            ลบ
          </button>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        <SelectField label="ประเภท" value={s.role} options={ROLES} onChange={(v) => onChange({ role: v, ...(v === "division" ? { ownership: 1 } : {}) })} />
        <NumField label="สัดส่วนถือหุ้น" pct value={s.ownership} onChange={(v) => onChange({ ownership: v ?? 0 })} />
        <NumField label="FX (บาท ต่อ 1 หน่วยสกุลส่วนงาน)" value={s.fx} onChange={(v) => onChange({ fx: v ?? 1 })} />
        <label className="block">
          <span className="label">Ticker / รหัสกิจการ</span>
          <input className="input" value={s.entity ?? ""} onChange={(e) => onChange({ entity: e.target.value || undefined })} placeholder="กันนับซ้ำ" />
        </label>
        <div className="sm:col-span-2">
          <SelectField label="ที่มาของมูลค่า" value={src.type} options={SOURCES} onChange={(t) => onChange({ source: defaultSource(t, defaults) })} />
        </div>
        <NumField label="หนี้สุทธิของส่วนงาน" nullable value={s.netDebt ?? null} onChange={(v) => onChange({ netDebt: v ?? undefined })} hint="ว่าง = ใช้จากโมเดลย่อย (DCF / Multiples) ถ้ามี" />
        <SelectField
          label="หักหนี้ที่"
          value={s.debtAt ?? "auto"}
          options={[{ value: "auto", label: "อัตโนมัติ" }, { value: "segment", label: "ส่วนงาน (EV − หนี้)" }, { value: "parent", label: "บริษัทแม่ (หนี้รวม)" }]}
          onChange={(v) => onChange({ debtAt: v === "auto" ? undefined : v })}
        />
      </div>

      {src.type === "multiple" && (
        <div className="grid gap-3 sm:grid-cols-4">
          <label className="block">
            <span className="label">ตัวชี้วัด</span>
            <input className="input" value={src.metricLabel} onChange={(e) => setSrc({ metricLabel: e.target.value })} />
          </label>
          <NumField label={`${src.metricLabel} (${unit})`} value={src.metric} onChange={(v) => setSrc({ metric: v ?? 0 })} />
          <NumField label="ตัวคูณ" value={src.multiple} onChange={(v) => setSrc({ multiple: v ?? 0 })} />
          <SelectField label="ผลลัพธ์เป็น" value={src.basis} options={[{ value: "enterprise", label: "EV" }, { value: "equity", label: "Equity" }]} onChange={(v) => setSrc({ basis: v })} />
          <label className="block sm:col-span-4">
            <span className="label">ที่มาของตัวคูณ</span>
            <input className="input" value={src.source ?? ""} onChange={(e) => setSrc({ source: e.target.value || undefined })} placeholder="เช่น ค่ากลาง peers ณ 2026-10" />
          </label>
        </div>
      )}
      {src.type === "market" && (
        <div className="grid gap-3 sm:grid-cols-3">
          <NumField label="ราคาหุ้น" value={src.price} onChange={(v) => setSrc({ price: v ?? 0 })} />
          <NumField label="จำนวนหุ้นทั้งหมด (100%)" value={src.shares} onChange={(v) => setSrc({ shares: v ?? 0 })} />
          <label className="block">
            <span className="label">ณ วันที่</span>
            <input type="date" className="input" value={src.asOf ?? ""} onChange={(e) => setSrc({ asOf: e.target.value || undefined })} />
          </label>
        </div>
      )}
      {src.type === "manual" && (
        <div className="grid gap-3 sm:grid-cols-3">
          <NumField label={`มูลค่า 100% (${unit})`} value={src.value} onChange={(v) => setSrc({ value: v ?? 0 })} />
          <SelectField label="เป็น" value={src.basis} options={[{ value: "equity", label: "Equity" }, { value: "enterprise", label: "EV" }]} onChange={(v) => setSrc({ basis: v })} />
          <label className="block">
            <span className="label">ณ วันที่</span>
            <input type="date" className="input" value={src.asOf ?? ""} onChange={(e) => setSrc({ asOf: e.target.value || undefined })} />
          </label>
          <label className="block sm:col-span-3">
            <span className="label">ที่มา (จำเป็น)</span>
            <input className={clsx("input", !src.source && "border-neg")} value={src.source} onChange={(e) => setSrc({ source: e.target.value })} placeholder="เช่น รายงานประเมินราคาที่ดิน 2026 / ราคาธุรกรรม" />
          </label>
        </div>
      )}
      {src.type === "model" && <ModelFields src={src} defaults={defaults} unit={unit} onChange={(p) => onChange({ source: { ...src, ...p } })} />}

      {row && (
        <div className="rounded bg-[var(--muted-bg,transparent)] text-xs">
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted">
            <span>{row.basis === "enterprise" ? "EV" : "Equity"} {fmtNum(row.value)}</span>
            {row.equity100 != null && <span>Equity 100% {fmtNum(row.equity100)}</span>}
            <span>หักหนี้ที่ {row.debtAt === "parent" ? "บริษัทแม่" : "ส่วนงาน"}</span>
            <span className="font-semibold text-[var(--fg)]">นับเข้า SOTP {fmtNum(row.attributable)}</span>
            {row.shareOfGross != null && <span>{fmtPct(row.shareOfGross, 1)} ของรวม</span>}
          </div>
          {row.errors.map((e, i) => (
            <p key={i} className="text-neg">✕ {e}</p>
          ))}
          {row.warnings.map((w, i) => (
            <p key={i} className="text-warn">⚠ {w}</p>
          ))}
        </div>
      )}
    </div>
  );
}

function ModelFields({ src, defaults, unit, onChange }: { src: Extract<Source, { type: "model" }>; defaults: EditorDefaults; unit: string; onChange: (p: Partial<Extract<Source, { type: "model" }>>) => void }) {
  const v = src.valuation;
  const values = v.assumptions as Record<string, unknown>;
  const setField = (k: string, x: number | null) => onChange({ valuation: { ...v, assumptions: { ...v.assumptions, [k]: x } } as SegModel });
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <SelectField label="โมเดล" value={v.method} options={MODEL_METHODS} onChange={(m) => onChange({ valuation: defaultModel(m, defaults), basis: undefined, shares: undefined })} />
        {v.method === "dcf_fcff" && (
          <SelectField label="ใช้มูลค่า" value={src.basis ?? "enterprise"} options={[{ value: "enterprise", label: "EV" }, { value: "equity", label: "Equity (หักหนี้ในโมเดล)" }]} onChange={(b) => onChange({ basis: b })} />
        )}
        {(v.method === "ddm" || v.method === "residual_income") && (
          <NumField label="จำนวนหุ้นของส่วนงาน" value={src.shares ?? null} nullable onChange={(x) => onChange({ shares: x ?? undefined })} hint="มูลค่าส่วนงาน = มูลค่าต่อหุ้น × จำนวนหุ้น" />
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        {MODEL_FIELDS[v.method].map((f) => (
          <NumField
            key={f.k}
            label={f.k === "revenue0" ? `${f.l} (${unit})` : f.l}
            pct={f.pct}
            nullable={f.k === "targetDebtWeight"}
            value={values[f.k] as number | null}
            onChange={(x) => setField(f.k, f.k === "targetDebtWeight" ? x : (x ?? 0))}
          />
        ))}
      </div>
      <p className="text-[11px] text-muted">คำนวณด้วยเครื่องยนต์เดียวกับหน้าประเมินมูลค่าปกติ · ใส่ตัวเลขเป็นยอดรวมของส่วนงานในหน่วย {unit || "เดียวกัน"}</p>
    </div>
  );
}

function LineItems({ title, items, onChange }: { title: string; items: { name: string; value: number }[]; onChange: (v: { name: string; value: number }[]) => void }) {
  return (
    <div className="space-y-2">
      <div className="text-sm text-muted">{title}</div>
      {items.map((it, i) => (
        <div key={i} className="flex gap-2">
          <input className="input" value={it.name} onChange={(e) => onChange(items.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)))} />
          <div className="w-40">
            <NumField label="" value={it.value} onChange={(v) => onChange(items.map((x, k) => (k === i ? { ...x, value: v ?? 0 } : x)))} />
          </div>
          <button type="button" className="btn-ghost text-xs" onClick={() => onChange(items.filter((_, k) => k !== i))}>
            ลบ
          </button>
        </div>
      ))}
      <button type="button" className="btn-ghost text-xs" onClick={() => onChange([...items, { name: "รายการ", value: 0 }])}>
        + เพิ่มรายการ
      </button>
    </div>
  );
}

function Waterfall({ steps, unit }: { steps: SotpResult["waterfall"]; unit: string }) {
  const max = Math.max(...steps.map((s) => Math.max(Math.abs(s.cumulative), Math.abs(s.cumulative - (s.kind === "total" ? 0 : s.amount)))), 1);
  const pct = (v: number) => `${(Math.max(v, 0) / max) * 100}%`;
  return (
    <div className="card space-y-1 text-xs">
      <h3 className="mb-1 text-sm font-semibold">SOTP waterfall ({unit})</h3>
      {steps.map((s, i) => {
        const start = s.kind === "total" ? 0 : s.cumulative - s.amount;
        const lo = Math.min(start, s.cumulative);
        const hi = Math.max(start, s.cumulative);
        return (
          <div key={i} className="grid grid-cols-[minmax(0,9rem)_1fr_5rem] items-center gap-2">
            <span className={clsx("truncate", s.kind === "total" && "font-semibold")} title={s.label}>{s.label}</span>
            <div className="relative h-4 rounded bg-[var(--border)]/30">
              <div
                className={clsx("absolute h-4 rounded", s.kind === "total" ? "bg-[var(--accent)]" : s.amount >= 0 ? "bg-emerald-500/70" : "bg-rose-500/70")}
                style={{ left: pct(lo), width: `calc(${pct(hi)} - ${pct(lo)})` }}
              />
            </div>
            <span className={clsx("text-right tabular-nums", s.kind === "total" && "font-semibold")}>{fmtNum(s.amount)}</span>
          </div>
        );
      })}
    </div>
  );
}
