---
name: gemini-batch
description: Batch image editing through the gemini.google.com web UI by driving a signed-in Chrome over CDP with Playwright. Use when images must be edited with an account's Gemini quota instead of the paid Gemini API — retouching, inpainting, artifact removal, style changes across a folder of images. Not for text prompts, and not a replacement for the Gemini API when API access is available.
---

# gemini-batch

Drives a real signed-in Chrome at `gemini.google.com` to edit images in bulk:
upload an image, send an editing prompt, save the generated result to disk.
One chat per image, sequential, resumable.

Location: `~/Developer/Personal/gemini-batch`

## When to use this

Use it when the user needs Gemini's image editing but **cannot use the Gemini
API** — typically because they are paying for a Gemini account plan and want to
spend that quota rather than per-image API credits.

If the user can use the API, prefer `gemini-2.5-flash-image` via
`@google/genai` instead. It is an order of magnitude more reliable than any
browser automation: no selectors, no login state, no rate-limit guessing.
Say so once, then respect the user's decision.

Be aware that automating the Gemini web UI may conflict with Google's Terms of
Service. Mention this once for a new user or a large batch, then proceed.

## Prerequisites

1. Chrome running with remote debugging on port 9222, using the dedicated
   profile, **signed in to a Google account**:

   ```bash
   ~/Developer/Personal/gemini-batch/chrome.sh
   ```

   The script sets `--user-data-dir=$HOME/.gemini-batch-profile`. The session
   persists in that profile, so sign-in is a one-time manual step. Only
   re-authenticate if Google expires the session, the password changes, or the
   profile is deleted.

2. Verify the endpoint before running anything:

   ```bash
   curl -s -m 3 http://localhost:9222/json/version
   ```

   No response means Chrome is not running with the debug port. Ask the user to
   run `chrome.sh`; it opens a GUI window and needs a human for login, so do not
   try to launch and log in autonomously.

Never commit or sync `~/.gemini-batch-profile`. It holds a live Google session;
anyone who can read it can use the account.

## Running a batch

Prefer the flags — they take any path, so nothing has to be copied into the
project first.

Single image, exact output file:

```bash
node gemini-batch.mjs \
  --in ~/Downloads/photo.jpg \
  --out ~/Downloads/photo-fixed.png \
  --prompt "your editing instruction"
```

A whole folder:

```bash
node gemini-batch.mjs \
  --in ~/Downloads/raw \
  --out ~/Downloads/edited \
  --prompt "your editing instruction"
```

`--in` takes a file or a directory. `--out` ending in `.png` names the file
directly; anything else is a directory, and outputs land in it as
`<original-name>_out.png`. `--out` as a `.png` file with `--in` as a directory
is rejected. Output is always PNG — the pixels are read off a canvas.

Add `--force` to regenerate images whose output already exists.

### Configuration

Flags win over environment variables.

| Flag | Env | Default | Purpose |
|---|---|---|---|
| `--prompt` | `PROMPT` | a portrait skin-smoothing prompt | The editing instruction |
| `--in` | `IN_DIR` | `./in` | Source image or directory |
| `--out` | `OUT_DIR` | `./out` | Destination file or directory |
| `--cdp` | `CDP_URL` | `http://localhost:9222` | Chrome debug endpoint |
| `--force` | — | off | Overwrite existing outputs |
| — | `GEN_TIMEOUT` | `240000` | Max wait per image, ms |
| — | `DELAY_MS` | `8000` | Pause between images, ms |
| — | `MAX_RETRY` | `2` | Retries per image |

The default `PROMPT` targets portraits. It is wrong for most other images —
always set `PROMPT` explicitly to match the actual edit the user asked for.

### Knowing whether it worked

Three signals, cheapest first.

**Exit code.**

| Code | Meaning |
|---|---|
| `0` | Every image produced a verified PNG, or was skipped as already done |
| `1` | At least one image failed, or no images matched `--in` |
| `2` | Fatal — rate limited, bad path, or the browser connection died |

**Summary line**, last line on stderr:

```
done=1 skipped=0 failed=0 report=/path/to/out/report.json
```

**`report.json`**, written to the output directory on every run. One entry per
image with `status` of `ok`, `skipped`, or `failed`, plus `bytes` on success and
`error` on failure, and the exact prompt used:

```json
{
  "finishedAt": "2026-10-03T10:05:39.049Z",
  "prompt": "...",
  "results": [
    { "input": "/abs/in/photo.jpg", "output": "/abs/out/photo_out.png",
      "status": "ok", "bytes": 1259988 }
  ]
}
```

Scripted check:

```bash
node gemini-batch.mjs --in ... --out ... --prompt "..." || echo "FAILED: $?"
jq -r '.results[] | "\(.status)\t\(.output)"' out/report.json
```

Every saved file is checked for the PNG magic bytes and a sane size before being
counted as `ok`, so `status: "ok"` means a real PNG landed on disk.

That is the limit of what the script can prove. It cannot judge whether the edit
is any good. **Open the output and look at it** — confirm the requested change
happened and that everything meant to stay fixed actually did. Gemini will
sometimes return a lightly altered copy of the input, which passes every
automated check here.

### Writing the prompt

Gemini rewrites whatever is not pinned down. Name what must stay fixed, not
just what should change. A prompt that worked:

```
Khôi phục vùng bị nhòe và bệt màu ở góc dưới bên phải ảnh, tái tạo mặt đường
bê tông, vỉa hè lát gạch đỏ và thảm cỏ cho liền mạch với phần xung quanh.
Giữ nguyên toàn bộ phần còn lại của ảnh, giữ nguyên nhà xưởng, bùng binh hình
ngôi sao và chữ DAMSAN. Không đổi bố cục, góc chụp, màu sắc.
```

Structure: target region → what to reconstruct → named elements to preserve →
"do not change composition, camera angle, colors".

### Resuming

An image is skipped when its output file already exists. Safe to interrupt and
re-run. To regenerate, delete the output or pass `--force`.

Run sequentially. Do not parallelize — concurrent chats trip Gemini's rate
limits quickly and the script has no backoff for a hard block.

## Two non-obvious behaviours, already handled

Do not "fix" these back to the obvious implementation.

**Blob URLs are dead on arrival.** Gemini revokes the generated image's
`blob:` URL right after painting it, so `fetch(img.src)` always throws
`TypeError: Failed to fetch`. The pixels are read with
`canvas.drawImage()` + `toDataURL()` instead. The blob is same-origin, so the
canvas is untainted and this works.

**The uploaded image reappears in the DOM after sending.** It renders a second
time inside `user-query-file-carousel` with class `preview-image`, at full
resolution. A broad `img` selector matches it and silently saves the input back
out as the "result". `SEL.responseImage` is therefore scoped to
`generated-image img, single-image img`. Keep it scoped.

## When Gemini changes its DOM

This is the expected failure mode, not an edge case. Selectors live in one
`SEL` object at the top of `gemini-batch.mjs`. Verified working as of
2026-10-03:

```js
fileInput:     'input.hidden-file-input[accept="image/*"]'
uploadedThumb: 'img.gem-attachment-style-img'
sendButton:    'button[aria-label="Send message"]'
responseImage: 'generated-image img, single-image img'
```

Three debug scripts, in the order you need them:

```bash
node gemini-batch.mjs --probe      # match counts for every SEL entry, empty chat
node probe-live.mjs <image>        # upload path: menu items, file inputs, chip DOM
node probe-send.mjs <image> <out>  # full send cycle, dumps image candidates
node inspect.mjs                   # dump the current page's images + containers
```

`--probe` on an empty chat legitimately reports `MISS` for `uploadedThumb`,
`responseImage`, `sendButton`, and `fileInput` — those elements only exist after
an upload or a send. Only `editor` and `addButton` must match there. A `MISS` on
`editor` means the profile is signed out.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `connectOverCDP` refused | Chrome not running with debug port | User runs `chrome.sh` |
| Menu shows "Sign in to try tools" | Profile signed out | User signs in to that Chrome window |
| Timeout waiting for `editor` | Signed out, or Gemini changed the composer | Check sign-in, then `--probe` |
| `TIMEOUT_WAITING_FOR_IMAGE` | `responseImage` selector stale, or Gemini answered with text only | `inspect.mjs` on the live page; read `model-response` text to see if it refused |
| Output file is the input image | `responseImage` matched the user turn | Re-scope to `generated-image` |
| `RATE_LIMITED`, exit 2 | Account quota exhausted | Wait, re-run; resume skips finished images |
| `NO_IMAGE_NODE` | Image not painted yet | Raise `GEN_TIMEOUT` |
| `OUTPUT_NOT_PNG` / `OUTPUT_TOO_SMALL` | Canvas read returned garbage | Check the image actually finished loading; raise `GEN_TIMEOUT` |
| `No images found in <path>`, exit 1 | Wrong `--in`, or no `.jpg/.jpeg/.png/.webp` in it | Fix the path |

When generation times out, read the model's own reply before touching
selectors — Gemini sometimes answers in text and never produces an image:

```js
document.querySelector("model-response").innerText
```

## Verifying a result

Do not report success from the exit code alone. Read the output image back and
confirm the requested edit happened and the preserved elements survived. The
script cannot tell a good edit from a bad one.
