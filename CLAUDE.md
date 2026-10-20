# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

APPGuide overlays step-by-step operation guides (highlight + tooltip bubble) on real third-party business web pages via a Chrome MV3 extension, without changing the target site. Guides are stored as **flows**: `flow → pages[] (matched by URL) → steps[]`. Code comments, docs, UI text and commit messages are in Chinese; keep that convention.

Active development is in `plugin-review/`. Background docs: `docs/APPGuide_系统功能说明.md` (system overview) and `docs/服务端接口规格书.md` (API spec the production PHP backend implements).

## Commands

There is no test suite. `npm run lint` is `tsc --noEmit` (TypeScript only; the extension is plain JS).

- `npm run dev:guide`: run `guide_server.ts` on port 3010 (the backend the extension uses). Set `SKIP_DB=true` to serve flows from `api/flows/*.json` instead of MySQL.
- `npm run build:guide`: bundle it to `dist/guide_server.cjs`. Production runs it as the systemd unit `guide-server` (see `how to run.md`).
- `npm run build:plugin-review`: obfuscate JS + minify CSS from `plugin-review/` into `dist/plugin-review/`. `npm run build:plugin` does the same for `plugin/`.
- `npm run dev`: DevKit server (`server.ts`, port 3000, Vite middleware + Gemini). Needs `GEMINI_API_KEY`.

To test the extension, load `plugin-review/` (unbuilt) as an unpacked extension in Chrome. Set the API base URL in its popup (default `https://api.skillcloud.cn`, or `http://localhost:3010` for local). Set `window.__appguideReviewDebug = true` in the page for semantic-matcher debug logging.

## Components

- **`plugin-review/`**: the review ("审核") extension, shortcut Alt+C. A human walks each flow step by step, confirms the auto-located element ("定位正确") or picks the right one ("修改定位", pick mode), edits titles and descriptions, deletes steps, then submits the whole flow's steps back. Each confirmed step records `selector`, `controlType`, `parameters` and, inside an iframe, `frameSelector`.
- **`plugin/`**: the end-user guide extension, shortcut Alt+G. It is gitignored and no longer tracked; `plugin-review/background.js` comments refer to it as the sibling to keep consistent.
- **`guide_server.ts`**: Express + MySQL (`appguide` table; the flow lives in the `steps` JSON column). When the DB is unreachable it falls back to the local JSON files.
- **`server.ts` + `src/`**: the original Google AI Studio "Guide DevKit" (React 19 / Vite 6 / Tailwind 4 simulator and editor). It is legacy and uses its own single-page `Guide` model (`src/types.ts`), not flows.

## Architecture of `plugin-review`

**Message flow.** `content.js` never fetches directly. It sends `chrome.runtime.sendMessage({action: ...})` to `background.js`, which calls `${apiBaseUrl}/rest?method=appguide.flows.<name>` from the extension origin to avoid mixed-content blocking. Action names shared across files are listed in `RESERVED_STRINGS` in `scripts/build-plugin.mjs`.

**Backend mismatch.** Local `guide_server.ts` implements `GET /rest` for `guide | bystarturl | byid | bypattern`, and `POST /rest?method=` for `corrections | stats`. It does **not** implement `appguide.flows.updatesteps`, which the review plugin POSTs with `method` in the JSON body. It also does not implement GET `stats`. Submitting a review only works against the production backend, unless you add those routes.

**Flow resolution** (`/api/guide`, and mirrored on the server):
- Branch A: an in-progress `flowId` is given and the URL matches one of its pages → `resume`.
- Branch B: otherwise match on `starturl` → `not_found` / `new` / `choose` (several candidates).

`pageIndex`, `globalStepNumber` and `totalSteps` are computed when the flow is read, never stored.

URL matching (`urlsMatch` server-side, `urlsMatchClient` in `content.js`) is implemented twice and must stay in sync:
- host is normalized, ignoring `www.`;
- both URLs must have the same number of path segments;
- each segment must be equal, or both sides must look like dynamic IDs (`looksLikeDynamicId`).

**Cross-page state.** Two `chrome.storage.local` keys hold state across pages, with a 2-hour TTL:
- `guideReview_flowState`: `{flowId, globalStepNumber, lastActiveAt}`.
- `guideReview_flowData`: the full flow JSON being edited. The in-memory copy is `_fullFlowData`, and `recordStepSelector` writes confirmations into it.

On page load the script silently auto-resumes, but only when the server answers `resume`.

**Locating a step's element** (`attemptResolveStep`):
1. Exact `selector` match, checked across the page and its frames.
2. S0: the normalized full title (or `clickText`) equals a control's label.
3. S1–S3 semantic match over `scanDOM()` candidates: keyword containment, then character overlap, then TF-IDF cosine with Chinese uni/bi-gram tokenization.

Retries use `LOCAL_RETRY_COUNT`. Each render bumps `renderRequestToken`, and async work belonging to an older render checks the token and aborts. `usedElements` makes later steps prefer elements no earlier step has used.

**iframes.** `content.js` is injected into every frame (`all_frames: true`) and branches on `IS_TOP_FRAME`. The top frame owns the UI. Iframe workers run matching and pick mode locally, and generate selectors in their own document context. Frames talk via `postMessage` with the marker `__appguide_review: true` and a `type` (`pick-request` / `pick-approve` / `pick-retry` / `clear-highlight` / probe messages). When a step lives in an iframe, `frameSelector` is the `<iframe>` element's selector in the top document, and `selector` is relative to the iframe.

**Selector generation** (`generateStableSelector`): first a unique non-auto-generated `id`, then stable classes, then a structural path. IDs that look auto-generated by Vue/React, and utility classes, are skipped (`isAutoGeneratedId`, `isUtilityClass`).
