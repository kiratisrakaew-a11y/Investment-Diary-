/**
 * Valuation smoke test (Playwright, against a running app). Widths 375 / 720 (≈1440 at 200% zoom) /
 * 768 / 1440, dim and light themes: no horizontal page scroll, no console errors, keyboard focus is
 * visible, and the staged-DCF switch works.
 * Usage: APP_PASSWORD=… BASE_URL=http://localhost:3000 node e2e/valuation-smoke.mjs [SYMBOL]
 * Read-only: it never saves anything.
 */
import { createRequire } from "node:module";

// require() also finds a globally installed Playwright (NODE_PATH); a local install works too.
const { chromium } = createRequire(import.meta.url)("playwright");

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const SYMBOL = process.argv[2] ?? "PTT";
const PAGES = ["/valuation", `/valuation/stock/${SYMBOL}`, `/valuation/new?symbol=${SYMBOL}`, `/valuation/new?symbol=${SYMBOL}&method=residual_income`, "/settings", "/data-quality"];
const WIDTHS = [375, 720, 768, 1440];
const failures = [];

const browser = await chromium.launch();
for (const theme of ["dim", "light"]) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript((t) => localStorage.setItem("theme", t), theme);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(`${BASE}/login`);
  await page.fill("#password", process.env.APP_PASSWORD ?? "");
  await page.keyboard.press("Enter");
  await page.waitForURL((u) => !u.toString().includes("/login"));
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of PAGES) {
      errors.length = 0;
      await page.goto(BASE + path, { waitUntil: "networkidle" });
      await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      // Tab until focus reaches the main content, then check the focus indicator is drawn.
      let focus = null;
      for (let i = 0; i < 40 && !focus; i++) {
        await page.keyboard.press("Tab");
        focus = await page.evaluate(() => {
          const el = document.activeElement;
          if (!el || !el.closest("main")) return null;
          // The indicator must come from focus itself: compare focused vs blurred styles.
          const look = () => {
            const cs = getComputedStyle(el);
            return `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor} | ${cs.boxShadow} | ${cs.borderColor}`;
          };
          const focused = look();
          const cs = getComputedStyle(el);
          const hasOutline = cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0;
          el.blur();
          const blurred = look();
          el.focus({ focusVisible: true });
          return { tag: el.tagName, ring: hasOutline || focused !== blurred };
        });
      }
      const label = `${theme} ${width}px ${path}`;
      if (overflow > 1) failures.push(`${label}: horizontal scroll ${overflow}px`);
      if (errors.length) failures.push(`${label}: console ${errors.slice(0, 2).join(" | ")}`);
      if (!focus) failures.push(`${label}: Tab never reached the main content`);
      else if (!focus.ring) failures.push(`${label}: no visible focus on ${focus.tag}`);
      console.log(`${overflow > 1 || errors.length || !focus?.ring ? "FAIL" : "ok  "} ${label}`);
    }
  }
  // Functional: switch the DCF editor to staged mode; three stages and a value must appear.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE}/valuation/new?symbol=${SYMBOL}`);
  await page.getByRole("radio", { name: "3-stage DCF" }).click();
  const rows = await page.locator("#val-forecast tbody tr").count();
  const value = await page.locator("#val-result .text-3xl").textContent();
  if (rows !== 3 || !/\d/.test(value ?? "")) failures.push(`${theme}: staged switch rows=${rows} value=${value}`);
  console.log(`${rows === 3 ? "ok  " : "FAIL"} ${theme} staged switch: ${rows} stages, value ${value}`);
  await ctx.close();
}
await browser.close();
console.log(failures.length ? `\n${failures.length} FAILED\n${failures.join("\n")}` : "\nALL PASSED");
process.exit(failures.length ? 1 : 0);
