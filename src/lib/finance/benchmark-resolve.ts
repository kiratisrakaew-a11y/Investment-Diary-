/**
 * PRICE_BASIS_BENCHMARK_SPEC D2 / D4: which index a feature compares against (pure; data access injected).
 *  - "default"  the feature's own rule, unchanged:
 *               featureDefault "settings" → Settings' benchmark whatever its kind (a kind mismatch is a warning);
 *               featureDefault "basis"    → benchmarkForBasis' rule (Settings / SETTRI / ^SET.BK by kind).
 *  - "auto"     an index whose kind matches the wanted basis (chooseBenchmarkBasis over every registered index).
 *  - <symbol>   that index; a kind mismatch is computed with a warning; no data → BENCHMARK_NOT_FOUND, data that
 *               starts after the period → BENCHMARK_COVERAGE (both list the indexes the app has).
 */
import {
  basisMismatchWarning,
  chooseBenchmarkBasis,
  type BenchmarkBasis,
  type BenchmarkCandidate,
} from "./benchmark-basis";

export type BenchmarkKind = "price_index" | "total_return";
export type FeatureBenchmarkDefault = "settings" | "basis";

export interface BenchmarkInfo {
  symbol: string;
  kind: BenchmarkKind;
  label: string | null;
  from: string | null;
  to: string | null;
  days: number;
}

export interface ResolvedBenchmark {
  symbol: string;
  kind: BenchmarkKind;
  basis: BenchmarkBasis;
  wanted: BenchmarkBasis;
  source: "default" | "auto" | "explicit";
  series: [string, number][];
  warning: string | null;
}

export type BenchmarkErrorCode = "BENCHMARK_NOT_FOUND" | "BENCHMARK_COVERAGE";

export class BenchmarkError extends Error {
  constructor(
    public code: BenchmarkErrorCode,
    message: string,
    public available: string[],
  ) {
    super(message);
    this.name = "BenchmarkError";
  }
  /** Same shape as OptimizerError so API / MCP error handlers print the code and a hint. */
  get issue() {
    return {
      code: this.code,
      suggestion: this.available.length
        ? `ดัชนีที่มีในระบบ: ${this.available.join(", ")}`
        : "ยังไม่มีดัชนีในระบบ — นำเข้าด้วย import_prices target \"benchmark\"",
    };
  }
}

export interface BenchmarkContext {
  settings: { benchmarkSymbol: string; benchmarkKind: BenchmarkKind };
  /** Registered kinds (benchmark_meta). */
  registry: Map<string, BenchmarkKind>;
  /** Every index with data, for "auto" and for error messages. */
  list: BenchmarkInfo[];
  load(symbol: string, from?: string): Promise<[string, number][]>;
}

const basisOf = (k: BenchmarkKind): BenchmarkBasis =>
  k === "total_return" ? "total_return" : "price";
const WEEK = 7 * 86_400_000;
/** chooseBenchmarkBasis needs a start date; without one any series with two points counts as covering. */
const NO_START = "9999-12-31";

/** Settings' benchmark keeps Settings' kind (as before); then the registry; SETTRI is a TRI; else a price index. */
export function benchmarkKindOf(
  symbol: string,
  ctx: Pick<BenchmarkContext, "settings" | "registry">,
): BenchmarkKind {
  if (symbol === ctx.settings.benchmarkSymbol) return ctx.settings.benchmarkKind;
  const k = ctx.registry.get(symbol);
  if (k) return k;
  return symbol === "SETTRI" ? "total_return" : "price_index";
}

export function normalizeBenchmarkRequest(
  request: string | null | undefined,
): string {
  const r = (request ?? "").trim();
  if (!r) return "default";
  const lower = r.toLowerCase();
  if (lower === "default" || lower === "auto") return lower;
  return r.toUpperCase();
}

export async function resolveBenchmarkWith(
  opts: {
    request?: string | null;
    wanted: BenchmarkBasis;
    from?: string;
    featureDefault: FeatureBenchmarkDefault;
  },
  ctx: BenchmarkContext,
): Promise<ResolvedBenchmark | null> {
  const req = normalizeBenchmarkRequest(opts.request);
  const available = ctx.list.filter((b) => b.days > 0).map((b) => b.symbol);
  const { wanted, from } = opts;

  if (req === "default" && opts.featureDefault === "settings") {
    const symbol = ctx.settings.benchmarkSymbol;
    const kind = ctx.settings.benchmarkKind;
    const series = await ctx.load(symbol, from);
    return {
      symbol,
      kind,
      basis: basisOf(kind),
      wanted,
      source: "default",
      series,
      warning:
        basisOf(kind) === wanted ? null : basisMismatchWarning(wanted, symbol),
    };
  }

  if (req === "default" || req === "auto") {
    const order =
      req === "default"
        ? [ctx.settings.benchmarkSymbol, "SETTRI", "^SET.BK"]
        : [
            ctx.settings.benchmarkSymbol,
            "SETTRI",
            "^SET.BK",
            ...ctx.list.map((b) => b.symbol),
          ];
    const symbols = [...new Set(order)];
    const cands: BenchmarkCandidate[] = await Promise.all(
      symbols.map(async (symbol) => ({
        symbol,
        // "default" keeps benchmarkForBasis' fixed kinds exactly (registry edits never move old results).
        basis:
          req === "default" && symbol !== ctx.settings.benchmarkSymbol
            ? symbol === "SETTRI"
              ? "total_return"
              : "price"
            : basisOf(benchmarkKindOf(symbol, ctx)),
        series: await ctx.load(symbol, from),
      })),
    );
    const choice = chooseBenchmarkBasis(wanted, cands, from ?? NO_START);
    if (!choice) {
      if (req === "default") return null;
      throw new BenchmarkError(
        "BENCHMARK_NOT_FOUND",
        `ไม่มีดัชนีที่มีข้อมูลครอบคลุม${from ? `ตั้งแต่ ${from}` : ""} ให้เลือกอัตโนมัติ`,
        available,
      );
    }
    return {
      symbol: choice.symbol,
      kind: choice.kind,
      basis: choice.basis,
      wanted,
      source: req === "default" ? "default" : "auto",
      series: choice.series,
      warning: choice.warning,
    };
  }

  const symbol = req;
  const series = await ctx.load(symbol, from);
  if (series.length < 2)
    throw new BenchmarkError(
      "BENCHMARK_NOT_FOUND",
      `ไม่มีข้อมูลดัชนี ${symbol}${from ? ` ตั้งแต่ ${from}` : ""} ในระบบ`,
      available,
    );
  if (from && Date.parse(series[0][0]) > Date.parse(from) + WEEK)
    throw new BenchmarkError(
      "BENCHMARK_COVERAGE",
      `ข้อมูลดัชนี ${symbol} เริ่ม ${series[0][0]} — ไม่ครอบคลุมช่วงที่คำนวณซึ่งเริ่ม ${from}`,
      available,
    );
  const kind = benchmarkKindOf(symbol, ctx);
  return {
    symbol,
    kind,
    basis: basisOf(kind),
    wanted,
    source: "explicit",
    series,
    warning:
      basisOf(kind) === wanted ? null : basisMismatchWarning(wanted, symbol),
  };
}

/** The response block (§5) without the series. */
export function benchmarkReportOf(b: ResolvedBenchmark | null) {
  if (!b) return null;
  return {
    symbol: b.symbol,
    kind: b.kind,
    basis: b.basis,
    wanted: b.wanted,
    source: b.source,
    warning: b.warning,
  };
}
