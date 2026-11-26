/** spec-lookback-window checks for compare / backtest / stress / rebalance (filled in phase W2). */
export async function windowChecksLater(
  check: (name: string, ok: boolean, detail?: string) => void,
  ctx: { days: string[]; base: string[]; withIpo: string[]; ipoStart: number },
) {
  void check;
  void ctx;
}
