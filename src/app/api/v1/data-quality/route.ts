import { api } from "@/server/api";
import { dataQualityReport } from "@/server/services/data-quality";

export const GET = api(async () => dataQualityReport());
