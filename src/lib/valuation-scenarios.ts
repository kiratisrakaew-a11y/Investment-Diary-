/**
 * Cross-method scenario engine (PR11–PR12). A thin orchestration layer: every scenario is the
 * unmodified valuation input with allow-listed overrides applied, re-validated by the same zod
 * schema, then valued by the same `evaluateLean` the editor uses — no model maths is copied here.
 *
 * Rules:
 * - `baseCaseValue` is the value of the inputs as entered (the legacy intrinsic value). The
 *   probability-weighted value is a separate number and never replaces it.
 * - Probabilities: finite, in [0, 1], unique ids, Σ = 1 within 1e-8. No silent normalisation.
 * - The weighted value needs every positive-probability scenario to be valid; zero-probability
 *   scenarios are shown but never enter the arithmetic.
 * - Probabilities weigh mutually exclusive scenarios of ONE method, never different methods.
 * - SOTP: each scenario reruns every segment model and the full EV-to-equity bridge.
 */
import { valuationInput, evaluateLean, riForecastRows, type ValuationInput } from "./valuation-schemas";
import { applyScenario, dcfAtRate, type DcfAssumptions, type DcfScenario } from "./finance/valuation";
import type { ScenarioSet, ValuationScenario } from "./valuation-scenario-schema";
import { MODEL_VERSION } from "./governance";

export const PROBABILITY_TOLERANCE = 1e-8;
export type Method = ValuationInput["method"];

// ------------------------------------------------------------------ allow-lists

const DCF_FIELDS = [
  "revenue0", "growthStart", "growthEnd", "ebitMarginStart", "ebitMarginEnd", "terminalGrowth", "taxRate", "daPct", "capexPct", "nwcPct",
  "debt", "cash", "otherClaims", "riskFree", "beta", "equityRiskPremium", "extraPremium", "costOfDebt", "targetDebtWeight",
  "debtFinancingRatio", "terminalRoic", "terminalRoe", "exitMultiple",
] as const;
const STAGE_FIELDS = ["revenueGrowthStart", "revenueGrowthEnd", "ebitMarginStart", "ebitMarginEnd", "daPct", "capexPct", "nwcPct", "taxRate", "debtFinancingRatio"] as const;
const FADE_FIELDS = ["growthStart", "growthEnd", "ebitMarginStart", "ebitMarginEnd"];
const DDM_FIELDS = ["d0", "highGrowth", "highGrowthYears", "terminalGrowth", "riskFree", "beta", "equityRiskPremium", "extraPremium"] as const;
const RIM_FIELDS = ["bookValuePerShare", "roe", "payoutRatio", "terminalGrowth", "terminalRoe", "persistence", "riskFree", "beta", "equityRiskPremium", "extraPremium"] as const;
const MULT_FIELDS = ["eps", "bookValuePerShare", "ebitda", "netDebt", "targetPE", "targetPBV", "targetEvEbitda"] as const;
const BOND_FIELDS = ["ytm"] as const;
const SOTP_FIELDS = ["netDebt", "minorityInterest", "holdingDiscount"] as const;
const SEGMENT_FIELDS = ["ownership", "fx", "netDebt"] as const;
const SOURCE_FIELDS: Record<string, string[]> = { market: ["price"], multiple: ["metric", "multiple"], manual: ["value"] };
const LINE_LISTS = ["nonOperatingAssets", "otherClaims", "eliminations"] as const;

/** Virtual drivers (not stored fields): applied on top of the stored inputs. */
const VIRTUAL: Record<string, string> = {
  growthShift: "บวกเพิ่มทุกอัตราการเติบโตของรายได้ (ทุกปี / ทุกช่วง)",
  marginShift: "บวกเพิ่มทุก EBIT margin",
  discountRate: "อัตราคิดลดที่ใช้ (WACC สำหรับ FCFF, Ke สำหรับ FCFE) — ใช้ในตาราง sensitivity / reverse / Monte Carlo",
  roeShift: "บวกเพิ่ม ROE ทุกปีที่ระบุเป็น ROE (ปีที่ระบุ EPS ไม่เปลี่ยน)",
  yieldShiftBp: "เลื่อน YTM ของพันธบัตร (basis point) จาก YTM ฐาน",
};

/** Paths each method accepts at the top level (documented for UI pickers, REST and MCP). */
export const SCENARIO_PATHS: Record<Method, string[]> = {
  dcf_fcff: [...DCF_FIELDS, "growthShift", "marginShift", "discountRate", "stages[<id|1-4>].<field>", "scenario"],
  dcf_fcfe: [...DCF_FIELDS, "growthShift", "marginShift", "discountRate", "stages[<id|1-4>].<field>", "scenario"],
  ddm: [...DDM_FIELDS],
  residual_income: [...RIM_FIELDS, "roeShift", "scenario"],
  multiples: [...MULT_FIELDS],
  bond: [...BOND_FIELDS, "yieldShiftBp", "horizon.exitYield", "horizon.reinvestRate"],
  sotp: [
    ...SOTP_FIELDS,
    "segments[<id>].ownership",
    "segments[<id>].fx",
    "segments[<id>].netDebt",
    "segments[<id>].source.price|metric|multiple|value",
    "segments[<id>].model.<path of the segment's own method>",
    "segments[<id>].scenario",
    "nonOperatingAssets[<name>].value",
    "otherClaims[<name>].value",
    "eliminations[<name>].value",
  ],
};

export const VIRTUAL_DRIVERS = VIRTUAL;

// ------------------------------------------------------------------ path handling

interface Token {
  key: string;
  sel?: string;
}

export function parsePath(path: string): Token[] | null {
  const parts: string[] = [];
  let cur = "";
  let depth = 0;
  for (const ch of path.trim()) {
    if (ch === "[") depth++;
    if (ch === "]") depth--;
    if (depth < 0) return null;
    if (ch === "." && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (depth !== 0) return null;
  parts.push(cur);
  const out: Token[] = [];
  for (const p of parts) {
    const m = /^([A-Za-z][A-Za-z0-9_]*)(?:\[([^\]]+)\])?$/.exec(p);
    if (!m) return null;
    out.push({ key: m[1], sel: m[2]?.trim() });
  }
  return out.length ? out : null;
}

/** Stable SOTP segment key: id, else entity, else name (case-insensitive). */
export function segmentKey(s: { id?: string; entity?: string; name: string }) {
  return (s.id?.trim() || s.entity?.trim() || s.name).trim().toUpperCase();
}

type Op = (old: number | undefined) => number | string;
interface Ctx {
  /** Base value of a virtual driver read from an evaluation (e.g. the discount rate). */
  virtual: Record<string, number>;
  notes: string[];
}

type Obj = Record<string, unknown>;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function fail(msg: string): never {
  throw new ScenarioPathError(msg);
}
export class ScenarioPathError extends Error {}

function setField(a: Obj, field: string, op: Op, allowed: readonly string[], label: string) {
  if (!allowed.includes(field)) fail(`${label}: ปรับ "${field}" ไม่ได้ (นอกรายการที่อนุญาต)`);
  const old = a[field];
  const v = op(old == null ? undefined : (old as number));
  if (!isNum(v)) fail(`${label}.${field}: ต้องเป็นตัวเลขจำกัด`);
  a[field] = v;
}

function applyDcf(a: Obj, t: Token[], op: Op, ctx: Ctx, label: string) {
  const [h, ...rest] = t;
  const staged = a.forecastMode === "staged" && Array.isArray(a.stages) && a.stages.length > 0;
  if (h.key === "stages") {
    if (!staged) fail(`${label}: ไม่ได้อยู่ในโหมดหลายช่วง — ใช้ growthStart / ebitMarginStart แทน`);
    const stages = a.stages as Obj[];
    const sel = h.sel ?? "";
    const idx = /^[1-4]$/.test(sel) ? Number(sel) - 1 : stages.findIndex((s) => String(s.id ?? s.name ?? "").toUpperCase() === sel.toUpperCase());
    if (idx < 0 || idx >= stages.length) fail(`${label}: ไม่พบช่วง "${sel}"`);
    if (rest.length !== 1) fail(`${label}: ระบุ stages[…].<field>`);
    stages[idx] = { ...stages[idx] };
    const st = stages[idx];
    const f = rest[0].key;
    if (!STAGE_FIELDS.includes(f as (typeof STAGE_FIELDS)[number])) fail(`${label}: ปรับ stages[].${f} ไม่ได้`);
    const v = op(st[f] == null ? (a[f] as number | undefined) : (st[f] as number));
    if (!isNum(v)) fail(`${label}: ต้องเป็นตัวเลขจำกัด`);
    st[f] = v;
    return;
  }
  if (rest.length) fail(`${label}: path ไม่ถูกต้อง`);
  if (h.key === "growthShift" || h.key === "marginShift") {
    const d = op(0);
    if (!isNum(d)) fail(`${label}: ต้องเป็นตัวเลขจำกัด`);
    const pair = h.key === "growthShift" ? ["revenueGrowthStart", "revenueGrowthEnd", "growthStart", "growthEnd"] : ["ebitMarginStart", "ebitMarginEnd", "ebitMarginStart", "ebitMarginEnd"];
    if (staged) a.stages = (a.stages as Obj[]).map((s) => ({ ...s, [pair[0]]: (s[pair[0]] as number) + d, [pair[1]]: (s[pair[1]] as number) + d }));
    else {
      a[pair[2]] = (a[pair[2]] as number) + d;
      a[pair[3]] = (a[pair[3]] as number) + d;
    }
    return;
  }
  if (h.key === "discountRate") {
    const base = ctx.virtual.discountRate;
    const v = op(base);
    if (!isNum(v)) fail(`${label}: ต้องเป็นตัวเลขจำกัด`);
    a.__discountRate = v;
    return;
  }
  if (staged && FADE_FIELDS.includes(h.key)) fail(`${label}: โหมดหลายช่วงใช้ stages[…].${h.key.replace("growth", "revenueGrowth")} แทน ${h.key}`);
  setField(a, h.key, op, DCF_FIELDS, label);
}

function applyRim(a: Obj, t: Token[], op: Op, label: string) {
  if (t.length !== 1) fail(`${label}: path ไม่ถูกต้อง`);
  const f = t[0].key;
  const term = (a.terminalMethod as string | undefined) ?? "perpetuity";
  if (f === "terminalGrowth" && term !== "perpetuity") fail(`${label}: ปรับ g ระยะยาวได้เฉพาะ continuing value แบบ perpetuity`);
  if (f === "persistence" && term !== "persistence") fail(`${label}: ปรับ ω ได้เฉพาะ continuing value แบบ persistence`);
  if (f === "terminalRoe" && term === "none") fail(`${label}: ไม่มี continuing value — ปรับ ROE ระยะยาวไม่ได้`);
  if (f === "roeShift" || f === "payoutRatio") {
    // Same rules as the RIM scenario engine (applyRimScenario): ROE shift touches ROE years only (EPS
    // years unchanged) and an explicit terminal ROE; payout replaces every year's payout.
    const rows = riForecastRows(a as Parameters<typeof riForecastRows>[0]) as Obj[];
    const v = op(f === "roeShift" ? 0 : (a.payoutRatio as number));
    if (!isNum(v)) fail(`${label}: ต้องเป็นตัวเลขจำกัด`);
    if (f === "roeShift") {
      if (rows.some((r) => r.eps != null) && v) ctxNote(a, "ปีที่ระบุ EPS ไม่ถูกปรับด้วย ROE shift");
      if (rows.length) a.forecast = rows.map((r) => (r.eps == null && isNum(r.roe) ? { ...r, roe: r.roe + v } : r));
      else a.roe = (a.roe as number) + v;
      if (isNum(a.terminalRoe)) a.terminalRoe = a.terminalRoe + v;
    } else {
      a.payoutRatio = v;
      if (rows.length) a.forecast = rows.map((r) => ({ ...r, payoutRatio: v }));
    }
    if (rows.length) for (const k of ["roeForecast", "epsForecast", "payoutForecast", "bookValueForecast"]) delete a[k];
    return;
  }
  setField(a, f, op, RIM_FIELDS, label);
}

const NOTE_KEY = "__notes";
function ctxNote(a: Obj, msg: string) {
  a[NOTE_KEY] = [...((a[NOTE_KEY] as string[] | undefined) ?? []), msg];
}

function applyBond(a: Obj, t: Token[], op: Op, ctx: Ctx, label: string) {
  const f = t.map((x) => x.key).join(".");
  if (f === "yieldShiftBp") {
    const base = ctx.virtual.ytm;
    if (!isNum(base)) fail(`${label}: ไม่มี YTM ฐาน`);
    const bp = op(0);
    if (!isNum(bp)) fail(`${label}: ต้องเป็นตัวเลขจำกัด`);
    a.ytm = base + bp / 10_000;
    delete a.cleanPrice;
    return;
  }
  if (f === "ytm") {
    const v = op((a.ytm as number | undefined) ?? ctx.virtual.ytm);
    if (!isNum(v)) fail(`${label}: ต้องเป็นตัวเลขจำกัด`);
    a.ytm = v;
    delete a.cleanPrice;
    return;
  }
  if (f === "horizon.exitYield" || f === "horizon.reinvestRate") {
    if (!a.horizon) fail(`${label}: ไม่มีการตั้ง horizon return`);
    const h = { ...(a.horizon as Obj) };
    const k = f.split(".")[1];
    const v = op(h[k] as number | undefined);
    if (!isNum(v)) fail(`${label}: ต้องเป็นตัวเลขจำกัด`);
    h[k] = v;
    a.horizon = h;
    return;
  }
  fail(`${label}: ปรับ "${f}" ของพันธบัตรไม่ได้`);
}

/** Apply a named scenario stored inside a DCF / RIM input (legacy `scenarios`). */
function applyNamed(method: Method, a: Obj, name: string, label: string) {
  const list = (a.scenarios as { name: string }[] | undefined) ?? [];
  const s = list.find((x) => x.name.toUpperCase() === name.toUpperCase());
  if (!s) fail(`${label}: ไม่พบ scenario "${name}" ในโมเดลนี้`);
  if (method === "dcf_fcff" || method === "dcf_fcfe") {
    const r = applyScenario(a as unknown as DcfAssumptions, s as DcfScenario);
    if (r.error) fail(`${label}: ${r.error}`);
    Object.assign(a, r.a);
    return;
  }
  if (method === "residual_income") {
    const o = (s as unknown as { overrides: Record<string, number | undefined> }).overrides;
    // roeShift first, then absolute overrides (the RIM engine's order).
    if (o.roeShift != null) applyRim(a, [{ key: "roeShift" }], () => o.roeShift!, label);
    for (const k of ["payoutRatio", "terminalGrowth", "terminalRoe", "persistence"]) if (o[k] != null) applyRim(a, [{ key: k }], () => o[k]!, label);
    return;
  }
  fail(`${label}: method ${method} ไม่มี scenario ในตัว`);
}

function applyToMethod(method: Method, a: Obj, t: Token[], op: Op, ctx: Ctx, label: string) {
  if (t.length === 1 && t[0].key === "scenario") {
    const name = op(undefined);
    if (typeof name !== "string") fail(`${label}.scenario: ต้องเป็นชื่อ scenario`);
    return applyNamed(method, a, name, label);
  }
  switch (method) {
    case "dcf_fcff":
    case "dcf_fcfe":
      return applyDcf(a, t, op, ctx, label);
    case "residual_income":
      return applyRim(a, t, op, label);
    case "ddm":
      if (t.length !== 1) fail(`${label}: path ไม่ถูกต้อง`);
      setField(a, t[0].key, op, DDM_FIELDS, label);
      if (t[0].key === "highGrowthYears") a.highGrowthYears = Math.round(a.highGrowthYears as number);
      return;
    case "multiples":
      if (t.length !== 1) fail(`${label}: path ไม่ถูกต้อง`);
      return setField(a, t[0].key, op, MULT_FIELDS, label);
    case "bond":
      return applyBond(a, t, op, ctx, label);
    case "sotp":
      return applySotp(a, t, op, ctx, label);
  }
}

function applySotp(a: Obj, t: Token[], op: Op, ctx: Ctx, label: string) {
  const [h, ...rest] = t;
  if (h.key === "segments") {
    const segs = a.segments as Obj[];
    const want = (h.sel ?? "").toUpperCase();
    const idx = segs.findIndex((s) => segmentKey(s as { id?: string; entity?: string; name: string }) === want);
    if (!want || idx < 0) fail(`${label}: ไม่พบส่วนงาน "${h.sel ?? ""}" (อ้างด้วย id / entity / ชื่อ ไม่ใช่ลำดับ)`);
    const seg: Obj = { ...segs[idx], source: { ...(segs[idx].source as Obj) } };
    segs[idx] = seg;
    const segLabel = `${label} › ${seg.name as string}`;
    const [k, ...tail] = rest;
    if (!k) fail(`${segLabel}: path ไม่ครบ`);
    if (k.key === "model" || k.key === "scenario") {
      const src = seg.source as Obj;
      if (src.type !== "model") fail(`${segLabel}: ส่วนงานนี้ไม่ได้ใช้โมเดล (${src.type as string})`);
      const val = { ...(src.valuation as Obj) };
      const inner = { ...(val.assumptions as Obj) };
      const m = val.method as Method;
      const innerCtx: Ctx = { virtual: {}, notes: ctx.notes };
      applyToMethod(m, inner, k.key === "scenario" ? [k] : tail, op, innerCtx, segLabel);
      if (inner.__discountRate != null) fail(`${segLabel}: discountRate ใช้ได้กับ DCF ที่ประเมินเดี่ยว — ใน SOTP ให้ปรับ riskFree / extraPremium ของส่วนงาน`);
      if (inner[NOTE_KEY]) {
        ctx.notes.push(...(inner[NOTE_KEY] as string[]).map((n) => `${segLabel}: ${n}`));
        delete inner[NOTE_KEY];
      }
      val.assumptions = inner;
      src.valuation = val;
      return;
    }
    if (k.key === "source") {
      const src = seg.source as Obj;
      if (tail.length !== 1) fail(`${segLabel}: ระบุ source.<field>`);
      return setField(src, tail[0].key, op, SOURCE_FIELDS[src.type as string] ?? [], `${segLabel}.source(${src.type as string})`);
    }
    if (tail.length) fail(`${segLabel}: path ไม่ถูกต้อง`);
    return setField(seg, k.key, op, SEGMENT_FIELDS, segLabel);
  }
  if ((LINE_LISTS as readonly string[]).includes(h.key)) {
    const list = [...((a[h.key] as Obj[] | undefined) ?? [])];
    const i = list.findIndex((x) => String(x.name).toUpperCase() === (h.sel ?? "").toUpperCase());
    if (i < 0) fail(`${label}: ไม่พบรายการ "${h.sel ?? ""}" ใน ${h.key}`);
    if (rest.length !== 1 || rest[0].key !== "value") fail(`${label}: ใช้ ${h.key}[<ชื่อ>].value`);
    list[i] = { ...list[i] };
    setField(list[i], "value", op, ["value"], label);
    a[h.key] = list;
    return;
  }
  if (rest.length) fail(`${label}: path ไม่ถูกต้อง`);
  setField(a, h.key, op, SOTP_FIELDS, label);
}

export interface ResolvedOverride {
  path: string;
  from: number | string | null;
  to: number | string;
}

const clone = <T>(x: T): T => structuredClone(x);

export type OverrideMode = "absolute" | "shift" | "pct";

/**
 * Apply overrides (named-scenario keys first, then the rest) and re-validate with the method schema.
 * `virtual` carries base values of virtual drivers (discount rate, YTM) taken from the base evaluation;
 * `modes` turns a value into a shift (base + v) or a relative change (base × (1 + v)).
 */
export function applyOverrides(
  input: ValuationInput,
  overrides: Record<string, number | string>,
  virtual: Record<string, number> = {},
  modes: Record<string, OverrideMode> = {},
): { input: ValuationInput | null; discountRate?: number; resolved: ResolvedOverride[]; errors: string[]; notes: string[] } {
  const a = clone(input.assumptions) as Obj;
  delete a.scenarioSet;
  const ctx: Ctx = { virtual, notes: [] };
  const resolved: ResolvedOverride[] = [];
  const errors: string[] = [];
  const isNamed = (k: string) => /(^|\.)scenario$/.test(k);
  const keys = Object.keys(overrides).sort((x, y) => Number(!isNamed(x)) - Number(!isNamed(y)));
  for (const path of keys) {
    const raw = overrides[path];
    const tokens = parsePath(path);
    if (!tokens) {
      errors.push(`path "${path}" รูปแบบไม่ถูกต้อง`);
      continue;
    }
    if (typeof raw === "number" && !Number.isFinite(raw)) {
      errors.push(`${path}: ค่าต้องเป็นตัวเลขจำกัด`);
      continue;
    }
    const mode = modes[path] ?? "absolute";
    let rec: ResolvedOverride | null = null;
    const op: Op = (old) => {
      let to: number | string = raw;
      if (typeof raw === "number" && mode !== "absolute") {
        if (old == null) fail(`${path}: ไม่มีค่าฐานให้ปรับแบบ ${mode}`);
        to = mode === "shift" ? old + raw : old * (1 + raw);
      }
      rec = { path, from: old ?? null, to };
      return to;
    };
    try {
      applyToMethod(input.method, a, tokens, op, ctx, path);
      if (rec) resolved.push(rec);
    } catch (e) {
      if (e instanceof ScenarioPathError) errors.push(e.message);
      else throw e;
    }
  }
  if (a[NOTE_KEY]) {
    ctx.notes.push(...(a[NOTE_KEY] as string[]));
    delete a[NOTE_KEY];
  }
  if (errors.length) return { input: null, resolved, errors, notes: ctx.notes };
  const discountRate = a.__discountRate as number | undefined;
  delete a.__discountRate;
  const parsed = valuationInput.safeParse({ method: input.method, assumptions: a });
  if (!parsed.success) {
    return { input: null, resolved, errors: parsed.error.issues.map((i) => `ค่าไม่ผ่าน schema: ${i.path.join(".")} — ${i.message}`), notes: ctx.notes };
  }
  return { input: parsed.data, discountRate, resolved, errors, notes: ctx.notes };
}

// ------------------------------------------------------------------ valuation of one input

export interface PointValue {
  value: number | null;
  price: number | null;
  equityValue: number | null;
  errors: string[];
  warnings: string[];
  warningCodes: string[];
  bridge?: { segments: { key: string; name: string; attributable: number | null }[]; equityValue: number | null; difference: number | null; valueUnit: string | null };
}

/** Value of an already-validated input (optionally at an explicit DCF discount rate). Same evaluator as the editor. */
export function valueOf(input: ValuationInput, discountRate?: number): PointValue {
  if (discountRate != null && (input.method === "dcf_fcff" || input.method === "dcf_fcfe")) {
    return dcfAtExplicitRate(input, discountRate);
  }
  const r = evaluateLean(input);
  const d = r.details as {
    equityValue?: number | null;
    errors?: ({ message: string; code?: string } | string)[];
    warnings?: string[];
    warningDetails?: { code: string; message: string }[];
    segments?: { name: string; attributable: number | null }[];
    reconciliation?: { difference: number; equityValue: number } | null;
    valueUnit?: string | null;
  };
  const errors = (d.errors ?? []).map((e) => (typeof e === "string" ? e : e.message));
  const errorCodes = (d.errors ?? []).flatMap((e) => (typeof e === "string" || !e.code ? [] : [e.code]));
  let value = r.value;
  if (value != null && !Number.isFinite(value)) value = null;
  if (value == null && !errors.length) errors.push("คำนวณมูลค่าไม่ได้ (เช่น อัตราคิดลด ≤ อัตราการเติบโต หรือข้อมูลไม่ครบ)");
  const out: PointValue = {
    value: errors.length ? null : value,
    price: r.price,
    equityValue: d.equityValue ?? null,
    errors,
    warnings: d.warnings ?? [],
    warningCodes: [...(d.warningDetails ?? []).map((w) => w.code), ...errorCodes],
  };
  if (input.method === "sotp") {
    const segs = input.assumptions.segments;
    out.bridge = {
      segments: (d.segments ?? []).map((s, i) => ({ key: segs[i] ? segmentKey(segs[i]) : s.name, name: s.name, attributable: s.attributable })),
      equityValue: d.reconciliation?.equityValue ?? null,
      difference: d.reconciliation?.difference ?? null,
      valueUnit: d.valueUnit ?? null,
    };
    const tol = 1e-6 * Math.max(1, Math.abs(d.reconciliation?.equityValue ?? 0));
    if (d.reconciliation && Math.abs(d.reconciliation.difference) > tol) {
      out.errors.push(`BRIDGE_UNBALANCED: waterfall ต่างจากมูลค่าส่วนผู้ถือหุ้น ${d.reconciliation.difference}`);
      out.value = null;
    }
  }
  return out;
}

function dcfAtExplicitRate(input: ValuationInput, rate: number): PointValue {
  const a = input.assumptions as DcfAssumptions;
  const model = input.method === "dcf_fcff" ? "fcff" : "fcfe";
  const g = a.terminalGrowth;
  if (a.terminalMethod !== "exit_multiple" && !(rate > g)) return { value: null, price: a.currentPrice, equityValue: null, errors: [`อัตราคิดลด ${(rate * 100).toFixed(2)}% ≤ g ระยะยาว ${(g * 100).toFixed(2)}%`], warnings: [], warningCodes: [] };
  const v = dcfAtRate(a, model, rate);
  return { value: v != null && Number.isFinite(v) ? v : null, price: a.currentPrice, equityValue: null, errors: v == null ? ["คำนวณไม่ได้ที่อัตราคิดลดนี้"] : [], warnings: [], warningCodes: [] };
}

/** Base values of virtual drivers (discount rate of a DCF, YTM of a bond) from the base evaluation. */
export function virtualBase(input: ValuationInput): Record<string, number> {
  const out: Record<string, number> = {};
  if (input.method === "dcf_fcff" || input.method === "dcf_fcfe") {
    const d = evaluateLean(input).details as { discountRate?: number };
    if (isNum(d.discountRate)) out.discountRate = d.discountRate;
  }
  if (input.method === "bond") {
    const d = evaluateLean(input).details as { ytm?: number };
    if (isNum(d.ytm)) out.ytm = d.ytm;
  }
  return out;
}

// ------------------------------------------------------------------ scenarios

/** SOTP / bridge warnings that keep a result preliminary until resolved. */
export const MATERIAL_CODES = ["MINORITY_DOUBLE_COUNT", "MISSING_MINORITY", "DEBT_DOUBLE_COUNT", "DEBT_OMITTED", "CASH_DOUBLE_COUNT", "INVESTMENT_DOUBLE_COUNT", "DUPLICATE_ENTITY", "EV_NEEDS_OWN_DEBT", "MISSING_SEGMENT_DEBT", "SEGMENT_DEBT_IGNORED"];

export type QualityStatus = "verified_inputs" | "preliminary" | "insufficient_data";

export interface ScenarioValuationResult {
  scenarioId: string;
  name: string;
  probability: number;
  valuePerShare: number | null;
  equityValue: number | null;
  upsidePct: number | null;
  marginOfSafetyPct: number | null;
  naReason: string | null;
  inputsResolved: ResolvedOverride[];
  warnings: string[];
  errors: string[];
  bridge?: PointValue["bridge"];
  rationale?: string;
  sources?: string;
  noteTh?: string;
}

export interface ScenarioSummary {
  method: Method;
  valueKind: "per_share" | "bond_clean_price";
  baseCaseValue: number | null;
  probabilityWeightedValue: number | null;
  weightedUpsidePct: number | null;
  weightedMarginOfSafetyPct: number | null;
  sumProbability: number;
  scenarios: ScenarioValuationResult[];
  price: number | null;
  currency: string;
  asOf: string;
  modelVersion: string;
  qualityStatus: QualityStatus;
  qualityReasons: string[];
  errors: string[];
  warnings: string[];
  derivedFromSegments: boolean;
}

/** upside = FV / price − 1; margin of safety = (FV − price) / FV. Both N/A (with a reason) unless FV > 0 and price > 0. */
export function upsideAndMos(fv: number | null, price: number | null) {
  if (fv == null || !Number.isFinite(fv)) return { upside: null, mos: null, reason: "ไม่มีมูลค่า" };
  if (!(price != null && price > 0)) return { upside: null, mos: null, reason: "ไม่มีราคาตลาดที่เป็นบวก" };
  if (!(fv > 0)) return { upside: fv / price - 1, mos: null, reason: "มูลค่าไม่เป็นบวก — margin of safety ไม่มีความหมาย" };
  return { upside: fv / price - 1, mos: (fv - price) / fv, reason: null };
}

/** Probability checks: finite, 0..1, unique ids, Σ = 1 within tolerance. Returns messages (empty = valid). */
export function validateProbabilities(scen: { id: string; probability: number }[]): string[] {
  const errs: string[] = [];
  if (!scen.length) errs.push("ไม่มี scenario");
  const ids = new Set<string>();
  for (const s of scen) {
    if (ids.has(s.id.toLowerCase())) errs.push(`id ซ้ำ: ${s.id}`);
    ids.add(s.id.toLowerCase());
    if (!Number.isFinite(s.probability)) errs.push(`${s.id}: ความน่าจะเป็นต้องเป็นตัวเลขจำกัด`);
    else if (s.probability < 0 || s.probability > 1) errs.push(`${s.id}: ความน่าจะเป็นต้องอยู่ระหว่าง 0 ถึง 1`);
  }
  const sum = scen.reduce((t, s) => t + (Number.isFinite(s.probability) ? s.probability : 0), 0);
  if (scen.length && Math.abs(sum - 1) > PROBABILITY_TOLERANCE) errs.push(`ความน่าจะเป็นรวม ${(sum * 100).toFixed(6)}% — ต้องเท่ากับ 100% (คลาดเคลื่อนได้ไม่เกิน 1e-8) · ระบบไม่ปรับให้เอง`);
  return errs;
}

/** Normalised probabilities shown to the user before they choose to apply them (never applied silently). */
export function proposeNormalised(scen: { id: string; probability: number }[]) {
  const sum = scen.reduce((t, s) => t + (s.probability > 0 && Number.isFinite(s.probability) ? s.probability : 0), 0);
  return sum > 0 ? scen.map((s) => ({ id: s.id, from: s.probability, to: s.probability > 0 ? s.probability / sum : 0 })) : null;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "") || "s";

/**
 * SOTP: one scenario per name shared by the segment models' own scenarios (e.g. the core DCF's
 * Bear/Base/Bull). Segments without scenarios (e.g. a market-valued stake) keep their base value.
 */
export function scenariosFromSegments(input: ValuationInput): { scenarios: ValuationScenario[]; errors: string[]; notes: string[] } {
  if (input.method !== "sotp") return { scenarios: [], errors: ["from_segments ใช้ได้เฉพาะ SOTP"], notes: [] };
  const errors: string[] = [];
  const notes: string[] = [];
  const bySeg: { key: string; name: string; list: { name: string; probability: number }[] }[] = [];
  for (const s of input.assumptions.segments) {
    if (s.source.type !== "model") {
      notes.push(`${s.name}: ไม่มี scenario ของตัวเอง — ใช้มูลค่าฐานทุก scenario (${s.source.type})`);
      continue;
    }
    const list = (s.source.valuation.assumptions as { scenarios?: { name: string; probability: number }[] }).scenarios ?? [];
    if (!list.length) notes.push(`${s.name}: โมเดลไม่มี scenario — ใช้มูลค่าฐาน`);
    else bySeg.push({ key: segmentKey(s), name: s.name, list });
  }
  if (!bySeg.length) return { scenarios: [], errors: ["ไม่มีส่วนงานที่มี scenario ของตัวเอง"], notes };
  const names = bySeg[0].list.map((x) => x.name);
  for (const seg of bySeg.slice(1)) {
    const same = seg.list.length === names.length && seg.list.every((x) => names.some((n) => n.toUpperCase() === x.name.toUpperCase()));
    if (!same) errors.push(`${seg.name}: ชื่อ scenario (${seg.list.map((x) => x.name).join("/")}) ไม่ตรงกับ ${bySeg[0].name} (${names.join("/")})`);
    for (const x of seg.list) {
      const ref = bySeg[0].list.find((y) => y.name.toUpperCase() === x.name.toUpperCase());
      if (ref && Math.abs(ref.probability - x.probability) > PROBABILITY_TOLERANCE) errors.push(`${seg.name}: ความน่าจะเป็นของ ${x.name} (${x.probability}) ไม่ตรงกับ ${bySeg[0].name} (${ref.probability}) — ต้องเป็นเหตุการณ์เดียวกัน`);
    }
  }
  const used = new Set<string>();
  const scenarios = bySeg[0].list.map((x) => {
    let id = slug(x.name);
    while (used.has(id)) id += "-2";
    used.add(id);
    return {
      id,
      name: x.name,
      probability: x.probability,
      inputOverrides: Object.fromEntries(bySeg.map((s) => [`segments[${s.key}].scenario`, x.name])),
      rationale: `ใช้ scenario "${x.name}" ของโมเดลส่วนงาน (${bySeg.map((s) => s.name).join(", ")}) แล้วคำนวณ SOTP ใหม่ทั้งสะพาน`,
    };
  });
  return { scenarios, errors, notes };
}

function duplicateSegmentIds(input: ValuationInput): string[] {
  if (input.method !== "sotp") return [];
  const seen = new Map<string, string>();
  const out: string[] = [];
  for (const s of input.assumptions.segments) {
    const k = segmentKey(s);
    if (seen.has(k)) out.push(`DUPLICATE_SEGMENT_ID: ส่วนงาน "${s.name}" ใช้ id/entity ซ้ำกับ "${seen.get(k)}" (${k}) — อ้างอิงใน scenario ไม่ได้`);
    else seen.set(k, s.name);
  }
  return out;
}

export interface RunScenarioOptions {
  currency?: string;
  today?: string;
  /** Scenarios to run instead of the input's own scenarioSet. */
  scenarios?: ValuationScenario[];
}

/** Run Base + every scenario through the same evaluator and aggregate with the strict probability rules. */
export function runScenarios(input: ValuationInput, opts: RunScenarioOptions = {}): ScenarioSummary {
  const set = (input.assumptions as { scenarioSet?: ScenarioSet }).scenarioSet;
  const errors: string[] = [];
  const warnings: string[] = [];
  let scenarios = opts.scenarios ?? set?.scenarios ?? [];
  let derived = false;
  if (!opts.scenarios && set?.mode === "from_segments") {
    const d = scenariosFromSegments(input);
    errors.push(...d.errors);
    warnings.push(...d.notes);
    scenarios = d.scenarios.map((s) => {
      const saved = set.scenarios.find((x) => x.id === s.id);
      return saved ? { ...s, noteTh: saved.noteTh, sources: saved.sources ?? s.sources, rationale: saved.rationale ?? s.rationale } : s;
    });
    derived = true;
  }
  errors.push(...duplicateSegmentIds(input));

  const base = valueOf(input);
  const meta = (input.assumptions as { inputMeta?: { asOf?: string } }).inputMeta;
  const virtual = virtualBase(input);
  const rows: ScenarioValuationResult[] = scenarios.map((s) => {
    const applied = applyOverrides(input, s.inputOverrides ?? {}, virtual);
    const pv = applied.input ? valueOf(applied.input, applied.discountRate) : null;
    const errs = [...applied.errors, ...(pv?.errors ?? [])];
    const value = errs.length ? null : (pv?.value ?? null);
    const um = upsideAndMos(value, pv?.price ?? base.price);
    return {
      scenarioId: s.id,
      name: s.name,
      probability: s.probability,
      valuePerShare: value,
      equityValue: pv?.equityValue ?? null,
      upsidePct: um.upside,
      marginOfSafetyPct: um.mos,
      naReason: value == null ? errs[0] ?? "คำนวณไม่ได้" : um.reason,
      inputsResolved: applied.resolved,
      warnings: [...applied.notes, ...(pv?.warnings ?? [])],
      errors: errs,
      bridge: pv?.bridge,
      rationale: s.rationale,
      sources: s.sources,
      noteTh: s.noteTh,
      warningCodes: pv?.warningCodes ?? [],
    } as ScenarioValuationResult & { warningCodes: string[] };
  });

  const probErrors = validateProbabilities(scenarios);
  errors.push(...probErrors);
  const invalidPositive = rows.filter((r) => r.probability > 0 && r.valuePerShare == null);
  invalidPositive.forEach((r) => errors.push(`${r.name}: คำนวณไม่ได้ (${r.errors.join("; ") || "ไม่มีค่า"}) — ไม่แสดงมูลค่าถ่วงน้ำหนัก`));
  rows.filter((r) => r.probability === 0 && r.valuePerShare == null).forEach((r) => warnings.push(`${r.name}: ความน่าจะเป็น 0% และคำนวณไม่ได้ — แสดงไว้แต่ไม่รวมในการถ่วงน้ำหนัก`));

  const weighted = !errors.length && rows.length ? rows.reduce((t, r) => (r.probability > 0 ? t + r.probability * r.valuePerShare! : t), 0) : null;
  const price = base.price;
  const wum = upsideAndMos(weighted, price);

  const codes = new Set<string>([...base.warningCodes, ...rows.flatMap((r) => (r as unknown as { warningCodes: string[] }).warningCodes)]);
  const material = MATERIAL_CODES.filter((c) => codes.has(c));
  const reasons: string[] = [];
  let quality: QualityStatus = "verified_inputs";
  if (base.value == null) {
    quality = "insufficient_data";
    reasons.push(`มูลค่ากรณีฐานคำนวณไม่ได้: ${base.errors.join("; ")}`);
  } else {
    if (material.length) reasons.push(`มีคำเตือนสำคัญที่ยังไม่แก้: ${material.join(", ")}`);
    if (!meta?.asOf && input.method !== "bond") reasons.push("ไม่ได้ระบุวันที่ของข้อมูลตลาด (inputMeta.asOf)");
    if (reasons.length) quality = "preliminary";
  }
  rows.forEach((r) => delete (r as unknown as { warningCodes?: string[] }).warningCodes);

  return {
    method: input.method,
    valueKind: input.method === "bond" ? "bond_clean_price" : "per_share",
    baseCaseValue: base.value,
    probabilityWeightedValue: weighted,
    weightedUpsidePct: wum.upside,
    weightedMarginOfSafetyPct: wum.mos,
    sumProbability: scenarios.reduce((t, s) => t + (Number.isFinite(s.probability) ? s.probability : 0), 0),
    scenarios: rows,
    price,
    currency: opts.currency ?? "THB",
    asOf: meta?.asOf ?? (input.method === "bond" ? (input.assumptions as { settlement: string }).settlement : (opts.today ?? new Date().toISOString().slice(0, 10))),
    modelVersion: MODEL_VERSION,
    qualityStatus: quality,
    qualityReasons: reasons,
    errors,
    warnings: [
      ...warnings,
      ...(input.method === "bond" ? ["พันธบัตร: ค่าที่ถ่วงน้ำหนักคือราคาสะอาดต่อ 100 ของแต่ละ scenario (ไม่ใช่มูลค่าหุ้น) — การช็อก yield ใช้การตีราคาเต็ม ไม่ใช่ duration/convexity; หุ้นกู้ที่เรียกไถ่ถอนได้อาจไม่เป็นเชิงเส้น"] : []),
    ],
    derivedFromSegments: derived,
  };
}

/** Bear/Base/Bull starter set with editable example probabilities 25/50/25 (not estimated). */
export function presetScenarios(input: ValuationInput): ValuationScenario[] {
  const m = input.method;
  const mk = (bear: Record<string, number>, bull: Record<string, number>): ValuationScenario[] => [
    { id: "bear", name: "Bear", probability: 0.25, inputOverrides: bear, rationale: "ตัวอย่างเริ่มต้น — แก้ให้ตรงกับเหตุผลของคุณ" },
    { id: "base", name: "Base", probability: 0.5, inputOverrides: {} },
    { id: "bull", name: "Bull", probability: 0.25, inputOverrides: bull, rationale: "ตัวอย่างเริ่มต้น — แก้ให้ตรงกับเหตุผลของคุณ" },
  ];
  switch (m) {
    case "dcf_fcff":
    case "dcf_fcfe":
      return mk({ growthShift: -0.02, marginShift: -0.01 }, { growthShift: 0.02, marginShift: 0.01 });
    case "ddm":
      return mk({ highGrowth: Math.max(-0.5, (input.assumptions.highGrowth ?? 0) - 0.02) }, { highGrowth: (input.assumptions.highGrowth ?? 0) + 0.02 });
    case "residual_income":
      return mk({ roeShift: -0.02 }, { roeShift: 0.02 });
    case "multiples": {
      const a = input.assumptions;
      return mk({ targetPE: a.targetPE * 0.85, targetPBV: a.targetPBV * 0.85, targetEvEbitda: a.targetEvEbitda * 0.85 }, { targetPE: a.targetPE * 1.15, targetPBV: a.targetPBV * 1.15, targetEvEbitda: a.targetEvEbitda * 1.15 });
    }
    case "bond":
      return mk({ yieldShiftBp: 100 }, { yieldShiftBp: -50 });
    case "sotp":
      return mk({ holdingDiscount: Math.min(0.9, input.assumptions.holdingDiscount + 0.1) }, { holdingDiscount: Math.max(0, input.assumptions.holdingDiscount - 0.1) });
  }
}
