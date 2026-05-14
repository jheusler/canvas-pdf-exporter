# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the script

```powershell
cd Desktop\canvas-pdf-exporter
npm install        # first time only
node export.js
```

The script opens a visible browser. If not logged in, the user logs in manually, then presses **ENTER** in the terminal to continue. Login persists across runs via `.browser-profile/`.

PDFs are saved to `./canvas-module-pdfs/` named `001 - Title.pdf`, `002 - Title.pdf`, etc.

## Architecture

Single-file script (`export.js`). No build step, no tests, no lint config. Only dependency is Puppeteer.

**Flow:**
1. Launch browser (`headless: false`, persistent `userDataDir`)
2. Navigate to `MODULES_URL`, pause for manual login
3. Reload modules page, expand all collapsed modules via `.collapse_module_link` / `.expand_module_link` selectors
4. `autoScroll()` the modules page to trigger lazy-load
5. Collect links via Canvas-specific selectors (`.ig-title`, `.item_link`, `li.context_module_item a.title`) with a fallback pass over all `li.context_module_item` elements
6. Deduplicate by `href`, filter with `IGNORE_PATTERNS` and `isValidLink()`
7. For each link: open new tab → `autoScroll()` → `page.pdf()` → close tab

**Key constants:**
- `MODULES_URL` — Canvas course modules page
- `OUTPUT_DIR` — `./canvas-module-pdfs`
- `USER_DATA_DIR` — `./.browser-profile` (persists Chrome session/cookies)

## Known core problem

The script captures **Canvas wrapper/shell content only**, not actual lesson body content. Lessons are typically embedded in iframes (SCORM, LTI external tools, Rustici player). The current `autoScroll()` scrolls `document.body` of the **outer** Canvas page — it does not enter the iframe.

**Root cause:** Lesson content lives inside a nested iframe (`/external_tools/` launch URLs), but `isValidLink()` currently filters those out, and even when a lesson tab opens, `autoScroll` runs on the outer frame rather than inside the content iframe.

**What needs fixing (do not rewrite — patch only):**
1. After navigating to a lesson page, detect iframe hierarchy: `page.frames()` or `page.$('iframe')`
2. Identify the content iframe (not the Canvas nav shell)
3. Call `autoScroll` inside that frame's context, or use `frame.evaluate()`
4. Wait for dynamic height to stabilize before calling `page.pdf()`
5. Before saving, validate that captured text is not just wrapper boilerplate ("This assignment does not count toward the final grade", "EXIT COURSE")

## Debugging a single lesson

Add a `--start` / `--end` flag or temporarily hardcode a slice of the `links` array to test one item:

```js
// Temporarily limit to lesson index 35 (0-based) for debugging:
const testLinks = links.slice(35, 36);
```

Run against lesson 36 ("Building Arrays - 2 - Creating Arrays with Array(n)") as the primary debug target before re-enabling batch export.

## Important constraints

- **Do not rewrite** into a generic scraper. Keep: Canvas login flow, module expansion, lesson discovery, PDF output.
- **Do not use Playwright** — Puppeteer only.
- **Do not mass-export** while the iframe capture issue is unresolved.
- The user is on **Windows PowerShell**. Keep all instructions PowerShell-compatible. Avoid Unix-only shell syntax.
- `package.json` has no `scripts` block yet — `npm start` and `npm run manual` do not work until scripts are added.
