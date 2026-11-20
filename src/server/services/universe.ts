/**
 * Candidate assets for optimize / compare / backtest — one rule for every tool:
 * non-cash, the requested symbols (or all), archived assets skipped with the reason.
 */
export const ARCHIVED_REASON =
  "เก็บถาวร — ไม่ถูกเลือกโดยค่าเริ่มต้น (นำกลับมาใช้งานที่หน้าสินทรัพย์)";

export function selectCandidates<
  A extends {
    symbol: string;
    assetClass: string;
    archivedAt?: Date | string | null;
  },
>(assets: A[], symbols?: string[]) {
  const wanted = symbols?.length
    ? new Set(symbols.map((s) => s.toUpperCase()))
    : null;
  const skipped: { symbol: string; reason: string }[] = [];
  const candidates = assets
    .filter(
      (a) =>
        a.assetClass !== "cash" &&
        (!wanted || wanted.has(a.symbol.toUpperCase())),
    )
    .filter((a) => {
      // Held assets cannot be archived, so holdings never vanish from a tool.
      if (a.archivedAt)
        skipped.push({ symbol: a.symbol, reason: ARCHIVED_REASON });
      return !a.archivedAt;
    });
  return { candidates, skipped, wanted };
}
