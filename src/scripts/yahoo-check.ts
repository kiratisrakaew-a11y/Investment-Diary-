import { fetchDailyCloses } from "../lib/prices/yahoo";

const from = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10);
for (const s of ["PTT.BK", "^SET.BK", "AAPL", "GC=F", "THB=X"]) {
  try {
    const rows = await fetchDailyCloses(s, from);
    console.log(s, rows.slice(-2));
  } catch (e) {
    console.log(s, "ERR", (e as Error).message.slice(0, 200));
  }
}
