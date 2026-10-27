/** zod schemas shared by the UI server actions, the REST API and the MCP tools. */
import { z } from "zod";
import { bondTermsSchema } from "./finance/bond-meta";
import { creditProfileSchema } from "./finance/credit-risk";

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .describe("Date in YYYY-MM-DD format");

export const assetClass = z.enum(["thai_stock", "us_stock", "bond", "fund", "gold", "cash"]);
export const source = z.enum(["web", "claude", "chatgpt", "api"]);

export const noteInput = z.object({
  date: isoDate.optional().describe("Date of the note (defaults to today)"),
  title: z.string().min(1).max(300),
  body: z.string().max(50_000).default("").describe("Markdown body: reasoning, thesis, risks, exit plan"),
  type: z.enum(["idea", "thesis", "review", "lesson", "market"]).default("idea"),
  tags: z.array(z.string().max(50)).max(30).default([]),
  symbols: z.array(z.string()).max(30).default([]).describe("Related asset symbols, e.g. ['PTT', 'AAPL']"),
  conviction: z.number().int().min(1).max(5).optional().describe("Conviction level 1-5"),
  source: source.optional(),
});

export const assetInput = z.object({
  symbol: z.string().min(1).max(40).describe("Your short symbol, e.g. PTT, AAPL, K-FIXED, GOLD"),
  name: z.string().min(1).max(200),
  assetClass,
  currency: z.enum(["THB", "USD"]).default("THB"),
  priceSource: z.enum(["yahoo", "sec_th", "manual"]).default("manual"),
  providerSymbol: z
    .string()
    .max(60)
    .optional()
    .describe("Yahoo symbol (PTT.BK, AAPL, GC=F, GOLD_TH for Thai gold bar) or SEC proj_id for Thai funds"),
  couponRate: z.number().optional().describe("Bonds: annual coupon %"),
  maturityDate: isoDate.optional(),
  faceValue: z.number().optional(),
  couponFrequency: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(12)]).optional().describe("Bonds: coupons per year"),
  dayCount: z.enum(["ACT/ACT-ICMA", "ACT/365F", "ACT/360", "30/360"]).optional().describe("Bonds: accrued-interest day count from the bond's terms"),
});

export const transactionInput = z
  .object({
    date: isoDate.optional().describe("Trade date (defaults to today)"),
    type: z.enum(["buy", "sell", "dividend", "coupon", "deposit", "withdraw", "fee", "split"]),
    symbol: z.string().optional().describe("Asset symbol (required for buy/sell/dividend/coupon/split)"),
    quantity: z.number().nonnegative().default(0).describe("Units / shares (buy & sell); split: new shares per old share (2 = 1:2 split, 0.1 = 10:1 reverse)"),
    splitFrom: z.number().positive().optional().describe("split only: old shares (e.g. 1 in a 1:2 split)"),
    splitTo: z.number().positive().optional().describe("split only: new shares (e.g. 2 in a 1:2 split)"),
    price: z
      .number()
      .nonnegative()
      .describe("Price per unit for buy/sell; total amount for dividend/coupon/deposit/withdraw/fee"),
    fee: z.number().nonnegative().default(0).describe("Commission + tax in the asset currency"),
    fxRate: z.number().positive().optional().describe("THB per 1 USD for USD assets (auto-filled if omitted)"),
    noteId: z.number().int().optional().describe("Link to a journal note id"),
    memo: z.string().max(1000).optional(),
    source: source.optional(),
  })
  .refine((t) => !["buy", "sell", "dividend", "coupon", "split"].includes(t.type) || !!t.symbol, {
    message: "symbol is required for this transaction type",
    path: ["symbol"],
  })
  .refine((t) => !["buy", "sell"].includes(t.type) || t.quantity > 0, {
    message: "quantity must be > 0 for buy/sell",
    path: ["quantity"],
  })
  .refine((t) => t.type !== "split" || (t.splitFrom && t.splitTo ? t.splitTo / t.splitFrom : t.quantity) > 0, {
    message: "split needs splitFrom and splitTo (or quantity = new shares per old share)",
    path: ["quantity"],
  });

/** Risk metadata maintained by the user (issuer / sector / credit). Sector needs a source and date; nothing is inferred. */
export const assetProfileInput = z
  .object({
    symbol: z.string().min(1),
    issuer: z.string().max(120).nullable().optional().describe("Economic issuer, e.g. PTT for PTT and its bonds (null clears)"),
    sector: z.string().max(80).nullable().optional().describe("Sector / industry group as you classify it (null clears)"),
    sectorSource: z.string().max(200).nullable().optional().describe("Classification source, e.g. SET industry group"),
    sectorAsOf: isoDate.nullable().optional(),
    credit: creditProfileSchema.nullable().optional().describe("Bond credit profile (rating + agency + date; PD with type/source/date; LGD with source/date). null clears"),
    bondTerms: bondTermsSchema.nullable().optional().describe("Bond metadata: issuerType, issuerCountry, couponType, callable, identifiers, riskFreeProxyEligible (eligibility flag only). null clears"),
  })
  .refine((v) => !v.sector || (v.sectorSource && v.sectorAsOf), { message: "sector needs sectorSource and sectorAsOf", path: ["sectorSource"] });

export const yieldCurveInput = z.object({
  points: z.array(z.object({ years: z.number().positive().max(50), rate: z.number().min(-0.05).max(0.5) })).min(1).max(30).describe("Zero rates (decimal, annual compounding) by maturity in years"),
  source: z.string().min(1).max(200).describe("e.g. ThaiBMA government zero curve"),
  asOf: isoDate,
  currency: z.string().length(3).toUpperCase().optional().describe("Currency of the curve, e.g. THB (curves saved before this field have none and are reported as unknown)"),
  kind: z.enum(["nominal", "real"]).optional().describe("Nominal (default) or real (inflation-linked) rates"),
});

export const priceInput = z.object({
  symbol: z.string(),
  date: isoDate.optional(),
  close: z.number().positive().describe("Closing price / NAV in the asset currency"),
});

export const settingsInput = z.object({
  riskFreeRate: z.number().min(-5).max(50).describe("Annual risk-free rate in %, e.g. Thai 1Y govt bond yield"),
  benchmarkSymbol: z.string().min(1),
  equityRiskPremium: z.number().min(0).max(30).default(6).describe("Expected equity risk premium in %"),
  cashFlowPolicy: z.enum(["strict", "infer_with_warning"]).default("strict"),
  twrFlowTiming: z.enum(["start_of_day", "end_of_day", "modified_dietz"]).default("start_of_day"),
  benchmarkKind: z.enum(["price_index", "total_return"]).default("price_index"),
  rfSource: z.string().max(200).nullable().default(null).describe("Where the risk-free rate comes from, e.g. ThaiBMA"),
  rfSeries: z.string().max(200).nullable().default(null).describe("Which series / maturity, e.g. Thai government bond 10Y"),
  rfAsOf: isoDate.nullable().default(null),
  erpSource: z.string().max(200).nullable().default(null),
  erpAsOf: isoDate.nullable().default(null),
  sortinoMarPct: z.number().min(-50).max(100).nullable().default(null).describe("Sortino minimum acceptable return, annual %; null = risk-free rate"),
});

export const targetsInput = z.record(assetClass, z.number().min(0).max(100));

export type NoteInput = z.infer<typeof noteInput>;
export type AssetInputT = z.infer<typeof assetInput>;
export type TransactionInputT = z.infer<typeof transactionInput>;
export type PriceInputT = z.infer<typeof priceInput>;

export const today = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Bangkok" });
