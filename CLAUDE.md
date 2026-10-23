# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

APPGuide: a Chrome extension (MV3) that overlays step-by-step highlight guides on third-party business systems (bank/ERP pages) without modifying them, plus the backend that serves those guides. Docs and comments are in Chinese; `docs/APPGuide_系统功能说明.md` is the system overview.

## Commands

- `npm run dev:guide` — run the plugin-facing guide server (`guide_server.ts`, port 3010) via tsx. Set `SKIP_DB=true` to serve flows from `api/flows/*.json` instead of MySQL.
- `npm run build:plugin` — obfuscate JS / minify CSS from `plugin/` into `dist/plugin/` (load that folder unpacked in Chrome).
- `npm run dev` — DevKit editor (`server.ts`, port 3000, Express + Vite middleware, Gemini via `GEMINI_API_KEY`).
- `npm run build:guide` / `npm run start:guide` — bundle and run the guide server from `dist/`.
- `npm run lint` — `tsc --noEmit`; the only automated check. There is no test suite in the repo.

## Architecture

Three largely independent parts:

1. **`plugin/`** (plain JS, no bundler) — the product.
   - `content.js` injects into every page/frame, renders highlights and bubbles, and runs the local semantic matcher that finds controls when a step has no working `selector`.
   - `content.js` never fetches directly. It `chrome.runtime.sendMessage`s an `action` to `background.js`, which calls `<apiBaseUrl>/rest?method=appguide.xxx` (to bypass mixed content). The API base URL is stored in `chrome.storage.local.appguide_apiBaseUrl` (set in `popup.js`) and defaults to `https://api.skillcloud.cn`.
   - Cross-page flow progress persists in `chrome.storage.local` (`flowId`, `globalStepNumber`, `lastActiveAt`, 2h TTL), because page navigation destroys content-script state.
   - New message `action` strings shared between `background.js` / `content.js` / `popup.js` go into `RESERVED_STRINGS` in `scripts/build-plugin.mjs`.
2. **`guide_server.ts`** — Express + MySQL (`appguide` table; `steps` JSON column holds `{title, pages[]}`).
   - It is the reference implementation: production runs a PHP port, specified in `docs/服务端接口规格书.md`. Any API/behavior change here must be mirrored in that spec doc.
   - `/api/*` routes are the canonical handlers. `GET/POST /rest?method=appguide.*` is the unified entry the plugin actually uses; it re-dispatches to `/api/*` via `app.handle`.
   - `POST /rest` also accepts `method` in the JSON body. A frozen external client (`GuideManage/plugin-review`) depends on both shapes, so keep them working.
   - When the DB is unavailable, flow loaders return `null` and callers fall back to `api/flows/*.json`.
   - URL matching (`urlsMatch` / `looksLikeDynamicId`) compares host + path segments and treats ID-like segments as wildcards. SQL `LIKE` on host is only a prefilter.
   - `pageIndex` / `globalStepNumber` are computed at read time from the `pages` array order, never stored.
   - The RPA bridge (`appguide.rpa.*`) proxies to guidedatamanager with `RPA_BRIDGE_BASE_URL` / `RPA_BRIDGE_API_KEY`, kept server-side only. If either is missing, the bridge returns 503. `appguide.rpa.run` forces `mode: "write_keep"`.
3. **DevKit** (`src/`, `server.ts`, React 19 + Vite 6 + Tailwind 4) — an AI Studio–generated guide editor/simulator with its own in-memory guide API and Gemini generation. It is separate from the guide server's data model and rarely touched.
