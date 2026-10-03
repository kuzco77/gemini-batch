#!/usr/bin/env bash
# Launch a debuggable Chrome with a dedicated profile.
# Log in to Google once in this window; the profile keeps the session.
set -euo pipefail

PROFILE="${PROFILE:-$HOME/.gemini-batch-profile}"
PORT="${PORT:-9222}"

exec "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$PROFILE" \
  --no-first-run \
  --no-default-browser-check \
  "https://gemini.google.com/app"
