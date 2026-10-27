import {
  pgTable,
  serial,
  text,
  integer,
  doublePrecision,
  date,
  timestamp,
  pgEnum,
  uniqueIndex,
  index,
  jsonb,
} from "drizzle-orm/pg-core";

export const assetClassEnum = pgEnum("asset_class", [
  "thai_stock",
  "us_stock",
  "bond",
  "fund",
  "gold",
  "cash",
]);
export const currencyEnum = pgEnum("currency", ["THB", "USD"]);
export const priceSourceEnum = pgEnum("price_source", ["yahoo", "sec_th", "manual"]);
export const txTypeEnum = pgEnum("tx_type", [
  "buy",
  "sell",
  "dividend",
  "coupon",
  "deposit",
  "withdraw",
  "fee",
  /** Stock split / reverse split: quantity = new shares per old share; price = 0. */
  "split",
]);
export const noteTypeEnum = pgEnum("note_type", ["idea", "thesis", "review", "lesson", "market"]);
export const noteSourceEnum = pgEnum("note_source", ["web", "claude", "chatgpt", "api"]);

export const assets = pgTable("assets", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull().unique(),
  name: text("name").notNull(),
  assetClass: assetClassEnum("asset_class").notNull(),
  currency: currencyEnum("currency").notNull().default("THB"),
  priceSource: priceSourceEnum("price_source").notNull().default("manual"),
  /** Symbol used by the price provider, e.g. "PTT.BK" for Yahoo or the fund proj_id for SEC. */
  providerSymbol: text("provider_symbol"),
  /** Bonds: annual coupon rate in percent. */
  couponRate: doublePrecision("coupon_rate"),
  maturityDate: date("maturity_date"),
  faceValue: doublePrecision("face_value"),
  /** Bonds: coupons per year (1, 2, 4, 12); null = not specified (analytics assume 2 and say so). */
  couponFrequency: integer("coupon_frequency"),
  /** Bonds: accrued-interest day count, e.g. ACT/ACT-ICMA or ACT/365F. */
  dayCount: text("day_count"),
  /** Trading lot (units per lot); null = the default for the asset class in settings.tradingCosts. */
  lotSize: doublePrecision("lot_size"),
  /** Economic issuer (user-maintained mapping; stocks and bonds of one issuer share it). */
  issuer: text("issuer"),
  /** User-maintained sector / industry group with its source and date (never auto-assigned). */
  sector: text("sector"),
  sectorSource: text("sector_source"),
  sectorAsOf: date("sector_as_of"),
  /** Bond credit profile (rating with agency/date, PD with type/source/date, LGD) — creditProfileSchema. */
  credit: jsonb("credit"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const notes = pgTable(
  "notes",
  {
    id: serial("id").primaryKey(),
    date: date("date").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    type: noteTypeEnum("type").notNull().default("idea"),
    tags: text("tags").array().notNull().default([]),
    assetIds: integer("asset_ids").array().notNull().default([]),
    conviction: integer("conviction"),
    source: noteSourceEnum("source").notNull().default("web"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("notes_date_idx").on(t.date)],
);

export const transactions = pgTable(
  "transactions",
  {
    id: serial("id").primaryKey(),
    date: date("date").notNull(),
    /** Null for pure cash movements (deposit / withdraw). */
    assetId: integer("asset_id").references(() => assets.id, { onDelete: "cascade" }),
    type: txTypeEnum("type").notNull(),
    quantity: doublePrecision("quantity").notNull().default(0),
    /** Price per unit in the asset currency; for cash flows the total amount. */
    price: doublePrecision("price").notNull().default(0),
    fee: doublePrecision("fee").notNull().default(0),
    /** THB per 1 unit of the transaction currency at trade time. 1 for THB. */
    fxRate: doublePrecision("fx_rate").notNull().default(1),
    noteId: integer("note_id").references(() => notes.id, { onDelete: "set null" }),
    memo: text("memo"),
    source: noteSourceEnum("source").notNull().default("web"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("tx_date_idx").on(t.date)],
);

export const prices = pgTable(
  "prices",
  {
    id: serial("id").primaryKey(),
    assetId: integer("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    /** Provider close: for Yahoo this is split-adjusted but not dividend-adjusted. */
    close: doublePrecision("close").notNull(),
    /** Split- and dividend-adjusted close (total-return series); null unless synced with priceType adjusted_close. */
    adjClose: doublePrecision("adj_close"),
  },
  (t) => [uniqueIndex("prices_asset_date_uq").on(t.assetId, t.date)],
);

/** Benchmark index levels (e.g. SET index) keyed by symbol. */
export const benchmarkPrices = pgTable(
  "benchmark_prices",
  {
    id: serial("id").primaryKey(),
    symbol: text("symbol").notNull(),
    date: date("date").notNull(),
    close: doublePrecision("close").notNull(),
    adjClose: doublePrecision("adj_close"),
  },
  (t) => [uniqueIndex("bench_symbol_date_uq").on(t.symbol, t.date)],
);

export const fxRates = pgTable(
  "fx_rates",
  {
    id: serial("id").primaryKey(),
    pair: text("pair").notNull().default("USDTHB"),
    date: date("date").notNull(),
    rate: doublePrecision("rate").notNull(),
  },
  (t) => [uniqueIndex("fx_pair_date_uq").on(t.pair, t.date)],
);

export const allocationTargets = pgTable("allocation_targets", {
  assetClass: assetClassEnum("asset_class").primaryKey(),
  targetPct: doublePrecision("target_pct").notNull(),
});

export const settings = pgTable("settings", {
  id: integer("id").primaryKey().default(1),
  /** Annual risk-free rate in percent (e.g. Thai 1Y government bond yield). */
  riskFreeRate: doublePrecision("risk_free_rate").notNull().default(2.0),
  benchmarkSymbol: text("benchmark_symbol").notNull().default("^SET.BK"),
  /** Expected equity risk premium (%) used for CAPM expected returns and cost of equity. */
  equityRiskPremium: doublePrecision("equity_risk_premium").notNull().default(6.0),
  /** strict: reject buys/fees without enough recorded cash; infer_with_warning: allow with an explicit inferred deposit. */
  cashFlowPolicy: text("cash_flow_policy").$type<"strict" | "infer_with_warning">().notNull().default("strict"),
  /** How external flows are timed in TWR sub-periods. */
  twrFlowTiming: text("twr_flow_timing").$type<"start_of_day" | "end_of_day" | "modified_dietz">().notNull().default("start_of_day"),
  /** Whether the benchmark series includes dividends. */
  benchmarkKind: text("benchmark_kind").$type<"price_index" | "total_return">().notNull().default("price_index"),
  baseCurrency: currencyEnum("base_currency").notNull().default("THB"),
  /** Provenance of the market inputs; null source = illustrative default. */
  rfSource: text("rf_source"),
  rfSeries: text("rf_series"),
  rfAsOf: date("rf_as_of"),
  erpSource: text("erp_source"),
  erpAsOf: date("erp_as_of"),
  /** Trading cost model for rebalancing proposals (see tradingCostsSchema); {} = all zero / defaults. */
  tradingCosts: jsonb("trading_costs").notNull().default({}),
  /** Government zero curve for spread analytics: { points: [{years, rate}], source, asOf } (decimal, annual compounding). */
  yieldCurve: jsonb("yield_curve"),
});

export const valuationMethodEnum = pgEnum("valuation_method", [
  "dcf_fcff",
  "dcf_fcfe",
  "ddm",
  "residual_income",
  "multiples",
  "bond",
  "sotp",
]);

/** A saved valuation: the full assumption set plus headline results, versioned by date. */
export const valuations = pgTable(
  "valuations",
  {
    id: serial("id").primaryKey(),
    assetId: integer("asset_id").references(() => assets.id, { onDelete: "set null" }),
    symbol: text("symbol").notNull(),
    date: date("date").notNull(),
    method: valuationMethodEnum("method").notNull(),
    title: text("title").notNull().default(""),
    assumptions: jsonb("assumptions").notNull(),
    /** Headline outputs: { value, price, upside, ... } */
    result: jsonb("result").notNull(),
    intrinsicValue: doublePrecision("intrinsic_value"),
    priceAtValuation: doublePrecision("price_at_valuation"),
    note: text("note").notNull().default(""),
    source: noteSourceEnum("source").notNull().default("web"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("valuations_symbol_idx").on(t.symbol)],
);

/** Historical financial statements, one row per company and fiscal year (values in millions). */
export const financialStatements = pgTable(
  "financial_statements",
  {
    id: serial("id").primaryKey(),
    symbol: text("symbol").notNull(),
    assetId: integer("asset_id").references(() => assets.id, { onDelete: "set null" }),
    fiscalYear: integer("fiscal_year").notNull(),
    currency: text("currency").notNull().default("THB"),
    data: jsonb("data").$type<Record<string, number | null>>().notNull(),
    sourceFile: text("source_file"),
    /** Date the figures became public (annual report / SET filing); null = unknown → not usable point-in-time. */
    publishedAt: date("published_at"),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("fin_symbol_year_uq").on(t.symbol, t.fiscalYear)],
);

/**
 * Issuer dividend events (announcements / ex-dates), separate from the investor's dividend receipts
 * in `transactions`. Never written to the ledger. Unknown fields stay null.
 */
export const dividendEvents = pgTable(
  "dividend_events",
  {
    id: serial("id").primaryKey(),
    symbol: text("symbol").notNull(),
    assetId: integer("asset_id").references(() => assets.id, { onDelete: "set null" }),
    issuer: text("issuer"),
    declarationDate: date("declaration_date"),
    exDate: date("ex_date"),
    recordDate: date("record_date"),
    paymentDate: date("payment_date"),
    /** Per share, in `currency`, on the share basis described by splitAdjustmentPolicy. */
    dividendPerShare: doublePrecision("dividend_per_share").notNull(),
    currency: text("currency").notNull().default("THB"),
    /** cash | stock */
    cashOrStock: text("cash_or_stock").notNull().default("cash"),
    /** regular | special | indicated_annual (announced annual rate, not a payment) | unknown */
    kind: text("kind").notNull().default("unknown"),
    fiscalPeriod: text("fiscal_period"),
    source: text("source").notNull(),
    /** Stable id within the source (e.g. "PTT.BK:2025-08-20"); unique with source → idempotent upsert. */
    sourceEventId: text("source_event_id").notNull(),
    retrievedAt: timestamp("retrieved_at").defaultNow().notNull(),
    /** First time the event was publicly known; null = unknown (not usable point-in-time). */
    announcedAt: date("announced_at"),
    /** verified | provider | unverified */
    dataQualityStatus: text("data_quality_status").notNull().default("unverified"),
    /** as_reported (share basis on the ex-date) | provider_split_adjusted (already on the latest basis) */
    splitAdjustmentPolicy: text("split_adjustment_policy").notNull().default("as_reported"),
    withholdingTaxRate: doublePrecision("withholding_tax_rate"),
    withholdingSource: text("withholding_source"),
    note: text("note"),
    /** Previous values kept on correction: [{ at, values }]. */
    revisions: jsonb("revisions").$type<{ at: string; values: Record<string, unknown> }[]>().notNull().default([]),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("div_source_event_uq").on(t.source, t.sourceEventId), index("div_symbol_ex_idx").on(t.symbol, t.exDate)],
);

/** Audit trail of statement files read by AI (the files themselves are not stored). */
export const statementUploads = pgTable("statement_uploads", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  filename: text("filename").notNull(),
  mimeType: text("mime_type").notNull(),
  size: integer("size").notNull(),
  status: text("status").notNull(),
  yearsFound: integer("years_found").array().notNull().default([]),
  unitDetected: text("unit_detected"),
  notes: text("notes").notNull().default(""),
  error: text("error"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/** In-app AI advisor conversations (text turns only). */
export const advisorThreads = pgTable("advisor_threads", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  messages: jsonb("messages").$type<{ role: "user" | "assistant"; content: string }[]>().notNull().default([]),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type Asset = typeof assets.$inferSelect;
export type Valuation = typeof valuations.$inferSelect;
export type ValuationMethod = (typeof valuationMethodEnum.enumValues)[number];
export type Note = typeof notes.$inferSelect;
export type Transaction = typeof transactions.$inferSelect;
export type Price = typeof prices.$inferSelect;
export type Settings = typeof settings.$inferSelect;
export type AssetClass = (typeof assetClassEnum.enumValues)[number];
export type TxType = (typeof txTypeEnum.enumValues)[number];
