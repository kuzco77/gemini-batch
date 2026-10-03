import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

function argOf(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const CDP_URL = argOf("cdp") ?? process.env.CDP_URL ?? "http://localhost:9222";
const IN_PATH = argOf("in") ?? process.env.IN_DIR ?? "./in";
const OUT_PATH = argOf("out") ?? process.env.OUT_DIR ?? "./out";
const PROMPT =
  argOf("prompt") ??
  process.env.PROMPT ??
  "Làm mịn da tự nhiên, giữ nguyên bố cục, ánh sáng, màu sắc và chi tiết tóc. Không đổi khuôn mặt.";
const FORCE = process.argv.includes("--force");
const GEN_TIMEOUT = Number(process.env.GEN_TIMEOUT ?? 240_000);
const UPLOAD_TIMEOUT = Number(process.env.UPLOAD_TIMEOUT ?? 90_000);
const DELAY_MS = Number(process.env.DELAY_MS ?? 8_000);
const MAX_RETRY = Number(process.env.MAX_RETRY ?? 2);
const MIN_IMAGE_PX = Number(process.env.MIN_IMAGE_PX ?? 256);

// Gemini ships UI changes often. When a run fails at a specific step,
// fix the matching entry here and re-run; nothing else needs to change.
// `node gemini-batch.mjs --probe` prints how many nodes each one matches.
const SEL = {
  fileInput:
    'input.hidden-file-input[accept="image/*"], input[type="file"][accept*="image"]',
  addButton:
    'button[aria-label*="add files" i], button[aria-label*="upload" i], button[aria-label*="tệp" i], button[aria-label*="thêm" i]',
  editor: 'rich-textarea div[contenteditable="true"], div[contenteditable="true"]',
  sendButton:
    'button[aria-label*="send" i], button[aria-label*="gửi" i], button.send-button',
  uploadedThumb:
    'img.gem-attachment-style-img, uploader-file-preview img, [class*="file-preview"] img',
  responseImage: "generated-image img, single-image img",
  stopButton: 'button[aria-label*="stop" i], button[aria-label*="dừng" i]',
};

const LIMIT_RE =
  /(reached your limit|usage limit|try again later|đã đạt giới hạn|hết lượt|quota)/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.error(`[${new Date().toISOString()}]`, ...a);

async function firstVisible(page, selector, timeout) {
  const loc = page.locator(selector).first();
  await loc.waitFor({ state: "visible", timeout });
  return loc;
}

async function newChat(page) {
  await page.goto("https://gemini.google.com/app", {
    waitUntil: "domcontentloaded",
  });
  await firstVisible(page, SEL.editor, 60_000);
  await sleep(1_500);
}

async function attachFile(page, filePath) {
  let input = page.locator(SEL.fileInput).first();
  if ((await input.count()) === 0) {
    await page.locator(SEL.addButton).first().click({ timeout: 15_000 });
    await sleep(1_000);
    input = page.locator(SEL.fileInput).first();
  }
  await input.setInputFiles(filePath);
  await firstVisible(page, SEL.uploadedThumb, UPLOAD_TIMEOUT);
  await sleep(2_000);
}

async function countResultImages(page) {
  return page.evaluate(
    ({ sel, minPx }) =>
      [...document.querySelectorAll(sel)].filter((i) => i.naturalWidth >= minPx)
        .length,
    { sel: SEL.responseImage, minPx: MIN_IMAGE_PX },
  );
}

async function sendPrompt(page) {
  const editor = await firstVisible(page, SEL.editor, 30_000);
  await editor.click();
  await editor.fill(PROMPT);
  await sleep(500);

  const send = page.locator(SEL.sendButton).first();
  if ((await send.count()) > 0 && (await send.isEnabled())) {
    await send.click();
  } else {
    await page.keyboard.press("Enter");
  }
}

async function assertNotRateLimited(page) {
  const body = await page.evaluate(() => document.body.innerText.slice(-4000));
  if (LIMIT_RE.test(body)) {
    throw Object.assign(new Error("RATE_LIMITED"), { fatal: true });
  }
}

async function waitForNewImage(page, baseline) {
  const deadline = Date.now() + GEN_TIMEOUT;
  while (Date.now() < deadline) {
    if ((await countResultImages(page)) > baseline) {
      await sleep(2_500); // let the final full-res src swap in
      return;
    }
    await assertNotRateLimited(page);
    await sleep(1_500);
  }
  throw new Error("TIMEOUT_WAITING_FOR_IMAGE");
}

// Gemini revokes the blob URL once the image is painted, so fetch() on it
// raises "Failed to fetch". Reading the pixels off a canvas always works:
// the blob is same-origin, so the canvas stays untainted.
async function grabLastImage(page) {
  return page.evaluate(
    ({ sel, minPx }) => {
      const imgs = [...document.querySelectorAll(sel)].filter(
        (i) => i.naturalWidth >= minPx,
      );
      const el = imgs.at(-1);
      if (!el) throw new Error("NO_IMAGE_NODE");

      const canvas = document.createElement("canvas");
      canvas.width = el.naturalWidth;
      canvas.height = el.naturalHeight;
      canvas.getContext("2d").drawImage(el, 0, 0);

      return {
        mime: "image/png",
        data: canvas.toDataURL("image/png").split(",")[1],
      };
    },
    { sel: SEL.responseImage, minPx: MIN_IMAGE_PX },
  );
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

// A truncated or non-PNG write means the canvas read went wrong. Catching it
// here keeps a corrupt file from being reported as a success.
function verifyPng(outPath) {
  const buf = fs.readFileSync(outPath);
  if (buf.length < 1000) throw new Error(`OUTPUT_TOO_SMALL_${buf.length}B`);
  if (!buf.subarray(0, 4).equals(PNG_MAGIC)) throw new Error("OUTPUT_NOT_PNG");
  return buf.length;
}

async function processOne(page, inputPath, outPath) {
  await newChat(page);
  await attachFile(page, inputPath);

  const baseline = await countResultImages(page);
  await sendPrompt(page);
  await waitForNewImage(page, baseline);

  const { data } = await grabLastImage(page);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, Buffer.from(data, "base64"));
  return { outPath, bytes: verifyPng(outPath) };
}

async function probe(page) {
  await page.goto("https://gemini.google.com/app", {
    waitUntil: "domcontentloaded",
  });
  await sleep(5_000);
  for (const [name, sel] of Object.entries(SEL)) {
    const n = await page.locator(sel).count();
    log(`${n === 0 ? "MISS" : "ok  "} ${name.padEnd(16)} ${n} -> ${sel}`);
  }
}

const IMAGE_RE = /\.(jpe?g|png|webp)$/i;
const outNameFor = (input) => `${path.parse(input).name}_out.png`;

// --in accepts a single image or a directory. --out follows: a path ending in
// .png names the file directly, anything else is treated as a directory.
function buildJobs() {
  const inIsFile = fs.statSync(IN_PATH).isFile();
  const outIsFile = /\.png$/i.test(OUT_PATH);

  if (outIsFile && !inIsFile) {
    throw new Error("--out is a .png file but --in is a directory");
  }

  if (inIsFile) {
    const output = outIsFile ? OUT_PATH : path.join(OUT_PATH, outNameFor(IN_PATH));
    return [{ input: IN_PATH, output }];
  }

  return fs
    .readdirSync(IN_PATH)
    .filter((f) => IMAGE_RE.test(f))
    .sort()
    .map((f) => ({
      input: path.join(IN_PATH, f),
      output: path.join(OUT_PATH, outNameFor(f)),
    }));
}

function writeReport(results) {
  const dir = path.dirname(results[0].output);
  fs.mkdirSync(dir, { recursive: true });
  const reportPath = path.join(dir, "report.json");
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      { finishedAt: new Date().toISOString(), prompt: PROMPT, results },
      null,
      2,
    ),
  );
  return reportPath;
}

async function main() {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];
  if (!context) throw new Error("No browser context on CDP endpoint");
  const page =
    context.pages().find((p) => p.url().includes("gemini.google.com")) ??
    context.pages().find((p) => p.url().startsWith("http")) ??
    (await context.newPage());
  await page.bringToFront();

  if (process.argv.includes("--probe")) {
    await probe(page);
    return 0;
  }

  const jobs = buildJobs();
  if (jobs.length === 0) {
    log(`No images found in ${IN_PATH}`);
    return 1;
  }

  const results = [];

  for (const [i, job] of jobs.entries()) {
    const tag = `[${i + 1}/${jobs.length}] ${path.basename(job.input)}`;

    if (!FORCE && fs.existsSync(job.output)) {
      log(`${tag} SKIP (output exists)`);
      results.push({ ...job, status: "skipped" });
      continue;
    }

    let lastErr;
    for (let attempt = 1; attempt <= MAX_RETRY + 1; attempt++) {
      try {
        const { outPath, bytes } = await processOne(page, job.input, job.output);
        log(`${tag} OK -> ${outPath} (${bytes} bytes)`);
        results.push({ ...job, status: "ok", bytes });
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        if (err.fatal) {
          log(`${tag} FATAL: ${err.message}. Re-run later to resume.`);
          results.push({ ...job, status: "failed", error: err.message });
          writeReport(results);
          return 2;
        }
        log(`${tag} attempt ${attempt} failed: ${err.message}`);
        await sleep(DELAY_MS * attempt);
      }
    }

    if (lastErr) {
      results.push({ ...job, status: "failed", error: lastErr.message });
    }
    await sleep(DELAY_MS);
  }

  const reportPath = writeReport(results);
  const count = (s) => results.filter((r) => r.status === s).length;
  log(
    `done=${count("ok")} skipped=${count("skipped")} failed=${count("failed")} report=${reportPath}`,
  );
  return count("failed") > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    log("FATAL", err);
    process.exit(2);
  });
