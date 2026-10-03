import { chromium } from "playwright";

const CDP_URL = process.env.CDP_URL ?? "http://localhost:9222";
const FILE = process.argv[2];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.error(...a);

const browser = await chromium.connectOverCDP(CDP_URL);
const context = browser.contexts()[0];
const page =
  context.pages().find((p) => p.url().includes("gemini.google.com")) ??
  (await context.newPage());
await page.bringToFront();

await page.goto("https://gemini.google.com/app", { waitUntil: "domcontentloaded" });
await sleep(4000);

log("=== STEP 1: click add button ===");
await page.locator('button[aria-label*="add files" i], button[aria-label*="upload" i], button[aria-label*="tệp" i], button[aria-label*="thêm" i]').first().click();
await sleep(1500);

const menu = await page.evaluate(() =>
  [...document.querySelectorAll('[role="menuitem"], [role="menu"] button, mat-menu button, .mat-mdc-menu-item')]
    .map((e) => ({
      tag: e.tagName.toLowerCase(),
      text: (e.innerText || "").trim().slice(0, 60),
      aria: e.getAttribute("aria-label"),
    }))
    .filter((e) => e.text || e.aria),
);
log(JSON.stringify(menu, null, 2));

log("=== STEP 2: file inputs now present ===");
log(await page.evaluate(() =>
  [...document.querySelectorAll('input[type="file"]')].map((e) => ({
    accept: e.accept,
    multiple: e.multiple,
    id: e.id,
    cls: e.className,
  })),
));

if (!FILE) {
  log("no file arg; stopping before upload");
  process.exit(0);
}

log("=== STEP 3: upload via filechooser ===");
await page
  .locator('input.hidden-file-input[accept="image/*"], input[type="file"][accept*="image"]')
  .first()
  .setInputFiles(FILE);
await sleep(6000);

log("=== STEP 4: DOM after upload (candidate preview nodes) ===");
log(JSON.stringify(await page.evaluate(() =>
  [...document.querySelectorAll("img, [class*='preview'], [class*='chip'], [class*='attach']")]
    .filter((e) => e.offsetParent !== null)
    .slice(0, 25)
    .map((e) => ({
      tag: e.tagName.toLowerCase(),
      cls: String(e.className).slice(0, 80),
      w: e.naturalWidth ?? null,
      src: (e.currentSrc || e.src || "").slice(0, 60),
      path: (() => {
        const p = [];
        for (let n = e; n && p.length < 5; n = n.parentElement) p.unshift(n.tagName.toLowerCase());
        return p.join(">");
      })(),
    })),
), null, 2));

log("=== STEP 5: send button candidates ===");
await page.locator('rich-textarea div[contenteditable="true"], div[contenteditable="true"]').first().fill("test prompt");
await sleep(1500);
log(JSON.stringify(await page.evaluate(() =>
  [...document.querySelectorAll("button")]
    .filter((e) => e.offsetParent !== null)
    .map((e) => ({ aria: e.getAttribute("aria-label"), cls: String(e.className).slice(0, 60), disabled: e.disabled }))
    .filter((e) => e.aria && /send|gửi|submit/i.test(e.aria)),
), null, 2));

log("=== done; prompt typed but NOT sent ===");
process.exit(0);
