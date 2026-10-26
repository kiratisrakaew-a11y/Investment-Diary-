"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { DEFAULT_DCF, dcf, dcfSensitivity, type DcfAssumptions } from "@/lib/finance/valuation";
import { evaluate, type ValuationInput } from "@/lib/valuation-schemas";
import { fetchFundamentalsAction, saveValuationAction } from "@/app/(app)/valuation/actions";
import { NumField, SelectField, Toggle } from "./fields";
import { fmtNum, fmtPct, signClass } from "@/lib/format";

type Method = "dcf_fcff" | "dcf_fcfe" | "ddm" | "residual_income" | "multiples";
type Ddm = Extract<ValuationInput, { method: "ddm" }>["assumptions"];
type Ri = Extract<ValuationInput, { method: "residual_income" }>["assumptions"];
type Mult = Extract<ValuationInput, { method: "multiples" }>["assumptions"];

export interface EditorDefaults {
  riskFree: number;
  equityRiskPremium: number;
  currentPrice: number;
  beta: number;
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
}: {
  id?: number;
  symbol: string;
  symbols: string[];
  method: Method;
  assumptions?: unknown;
  title?: string;
  note?: string;
  defaults: EditorDefaults;
}) {
  const router = useRouter();
  const [symbol, setSymbol] = useState(initialSymbol);
  const [method, setMethod] = useState<Method>(initialMethod);
  const [title, setTitle] = useState(initialTitle ?? "");
  const [note, setNote] = useState(initialNote ?? "");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  const discount = { riskFree: defaults.riskFree, beta: defaults.beta, equityRiskPremium: defaults.equityRiskPremium, extraPremium: 0 };
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
          return { method: m.value, label: m.label, result: evaluate(input(m.value)).value };
        } catch {
          return { method: m.value, label: m.label, result: null };
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dcfA, ddm, ri, mult],
  );

  const setD = (k: keyof DcfAssumptions) => (v: number | null) => setDcfA((a) => ({ ...a, [k]: v ?? 0 }));
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
      if (!id) router.push(`/valuation/${r.id}`);
      else router.refresh();
    });
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
          {msg && <span className={clsx("text-sm", msg.ok ? "text-pos" : "text-neg")}>{msg.text}</span>}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        <section className="card space-y-4 lg:col-span-3">
          <h2 className="font-semibold">สมมติฐาน</h2>
          <Group title="ราคาและอัตราคิดลด (CAPM)">
            <NumField label="ราคาปัจจุบัน" value={dcfA.currentPrice} onChange={(v) => setShared("currentPrice", v ?? 0)} />
            <NumField label="Risk-free" pct value={dcfA.riskFree} onChange={(v) => setShared("riskFree", v ?? 0)} />
            <NumField label="Beta" value={dcfA.beta} onChange={(v) => setShared("beta", v ?? 0)} />
            <NumField label="Equity risk premium" pct value={dcfA.equityRiskPremium} onChange={(v) => setShared("equityRiskPremium", v ?? 0)} />
            <NumField label="Premium เพิ่ม (size/country)" pct value={dcfA.extraPremium} onChange={(v) => setShared("extraPremium", v ?? 0)} />
          </Group>

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
                  <NumField label="สัดส่วนกู้เพื่อลงทุนสุทธิ (δ)" pct value={dcfA.debtFinancingRatio} onChange={setD("debtFinancingRatio")} />
                )}
              </Group>
              <Group title="Terminal value">
                <SelectField
                  label="วิธี"
                  value={dcfA.terminalMethod}
                  options={[
                    { value: "gordon", label: "Gordon growth" },
                    { value: "exit_multiple", label: method === "dcf_fcff" ? "Exit EV/EBITDA" : "Exit P/E" },
                  ]}
                  onChange={(v) => setDcfA((a) => ({ ...a, terminalMethod: v }))}
                />
                {dcfA.terminalMethod === "gordon" ? (
                  <NumField label="Terminal growth (g)" pct value={dcfA.terminalGrowth} onChange={setD("terminalGrowth")} />
                ) : (
                  <NumField label="Exit multiple" value={dcfA.exitMultiple} onChange={setD("exitMultiple")} />
                )}
                <div className="flex items-end pb-2">
                  <Toggle label="Mid-year convention" checked={dcfA.midYear} onChange={(v) => setDcfA((a) => ({ ...a, midYear: v }))} />
                </div>
              </Group>
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
                <Details method={method} details={result.details} />
              </>
            ) : (
              <p className="text-sm text-neg">คำนวณไม่ได้ — ตรวจสอบว่าอัตราคิดลด &gt; growth และข้อมูลครบ</p>
            )}
          </section>

          <section className="card">
            <h2 className="mb-3 font-semibold">เทียบทุกวิธี</h2>
            <FootballField rows={allResults} price={dcfA.currentPrice} active={method} />
            <p className="mt-2 text-xs text-muted">แต่ละวิธีใช้สมมติฐานในแท็บของตัวเอง — สลับวิธีด้านบนเพื่อแก้ไข</p>
          </section>
        </div>
      </div>

      {(method === "dcf_fcff" || method === "dcf_fcfe") && <DcfTables a={dcfA} model={method === "dcf_fcff" ? "fcff" : "fcfe"} />}
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
          <KV k="Implied exit multiple" v={fmtNum(n("impliedExitMultiple"), 1) + "x"} />
          <KV k="Growth ที่ราคาตลาดสะท้อน (reverse DCF)" v={fmtPct(n("impliedRevenueGrowthAtCurrentPrice"), 1)} />
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

function FootballField({ rows, price, active }: { rows: { method: Method; label: string; result: number | null }[]; price: number; active: Method }) {
  const vals = rows.map((r) => r.result).filter((v): v is number => v != null && Number.isFinite(v) && v > 0);
  const max = Math.max(price, ...vals) * 1.1 || 1;
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div key={r.method} className="text-xs">
          <div className="mb-0.5 flex justify-between">
            <span className={clsx(r.method === active && "font-semibold")}>{r.label}</span>
            <span className="tabular-nums">{r.result != null && Number.isFinite(r.result) ? fmtNum(r.result) : "–"}</span>
          </div>
          <div className="relative h-2.5 rounded-full bg-border/50">
            {r.result != null && r.result > 0 && (
              <div className="h-2.5 rounded-full" style={{ width: `${Math.min(100, (r.result / max) * 100)}%`, background: "var(--series-1)" }} />
            )}
            <div className="absolute -top-[3px] h-4 w-0.5 bg-text" style={{ left: `${(price / max) * 100}%` }} title={`ราคา ${price}`} />
          </div>
        </div>
      ))}
      <div className="text-right text-[11px] text-muted">เส้นตั้ง = ราคาปัจจุบัน {fmtNum(price)}</div>
    </div>
  );
}

function DcfTables({ a, model }: { a: DcfAssumptions; model: "fcff" | "fcfe" }) {
  const r = useMemo(() => dcf(a, model), [a, model]);
  const s = useMemo(() => dcfSensitivity(a, model), [a, model]);
  const fmt = (v: number) => fmtNum(v, 0);
  const rows: [string, (y: (typeof r.years)[number]) => string][] = [
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
          ["ดอกเบี้ยจ่าย", (y) => fmt(y.interest)],
          ["กำไรสุทธิ", (y) => fmt(y.netIncome)],
          ["+ กู้สุทธิ", (y) => fmt(y.netBorrowing)],
          ["FCFE", (y) => fmt(y.fcfe)],
        ] as [string, (y: (typeof r.years)[number]) => string][])
      : []),
    ["Discount factor", (y) => y.discountFactor.toFixed(4)],
    ["PV", (y) => fmt(y.pv)],
  ];
  const base = r.valuePerShare;
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
          PV รวม {fmt(r.sumPvCashFlows)} + PV terminal {fmt(r.pvTerminalValue)} (TV {fmt(r.terminalValue)})
        </p>
      </section>
      <section className="card overflow-x-auto lg:col-span-2">
        <h2 className="mb-3 font-semibold">Sensitivity: มูลค่าต่อหุ้น</h2>
        <table className="text-xs">
          <thead>
            <tr>
              <th className="px-2 py-1 text-left text-muted">{model === "fcff" ? "WACC" : "Ke"} ↓ / g →</th>
              {s.growths.map((g) => (
                <th key={g} className="px-2 py-1 text-right text-muted">{fmtPct(g, 1)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {s.grid.map((row, i) => (
              <tr key={i}>
                <th className="px-2 py-1 text-left font-medium text-muted">{fmtPct(s.rates[i], 1)}</th>
                {row.map((v, j) => {
                  const rel = Number.isFinite(v) && base ? v / base - 1 : 0;
                  const c = Math.min(1, Math.abs(rel) * 2);
                  return (
                    <td
                      key={j}
                      className={clsx("border-2 border-panel px-2 py-1.5 text-right tabular-nums", i === 2 && j === 2 && "font-semibold")}
                      style={{ background: `color-mix(in oklab, ${rel >= 0 ? "var(--series-3)" : "var(--series-2)"} ${c * 45}%, var(--panel))` }}
                    >
                      {Number.isFinite(v) ? fmtNum(v) : "–"}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-muted">ราคาปัจจุบัน {fmtNum(a.currentPrice)}</p>
      </section>
    </div>
  );
}
