"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import {
  DEFAULT_DCF,
  SENSITIVITY_AXES,
  dcf,
  dcfSensitivity,
  defaultScenarios,
  scenarioAnalysis,
  type DcfAssumptions,
  type DcfScenario,
  type InputMeta,
  type ScenarioField,
  type SensitivityAxis,
} from "@/lib/finance/valuation";
import { evaluate, type ValuationInput } from "@/lib/valuation-schemas";
import { fetchFundamentalsAction, saveValuationAction } from "@/app/(app)/valuation/actions";
import { NumField, SelectField, Toggle } from "./fields";
import { FinancialStatementsPanel, type StatementsData } from "./FinancialStatementsPanel";
import type { HistoryAssumptions } from "@/lib/financials";
import { explainValuation, type Explanation } from "@/lib/valuation-explain";
import { CalculationDetail, CalculationDrawer } from "./CalculationDetail";
import { fmtNum, fmtPct, signClass } from "@/lib/format";
import { exportValuationFile, parseValuationImport, type InputProvenance } from "@/lib/governance";

type Method = "dcf_fcff" | "dcf_fcfe" | "ddm" | "residual_income" | "multiples";
type Ddm = Extract<ValuationInput, { method: "ddm" }>["assumptions"];
type Ri = Extract<ValuationInput, { method: "residual_income" }>["assumptions"];
type Mult = Extract<ValuationInput, { method: "multiples" }>["assumptions"];

export interface EditorDefaults {
  riskFree: number;
  equityRiskPremium: number;
  currentPrice: number;
  beta: number;
  /** Sources copied into new valuations (from settings and the beta estimate). */
  inputMeta?: InputMeta;
  provenance?: { riskFree: InputProvenance; erp: InputProvenance };
}

const METHODS: { value: Method; label: string }[] = [
  { value: "dcf_fcff", label: "DCF – FCFF (WACC)" },
  { value: "dcf_fcfe", label: "DCF – FCFE (Ke)" },
  { value: "ddm", label: "Dividend discount (DDM)" },
  { value: "residual_income", label: "Residual income / Justified P/BV" },
  { value: "multiples", label: "Relative multiples" },
];

export function ValuationEditor({
  id,
  symbol: initialSymbol,
  symbols,
  method: initialMethod,
  assumptions,
  title: initialTitle,
  note: initialNote,
  defaults,
  statements,
}: {
  id?: number;
  symbol: string;
  symbols: string[];
  method: Method;
  assumptions?: unknown;
  title?: string;
  note?: string;
  defaults: EditorDefaults;
  statements: StatementsData;
}) {
  const router = useRouter();
  const [symbol, setSymbol] = useState(initialSymbol);
  const [method, setMethod] = useState<Method>(initialMethod);
  const [title, setTitle] = useState(initialTitle ?? "");
  const [note, setNote] = useState(initialNote ?? "");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  // New valuations start with the settings' sources; saved ones keep their own.
  const discount = {
    riskFree: defaults.riskFree,
    beta: defaults.beta,
    equityRiskPremium: defaults.equityRiskPremium,
    extraPremium: 0,
    ...(assumptions ? {} : { inputMeta: defaults.inputMeta }),
  };
  const isDcf = initialMethod === "dcf_fcff" || initialMethod === "dcf_fcfe";
  const [dcfA, setDcfA] = useState<DcfAssumptions>({
    ...DEFAULT_DCF,
    ...discount,
    currentPrice: defaults.currentPrice || DEFAULT_DCF.currentPrice,
    ...(isDcf ? (assumptions as Partial<DcfAssumptions>) : {}),
  });
  const [ddm, setDdm] = useState<Ddm>({
    d0: 1,
    currentPrice: defaults.currentPrice || 30,
    ...discount,
    model: "two_stage",
    highGrowth: 0.05,
    highGrowthYears: 5,
    terminalGrowth: 0.025,
    ...(initialMethod === "ddm" ? (assumptions as Partial<Ddm>) : {}),
  });
  const [ri, setRi] = useState<Ri>({
    bookValuePerShare: 20,
    roe: 0.12,
    payoutRatio: 0.5,
    currentPrice: defaults.currentPrice || 30,
    ...discount,
    terminalGrowth: 0.03,
    ...(initialMethod === "residual_income" ? (assumptions as Partial<Ri>) : {}),
  });
  const [mult, setMult] = useState<Mult>({
    eps: 2,
    bookValuePerShare: 20,
    ebitda: 20_000,
    netDebt: 20_000,
    sharesOutstanding: 5_000,
    currentPrice: defaults.currentPrice || 30,
    targetPE: 15,
    targetPBV: 1.5,
    targetEvEbitda: 8,
    ...(initialMethod === "multiples" ? (assumptions as Partial<Mult>) : {}),
  });

  const input = (m: Method): ValuationInput =>
    m === "dcf_fcff" || m === "dcf_fcfe"
      ? { method: m, assumptions: dcfA }
      : m === "ddm"
        ? { method: m, assumptions: ddm }
        : m === "residual_income"
          ? { method: m, assumptions: ri }
          : { method: m, assumptions: mult };

  const result = useMemo(() => {
    try {
      return evaluate(input(method));
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [method, dcfA, ddm, ri, mult]);

  // Every method side by side ("football field").
  const allResults = useMemo(
    () =>
      METHODS.map((m) => {
        try {
          const ex = explainValuation(input(m.value));
          return { method: m.value, label: m.label, result: evaluate(input(m.value)).value, explanation: ex };
        } catch {
          return { method: m.value, label: m.label, result: null, explanation: null };
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dcfA, ddm, ri, mult],
  );

  const [drawer, setDrawer] = useState<Explanation | null>(null);
  const activeExplanation = allResults.find((r) => r.method === method)?.explanation ?? null;

  const setD = (k: keyof DcfAssumptions) => (v: number | null) => setDcfA((a) => ({ ...a, [k]: v ?? 0 }));
  const setMeta = (k: keyof InputMeta, v: string) => {
    const patch = <T extends { inputMeta?: InputMeta }>(a: T): T => ({ ...a, inputMeta: { ...a.inputMeta, [k]: v || undefined } });
    setDcfA(patch);
    setDdm(patch);
    setRi(patch);
  };
  const setShared = (k: "riskFree" | "beta" | "equityRiskPremium" | "extraPremium" | "currentPrice", v: number) => {
    setDcfA((a) => ({ ...a, [k]: v }));
    setDdm((a) => ({ ...a, [k]: v }));
    setRi((a) => ({ ...a, [k]: v }));
    if (k === "currentPrice") setMult((a) => ({ ...a, currentPrice: v }));
  };

  async function prefill() {
    setMsg(null);
    const r = await fetchFundamentalsAction(symbol);
    if (!r.ok) return setMsg({ ok: false, text: r.error });
    const f = r.data;
    const filled: string[] = [];
    const pick = <T,>(v: T | undefined, name: string) => (v != null ? (filled.push(name), v) : undefined);
    setDcfA((a) => ({
      ...a,
      revenue0: pick(f.revenue, "revenue") ?? a.revenue0,
      ebitMarginStart: pick(f.operatingMargin, "margin") ?? a.ebitMarginStart,
      ebitMarginEnd: f.operatingMargin ?? a.ebitMarginEnd,
      debt: pick(f.totalDebt, "debt") ?? a.debt,
      cash: pick(f.totalCash, "cash") ?? a.cash,
      sharesOutstanding: pick(f.sharesOutstanding, "shares") ?? a.sharesOutstanding,
      beta: pick(f.beta, "beta") ?? a.beta,
      currentPrice: pick(f.price, "price") ?? a.currentPrice,
    }));
    if (f.price) setShared("currentPrice", f.price);
    if (f.beta) setShared("beta", f.beta);
    if (f.dividendPerShare) setDdm((a) => ({ ...a, d0: f.dividendPerShare! }));
    setRi((a) => ({ ...a, bookValuePerShare: f.bookValuePerShare ?? a.bookValuePerShare, roe: f.returnOnEquity ?? a.roe, payoutRatio: f.payoutRatio ?? a.payoutRatio }));
    setMult((a) => ({
      ...a,
      eps: f.trailingEps ?? a.eps,
      bookValuePerShare: f.bookValuePerShare ?? a.bookValuePerShare,
      ebitda: f.ebitda ?? a.ebitda,
      netDebt: f.totalDebt != null && f.totalCash != null ? f.totalDebt - f.totalCash : a.netDebt,
      sharesOutstanding: f.sharesOutstanding ?? a.sharesOutstanding,
    }));
    setMsg({ ok: true, text: `ดึงจาก Yahoo (${r.yahoo}) ได้: ${filled.join(", ") || "ไม่มีข้อมูล"} — ตรวจสอบกับงบการเงินก่อนใช้` });
  }

  function save() {
    setMsg(null);
    start(async () => {
      const r = await saveValuationAction({ id, symbol, title, note, valuation: input(method) });
      if (!r.ok) return setMsg({ ok: false, text: r.error });
      setMsg({ ok: true, text: "บันทึกแล้ว" });
      // Show the new valuation alongside the stock's other valuations.
      router.push(`/valuation/stock/${encodeURIComponent(symbol)}`);
    });
  }

  function exportJson() {
    const file = exportValuationFile({ symbol, title, note, valuation: input(method) });
    const blob = new Blob([JSON.stringify(file, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${symbol || "valuation"}-${method}-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function importJson(file: File) {
    const r = parseValuationImport(await file.text());
    if (!r.ok) return setMsg({ ok: false, text: r.error });
    const v = r.valuation;
    if (v.method === "bond") return setMsg({ ok: false, text: "ไฟล์นี้เป็นพันธบัตร — นำเข้าในหน้าพันธบัตรไม่ได้ในตอนนี้" });
    if (v.method === "dcf_fcff" || v.method === "dcf_fcfe") setDcfA((a) => ({ ...a, ...(v.assumptions as Partial<DcfAssumptions>) }));
    else if (v.method === "ddm") setDdm((a) => ({ ...a, ...v.assumptions }));
    else if (v.method === "residual_income") setRi((a) => ({ ...a, ...v.assumptions }));
    else setMult((a) => ({ ...a, ...v.assumptions }));
    setMethod(v.method);
    if (r.symbol) setSymbol(r.symbol);
    if (r.title) setTitle(r.title);
    if (r.note) setNote(r.note);
    setMsg({ ok: true, text: `นำเข้าแล้ว${r.modelVersion ? ` (ไฟล์จากสูตรเวอร์ชัน ${r.modelVersion})` : ""} — ตรวจแล้วกดบันทึก` });
  }

  function applyHistory(h: HistoryAssumptions) {
    setDcfA((a) => ({ ...a, ...h.dcf }));
    setDdm((a) => ({ ...a, ...h.ddm }));
    setRi((a) => ({ ...a, ...h.ri }));
    setMult((a) => ({ ...a, ...h.multiples }));
    setMsg({ ok: true, text: "เติมสมมติฐานจากงบการเงินย้อนหลังแล้ว" });
  }

  return (
    <div className="space-y-6">
      <div className="card grid gap-3 sm:grid-cols-4">
        <label className="block">
          <span className="label">สินทรัพย์</span>
          <input className="input" list="symbols" value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} />
          <datalist id="symbols">
            {symbols.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </label>
        <SelectField label="วิธีประเมินมูลค่า" value={method} options={METHODS} onChange={setMethod} />
        <label className="block sm:col-span-2">
          <span className="label">ชื่อ / scenario</span>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="เช่น Base case 2026" />
        </label>
        <div className="flex flex-wrap items-center gap-2 sm:col-span-4">
          <button type="button" className="btn" onClick={save} disabled={pending || !symbol}>
            {pending ? "กำลังบันทึก…" : id ? "บันทึกการแก้ไข" : "บันทึก valuation"}
          </button>
          <button type="button" className="btn-ghost" onClick={prefill}>
            ดึงข้อมูลพื้นฐาน (Yahoo)
          </button>
          <button type="button" className="btn-ghost" onClick={exportJson}>
            ส่งออก JSON
          </button>
          <label className="btn-ghost cursor-pointer">
            นำเข้า JSON
            <input
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) importJson(f);
                e.target.value = "";
              }}
            />
          </label>
          {msg && <span className={clsx("text-sm", msg.ok ? "text-pos" : "text-neg")}>{msg.text}</span>}
        </div>
      </div>

      <FinancialStatementsPanel symbol={symbol} initial={statements} terminalGrowth={dcfA.terminalGrowth} onApply={applyHistory} />

      <div className="grid gap-6 lg:grid-cols-5">
        <section className="card space-y-4 lg:col-span-3">
          <h2 className="font-semibold">สมมติฐาน</h2>
          <Group title="ราคาและอัตราคิดลด (CAPM)">
            <NumField label="ราคาปัจจุบัน" value={dcfA.currentPrice} onChange={(v) => setShared("currentPrice", v ?? 0)} />
            <NumField label="Risk-free" pct value={dcfA.riskFree} onChange={(v) => setShared("riskFree", v ?? 0)} />
            <NumField label="Beta" value={dcfA.beta} onChange={(v) => setShared("beta", v ?? 0)} />
            <NumField label="Equity risk premium" pct value={dcfA.equityRiskPremium} onChange={(v) => setShared("equityRiskPremium", v ?? 0)} />
            <NumField label="Premium เพิ่ม (size/country)" pct value={dcfA.extraPremium} onChange={(v) => setShared("extraPremium", v ?? 0)} hint="อย่าบวก country premium ซ้ำ ถ้า ERP หรือ Rf สะท้อนความเสี่ยงประเทศแล้ว" />
            <TextField label="ข้อมูล ณ วันที่" type="date" value={dcfA.inputMeta?.asOf} onChange={(v) => setMeta("asOf", v)} />
            <TextField label="ที่มา Rf" value={dcfA.inputMeta?.rfSource} placeholder="เช่น ThaiBMA 10Y" onChange={(v) => setMeta("rfSource", v)} />
            <TextField label="ที่มา ERP" value={dcfA.inputMeta?.erpSource} placeholder="เช่น Damodaran ม.ค. 2026" onChange={(v) => setMeta("erpSource", v)} />
            <TextField label="ที่มา Beta" value={dcfA.inputMeta?.betaSource} placeholder="เช่น 2 ปีรายสัปดาห์ vs SET" onChange={(v) => setMeta("betaSource", v)} />
          </Group>
          {!(dcfA.inputMeta?.rfSource && dcfA.inputMeta?.erpSource) && method !== "multiples" && (
            <p className="-mt-2 text-xs text-muted">Rf / ERP ที่ไม่ได้ระบุที่มาถือเป็นค่าตัวอย่าง — ควรใช้อัตราสกุลเงินและอายุเดียวกับกระแสเงินสด (เช่น พันธบัตรไทยระยะยาวสำหรับ DCF เงินบาท) และ ERP แบบคาดการณ์ ไม่ใช่ผลตอบแทนในอดีต</p>
          )}

          {(method === "dcf_fcff" || method === "dcf_fcfe") && (
            <>
              <Group title="ประมาณการรายได้และกำไร (หน่วยเดียวกันทั้งหมด เช่น ล้านบาท)">
                <NumField label="รายได้ปีล่าสุด" value={dcfA.revenue0} onChange={setD("revenue0")} />
                <NumField label="จำนวนปีประมาณการ" value={dcfA.years} onChange={(v) => setDcfA((a) => ({ ...a, years: Math.max(1, Math.min(20, Math.round(v ?? 5))) }))} />
                <NumField label="Growth ปีแรก" pct value={dcfA.growthStart} onChange={setD("growthStart")} />
                <NumField label="Growth ปีสุดท้าย" pct value={dcfA.growthEnd} onChange={setD("growthEnd")} />
                <NumField label="EBIT margin ปีแรก" pct value={dcfA.ebitMarginStart} onChange={setD("ebitMarginStart")} />
                <NumField label="EBIT margin ปีสุดท้าย" pct value={dcfA.ebitMarginEnd} onChange={setD("ebitMarginEnd")} />
                <NumField label="ภาษี" pct value={dcfA.taxRate} onChange={setD("taxRate")} />
              </Group>
              <Group title="การลงทุน (% ของรายได้)">
                <NumField label="ค่าเสื่อม D&A" pct value={dcfA.daPct} onChange={setD("daPct")} />
                <NumField label="Capex" pct value={dcfA.capexPct} onChange={setD("capexPct")} />
                <NumField label="Net working capital" pct value={dcfA.nwcPct} onChange={setD("nwcPct")} hint="ΔNWC = %NWC × รายได้ที่เพิ่มขึ้น" />
              </Group>
              <Group title="โครงสร้างทุน">
                <NumField label="หนี้สินที่มีดอกเบี้ย" value={dcfA.debt} onChange={setD("debt")} />
                <NumField label="เงินสด" value={dcfA.cash} onChange={setD("cash")} />
                <NumField label="Minority / อื่น ๆ" value={dcfA.otherClaims} onChange={setD("otherClaims")} />
                <NumField label="จำนวนหุ้น" value={dcfA.sharesOutstanding} onChange={setD("sharesOutstanding")} />
                <NumField label="ต้นทุนหนี้ก่อนภาษี (Kd)" pct value={dcfA.costOfDebt} onChange={setD("costOfDebt")} />
                <NumField
                  label="สัดส่วนหนี้เป้าหมาย D/(D+E)"
                  pct
                  nullable
                  value={dcfA.targetDebtWeight}
                  onChange={(v) => setDcfA((a) => ({ ...a, targetDebtWeight: v }))}
                  hint="เว้นว่าง = ใช้ market value (ราคา × หุ้น และหนี้)"
                />
                {method === "dcf_fcfe" && (
                  <SelectField
                    label="นโยบายการกู้ (FCFE)"
                    value={dcfA.debtPolicy}
                    options={[
                      { value: "fixed_borrowing_ratio", label: "สัดส่วนคงที่ของการลงทุนสุทธิ (δ)" },
                      { value: "explicit_schedule", label: "ระบุกู้สุทธิรายปี" },
                    ]}
                    onChange={(v) => setDcfA((a) => ({ ...a, debtPolicy: v, netBorrowingSchedule: a.netBorrowingSchedule ?? Array(a.years).fill(0) }))}
                  />
                )}
                {method === "dcf_fcfe" && dcfA.debtPolicy !== "explicit_schedule" && (
                  <NumField label="สัดส่วนกู้เพื่อลงทุนสุทธิ (δ)" pct value={dcfA.debtFinancingRatio} onChange={setD("debtFinancingRatio")} />
                )}
              </Group>
              {method === "dcf_fcfe" && dcfA.debtPolicy === "explicit_schedule" && (
                <Group title="กู้สุทธิรายปี (กู้ใหม่ − ชำระคืน)">
                  {Array.from({ length: dcfA.years }, (_, i) => (
                    <NumField
                      key={i}
                      label={`ปี ${i + 1}`}
                      value={dcfA.netBorrowingSchedule?.[i] ?? 0}
                      onChange={(v) =>
                        setDcfA((a) => {
                          const sched = Array.from({ length: a.years }, (_, j) => a.netBorrowingSchedule?.[j] ?? 0);
                          sched[i] = v ?? 0;
                          return { ...a, netBorrowingSchedule: sched };
                        })
                      }
                    />
                  ))}
                </Group>
              )}
              <Group title="Terminal value">
                <SelectField
                  label="วิธี"
                  value={dcfA.terminalMethod}
                  options={[
                    { value: "stable_roic", label: method === "dcf_fcff" ? "Stable ROIC (แนะนำ)" : "Stable ROE (แนะนำ)" },
                    { value: "gordon", label: "Gordon (CF ปีสุดท้าย × (1+g))" },
                    { value: "exit_multiple", label: method === "dcf_fcff" ? "Exit EV/EBITDA" : "Exit P/E" },
                  ]}
                  onChange={(v) => setDcfA((a) => ({ ...a, terminalMethod: v }))}
                />
                {dcfA.terminalMethod !== "exit_multiple" ? (
                  <NumField label="Terminal growth (g)" pct value={dcfA.terminalGrowth} onChange={setD("terminalGrowth")} />
                ) : (
                  <NumField label={method === "dcf_fcff" ? "Exit EV/EBITDA" : "Exit P/E"} value={dcfA.exitMultiple} onChange={setD("exitMultiple")} />
                )}
                {dcfA.terminalMethod === "stable_roic" &&
                  (method === "dcf_fcff" ? (
                    <NumField label="Terminal ROIC" pct value={dcfA.terminalRoic} onChange={setD("terminalRoic")} hint="Reinvestment rate = g ÷ ROIC" />
                  ) : (
                    <NumField label="Terminal ROE" pct value={dcfA.terminalRoe} onChange={setD("terminalRoe")} hint="Equity reinvestment rate = g ÷ ROE" />
                  ))}
                <div className="flex items-end pb-2">
                  <Toggle label="Mid-year convention" checked={dcfA.midYear} onChange={(v) => setDcfA((a) => ({ ...a, midYear: v }))} />
                </div>
              </Group>
              <p className="text-xs text-muted">DCF แบบ FCFF ไม่เหมาะกับธนาคาร/สถาบันการเงิน (หนี้เป็นวัตถุดิบในการดำเนินงาน) — ใช้ DDM หรือ Residual income แทน</p>
            </>
          )}

          {method === "ddm" && (
            <Group title="เงินปันผล">
              <NumField label="ปันผลต่อหุ้นล่าสุด (D0)" value={ddm.d0} onChange={(v) => setDdm((a) => ({ ...a, d0: v ?? 0 }))} />
              <SelectField
                label="โมเดล"
                value={ddm.model}
                options={[
                  { value: "gordon", label: "Gordon growth" },
                  { value: "two_stage", label: "Two-stage" },
                  { value: "h_model", label: "H-model" },
                ]}
                onChange={(v) => setDdm((a) => ({ ...a, model: v }))}
              />
              {ddm.model !== "gordon" && (
                <>
                  <NumField label="Growth ช่วงแรก" pct value={ddm.highGrowth} onChange={(v) => setDdm((a) => ({ ...a, highGrowth: v ?? 0 }))} />
                  <NumField label="จำนวนปีช่วงแรก" value={ddm.highGrowthYears} onChange={(v) => setDdm((a) => ({ ...a, highGrowthYears: Math.max(1, Math.round(v ?? 1)) }))} />
                </>
              )}
              <NumField label="Growth ระยะยาว" pct value={ddm.terminalGrowth} onChange={(v) => setDdm((a) => ({ ...a, terminalGrowth: v ?? 0 }))} />
            </Group>
          )}

          {method === "residual_income" && (
            <Group title="ส่วนของผู้ถือหุ้น">
              <NumField label="Book value ต่อหุ้น" value={ri.bookValuePerShare} onChange={(v) => setRi((a) => ({ ...a, bookValuePerShare: v ?? 0 }))} />
              <NumField label="ROE ที่ยั่งยืน" pct value={ri.roe} onChange={(v) => setRi((a) => ({ ...a, roe: v ?? 0 }))} />
              <NumField label="Payout ratio" pct value={ri.payoutRatio} onChange={(v) => setRi((a) => ({ ...a, payoutRatio: v ?? 0 }))} />
              <NumField label="Growth ระยะยาว" pct value={ri.terminalGrowth} onChange={(v) => setRi((a) => ({ ...a, terminalGrowth: v ?? 0 }))} hint="g = ROE × (1 − payout)" />
              <div className="flex items-end pb-2 text-xs text-muted">g ยั่งยืน = {fmtPct(ri.roe * (1 - ri.payoutRatio))}</div>
            </Group>
          )}

          {method === "multiples" && (
            <Group title="ตัวเลขบริษัท vs multiple อ้างอิง (peer / ค่าเฉลี่ยในอดีต)">
              <SelectField
                label="ฐานกำไร"
                value={mult.earningsBasis ?? "trailing"}
                options={[
                  { value: "trailing", label: "Trailing (12 เดือนล่าสุด)" },
                  { value: "forward", label: "Forward (ปีหน้า)" },
                ]}
                onChange={(v) => setMult((a) => ({ ...a, earningsBasis: v }))}
              />
              <NumField label="EPS" value={mult.eps} onChange={(v) => setMult((a) => ({ ...a, eps: v ?? 0 }))} />
              <NumField label="Book value ต่อหุ้น" value={mult.bookValuePerShare} onChange={(v) => setMult((a) => ({ ...a, bookValuePerShare: v ?? 0 }))} />
              <NumField label="EBITDA" value={mult.ebitda} onChange={(v) => setMult((a) => ({ ...a, ebitda: v ?? 0 }))} />
              <NumField label="หนี้สุทธิ" value={mult.netDebt} onChange={(v) => setMult((a) => ({ ...a, netDebt: v ?? 0 }))} />
              <NumField label="จำนวนหุ้น" value={mult.sharesOutstanding} onChange={(v) => setMult((a) => ({ ...a, sharesOutstanding: v ?? 0 }))} />
              <NumField label="P/E เป้าหมาย" value={mult.targetPE} onChange={(v) => setMult((a) => ({ ...a, targetPE: v ?? 0 }))} />
              <NumField label="P/BV เป้าหมาย" value={mult.targetPBV} onChange={(v) => setMult((a) => ({ ...a, targetPBV: v ?? 0 }))} />
              <NumField label="EV/EBITDA เป้าหมาย" value={mult.targetEvEbitda} onChange={(v) => setMult((a) => ({ ...a, targetEvEbitda: v ?? 0 }))} />
            </Group>
          )}

          <label className="block">
            <span className="label">หมายเหตุ / เหตุผลของสมมติฐาน</span>
            <textarea className="input" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
        </section>

        <div className="space-y-6 lg:col-span-2">
          <section className="card">
            <h2 className="mb-3 font-semibold">ผลลัพธ์</h2>
            {result?.value != null ? (
              <>
                <div className="text-xs text-muted">มูลค่าที่เหมาะสมต่อหุ้น</div>
                <div className="text-3xl font-semibold tabular-nums">{fmtNum(result.value)}</div>
                <div className={clsx("mt-1 text-sm font-medium", signClass(result.upside))}>
                  {result.upside != null && `${result.upside >= 0 ? "Upside" : "Downside"} ${fmtPct(Math.abs(result.upside), 1)} จากราคา ${fmtNum(result.price)}`}
                </div>
                {result.upside != null && result.upside > 0 && (
                  <div className="text-xs text-muted">Margin of safety {fmtPct(1 - (result.price ?? 0) / result.value, 1)}</div>
                )}
                <KeyDrivers a={method === "ddm" ? ddm : method === "residual_income" ? ri : dcfA} show={method !== "multiples"} />
                {activeExplanation && activeExplanation.warnings.length > 0 && method !== "dcf_fcff" && method !== "dcf_fcfe" && (
                  <div className="mt-3 space-y-1">
                    {activeExplanation.warnings.slice(0, 4).map((w) => (
                      <p key={w} className="text-xs text-neg">⚠️ {w}</p>
                    ))}
                  </div>
                )}
                <Details method={method} details={result.details} />
                {activeExplanation && (
                  <details className="mt-4">
                    <summary className="cursor-pointer text-sm font-medium text-accent">วิธีคำนวณโดยละเอียด ›</summary>
                    <div className="mt-3">
                      <CalculationDetail e={activeExplanation} compact />
                    </div>
                  </details>
                )}
              </>
            ) : (
              <div className="space-y-1 text-sm text-neg">
                <p>คำนวณไม่ได้</p>
                {((result?.details.errors as { message: string }[] | undefined) ?? [{ message: "ตรวจสอบว่าอัตราคิดลด > growth และข้อมูลครบ" }]).map((e) => (
                  <p key={e.message} className="text-xs">• {e.message}</p>
                ))}
              </div>
            )}
          </section>

          <section className="card">
            <h2 className="mb-3 font-semibold">เทียบทุกวิธี</h2>
            <FootballField rows={allResults} price={dcfA.currentPrice} active={method} onOpen={(r) => r.explanation && setDrawer(r.explanation)} />
            <p className="mt-2 text-xs text-muted">กดที่แต่ละวิธีเพื่อดูสมมติฐานและวิธีคำนวณ · แต่ละวิธีใช้สมมติฐานในแท็บของตัวเอง — สลับวิธีด้านบนเพื่อแก้ไข</p>
          </section>
        </div>
      </div>

      {(method === "dcf_fcff" || method === "dcf_fcfe") && (
        <>
          <DcfTables a={dcfA} model={method === "dcf_fcff" ? "fcff" : "fcfe"} />
          <ScenarioPanel a={dcfA} model={method === "dcf_fcff" ? "fcff" : "fcfe"} onChange={(scenarios) => setDcfA((a) => ({ ...a, scenarios }))} />
        </>
      )}
      <CalculationDrawer e={drawer} onClose={() => setDrawer(null)} />
    </div>
  );
}

/** Market inputs that drive the discount rate, with where each one came from. */
function KeyDrivers({ a, show }: { a: { riskFree: number; equityRiskPremium: number; beta: number; inputMeta?: InputMeta }; show: boolean }) {
  if (!show) return null;
  const src = (v?: string) => v ?? "ค่าตัวอย่าง — ไม่ได้ระบุที่มา";
  const rows: [string, string, string | undefined][] = [
    ["Rf", fmtPct(a.riskFree), a.inputMeta?.rfSource],
    ["ERP", fmtPct(a.equityRiskPremium), a.inputMeta?.erpSource],
    ["Beta", fmtNum(a.beta), a.inputMeta?.betaSource],
  ];
  return (
    <div className="mt-3 rounded-lg bg-bg p-2 text-xs">
      <div className="mb-1 font-medium">ปัจจัยหลักและที่มา{a.inputMeta?.asOf && ` (ณ ${a.inputMeta.asOf})`}</div>
      {rows.map(([k, v, s]) => (
        <div key={k} className="flex justify-between gap-2">
          <span>
            {k} <b className="tabular-nums">{v}</b>
          </span>
          <span className={clsx("truncate text-right", s ? "text-muted" : "text-neg")} title={src(s)}>
            {src(s)}
          </span>
        </div>
      ))}
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset>
      <legend className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">{title}</legend>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">{children}</div>
    </fieldset>
  );
}

function KV({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return (
    <div className="flex justify-between gap-3 border-b border-border/60 py-1.5 text-sm">
      <span className="text-muted">{k}</span>
      <span className={clsx("tabular-nums", tone)}>{v}</span>
    </div>
  );
}

function Details({ method, details }: { method: Method; details: Record<string, unknown> }) {
  const d = details as Record<string, number | null | string[]>;
  const n = (k: string) => d[k] as number | null;
  return (
    <div className="mt-4">
      {(method === "dcf_fcff" || method === "dcf_fcfe") && (
        <>
          <KV k="Cost of equity (Ke)" v={fmtPct(n("costOfEquity"))} />
          <KV k="WACC" v={fmtPct(n("wacc"))} />
          {n("enterpriseValue") != null && <KV k="Enterprise value" v={fmtNum(n("enterpriseValue"), 0)} />}
          <KV k="Equity value" v={fmtNum(n("equityValue"), 0)} />
          <KV k="Terminal value / มูลค่ารวม" v={fmtPct(n("terminalShareOfValue"), 1)} />
          <KV k="Implied terminal multiple" v={`${fmtNum((details.terminal as { impliedMultiple: number | null }).impliedMultiple, 1)}x ${(details.terminal as { multipleLabel: string }).multipleLabel}`} />
          <ReverseDcf r={details.reverseDcf as { rate: number | null; status: string; candidates: number[] } | undefined} />
          {(details.scenarios as { expectedValue: number | null; expectedUpside: number | null } | null) && (
            <KV
              k="มูลค่าคาดหวังจาก scenario"
              v={`${fmtNum((details.scenarios as { expectedValue: number | null }).expectedValue)} (${fmtPct((details.scenarios as { expectedUpside: number | null }).expectedUpside, 1)})`}
            />
          )}
          {(d.warnings as string[]).map((w) => (
            <p key={w} className="mt-2 text-xs text-neg">⚠️ {w}</p>
          ))}
        </>
      )}
      {method === "ddm" && (
        <>
          <KV k="Cost of equity (Ke)" v={fmtPct(n("costOfEquity"))} />
          <KV k="Dividend yield" v={fmtPct(n("dividendYield"))} />
        </>
      )}
      {method === "residual_income" && (
        <>
          <KV k="Cost of equity (Ke)" v={fmtPct(n("costOfEquity"))} />
          <KV k="Justified P/BV = (ROE−g)/(Ke−g)" v={fmtNum(n("justifiedPBV"))} />
          <KV k="Justified P/E" v={fmtNum(n("justifiedPE"))} />
          <KV k="P/BV ตลาด" v={fmtNum(n("marketPBV"))} />
        </>
      )}
      {method === "multiples" && (
        <>
          <KV k="ตาม P/E" v={fmtNum(n("byPE"))} />
          <KV k="ตาม P/BV" v={fmtNum(n("byPBV"))} />
          <KV k="ตาม EV/EBITDA" v={fmtNum(n("byEvEbitda"))} />
          <KV k="P/E ปัจจุบัน" v={fmtNum(n("currentPE"), 1)} />
          <KV k="P/BV ปัจจุบัน" v={fmtNum(n("currentPBV"), 2)} />
          <KV k="EV/EBITDA ปัจจุบัน" v={fmtNum(n("currentEvEbitda"), 1)} />
        </>
      )}
    </div>
  );
}

type FieldRow = { method: Method; label: string; result: number | null; explanation: Explanation | null };

function FootballField({ rows, price, active, onOpen }: { rows: FieldRow[]; price: number; active: Method; onOpen: (r: FieldRow) => void }) {
  const vals = rows.map((r) => r.result).filter((v): v is number => v != null && Number.isFinite(v) && v > 0);
  const max = Math.max(price, ...vals) * 1.1 || 1;
  return (
    <div className="space-y-1">
      {rows.map((r) => {
        const warn = (r.explanation?.warnings.length ?? 0) > 0;
        return (
          <button
            key={r.method}
            type="button"
            onClick={() => onOpen(r)}
            disabled={!r.explanation}
            className="block w-full rounded-md px-1.5 py-1 text-left text-xs hover:bg-border/40 disabled:cursor-default"
            title="ดูวิธีคำนวณ"
          >
            <div className="mb-0.5 flex justify-between gap-2">
              <span className={clsx(r.method === active && "font-semibold")}>
                {r.label} {warn && <span title={r.explanation!.warnings.join("\n")}>⚠️</span>}
              </span>
              <span className="tabular-nums">
                {r.result != null && Number.isFinite(r.result) ? fmtNum(r.result) : "–"} <span className="text-accent">›</span>
              </span>
            </div>
            <div className="relative h-2.5 rounded-full bg-border/50">
              {r.result != null && r.result > 0 && (
                <div className="h-2.5 rounded-full" style={{ width: `${Math.min(100, (r.result / max) * 100)}%`, background: "var(--series-1)" }} />
              )}
              <div className="absolute -top-[3px] h-4 w-0.5 bg-text" style={{ left: `${(price / max) * 100}%` }} />
            </div>
          </button>
        );
      })}
      <div className="text-right text-[11px] text-muted">เส้นตั้ง = ราคาปัจจุบัน {fmtNum(price)}</div>
    </div>
  );
}

function TextField({ label, value, onChange, placeholder, type = "text" }: { label: string; value?: string; onChange: (v: string) => void; placeholder?: string; type?: string }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      <input className="input" type={type} value={value ?? ""} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function ReverseDcf({ r }: { r?: { rate: number | null; status: string; candidates: number[] } }) {
  if (!r) return null;
  const v =
    r.status === "ok"
      ? fmtPct(r.rate, 1)
      : r.status === "multiple_roots"
        ? `หลายคำตอบ: ${r.candidates.map((c) => fmtPct(c, 1)).join(", ")}`
        : r.status === "no_root"
          ? "ไม่มี growth ในช่วง −50%…100% ที่ให้ราคานี้"
          : "–";
  return <KV k="Growth ที่ราคาตลาดสะท้อน (reverse DCF)" v={v} />;
}

function DcfTables({ a, model }: { a: DcfAssumptions; model: "fcff" | "fcfe" }) {
  const [axis, setAxis] = useState<SensitivityAxis>("terminalGrowth");
  const r = useMemo(() => dcf(a, model), [a, model]);
  const s = useMemo(() => dcfSensitivity(a, model, axis), [a, model, axis]);
  const fmt = (v: number | null) => fmtNum(v, 0);
  type Y = (typeof r.years)[number];
  const rows: [string, (y: Y) => string][] = [
    ["Growth", (y) => fmtPct(y.growth, 1)],
    ["รายได้", (y) => fmt(y.revenue)],
    ["EBIT", (y) => fmt(y.ebit)],
    ["EBIT margin", (y) => fmtPct(y.ebitMargin, 1)],
    ["NOPAT", (y) => fmt(y.nopat)],
    ["+ D&A", (y) => fmt(y.da)],
    ["− Capex", (y) => fmt(y.capex)],
    ["− ΔNWC", (y) => fmt(y.deltaNwc)],
    ["FCFF", (y) => fmt(y.fcff)],
    ...(model === "fcfe"
      ? ([
          ["หนี้ต้นงวด", (y) => fmt(y.openingDebt)],
          ["ดอกเบี้ยจ่าย (หนี้ต้นงวด × Kd)", (y) => fmt(y.interest)],
          ["กำไรสุทธิ", (y) => fmt(y.netIncome)],
          ["+ กู้สุทธิ", (y) => fmt(y.netBorrowing)],
          ["หนี้ปลายงวด", (y) => fmt(y.closingDebt)],
          ["FCFE", (y) => fmt(y.fcfe)],
        ] as [string, (y: Y) => string][])
      : []),
    ["Discount factor", (y) => y.discountFactor.toFixed(4)],
    ["PV", (y) => fmt(y.pv)],
  ];
  const t = r.terminal;
  const base = r.valuePerShare;
  const ret = model === "fcff" ? "ROIC" : "ROE";
  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <section className="card overflow-x-auto lg:col-span-3">
        <h2 className="mb-3 font-semibold">ประมาณการกระแสเงินสด ({model.toUpperCase()})</h2>
        <table className="table">
          <thead>
            <tr>
              <th />
              {r.years.map((y) => (
                <th key={y.year} className="num">ปี {y.year}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, f]) => (
              <tr key={label} className={label === "FCFF" || label === "FCFE" ? "font-semibold" : ""}>
                <td>{label}</td>
                {r.years.map((y) => (
                  <td key={y.year} className="num">{f(y)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-muted">
          PV รวม {fmt(r.sumPvCashFlows)} + PV terminal {fmt(r.pvTerminalValue)} (TV {fmt(r.terminalValue)} คิดลด {t.discountYears} ปี) · TV คิดเป็น {fmtPct(r.terminalShareOfValue, 1)} ของมูลค่า
        </p>
        <h3 className="mt-4 mb-1 text-sm font-semibold">Terminal ปีที่ {a.years + 1} (steady state)</h3>
        <div className="grid grid-cols-2 gap-x-6 sm:grid-cols-3">
          {t.method !== "exit_multiple" && (
            <>
              <KV k={`${model === "fcff" ? "NOPAT" : "กำไรสุทธิ"} ปี n+1`} v={fmt(t.earningsNext)} />
              <KV k={`${model === "fcff" ? "FCFF" : "FCFE"} ปี n+1`} v={fmt(t.cashFlowNext)} />
              <KV k="Reinvestment rate" v={fmtPct(t.reinvestmentRate, 1)} />
              <KV k={t.method === "stable_roic" ? `${ret} (สมมติฐาน)` : `${ret} ที่แฝงอยู่`} v={fmtPct(t.method === "stable_roic" ? (model === "fcff" ? a.terminalRoic : a.terminalRoe) : t.impliedReturnOnCapital, 1)} />
            </>
          )}
          <KV k={`Implied ${t.multipleLabel}`} v={`${fmtNum(t.impliedMultiple, 1)}x`} />
          {r.impliedPerpetualGrowth != null && <KV k="g ที่แฝงใน exit multiple" v={fmtPct(r.impliedPerpetualGrowth, 2)} />}
        </div>
      </section>
      <section className="card overflow-x-auto lg:col-span-2">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">Sensitivity: มูลค่าต่อหุ้น</h2>
          <select className="input w-auto py-1 text-xs" value={axis} onChange={(e) => setAxis(e.target.value as SensitivityAxis)}>
            {(Object.keys(SENSITIVITY_AXES) as SensitivityAxis[])
              .filter((k) => model === "fcfe" || k !== "debtFinancingRatio")
              .map((k) => (
                <option key={k} value={k}>
                  {SENSITIVITY_AXES[k].label}
                </option>
              ))}
          </select>
        </div>
        <table className="text-xs">
          <thead>
            <tr>
              <th className="px-2 py-1 text-left text-muted">{model === "fcff" ? "WACC" : "Ke"} ↓ / {SENSITIVITY_AXES[axis].label} →</th>
              {s.columns.map((g, j) => (
                <th key={j} className="px-2 py-1 text-right text-muted">{fmtPct(g, 1)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {s.grid.map((row, i) => (
              <tr key={i}>
                <th className="px-2 py-1 text-left font-medium text-muted">{fmtPct(s.rates[i], 1)}</th>
                {row.map((v, j) => {
                  const rel = v != null && base ? v / base - 1 : 0;
                  const c = Math.min(1, Math.abs(rel) * 2);
                  return (
                    <td
                      key={j}
                      className={clsx("border-2 border-panel px-2 py-1.5 text-right tabular-nums", i === 2 && j === 2 && "font-semibold", v == null && "text-muted")}
                      style={v != null ? { background: `color-mix(in oklab, ${rel >= 0 ? "var(--series-3)" : "var(--series-2)"} ${c * 45}%, var(--panel))` } : undefined}
                    >
                      {v != null ? fmtNum(v) : "N/A"}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-muted">ราคาปัจจุบัน {fmtNum(a.currentPrice)} · N/A = สมมติฐานใช้ไม่ได้ (เช่น อัตราคิดลด ≤ g)</p>
      </section>
    </div>
  );
}

const SCEN_COLS: { key: ScenarioField; label: string }[] = [
  { key: "growthStart", label: "Growth ปีแรก" },
  { key: "growthEnd", label: "Growth ปีสุดท้าย" },
  { key: "ebitMarginStart", label: "Margin ปีแรก" },
  { key: "ebitMarginEnd", label: "Margin ปีสุดท้าย" },
  { key: "terminalGrowth", label: "Terminal g" },
];

function ScenarioPanel({ a, model, onChange }: { a: DcfAssumptions; model: "fcff" | "fcfe"; onChange: (s: DcfScenario[] | undefined) => void }) {
  const sc = a.scenarios;
  const res = useMemo(() => (sc?.length ? scenarioAnalysis(a, model, sc) : null), [a, model, sc]);
  const update = (i: number, patch: Partial<DcfScenario>) => onChange(sc!.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <section className="card overflow-x-auto">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">Scenarios (Bear / Base / Bull)</h2>
        <Toggle label="ใช้ scenarios" checked={!!sc?.length} onChange={(on) => onChange(on ? defaultScenarios(a) : undefined)} />
      </div>
      {!sc?.length ? (
        <p className="text-xs text-muted">เปิดเพื่อกำหนดสมมติฐานแต่ละกรณีพร้อมความน่าจะเป็น แล้วดูมูลค่าคาดหวังและช่วงมูลค่า — ค่าเริ่มต้นเป็นตัวอย่าง (growth ±2 จุด, margin ±15% จาก base)</p>
      ) : (
        <>
          <table className="table text-xs">
            <thead>
              <tr>
                <th>กรณี</th>
                <th className="num">โอกาส (%)</th>
                {SCEN_COLS.map((c) => (
                  <th key={c.key} className="num">{c.label} (%)</th>
                ))}
                <th className="num">มูลค่า/หุ้น</th>
                <th className="num">Upside</th>
              </tr>
            </thead>
            <tbody>
              {sc.map((x, i) => (
                <tr key={i}>
                  <td>
                    <input className="input w-20 py-1 text-xs" value={x.name} onChange={(e) => update(i, { name: e.target.value })} />
                  </td>
                  <td className="num">
                    <PctCell value={x.probability} onChange={(v) => update(i, { probability: v ?? 0 })} />
                  </td>
                  {SCEN_COLS.map((c) => (
                    <td key={c.key} className="num">
                      <PctCell
                        value={x.overrides[c.key]}
                        placeholder={fmtPct(a[c.key], 1)}
                        onChange={(v) => {
                          const o = { ...x.overrides };
                          if (v == null) delete o[c.key];
                          else o[c.key] = v;
                          update(i, { overrides: o });
                        }}
                      />
                    </td>
                  ))}
                  <td className="num font-medium">{fmtNum(res?.rows[i]?.value)}</td>
                  <td className={clsx("num", signClass(res?.rows[i]?.upside))}>{fmtPct(res?.rows[i]?.upside, 1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {res && (
            <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
              <span>
                มูลค่าคาดหวัง <b className="tabular-nums">{fmtNum(res.expectedValue)}</b> <span className={signClass(res.expectedUpside)}>({fmtPct(res.expectedUpside, 1)})</span>
              </span>
              <span className="text-muted">
                ช่วง {fmtNum(res.low)} – {fmtNum(res.high)} · σ {fmtNum(res.stdev)}
              </span>
              {res.errors.map((e) => (
                <span key={e} className="text-xs text-neg">⚠️ {e}</span>
              ))}
            </div>
          )}
          <p className="mt-2 text-xs text-muted">ช่องว่าง = ใช้ค่าเดียวกับ base · บันทึก valuation เพื่อเก็บ scenarios ไว้กับสมมติฐาน</p>
        </>
      )}
    </section>
  );
}

function PctCell({ value, onChange, placeholder }: { value: number | undefined; onChange: (v: number | null) => void; placeholder?: string }) {
  const [text, setText] = useState(value == null ? "" : String(Number((value * 100).toFixed(4))));
  return (
    <input
      className="input w-16 py-1 text-right text-xs tabular-nums"
      inputMode="decimal"
      value={text}
      placeholder={placeholder?.replace("%", "")}
      onChange={(e) => {
        setText(e.target.value);
        if (e.target.value.trim() === "") return onChange(null);
        const n = Number(e.target.value);
        if (Number.isFinite(n)) onChange(n / 100);
      }}
    />
  );
}
