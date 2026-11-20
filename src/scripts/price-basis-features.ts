/**
 * PRICE_BASIS_BENCHMARK_SPEC 6.1 / 6.4 / 6.5 feature checks (extended phase by phase): no new option ==
 * explicit defaults; total_return never drops an asset silently; MCP == REST == service for the same params.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../server/mcp";
import { loadUniverse, optimizePortfolio } from "../server/services/optimizer";
import { stressTestPortfolio } from "../server/services/stress";
import { getMptAnalysis } from "../server/services/portfolio";
import { editorDefaults } from "../server/services/valuation-defaults";
import { importPrices } from "../server/services/price-sync";
import { getSettings, saveSettings } from "../server/services/settings";
import { getDb, schema } from "../db";
import { eq } from "drizzle-orm";

type Check = (name: string, ok: boolean, detail?: string) => void;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Drop fields that legitimately differ between two runs (timestamps). */
const stable = (o: unknown) =>
  JSON.parse(JSON.stringify(o, (k, v) => (k === "asOf" || k === "generatedAt" ? undefined : v)));
/** Same result apart from where the basis came from (request vs Settings). */
const noSource = (o: unknown) =>
  stable(JSON.parse(JSON.stringify(o, (k, v) => (k === "requested" || k === "source" ? undefined : v))));

let client: Client;
async function mcp(name: string, args: Record<string, unknown>) {
  const r = await client.callTool({ name, arguments: args });
  const c = r.content as { text: string }[];
  if (!r.isError) return { ok: true as const, data: JSON.parse(c[0].text) };
  return { ok: false as const, code: c[0].text.match(/\[([A-Z_]+)\]/)?.[1] ?? "ERROR", text: c[0].text };
}

async function rest(path: string, init?: { method?: string; body?: unknown }) {
  const file = `../app/api/v1/${path.split("?")[0]}/route`;
  const mod = (await import(file)) as Record<string, (req: Request, ctx: unknown) => Promise<Response>>;
  const method = init?.method ?? "GET";
  const res = await mod[method](
    new Request(`http://local/api/v1/${path}`, {
      method,
      headers: { authorization: `Bearer ${process.env.API_KEY}`, "content-type": "application/json" },
      ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
    }),
    { params: Promise.resolve({}) },
  );
  return { status: res.status, data: await res.json() };
}

export async function featureChecks(check: Check, days: string[]) {
  // REST handlers need an API key; a throwaway one for this process only.
  process.env.API_KEY ??= `check-${Math.random().toString(36).slice(2)}`;
  const server = createMcpServer();
  client = new Client({ name: "check", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const settings = await getSettings();

  // A total-return index covering the whole local history (TEST-LOCAL).
  await importPrices({
    target: "benchmark",
    kind: "total_return",
    rows: days.map((d, i) => ({ symbol: "PBT-TRI3", date: d, close: 1000 * (1 + 0.0002 * i + 0.01 * Math.sin(i / 7)) })),
  });

  // A dividend payer without adjusted closes (TEST-LOCAL): total_return must list it as excluded, with the reason.
  const db = getDb();
  const [D] = await db
    .insert(schema.assets)
    .values({ symbol: "PBT-D", name: "TEST-LOCAL PBT-D (sample)", assetClass: "thai_stock", priceSource: "manual" })
    .returning();
  await db.insert(schema.prices).values(days.map((d, i) => ({ assetId: D.id, date: d, close: 30 + Math.cos(i / 11) })));
  await db.insert(schema.dividendEvents).values({
    symbol: "PBT-D",
    assetId: D.id,
    exDate: days[days.length - 100],
    dividendPerShare: 0.5,
    source: "test",
    sourceEventId: "PBT-D-1",
  });

  try {
    // ---------------------------------------------------------------- F3 universe / optimize
    const u0 = await loadUniverse(undefined, undefined, { withSeries: true });
    const u1 = await loadUniverse(undefined, undefined, {
      withSeries: true,
      returnBasis: "price_return",
      benchmark: "default",
    });
    check("6.1 F3 universe: no option == explicit price_return + default", same(noSource(u0), noSource(u1)));
    check(
      "F3 universe reports priceBasis + benchmark",
      u0.priceBasis?.used === "price_return" &&
        u0.priceBasis.source === "settings" &&
        u0.benchmark?.symbol === settings.benchmarkSymbol &&
        u0.benchmark.source === "default",
    );
    const uTr = await loadUniverse(undefined, undefined, { returnBasis: "total_return" });
    check("B1: total_return + default index → kind-mismatch warning", !!uTr.benchmark?.warning);
    const uAuto = await loadUniverse(undefined, undefined, { returnBasis: "total_return", benchmark: "auto" });
    check(
      "F3 total_return + auto → the TRI, no warning",
      uAuto.benchmark?.symbol === "PBT-TRI3" && uAuto.benchmark.warning === null,
      JSON.stringify(uAuto.benchmark),
    );
    const symbolsOf = (u: typeof u0) => [...u.assets.map((x) => x.symbol), ...u.skipped.map((x) => x.symbol)].sort();
    check(
      "6.4 total_return keeps every asset accounted for (used or skipped with a reason)",
      same(symbolsOf(u0), symbolsOf(uTr)) &&
        uTr.skipped.every((x) => x.reason.length > 0) &&
        (uTr.priceBasis?.excluded ?? []).every((x) => uTr.skipped.some((s) => s.symbol === x.symbol)) &&
        (uTr.priceBasis?.fallback ?? []).every((x) => x.reason.length > 0),
      JSON.stringify(uTr.priceBasis),
    );
    check(
      "6.4 dividend payer without adj_close → priceBasis.excluded with the reason (not dropped silently)",
      uTr.priceBasis?.excluded.some((x) => x.symbol === "PBT-D" && /ปันผล/.test(x.reason)) === true &&
        u0.assets.some((x) => x.symbol === "PBT-D"),
    );
    const explicit = await loadUniverse(undefined, undefined, { benchmark: settings.benchmarkSymbol });
    check(
      "F3 explicit Settings index == default numbers (source explicit)",
      same(explicit.assets.map((x) => x.beta), u0.assets.map((x) => x.beta)) && explicit.benchmark?.source === "explicit",
    );

    // Settings default flows through (request → Settings → feature default).
    await saveSettings({ riskFreeRate: settings.riskFreeRate, benchmarkSymbol: settings.benchmarkSymbol, defaultReturnBasis: "total_return", defaultBenchmark: "auto" });
    const uS = await loadUniverse(undefined, undefined, {});
    check(
      "D3 Settings defaults apply when the request has none",
      uS.priceBasis?.used === "total_return" && uS.priceBasis.source === "settings" && uS.benchmark?.symbol === "PBT-TRI3",
    );
    const uR = await loadUniverse(undefined, undefined, { returnBasis: "price_return", benchmark: "default" });
    check("D3 request overrides Settings", uR.priceBasis?.source === "request" && same(uR.assets, u0.assets));
    await saveSettings({ riskFreeRate: settings.riskFreeRate, benchmarkSymbol: settings.benchmarkSymbol, defaultReturnBasis: settings.defaultReturnBasis, defaultBenchmark: settings.defaultBenchmark });

    // 6.5 MCP == REST == service (optimize, total_return + auto).
    const params = { returnBasis: "total_return", benchmark: "auto", returnMethod: "capm" } as const;
    const svc = await optimizePortfolio(params);
    const viaMcp = await mcp("optimize_portfolio", params);
    const viaRest = await rest("portfolio/optimize", { method: "POST", body: params });
    check(
      "6.5 optimize_portfolio: MCP == REST == service",
      viaMcp.ok && viaRest.status === 200 && same(stable(viaMcp.data), stable(svc)) && same(stable(viaRest.data), stable(svc)),
      viaMcp.ok ? "" : viaMcp.text,
    );
    const nf = await mcp("optimize_portfolio", { benchmark: "PBT-NOPE" });
    const nfRest = await rest("portfolio/optimize", { method: "POST", body: { benchmark: "PBT-NOPE" } });
    check(
      "BENCHMARK_NOT_FOUND through MCP and REST",
      !nf.ok && nf.code === "BENCHMARK_NOT_FOUND" && nfRest.status === 400 && nfRest.data.code === "BENCHMARK_NOT_FOUND" && nfRest.data.available.includes("PBT-TRI3"),
    );

    // ---------------------------------------------------------------- F6 stress
    const s0 = await stressTestPortfolio({});
    const s1 = await stressTestPortfolio({ returnBasis: "price_return", benchmark: "default" });
    check("6.1 F6 stress: no option == explicit defaults", same(noSource(s0), noSource(s1)));
    const sT = await stressTestPortfolio({ returnBasis: "total_return", benchmark: "PBT-TRI3" });
    const sM = await mcp("stress_test_portfolio", { returnBasis: "total_return", benchmark: "PBT-TRI3" });
    const sR = await rest("portfolio/stress", { method: "POST", body: { returnBasis: "total_return", benchmark: "PBT-TRI3" } });
    check(
      "F6 β assumption names the basis and index; MCP == REST == service",
      (sT.assumptions.beta.includes("PBT-TRI3 (ผลตอบแทนรวม)") || sT.assumptions.beta.startsWith("ไม่มี β")) &&
        sM.ok && same(stable(sM.data), stable(sT)) && same(stable(sR.data), stable(sT)),
      sT.assumptions.beta,
    );

    // ---------------------------------------------------------------- F2 portfolio MPT
    const m0 = await getMptAnalysis();
    const m1 = await getMptAnalysis(undefined, undefined, { returnBasis: "price_return" });
    const strip = (m: typeof m0) => ({ ...m, priceBasis: undefined, cloud: undefined });
    check("6.1 F2 MPT: no option == explicit price_return (numbers)", same(strip(m0), strip(m1)) && m1.priceBasis.source === "request");
    const mT = await getMptAnalysis(undefined, undefined, { returnBasis: "total_return" });
    const mM = await mcp("get_portfolio_optimization", { returnBasis: "total_return" });
    const mR = await rest("portfolio/mpt?returnBasis=total_return");
    const noCloud = (m: Record<string, unknown>) => ({ ...m, cloud: undefined, frontier: undefined });
    check(
      "F2 total_return: priceBasis reported; MCP == REST == service",
      mT.priceBasis.used === "total_return" &&
        mM.ok && same(noCloud(mM.data), noCloud(mT as never)) && same(noCloud(mR.data), noCloud(mT as never)),
    );
    check(
      "6.4 F2 total_return: every excluded holding has a reason and is in skipped",
      mT.priceBasis.excluded.every((x) => x.reason && mT.skipped.includes(x.symbol)),
    );

    // ---------------------------------------------------------------- F9 valuation β
    const held = u0.assets.find((x) => x.beta != null)?.symbol;
    if (held) {
      const e0 = await editorDefaults(held);
      const e1 = await editorDefaults(held, { returnBasis: "price_return", benchmark: "default" });
      check("6.1 F9 β: no option == explicit defaults", e0.defaults.beta === e1.defaults.beta && e0.defaults.inputMeta?.betaSource === e1.defaults.inputMeta?.betaSource);
      const eT = await editorDefaults(held, { returnBasis: "price_return", benchmark: "PBT-TRI3" });
      check(
        "F9 β source records basis, index and period",
        /PBT-TRI3/.test(eT.defaults.inputMeta?.betaSource ?? "") && /ราคา Close/.test(eT.defaults.inputMeta?.betaSource ?? "") && /→/.test(eT.defaults.inputMeta?.betaSource ?? ""),
        eT.defaults.inputMeta?.betaSource,
      );
    }
  } finally {
    await saveSettings({ riskFreeRate: settings.riskFreeRate, benchmarkSymbol: settings.benchmarkSymbol, defaultReturnBasis: settings.defaultReturnBasis, defaultBenchmark: settings.defaultBenchmark });
    await client.close();
    await db.delete(schema.dividendEvents).where(eq(schema.dividendEvents.symbol, "PBT-D"));
  }
}
