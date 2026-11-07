// Records the WatchSeal demo against a running production server, logging every beat.
// usage: CHROME_PATH=/path/to/chrome node scripts/video/record-demo.mjs <baseUrl> <outDir>
// Needs playwright-core (npm i -D playwright-core) and a Chrome or Chromium binary.
import { chromium } from "playwright-core";
import { writeFileSync } from "node:fs";

const [, , base, outDir] = process.argv;
const W = 1600, H = 900;
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH,
  args: ["--no-sandbox", "--force-color-profile=srgb"],
});
const context = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: outDir, size: { width: W, height: H } } });

// A visible cursor with a click ripple, since headless recordings have none.
await context.addInitScript(() => {
  const install = () => {
    if (document.getElementById("__cursor")) return;
    const c = document.createElement("div");
    c.id = "__cursor";
    c.style.cssText = "position:fixed;left:0;top:0;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:rgba(255,255,255,.85);border:2.5px solid #0F2A36;box-shadow:0 1px 4px rgba(0,0,0,.35);z-index:2147483647;pointer-events:none;transition:transform .12s ease";
    document.body.appendChild(c);
    addEventListener("mousemove", (e) => { c.style.left = e.clientX + "px"; c.style.top = e.clientY + "px"; }, true);
    addEventListener("mousedown", () => { c.style.transform = "scale(.7)"; }, true);
    addEventListener("mouseup", () => { c.style.transform = "scale(1)"; }, true);
  };
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", install);
  else install();
});

const page = await context.newPage();
const t0 = Date.now();
const beats = [];
const beat = (label, kind = "action") => { beats.push({ t: (Date.now() - t0) / 1000, label, kind }); console.log(((Date.now() - t0) / 1000).toFixed(1), kind, label); };
const pause = (ms) => page.waitForTimeout(ms);
let mouse = { x: W / 2, y: H / 2 };

async function moveTo(locator) {
  await locator.scrollIntoViewIfNeeded();
  const b = await locator.boundingBox();
  const x = b.x + b.width / 2, y = b.y + b.height / 2;
  await page.mouse.move(x, y, { steps: Math.max(12, Math.round(Math.hypot(x - mouse.x, y - mouse.y) / 18)) });
  mouse = { x, y };
  await pause(220);
}
async function click(locator) {
  await moveTo(locator);
  await page.mouse.down();
  await pause(70);
  await page.mouse.up();
}
/** Waits for the engine to start and finish an action (the progress line comes and goes). */
async function settle(label, timeout = 300_000) {
  beat(label, "wait-start");
  await page.locator(".activity").first().waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  await page.locator(".activity").first().waitFor({ state: "detached", timeout });
  await pause(400);
  beat(label, "wait-end");
}
const scrollTo = (y) => page.evaluate((top) => window.scrollTo({ top, behavior: "smooth" }), y);

// ---- landing ----
beat("landing");
await page.goto(base + "/", { waitUntil: "load" });
await pause(3500);
await page.evaluate(() => document.getElementById("cetus").scrollIntoView({ behavior: "smooth", block: "start" }));
beat("landing: Cetus learning curve");
await pause(6000);
await page.mouse.wheel(0, 520);
await pause(4000);
await scrollTo(0);
await pause(1200);
await click(page.locator(".l-nav a"));
await page.waitForURL("**/dashboard");
await page.locator(".soundings").waitFor();
beat("dashboard");
await pause(2500);

// ---- add Cetus ----
await click(page.getByRole("button", { name: "Add protocol" }));
await pause(700);
await click(page.getByRole("button", { name: "Cetus CLMM from v9" }));
await pause(600);
await click(page.getByRole("button", { name: "Start watching" }));
await settle("add Cetus");
await pause(2500);

// ---- v10 ----
beat("v10: next upgrade");
await page.keyboard.press("n");
await settle("v10 analysis");
await pause(4500);
await click(page.getByRole("tab", { name: "Transaction" }));
beat("v10: transaction tab");
await pause(4000);
await click(page.getByRole("button", { name: "Compare without memory" }));
await settle("v10 compare");
await pause(5000);
await click(page.getByRole("button", { name: /Expected, trust signer/ }));
await settle("v10 label expected");
await pause(3000);

// ---- v11 ----
beat("v11: next upgrade");
await page.keyboard.press("n");
await settle("v11 analysis");
await pause(3500);
await click(page.locator("input.note"));
await page.locator("input.note").pressSequentially("Silent config change on exploit day", { delay: 45 });
await pause(500);
await click(page.getByRole("button", { name: "Suspicious", exact: true }));
await settle("v11 label suspicious");
await pause(2500);

// ---- rule ----
beat("rule");
await click(page.locator(".rule-form textarea"));
await page.locator(".rule-form textarea").pressSequentially("Always escalate new withdraw functions", { delay: 45 });
await pause(500);
await click(page.getByRole("button", { name: "Save rule" }));
await settle("rule saved");
await pause(2000);

// ---- v12 ----
beat("v12: next upgrade");
await page.keyboard.press("n");
await settle("v12 analysis");
await pause(3500);
await page.mouse.wheel(0, 380);
beat("v12: memory influence");
await pause(5000);
await page.mouse.wheel(0, -380);
await pause(800);
await click(page.getByRole("button", { name: "Compare without memory" }));
await settle("v12 compare");
await pause(4500);
await click(page.getByRole("button", { name: "Expected", exact: true }));
await settle("v12 label expected");
await pause(2000);

// ---- v13 ----
beat("v13: next upgrade");
await page.keyboard.press("n");
await settle("v13 analysis");
await pause(4000);
await click(page.getByRole("button", { name: "False positive", exact: true }));
await settle("v13 label false positive");
await pause(2000);

// ---- v14 ----
beat("v14: next upgrade");
await page.keyboard.press("n");
await settle("v14 analysis");
await pause(3000);
await click(page.getByRole("button", { name: "Compare without memory" }));
await settle("v14 compare");
beat("v14: payoff gauge");
await pause(6000);
await page.mouse.wheel(0, 380);
beat("v14: memory influence");
await pause(6000);
await page.mouse.wheel(0, -380);
await pause(1000);

// ---- close ----
beat("close: echogram");
await moveTo(page.locator(".echogram"));
await pause(5000);
await click(page.getByRole("tab", { name: "Ask the memory" }));
await pause(800);
await click(page.getByRole("button", { name: "Who is allowed to upgrade Cetus?" }));
beat("ask the memory", "wait-start");
await page.locator(".recall-list li").first().waitFor({ timeout: 60000 });
beat("ask the memory", "wait-end");
await pause(6500);
beat("end");

const video = page.video();
await context.close();
await browser.close();
const path = await video.path();
writeFileSync(outDir + "/beats.json", JSON.stringify({ video: path, beats }, null, 1));
console.log("video:", path);
