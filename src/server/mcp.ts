/**
 * MCP server exposing the diary to Claude (claude.ai custom connector,
 * Claude Desktop, Claude Code). Tools reuse the same services and zod schemas
 * as the REST API.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { assetInput, noteInput, priceInput, transactionInput } from "@/lib/validation";
import { createAsset, getAssetBySymbol, listAssets } from "./services/assets";
import { createNote, listNotes } from "./services/notes";
import { recordPrice } from "./services/prices";
import { createTransaction, listTransactions } from "./services/transactions";
import { getAllocation, getMptAnalysis, getPerformance, getPortfolioSummary } from "./services/portfolio";

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

function safe<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A) => {
    try {
      return json(await fn(args));
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
    }
  };
}

export function createMcpServer() {
  const server = new McpServer(
    { name: "investment-diary", version: "1.0.0" },
    {
      instructions:
        "Personal investment diary (base currency THB). Use add_note to record ideas, theses, reviews and lessons " +
        "on the timeline; record_transaction for trades (add_asset first for new symbols); update_price for manual " +
        "prices/NAVs; and get_* tools to read holdings, asset allocation and risk-adjusted performance " +
        "(TWR, XIRR, Sharpe, Sortino, Beta, Jensen's alpha, Treynor, efficient frontier). Dates are YYYY-MM-DD.",
    },
  );

  const { source: _ns, ...noteShape } = noteInput.shape;
  server.registerTool(
    "add_note",
    {
      title: "Add journal note",
      description:
        "Write an entry on the investment diary timeline: an idea, thesis, review, lesson or market note. " +
        "Summarize the user's reasoning, catalysts, risks, valuation and exit plan in the markdown body.",
      inputSchema: noteShape,
    },
    safe(async (args) => createNote({ ...args, source: "claude" })),
  );

  server.registerTool(
    "search_notes",
    {
      title: "Search journal notes",
      description: "Search the diary timeline by text, type, tag, symbol or date range.",
      inputSchema: {
        q: z.string().optional(),
        type: z.enum(["idea", "thesis", "review", "lesson", "market"]).optional(),
        tag: z.string().optional(),
        symbol: z.string().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        limit: z.number().int().max(200).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ symbol, ...f }) => {
      const asset = symbol ? await getAssetBySymbol(symbol) : null;
      return listNotes({ ...f, assetId: asset?.id, limit: f.limit ?? 30 });
    }),
  );

  const { source: _ts, ...txShape } = transactionInput.shape;
  server.registerTool(
    "record_transaction",
    {
      title: "Record transaction",
      description:
        "Record a buy, sell, dividend, coupon, deposit, withdraw or fee. For buy/sell give quantity and price per unit " +
        "in the asset's currency; for other types put the total amount in `price`. The asset must exist (add_asset).",
      inputSchema: txShape,
    },
    safe(async (args) => createTransaction({ ...args, source: "claude" })),
  );

  server.registerTool(
    "list_transactions",
    {
      title: "List transactions",
      description: "Recent transactions, optionally for one symbol.",
      inputSchema: { symbol: z.string().optional(), limit: z.number().int().max(500).optional() },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ symbol, limit }) => {
      const asset = symbol ? await getAssetBySymbol(symbol) : null;
      const rows = await listTransactions({ assetId: asset?.id, limit: limit ?? 50 });
      return rows.map((r) => ({ ...r.tx, symbol: r.symbol }));
    }),
  );

  server.registerTool(
    "add_asset",
    {
      title: "Add asset",
      description:
        "Register a stock, bond, fund, gold or cash asset. Thai stocks: assetClass thai_stock, priceSource yahoo, " +
        "providerSymbol like 'PTT.BK'. US stocks: providerSymbol 'AAPL', currency USD. Thai gold bar: assetClass gold, " +
        "priceSource yahoo, providerSymbol 'GOLD_TH'. Thai funds: priceSource sec_th with the SEC proj_id, or manual. " +
        "Bonds: usually manual with couponRate / maturityDate.",
      inputSchema: assetInput.shape,
    },
    safe(async (args) => createAsset(args)),
  );

  server.registerTool(
    "list_assets",
    { title: "List assets", description: "All registered assets.", annotations: { readOnlyHint: true } },
    safe(async () => listAssets()),
  );

  server.registerTool(
    "update_price",
    {
      title: "Update price",
      description: "Set the closing price / NAV of an asset for a date (defaults to today).",
      inputSchema: priceInput.shape,
    },
    safe(async (args) => recordPrice(args)),
  );

  server.registerTool(
    "get_portfolio_summary",
    {
      title: "Portfolio summary",
      description: "Holdings with quantity, average cost, market value, unrealized/realized P&L and weights (THB).",
      annotations: { readOnlyHint: true },
    },
    safe(async () => getPortfolioSummary()),
  );

  server.registerTool(
    "get_allocation",
    {
      title: "Asset allocation",
      description: "Actual vs. target asset allocation by asset class with drift and rebalance amounts (THB).",
      annotations: { readOnlyHint: true },
    },
    safe(async () => getAllocation()),
  );

  server.registerTool(
    "get_performance_metrics",
    {
      title: "Performance metrics",
      description:
        "Time-weighted and money-weighted (XIRR) returns, volatility, max drawdown, VaR, risk premium, Sharpe, " +
        "Sortino, and vs. benchmark: beta, CAPM expected return, Jensen's alpha, Treynor, information ratio.",
      annotations: { readOnlyHint: true },
    },
    safe(async () => {
      const { growth: _g, valueSeries: _v, ...m } = await getPerformance();
      return m;
    }),
  );

  server.registerTool(
    "get_portfolio_optimization",
    {
      title: "Modern Portfolio Theory analysis",
      description:
        "Markowitz analysis of current holdings: expected returns, correlation, current portfolio risk/return, " +
        "minimum-variance and maximum-Sharpe (tangency) weights, and the Capital Market Line.",
      annotations: { readOnlyHint: true },
    },
    safe(async () => {
      const r = await getMptAnalysis();
      if (!r.ok) return r;
      const { cloud: _c, frontier: _f, ...rest } = r;
      return rest;
    }),
  );

  return server;
}
