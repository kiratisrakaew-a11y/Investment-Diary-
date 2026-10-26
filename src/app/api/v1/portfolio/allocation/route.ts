import { api } from "@/server/api";
import { getAllocation } from "@/server/services/portfolio";

export const GET = api(async () => getAllocation());
