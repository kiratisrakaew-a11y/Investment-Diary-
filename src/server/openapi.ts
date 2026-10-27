/** OpenAPI 3.1 document for ChatGPT Custom GPT Actions, generated from the shared zod schemas. */
import { z } from "zod";
import { assetInput, assetProfileInput, noteInput, priceInput, transactionInput, yieldCurveInput } from "@/lib/validation";
import { bondSchema, multiStageRiToolInput, valuationInput } from "@/lib/valuation-schemas";
import { optimizeInput } from "./optimize-schema";
import { financialYearSchema } from "@/lib/financials";
import { importPricesInput, syncHistoricalPricesInput } from "./services/price-sync";
import { rebalanceInput } from "./services/rebalance";
import { stressInput } from "./services/stress";
import { dividendIncomeInput, screenDividendInput, screenFactorInput } from "./services/strategies";
import { dividendEventInput } from "./services/dividends";
import { bondLadderInput } from "./services/bonds";
import { recordSplitInput } from "./services/splits";
import { backtestInput } from "./services/backtest";

const schema = (s: z.ZodType) => {
  const { $schema: _s, ...rest } = z.toJSONSchema(s, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  return rest;
};

const ok = (description: string) => ({
  description,
  content: { "application/json": { schema: { type: "object", additionalProperties: true } } },
});
const okList = (description: string) => ({
  description,
  content: { "application/json": { schema: { type: "array", items: { type: "object", additionalProperties: true } } } },
});
const body = (ref: string) => ({
  required: true,
  content: { "application/json": { schema: { $ref: `#/components/schemas/${ref}` } } },
});
const q = (name: string, description: string, type = "string") => ({
  name,
  in: "query",
  required: false,
  description,
  schema: { type },
});

export function buildOpenApi(origin: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Investment Diary API",
      version: "1.0.0",
      description:
        "Personal investment diary (THB base). Record journal notes and trades, update prices, and read holdings, " +
        "asset allocation and finance-theory performance metrics. When writing, set source to \"chatgpt\".",
    },
    servers: [{ url: origin }],
    paths: {
      "/api/v1/notes": {
        get: {
          operationId: "searchNotes",
          summary: "Search journal notes on the timeline",
          parameters: [
            q("q", "Text search"),
            q("type", "idea | thesis | review | lesson | market"),
            q("tag", "Tag"),
            q("symbol", "Asset symbol"),
            q("from", "From date YYYY-MM-DD"),
            q("to", "To date YYYY-MM-DD"),
            q("limit", "Max results", "integer"),
          ],
          responses: { "200": okList("Notes, newest first") },
        },
        post: {
          operationId: "addNote",
          summary: "Add an idea / thesis / review / lesson / market note to the diary",
          requestBody: body("NoteInput"),
          responses: { "200": ok("Created note") },
        },
      },
      "/api/v1/assets/profile": {
        post: {
          operationId: "updateAssetProfile",
          summary: "Set issuer / sector (with source and date) / bond credit profile of an asset",
          description: "Only user-provided data; nothing is inferred. null clears a field.",
          requestBody: body("AssetProfile"),
          responses: { "200": ok("Updated asset") },
        },
      },
      "/api/v1/settings/yield-curve": {
        put: {
          operationId: "setYieldCurve",
          summary: "Set the government zero curve used for Z-spread and spread duration",
          requestBody: body("YieldCurve"),
          responses: { "200": ok("Saved curve") },
        },
      },
      "/api/v1/transactions/split": {
        post: {
          operationId: "recordSplit",
          summary: "Record a stock split / reverse split and repair stored prices (dryRun previews)",
          description: "splitFrom:splitTo (1:2 = shares double). Units ×ratio, cost unchanged, no cash. Prices before the date are divided only if still at the old level.",
          requestBody: body("RecordSplit"),
          responses: { "200": ok("Transaction id and price repair result") },
        },
      },
      "/api/v1/transactions": {
        get: {
          operationId: "listTransactions",
          summary: "List recent transactions",
          parameters: [q("symbol", "Asset symbol"), q("limit", "Max results", "integer")],
          responses: { "200": okList("Transactions") },
        },
        post: {
          operationId: "recordTransaction",
          summary: "Record a buy, sell, dividend, coupon, deposit, withdraw or fee",
          description:
            "For buy/sell give quantity and price per unit in the asset currency; for other types put the total amount in price. " +
            "The asset must already exist (addAsset). Overselling returns 400 OVERSELL; with the strict cash policy a buy/fee without enough cash returns 400 INSUFFICIENT_CASH — record a deposit first.",
          requestBody: body("TransactionInput"),
          responses: { "200": ok("Created transaction") },
        },
      },
      "/api/v1/assets": {
        get: { operationId: "listAssets", summary: "List registered assets", responses: { "200": okList("Assets") } },
        post: {
          operationId: "addAsset",
          summary: "Register a stock, bond, fund, gold or cash asset",
          description:
            "Thai stock: assetClass thai_stock, priceSource yahoo, providerSymbol e.g. PTT.BK. US stock: currency USD, providerSymbol AAPL. " +
            "Thai gold bar: assetClass gold, priceSource yahoo, providerSymbol GOLD_TH. Thai fund: priceSource sec_th + SEC proj_id, or manual.",
          requestBody: body("AssetInput"),
          responses: { "200": ok("Created (or existing) asset") },
        },
      },
      "/api/v1/prices": {
        post: {
          operationId: "updatePrice",
          summary: "Set the closing price / NAV of an asset for a date",
          requestBody: body("PriceInput"),
          responses: { "200": ok("Saved price") },
        },
      },
      "/api/v1/prices/sync": {
        post: {
          operationId: "syncHistoricalPrices",
          summary: "Backfill / refresh daily prices for existing assets over a date range (plus benchmark and USDTHB)",
          description:
            "Default last 365 days, keeps stored prices (overwriteExisting false). dryRun reports without writing. Unknown symbols are reported, not created — add the asset first.",
          requestBody: body("SyncHistoricalPrices"),
          responses: { "200": ok("Per-asset inserted/updated counts, coverage, corporate-action warnings and optimizer eligibility") },
        },
      },
      "/api/v1/prices/import": {
        post: {
          operationId: "importPrices",
          summary: "Store many prices at once (rows or CSV text) for existing assets",
          description: "rows [{symbol,date,close,adjClose?}] or csv. Keeps stored prices unless overwriteExisting; dryRun validates only. Unknown symbols are reported.",
          requestBody: body("ImportPrices"),
          responses: { "200": ok("Per-symbol inserted/updated/kept counts, parse errors and warnings") },
        },
      },
      "/api/v1/portfolio/summary": {
        get: { operationId: "getPortfolioSummary", summary: "Holdings, cost, market value and P&L in THB", responses: { "200": ok("Summary") } },
      },
      "/api/v1/data-quality": {
        get: {
          operationId: "getDataQuality",
          summary: "Data quality and assumption provenance: stale prices/FX, illustrative Rf/ERP, inferred cash, benchmark type, outdated valuations",
          responses: { "200": ok("Checks with status ok / warn / error") },
        },
      },
      "/api/v1/portfolio/allocation": {
        get: { operationId: "getAllocation", summary: "Actual vs target asset allocation and rebalance amounts", responses: { "200": ok("Allocation") } },
      },
      "/api/v1/portfolio/performance": {
        get: {
          operationId: "getPerformanceMetrics",
          summary: "Cumulative/annualized TWR, XIRR (with root status), volatility, drawdown, periodic-excess Sharpe/Sortino, OLS beta/alpha with standard errors, Treynor, IR, data-quality warnings",
          responses: { "200": ok("Metrics (decimals, 0.05 = 5%)") },
        },
      },
      "/api/v1/valuation/evaluate": {
        post: {
          operationId: "valueSecurity",
          summary: "Value a stock or bond: DCF (FCFF/FCFE), DDM, residual income, multiples, bond",
          description:
            "Send { method, assumptions }. Rates are decimals. DCF monetary inputs share one unit (e.g. THB million & million shares). " +
            "Returns intrinsic value per share, upside, WACC/Ke, terminal-value share, reverse-DCF growth and a sensitivity grid.",
          requestBody: body("ValuationInput"),
          responses: { "200": ok("Valuation summary") },
        },
      },
      "/api/v1/valuation/residual-income": {
        post: {
          operationId: "multiStageResidualIncome",
          summary: "Multi-stage residual income: yearly ROE / EPS / payout / book value forecasts + continuing value (optionally save)",
          description:
            "roeForecast is required (decimal per year, year 1 first). bookValueForecast null = clean surplus. terminalMethod: perpetuity RI(n+1)/(Ke−g), persistence RI(n+1)/(1+Ke−ω) or none. " +
            "Set save: true and symbol to save it to the Valuation page (ask the user first).",
          requestBody: body("MultiStageResidualIncome"),
          responses: { "200": ok("Value per share, upside, yearly residual income table, warnings") },
        },
      },
      "/api/v1/valuations": {
        get: {
          operationId: "listValuations",
          summary: "List saved valuations",
          parameters: [q("symbol", "Asset symbol")],
          responses: { "200": okList("Valuations") },
        },
        post: {
          operationId: "saveValuation",
          summary: "Save a valuation to the app (set source to chatgpt)",
          requestBody: body("SaveValuation"),
          responses: { "200": ok("Saved valuation") },
        },
      },
      "/api/v1/statements": {
        get: {
          operationId: "getFinancialStatements",
          summary: "Historical financial statements (millions) and derived ratios for a company",
          parameters: [{ ...q("symbol", "Asset symbol"), required: true }],
          responses: { "200": ok("Statements and ratios") },
        },
        post: {
          operationId: "saveFinancialStatements",
          summary: "Store historical statements, one object per fiscal year; money in millions, shares in millions, EPS/DPS per share",
          requestBody: body("SaveStatements"),
          responses: { "200": okList("All stored years") },
        },
      },
      "/api/v1/bonds": {
        get: { operationId: "getBondHoldings", summary: "YTM and duration of the user's bonds", responses: { "200": ok("Bond holdings") } },
      },
      "/api/v1/bonds/analyze": {
        post: {
          operationId: "analyzeBond",
          summary: "Bond price ↔ YTM, accrued interest, duration, convexity, DV01, yield to call (per 100 face)",
          requestBody: body("BondInput"),
          responses: { "200": ok("Bond analytics") },
        },
      },
      "/api/v1/portfolio/optimize": {
        post: {
          operationId: "optimizePortfolio",
          summary: "Recommend portfolio weights with Modern Portfolio Theory",
          description: "Objectives: max_sharpe, min_variance, target_return, target_risk, utility (risk aversion A). Returns weights and THB trades.",
          requestBody: body("OptimizeInput"),
          responses: { "200": ok("Recommendation") },
        },
      },
      "/api/v1/portfolio/rebalance": {
        post: {
          operationId: "rebalancePortfolio",
          summary: "Whole-lot buy/sell proposal after trading costs (never records transactions)",
          description: "Targets: custom {symbol: weight} or the optimizer recommendation. Uses the cost model in Settings unless overridden.",
          requestBody: body("RebalanceInput"),
          responses: { "200": ok("Trades, costs, remaining cash, final weights, tracking error, violations") },
        },
      },
      "/api/v1/portfolio/backtest": {
        post: {
          operationId: "backtestPortfolio",
          summary: "Walk-forward backtest (no look-ahead) with trading costs and existing performance metrics",
          requestBody: body("BacktestInput"),
          responses: { "200": ok("Equity curve, drawdown, weights, trades, costs, metrics, limitations") },
        },
      },
      "/api/v1/dividends/screen": {
        post: {
          operationId: "screenDividendStocks",
          summary: "Dividend screener: presets, editable filters/weights, scores with factor contributions, exclusions, target weights",
          requestBody: body("ScreenDividendInput"),
          responses: { "200": ok("Strategy decision with metric profiles (status, methodology, provenance)") },
        },
      },
      "/api/v1/bonds/ladder": {
        post: { operationId: "planBondLadder", summary: "Bond ladder plan: rungs, holdings, coupon vs principal cashflows, XIRR, duration, DV01", requestBody: body("BondLadderInput"), responses: { "200": ok("Ladder plan (proposal only)") } },
      },
      "/api/v1/strategies/factors": {
        post: {
          operationId: "screenFactorStocks",
          summary: "Factor screen: value / quality / momentum / multi-factor with coverage report and exclusions",
          requestBody: body("ScreenFactorInput"),
          responses: { "200": ok("Ranked candidates, family scores, target weights") },
        },
      },
      "/api/v1/dividends/income": {
        post: {
          operationId: "getDividendIncome",
          summary: "Dividend income plan: announced / estimated / received / missing_confirmation by month, quarter and year",
          requestBody: body("DividendIncomeInput"),
          responses: { "200": ok("Income rows and totals") },
        },
      },
      "/api/v1/dividends/events": {
        get: { operationId: "listDividendEvents", summary: "Stored issuer dividend events (?symbols=PTT,SCC)", responses: { "200": ok("Events") } },
        post: { operationId: "recordDividendEvents", summary: "Upsert issuer dividend events (not ledger receipts)", requestBody: body("DividendEvents"), responses: { "200": ok("Inserted / updated / unchanged") } },
      },
      "/api/v1/dividends/import": {
        post: { operationId: "importDividendsFromYahoo", summary: "Store Yahoo dividend history as issuer events", responses: { "200": ok("Per-symbol results") } },
      },
      "/api/v1/portfolio/stress": {
        post: {
          operationId: "stressTestPortfolio",
          summary: "Stress test current holdings (equity × beta, rates × duration, FX, specific, liquidity, correlation)",
          requestBody: body("StressInput"),
          responses: { "200": ok("P&L by asset and factor with assumptions") },
        },
      },
      "/api/v1/portfolio/mpt": {
        get: {
          operationId: "getPortfolioOptimization",
          summary: "Modern Portfolio Theory: min-variance and max-Sharpe weights, correlation, CML",
          responses: { "200": ok("MPT analysis") },
        },
      },
    },
    components: {
      schemas: {
        NoteInput: schema(noteInput),
        TransactionInput: schema(transactionInput),
        AssetInput: schema(assetInput),
        PriceInput: schema(priceInput),
        ValuationInput: schema(valuationInput),
        SyncHistoricalPrices: schema(syncHistoricalPricesInput),
        ImportPrices: schema(importPricesInput),
        MultiStageResidualIncome: schema(multiStageRiToolInput),
        SaveValuation: schema(
          z.object({
            symbol: z.string(),
            title: z.string().optional(),
            note: z.string().optional(),
            source: z.enum(["chatgpt", "api"]).optional(),
            valuation: valuationInput,
          }),
        ),
        BondInput: schema(bondSchema),
        SaveStatements: schema(
          z.object({
            symbol: z.string(),
            currency: z.string().optional(),
            years: z.array(financialYearSchema.partial().extend({ fiscalYear: z.number().int(), publishedAt: z.string().optional().describe("Date the figures became public (YYYY-MM-DD)") })),
          }),
        ),
        OptimizeInput: schema(optimizeInput),
        RebalanceInput: schema(rebalanceInput),
        StressInput: schema(stressInput),
        RecordSplit: schema(recordSplitInput.omit({ source: true })),
        AssetProfile: schema(assetProfileInput),
        YieldCurve: schema(yieldCurveInput),
        BacktestInput: schema(backtestInput),
        ScreenDividendInput: schema(screenDividendInput),
        ScreenFactorInput: schema(screenFactorInput),
        BondLadderInput: schema(bondLadderInput),
        DividendIncomeInput: schema(dividendIncomeInput),
        DividendEvents: schema(z.object({ events: z.array(dividendEventInput) })),
      },
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
    },
    security: [{ bearerAuth: [] }],
  };
}
