/**
 * PR15 — editable plain-Thai explanation per scenario. Generated only from the inputs and results
 * (never invents a source); the analyst's own `noteTh` is kept and never overwritten automatically.
 */
import type { ValuationInput } from "./valuation-schemas";
import type { ScenarioSummary, ScenarioValuationResult } from "./valuation-scenarios";
import { VIRTUAL_DRIVERS } from "./valuation-scenarios";

const f2 = (n: number | null | undefined, d = 2) => (n == null || !Number.isFinite(n) ? "—" : n.toLocaleString("th-TH", { maximumFractionDigits: d, minimumFractionDigits: d }));
const pct = (n: number | null | undefined, d = 1) => (n == null || !Number.isFinite(n) ? "—" : `${(n * 100).toFixed(d)}%`);
const val = (v: number | string | null) => (typeof v === "number" ? (Math.abs(v) < 1.5 && v !== 0 && !Number.isInteger(v) ? `${(v * 100).toFixed(2)}%` : f2(v, 4)) : (v ?? "—"));

const METHOD_STEPS: Record<string, string> = {
  dcf_fcff: "ประมาณการรายได้ → EBIT → FCFF ทุกปีใหม่ตามสมมติฐานของ scenario → คิดลดด้วย WACC → บวกมูลค่าปลายทาง (PV) = EV → หักหนี้สุทธิและภาระอื่น = มูลค่าส่วนผู้ถือหุ้น → หารจำนวนหุ้น",
  dcf_fcfe: "ประมาณการ FCFE ทุกปี (หลังดอกเบี้ยและการกู้สุทธิ) ใหม่ตามสมมติฐาน → คิดลดด้วย Ke → บวกมูลค่าปลายทาง = มูลค่าส่วนผู้ถือหุ้น → หารจำนวนหุ้น (ไม่หักหนี้ซ้ำ)",
  ddm: "ปันผลต่อหุ้นตามอัตราเติบโตแต่ละช่วง → คิดลดด้วย Ke (Rf + β×ERP + ส่วนเพิ่ม) → รวมเป็นมูลค่าต่อหุ้น",
  residual_income: "BV ต้นปี × (ROE − Ke) = กำไรส่วนเกินรายปี → คิดลดด้วย Ke → บวก continuing value → บวก BV ปัจจุบัน = มูลค่าต่อหุ้น",
  multiples: "ตัวเลขพื้นฐาน (EPS / BV / EBITDA) × ตัวคูณเป้าหมาย → เฉลี่ยวิธีที่ให้ค่าบวก (EV/EBITDA หักหนี้สุทธิก่อนหารหุ้น)",
  bond: "กระแสเงินสดคูปองและเงินต้น → คิดลดด้วย YTM ของ scenario → ราคาสะอาดต่อ 100 (ไม่ใช่มูลค่าหุ้น)",
  sotp: "คำนวณมูลค่าแต่ละส่วนงานใหม่ด้วยโมเดลของตัวเอง → × สัดส่วนถือหุ้น และ FX → รวมส่วนงาน − holding discount + สินทรัพย์นอกการดำเนินงาน − หนี้สุทธิ − ส่วนน้อย − ภาระอื่น − รายการระหว่างกัน = มูลค่าส่วนผู้ถือหุ้น → หารจำนวนหุ้นบริษัทแม่",
};

function sources(input: ValuationInput): string[] {
  const a = input.assumptions as { inputMeta?: { asOf?: string; rfSource?: string; erpSource?: string; betaSource?: string }; currentPrice?: number };
  const out: string[] = [];
  const m = a.inputMeta;
  if (m?.asOf) out.push(`วันที่ข้อมูลตลาด: ${m.asOf}`);
  if (m?.rfSource) out.push(`Rf: ${m.rfSource}`);
  if (m?.erpSource) out.push(`ERP: ${m.erpSource}`);
  if (m?.betaSource) out.push(`Beta: ${m.betaSource}`);
  if (input.method === "sotp")
    for (const s of input.assumptions.segments) {
      const src = s.source;
      if (src.type === "market") out.push(`${s.name}: ราคาตลาด ${src.price} × ${src.shares} หุ้น${src.asOf ? ` ณ ${src.asOf}` : " (ไม่ระบุวันที่)"}`);
      if (src.type === "manual") out.push(`${s.name}: ${src.source}${src.asOf ? ` ณ ${src.asOf}` : ""}`);
      if (src.type === "multiple") out.push(`${s.name}: ตัวคูณ ${src.multiple}${src.source ? ` — ${src.source}` : " (ไม่ระบุแหล่งที่มา)"}`);
    }
  return out;
}

export function generateScenarioNoteTh(input: ValuationInput, summary: ScenarioSummary, s: ScenarioValuationResult): string {
  const unit = summary.valueKind === "bond_clean_price" ? "ต่อ 100 หน้าตั๋ว" : `${summary.currency} ต่อหุ้น`;
  const base = summary.baseCaseValue;
  const diff = s.valuePerShare != null && base ? s.valuePerShare / base - 1 : null;
  const changes = s.inputsResolved.map((r) => `• ${r.path}${VIRTUAL_DRIVERS[r.path.split(".").pop() ?? ""] ? ` (${VIRTUAL_DRIVERS[r.path.split(".").pop()!]})` : ""}: ${val(r.from)} → ${val(r.to)}`);
  const src = sources(input);
  const lines: string[] = [];
  lines.push("สรุปง่าย ๆ");
  if (s.valuePerShare == null) lines.push(`${s.name}: คำนวณมูลค่าไม่ได้ — ${s.errors.join("; ") || "ข้อมูลไม่ครบ"}`);
  else
    lines.push(
      `${s.name}: ${f2(s.valuePerShare)} ${unit} เทียบกรณีฐาน ${f2(base)} (${diff == null ? "—" : `${diff >= 0 ? "+" : ""}${pct(diff)}`})` +
        (changes.length ? " เพราะเปลี่ยนสมมติฐานต่อไปนี้" : " — ใช้สมมติฐานเดียวกับกรณีฐาน"),
    );
  lines.push(...changes);
  lines.push("", "ข้อมูลจริง");
  lines.push(...(src.length ? src.map((x) => `• ${x}`) : ["• ไม่มีแหล่งที่มาระบุในข้อมูลนำเข้า — ตัวเลขทั้งหมดถือเป็นสมมติฐานจนกว่าจะเพิ่มแหล่งที่มา"]));
  if (s.sources) lines.push(`• แหล่งข้อมูลเฉพาะ scenario: ${s.sources}`);
  if (summary.price != null) lines.push(`• ราคาตลาดที่ใช้เทียบ: ${f2(summary.price)} (ณ ${summary.asOf})`);
  lines.push("", "สมมติฐาน");
  lines.push(`• ความน่าจะเป็น ${pct(s.probability)} — ค่าที่ผู้ใช้กำหนด ไม่ใช่การประมาณทางสถิติ`);
  if (s.rationale) lines.push(`• เหตุผล: ${s.rationale}`);
  if (!changes.length) lines.push("• ไม่มีการปรับจากกรณีฐาน");
  lines.push("", "วิธีคำนวณ");
  lines.push(`• ${METHOD_STEPS[input.method] ?? ""}`);
  if (s.bridge) {
    lines.push(...s.bridge.segments.map((b) => `• ${b.name}: ${f2(b.attributable)} ${s.bridge!.valueUnit ?? ""}`.trimEnd()));
    lines.push(`• มูลค่าส่วนผู้ถือหุ้น ${f2(s.bridge.equityValue)} ${s.bridge.valueUnit ?? ""} (สะพานกระทบยอดต่าง ${f2(s.bridge.difference, 6)})`.trimEnd());
  }
  if (s.upsidePct != null) lines.push(`• Upside = มูลค่า ÷ ราคา − 1 = ${pct(s.upsidePct)}`);
  if (s.marginOfSafetyPct != null) lines.push(`• Margin of safety = (มูลค่า − ราคา) ÷ มูลค่า = ${pct(s.marginOfSafetyPct)}`);
  lines.push("", "ข้อจำกัด");
  const lim = [...summary.qualityReasons, ...s.warnings, ...s.errors];
  lines.push(...(lim.length ? lim.map((x) => `• ${x}`) : ["• ไม่พบคำเตือนจากโมเดล (ยังต้องตรวจความครบถ้วนของข้อมูลเอง)"]));
  lines.push("", "ความหมาย");
  lines.push("• มูลค่าถ่วงน้ำหนักความน่าจะเป็นคือค่าคาดหวังจากแบบจำลองและความน่าจะเป็นที่ผู้ใช้กำหนด ไม่ใช่คำสัญญาหรือความแน่นอน และไม่แทนที่มูลค่ากรณีฐาน");
  return lines.join("\n");
}

/** Lines only in a (−) or only in b (+) — enough to show what regeneration would change. */
export function lineDiff(a: string, b: string): { removed: string[]; added: string[] } {
  const A = a.split("\n");
  const B = b.split("\n");
  return { removed: A.filter((l) => l.trim() && !B.includes(l)), added: B.filter((l) => l.trim() && !A.includes(l)) };
}

/** Hash of the inputs that drive results (free-text notes excluded), to mark a saved snapshot stale. */
export function inputHash(assumptions: unknown): string {
  const strip = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(strip);
    if (x && typeof x === "object")
      return Object.fromEntries(
        Object.keys(x as object)
          .filter((k) => !["noteTh", "rationale", "sources"].includes(k))
          .sort()
          .map((k) => [k, strip((x as Record<string, unknown>)[k])]),
      );
    return x;
  };
  const s = JSON.stringify(strip(assumptions));
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
