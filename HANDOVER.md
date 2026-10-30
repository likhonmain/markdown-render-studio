# HANDOVER — Markdown Render Studio: session summary for the next AI

> **For the next AI:** read this file first, then [`WORK_PROGRESS.md`](WORK_PROGRESS.md).
> This file covers what happened, why and how. `WORK_PROGRESS.md` covers what is **left**: the test checklist, missing features and risks.
> Together they give you the full context to continue where the previous session stopped.

---

## 1. The project in one paragraph

**Markdown Render Studio** is a static TypeScript and Vite web app with no UI framework. You paste raw Markdown from an AI chat (ChatGPT, DeepSeek, Google AI Studio…) and it renders faithfully: GFM, tables and KaTeX math, styled like the DeepSeek Harness chat renderer. It shows **paginated A4/Letter pages** live, exports **PDF** through the browser print dialog, and also offers **Word copy** (rich clipboard HTML with MathML) and a native **.docx** download.

- Repo: `https://github.com/likhonmain/markdown-render-studio` (branch `main`; `gh-pages` serves the live site)
- Live site: https://likhonmain.github.io/markdown-render-studio/
- Local folder: `D:\Deepseek\Markdown` (Windows, PowerShell, Node 24, npm 11)
- Owner: Tanvir Ahamed Likhon (`likhonmain@gmail.com`). Commits use that identity, which is already configured.

**User priorities (important):**
- He uses the app mainly on **phones and tablets** and rarely on a PC. Mobile and touch support comes first.
- He wants **safe commits before big changes**.
- He wants **everything saved in the browser** so nothing is lost on a refresh or crash.
- He wants **suggestions** at the end of each round.
- He writes informally; reply in clear, simple English.

---

## 2. State before this session

Three commits existed on `main` (newest first):
```
2f08ba5 Start with empty editor by default; keep mobile bottom navigation always visible
09c8eb0 Mobile layout: bottom tabs, export tab, phone flow view, pinch zoom
64aa668 Markdown Render Studio: faithful AI Markdown render, paginated PDF, Word copy and .docx export
```
What the app could do then:
- Markdown editor (textarea) on the left, preview in the middle, page setup on the right.
- On phones: bottom tabs Edit / Preview / Setup / Export.
- The preview was **read-only**: you could only change it by editing the Markdown.
- Only the Markdown source and the settings were saved (localStorage).
- **Bug:** multiple spaces collapsed into one (normal HTML behaviour), and several blank lines collapsed into one paragraph gap.

---

## 3. What the user asked for in this session (the target)

1. **Fix:** keep repeated spaces and extra blank lines from pasted AI text.
2. **Commit and push that fix first**, so the code is safe before the big change.
3. **Big feature:** edit the **rendered page itself**, not the Markdown, in a Word-like way:
   - type, select, delete; Enter or space adds space above and below
   - must work well on **mobile and tablet**, and also on PC
   - **pictures:**
     - insert them with **crop** at insert time and later
     - **fixed on the page** by default: the picture must NOT move when text above it changes, and it pushes text above and below it like Word
     - an **"in line with text"** option as well
     - **align** (left, centre, right), **move anywhere**, **resize by dragging a corner**
   - select text and apply **colour** or **bold** from a toolbar
   - **autosave to browser storage** so nothing is lost on a refresh, crash or navigating away; export to PDF later
4. Test, **commit, push, update the live page** (`npm run deploy`), report back and give suggestions. The user will then ask for the next round.

---

## 4. What was done, in order

### Step 1: explored the code
I read every source file: `main.ts`, `markdown.ts`, `paginate.ts`, `settings.ts`, `docx.ts`, `wordcopy.ts`, the three CSS files, `index.html`, the README and `package.json`. I learned how rendering works:
`markdownToHtml()` → HTML string → laid out off-screen in `#measure` → `paginate()` clones blocks into `.page > .page-content` boxes, splitting paragraphs between lines and lists/tables between items/rows → shown in `#stage`, scaled by a CSS transform for zoom.

### Step 2: Fix 1, repeated spaces and blank lines ✅ committed
- `src/markdown.ts` → `preprocess()`: a run of **2 or more blank lines** becomes a `<!-- blank-lines:N -->` marker (N = blanks − 1). The marker is skipped inside code fences and math, and when the next line is indented 4+ spaces (an indented code block).
- `remarkHtmlAsText()` turns that marker into an empty paragraph node rendered as `<div class="blank-lines" data-lines="N" style="--n:N">`, with `data.blankLines = N` for the .docx writer.
- `rehypeDsh()`: in every text node outside `code`/`pre`, a run of N spaces becomes N−1 `&nbsp;` plus one normal space, so lines can still wrap.
- CSS (`markdown.css`): `.md .blank-lines` height = N line-heights minus the normal paragraph gap.
- `docx.ts`: a blankLines paragraph → N empty Word paragraphs. `wordcopy.ts`: → N `<p>&nbsp;</p>`.
- Checked in the browser (screenshot), built, **committed and pushed as `42e7146`** ("Preserve repeated spaces and extra blank lines in the render, PDF, Word copy and .docx").

### Step 3: designed the page editor
Key design decisions, with reasons:
- **One persistent `contenteditable` host (`#stage`)** instead of one per page. Pages are rebuilt *inside* it, so focus and the mobile keyboard are kept, and a selection can cross pages.
- **The document flow is the source of truth, not the pages.** After edits, the pages are joined back into one unpaginated HTML flow and paginated again. Fragments of a block split across pages carry a shared `data-sid`, so they can be re-joined.
- **Re-paginate lazily:** 650 ms after typing stops, and only when content overflows a page or space is freed. Caret marker `<span data-caret>` elements keep the cursor through a rebuild.
- **Two picture types, like Word:**
  - *Fixed* pictures (`floats`): stored as page index + x, y, width in mm. They are drawn absolutely positioned on the page, and the paginator receives "bands" (no-text zones) so text flows above and below them. That is the "fixed + pushes text" behaviour the user asked for.
  - *In-line* pictures: `<figure class="ed-fig">` blocks inside the text flow.
- **Storage:** IndexedDB for the document and the picture blobs, plus a synchronous localStorage copy of the document for crash safety. Images over 2400 px are downscaled.
- **Markdown ↔ page:** once the page is edited (`dirty`), the edited HTML wins. Markdown that only grows at the end is auto-appended; any other change shows a banner with three choices.
- **Exports** use the edited document. The .docx needed a new DOM-based writer, because the old one walks the Markdown AST.
- Kept the no-framework style and used `document.execCommand` for formatting. It is deprecated but universally supported and the simplest option for contenteditable.

### Step 4: implemented the feature 🟡 uncommitted
New files: `src/store.ts`, `src/flow.ts`, `src/crop.ts`, `src/editor.ts` (about 1,500 lines).
Rewrote `src/paginate.ts`. Modified `src/main.ts`, `src/docx.ts`, `src/settings.ts` (`editMode`), `index.html` (`#edit-bar`, `#edit-banner`), `src/styles/app.css` (large new section at the end) and `src/styles/print.css`.
The file-by-file explanation is in **`WORK_PROGRESS.md` → section 3, "Architecture of the new code"**.

### Step 5: partial testing (desktop Chrome via the automation browser)
- The app loads, the toolbar shows, typing works, and autosave works (status bar "Page edits saved"; localStorage key `mdstudio.doc.v1`).
- 25 × Enter pushed text onto a new page with the caret following. Backspace pulled it back and the page count returned to 3.
- **Bug found:** Enter inside bold text leaves an empty `<strong></strong>` that "eats" one Backspace. **Fix:** `cleanFlow()` in `flow.ts` removes empty inline wrappers. Built, **not re-tested**.
- Also added `normalizeEdits()` (in `flow.ts`, called from `extractFlow`). Enter copies `data-sid` and `split-*` classes onto new paragraphs, so markers are kept only on blocks that touch a page edge.
- Choosing a picture opens the crop dialog. Testing stopped there, at the user's request, because usage ran out.
- Toolbar layout fix: on desktop the toolbar wraps onto 2 rows; on mobile it is one row that scrolls sideways.

### Step 6: documentation
- `WORK_PROGRESS.md`: what is left, the full test checklist, missing features, risks and how to finish.
- `HANDOVER.md` (this file).

---

## 5. Current state (exactly where things stopped)

- **Git:** `main` is at `42e7146`, pushed. **Everything from Step 4 onwards is uncommitted** in the working tree. New untracked files: `src/editor.ts`, `src/flow.ts`, `src/store.ts`, `src/crop.ts`, `WORK_PROGRESS.md`, `HANDOVER.md`. Modified: `src/main.ts`, `src/paginate.ts`, `src/docx.ts`, `src/settings.ts`, `index.html`, `src/styles/app.css`, `src/styles/print.css`.
  **First thing to do:** `git checkout -b wip/page-editing && git add -A && git commit -m "WIP: direct page editing"`, so the work is safe.
- **Type-check:** `npx tsc --noEmit` passed at the end of the session. `npx vite build` passes. `dist/` holds the latest build and is gitignored.
- **Live site:** NOT updated. It doesn't even have Fix 1, because `npm run deploy` was never run.
- **No servers running.** All background jobs were stopped.
- **Progress:** about 85 % of the code written, about 25 % tested, about 60–65 % overall.

---

## 6. Environment gotchas (save yourself time)

- **`npx vite` (dev server) locks source files on this Windows machine.** File edits then fail with `EIO / ReplaceFileW`. Either stop the dev server before editing, or test with:
  `npx vite build && npx vite preview --port 5178 --host 127.0.0.1 --strictPort`, rebuilding after each change.
- In PowerShell, avoid `.Replace()` on code that contains backticks or `${}`. Template literals get mangled. Use a proper file-edit tool.
- `npm` prints a harmless warning: `Unknown env config "side-effects-cache"`.
- Git shows LF→CRLF warnings. They are harmless.
- To reset the app's stored data, run this in the browser console on the app page: `localStorage.clear(); indexedDB.deleteDatabase('mdstudio')`.
- Storage keys: `mdstudio.source.v1` (Markdown), `mdstudio.settings.v1`, `mdstudio.doc.v1` (edited page mirror), `mdstudio.pdfhint`. IndexedDB `mdstudio` → stores `kv` (key `doc`) and `images`.
- Phone layout switch point: `(max-width: 820px)` → `#app.mobile`, with `data-tab` = edit | preview | setup | export.
- Deploy: `npm run deploy` (builds, then pushes `dist/` to `gh-pages` with gh-pages).

---

## 7. Files to read, in this order

| # | File | Why |
|---|---|---|
| 1 | `HANDOVER.md` | This summary |
| 2 | `WORK_PROGRESS.md` | What is left: test checklist (section 5), missing features (section 6), risks (section 7), finishing steps (section 8) |
| 3 | `README.md` | What the app is and its features (the editing feature is not documented yet) |
| 4 | `index.html` | UI structure; `#stage`, `#edit-bar`, `#edit-banner`, the phone bottom nav |
| 5 | `src/main.ts` | Main controller: `render()`, `buildPages()`, `renderPages()`, `renderFlow()`, print/export functions, `initPageEditor()`, `boot()` |
| 6 | `src/editor.ts` | **The new page editor**, the heart of the feature (`PageEditor` class) |
| 7 | `src/flow.ts` | Joining pages into a flow, caret markers, picture markup, paste sanitising |
| 8 | `src/paginate.ts` | Paginator with picture bands, `data-sid` and regions |
| 9 | `src/store.ts` | IndexedDB / localStorage persistence and image helpers |
| 10 | `src/crop.ts` | Crop dialog |
| 11 | `src/docx.ts` | .docx writer: the Markdown path plus the new DOM path (`htmlToDocx`, `buildDom`) |
| 12 | `src/markdown.ts` | Markdown → HTML (Fix 1 is in `preprocess`, `remarkHtmlAsText` and `rehypeDsh`) |
| 13 | `src/settings.ts` | Settings type and defaults (`editMode` added) |
| 14 | `src/styles/app.css` (from "Page editing" to the end), `markdown.css`, `print.css` | Styling |
| 15 | `src/wordcopy.ts`, `src/omml.ts` | Only if you work on Word copy or equations |

Run `git diff 42e7146 --stat` to see every change since the last commit.

---

## 8. What to do next (short version; full details in `WORK_PROGRESS.md`)

1. Commit the WIP to a branch (section 5 above).
2. Re-test the Backspace-after-bold fix, then go through the **test checklist in `WORK_PROGRESS.md` section 5** (A text, B pictures, C persistence, D exports, E mobile/tablet, F page setup).
3. Implement the missing items in **`WORK_PROGRESS.md` section 6** (Flow-view notice for fixed pictures, re-clamping pictures after page-setup changes, the Word-copy picture fallback, the README).
4. Watch the risks in **`WORK_PROGRESS.md` section 7**.
5. `npm run build` → merge into `main` → `git push` → `npm run deploy` → check the live site on a phone and a tablet.
6. Report to the user in simple English. Include the suggestions from **`WORK_PROGRESS.md` section 9**, then wait for his next round of changes.
