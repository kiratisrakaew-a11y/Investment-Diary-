/**
 * Analyst consensus end to end on the real database: service (with a stubbed Yahoo), the MCP server
 * (in-memory client), asset rename / cascade delete, and REST / MCP over HTTP when the server runs.
 * Uses TEST-LOCAL symbols TLC-CONS* only and always removes them.
 * Run: npm run check:consensus [baseUrl]
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { getDb, schema } from "../db";
import { createMcpServer } from "../server/mcp";
import { consensusSummary, latestConsensusFor, recordConsensus, refreshConsensusFromYahoo, type RefreshDeps } from "../server/services/consensus";
import { editAssetBasics } from "../server/services/assets";
import { assetDependencies, changeAssetLifecycle } from "../server/services/asset-lifecycle";
import { today } from "../lib/validation";

const BASE = process.argv[2] ?? "http://localhost:3101";
const KEY = process.env.API_KEY ?? "";
const db = getDb();
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const code = async (p: Promise<unknown>) =>
  p.then(
    () => "OK",
    (e: Error & { code?: string; name?: string }) => e.code ?? (e.name === "ZodError" ? "VALIDATION_ERROR" : `ERR:${e.message.slice(0, 60)}`),
  );
const rows = async (prefix = "TLC-CONS%") => db.select().from(schema.analystConsensus).where(like(schema.analystConsensus.symbol, prefix));

async function cleanup() {
  await db.delete(schema.analystConsensus).where(like(schema.analystConsensus.symbol, "TLC-CONS%"));
  const a = await db.select({ id: schema.assets.id }).from(schema.assets).where(like(schema.assets.symbol, "TLC-CONS%"));
  for (const { id } of a) {
    await db.delete(schema.prices).where(eq(schema.prices.assetId, id));
    await db.delete(schema.assets).where(eq(schema.assets.id, id));
  }
  await db.delete(schema.assetLifecycleEvents).where(like(schema.assetLifecycleEvents.symbol, "TLC-CONS%"));
  return a.length;
}

async function fingerprint() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const h = async (t: any) => createHash("sha256").update(JSON.stringify(await db.select().from(t).orderBy(sql`1`))).digest("hex");
  return { prices: await h(schema.prices), transactions: await h(schema.transactions), valuations: await h(schema.valuations), statements: await h(schema.financialStatements) };
}

const stub = (result: Awaited<ReturnType<RefreshDeps["fetch"]>> | Error): RefreshDeps => ({
  yahooSymbol: async (s) => `${s}.BK`,
  fetch: async () => {
    if (result instanceof Error) throw result;
    return result;
  },
  today,
});
const figures = (mean: number) => ({ currency: "THB", targetMean: mean, targetMedian: mean - 1, targetHigh: mean + 5, targetLow: mean - 6, analysts: 11, recommendationKey: "buy" as const, recommendationMean: 2.2, priceAtFetch: 40 });

async function main() {
  await cleanup();
  const before = await fingerprint();
  const T = today();
  try {
    const [asset] = await db.insert(schema.assets).values({ symbol: "TLC-CONS", name: "TEST-LOCAL consensus (sample)", assetClass: "thai_stock" }).returning();
    await db.insert(schema.prices).values({ assetId: asset.id, date: "2026-11-01", close: 40 });

    // Yahoo refresh (stubbed): found → today's row; same-day re-fetch replaces it.
    const r1 = await refreshConsensusFromYahoo("tlc-cons", stub({ ok: true, figures: figures(44) }));
    const r2 = await refreshConsensusFromYahoo("TLC-CONS", stub({ ok: true, figures: figures(46) }));
    const y = (await rows()).filter((r) => r.source === "yahoo");
    check("refresh stores today's Yahoo row; same-day re-fetch replaces it", r1.status === "UPDATED" && r2.status === "UPDATED" && y.length === 1 && y[0].targetMean === 46 && y[0].asOf === T && y[0].yahooSymbol === "TLC-CONS.BK");

    // No coverage / failure: nothing written, latest found returned.
    const n1 = await refreshConsensusFromYahoo("TLC-CONS", stub({ ok: false, code: "NO_COVERAGE", message: "Yahoo ไม่มีราคาเป้าหมาย" }));
    const n2 = await refreshConsensusFromYahoo("TLC-CONS", stub(new Error("network down")));
    const after = await rows();
    check("NO_COVERAGE / FETCH_FAILED write nothing and keep the latest found", n1.status === "NO_COVERAGE" && n2.status === "FETCH_FAILED" && after.length === 1 && n1.latest?.targetMean === 46 && n2.latest?.targetMean === 46 && /ยังใช้ข้อมูลล่าสุด/.test(n1.message));

    // Manual entries: older date does not win; same date stored later wins.
    await recordConsensus({ symbol: "TLC-CONS", asOf: "2026-01-15", sourceNote: "บล.ตัวอย่าง (sample)", targetMean: 38 }, "manual");
    let latest = (await latestConsensusFor(["TLC-CONS"])).get("TLC-CONS");
    check("older manual entry does not replace the latest", latest?.source === "yahoo" && latest.targetMean === 46);
    await recordConsensus({ symbol: "TLC-CONS", asOf: T, sourceNote: "บล.ตัวอย่าง (sample)", targetMean: 50, targetLow: 41, targetHigh: 55, analysts: 3 }, "manual");
    latest = (await latestConsensusFor(["TLC-CONS"])).get("TLC-CONS");
    check("same-date entry stored later is the latest found", latest?.source === "manual" && latest.targetMean === 50 && latest.currency === "THB");
    const sum = await consensusSummary("tlc-cons", { history: true });
    check("summary: upside vs last stored close, history newest first", sum.view != null && Math.abs(sum.view.upside! - (50 / 40 - 1)) < 1e-12 && sum.price === 40 && sum.history!.length === 3 && sum.history![0].asOf === T);

    // Validation.
    const fut = new Date(Date.parse(T) + 3 * 86_400_000).toISOString().slice(0, 10);
    check("future date refused", (await code(recordConsensus({ symbol: "TLC-CONS", asOf: fut, sourceNote: "x", targetMean: 40 }, "manual"))) === "VALIDATION_ERROR");
    check("missing target / inverted range refused", (await code(recordConsensus({ symbol: "TLC-CONS", asOf: T, sourceNote: "x" }, "manual"))) === "VALIDATION_ERROR" && (await code(recordConsensus({ symbol: "TLC-CONS", asOf: T, sourceNote: "x", targetMean: 40, targetLow: 50, targetHigh: 45 }, "manual"))) === "VALIDATION_ERROR");

    // MCP server (in-memory): the same service through the tools Claude / ChatGPT see.
    const client = new Client({ name: "check", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([createMcpServer().connect(a), client.connect(b)]);
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: args });
      const c = r.content as { text: string }[];
      return r.isError ? { ok: false as const, text: c[0].text, code: c[1] ? (JSON.parse(c[1].text) as { code: string }).code : c[0].text.match(/\[([A-Z_]+)\]/)?.[1] ?? "SDK" } : { ok: true as const, data: JSON.parse(c[0].text) };
    };
    const g = await call("get_analyst_consensus", { symbols: ["tlc-cons"], history: true });
    check("MCP get_analyst_consensus", g.ok && g.data.results[0].latest.targetMean === 50 && g.data.results[0].history.length === 3 && Math.abs(g.data.results[0].view.upside - 0.25) < 1e-12);
    const rec = await call("record_analyst_consensus", { symbol: "TLC-CONS", asOf: "2026-06-30", sourceNote: "SET consensus (sample)", targetMedian: 42 });
    check("MCP record_analyst_consensus stores source mcp", rec.ok && rec.data.source === "mcp" && rec.data.targetMedian === 42);
    const bad = await call("record_analyst_consensus", { symbol: "TLC-CONS", asOf: "2026-06-30", sourceNote: "x" });
    const noSrc = await call("record_analyst_consensus", { symbol: "TLC-CONS", asOf: "2026-06-30", targetMean: 40 });
    check("MCP record refuses missing target / missing source", !bad.ok && bad.code === "VALIDATION_ERROR" && !noSrc.ok, `${!bad.ok && bad.code} ${!noSrc.ok && noSrc.code}`);
    const noConfirm = await call("delete_analyst_consensus", { id: rec.ok ? rec.data.id : 0, symbol: "TLC-CONS" });
    const wrongSym = await call("delete_analyst_consensus", { id: rec.ok ? rec.data.id : 0, symbol: "PTT", confirmDelete: true });
    const del = await call("delete_analyst_consensus", { id: rec.ok ? rec.data.id : 0, symbol: "TLC-CONS", confirmDelete: true });
    check("MCP delete needs confirmDelete and the right symbol", !noConfirm.ok && !wrongSym.ok && wrongSym.code === "CONSENSUS_NOT_FOUND" && del.ok && (await rows()).length === 3);
    const lv = await call("list_valuations", { symbol: "TLC-CONS" });
    check("MCP list_valuations carries analystConsensus separately", lv.ok && Array.isArray(lv.data.valuations) && lv.data.analystConsensus["TLC-CONS"]?.targetMean === 50);
    const live = await call("refresh_analyst_consensus", { symbol: "TLC-CONS" });
    check("MCP refresh against live Yahoo never overwrites on failure", live.ok && ["UPDATED", "NO_COVERAGE", "FETCH_FAILED"].includes(live.data.status) && (live.data.status === "UPDATED" || (await rows()).length === 3), live.ok ? `${live.data.status}: ${live.data.message.slice(0, 80)}` : live.text);
    await client.close();
    // Remove a possible live Yahoo row so the counts below are deterministic.
    await db.delete(schema.analystConsensus).where(sql`${schema.analystConsensus.symbol} = 'TLC-CONS' and ${schema.analystConsensus.source} = 'yahoo' and ${schema.analystConsensus.yahooSymbol} <> 'TLC-CONS.BK'`);

    // Asset rename: rows follow; renaming onto a symbol that already has consensus rows is refused.
    await recordConsensus({ symbol: "TLC-CONSX", asOf: "2026-05-01", sourceNote: "sample", targetMean: 10 }, "manual");
    const clash = await editAssetBasics(asset.id, { symbol: "TLC-CONSX", name: asset.name, assetClass: "thai_stock", currency: "THB", priceSource: "manual" }).then(() => "OK", (e: Error) => e.message);
    check("rename onto a symbol with consensus rows refused", /ราคาเป้าหมายนักวิเคราะห์/.test(clash), clash.slice(0, 80));
    await editAssetBasics(asset.id, { symbol: "TLC-CONS.BK", name: asset.name, assetClass: "thai_stock", currency: "THB", priceSource: "manual" });
    const moved = await rows("TLC-CONS.BK");
    check("rename moves consensus rows to the new symbol", moved.length === 3 && (await rows("TLC-CONS")).length === 0);
    const deps = await assetDependencies(asset.id);
    check("dependencies count consensus rows", deps?.analystConsensus === 3);

    // Cascade delete removes them; other symbols' rows stay.
    const gone = await changeAssetLifecycle({ assetId: asset.id, action: "delete", confirmSymbol: "TLC-CONS.BK", cascade: true });
    check("cascade delete removes consensus rows, others kept", gone.status === "DELETED" && (await rows("TLC-CONS.BK")).length === 0 && (await rows("TLC-CONSX")).length === 1);

    // HTTP (REST for ChatGPT Actions, MCP endpoint, OpenAPI) when the server runs.
    const up = await fetch(`${BASE}/login`).then((r) => r.ok).catch(() => false);
    if (!up) console.log("SKIP  HTTP checks — server not running at", BASE);
    else {
      const noKey = await fetch(`${BASE}/api/v1/valuation/consensus?symbols=TLC-CONSX`);
      check("REST without key → 401", noKey.status === 401);
      if (!KEY) console.log("SKIP  authorized HTTP checks — API_KEY not set");
      else {
        const h = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };
        const g2 = await fetch(`${BASE}/api/v1/valuation/consensus?symbols=TLC-CONSX&history=1`, { headers: h });
        const gj = (await g2.json()) as { results: { latest: { targetMean: number } | null }[] };
        check("REST GET consensus", g2.status === 200 && gj.results[0].latest?.targetMean === 10);
        const p = await fetch(`${BASE}/api/v1/valuation/consensus`, { method: "POST", headers: h, body: JSON.stringify({ symbol: "TLC-CONSX", asOf: "2026-05-02", sourceNote: "sample", targetMean: 0 }) });
        check("REST POST invalid → 400", p.status === 400);
        const rf = await fetch(`${BASE}/api/v1/valuation/consensus/refresh`, { method: "POST", headers: h, body: JSON.stringify({ symbol: "TLC-CONSX" }) });
        const rj = (await rf.json()) as { status: string };
        check("REST refresh returns a status without throwing", rf.status === 200 && ["UPDATED", "NO_COVERAGE", "FETCH_FAILED"].includes(rj.status), rj.status);
        await db.delete(schema.analystConsensus).where(sql`${schema.analystConsensus.symbol} = 'TLC-CONSX' and ${schema.analystConsensus.source} = 'yahoo'`);
        const tl = await fetch(`${BASE}/api/mcp`, { method: "POST", headers: { ...h, accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
        const tt = await tl.text();
        check("/api/mcp tools/list has the 4 consensus tools", ["get_analyst_consensus", "refresh_analyst_consensus", "record_analyst_consensus", "delete_analyst_consensus"].every((n) => tt.includes(`"${n}"`)));
        const oa = await (await fetch(`${BASE}/api/openapi.json`, { headers: h })).text();
        check("OpenAPI has the consensus operations (and existing ones)", ["getAnalystConsensus", "recordAnalystConsensus", "refreshAnalystConsensus", "backtestPortfolio", "listValuations"].every((n) => oa.includes(`"${n}"`)));
      }
    }

    const fp = await fingerprint();
    for (const k of Object.keys(before) as (keyof typeof before)[]) check(`${k} unchanged`, before[k] === fp[k]);
  } finally {
    console.log(`cleaned up ${await cleanup()} test assets and their consensus rows`);
  }
  console.log(failures ? `${failures} FAILED` : "ALL PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await cleanup().catch(() => 0);
  process.exit(1);
});
