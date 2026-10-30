# TEST PLAN — scroll-jump fix, page → Markdown sync, pen / highlighter / eraser

> **For the testing model.** Code is written, type-checks (`npx tsc --noEmit`) and builds (`npx vite build`).
> **Nothing has been tested in a browser yet.** Your job: run every check below, fix what fails, and report.
> **Do NOT commit or push to GitHub.** The owner reviews the changes first and will push himself.

Context: read `HANDOVER.md` and `WORK_PROGRESS.md` first. The owner mainly uses a **Samsung Galaxy Tab S9 + S Pen** (Chrome / Samsung Internet). Reference app for S Pen behaviour: `D:\Deepseek\reference-githubs\xnotes-android` (see `app/src/main/java/com/xnotes/canvas/StylusButtons.kt`).

How to run: `npx vite build && npx vite preview --port 5178 --host 0.0.0.0 --strictPort` (the dev server locks files on this Windows PC). Open on the tablet via the PC's LAN IP. Clear storage between scenarios: `localStorage.clear(); indexedDB.deleteDatabase('mdstudio')`.

---

## 0. What changed (files)

| File | Change |
| --- | --- |
| `src/ink.ts` (new) | Stroke model (mm, per page), SVG layer, smoothing (`pathD`), eraser hit test (`hitStroke`), point simplify, pen prefs (localStorage `mdstudio.ink.v1`). |
| `src/htmlmd.ts` (new) | Edited page HTML → Markdown (`htmlToMarkdown`). Writes `<span style>`, `<u>`, `<mark>`, `<sub>`, `<sup>`, `<!-- picture {...} -->`, extra blank lines; reports what Markdown cannot hold (`lossy`, e.g. text alignment). |
| `src/markdown.ts` | Renderer now understands those inline tags (`pairInlineTags`, only safe `color/background-color/font-size` styles) and `<!-- picture {...} -->` markers → `figure.ed-fig`. |
| `src/editor.ts` | (1) `noScroll` flag + `takeNoScroll()`; undo/redo, Done/Edit toggle, paragraph style, clear-page-ink keep the scroll position; caret markers only restored when the page has focus. (2) `syncMarkdown()` rewrites the Markdown editor from page edits after every commit; undo snapshots include the Markdown (`Snap.md`); "Discard page edits" restores `doc.mdOrig`; banner now offers *Use Markdown / Add to end / Keep page*. (3) Ink: toolbar (pen, highlighter, eraser, colour/width popover first), pointer handling in capture phase, S Pen side-button = eraser while held, palm rejection (fingers scroll once a pen was used), finger panning with momentum, stroke undo/redo, ink layers per page, ink saved in `doc.ink`. Toolbar reordered: Done · Pen · Highlighter · Eraser · Pen options · Undo · Redo · **B** · U · I · S · Text highlight · Text colour · Size · Paragraph · … |
| `src/store.ts` | `EditDoc.ink`, `EditDoc.mdOrig`; ink travels in session export/import; GC/export also keep pictures referenced from the Markdown. |
| `src/main.ts` | `render()` honours `takeNoScroll()`; `keepCaretVisible()` only runs when the page has focus; `setMarkdown` dep; "page-only formatting" note under the Markdown editor; print removes empty ink groups. |
| `src/flow.ts` | `.ink-layer` excluded from the text flow. |
| `src/styles/app.css`, `index.html` | Ink styles, compact edit bar (30 px desktop / 36 px tablet), `#md-sync-note`. |

---

## 1. Bug 1 — view jumps to the end of the page

Use the sample document (Markdown pane → **Sample**), Pages view, scroll to the middle of page 2.

- [ ] Type a word on page 2 → **Undo** button → view must stay on page 2 (not jump to the end / top). Repeat with **Redo**.
- [ ] Ctrl+Z / Ctrl+Y (desktop) — same.
- [ ] Click **Done** → view stays. Click **Edit page** → view stays (does NOT jump to where the caret last was).
- [ ] With caret on page 1, scroll to page 3 without clicking, press Undo → view stays on page 3.
- [ ] Change paragraph style from the toolbar while the page is not focused → view stays.
- [ ] Insert / resize / move a picture → view stays.
- [ ] Typing that pushes text onto a new page still scrolls *just enough* to keep the caret visible (this behaviour must remain).
- [ ] Flow view: repeat undo/redo — view stays.
- [ ] Tablet: same checks with touch + on-screen keyboard (keyboard opening/closing must not cause a jump to the end).

If it still jumps: log `scroller.scrollTop` before/after in `render()` (`src/main.ts`) and check whether `restoreCaret` (`src/flow.ts`) or the browser's own `focus()` scrolled. `focus({preventScroll:true})` is already used in `restoreRange`.

## 2. Bug 2 — delete on the page must also delete in the Markdown

- [ ] Load sample. Delete a sentence on the rendered page → within ~1 s the Markdown editor no longer contains it.
- [ ] Type new text on the page → appears in the Markdown.
- [ ] Bold / italic / strikethrough on the page → `**` / `*` / `~~` in the Markdown. Underline → `<u>`. Text colour / highlight / size → `<span style="color:…">`. Then **reload**: the page must look the same.
- [ ] Headings (H1–H4 from the toolbar), bullet and numbered lists, quotes, code blocks, tables (edit a cell), math (inline `$…$`, display `$$…$$`) survive the round trip: compare the page before and after clicking the banner's **Use Markdown** (see below).
- [ ] Inline picture → Markdown contains `<!-- picture {...} -->`; the page still shows it after **Use Markdown**, after reload, and after session export → import.
- [ ] Extra blank lines (Enter several times on the page) → blank-line spacing kept.
- [ ] Text alignment (centre/right): page keeps it; the yellow note under the Markdown says *"Page-only formatting (not in Markdown): text alignment"*. That is expected.
- [ ] Undo after a page edit → **both** the page and the Markdown go back. Redo → both forward.
- [ ] Type in the Markdown editor at the **end** → shows on the page below the edits (unchanged behaviour); a following page edit folds it in and the Markdown stays consistent (no duplicated text!).
- [ ] Edit the Markdown in the **middle** → banner *"The Markdown was edited by hand"*:
  - **Use Markdown** → page rebuilt from the Markdown (formatting kept, pen ink and fixed pictures stay).
  - **Add to end of page** → Markdown appended, then Markdown re-synced from the page.
  - **Keep page** → Markdown rewritten from the page.
- [ ] **Discard page edits** (toolbar reset icon) → Markdown returns to what it was before the first page edit; Undo restores page + Markdown.
- [ ] Session switch / export / import keeps page, Markdown and ink in sync.
- [ ] Escaping: on the page type `*star*`, `# not a heading`, `1. not a list`, `a|b`, `$5` → after **Use Markdown** the page shows the same literal text.
- [ ] Footnotes / task lists from the sample: check they are not lost (known weak spot of `htmlmd.ts`).

Weak spots to look at first if anything is wrong: `src/htmlmd.ts` (`para`, `listBlock`, `tableBlock`, `joinItems` — the `<!-- -->` separator between two adjacent lists, blank-line maths `Math.round(empties * 1.6)`), `pairInlineTags` in `src/markdown.ts`.

## 3. Pen, highlighter, eraser (main feature)

Desktop (mouse) first, then **Tab S9 + S Pen** (most important).

- [ ] Toolbar order: Done · Pen · Highlighter · Eraser · ● (options) · Undo · Redo · B · U · I · S · highlight · colour · Size · Paragraph … Buttons are smaller and the row fits on the Tab S9 in landscape (portrait may scroll sideways — acceptable).
- [ ] Tap **Pen**: button turns blue, page stops being editable (no caret, no keyboard). Draw → smooth line follows the pen with no lag; line stays after lifting.
- [ ] **Highlighter**: wide translucent stroke; text under it stays readable (multiply blend); highlighter is drawn *under* pen strokes.
- [ ] **●** options: colour swatches and widths for the current tool; "Draw with finger too"; "Clear page ink" clears the most visible page only.
- [ ] **Eraser**: drag over strokes → whole strokes disappear.
- [ ] **S Pen side button held while drawing = eraser**, released = pen again (like xnotes). Also: hold the button *before* touching. If it does not work in Chrome on the Tab S9, log in `inkDown`: `e.pointerType, e.button, e.buttons` for a press with the button held. Expected `buttons & 2` (barrel) or `& 32` (eraser). Adjust `toolFor()` in `src/editor.ts` accordingly. No context menu may appear (handled in the `contextmenu` listener).
- [ ] **Palm rejection**: after the S Pen touched once, the palm resting on the screen must not draw; one finger scrolls the page (with momentum). Two-finger pinch zoom still works.
- [ ] With "Draw with finger too" on and no pen used yet, the finger draws.
- [ ] Undo / Redo remove/restore single strokes and erasures, without moving the view.
- [ ] Strokes stay exactly in place when zooming (Fit width, 50 %, 200 %) and after reload.
- [ ] Strokes stay on their page when text is added above (they are anchored like fixed pictures — expected).
- [ ] Drawing on page 3 then deleting text so only 2 pages remain → page 3 must still exist (`minPages`).
- [ ] Turn a pen tool off (tap it again) → page editable again, caret works.
- [ ] Switch to Flow view while a pen tool is on → tool turns off, Flow banner says fixed items are only in Pages view.
- [ ] **Export PDF**: ink prints at the right place, highlighter translucent, no UI handles.
- [ ] .docx / Word copy: ink is **not** exported (known limitation, mention to the owner).
- [ ] Session export/import (`.mdstudio.json`) keeps ink.
- [ ] Performance: 200+ strokes on a page, then drawing still smooth; erasing still responsive.

## 4. Regression checks (must still work)

- [ ] Typing, Enter across pages, Backspace across pages, paste of AI Markdown, pictures (insert/crop/resize/move/fixed↔inline), colours, sizes, lists, page break.
- [ ] Sessions dialog: new / switch / rename / delete / export / import; scroll position restored after reload.
- [ ] Phone layout (≤ 820 px): edit bar visible on the Preview tab, bottom nav hides while typing.
- [ ] `npx tsc --noEmit` and `npm run build` clean.

## 5. Known limitations / decisions (tell the owner)

- Ink is anchored to the page position (like fixed pictures), not to the text. If text reflows, ink stays where it was drawn.
- Eraser removes whole strokes (no partial erase).
- Text alignment and blocks inside table cells cannot be stored in Markdown; the page keeps them and the note under the Markdown editor says so.
- Pressure sensitivity is not used (constant width) — can be added later via `e.pressure`.

## 6. Report back

List each section with ✅/❌, what you fixed (file + function), and anything still open. Then update `WORK_PROGRESS.md`. **Do not push.**
