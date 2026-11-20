/**
 * PRICE_BASIS_BENCHMARK_SPEC 6.6 — price basis / benchmark pickers (Playwright, against a running app).
 *  - server pages (overview, analytics, optimizer): changing the picker changes the URL and the summary line;
 *  - client panels (stress, model comparison, factor screen): the request body carries returnBasis / benchmark;
 *  - backtest: Adjusted Close is disabled, with the reason, for dividend strategies;
 *  - no horizontal scroll at 375 px and no page errors.
 * Usage: APP_PASSWORD=… BASE_URL=http://localhost:3000 [ABNORMAL_ASSET_ID=<thai stock id>] node e2e/price-basis-smoke.mjs
 * Read-only: it never saves anything.
 */
import { createRequire } from "node:module";

const { chromium } = createRequire(import.meta.url)("playwright");
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const failures = [];
const check = (name, ok, detail = "") => {
  if (!ok) failures.push(name);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const bodies = [];
page.on("request", (r) => {
  if (r.method() === "POST" && /stress|compare-models|strategies\/factors|portfolio\/backtest/.test(r.url()))
    bodies.push({ url: r.url(), body: r.postData() ?? "" });
});
await page.goto(`${BASE}/login`);
await page.fill("#password", process.env.APP_PASSWORD ?? "");
await page.keyboard.press("Enter");
await page.waitForURL((u) => !u.toString().includes("/login"));

const summary = async (scope = page) =>
  (await scope.locator("[data-testid=basis-summary]").first().innerText().catch(() => "")).split("\n")[0];

for (const path of ["/", "/analytics", "/optimizer"]) {
  await page.goto(BASE + path, { waitUntil: "networkidle" });
  const before = await summary();
  await page.locator("[data-testid=basis-benchmark-picker] select[name=returnBasis]").first().selectOption("total_return");
  await page.waitForURL(/basis=total_return/);
  await page.waitForLoadState("networkidle");
  await page.waitForFunction(() => document.querySelector("[data-testid=basis-summary]")?.textContent?.includes("Adjusted Close"), null, { timeout: 30000 }).catch(() => {});
  const after = await summary();
  check(`${path}: picker → URL ?basis=total_return and the summary line changes`, /Close/.test(before) && /Adjusted Close/.test(after), `${before} → ${after}`);
}

// Stress panel (analytics): body carries the choice.
await page.goto(`${BASE}/analytics?basis=total_return&bench=default`, { waitUntil: "networkidle" });
await page.getByRole("button", { name: "รันชุดสถานการณ์ตัวอย่าง" }).click();
await page.waitForTimeout(4000);
check("stress: request body has returnBasis / benchmark", bodies.some((b) => /stress/.test(b.url) && /"returnBasis":"total_return"/.test(b.body) && /"benchmark":"default"/.test(b.body)));

// Model comparison (optimizer tab): starts from the page values and sends them.
await page.goto(`${BASE}/optimizer?basis=total_return&bench=default`, { waitUntil: "networkidle" });
await page.getByRole("tab", { name: "เปรียบเทียบโมเดล" }).click();
const panel = page.locator("#panel-comparison");
check("compare: picker starts from the page values", (await panel.locator("select[name=returnBasis]").inputValue()) === "total_return");
await panel.getByRole("button", { name: /เปรียบเทียบ|รัน/ }).first().click();
await page.waitForTimeout(8000);
check("compare: request body has returnBasis / benchmark", bodies.some((b) => /compare-models/.test(b.url) && /"returnBasis":"total_return"/.test(b.body)));
check("compare: result shows the summary line", /Adjusted Close/.test(await summary(panel)));

// Backtest: Adjusted disabled with a reason for dividend strategies.
await page.goto(`${BASE}/backtest`, { waitUntil: "networkidle" });
const strat = page.locator("select").first();
const div = (await strat.locator("option").evaluateAll((os) => os.map((o) => o.value))).find((v) => v.startsWith("dividend_"));
await strat.selectOption(div);
const pk = page.locator("[data-testid=basis-benchmark-picker]").first();
check(
  "backtest: dividend strategy → Adjusted Close disabled with the reason",
  (await pk.locator("option[value=total_return]").evaluate((o) => o.disabled)) && /ป้องกันการนับปันผลซ้ำ/.test(await pk.innerText()),
);

// Factor screen: body carries returnBasis.
await page.goto(`${BASE}/factors`, { waitUntil: "networkidle" });
await page.locator("select[name=returnBasis]").selectOption("total_return");
await page.getByRole("button", { name: /คัดกรอง|รัน|ค้นหา|คำนวณ/ }).first().click();
await page.waitForTimeout(3000);
check("factors: request body has returnBasis", bodies.some((b) => /strategies\/factors/.test(b.url) && /"returnBasis":"total_return"/.test(b.body)));

// Abnormal trading (asset page): the basis choice reloads the overview with returnBasis / benchmark.
const ptt = process.env.ABNORMAL_ASSET_ID;
if (ptt) {
  const gets = [];
  page.on("request", (r) => r.url().includes("/abnormal") && gets.push(r.url()));
  await page.goto(`${BASE}/holdings/${ptt}`, { waitUntil: "networkidle" });
  await page.locator("[data-testid=settings-panel] summary").click();
  await page.locator("select[name=abnormalBasis]").selectOption("price_return");
  await page.waitForTimeout(3000);
  check("abnormal: basis choice → overview request carries returnBasis", gets.some((u) => /returnBasis=price_return/.test(u)));
}

// Phone width: the pickers do not cause horizontal scroll.
await page.setViewportSize({ width: 375, height: 800 });
for (const path of ["/", "/analytics", "/optimizer", "/backtest", "/settings", "/data-quality"]) {
  await page.goto(BASE + path, { waitUntil: "networkidle" });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(`${path} @375px: no horizontal scroll`, overflow <= 1, `${overflow}px`);
}
check("no page errors", errors.length === 0, errors.join(" | "));

await browser.close();
console.log(failures.length ? `${failures.length} FAILED` : "ALL PASSED");
process.exit(failures.length ? 1 : 0);
