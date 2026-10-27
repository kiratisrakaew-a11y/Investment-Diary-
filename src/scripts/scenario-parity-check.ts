/**
 * PR15 / PR16 tests 4 and 9 against the real database and a running server:
 * - a legacy SOTP record (PLANB #31 shape: segment DCF Bear/Base/Bull, no scenarioSet) saves and
 *   re-saves with the same base value and no weighted value;
 * - invalid probabilities refuse the save and leave the stored record unchanged;
 * - a from_segments save stores base and weighted values separately, plus generated Thai notes;
 * - an analyst's noteTh survives the round trip;
 * - editor (service), REST and MCP return the same numbers; REST and MCP refuse requests without the key.
 * Rows are titled "TEST-LOCAL scenario" and always deleted. Run: npm run check:scenario-parity [baseUrl]
 */
import "dotenv/config";
import { DEFAULT_DCF, type DcfAssumptions } from "../lib/finance/valuation";
import { evaluate, valuationInput, type ValuationInput } from "../lib/valuation-schemas";
import { runScenarios } from "../lib/valuation-scenarios";
import { analyzeValuation } from "../lib/valuation-analyze";
import { deleteValuation, getValuation, listValuations, saveValuation } from "../server/services/valuations";

const BASE = process.argv[2] ?? "http://localhost:3101";
const KEY = process.env.API_KEY ?? "";
const SYMBOL = "TLC-SCEN";
const TITLE = "TEST-LOCAL scenario";

const core: DcfAssumptions = {
  ...DEFAULT_DCF,
  revenue0: 8_000,
  debt: 0,
  cash: 0,
  otherClaims: 0,
  sharesOutstanding: 4_000,
  targetDebtWeight: 0.2,
  scenarios: [
    { name: "Bear", probability: 0.25, overrides: { growthStart: 0.02, growthEnd: 0.02 } },
    { name: "Base", probability: 0.5, overrides: {} },
    { name: "Bull", probability: 0.25, overrides: { growthStart: 0.1, growthEnd: 0.06 } },
  ],
};
const sotp = (extra: Record<string, unknown> = {}): ValuationInput =>
  valuationInput.parse({
    method: "sotp",
    assumptions: {
      sharesOutstanding: 4_000,
      currentPrice: 5,
      netDebt: 1_500,
      minorityInterest: 120,
      valueUnit: "ล้านบาท",
      inputMeta: { asOf: "2026-10-27" },
      segments: [
        { id: "core", name: "OOH + Engagement", role: "division", source: { type: "model", valuation: { method: "dcf_fcff", assumptions: core } } },
        { id: "com7", entity: "COM7", name: "COM7 stake", role: "investment", ownership: 0.2, source: { type: "market", price: 25, shares: 2_400, asOf: "2026-10-24" } },
      ],
      ...extra,
    },
  });

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const close = (a: number | null | undefined, b: number | null | undefined, tol = 1e-9) => a != null && b != null && Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

async function http(path: string, body: unknown, auth = true) {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(auth ? { authorization: `Bearer ${KEY}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: r.status === 200 ? await r.json() : null };
}
async function mcp(tool: string, args: unknown, auth = true) {
  const r = await http("/api/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }, auth);
  if (r.status !== 200) return { status: r.status, data: null };
  const text = (r.json as { result?: { content?: { text: string }[] } }).result?.content?.[0]?.text ?? "null";
  return { status: r.status, data: JSON.parse(text) };
}

async function main() {
  const ids: number[] = [];
  try {
    // 1. Legacy record (#31 shape): base only, unchanged by re-save.
    const legacy = sotp();
    const base = evaluate(legacy).value;
    const a = await saveValuation({ symbol: SYMBOL, title: TITLE, valuation: legacy });
    ids.push(a.valuation.id);
    const r1 = (await getValuation(a.valuation.id))!;
    check("legacy SOTP saves the base value", close(r1.intrinsicValue, base), `${r1.intrinsicValue}`);
    check("legacy SOTP has no weighted value", !(r1.result as Record<string, unknown>).scenarioAnalysis);
    check("legacy SOTP keeps MINORITY_DOUBLE_COUNT warning", JSON.stringify(r1.result).includes("ส่วนน้อย"));
    await saveValuation({ id: r1.id, symbol: SYMBOL, title: TITLE, valuation: valuationInput.parse({ method: r1.method, assumptions: r1.assumptions }) });
    const r1b = (await getValuation(r1.id))!;
    check("re-save of an unchanged legacy record keeps value and assumptions", r1b.intrinsicValue === r1.intrinsicValue && JSON.stringify(r1b.assumptions) === JSON.stringify(r1.assumptions));

    // 2. Invalid probabilities refuse the save; the record is untouched.
    let refused = false;
    try {
      await saveValuation({ id: r1.id, symbol: SYMBOL, title: TITLE, valuation: sotp({ scenarioSet: { scenarios: [{ id: "bear", name: "Bear", probability: 0.25 }, { id: "base", name: "Base", probability: 0.5 }, { id: "bull", name: "Bull", probability: 0.2 }] } }) });
    } catch (e) {
      refused = /ไม่ผ่านการตรวจ/.test((e as Error).message);
    }
    const r1c = (await getValuation(r1.id))!;
    check("25/50/20 is refused on save", refused);
    check("refused save leaves the record unchanged", JSON.stringify(r1c.assumptions) === JSON.stringify(r1.assumptions) && r1c.intrinsicValue === r1.intrinsicValue);

    // 3. from_segments with an analyst note on Bear.
    const withScen = sotp({ scenarioSet: { mode: "from_segments", scenarios: [{ id: "bear", name: "Bear", probability: 0.25, noteTh: "บันทึกของนักวิเคราะห์: ทดสอบ" }] } });
    const expected = runScenarios(withScen);
    const b = await saveValuation({ symbol: SYMBOL, title: TITLE, valuation: withScen });
    ids.push(b.valuation.id);
    const r2 = (await getValuation(b.valuation.id))!;
    const snap = (r2.result as { scenarioAnalysis?: { baseCaseValue: number; probabilityWeightedValue: number; qualityStatus: string; scenarios: { generatedNoteTh: string }[] }; inputHash?: string }).scenarioAnalysis;
    check("intrinsicValue stays the base value", close(r2.intrinsicValue, base));
    check("weighted value stored separately", close(snap?.probabilityWeightedValue, expected.probabilityWeightedValue), `${snap?.probabilityWeightedValue} vs base ${snap?.baseCaseValue}`);
    check("quality preliminary (minority double count)", snap?.qualityStatus === "preliminary");
    check("generated Thai notes have the six sections", !!snap?.scenarios.every((s) => ["สรุปง่าย ๆ", "ข้อมูลจริง", "สมมติฐาน", "วิธีคำนวณ", "ข้อจำกัด", "ความหมาย"].every((h) => s.generatedNoteTh.includes(h))));
    const savedNote = (r2.assumptions as { scenarioSet?: { scenarios: { id: string; noteTh?: string }[] } }).scenarioSet?.scenarios.find((s) => s.id === "bear")?.noteTh;
    check("analyst noteTh survives the round trip", savedNote === "บันทึกของนักวิเคราะห์: ทดสอบ");
    check("inputHash stored", typeof (r2.result as { inputHash?: string }).inputHash === "string");

    // 4. Parity: service vs REST vs MCP, and auth.
    const svc = analyzeValuation({ valuation: withScen, sensitivity: "default", reverse: "default" });
    const rest = await http("/api/v1/valuation/analyze", { valuation: withScen, sensitivity: "default", reverse: "default" });
    const restNoKey = await http("/api/v1/valuation/analyze", { valuation: withScen }, false);
    const ev = await http("/api/v1/valuation/evaluate", withScen);
    const m = await mcp("analyze_valuation", { valuation: withScen, sensitivity: "default", reverse: "default" });
    const mv = await mcp("value_security", { valuation: withScen });
    const mNoKey = await mcp("analyze_valuation", { valuation: withScen }, false);
    type A = { scenarioAnalysis: { probabilityWeightedValue: number; baseCaseValue: number; asOf: string }; reverse: { solution: number }; sensitivity: { basePointValue: number }; generatedNotesTh: Record<string, string> };
    const rj = rest.json as A | null;
    const mj = m.data as A | null;
    check("REST without key → 401", restNoKey.status === 401, String(restNoKey.status));
    check("MCP without key → 401", mNoKey.status === 401, String(mNoKey.status));
    check("REST analyze weighted = service", close(rj?.scenarioAnalysis.probabilityWeightedValue, svc.scenarioAnalysis!.probabilityWeightedValue));
    check("MCP analyze weighted = service", close(mj?.scenarioAnalysis.probabilityWeightedValue, svc.scenarioAnalysis!.probabilityWeightedValue));
    check("REST / MCP reverse and sensitivity = service", close(rj?.reverse.solution, (svc.reverse as { solution: number }).solution) && close(mj?.sensitivity.basePointValue, (svc.sensitivity as { basePointValue: number }).basePointValue));
    check("REST / MCP as-of and Thai notes = service", rj?.scenarioAnalysis.asOf === svc.scenarioAnalysis!.asOf && mj?.generatedNotesTh.bear === svc.generatedNotesTh.bear);
    check("REST evaluate keeps value = base and adds scenarioAnalysis", close((ev.json as { value: number }).value, base) && close((ev.json as A).scenarioAnalysis.probabilityWeightedValue, svc.scenarioAnalysis!.probabilityWeightedValue));
    check("MCP value_security = REST evaluate", close((mv.data as { value: number }).value, base) && close((mv.data as A).scenarioAnalysis.probabilityWeightedValue, svc.scenarioAnalysis!.probabilityWeightedValue));
  } finally {
    for (const id of ids) await deleteValuation(id);
    const left = (await listValuations({ symbol: SYMBOL })).filter((v) => v.title === TITLE);
    for (const v of left) await deleteValuation(v.id);
    console.log(`cleaned up ${ids.length} test valuations`);
  }
  console.log(failures ? `${failures} FAILED` : "ALL PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
