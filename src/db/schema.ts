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
    close: doublePrecision("close").notNull(),
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
  baseCurrency: currencyEnum("base_currency").notNull().default("THB"),
});

export type Asset = typeof assets.$inferSelect;
export type Note = typeof notes.$inferSelect;
export type Transaction = typeof transactions.$inferSelect;
export type Price = typeof prices.$inferSelect;
export type Settings = typeof settings.$inferSelect;
export type AssetClass = (typeof assetClassEnum.enumValues)[number];
export type TxType = (typeof txTypeEnum.enumValues)[number];
