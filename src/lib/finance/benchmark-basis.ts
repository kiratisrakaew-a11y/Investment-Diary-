/**
 * Pick the benchmark whose return basis matches the portfolio's (pure):
 *  - portfolio with dividends (total return / dividend cash flows) → a total-return index (Settings if it
 *    is one, else the imported SET TRI);
 *  - price-only portfolio → a price index (Settings if it is one, else ^SET.BK).
 * A benchmark is usable only when it covers the start of the test period (within a week). When no
 * matching series exists the other one is used and the mismatch is a warning: alpha / IR are biased.
 */
export type BenchmarkBasis = "price" | "total_return";
export interface BenchmarkCandidate {
  symbol: string;
  basis: BenchmarkBasis;
  series: [string, number][];
}
export interface BenchmarkChoice {
  symbol: string;
  basis: BenchmarkBasis;
  kind: "price_index" | "total_return";
  series: [string, number][];
  wanted: BenchmarkBasis;
  warning: string | null;
}

const covers = (c: BenchmarkCandidate, from: string) =>
  c.series.length > 1 &&
  Date.parse(c.series[0][0]) <= Date.parse(from) + 7 * 86_400_000;

export function chooseBenchmarkBasis(
  wanted: BenchmarkBasis,
  candidates: BenchmarkCandidate[],
  from: string,
): BenchmarkChoice | null {
  const usable = candidates.filter((c) => covers(c, from));
  const pick = (
    c: BenchmarkCandidate,
    warning: string | null,
  ): BenchmarkChoice => ({
    symbol: c.symbol,
    basis: c.basis,
    kind: c.basis === "total_return" ? "total_return" : "price_index",
    series: c.series,
    wanted,
    warning,
  });
  const match = usable.find((c) => c.basis === wanted);
  if (match) return pick(match, null);
  const other = usable[0];
  if (!other) return null;
  return pick(other, basisMismatchWarning(wanted, other.symbol));
}

/** The warning used whenever a benchmark's kind does not match the return basis it is compared with. */
export function basisMismatchWarning(
  wanted: BenchmarkBasis,
  symbol: string,
): string {
  return wanted === "total_return"
    ? `benchmark basis ไม่ตรง — พอร์ตรวมปันผลแต่ดัชนีอ้างอิง ${symbol} เป็นดัชนีราคา: alpha / IR เอียงเข้าข้างพอร์ต (ราว dividend yield ของตลาด) · นำเข้า SET TRI ด้วย import_prices target "benchmark" symbol SETTRI`
    : `benchmark basis ไม่ตรง — พอร์ตไม่รวมปันผลแต่ดัชนีอ้างอิง ${symbol} เป็นผลตอบแทนรวม: alpha / IR ต่ำกว่าจริง`;
}
