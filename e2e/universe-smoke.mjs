/**
 * spec-mpt-selected-universe UI smoke (Playwright, against a running app, read-only):
 *  - ?sel= drives the page: the coverage table / table rows / "ชุดสินทรัพย์ที่ใช้" list only the checked assets;
 *  - ticking / unticking changes ?sel= (after a short debounce) and the banner;
 *  - clearing everything blocks the run (no fallback to every asset);
 *  - the Rf / ERP box states the period unit; no horizontal scroll at 375 px; no page errors.
 * Usage: APP_PASSWORD=… BASE_URL=http://localhost:3000 node e2e/universe-smoke.mjs
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
await page.goto(`${BASE}/login`);
await page.fill("#password", process.env.APP_PASSWORD ?? "");
await page.keyboard.press("Enter");
await page.waitForURL((u) => !u.toString().includes("/login"));

await page.goto(`${BASE}/optimizer?sel=PTT,CPALL,K-FIXED,LB29DA`, { waitUntil: "networkidle" });
const syms = async () => (await page.locator("[data-testid=universe-used]").first().innerText().catch(() => "")).replace(/\s+/g, " ");
const used = await syms();
const list = (t) => (t.split("—")[1] ?? "").split(",").map((x) => x.trim()).filter(Boolean).sort().join(",");
check("only the checked assets are used", /4 ตัว/.test(used) && list(used) === "CPALL,K-FIXED,LB29DA,PTT", used);
const covRows = await page.locator("[data-testid=coverage-panel] tbody tr").allInnerTexts();
check("coverage table lists only the checked assets", covRows.length === 4 && !covRows.join(" ").match(/AAPL|GOLD/), `${covRows.length} rows`);
check("picker shows 4 / N selected", /4\s*\/\s*\d+ ตัว/.test(await page.locator("[data-testid=universe-picker] summary").innerText()));

// Untick one → ?sel= changes and the used list follows.
await page.locator("[data-testid=universe-picker] input[data-symbol=K-FIXED]").uncheck();
await page.waitForURL((u) => u.searchParams.get("sel") === "PTT,CPALL,LB29DA", { timeout: 15000 });
await page.waitForLoadState("networkidle");
await page.waitForFunction(() => /3 ตัว/.test(document.querySelector("[data-testid=universe-used]")?.textContent ?? ""), null, { timeout: 30000 }).catch(() => {});
const after2 = await syms();
check("unticking K-FIXED → sel without it and 3 assets used", /3 ตัว/.test(after2) && list(after2) === "CPALL,LB29DA,PTT", after2 || "(empty)");

// Add one back.
await page.locator("[data-testid=universe-picker] input[data-symbol=AAPL]").check();
await page.waitForURL((u) => (u.searchParams.get("sel") ?? "").includes("AAPL"), { timeout: 15000 });
await page.waitForLoadState("networkidle");
check("ticking AAPL → it joins sel", (new URL(page.url()).searchParams.get("sel") ?? "").split(",").includes("AAPL"));

// Clear → blocked, nothing computed for "every asset".
await page.goto(`${BASE}/optimizer?sel=`, { waitUntil: "networkidle" });
const body = await page.locator("main").innerText();
check("empty selection → message, no results", /ยังไม่ได้เลือกสินทรัพย์/.test(body) && (await page.locator("[data-testid=universe-used]").count()) === 0);
check("empty selection → picker still available (0 / N)", /0\s*\/\s*\d+ ตัว/.test(await page.locator("[data-testid=universe-picker] summary").innerText()));

// Period unit in the Rf / ERP box.
await page.goto(`${BASE}/optimizer?sel=PTT,CPALL,AAPL`, { waitUntil: "networkidle" });
const box = await page.locator("main").innerText();
check("Rf / ERP box states the unit (สัปดาห์ for a mixed-market set)", /\d+ สัปดาห์\)/.test(box) || /\d+ วัน\)/.test(box), (box.match(/\(\d+ (วัน|สัปดาห์|เดือน)\)/) ?? [""])[0]);

await page.setViewportSize({ width: 375, height: 800 });
await page.goto(`${BASE}/optimizer`, { waitUntil: "networkidle" });
check("@375px no horizontal scroll", (await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 1);
check("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(failures.length ? `${failures.length} FAILED` : "ALL PASSED");
process.exit(failures.length ? 1 : 0);
