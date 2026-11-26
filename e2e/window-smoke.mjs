/**
 * spec-lookback-window UI smoke (Playwright, against a running app):
 *  - optimizer / analytics: choosing a period changes the URL (?win=…) and the window banner;
 *  - backtest / compare / stress: the request body carries `window`;
 *  - the coverage panel is shown; no horizontal scroll at 375 px; no page errors.
 * Usage: APP_PASSWORD=… BASE_URL=http://localhost:3000 node e2e/window-smoke.mjs   (read-only)
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
  if (r.method() === "POST" && /portfolio\/(backtest|compare-models|stress)/.test(r.url())) bodies.push({ url: r.url(), body: r.postData() ?? "" });
});
await page.goto(`${BASE}/login`);
await page.fill("#password", process.env.APP_PASSWORD ?? "");
await page.keyboard.press("Enter");
await page.waitForURL((u) => !u.toString().includes("/login"));

const banner = async () => (await page.locator("[data-testid=window-banner]").first().innerText().catch(() => "")).replace(/\n/g, " ");

for (const path of ["/optimizer", "/analytics"]) {
  await page.goto(BASE + path, { waitUntil: "networkidle" });
  const before = await banner();
  await page.locator("select[name=windowPreset]").first().selectOption("1y");
  await page.waitForURL(/win=1y/);
  await page.waitForLoadState("networkidle");
  await page.waitForFunction(() => document.querySelector("[data-testid=window-banner]")?.textContent?.includes("ขอ 1.0 ปี"), null, { timeout: 30000 }).catch(() => {});
  const after = await banner();
  check(`${path}: period picker → ?win=1y and the banner changes`, before !== after && /ขอ 1\.0 ปี/.test(after), `${before.slice(0, 60)} → ${after.slice(0, 60)}`);
  check(`${path}: coverage panel shown`, (await page.locator("[data-testid=coverage-panel]").count()) > 0);
}

await page.goto(`${BASE}/backtest`, { waitUntil: "networkidle" });
await page.locator("select[name=windowPreset]").first().selectOption("2y");
await page.getByRole("button", { name: /^รัน|^ทดสอบ|Backtest$/ }).first().click().catch(() => {});
await page.waitForTimeout(6000);
check("backtest: body carries window 2y", bodies.some((b) => /backtest/.test(b.url) && /"window":\{"preset":"2y"/.test(b.body)));
check("backtest: result banner", /ขอ 2\.0 ปี/.test(await banner()), await banner());

await page.goto(`${BASE}/optimizer`, { waitUntil: "networkidle" });
await page.getByRole("tab", { name: "เปรียบเทียบโมเดล" }).click();
const panel = page.locator("#panel-comparison");
await panel.locator("select[name=windowPreset]").selectOption("2y");
await panel.getByRole("button", { name: /เปรียบเทียบ|รัน/ }).first().click();
await page.waitForTimeout(8000);
check("compare: body carries window", bodies.some((b) => /compare-models/.test(b.url) && /"window":\{"preset":"2y"/.test(b.body)));

await page.goto(`${BASE}/analytics`, { waitUntil: "networkidle" });
const stress = page.getByRole("button", { name: "รันชุดสถานการณ์ตัวอย่าง" });
await stress.scrollIntoViewIfNeeded();
await stress.click();
await page.waitForTimeout(4000);
check("stress: body carries window", bodies.some((b) => /stress/.test(b.url) && /"window":\{"preset"/.test(b.body)));

await page.setViewportSize({ width: 375, height: 800 });
for (const path of ["/optimizer", "/analytics", "/backtest", "/settings"]) {
  await page.goto(BASE + path, { waitUntil: "networkidle" });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(`${path} @375px: no horizontal scroll`, overflow <= 1, `${overflow}px`);
}
check("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(failures.length ? `${failures.length} FAILED` : "ALL PASSED");
process.exit(failures.length ? 1 : 0);
