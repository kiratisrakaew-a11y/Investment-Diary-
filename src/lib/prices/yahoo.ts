import YahooFinance from "yahoo-finance2";

/**
 * Free (unofficial) Yahoo Finance data.
 * Thai stocks use the ".BK" suffix (e.g. "PTT.BK"), the SET index is "^SET.BK",
 * gold futures "GC=F" (USD/oz) and the USD/THB rate "THB=X".
 */
const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

export interface DailyClose {
  date: string;
  close: number;
}

export async function fetchDailyCloses(symbol: string, from: string): Promise<DailyClose[]> {
  const res = await yf.chart(symbol, { period1: from, interval: "1d" });
  return res.quotes
    .filter((q) => q.close != null && Number.isFinite(q.close))
    .map((q) => ({ date: q.date.toISOString().slice(0, 10), close: q.close as number }));
}

export async function searchSymbols(query: string) {
  const res = await yf.search(query, { quotesCount: 8, newsCount: 0 });
  return res.quotes
    .filter((q): q is typeof q & { symbol: string } => "symbol" in q && typeof q.symbol === "string")
    .map((q) => ({
      symbol: q.symbol,
      name: ("longname" in q && q.longname) || ("shortname" in q && q.shortname) || q.symbol,
      exchange: "exchange" in q ? q.exchange : undefined,
      type: "quoteType" in q ? q.quoteType : undefined,
    }));
}
