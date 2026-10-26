import "dotenv/config";
import { updateAllPrices } from "../server/services/price-updater";

console.table(await updateAllPrices());
process.exit(0);
