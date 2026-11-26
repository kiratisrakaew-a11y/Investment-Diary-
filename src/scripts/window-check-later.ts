/** spec-lookback-window checks for compare / backtest / stress / rebalance (TEST-LOCAL PBW-* data). */
import { backtestPortfolio } from "../server/services/backtest";
import { comparePortfolioModels } from "../server/services/model-comparison";
import { stressTestPortfolio } from "../server/services/stress";
import { rebalancePortfolio } from "../server/services/rebalance";
import { WindowError } from "../lib/finance/window";
import { getSettings, saveSettings } from "../server/services/settings";
import { getDb, schema } from "../db";

export async function windowChecksLater(
  check: (name: string, ok: boolean, detail?: string) => void,
  ctx: { days: string[]; base: string[]; withIpo: string[]; ipoStart: number },
) {
  const { days, base, withIpo, ipoStart } = ctx;
  const code = async (f: () => Promise<unknown>) => {
    try {
      await f();
      return null;
    } catch (e) {
      return e instanceof WindowError ? e.code : String(e).slice(0, 80);
    }
  };

  // Backtest: window 3y → the test period is the last 3 years; legacy startDate == custom window.
  const bt = await backtestPortfolio({ strategy: "equal_weight", symbols: base, window: { preset: "3y" } });
  const wi = bt.windowInfo!;
  check(
    "W2 backtest window 3y → effective ≈ 3 years ending on the last price date",
    wi.requested.preset === "3y" && Math.abs(wi.effective!.years - 3) < 0.05 && wi.effective!.endDate === days[days.length - 1],
    `${wi.effective?.startDate} → ${wi.effective?.endDate}`,
  );
  const legacy = await backtestPortfolio({ strategy: "equal_weight", symbols: base, startDate: wi.requested.startDate! });
  check("W2 backtest legacy startDate == window custom (metrics)", JSON.stringify(legacy.metrics) === JSON.stringify(bt.metrics));
  check(
    "W2 backtest window + startDate → WINDOW_CONFLICT",
    (await code(() => backtestPortfolio({ strategy: "equal_weight", symbols: base, window: { preset: "1y" }, startDate: days[0] }))) === "WINDOW_CONFLICT",
  );
  const btIpo = await backtestPortfolio({ strategy: "equal_weight", symbols: withIpo, window: { preset: "3y" } });
  check(
    "W2 backtest: a late listing is named in windowInfo.limitedBy",
    btIpo.windowInfo!.limitedBy.some((l) => l.symbol === "PBW-IPO" && l.firstDate === days[ipoStart]),
  );

  // Compare: trainingWindow { years } → observations from the data; window endDate in the past.
  const past = days[days.length - 300];
  const cmp = await comparePortfolioModels({
    symbols: base,
    window: { preset: "3y", endDate: past },
    trainingWindow: { years: 1 },
    models: ["equal_weight", "min_variance"],
  } as never);
  check(
    "W2 compare: trainingWindow 1 year ≈ observations per year; nothing after window.endDate",
    Math.abs(cmp.input.windowDays - 261) <= 3 && cmp.period.to <= past && cmp.windowInfo!.requested.endDate === past,
    `windowDays ${cmp.input.windowDays}, to ${cmp.period.to}`,
  );

  // Stress / rebalance carry the window too.
  const st = await stressTestPortfolio({ window: { preset: "1y" } });
  check("W2 stress: window → windowInfo (1y)", st.windowInfo?.requested.preset === "1y" && (st.windowInfo?.effective?.years ?? 0) <= 1.01);
  check("W2 stress: window + lookbackDays → WINDOW_CONFLICT", (await code(() => stressTestPortfolio({ window: { preset: "1y" }, lookbackDays: 365 }))) === "WINDOW_CONFLICT");
  const rb = await rebalancePortfolio({ targets: { "PBW-A": 0.5, "PBW-B": 0.5 }, optimizer: { window: { preset: "2y" } } } as never);
  // 8.3: a changed Rf / ERP needs source + date; other settings save normally.
  const before = await getSettings();
  const r1 = await saveSettings({ riskFreeRate: before.riskFreeRate + 0.5, benchmarkSymbol: before.benchmarkSymbol, rfSource: null, rfAsOf: null }).then(() => null, (e: Error) => e.message);
  const r2 = await saveSettings({ riskFreeRate: before.riskFreeRate, benchmarkSymbol: before.benchmarkSymbol, minObsPerAsset: before.minObsPerAsset }).then(() => null, (e: Error) => e.message);
  const r3 = await saveSettings({ riskFreeRate: before.riskFreeRate + 0.5, benchmarkSymbol: before.benchmarkSymbol, rfSource: "TEST source", rfAsOf: "2026-11-20" }).then(() => null, (e: Error) => e.message);
  // Restore exactly (bypassing the guard: the original values may be illustrative).
  await getDb().update(schema.settings).set({ riskFreeRate: before.riskFreeRate, rfSource: before.rfSource, rfAsOf: before.rfAsOf });
  check(
    "8.3 changed Rf without source / date → refused; unchanged Rf saves; with source + date saves",
    !!r1 && /แหล่งที่มา/.test(r1) && r2 === null && r3 === null && (await getSettings()).riskFreeRate === before.riskFreeRate,
    r1 ?? "",
  );
  check("W2 rebalance: optimizer.window drives the tracking-error covariance period", (rb as { windowInfo?: { requested: { preset: string } } | null }).windowInfo?.requested.preset === "2y");
}
