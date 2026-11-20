/**
 * PRICE_BASIS_BENCHMARK_SPEC 6.1 / 6.5 feature checks (filled phase by phase): for every feature, calling it
 * with no new option must equal calling it with the explicit defaults, and the response must carry
 * priceBasis / benchmark.
 */
export async function featureChecks(
  check: (name: string, ok: boolean, detail?: string) => void,
  days: string[],
) {
  void check;
  void days;
}
