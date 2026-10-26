import { api } from "@/server/api";
import { bondHoldings } from "@/server/services/bonds";

export const GET = api(async () => bondHoldings());
