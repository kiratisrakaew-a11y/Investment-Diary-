/**
 * Thai mutual fund NAVs from the SEC Thailand Open API (free, register at
 * https://api-portal.sec.or.th to get a subscription key → env SEC_API_KEY).
 * The asset's `providerSymbol` must be the fund's SEC `proj_id`.
 */
const BASE = process.env.SEC_API_BASE ?? "https://api.sec.or.th";

function headers() {
  const key = process.env.SEC_API_KEY;
  if (!key) throw new Error("SEC_API_KEY is not set");
  return { "Ocp-Apim-Subscription-Key": key, "Content-Type": "application/json" };
}

/** NAV per unit for one day, or null on holidays / no data. */
export async function fetchFundNav(projId: string, date: string): Promise<number | null> {
  const res = await fetch(`${BASE}/FundDailyInfo/${encodeURIComponent(projId)}/dailynav/${date}`, { headers: headers() });
  if (res.status === 204 || res.status === 404) return null;
  if (!res.ok) throw new Error(`SEC API ${res.status}`);
  const text = await res.text();
  if (!text) return null;
  const data = JSON.parse(text) as { last_val?: number } | { last_val?: number }[];
  const row = Array.isArray(data) ? data[0] : data;
  return typeof row?.last_val === "number" ? row.last_val : null;
}

/** Most recent NAVs going back up to `days` calendar days. */
export async function fetchRecentFundNavs(projId: string, days = 7): Promise<{ date: string; close: number }[]> {
  const out: { date: string; close: number }[] = [];
  for (let i = days; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86_400_000);
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    const date = d.toISOString().slice(0, 10);
    const nav = await fetchFundNav(projId, date);
    if (nav != null) out.push({ date, close: nav });
  }
  return out;
}

/** Search funds by (part of) their name / abbreviation to find the proj_id. */
export async function searchFunds(name: string): Promise<{ projId: string; abbr: string; name: string }[]> {
  const res = await fetch(`${BASE}/FundFactsheet/fund`, { method: "POST", headers: headers(), body: JSON.stringify({ name }) });
  if (!res.ok) throw new Error(`SEC API ${res.status}`);
  const rows = (await res.json()) as { proj_id: string; proj_abbr_name: string; proj_name_th: string }[];
  return rows.map((r) => ({ projId: r.proj_id, abbr: r.proj_abbr_name, name: r.proj_name_th }));
}
