/**
 * spec-mpt-selected-universe: the checked assets are an input of the optimizer page, carried in the URL.
 *  - no `sel` = every asset of the catalog (the previous default);
 *  - `sel=` (empty) = nothing selected — the run is blocked, never "all assets";
 *  - symbols outside the catalog are dropped.
 */
export function parseSelection(sel: string | undefined, catalog: string[]): string[] {
  if (sel === undefined) return [...catalog];
  const known = new Map(catalog.map((s) => [s.toUpperCase(), s]));
  const out: string[] = [];
  for (const raw of sel.split(",")) {
    const s = known.get(raw.trim().toUpperCase());
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/** The value written to ?sel= (all selected is written explicitly so the URL always states the universe). */
export const selectionToQuery = (selected: string[]) => selected.join(",");

/**
 * Benchmark the optimizer page passes explicitly: on total_return, an unchosen index ("default") becomes "auto"
 * (a total-return index, e.g. SETTRI, when one is stored) so β / CAPM do not fall back to a price index.
 */
export function pageBenchmark(returnBasis: "price_return" | "total_return", bench: string | undefined | null): string {
  const b = (bench ?? "").trim();
  if (!b || b === "default") return returnBasis === "total_return" ? "auto" : "default";
  return b;
}

/** "56 สัปดาห์" / "484 วัน" — the unit follows the sampling frequency. */
export function periodUnit(frequency: string | undefined | null): string {
  return frequency === "weekly" ? "สัปดาห์" : frequency === "monthly" ? "เดือน" : "วัน";
}
