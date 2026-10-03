import { chromium } from "playwright";
import fs from "node:fs";

const CDP_URL = process.env.CDP_URL ?? "http://localhost:9222";
const FILE = process.argv[2];
const OUT = process.argv[3] ?? "./out/probe-result.png";
const PROMPT = process.env.PROMPT ?? "Làm mịn ảnh này.";
const GEN_TIMEOUT = Number(process.env.GEN_TIMEOUT ?? 300_000);

const FILE_INPUT =
  'input.hidden-file-input[accept="image/*"], input[type="file"][accept*="image"]';
const ADD_BTN =
  'button[aria-label*="add files" i], button[aria-label*="upload" i], button[aria-label*="tệp" i], button[aria-label*="thêm" i]';
const EDITOR = 'rich-textarea div[contenteditable="true"], div[contenteditable="true"]';
const SEND = 'button[aria-label*="send" i], button[aria-label*="gửi" i]';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.error(...a);

// Any large <img> that is not the attachment chip we just uploaded.
const candidates = () =>
  [...document.querySelectorAll("img")]
    .filter(
      (e) =>
        e.naturalWidth >= 512 &&
        !e.className.includes("gem-attachment-style-img") &&
        e.offsetParent !== null,
    )
    .map((e) => {
      const p = [];
      for (let n = e; n && p.length < 7; n = n.parentElement) p.unshift(n.tagName.toLowerCase());
      return {
        cls: String(e.className).slice(0, 70),
        w: e.naturalWidth,
        h: e.naturalHeight,
        src: (e.currentSrc || e.src || "").slice(0, 50),
        path: p.join(">"),
      };
    });

const browser = await chromium.connectOverCDP(CDP_URL);
const context = browser.contexts()[0];
const page =
  context.pages().find((p) => p.url().includes("gemini.google.com")) ??
  (await context.newPage());
await page.bringToFront();

await page.goto("https://gemini.google.com/app", { waitUntil: "domcontentloaded" });
await page.locator(EDITOR).first().waitFor({ state: "visible", timeout: 60_000 });
await sleep(2_000);

log("upload...");
if ((await page.locator(FILE_INPUT).count()) === 0) {
  await page.locator(ADD_BTN).first().click();
  await sleep(1_500);
}
await page.locator(FILE_INPUT).first().setInputFiles(FILE);
await page
  .locator("img.gem-attachment-style-img")
  .first()
  .waitFor({ state: "visible", timeout: 90_000 });
await sleep(2_000);

log("prompt + send...");
const editor = page.locator(EDITOR).first();
await editor.click();
await editor.fill(PROMPT);
await sleep(800);
const send = page.locator(SEND).first();
if ((await send.count()) > 0 && (await send.isEnabled())) await send.click();
else await page.keyboard.press("Enter");

log("waiting for generated image...");
const deadline = Date.now() + GEN_TIMEOUT;
let found = null;
while (Date.now() < deadline) {
  const list = await page.evaluate(candidates);
  if (list.length > 0) {
    found = list;
    break;
  }
  const txt = await page.evaluate(() => document.body.innerText.slice(-3000));
  if (/(reached your limit|usage limit|try again later|đã đạt giới hạn|hết lượt)/i.test(txt)) {
    log("RATE LIMITED");
    process.exit(2);
  }
  process.stderr.write(".");
  await sleep(3_000);
}
log("");

if (!found) {
  log("TIMEOUT: no generated image found");
  log("all visible imgs:");
  log(JSON.stringify(await page.evaluate(() =>
    [...document.querySelectorAll("img")].filter((e) => e.offsetParent !== null)
      .map((e) => ({ cls: String(e.className).slice(0, 60), w: e.naturalWidth })),
  ), null, 2));
  process.exit(1);
}

log("=== generated image candidates ===");
log(JSON.stringify(found, null, 2));

await sleep(3_000);
const { mime, data } = await page.evaluate(async () => {
  const imgs = [...document.querySelectorAll("img")].filter(
    (e) =>
      e.naturalWidth >= 512 &&
      !e.className.includes("gem-attachment-style-img") &&
      e.offsetParent !== null,
  );
  const el = imgs.at(-1);
  const res = await fetch(el.currentSrc || el.src);
  const blob = await res.blob();
  const d = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error("READ_FAILED"));
    fr.onload = () => resolve(String(fr.result).split(",")[1]);
    fr.readAsDataURL(blob);
  });
  return { mime: blob.type || "image/png", data: d };
});

fs.writeFileSync(OUT, Buffer.from(data, "base64"));
log(`saved ${OUT} (${mime}, ${Buffer.from(data, "base64").length} bytes)`);
process.exit(0);
