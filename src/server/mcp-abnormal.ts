/**
 * MCP tools for abnormal-trading detection (Thai stocks): event study (AR/CAR), abnormal volume,
 * daily scan, company events and shares outstanding. Thin adapters over services/abnormal.ts and
 * services/stock-data.ts — the same services the UI and REST use. Outputs always state the model,
 * benchmark, period, n, warnings and that results are statistical signals, not proof of wrongdoing.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isCalendarDate } from "@/lib/finance/abnormal/scan";
import {
  getAbnormalVolume,
  runEventStudy,
  scanAbnormalTrading,
} from "./services/abnormal";
import {
  EVENT_TYPES,
  deleteEvent,
  eventInput,
  listEvents,
  recordEvent,
  setSharesOutstanding,
  sharesHistory,
  sharesOutstandingInput,
} from "./services/stock-data";
import { DISCLAIMER } from "@/lib/finance/abnormal/returns";

const isoDate = z.string().refine(isCalendarDate, "A real date in YYYY-MM-DD");
const symbol = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .describe(
    "Thai stock symbol as stored in the app, e.g. PLANB (the asset must exist, asset class thai_stock)",
  );
const windowSchema = z.tuple([z.number().int(), z.number().int()]);
const thresholds = z
  .object({
    notable: z.number().positive().optional(),
    abnormal: z.number().positive().optional(),
  })
  .optional()
  .describe(
    "Levels: |value| > notable = น่าสังเกต, > abnormal = ผิดปกติ (defaults 2 and 3). Do not lower them to force a result",
  );

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Safe = <A>(fn: (args: A) => Promise<unknown>) => (args: A) => Promise<any>;

export const ABNORMAL_TOOL_NAMES = [
  "run_event_study",
  "get_abnormal_volume",
  "scan_abnormal_trading",
  "list_events",
  "record_event",
  "delete_event",
  "set_shares_outstanding",
] as const;

export function registerAbnormalTools(server: McpServer, safe: Safe) {
  server.registerTool(
    "run_event_study",
    {
      title: "Event study: abnormal return around an event",
      description:
        "Abnormal return (AR) and cumulative abnormal return (CAR) of a Thai stock around one event date, with t-statistics (AR/σ(ε), CAR/(σ√L)), " +
        "plus CAR sub-windows (run-up before the news, announcement days) and abnormal-volume z-scores for the same days. " +
        "Estimation window default −250…−30 trading days (≥ 120 observations or an error with the reason), event window default −10…+10. " +
        "Models: market (OLS, default), dimson (lags −1/0/+1, for thinly traded stocks), market_adjusted. Benchmark: adjusted close vs SET TRI when imported, otherwise close vs the price index (warned). " +
        "Give eventDate or eventId (from list_events). Statistical signal only — not evidence of wrongdoing.",
      inputSchema: {
        symbol,
        eventDate: isoDate
          .optional()
          .describe(
            "Day the news became public; a non-trading day uses the next trading day",
          ),
        eventId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Event id from list_events (recorded events only)"),
        model: z
          .enum(["market", "dimson", "market_adjusted"])
          .default("market"),
        estimationWindow: windowSchema
          .optional()
          .describe(
            "[start, end] in trading days relative to day 0, default [-250, -30]",
          ),
        eventWindow: windowSchema
          .optional()
          .describe("[start, end], default [-10, 10]"),
        triSymbol: z
          .string()
          .trim()
          .min(1)
          .max(40)
          .optional()
          .describe(
            "Total return index symbol in benchmark data (default SETTRI)",
          ),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async (x) => runEventStudy(x)),
  );

  server.registerTool(
    "get_abnormal_volume",
    {
      title: "Abnormal trading volume (mean-adjusted)",
      description:
        "Daily abnormal volume z-scores of a Thai stock: V = ln(turnover + 0.00000255) with turnover = volume / shares outstanding (Campbell & Wasley 1996); " +
        "without a recorded share count it falls back to ln(volume + 1) with a warning (valid for this stock, not comparable across stocks). " +
        "z is against the stock's own estimation window (default −250…−30 trading days, ≥ 120 days). Returns flagged days; set includeDays for every day. Statistical signal only.",
      inputSchema: {
        symbol,
        from: isoDate.optional(),
        to: isoDate.optional(),
        thresholds,
        estimationWindow: windowSchema.optional(),
        includeDays: z
          .boolean()
          .default(false)
          .describe("Include every day's z (can be long)"),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ includeDays, ...x }) => {
      const r = await getAbnormalVolume(x);
      const { days, ...rest } = r;
      return {
        ...rest,
        benchmark: null,
        benchmarkNote:
          "abnormal volume ใช้ค่าเฉลี่ยในอดีตของหุ้นตัวเอง (mean-adjusted) ไม่ใช้ดัชนีตลาด",
        n: days.at(-1)?.n ?? 0,
        latest: days.at(-1) ?? null,
        ...(includeDays ? { days } : {}),
      };
    }),
  );

  server.registerTool(
    "scan_abnormal_trading",
    {
      title: "Daily scan for abnormal trading",
      description:
        "Scan Thai stocks (all non-archived thai_stock assets, or the given symbols) day by day over a date range with a rolling market model. " +
        "ผิดปกติ: (|t_AR| > 3 and volume z > 3) or |t of 5-day CAR| > 3; น่าสังเกต: same with 2. " +
        "Flags followed by a recorded event within 10 trading days are labelled 'ผิดปกติก่อน event X วัน'. Sorted by level, then strength. " +
        "Days without enough index history have no AR and are never flagged on returns (listed under volumeOnly if volume is high). Report results as found — statistical signals, not evidence of wrongdoing.",
      inputSchema: {
        symbols: z
          .array(symbol)
          .max(100)
          .optional()
          .describe("Omit to scan every non-archived Thai stock"),
        from: isoDate.optional(),
        to: isoDate.optional(),
        thresholds,
        estimationWindow: windowSchema.optional(),
        eventHorizon: z
          .number()
          .int()
          .min(1)
          .max(60)
          .optional()
          .describe(
            "Trading days after a flag to look for an event (default 10)",
          ),
        triSymbol: z.string().trim().min(1).max(40).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async (x) => scanAbnormalTrading(x)),
  );

  server.registerTool(
    "list_events",
    {
      title: "List company events",
      description:
        "Company events of a stock (earnings, M&A, XD, news, other), newest first. XD dates from dividend data are included read-only (id null).",
      inputSchema: {
        symbol,
        from: isoDate.optional(),
        to: isoDate.optional(),
        types: z.array(z.enum(EVENT_TYPES)).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async (x) => ({ events: await listEvents(x) })),
  );

  server.registerTool(
    "record_event",
    {
      title: "Record a company event",
      description:
        "Record a company event (earnings / ma / xd / news / other) on the date it became public, for event studies and the 'abnormal before event' label. " +
        "Use the date and description the user or a cited source gives — never guess a date.",
      inputSchema: eventInput.shape,
      annotations: { readOnlyHint: false },
    },
    safe(async (x) => recordEvent(x)),
  );

  server.registerTool(
    "delete_event",
    {
      title: "Delete a company event",
      description:
        "Permanently delete one recorded event by id (from list_events; XD rows from dividend data cannot be deleted here). Requires confirmDelete: true. Only when the user asks.",
      inputSchema: {
        id: z.number().int().positive(),
        symbol,
        confirmDelete: z.literal(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    safe(async ({ id, symbol: s }) => deleteEvent(id, s)),
  );

  server.registerTool(
    "set_shares_outstanding",
    {
      title: "Set shares outstanding",
      description:
        "Record a stock's total shares outstanding from a given effective date (used to turn volume into turnover). source is required. " +
        "Only use a figure the user gave or a cited source (SET company profile, annual report) — never estimate it. The same date replaces the earlier figure.",
      inputSchema: sharesOutstandingInput.shape,
      annotations: { readOnlyHint: false },
    },
    safe(async (x) => {
      const saved = await setSharesOutstanding(x);
      return {
        saved,
        history: await sharesHistory(saved.symbol),
        disclaimer: DISCLAIMER,
      };
    }),
  );
}
