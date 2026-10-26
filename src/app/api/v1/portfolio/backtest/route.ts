import { api, jsonBody } from "@/server/api";
import { backtestPortfolio } from "@/server/services/backtest";

export const maxDuration = 60;

export const POST = api(async (req) => backtestPortfolio((await jsonBody(req)) as never));
