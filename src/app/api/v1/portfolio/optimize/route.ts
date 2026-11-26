import { api, jsonBody } from "@/server/api";
import { optimizeInput } from "@/server/optimize-schema";
import { optimizePortfolio, previewOptimizeWindow } from "@/server/services/optimizer";

export const POST = api(async (req) => {
  const p = optimizeInput.parse(await jsonBody(req));
  // dryRun: period + per-asset coverage only (no solver) — used by the coverage panel.
  return p.dryRun ? previewOptimizeWindow(p) : optimizePortfolio(p);
});
