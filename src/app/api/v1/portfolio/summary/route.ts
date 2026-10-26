import { api } from "@/server/api";
import { getPortfolioSummary } from "@/server/services/portfolio";

export const GET = api(async () => getPortfolioSummary());
