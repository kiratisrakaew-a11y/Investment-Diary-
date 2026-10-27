/**
 * PR13 — generic sensitivity grid and reverse solver on top of the scenario engine. Every cell or
 * solver step is the base input with one or two driver overrides, re-validated and valued by the same
 * evaluator; an invalid combination is N/A with its reason, never 0 or a guessed number.
 */
import type { ValuationInput } from "./valuation-schemas";
import { applyOverrides, valueOf, virtualBase, segmentKey, type OverrideMode } from "./valuation-scenarios";
import type { ReverseConfig, SensitivityAxisSpec, SensitivityConfig } from "./valuation-scenario-schema";

export const MAX_SENSITIVITY_CELLS = 121;

export interface SensitivityCell {
  x: number;
  y: number | null;
  value: number | null;
  delta: number | null;
  deltaPct: number | null;
  error: string | null;
  warnings: string[];
}

export interface SensitivityResult {
  ok: boolean;
  x: SensitivityAxisSpec & { label: string };
  y: (SensitivityAxisSpec & { label: string }) | null;
  baseValue: number | null;
  /** Value at the zero-shift / base point (must equal baseValue when the grid contains it). */
  basePointValue: number | null;
  cells: SensitivityCell[][];
  monotonic: { rows: ("increasing" | "decreasing" | "flat" | "mixed" | "n/a")[] };
  errors: string[];
  notes: string[];
}

const pathLabel = (p: string, mode: string) => `${p}${mode === "shift" ? " (± จากฐาน)" : mode === "pct" ? " (% จากฐาน)" : ""}`;

function evalAt(input: ValuationInput, over: Record<string, number>, modes: Record<string, OverrideMode>, virtual: Record<string, number>) {
  const a = applyOverrides(input, over, virtual, modes);
  if (!a.input) return { value: null, error: a.errors.join("; "), warnings: a.notes };
  const v = valueOf(a.input, a.discountRate);
  return { value: v.value, error: v.value == null ? v.errors.join("; ") || "คำนวณไม่ได้" : null, warnings: [...a.notes, ...v.warnings] };
}

function trend(vals: (number | null)[]): SensitivityResult["monotonic"]["rows"][number] {
  const v = vals.filter((x): x is number => x != null);
  if (v.length < 2) return "n/a";
  const d = v.slice(1).map((x, i) => x - v[i]);
  const tol = 1e-12 * Math.max(1, ...v.map(Math.abs));
  if (d.every((x) => Math.abs(x) <= tol)) return "flat";
  if (d.every((x) => x >= -tol)) return "increasing";
  if (d.every((x) => x <= tol)) return "decreasing";
  return "mixed";
}

/** 1-D or 2-D grid; rows follow y (or one row when there is no y), columns follow x. */
export function sensitivityGrid(input: ValuationInput, cfg: SensitivityConfig): SensitivityResult {
  const errors: string[] = [];
  const nx = cfg.x.values.length;
  const ny = cfg.y?.values.length ?? 1;
  if (nx * ny > MAX_SENSITIVITY_CELLS) errors.push(`ตารางใหญ่เกิน ${MAX_SENSITIVITY_CELLS} ช่อง`);
  if (cfg.y && cfg.y.path === cfg.x.path) errors.push("แกน x และ y ต้องเป็นตัวแปรต่างกัน");
  const base = valueOf(input);
  const virtual = virtualBase(input);
  const xs = { ...cfg.x, label: pathLabel(cfg.x.path, cfg.x.mode) };
  const ys = cfg.y ? { ...cfg.y, label: pathLabel(cfg.y.path, cfg.y.mode) } : null;
  if (errors.length) return { ok: false, x: xs, y: ys, baseValue: base.value, basePointValue: null, cells: [], monotonic: { rows: [] }, errors, notes: [] };
  const modes: Record<string, OverrideMode> = { [cfg.x.path]: cfg.x.mode, ...(cfg.y ? { [cfg.y.path]: cfg.y.mode } : {}) };
  const isBase = (ax: SensitivityAxisSpec, v: number) => (ax.mode === "absolute" ? false : v === 0);
  let basePoint: number | null = null;
  const cells = (cfg.y?.values ?? [null]).map((yv) =>
    cfg.x.values.map((xv) => {
      const over: Record<string, number> = { [cfg.x.path]: xv, ...(cfg.y && yv != null ? { [cfg.y.path]: yv } : {}) };
      const r = evalAt(input, over, modes, virtual);
      if (isBase(cfg.x, xv) && (!cfg.y || (yv != null && isBase(cfg.y, yv)))) basePoint = r.value;
      const delta = r.value != null && base.value != null ? r.value - base.value : null;
      return { x: xv, y: yv, value: r.value, delta, deltaPct: delta != null && base.value ? delta / Math.abs(base.value) : null, error: r.error, warnings: r.warnings } satisfies SensitivityCell;
    }),
  );
  const notes: string[] = [];
  const rows = cells.map((r) => trend(r.map((c) => c.value)));
  if (rows.includes("mixed")) notes.push("บางแถวไม่เป็นเอกภาพ (ไม่ขึ้นหรือลงอย่างเดียว) — ตรวจช่องที่ผิดปกติ ไม่ควรสรุปว่าความสัมพันธ์เป็นเส้นตรง");
  if (basePoint != null && base.value != null && Math.abs(basePoint - base.value) > 1e-9 * Math.max(1, Math.abs(base.value))) errors.push(`จุดฐานของตาราง (${basePoint}) ไม่ตรงกับมูลค่าฐาน (${base.value})`);
  return { ok: !errors.length, x: xs, y: ys, baseValue: base.value, basePointValue: basePoint, cells, monotonic: { rows }, errors, notes };
}

const range = (c: number, step: number, n = 2) => Array.from({ length: 2 * n + 1 }, (_, i) => Number((c + (i - n) * step).toFixed(10)));

/** Default grid per method (WACC × g, Ke × g, ROE × Ke, multiple × earnings, yield shift, SOTP segment drivers). */
export function defaultSensitivity(input: ValuationInput): SensitivityConfig | { unsupported: string } {
  const shift = (path: string, values: number[]) => ({ path, mode: "shift" as const, values });
  switch (input.method) {
    case "dcf_fcff":
    case "dcf_fcfe":
      if (input.assumptions.terminalMethod === "exit_multiple") return { x: shift("discountRate", range(0, 0.01)), y: shift("exitMultiple", range(0, 1)) };
      return { x: shift("discountRate", range(0, 0.01)), y: shift("terminalGrowth", range(0, 0.005)) };
    case "ddm":
      // Ke = Rf + β·ERP + premium, so shifting the premium shifts Ke one-for-one.
      return { x: shift("extraPremium", range(0, 0.01)), y: shift(input.assumptions.model === "gordon" ? "terminalGrowth" : "highGrowth", range(0, 0.01)) };
    case "residual_income":
      return { x: shift("roeShift", range(0, 0.02)), y: shift("extraPremium", range(0, 0.01)) };
    case "multiples":
      return { x: shift("targetPE", range(0, 2)), y: { path: "eps", mode: "pct", values: range(0, 0.1) } };
    case "bond":
      return { x: shift("yieldShiftBp", range(0, 50, 3)) };
    case "sotp": {
      const seg = input.assumptions.segments.find((s) => s.source.type === "model" && (s.source.valuation.method === "dcf_fcff" || s.source.valuation.method === "dcf_fcfe"));
      if (!seg) return { x: shift("holdingDiscount", range(0.1, 0.05).filter((v) => v >= 0)) };
      const k = segmentKey(seg);
      return { x: shift(`segments[${k}].model.extraPremium`, range(0, 0.01)), y: shift(`segments[${k}].model.terminalGrowth`, range(0, 0.005)) };
    }
  }
}

// ------------------------------------------------------------------ reverse

export interface ReverseResult {
  status: "solved" | "no_solution" | "ambiguous" | "unsupported" | "invalid";
  kind: "reverse_dcf" | "implied_metric";
  path: string;
  targetPrice: number | null;
  solution: number | null;
  modeledPrice: number | null;
  residual: number | null;
  iterations: number;
  bracket: [number, number] | null;
  roots: [number, number][];
  scan: { x: number; value: number | null }[];
  monotonic: ReturnType<typeof trend>;
  fixedInputs: string;
  messages: string[];
}

const DCF = ["dcf_fcff", "dcf_fcfe"];

/** Whether reverse DCF applies: standalone DCF, or SOTP solving a DCF segment's driver. */
export function reverseSupport(input: ValuationInput, path: string): string | null {
  if (DCF.includes(input.method)) return null;
  if (input.method === "sotp") {
    const m = /^segments\[([^\]]+)\]\.model\./.exec(path);
    if (!m) return "Reverse ของ SOTP ต้องแก้ตัวแปรของส่วนงานที่ใช้ DCF (segments[<id>].model.<ตัวแปร>) โดยคงส่วนอื่นไว้";
    const seg = input.assumptions.segments.find((s) => segmentKey(s) === m[1].toUpperCase());
    if (!seg || seg.source.type !== "model" || !DCF.includes(seg.source.valuation.method)) return `ส่วนงาน ${m[1]} ไม่ได้ใช้ DCF — ไม่ใช่ reverse DCF`;
    return null;
  }
  return "Reverse DCF ใช้ได้กับ FCFF / FCFE / SOTP ที่มีส่วนงาน DCF — วิธีอื่นดูตัวคูณโดยนัย (implied P/E, P/BV) ในผลหลัก ไม่เรียกว่า reverse DCF";
}

/**
 * Solve one driver so the modelled value equals the market price: scan the bounded interval, count
 * sign changes (0 = no solution, > 1 = ambiguous), then bisect the single bracket.
 */
export function reverseSolve(input: ValuationInput, cfg: ReverseConfig & { mode?: OverrideMode; scanPoints?: number; tolerance?: number }): ReverseResult {
  const mode = cfg.mode ?? "absolute";
  const target = cfg.targetPrice ?? (input.assumptions as { currentPrice?: number }).currentPrice ?? null;
  const out: ReverseResult = {
    status: "invalid",
    kind: "reverse_dcf",
    path: cfg.path,
    targetPrice: target,
    solution: null,
    modeledPrice: null,
    residual: null,
    iterations: 0,
    bracket: null,
    roots: [],
    scan: [],
    monotonic: "n/a",
    fixedInputs: "ตัวแปรอื่นทั้งหมดคงตามที่บันทึก — ผลลัพธ์เป็นเงื่อนไขของสมมติฐานเหล่านั้น ไม่ใช่การประมาณการเติบโตอิสระ",
    messages: [],
  };
  const unsupported = reverseSupport(input, cfg.path);
  if (unsupported) return { ...out, status: "unsupported", messages: [unsupported] };
  if (!(target != null && target > 0)) return { ...out, messages: ["ไม่มีราคาตลาดเป้าหมาย"] };
  if (!(cfg.hi > cfg.lo)) return { ...out, messages: ["ช่วงค้นหาต้องมี hi > lo"] };
  const virtual = virtualBase(input);
  const r = bracketSolve((x) => evalAt(input, { [cfg.path]: x }, { [cfg.path]: mode }, virtual).value, cfg.lo, cfg.hi, target, cfg);
  return { ...out, ...r };
}

/**
 * Bounded root search for f(x) = target: scan, count sign changes (0 = no solution, > 1 = ambiguous),
 * then bisect the single bracket. f returns null where the model is invalid.
 */
export function bracketSolve(f: (x: number) => number | null, lo0: number, hi0: number, target: number, opt: { scanPoints?: number; tolerance?: number } = {}) {
  const n = Math.max(11, Math.min(201, opt.scanPoints ?? 61));
  const scan = Array.from({ length: n }, (_, i) => {
    const x = lo0 + ((hi0 - lo0) * i) / (n - 1);
    return { x, value: f(x) };
  });
  const monotonic = trend(scan.map((s) => s.value));
  const base = { scan, monotonic, roots: [] as [number, number][], bracket: null as [number, number] | null, solution: null as number | null, modeledPrice: null as number | null, residual: null as number | null, iterations: 0 };
  const valid = scan.filter((s) => s.value != null) as { x: number; value: number }[];
  if (valid.length < 2) return { ...base, status: "no_solution" as const, messages: ["ช่วงที่ค้นหาคำนวณมูลค่าไม่ได้เกือบทั้งหมด (เช่น อัตราคิดลด ≤ g)"] };
  const roots: [number, number][] = [];
  for (let i = 1; i < valid.length; i++) {
    const a = valid[i - 1].value - target;
    const b = valid[i].value - target;
    if (a === 0) roots.push([valid[i - 1].x, valid[i - 1].x]);
    else if (a * b < 0) roots.push([valid[i - 1].x, valid[i].x]);
  }
  if (valid[valid.length - 1].value === target) roots.push([valid[valid.length - 1].x, valid[valid.length - 1].x]);
  const vmin = Math.min(...valid.map((v) => v.value));
  const vmax = Math.max(...valid.map((v) => v.value));
  if (!roots.length) return { ...base, roots, status: "no_solution" as const, messages: [`ในช่วง ${lo0}–${hi0} มูลค่าอยู่ระหว่าง ${vmin.toFixed(4)}–${vmax.toFixed(4)} ไม่ถึงราคา ${target} — ไม่มีคำตอบ (ระบบไม่สร้างค่าให้)`] };
  if (roots.length > 1) return { ...base, roots, status: "ambiguous" as const, messages: [`พบคำตอบได้ ${roots.length} ช่วง (${roots.map(([a, b]) => `${a.toFixed(4)}–${b.toFixed(4)}`).join(", ")}) — ความสัมพันธ์ไม่เป็นเอกภาพ จึงไม่เลือกให้`] };
  let [a, b] = roots[0];
  const bracket: [number, number] = [a, b];
  let fa = f(a)! - target;
  const tol = opt.tolerance ?? 1e-10;
  let it = 0;
  let x = a;
  while (a !== b && it < 200) {
    it++;
    x = (a + b) / 2;
    const fx = f(x);
    if (fx == null) return { ...base, roots, bracket, iterations: it, status: "invalid" as const, messages: [`ค่าที่ ${x} คำนวณไม่ได้ระหว่างค้นหา`] };
    const d = fx - target;
    if (Math.abs(d) <= tol * Math.max(1, Math.abs(target)) || (b - a) / 2 < 1e-13) break;
    if (fa * d < 0) b = x;
    else {
      a = x;
      fa = d;
    }
  }
  const mv = f(x)!;
  return {
    ...base,
    roots,
    bracket,
    status: "solved" as const,
    solution: x,
    modeledPrice: mv,
    residual: mv - target,
    iterations: it,
    messages: monotonic === "mixed" ? ["มูลค่าไม่เป็นเอกภาพในช่วงค้นหา แม้พบคำตอบเดียว — ตรวจความสมเหตุสมผล"] : [],
  };
}

/** Default driver and bounds for reverse DCF. */
export function defaultReverse(input: ValuationInput): ReverseConfig | { unsupported: string } {
  if (DCF.includes(input.method)) return { path: "growthShift", lo: -0.3, hi: 0.5 };
  if (input.method === "sotp") {
    const seg = input.assumptions.segments.find((s) => s.source.type === "model" && DCF.includes(s.source.valuation.method));
    if (seg) return { path: `segments[${segmentKey(seg)}].model.growthShift`, lo: -0.3, hi: 0.5 };
  }
  return { unsupported: reverseSupport(input, "") ?? "ไม่รองรับ" };
}
