/**
 * Step-by-step explanation of a valuation: every assumption, each formula with
 * the numbers substituted in, the forecast table and sanity warnings. Built only
 * from the functions in ./finance/valuation so it always matches the result shown.
 */
import {
  costOfEquity,
  dcf,
  gordonGrowth,
  hModel,
  justifiedPBV,
  justifiedPE,
  multiplesValuation,
  residualIncome,
  twoStageDdm,
  type DcfAssumptions,
} from "./finance/valuation";
import type { ValuationInput } from "./valuation-schemas";

export type Unit = "%" | "x" | "money" | "perShare" | "years" | "text" | "factor";

export interface Assumption {
  group: string;
  label: string;
  value: number | string | null;
  unit: Unit;
  note?: string;
}

export interface Step {
  label: string;
  formula: string;
  substitution: string;
  result: number | null;
  unit: Unit;
}

export interface ExplainTable {
  columns: string[];
  rows: { label: string; values: (number | null)[]; unit: Unit; strong?: boolean }[];
}

export interface Explanation {
  method: ValuationInput["method"];
  title: string;
  value: number | null;
  price: number | null;
  upside: number | null;
  assumptions: Assumption[];
  steps: Step[];
  table?: ExplainTable;
  warnings: string[];
}

export const METHOD_TITLE: Record<ValuationInput["method"], string> = {
  dcf_fcff: "DCF – Free Cash Flow to Firm (คิดลดด้วย WACC)",
  dcf_fcfe: "DCF – Free Cash Flow to Equity (คิดลดด้วย Ke)",
  ddm: "Dividend Discount Model",
  residual_income: "Residual Income / Justified P/BV",
  multiples: "Relative multiples",
  bond: "Bond pricing",
};

// ------------------------------------------------------------------ formatting

const fin = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);
export const fmtP = (v: number | null | undefined, d = 2) => (fin(v) ? `${(v * 100).toFixed(d)}%` : "–");
export const fmtM = (v: number | null | undefined, d = 0) =>
  fin(v) ? v.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d }) : "–";
export const fmtX = (v: number | null | undefined, d = 2) => (fin(v) ? `${v.toFixed(d)}x` : "–");

export function formatValue(v: number | string | null, unit: Unit): string {
  if (typeof v === "string") return v;
  switch (unit) {
    case "%":
      return fmtP(v);
    case "x":
      return fmtX(v);
    case "perShare":
      return fmtM(v, 2);
    case "factor":
      return fin(v) ? v.toFixed(4) : "–";
    case "years":
      return fin(v) ? `${v} ปี` : "–";
    default:
      return fmtM(v, Math.abs(v ?? 0) < 100 ? 2 : 0);
  }
}

// ------------------------------------------------------------------ shared pieces

function keSteps(a: { riskFree: number; beta: number; equityRiskPremium: number; extraPremium?: number }) {
  const ke = costOfEquity(a.riskFree, a.beta, a.equityRiskPremium, a.extraPremium ?? 0);
  const step: Step = {
    label: "ต้นทุนส่วนของผู้ถือหุ้น (CAPM)",
    formula: "Ke = Rf + β × ERP + premium",
    substitution: `${fmtP(a.riskFree)} + ${a.beta.toFixed(2)} × ${fmtP(a.equityRiskPremium)} + ${fmtP(a.extraPremium ?? 0)}`,
    result: ke,
    unit: "%",
  };
  const assumptions: Assumption[] = [
    { group: "อัตราคิดลด", label: "Risk-free rate (Rf)", value: a.riskFree, unit: "%" },
    { group: "อัตราคิดลด", label: "Beta (β)", value: a.beta, unit: "factor" },
    { group: "อัตราคิดลด", label: "Equity risk premium (ERP)", value: a.equityRiskPremium, unit: "%" },
    { group: "อัตราคิดลด", label: "Premium เพิ่ม (size/country)", value: a.extraPremium ?? 0, unit: "%" },
  ];
  return { ke, step, assumptions };
}

/** Sanity checks common to every method. */
function sanity(value: number | null, price: number | null, warnings: string[]) {
  if (fin(value) && fin(price) && price > 0) {
    if (value > price * 3) warnings.push(`มูลค่าสูงกว่าราคาตลาด ${(value / price).toFixed(1)} เท่า — ตรวจสมมติฐาน (growth, ROE, อัตราคิดลด) ว่าสมเหตุสมผลหรือไม่`);
    if (value < price / 3 && value > 0) warnings.push(`มูลค่าต่ำกว่าราคาตลาดมากกว่า 3 เท่า — ตรวจสมมติฐานหรือหน่วยของตัวเลข`);
  }
  if (fin(value) && value <= 0) warnings.push("มูลค่าติดลบหรือเป็นศูนย์ — วิธีนี้อาจไม่เหมาะกับบริษัทนี้ หรือสมมติฐานผิด");
}

function spreadWarning(rate: number, g: number, name: string, warnings: string[]) {
  if (rate <= g) warnings.push(`${name} ต้องมากกว่า growth ระยะยาว (r > g) ไม่เช่นนั้นสูตร perpetuity ใช้ไม่ได้`);
  else if (rate - g < 0.02) warnings.push(`${name} − g = ${fmtP(rate - g)} น้อยกว่า 2% — มูลค่าอ่อนไหวมาก เปลี่ยน g เพียงเล็กน้อยมูลค่าจะเปลี่ยนมาก`);
}

const upsideOf = (v: number | null, p: number) => (fin(v) && p > 0 ? v / p - 1 : null);

// ------------------------------------------------------------------ DCF

function explainDcf(a: DcfAssumptions, model: "fcff" | "fcfe"): Explanation {
  const r = dcf(a, model);
  const { step: keStep, assumptions: keAssumptions } = keSteps(a);
  const steps: Step[] = [keStep];
  const warnings = [...r.warnings];
  const last = r.years[r.years.length - 1];
  const rate = r.discountRate;

  const assumptions: Assumption[] = [
    { group: "ราคา", label: "ราคาปัจจุบัน", value: a.currentPrice, unit: "perShare" },
    ...keAssumptions,
    { group: "ประมาณการ", label: "รายได้ปีล่าสุด", value: a.revenue0, unit: "money" },
    { group: "ประมาณการ", label: "จำนวนปีประมาณการ", value: a.years, unit: "years" },
    { group: "ประมาณการ", label: "Revenue growth ปีแรก → ปีสุดท้าย", value: `${fmtP(a.growthStart)} → ${fmtP(a.growthEnd)}`, unit: "text", note: "เปลี่ยนแบบเส้นตรง" },
    { group: "ประมาณการ", label: "EBIT margin ปีแรก → ปีสุดท้าย", value: `${fmtP(a.ebitMarginStart)} → ${fmtP(a.ebitMarginEnd)}`, unit: "text" },
    { group: "ประมาณการ", label: "อัตราภาษี", value: a.taxRate, unit: "%" },
    { group: "ประมาณการ", label: "D&A / รายได้", value: a.daPct, unit: "%" },
    { group: "ประมาณการ", label: "Capex / รายได้", value: a.capexPct, unit: "%" },
    { group: "ประมาณการ", label: "NWC / รายได้", value: a.nwcPct, unit: "%", note: "ΔNWC = %NWC × รายได้ที่เพิ่มขึ้น" },
    { group: "โครงสร้างทุน", label: "หนี้สินที่มีดอกเบี้ย", value: a.debt, unit: "money" },
    { group: "โครงสร้างทุน", label: "เงินสด", value: a.cash, unit: "money" },
    { group: "โครงสร้างทุน", label: "Minority / อื่น ๆ", value: a.otherClaims, unit: "money" },
    { group: "โครงสร้างทุน", label: "จำนวนหุ้น", value: a.sharesOutstanding, unit: "money" },
    { group: "โครงสร้างทุน", label: "ต้นทุนหนี้ก่อนภาษี (Kd)", value: a.costOfDebt, unit: "%" },
    {
      group: "โครงสร้างทุน",
      label: "สัดส่วนหนี้ D/(D+E)",
      value: a.targetDebtWeight ?? "ใช้ market value",
      unit: a.targetDebtWeight != null ? "%" : "text",
    },
    ...(model === "fcfe" ? [{ group: "โครงสร้างทุน", label: "สัดส่วนกู้เพื่อลงทุนสุทธิ (δ)", value: a.debtFinancingRatio, unit: "%" as Unit }] : []),
    {
      group: "Terminal value",
      label: a.terminalMethod === "gordon" ? "Terminal growth (g)" : model === "fcff" ? "Exit EV/EBITDA" : "Exit P/E",
      value: a.terminalMethod === "gordon" ? a.terminalGrowth : a.exitMultiple,
      unit: a.terminalMethod === "gordon" ? "%" : "x",
    },
    { group: "Terminal value", label: "Mid-year convention", value: a.midYear ? "ใช้" : "ไม่ใช้", unit: "text" },
  ];

  if (model === "fcff") {
    const equityMv = a.currentPrice * a.sharesOutstanding;
    const wD = a.targetDebtWeight ?? (equityMv + a.debt > 0 ? a.debt / (equityMv + a.debt) : 0);
    steps.push({
      label: "สัดส่วนเงินทุน",
      formula: a.targetDebtWeight != null ? "D/V = สัดส่วนหนี้เป้าหมาย" : "D/V = หนี้ ÷ (ราคา × หุ้น + หนี้)",
      substitution: a.targetDebtWeight != null ? fmtP(wD) : `${fmtM(a.debt)} ÷ (${fmtM(a.currentPrice, 2)} × ${fmtM(a.sharesOutstanding)} + ${fmtM(a.debt)})`,
      result: wD,
      unit: "%",
    });
    steps.push({
      label: "ต้นทุนเงินทุนถัวเฉลี่ย (WACC)",
      formula: "WACC = E/V × Ke + D/V × Kd × (1 − t)",
      substitution: `${fmtP(1 - wD)} × ${fmtP(r.costOfEquity)} + ${fmtP(wD)} × ${fmtP(a.costOfDebt)} × (1 − ${fmtP(a.taxRate)})`,
      result: r.wacc,
      unit: "%",
    });
    steps.push({
      label: "กระแสเงินสดอิสระต่อกิจการ (ปีที่ 1)",
      formula: "FCFF = EBIT × (1 − t) + D&A − Capex − ΔNWC",
      substitution: `${fmtM(r.years[0].ebit)} × (1 − ${fmtP(a.taxRate)}) + ${fmtM(r.years[0].da)} − ${fmtM(r.years[0].capex)} − ${fmtM(r.years[0].deltaNwc)}`,
      result: r.years[0].fcff,
      unit: "money",
    });
  } else {
    steps.push({
      label: "กระแสเงินสดอิสระต่อผู้ถือหุ้น (ปีที่ 1)",
      formula: "FCFE = กำไรสุทธิ − (Capex − D&A) − ΔNWC + กู้สุทธิ",
      substitution: `${fmtM(r.years[0].netIncome)} − (${fmtM(r.years[0].capex)} − ${fmtM(r.years[0].da)}) − ${fmtM(r.years[0].deltaNwc)} + ${fmtM(r.years[0].netBorrowing)}`,
      result: r.years[0].fcfe,
      unit: "money",
    });
  }

  const name = model === "fcff" ? "WACC" : "Ke";
  steps.push({
    label: `มูลค่าปัจจุบันของกระแสเงินสด ${a.years} ปี`,
    formula: `Σ CFₜ ÷ (1 + ${name})^t${a.midYear ? " (t − 0.5 แบบ mid-year)" : ""}`,
    substitution: r.years.map((y) => fmtM(y.pv)).join(" + "),
    result: r.sumPvCashFlows,
    unit: "money",
  });
  const cfLast = model === "fcff" ? last.fcff : last.fcfe;
  if (a.terminalMethod === "gordon") {
    steps.push({
      label: "Terminal value (ณ สิ้นปีที่ " + a.years + ")",
      formula: `TV = CFₙ × (1 + g) ÷ (${name} − g)`,
      substitution: `${fmtM(cfLast)} × (1 + ${fmtP(a.terminalGrowth)}) ÷ (${fmtP(rate)} − ${fmtP(a.terminalGrowth)})`,
      result: r.terminalValue,
      unit: "money",
    });
    spreadWarning(rate, a.terminalGrowth, name, warnings);
  } else {
    const base = model === "fcff" ? last.ebit + last.da : last.netIncome;
    steps.push({
      label: "Terminal value (ณ สิ้นปีที่ " + a.years + ")",
      formula: model === "fcff" ? "TV = EBITDAₙ × EV/EBITDA" : "TV = กำไรสุทธิₙ × P/E",
      substitution: `${fmtM(base)} × ${fmtX(a.exitMultiple, 1)}`,
      result: r.terminalValue,
      unit: "money",
    });
  }
  steps.push({
    label: "มูลค่าปัจจุบันของ Terminal value",
    formula: `PV(TV) = TV ÷ (1 + ${name})^${a.years}`,
    substitution: `${fmtM(r.terminalValue)} ÷ (1 + ${fmtP(rate)})^${a.years}`,
    result: r.pvTerminalValue,
    unit: "money",
  });
  if (model === "fcff") {
    steps.push({
      label: "มูลค่ากิจการ (Enterprise value)",
      formula: "EV = ΣPV + PV(TV)",
      substitution: `${fmtM(r.sumPvCashFlows)} + ${fmtM(r.pvTerminalValue)}`,
      result: r.enterpriseValue,
      unit: "money",
    });
    steps.push({
      label: "มูลค่าส่วนของผู้ถือหุ้น",
      formula: "Equity = EV − หนี้ + เงินสด − minority",
      substitution: `${fmtM(r.enterpriseValue)} − ${fmtM(a.debt)} + ${fmtM(a.cash)} − ${fmtM(a.otherClaims)}`,
      result: r.equityValue,
      unit: "money",
    });
  } else {
    steps.push({
      label: "มูลค่าส่วนของผู้ถือหุ้น",
      formula: "Equity = ΣPV + PV(TV) + เงินสด",
      substitution: `${fmtM(r.sumPvCashFlows)} + ${fmtM(r.pvTerminalValue)} + ${fmtM(a.cash)}`,
      result: r.equityValue,
      unit: "money",
    });
  }
  steps.push({
    label: "มูลค่าที่เหมาะสมต่อหุ้น",
    formula: "Value = Equity ÷ จำนวนหุ้น",
    substitution: `${fmtM(r.equityValue)} ÷ ${fmtM(a.sharesOutstanding)}`,
    result: r.valuePerShare,
    unit: "perShare",
  });
  steps.push({
    label: "Upside / Downside",
    formula: "Value ÷ ราคา − 1",
    substitution: `${fmtM(r.valuePerShare, 2)} ÷ ${fmtM(a.currentPrice, 2)} − 1`,
    result: r.upside,
    unit: "%",
  });
  steps.push({
    label: "สัดส่วน Terminal value ต่อมูลค่ารวม",
    formula: "PV(TV) ÷ (ΣPV + PV(TV))",
    substitution: `${fmtM(r.pvTerminalValue)} ÷ ${fmtM(r.sumPvCashFlows + r.pvTerminalValue)}`,
    result: r.terminalShareOfValue,
    unit: "%",
  });

  const cols = r.years.map((y) => `ปี ${y.year}`);
  const row = (label: string, f: (y: (typeof r.years)[number]) => number, unit: Unit, strong = false) => ({
    label,
    values: r.years.map(f),
    unit,
    strong,
  });
  const table: ExplainTable = {
    columns: cols,
    rows: [
      row("Revenue growth", (y) => y.growth, "%"),
      row("รายได้", (y) => y.revenue, "money"),
      row("EBIT margin", (y) => y.ebitMargin, "%"),
      row("EBIT", (y) => y.ebit, "money"),
      ...(model === "fcff"
        ? [row("ภาษีจาก EBIT", (y) => y.ebit - y.nopat, "money"), row("NOPAT", (y) => y.nopat, "money")]
        : [row("ดอกเบี้ยจ่าย", (y) => y.interest, "money"), row("กำไรสุทธิ", (y) => y.netIncome, "money")]),
      row("+ D&A", (y) => y.da, "money"),
      row("− Capex", (y) => y.capex, "money"),
      row("− ΔNWC", (y) => y.deltaNwc, "money"),
      ...(model === "fcfe" ? [row("+ กู้สุทธิ", (y) => y.netBorrowing, "money")] : []),
      row(model === "fcff" ? "FCFF" : "FCFE", (y) => (model === "fcff" ? y.fcff : y.fcfe), "money", true),
      row("Discount factor", (y) => y.discountFactor, "factor"),
      row("Present value", (y) => y.pv, "money", true),
    ],
  };

  const value = Number.isFinite(r.valuePerShare) ? r.valuePerShare : null;
  sanity(value, a.currentPrice, warnings);
  return {
    method: model === "fcff" ? "dcf_fcff" : "dcf_fcfe",
    title: METHOD_TITLE[model === "fcff" ? "dcf_fcff" : "dcf_fcfe"],
    value,
    price: a.currentPrice,
    upside: r.upside,
    assumptions,
    steps,
    table,
    warnings: [...new Set(warnings)],
  };
}

// ------------------------------------------------------------------ DDM / RI / multiples

type Ddm = Extract<ValuationInput, { method: "ddm" }>["assumptions"];
type Ri = Extract<ValuationInput, { method: "residual_income" }>["assumptions"];
type Mult = Extract<ValuationInput, { method: "multiples" }>["assumptions"];

function explainDdm(a: Ddm): Explanation {
  const { ke, step, assumptions: keA } = keSteps(a);
  const steps: Step[] = [step];
  const warnings: string[] = [];
  const assumptions: Assumption[] = [
    { group: "ราคา", label: "ราคาปัจจุบัน", value: a.currentPrice, unit: "perShare" },
    ...keA,
    { group: "เงินปันผล", label: "ปันผลต่อหุ้นล่าสุด (D₀)", value: a.d0, unit: "perShare" },
    { group: "เงินปันผล", label: "โมเดล", value: a.model === "gordon" ? "Gordon growth" : a.model === "two_stage" ? "Two-stage" : "H-model", unit: "text" },
    ...(a.model !== "gordon"
      ? [
          { group: "เงินปันผล", label: "Growth ช่วงแรก", value: a.highGrowth, unit: "%" as Unit },
          { group: "เงินปันผล", label: a.model === "h_model" ? "ระยะเวลาที่ growth ลดลง (2H)" : "จำนวนปีช่วงแรก", value: a.highGrowthYears, unit: "years" as Unit },
        ]
      : []),
    { group: "เงินปันผล", label: "Growth ระยะยาว (g)", value: a.terminalGrowth, unit: "%" },
  ];
  let value: number;
  let table: ExplainTable | undefined;
  if (a.model === "gordon") {
    value = gordonGrowth(a.d0, ke, a.terminalGrowth);
    steps.push({ label: "ปันผลปีหน้า", formula: "D₁ = D₀ × (1 + g)", substitution: `${fmtM(a.d0, 2)} × (1 + ${fmtP(a.terminalGrowth)})`, result: a.d0 * (1 + a.terminalGrowth), unit: "perShare" });
    steps.push({ label: "มูลค่าที่เหมาะสม (Gordon)", formula: "P₀ = D₁ ÷ (Ke − g)", substitution: `${fmtM(a.d0 * (1 + a.terminalGrowth), 2)} ÷ (${fmtP(ke)} − ${fmtP(a.terminalGrowth)})`, result: value, unit: "perShare" });
  } else if (a.model === "h_model") {
    const H = a.highGrowthYears / 2;
    value = hModel(a.d0, ke, a.highGrowth, a.terminalGrowth, H);
    steps.push({
      label: "มูลค่าที่เหมาะสม (H-model)",
      formula: "P₀ = [D₀(1 + gL) + D₀ × H × (gS − gL)] ÷ (Ke − gL)",
      substitution: `[${fmtM(a.d0, 2)} × (1 + ${fmtP(a.terminalGrowth)}) + ${fmtM(a.d0, 2)} × ${H} × (${fmtP(a.highGrowth)} − ${fmtP(a.terminalGrowth)})] ÷ (${fmtP(ke)} − ${fmtP(a.terminalGrowth)})`,
      result: value,
      unit: "perShare",
    });
  } else {
    const t = twoStageDdm(a.d0, ke, a.highGrowth, a.highGrowthYears, a.terminalGrowth);
    value = t.value;
    const lastD = t.dividends[t.dividends.length - 1]?.dividend ?? a.d0;
    steps.push({ label: `PV ปันผลช่วง ${a.highGrowthYears} ปีแรก`, formula: "Σ D₀(1 + g₁)ᵗ ÷ (1 + Ke)ᵗ", substitution: t.dividends.map((d) => fmtM(d.pv, 2)).join(" + "), result: t.pvDividends, unit: "perShare" });
    steps.push({ label: "มูลค่าปลายงวด", formula: "Pₙ = Dₙ × (1 + g₂) ÷ (Ke − g₂)", substitution: `${fmtM(lastD, 2)} × (1 + ${fmtP(a.terminalGrowth)}) ÷ (${fmtP(ke)} − ${fmtP(a.terminalGrowth)})`, result: t.terminal, unit: "perShare" });
    steps.push({ label: "PV ของมูลค่าปลายงวด", formula: "Pₙ ÷ (1 + Ke)ⁿ", substitution: `${fmtM(t.terminal, 2)} ÷ (1 + ${fmtP(ke)})^${a.highGrowthYears}`, result: t.pvTerminal, unit: "perShare" });
    steps.push({ label: "มูลค่าที่เหมาะสม", formula: "P₀ = PV ปันผล + PV มูลค่าปลายงวด", substitution: `${fmtM(t.pvDividends, 2)} + ${fmtM(t.pvTerminal, 2)}`, result: value, unit: "perShare" });
    table = {
      columns: t.dividends.map((d) => `ปี ${d.year}`),
      rows: [
        { label: "เงินปันผลต่อหุ้น", values: t.dividends.map((d) => d.dividend), unit: "perShare" },
        { label: "Discount factor", values: t.dividends.map((d) => 1 / (1 + ke) ** d.year), unit: "factor" },
        { label: "Present value", values: t.dividends.map((d) => d.pv), unit: "perShare", strong: true },
      ],
    };
  }
  steps.push({ label: "Dividend yield ปัจจุบัน", formula: "D₀ ÷ ราคา", substitution: `${fmtM(a.d0, 2)} ÷ ${fmtM(a.currentPrice, 2)}`, result: a.currentPrice > 0 ? a.d0 / a.currentPrice : null, unit: "%" });
  spreadWarning(ke, a.terminalGrowth, "Ke", warnings);
  const v = Number.isFinite(value) ? value : null;
  steps.push({ label: "Upside / Downside", formula: "Value ÷ ราคา − 1", substitution: `${fmtM(v, 2)} ÷ ${fmtM(a.currentPrice, 2)} − 1`, result: upsideOf(v, a.currentPrice), unit: "%" });
  sanity(v, a.currentPrice, warnings);
  return { method: "ddm", title: METHOD_TITLE.ddm, value: v, price: a.currentPrice, upside: upsideOf(v, a.currentPrice), assumptions, steps, table, warnings };
}

function explainRi(a: Ri): Explanation {
  const { ke, step, assumptions: keA } = keSteps(a);
  const warnings: string[] = [];
  const value = residualIncome(a.bookValuePerShare, a.roe, ke, a.terminalGrowth);
  const v = Number.isFinite(value) ? value : null;
  const sg = a.roe * (1 - a.payoutRatio);
  const steps: Step[] = [
    step,
    { label: "กำไรส่วนเกิน (Residual income) ปีหน้า", formula: "RI = (ROE − Ke) × B₀", substitution: `(${fmtP(a.roe)} − ${fmtP(ke)}) × ${fmtM(a.bookValuePerShare, 2)}`, result: (a.roe - ke) * a.bookValuePerShare, unit: "perShare" },
    {
      label: "มูลค่าที่เหมาะสม",
      formula: "V₀ = B₀ + (ROE − Ke) × B₀ ÷ (Ke − g)",
      substitution: `${fmtM(a.bookValuePerShare, 2)} + (${fmtP(a.roe)} − ${fmtP(ke)}) × ${fmtM(a.bookValuePerShare, 2)} ÷ (${fmtP(ke)} − ${fmtP(a.terminalGrowth)})`,
      result: v,
      unit: "perShare",
    },
    { label: "Justified P/BV", formula: "(ROE − g) ÷ (Ke − g)", substitution: `(${fmtP(a.roe)} − ${fmtP(a.terminalGrowth)}) ÷ (${fmtP(ke)} − ${fmtP(a.terminalGrowth)})`, result: justifiedPBV(a.roe, ke, a.terminalGrowth), unit: "x" },
    { label: "Justified P/E", formula: "payout × (1 + g) ÷ (Ke − g)", substitution: `${fmtP(a.payoutRatio)} × (1 + ${fmtP(a.terminalGrowth)}) ÷ (${fmtP(ke)} − ${fmtP(a.terminalGrowth)})`, result: justifiedPE(a.payoutRatio, ke, a.terminalGrowth), unit: "x" },
    { label: "P/BV ตลาดปัจจุบัน", formula: "ราคา ÷ B₀", substitution: `${fmtM(a.currentPrice, 2)} ÷ ${fmtM(a.bookValuePerShare, 2)}`, result: a.bookValuePerShare ? a.currentPrice / a.bookValuePerShare : null, unit: "x" },
    { label: "Growth ที่ยั่งยืน (ตรวจสอบ)", formula: "g = ROE × (1 − payout)", substitution: `${fmtP(a.roe)} × (1 − ${fmtP(a.payoutRatio)})`, result: sg, unit: "%" },
    { label: "Upside / Downside", formula: "Value ÷ ราคา − 1", substitution: `${fmtM(v, 2)} ÷ ${fmtM(a.currentPrice, 2)} − 1`, result: upsideOf(v, a.currentPrice), unit: "%" },
  ];
  spreadWarning(ke, a.terminalGrowth, "Ke", warnings);
  if (a.roe > ke + 0.08) warnings.push(`ROE (${fmtP(a.roe)}) สูงกว่า Ke (${fmtP(ke)}) มาก — สูตรสมมติว่าทำ ROE ระดับนี้ได้ตลอดไป ซึ่งมักไม่สมจริง`);
  if (a.terminalGrowth > sg + 0.02) warnings.push(`g ที่ใช้ (${fmtP(a.terminalGrowth)}) สูงกว่า growth ที่ยั่งยืนจาก ROE × retention (${fmtP(sg)})`);
  sanity(v, a.currentPrice, warnings);
  return {
    method: "residual_income",
    title: METHOD_TITLE.residual_income,
    value: v,
    price: a.currentPrice,
    upside: upsideOf(v, a.currentPrice),
    assumptions: [
      { group: "ราคา", label: "ราคาปัจจุบัน", value: a.currentPrice, unit: "perShare" },
      ...keA,
      { group: "ส่วนของผู้ถือหุ้น", label: "Book value ต่อหุ้น (B₀)", value: a.bookValuePerShare, unit: "perShare" },
      { group: "ส่วนของผู้ถือหุ้น", label: "ROE ที่ยั่งยืน", value: a.roe, unit: "%" },
      { group: "ส่วนของผู้ถือหุ้น", label: "Payout ratio", value: a.payoutRatio, unit: "%" },
      { group: "ส่วนของผู้ถือหุ้น", label: "Growth ระยะยาว (g)", value: a.terminalGrowth, unit: "%" },
    ],
    steps,
    warnings,
  };
}

function explainMultiples(a: Mult): Explanation {
  const m = multiplesValuation(a);
  const vals = [m.pe, m.pbv, m.evEbitda].filter((v) => Number.isFinite(v) && v > 0);
  const avg = vals.length ? vals.reduce((x, y) => x + y, 0) / vals.length : NaN;
  const v = Number.isFinite(avg) ? avg : null;
  const warnings: string[] = [];
  const steps: Step[] = [
    { label: "ตาม P/E", formula: "EPS × P/E เป้าหมาย", substitution: `${fmtM(a.eps, 2)} × ${fmtX(a.targetPE, 1)}`, result: m.pe, unit: "perShare" },
    { label: "ตาม P/BV", formula: "BVPS × P/BV เป้าหมาย", substitution: `${fmtM(a.bookValuePerShare, 2)} × ${fmtX(a.targetPBV, 2)}`, result: m.pbv, unit: "perShare" },
    {
      label: "ตาม EV/EBITDA",
      formula: "(EBITDA × EV/EBITDA − หนี้สุทธิ) ÷ จำนวนหุ้น",
      substitution: `(${fmtM(a.ebitda)} × ${fmtX(a.targetEvEbitda, 1)} − ${fmtM(a.netDebt)}) ÷ ${fmtM(a.sharesOutstanding)}`,
      result: Number.isFinite(m.evEbitda) ? m.evEbitda : null,
      unit: "perShare",
    },
    { label: "มูลค่าเฉลี่ย (เฉพาะวิธีที่ได้ค่าบวก)", formula: "ค่าเฉลี่ยของ 3 วิธี", substitution: vals.map((x) => fmtM(x, 2)).join(" + ") + ` ÷ ${vals.length}`, result: v, unit: "perShare" },
    { label: "P/E ปัจจุบัน", formula: "ราคา ÷ EPS", substitution: `${fmtM(a.currentPrice, 2)} ÷ ${fmtM(a.eps, 2)}`, result: a.eps > 0 ? a.currentPrice / a.eps : null, unit: "x" },
    { label: "P/BV ปัจจุบัน", formula: "ราคา ÷ BVPS", substitution: `${fmtM(a.currentPrice, 2)} ÷ ${fmtM(a.bookValuePerShare, 2)}`, result: a.bookValuePerShare ? a.currentPrice / a.bookValuePerShare : null, unit: "x" },
    {
      label: "EV/EBITDA ปัจจุบัน",
      formula: "(ราคา × หุ้น + หนี้สุทธิ) ÷ EBITDA",
      substitution: `(${fmtM(a.currentPrice, 2)} × ${fmtM(a.sharesOutstanding)} + ${fmtM(a.netDebt)}) ÷ ${fmtM(a.ebitda)}`,
      result: a.ebitda > 0 ? (a.currentPrice * a.sharesOutstanding + a.netDebt) / a.ebitda : null,
      unit: "x",
    },
    { label: "Upside / Downside", formula: "Value ÷ ราคา − 1", substitution: `${fmtM(v, 2)} ÷ ${fmtM(a.currentPrice, 2)} − 1`, result: upsideOf(v, a.currentPrice), unit: "%" },
  ];
  if (vals.length && Math.max(...vals) > 2 * Math.min(...vals)) warnings.push("ผลจากแต่ละ multiple ต่างกันมากกว่า 2 เท่า — ตรวจว่าใช้ peer หรือหน่วยตัวเลขเดียวกัน");
  sanity(v, a.currentPrice, warnings);
  return {
    method: "multiples",
    title: METHOD_TITLE.multiples,
    value: v,
    price: a.currentPrice,
    upside: upsideOf(v, a.currentPrice),
    assumptions: [
      { group: "ราคา", label: "ราคาปัจจุบัน", value: a.currentPrice, unit: "perShare" },
      { group: "ข้อมูลบริษัท", label: "EPS", value: a.eps, unit: "perShare" },
      { group: "ข้อมูลบริษัท", label: "Book value ต่อหุ้น", value: a.bookValuePerShare, unit: "perShare" },
      { group: "ข้อมูลบริษัท", label: "EBITDA", value: a.ebitda, unit: "money" },
      { group: "ข้อมูลบริษัท", label: "หนี้สุทธิ", value: a.netDebt, unit: "money" },
      { group: "ข้อมูลบริษัท", label: "จำนวนหุ้น", value: a.sharesOutstanding, unit: "money" },
      { group: "Multiple อ้างอิง", label: "P/E", value: a.targetPE, unit: "x" },
      { group: "Multiple อ้างอิง", label: "P/BV", value: a.targetPBV, unit: "x" },
      { group: "Multiple อ้างอิง", label: "EV/EBITDA", value: a.targetEvEbitda, unit: "x" },
    ],
    steps,
    warnings,
  };
}

/** Build the explanation for any stock valuation method (bonds are explained on the bond page). */
export function explainValuation(input: ValuationInput): Explanation | null {
  switch (input.method) {
    case "dcf_fcff":
      return explainDcf(input.assumptions as DcfAssumptions, "fcff");
    case "dcf_fcfe":
      return explainDcf(input.assumptions as DcfAssumptions, "fcfe");
    case "ddm":
      return explainDdm(input.assumptions);
    case "residual_income":
      return explainRi(input.assumptions);
    case "multiples":
      return explainMultiples(input.assumptions);
    default:
      return null;
  }
}

/** Plain-text version (for copying into notes or chat). */
export function explanationToText(e: Explanation): string {
  const lines = [`${e.title}`, `มูลค่าที่เหมาะสม: ${fmtM(e.value, 2)} | ราคา: ${fmtM(e.price, 2)} | Upside: ${fmtP(e.upside, 1)}`, "", "สมมติฐาน:"];
  for (const a of e.assumptions) lines.push(`- ${a.label}: ${formatValue(a.value, a.unit)}${a.note ? ` (${a.note})` : ""}`);
  lines.push("", "ขั้นตอนการคำนวณ:");
  e.steps.forEach((s, i) => lines.push(`${i + 1}. ${s.label}: ${s.formula} = ${s.substitution} = ${formatValue(s.result, s.unit)}`));
  if (e.warnings.length) lines.push("", "ข้อควรระวัง:", ...e.warnings.map((w) => `- ${w}`));
  return lines.join("\n");
}
