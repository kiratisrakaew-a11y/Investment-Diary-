/** Helpers that keep the values sent to the "อธิบาย" button small: evenly sampled series and rounded numbers. */

export function downsample<T>(xs: T[], n = 24): T[] {
  if (xs.length <= n) return xs;
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(xs[Math.round((i * (xs.length - 1)) / (n - 1))]);
  return out;
}

/** Round every number to `digits` significant figures (deep); drops undefined fields. */
export function compact(v: unknown, digits = 5): unknown {
  if (typeof v === "number") return Number.isFinite(v) ? Number(v.toPrecision(digits)) : null;
  if (Array.isArray(v)) return v.map((x) => compact(x, digits));
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) o[k] = compact(x, digits);
    return o;
  }
  return v;
}
