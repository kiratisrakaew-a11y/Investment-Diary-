/**
 * PRICE_BASIS_BENCHMARK_SPEC 6.1 / 6.4 / 6.5 feature checks (extended phase by phase): no new option ==
 * explicit defaults; total_return never drops an asset silently; MCP == REST == service for the same params.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../server/mcp";
import { loadUniverse, optimizePortfolio } from "../server/services/optimizer";
import { stressTestPortfolio } from "../server/services/stress";
import { getMptAnalysis, getPerformance } from "../server/services/portfolio";
import { editorDefaults } from "../server/services/valuation-defaults";
import { importPrices } from "../server/services/price-sync";
import { getSettings, saveSettings } from "../server/services/settings";
import { backtestPortfolio } from "../server/services/backtest";
import { summarizeBacktest } from "../server/services/backtest-summary";
import { comparePortfolioModels, summarizeModelComparison } from "../server/services/model-comparison";
import { screenFactorStocks } from "../server/services/strategies";
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

    // ---------------------------------------------------------------- F1 real portfolio (D5)
    const f0 = await getPerformance();
    const f1 = await getPerformance(undefined, undefined, { returnBasis: "price_return", benchmark: "default" });
    check("6.1 F1 performance: no option == explicit defaults", same(noSource(f0), noSource(f1)));
    // A TEST holding with full adj_close that goes ex-dividend (1 THB on 50) with no dividend recorded.
    const n = days.length;
    const xd = n - 60;
    const [E] = await db
      .insert(schema.assets)
      .values({ symbol: "PBT-E", name: "TEST-LOCAL PBT-E (sample)", assetClass: "thai_stock", priceSource: "manual" })
      .returning();
    await db.insert(schema.prices).values(
      days.map((d, i) => ({ assetId: E.id, date: d, close: i < xd ? 50 : 49, adjClose: i < xd ? 49 : 49 })),
    );
    await db.insert(schema.transactions).values([
      { date: days[n - 200], assetId: null, type: "deposit", price: 5000, memo: "PBT-TEST" },
      { date: days[n - 200], assetId: E.id, type: "buy", quantity: 100, price: 50, memo: "PBT-TEST" },
    ]);
    const fc = await getPerformance(undefined, undefined, { returnBasis: "price_return" });
    const ft = await getPerformance(undefined, undefined, { returnBasis: "total_return" });
    check(
      "F1 total_return: PBT-E on the adj chain; holdings without adj_close fall back to closes with a reason (none dropped)",
      ft.priceBasis.used === "total_return" &&
        !ft.priceBasis.fallback.some((x) => x.symbol === "PBT-E") &&
        ft.priceBasis.fallback.every((x) => x.reason.length > 0) &&
        ft.priceBasis.excluded.length === 0,
      JSON.stringify(ft.priceBasis.fallback.map((x) => x.symbol)),
    );
    check(
      "6.2(ค) on the real ledger: unrecorded dividend → listed + warning, TWR(adj) > TWR(close)",
      (ft.unrecordedDividends ?? []).some((u) => u.symbol === "PBT-E" && u.exDate === days[xd]) &&
        ft.dataQuality.warnings.some((w) => w.includes("PBT-E")) &&
        ft.cumulativeReturn > fc.cumulativeReturn,
    );
    check(
      "D5 values / XIRR identical between the two bases",
      same(ft.valueSeries, fc.valueSeries) && same(ft.xirr, fc.xirr),
    );
    await db.insert(schema.transactions).values({ date: days[xd + 15], assetId: E.id, type: "dividend", price: 100, memo: "PBT-TEST" });
    const ft2 = await getPerformance(undefined, undefined, { returnBasis: "total_return" });
    check(
      "6.2(ข) dividend recorded → no longer reported",
      !(ft2.unrecordedDividends ?? []).some((u) => u.symbol === "PBT-E"),
    );
    const fa = await getPerformance(undefined, undefined, { benchmark: "auto" });
    check(
      "B2: auto → a total-return index for the real portfolio (no mismatch warning)",
      fa.benchmark?.symbol === "PBT-TRI3" && fa.benchmark.warning === null && fa.benchmark.kind === "total_return",
      JSON.stringify(fa.benchmark && { s: fa.benchmark.symbol, w: fa.benchmark.warning }),
    );
    const noSeries = (m: Record<string, unknown>) => stable({ ...m, growth: undefined, valueSeries: undefined });
    const pm = await mcp("get_performance_metrics", { returnBasis: "total_return", benchmark: "auto" });
    const pr = await rest("portfolio/performance?returnBasis=total_return&benchmark=auto");
    const ps = await getPerformance(undefined, undefined, { returnBasis: "total_return", benchmark: "auto" });
    check(
      "6.5 get_performance_metrics: MCP == REST == service",
      pm.ok && pr.status === 200 && same(noSeries(pm.data), noSeries(ps as never)) && same(noSeries(pr.data), noSeries(ps as never)),
    );

    // ---------------------------------------------------------------- F5 backtest / F4 compare
    const b0 = await backtestPortfolio({ strategy: "equal_weight" });
    const b1 = await backtestPortfolio({ strategy: "equal_weight", returnBasis: "price_return", benchmark: "default" });
    // The echoed input differs only by the explicit benchmark field itself.
    const noInput = (o: Record<string, unknown>) => noSource({ ...o, input: undefined });
    check("6.1 F5 backtest: no option == explicit defaults", same(noInput(b0), noInput(b1)) && b0.priceBasis.used === "price_return");
    const bA = await backtestPortfolio({ strategy: "equal_weight", returnBasis: "total_return", benchmark: "auto" });
    check(
      "F5 total_return + auto → TRI benchmark; priceBasis lists fallbacks with reasons",
      bA.benchmark?.symbol === "PBT-TRI3" && bA.benchmark.warning === null && bA.priceBasis.used === "total_return" && bA.priceBasis.fallback.every((f) => f.reason),
      JSON.stringify(bA.benchmark),
    );
    await saveSettings({ riskFreeRate: settings.riskFreeRate, benchmarkSymbol: settings.benchmarkSymbol, defaultReturnBasis: "total_return" });
    const bDiv = await backtestPortfolio({ strategy: "equal_weight", dividendCashflows: true }).catch((e) => e as Error);
    const bSet = await backtestPortfolio({ strategy: "equal_weight" });
    await saveSettings({ riskFreeRate: settings.riskFreeRate, benchmarkSymbol: settings.benchmarkSymbol, defaultReturnBasis: settings.defaultReturnBasis });
    check(
      "F5 dividend cash flows ignore a total_return Settings default (closes, no double count); others follow Settings",
      !(bDiv instanceof Error) && bDiv.priceBasis.used === "price_return" && bDiv.priceBasis.source === "feature_default" && bSet.priceBasis.used === "total_return",
      bDiv instanceof Error ? bDiv.message : "",
    );
    const bErr = await backtestPortfolio({ strategy: "equal_weight", dividendCashflows: true, returnBasis: "total_return" }).catch((e) => e as Error);
    check("F5 explicit total_return + dividend cash flows is still an error", bErr instanceof Error);
    const bm = await mcp("backtest_portfolio", { strategy: "equal_weight", returnBasis: "total_return", benchmark: "auto" });
    const br = await rest("portfolio/backtest", { method: "POST", body: { strategy: "equal_weight", returnBasis: "total_return", benchmark: "auto" } });
    check(
      "6.5 backtest: MCP == service summary; REST == service",
      bm.ok && same(stable(bm.data), stable(summarizeBacktest(bA))) && br.status === 200 && same(stable(br.data), stable(bA)),
    );
    // The seeded assets only (TEST holdings with short histories would shorten the common period).
    const seedSymbols = u0.assets.map((x) => x.symbol).filter((x) => !x.startsWith("PBT-"));
    const c0 = await comparePortfolioModels({ windowDays: 126, symbols: seedSymbols });
    const c1 = await comparePortfolioModels({ windowDays: 126, symbols: seedSymbols, returnBasis: "price_return", benchmark: "default" });
    check("6.1 F4 compare: no option == explicit defaults", same(noInput(c0), noInput(c1)));
    const cp = { windowDays: 126, symbols: seedSymbols, returnBasis: "total_return", benchmark: "PBT-TRI3" } as const;
    const cA = await comparePortfolioModels(cp);
    const cm = await mcp("compare_portfolio_models", cp);
    const cr = await rest("portfolio/compare-models", { method: "POST", body: cp });
    check(
      "F4 explicit TRI on total_return; MCP == summary(service), REST == service",
      cA.benchmark?.symbol === "PBT-TRI3" && cA.benchmark.warning === null && cm.ok && same(stable(cm.data), stable(summarizeModelComparison(cA))) && cr.status === 200 && same(stable(cr.data), stable(cA)),
    );

    // ---------------------------------------------------------------- F7 momentum (screen ↔ backtest parity)
    // Four TEST stocks with closes; M1–M3 have adjusted closes whose dividends change the 12–1 ranking, M4 lacks
    // adj_close inside the momentum window.
    const mk = async (sym: string, k: number, adj: "full" | "gap") => {
      const [A] = await db
        .insert(schema.assets)
        .values({ symbol: sym, name: `TEST-LOCAL ${sym} (sample)`, assetClass: "thai_stock", priceSource: "manual" })
        .returning();
      const n = days.length;
      await db.insert(schema.prices).values(
        days.map((d, i) => {
          // M1: closes drift down 5%/yr but large dividends lift the adjusted series ≈ +20%/yr;
          // M2: closes +10%/yr, no dividends; M3 / M4: flat-ish.
          const close = k === 1 ? 30 * (1 - 0.0002 * i) : k === 2 ? 25 * (1 + 0.0004 * i) : 20 + k + 0.2 * Math.sin(i / 9);
          const f = k === 1 ? 0.6 + 0.4 * (i / n) : 1;
          return { assetId: A.id, date: d, close, adjClose: adj === "gap" && i > n - 200 && i < n - 150 ? null : close * f };
        }),
      );
    };
    await mk("PBT-M1", 1, "full");
    await mk("PBT-M2", 2, "full");
    await mk("PBT-M3", 3, "full");
    await mk("PBT-M4", 4, "gap");
    const syms = ["PBT-M1", "PBT-M2", "PBT-M3", "PBT-M4"];
    const bt = await backtestPortfolio({ strategy: "momentum", symbols: syms, returnBasis: "total_return", factorSettings: { topN: 1 }, rebalance: "quarterly" } as never);
    const decs = bt.decisions ?? [];
    let parity = decs.length > 0;
    for (const d of decs.slice(0, 4)) {
      const sc = await screenFactorStocks({ strategy: "momentum", asOf: d.cutoff, symbols: syms, returnBasis: "total_return", settings: { topN: 1 } });
      if (!same(sc.selected, d.selected)) parity = false;
    }
    check("F7 momentum total_return: screen == backtest selection at each decision (first 4)", parity, `${decs.length} decisions`);
    const scT = await screenFactorStocks({ strategy: "momentum", symbols: syms, returnBasis: "total_return", settings: { topN: 1 } });
    const scP = await screenFactorStocks({ strategy: "momentum", symbols: syms, returnBasis: "price_return", settings: { topN: 1 } });
    check(
      "F7 a stock without adj_close in its 12–1 window has no momentum (listed, never mixed with closes)",
      scT.priceBasis.excluded.some((x) => x.symbol === "PBT-M4") && !scP.priceBasis.excluded.length,
      JSON.stringify(scT.priceBasis.excluded),
    );
    check("F7 the basis changes the momentum ranking (dividends count)", !same(scT.selected, scP.selected), `${scT.selected} vs ${scP.selected}`);
    const sc0 = await screenFactorStocks({ strategy: "momentum", symbols: syms, settings: { topN: 1 } });
    const diffKeys = Object.keys({ ...sc0, ...scP }).filter((k) => !same(noSource((sc0 as Record<string, unknown>)[k]), noSource((scP as Record<string, unknown>)[k])));
    check("6.1 F7 screen: no option == price_return", diffKeys.length === 0, diffKeys.join(","));

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
