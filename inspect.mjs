import { chromium } from "playwright";

const browser = await chromium.connectOverCDP(
  process.env.CDP_URL ?? "http://localhost:9222",
);
const context = browser.contexts()[0];
const page = context.pages().find((p) => p.url().includes("gemini.google.com"));

const out = await page.evaluate(() =>
  [...document.querySelectorAll("img")]
    .filter((e) => e.naturalWidth >= 200)
    .map((e) => {
      const p = [];
      for (let n = e; n && p.length < 9; n = n.parentElement) p.unshift(n.tagName.toLowerCase());
      return {
        cls: String(e.className).slice(0, 60),
        size: `${e.naturalWidth}x${e.naturalHeight}`,
        proto: (e.currentSrc || e.src || "").split(":")[0],
        inUserTurn: Boolean(e.closest("user-query, user-query-content, user-query-file-carousel")),
        path: p.join(">"),
      };
    }),
);
console.error(JSON.stringify(out, null, 2));

console.error("=== response containers present ===");
console.error(
  await page.evaluate(() =>
    ["model-response", "message-content", "response-container", "single-image", "generated-image-container", "image-carousel"]
      .map((t) => `${t}: ${document.querySelectorAll(t).length}`)
      .join("\n"),
  ),
);
process.exit(0);
