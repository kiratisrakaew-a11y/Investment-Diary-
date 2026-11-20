/**
 * PRICE_BASIS_BENCHMARK_SPEC §5: the two shared request fields (one definition for MCP, OpenAPI, REST and
 * services). Both optional: omitted = Settings' default, then the feature's own default (results unchanged).
 */
import { z } from "zod";

export const returnBasisField = z
  .enum(["price_return", "total_return"])
  .optional()
  .describe(
    "Price basis: price_return = closes (split-adjusted, no dividends); total_return = adjusted closes (splits + dividends). Omit = Settings default",
  );

export const benchmarkField = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .optional()
  .describe(
    'Benchmark index: "default" = this feature\'s usual index, "auto" = an index whose kind matches the price basis (TRI for total_return), or a stored index symbol such as SETTRI or ^SET.BK. Omit = Settings default',
  );

export const basisBenchmarkShape = {
  returnBasis: returnBasisField,
  benchmark: benchmarkField,
};
