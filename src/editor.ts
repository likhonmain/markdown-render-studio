// Direct editing of the rendered page ("WYSIWYG" mode).
//
// The rendered pages live inside one persistent contenteditable host, so the
// on-screen keyboard stays open while pages are rebuilt. After each pause in
// typing the edited pages are joined back into one document flow (`flow.ts`),
// saved, and — only when the text no longer fits the pages it is on — paginated
// again with the caret kept in place.
//
// Pictures come in two kinds, like Word:
//  • "Fixed on page": anchored to a page position; text flows above/below it
//    ("push") or the picture floats in front of the text. It never moves when
//    text above it changes.
//  • "In line with text": a block in the text flow that moves with the text.
import { markdownToHtml } from './markdown';
import { hasContent, type Band } from './paginate';
import { MM_PX, geometry, type Geometry, type Settings } from './settings';
import { emptyDoc, gcImages, imageUrl, loadDoc, loadImages, putImage, readImageFile, saveDoc, type Crop, type EditDoc, type FloatImg } from './store';
import {
  cleanFlow, extractFlow, extractSimple, figData, figureImageIds, fillCropBox, hydrateFigure, insertCaretMarkers, looksLikeMarkdown, makeFigure,
  picHeight, removeCaretMarkers, restoreCaret, sanitizeHtml, stripCaretMarkers, type PicData,
} from './flow';
import { openCrop } from './crop';
import { htmlToMarkdown } from './htmlmd';
import {
  HL_COLORS, HL_WIDTHS, PEN_COLORS, PEN_WIDTHS, hitStroke, inkLayer, loadInkPrefs, pathD, saveInkPrefs, simplify, strokePath,
  type InkPrefs, type InkStroke, type InkTool,
} from './ink';

export interface EditorDeps {
  host: HTMLElement; // persistent element holding the rendered pages / flow sheet
  bar: HTMLElement;
  banner: HTMLElement;
  scroller: HTMLElement;
  settings(): Settings;
  saveSettings(): void;
  pages(): HTMLElement | null; // current `.pages` element (Pages view)
  flowMd(): HTMLElement | null; // current `.md` element (Flow view)
  zoom(): number;
  rerender(): void; // synchronous full render that keeps the scroll position
  markdown(): string;
  /** Writes Markdown produced from page edits into the editor (no re-render, no change event). */
  setMarkdown(md: string): void;
  toast(msg: string, kind?: 'ok' | 'error', ms?: number): void;
  status(msg: string): void;
  isMobile(): boolean;
  onDocSaved?(): void;
}

interface Snap {
  dirty: boolean;
  html: string; // may contain caret markers
  mdBase: string;
  md: string; // the Markdown editor contents at that time
  floats: string; // JSON
  ink: string; // JSON
}

type Sel = { kind: 'float' | 'fig'; id: string } | null;

const svg = (d: string) => `<svg viewBox="0 0 24 24">${d}</svg>`;
const I = {
  pencil: '<path d="M4 20h4L19 9l-4-4L4 16z M13.5 6.5l4 4" />',
  pen: '<path d="M3 21l1.5-5L15.5 5a2.1 2.1 0 0 1 3 3L7.5 19z M13.5 7l3 3" />',
  marker: '<path d="M9 15l-5 5h5l2-2M15.5 4.5l4 4L12 16l-4-4z" /><path d="M4 21h16" />',
  eraser: '<path d="M7 21h12M5.5 14.5l7-7a2 2 0 0 1 2.8 0l3.2 3.2a2 2 0 0 1 0 2.8L12 20H8l-2.5-2.5a2 2 0 0 1 0-3z M9.5 10.5l5 5" />',
  check: '<path d="m5 12.5 4.5 4.5L19 7" />',
  undo: '<path d="M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />',
  redo: '<path d="m15 14 5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />',
  hilite: '<path d="m9 11-5 5v3h6l2-2M20.5 9.5 15 15l-6-6 5.5-5.5a2.1 2.1 0 0 1 3 0l3 3a2.1 2.1 0 0 1 0 3z" />',
  left: '<path d="M4 6h16M4 10h10M4 14h16M4 18h10" />',
  center: '<path d="M4 6h16M7 10h10M4 14h16M7 18h10" />',
  right: '<path d="M4 6h16M10 10h10M4 14h16M10 18h10" />',
  justify: '<path d="M4 6h16M4 10h16M4 14h16M4 18h16" />',
  ul: '<path d="M9 6h11M9 12h11M9 18h11" /><circle cx="4.5" cy="6" r="1.2" /><circle cx="4.5" cy="12" r="1.2" /><circle cx="4.5" cy="18" r="1.2" />',
  ol: '<path d="M10 6h10M10 12h10M10 18h10M4 4.5l1.5-1V9M3.5 14.5a1.5 1.5 0 1 1 2.6 1L3.5 19.5h3" />',
  pic: '<rect x="3" y="4.5" width="18" height="15" rx="2" /><circle cx="9" cy="10" r="1.8" /><path d="m21 16-5-5-8.5 8.5" />',
  pagebreak: '<path d="M6 3v5h12V3M6 21v-5h12v5M3 12h2M8 12h2M14 12h2M19 12h2" />',
  clear: '<path d="M5 6V4.5h12V6M11 4.5 8 19M7 19h4M15 13l5 5M20 13l-5 5" />',
  reset: '<path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4" />',
  crop: '<path d="M6 2v14a2 2 0 0 0 2 2h14M18 22V8a2 2 0 0 0-2-2H2" />',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M5.5 7l1 13h11l1-13M9 7V4h6v3" />',
  wrapL: '<rect x="3" y="5" width="8" height="8" rx="1" /><path d="M14 6h7M14 10h7M14 14h7M3 18h18" />',
  wrapR: '<rect x="13" y="5" width="8" height="8" rx="1" /><path d="M3 6h7M3 10h7M3 14h7M3 18h18" />',
};

const COLORS = ['#0f1115', '#61666b', '#d92d20', '#e8590c', '#f08c00', '#2b8a3e', '#0c8599', '#1971c2', '#3964fe', '#7048e8', '#c2255c', '#ffffff'];
const HILITES = ['#fff3a3', '#c3fae8', '#d0ebff', '#ffd8e8', '#ffe8cc', '#e5dbff', '#e9ecef'];
const DEFAULT_COLOR = '#0f1115';
const BLOCKS: Array<[string, string]> = [['p', 'Normal text'], ['h1', 'Heading 1'], ['h2', 'Heading 2'], ['h3', 'Heading 3'], ['h4', 'Heading 4'], ['blockquote', 'Quote'], ['pre', 'Code']];
const SIZES: Array<[string, string]> = [['', 'Size'], ['0.8', 'Small'], ['1', 'Normal'], ['1.25', 'Large'], ['1.5', 'Larger'], ['2', 'Huge']];
const TEXT_BLOCK = /^(P|H[1-6]|PRE|DIV|LI|BLOCKQUOTE)$/;

const uid = (p: string) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export class PageEditor {
  doc: EditDoc = emptyDoc();
  private pending = false; // the DOM has edits not yet copied into `doc`
  private composing = false;
  private idleTimer = 0;
  private saveTimer = 0;
  private override: string | null = null; // HTML for the next render (with caret markers)
  private markers = false;
  private sig: number[] = [];
  private undoStack: Snap[] = [];
  private redoStack: Snap[] = [];
  private current!: Snap;
  private sel: Sel = null;
  private savedRange: Range | null = null;
  private fileInput = document.createElement('input');
  private tailCache = { md: '\u0000', html: '' };
  private pop: HTMLElement | null = null;
  private barRaf = 0;
  private noScroll = false; // next render must not move the view (undo / redo / toolbar)
  private mdLossy: string[] = []; // formatting the Markdown mirror cannot hold
  // Ink
  inkTool: InkTool | null = null;
  private inkPrefs: InkPrefs = loadInkPrefs();
  private penSeen = false; // a stylus was used: fingers only scroll (palm rejection)
  private inkPtr: number | null = null;
  private stroke: { s: InkStroke; path: SVGPathElement; page: HTMLElement; raf: number } | null = null;
  private erasing: { page: number; removed: boolean } | null = null;
  private pan: { id: number; y: number; x: number; vy: number; t: number } | null = null;
  private hoverButton = false; // S Pen side button seen held while hovering (some pens only report it then)

  constructor(private d: EditorDeps) {}

  get enabled(): boolean {
    return this.d.settings().editMode;
  }

  private get pagesView(): boolean {
    return this.d.settings().view === 'pages';
  }

  /* ------------------------------------------------------------------ */
  /* Setup                                                               */
  /* ------------------------------------------------------------------ */

  async init(): Promise<void> {
    this.doc = await loadDoc();
    this.doc.ink ??= [];
    const ids = [...figureImageIds(this.doc.html), ...mdImageIds(this.d.markdown()), ...this.doc.floats.map((f) => f.img)];
    await loadImages(ids);
    void gcImages(new Set(ids));
    if (this.doc.dirty) this.mdLossy = htmlToMarkdown(this.doc.html).lossy;
    this.current = this.state();
    try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch { /* old browsers */ }
    this.fileInput.type = 'file';
    this.fileInput.accept = 'image/*';
    this.fileInput.hidden = true;
    document.body.appendChild(this.fileInput);
    this.fileInput.addEventListener('change', () => {
      const f = this.fileInput.files?.[0];
      this.fileInput.value = '';
      if (f) void this.insertPictureFile(f);
    });
    this.buildBar();
    this.bindHost();
    this.updateBanner();
    window.addEventListener('pagehide', () => this.flushNow());
    window.addEventListener('beforeunload', () => this.flushNow());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.flushNow(); });
  }

  /** Switches the editor to a different session's document. */
  async loadSessionDoc(doc: EditDoc): Promise<void> {
    clearTimeout(this.idleTimer);
    clearTimeout(this.saveTimer);
    this.pending = false;
    this.composing = false;
    this.override = null;
    this.markers = false;
    this.sel = null;
    this.savedRange = null;
    this.doc = structuredClone(doc);
    this.doc.ink ??= [];
    this.mdLossy = this.doc.dirty ? htmlToMarkdown(this.doc.html).lossy : [];
    const ids = [...figureImageIds(this.doc.html), ...mdImageIds(this.d.markdown()), ...this.doc.floats.map((f) => f.img)];
    await loadImages(ids);
    this.undoStack = [];
    this.redoStack = [];
    this.current = this.state();
    await saveDoc(this.doc);
    this.updateBanner();
  }

  /** The HTML the pages should show. */
  pageHtml(renderMd: (md: string) => string): string {
    if (this.override !== null) return this.override;
    let html: string;
    const md = this.d.markdown();
    if (!this.doc.dirty) html = renderMd(md);
    else {
      html = this.doc.html;
      if (md !== this.doc.mdBase && md.startsWith(this.doc.mdBase)) {
        const tail = md.slice(this.doc.mdBase.length);
        if (tail.trim()) {
          if (this.tailCache.md !== tail) this.tailCache = { md: tail, html: safeMd(tail) };
          html += this.tailCache.html;
        }
      }
    }
    if (this.enabled && !html.trim()) html = '<p><br></p>';
    return html;
  }

  /** Whether exports must use the edited page instead of the Markdown. */
  get edited(): boolean {
    return this.doc.dirty || this.doc.floats.length > 0 || (this.doc.ink?.length ?? 0) > 0;
  }

  /** True when the next render should leave the scroll position exactly where it is. */
  takeNoScroll(): boolean {
    const v = this.noScroll;
    this.noScroll = false;
    return v;
  }

  bands(g: Geometry): (page: number) => Band[] {
    for (const f of this.doc.floats) this.clampFloat(f);
    return (i) =>
      this.doc.floats
        .filter((f) => f.page === i && f.wrap === 'push')
        .map((f) => ({ top: (f.y - g.mt) * MM_PX - 6, bottom: (f.y + picHeight(f) - g.mt) * MM_PX + 8 }));
  }

  minPages(): number {
    const pics = this.doc.floats.reduce((m, f) => Math.max(m, f.page + 1), 1);
    return (this.doc.ink ?? []).reduce((m, s) => Math.max(m, s.page + 1), pics);
  }

  /** Adds fixed pictures, ink layers and marks non-editable islands on freshly built pages. */
  decoratePages(pages: HTMLElement): void {
    const pageEls = [...pages.children].filter((e) => e.classList.contains('page')) as HTMLElement[];
    for (const f of this.doc.floats) {
      this.clampFloat(f);
      const page = pageEls[f.page];
      if (page) page.appendChild(this.floatEl(f));
    }
    const g = geometry(this.d.settings());
    const ink = this.doc.ink ?? [];
    pageEls.forEach((page, i) => {
      page.dataset.page = String(i);
      page.appendChild(inkLayer(g.pageW, g.pageH, ink.filter((s) => s.page === i)));
    });
    for (const el of pages.querySelectorAll('.page-num, .page-label, .ex-spacer')) el.setAttribute('contenteditable', 'false');
    this.islands(pages);
  }

  decorateFlow(md: HTMLElement): void {
    this.islands(md);
  }

  private islands(root: ParentNode): void {
    for (const k of root.querySelectorAll('.katex, .math-display, figure.ed-fig, hr')) k.setAttribute('contenteditable', 'false');
  }

  private floatEl(f: FloatImg): HTMLElement {
    const el = document.createElement('div');
    el.className = 'fimg' + (f.wrap === 'front' ? ' front' : '');
    el.dataset.id = f.id;
    el.setAttribute('contenteditable', 'false');
    el.style.left = `${f.x}mm`;
    el.style.top = `${f.y}mm`;
    el.style.width = `${f.w}mm`;
    const box = document.createElement('span');
    el.appendChild(box);
    fillCropBox(box, f);
    return el;
  }

  /** Called by the renderer before it replaces the pages. */
  prepareRender(): void {
    if (this.override !== null) return;
    if (!this.enabled) {
      if (this.pending) this.flushNow();
      return;
    }
    const focused = this.hasFocus();
    if (!this.pending && !focused) return;
    const marked = focused && insertCaretMarkers(this.d.host);
    const html = this.extractHtml();
    if (html === null) {
      if (marked) removeCaretMarkers(this.d.host);
      return;
    }
    if (this.pending) this.commit(html);
    this.override = html;
    this.markers = marked;
  }

  /** Called by the renderer after the new pages are in place. */
  afterRender(): void {
    const host = this.d.host;
    if (this.inkTool && !this.pagesView) this.inkTool = null; // pen tools only work on pages
    if (this.enabled && !this.inkTool) host.setAttribute('contenteditable', 'true');
    else host.removeAttribute('contenteditable');
    host.classList.toggle('ink-mode', !!this.inkTool);
    host.dataset.inkTool = this.inkTool ?? '';
    this.override = null;
    if (host.querySelector('[data-caret]')) restoreCaret(host, this.markers && this.hasFocus());
    removeCaretMarkers(host);
    this.markers = false;
    this.applySel();
    this.sig = this.signature();
    this.updateBar();
    const hidden = !this.pagesView && (this.doc.floats.length > 0 || (this.doc.ink?.length ?? 0) > 0);
    this.d.host.classList.toggle('has-floats-hidden', hidden);
  }

  onMarkdownChange(): void {
    this.updateBanner();
  }

  /* ------------------------------------------------------------------ */
  /* Flow extraction, commit, save, undo                                 */
  /* ------------------------------------------------------------------ */

  private hasFocus(): boolean {
    const a = document.activeElement;
    return !!a && (a === this.d.host || this.d.host.contains(a));
  }

  private extractHtml(): string | null {
    // Follow what is on screen (the view setting may just have been switched).
    const p = this.d.pages();
    if (p && p.isConnected) return extractFlow(p).innerHTML;
    const md = this.d.flowMd();
    return md && md.isConnected ? extractSimple(md).innerHTML : null;
  }

  private state(html?: string): Snap {
    return {
      dirty: this.doc.dirty,
      html: html ?? this.doc.html,
      mdBase: this.doc.mdBase,
      md: this.d.markdown(),
      floats: JSON.stringify(this.doc.floats),
      ink: JSON.stringify(this.doc.ink ?? []),
    };
  }

  private same(a: Snap, b: Snap): boolean {
    return a.dirty === b.dirty && a.floats === b.floats && a.ink === b.ink && a.mdBase === b.mdBase && a.md === b.md && stripCaretMarkers(a.html) === stripCaretMarkers(b.html);
  }

  private pushState(s: Snap): void {
    if (this.same(s, this.current)) {
      this.current = s; // keep the newer caret position
      return;
    }
    this.undoStack.push(this.current);
    if (this.undoStack.length > 150) this.undoStack.shift();
    this.current = s;
    this.redoStack = [];
  }

  /**
   * Page edits → Markdown: rewrites the Markdown editor from the edited page so
   * deleting (or adding) text on the page also changes the Markdown. Markdown the
   * user typed below the page edits (not yet on the page) is kept.
   */
  private syncMarkdown(): void {
    if (!this.doc.dirty) return;
    // `doc.html` was just extracted from the screen, which already shows any Markdown the
    // user typed below the page edits, so the whole Markdown is rebuilt from it.
    const md = this.d.markdown();
    const res = htmlToMarkdown(this.doc.html);
    this.mdLossy = res.lossy;
    this.doc.mdBase = res.md;
    if (this.doc.mdOrig === undefined) this.doc.mdOrig = md;
    if (res.md !== md) this.d.setMarkdown(res.md);
    this.updateBanner();
  }

  /** Copies extracted HTML (may contain caret markers) into the document. */
  private commit(html: string): void {
    const clean = stripCaretMarkers(html);
    this.pending = false;
    if (!this.doc.dirty || clean !== this.doc.html) {
      if (!this.doc.dirty) this.doc.mdOrig = this.d.markdown();
      this.doc.html = clean;
      this.doc.dirty = true;
      this.syncMarkdown();
    }
    this.pushState(this.state(html));
    this.scheduleSave();
    this.updateBanner();
  }

  /** Changes to pictures / settings of the document (always re-rendered). */
  private commitDoc(): void {
    if (this.pending) {
      const html = this.extractHtml();
      if (html !== null) {
        const clean = stripCaretMarkers(html);
        if (!this.doc.dirty) this.doc.mdOrig = this.d.markdown();
        this.doc.html = clean;
        this.doc.dirty = true;
        this.syncMarkdown();
      }
      this.pending = false;
    }
    this.pushState(this.state());
    this.scheduleSave();
    this.d.rerender();
  }

  private scheduleSave(): void {
    this.d.status('Saving…');
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.saveNow(), 350);
  }

  private async saveNow(): Promise<void> {
    clearTimeout(this.saveTimer);
    try {
      await saveDoc(this.doc);
      this.d.onDocSaved?.();
      this.d.status(this.edited ? 'Page edits saved' : 'Saved');
    } catch (err) {
      console.error(err);
      this.d.status('Not saved!');
      this.d.toast('Could not save in this browser (storage full or blocked)', 'error', 5000);
    }
  }

  /** Synchronous save (page hide / unload / before export). */
  flushNow(): void {
    if (this.pending) {
      const html = this.extractHtml();
      if (html !== null) this.commit(html);
    }
    if (this.saveTimer) void this.saveNow();
  }

  private onIdle(): void {
    clearTimeout(this.idleTimer);
    if (!this.pending) return;
    const html = this.extractHtml();
    if (html === null) return;
    this.commit(html);
    if (!this.composing && this.needsRepaginate()) this.d.rerender();
    else this.sig = this.signature();
  }

  private scheduleIdle(ms = 650): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => this.onIdle(), ms);
  }

  private signature(): number[] {
    const p = this.d.pages();
    if (!this.pagesView || !p) return [];
    return [...p.querySelectorAll<HTMLElement>(':scope > .page > .page-content')].map((pc) => {
      let last = pc.lastElementChild as HTMLElement | null;
      while (last && last.classList.contains('ex-spacer')) last = last.previousElementSibling as HTMLElement | null;
      return last ? last.offsetTop + last.offsetHeight : 0;
    });
  }

  private needsRepaginate(): boolean {
    if (!this.pagesView) return false;
    const now = this.signature();
    const old = this.sig;
    const p = this.d.pages();
    if (!p || now.length !== old.length) return true;
    const pcs = [...p.querySelectorAll<HTMLElement>(':scope > .page > .page-content')];
    for (let i = 0; i < now.length; i++) {
      if (Math.abs(now[i] - old[i]) < 0.5) continue;
      if (pcs[i].querySelector(':scope > .ex-spacer')) return true;
      if (now[i] > pcs[i].clientHeight + 0.5) return true; // overflows the page
      if (now[i] < old[i] && i < now.length - 1) return true; // room freed with a next page to pull from
    }
    // Also catch content that grew without touching the last block (e.g. a table cell).
    return pcs.some((pc) => pc.scrollHeight > pc.clientHeight + 1);
  }

  undo(): void {
    this.flushNow();
    // Markdown typed by hand since the last snapshot becomes its own undo step (never lost).
    if (this.d.markdown() !== this.current.md) this.pushState(this.state());
    const prev = this.undoStack.pop();
    if (!prev) return this.d.toast('Nothing to undo');
    this.redoStack.push(this.current);
    this.current = prev;
    this.applySnap(prev);
  }

  redo(): void {
    this.flushNow();
    const next = this.redoStack.pop();
    if (!next) return this.d.toast('Nothing to redo');
    this.undoStack.push(this.current);
    this.current = next;
    this.applySnap(next);
  }

  private applySnap(s: Snap): void {
    this.doc.dirty = s.dirty;
    this.doc.html = stripCaretMarkers(s.html);
    this.doc.mdBase = s.mdBase;
    this.doc.floats = JSON.parse(s.floats) as FloatImg[];
    this.doc.ink = JSON.parse(s.ink || '[]') as InkStroke[];
    if (this.d.markdown() !== s.md) this.d.setMarkdown(s.md);
    this.mdLossy = s.dirty ? htmlToMarkdown(this.doc.html).lossy : [];
    this.pending = false;
    this.sel = null;
    this.scheduleSave();
    this.updateBanner();
    // Only restore the caret if the user is typing on the page; otherwise the
    // caret marker would scroll the view to wherever the caret last was.
    if (s.dirty) {
      this.override = s.html;
      this.markers = s.html.includes('data-caret') && this.hasFocus();
    }
    this.noScroll = !this.markers;
    this.d.rerender();
  }

  /* ------------------------------------------------------------------ */
  /* Host events                                                         */
  /* ------------------------------------------------------------------ */

  private bindHost(): void {
    const host = this.d.host;
    // Ink gets the pointer first (capture phase) so text editing and picture dragging never see it.
    host.addEventListener('pointerdown', (e) => {
      if (this.inkTool && this.inkDown(e)) e.stopImmediatePropagation();
    }, { capture: true });
    host.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'pen' && e.buttons === 0) this.hoverButton = false;
      if (e.pointerType === 'pen' && (e.buttons & 2) && this.inkPtr === null) this.hoverButton = true;
      if (this.inkPtr !== null || this.pan) this.inkMove(e);
    });
    host.addEventListener('pointerup', (e) => this.inkUp(e));
    host.addEventListener('pointercancel', (e) => this.inkUp(e));
    host.addEventListener('lostpointercapture', (e) => { if (e.pointerId === this.inkPtr) this.inkUp(e); });
    // S Pen button + touch fires a context menu (right-click); never show it while drawing.
    host.addEventListener('contextmenu', (e) => { if (this.inkTool || (e as PointerEvent).pointerType === 'pen') e.preventDefault(); });
    host.addEventListener('touchmove', (e) => { if (this.inkTool && (this.inkPtr !== null || this.pan)) e.preventDefault(); }, { passive: false });
    host.addEventListener('input', () => {
      if (!this.enabled) return;
      this.pending = true;
      this.d.status('Editing…');
      this.scheduleIdle();
    });
    host.addEventListener('compositionstart', () => { this.composing = true; });
    host.addEventListener('compositionend', () => {
      this.composing = false;
      if (this.pending) this.scheduleIdle(500);
    });
    host.addEventListener('focusout', (e) => {
      const to = e.relatedTarget as Node | null;
      if (to && (host.contains(to) || this.d.bar.contains(to))) return;
      if (this.pending) {
        this.composing = false;
        this.onIdle();
      }
    });
    host.addEventListener('beforeinput', (e) => {
      if (!this.enabled) return;
      const t = e.inputType;
      if (t === 'historyUndo' || t === 'historyRedo') {
        e.preventDefault();
        if (t === 'historyUndo') this.undo();
        else this.redo();
        return;
      }
      if (!this.pagesView) return;
      if (t === 'deleteContentBackward' && this.crossPage(true)) e.preventDefault();
      else if (t === 'deleteContentForward' && this.crossPage(false)) e.preventDefault();
    });
    host.addEventListener('keydown', (e) => {
      if (!this.enabled) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && !e.altKey && (k === 'z' || k === 'y')) {
        e.preventDefault();
        if (k === 'y' || e.shiftKey) this.redo();
        else this.undo();
      } else if (mod && k === 'u') {
        e.preventDefault();
        document.execCommand('underline');
      }
    });
    host.addEventListener('paste', (e) => this.onPaste(e));
    host.addEventListener('copy', (e) => this.onCopy(e, false));
    host.addEventListener('cut', (e) => this.onCopy(e, true));
    host.addEventListener('dragstart', (e) => {
      if ((e.target as Element).closest?.('.fimg, figure.ed-fig')) e.preventDefault();
    });
    host.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    host.addEventListener('click', (e) => {
      // Links inside the editable page should not navigate while editing.
      if (this.enabled && (e.target as Element).closest('a')) e.preventDefault();
    });
    document.addEventListener('selectionchange', () => {
      const s = getSelection();
      if (s && s.rangeCount && host.contains(s.anchorNode)) {
        this.savedRange = s.getRangeAt(0).cloneRange();
        if (this.sel && !s.isCollapsed) this.select(null);
        cancelAnimationFrame(this.barRaf);
        this.barRaf = requestAnimationFrame(() => this.updateBar());
      }
    });
    document.addEventListener('keydown', (e) => {
      if (!this.sel || !this.enabled) return;
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, dialog')) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        this.deleteSelected();
      } else if (e.key === 'Escape') this.select(null);
      else if (e.key.startsWith('Arrow') && this.sel.kind === 'float') {
        e.preventDefault();
        const f = this.float(this.sel.id);
        if (!f) return;
        const step = e.shiftKey ? 5 : 1;
        if (e.key === 'ArrowLeft') f.x -= step;
        if (e.key === 'ArrowRight') f.x += step;
        if (e.key === 'ArrowUp') f.y -= step;
        if (e.key === 'ArrowDown') f.y += step;
        this.clampFloat(f);
        this.commitDoc();
      }
    });
    // Pictures dropped on the page.
    host.addEventListener('drop', (e) => {
      const file = [...(e.dataTransfer?.files ?? [])].find((f) => f.type.startsWith('image/'));
      if (!file || !this.enabled) return;
      e.preventDefault();
      e.stopPropagation();
      void this.insertPictureFile(file, { x: e.clientX, y: e.clientY });
    });
  }

  /* ------------------------------------------------------------------ */
  /* Backspace / Delete across a page (or picture) boundary              */
  /* ------------------------------------------------------------------ */

  private crossPage(backward: boolean): boolean {
    const sel = getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return false;
    const r = sel.getRangeAt(0);
    const startEl = r.startContainer.nodeType === Node.ELEMENT_NODE ? (r.startContainer as Element) : r.startContainer.parentElement;
    const pc = startEl?.closest('.page-content');
    if (!pc) return false;
    const block = topBlock(r.startContainer, pc);
    if (!block) return false;
    const edge = document.createRange();
    if (backward) {
      edge.setStart(block, 0);
      edge.setEnd(r.startContainer, r.startOffset);
    } else {
      edge.setStart(r.startContainer, r.startOffset);
      edge.setEnd(block, block.childNodes.length);
    }
    if (!isBlankRange(edge)) return false;
    const sib = backward ? prevEl(block) : nextEl(block);
    if (sib && !sib.classList.contains('ex-spacer')) return false; // an ordinary edit inside the page
    let target: Element | null = null;
    if (sib) target = backward ? prevEl(sib) : nextEl(sib);
    if (!target) {
      const page = pc.closest('.page');
      let other = backward ? page?.previousElementSibling : page?.nextElementSibling;
      while (other && !other.classList.contains('page')) other = backward ? other.previousElementSibling : other.nextElementSibling;
      const opc = other?.querySelector(':scope > .page-content');
      if (opc) target = backward ? lastBlockOf(opc) : firstBlockOf(opc);
    }
    if (!target) return !!sib; // nothing to join with (keep the spacer island intact)
    const first = backward ? target : block;
    const second = backward ? block : target;
    const sid = first.getAttribute('data-sid');
    if (sid && sid === second.getAttribute('data-sid')) {
      // One paragraph continued on the next page: delete the character at the break.
      if (backward) {
        setCaret(deepEnd(first));
        document.execCommand('delete');
      } else {
        setCaret(deepStart(second));
        document.execCommand('forwardDelete');
      }
    } else if (!hasContent(second)) {
      second.remove();
      setCaret(backward ? deepEnd(first) : deepEnd(first));
    } else if (!hasContent(first)) {
      first.remove();
      setCaret(deepStart(second));
    } else {
      const dest = lastTextBlock(first);
      const src = firstTextBlock(second);
      if (dest && src && src === second) {
        const pos = deepEnd(dest);
        dest.append(...[...second.childNodes]);
        second.remove();
        setCaret(pos);
      } else setCaret(backward ? deepEnd(first) : deepStart(second));
    }
    this.pending = true;
    this.d.rerender();
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* Paste / copy                                                        */
  /* ------------------------------------------------------------------ */

  private onCopy(e: ClipboardEvent, cut: boolean): void {
    if (!this.enabled || !e.clipboardData) return;
    const s = getSelection();
    if (!s || !s.rangeCount || s.isCollapsed) return;
    const box = document.createElement('div');
    box.appendChild(s.getRangeAt(0).cloneContents());
    cleanFlow(box);
    e.clipboardData.setData('text/html', `<!--mdstudio-->${box.innerHTML}`);
    e.clipboardData.setData('text/plain', s.toString());
    e.preventDefault();
    if (cut) document.execCommand('delete');
  }

  private onPaste(e: ClipboardEvent): void {
    if (!this.enabled) return;
    const dt = e.clipboardData;
    if (!dt) return;
    const files = [...dt.files].filter((f) => f.type.startsWith('image/'));
    if (files.length) {
      e.preventDefault();
      void (async () => { for (const f of files) await this.insertPictureFile(f); })();
      return;
    }
    const html = dt.getData('text/html');
    const text = dt.getData('text/plain');
    let frag: DocumentFragment | null = null;
    if (html.includes('<!--mdstudio-->')) {
      const tpl = document.createElement('template');
      tpl.innerHTML = html.slice(html.indexOf('<!--mdstudio-->') + 15);
      for (const bad of tpl.content.querySelectorAll('script, style, iframe, object')) bad.remove();
      for (const el of tpl.content.querySelectorAll('*')) for (const a of [...el.attributes]) if (/^on/i.test(a.name)) el.removeAttribute(a.name);
      frag = tpl.content;
    } else if (text && looksLikeMarkdown(text) && (!html || !/<(p|h[1-6]|ul|ol|table|li)[\s>]/i.test(html))) {
      const tpl = document.createElement('template');
      tpl.innerHTML = safeMd(text);
      frag = tpl.content;
    } else if (html) {
      frag = sanitizeHtml(html);
    }
    e.preventDefault();
    if (!frag) {
      if (text) document.execCommand('insertText', false, text);
      return;
    }
    this.insertFragment(frag);
  }

  /** Inserts nodes at the caret; block content splits the current block. */
  private insertFragment(frag: DocumentFragment): void {
    this.restoreRange();
    const sel = getSelection();
    if (!sel || !sel.rangeCount) return;
    const r = sel.getRangeAt(0);
    if (!this.d.host.contains(r.commonAncestorContainer)) return;
    r.deleteContents();
    const nodes = [...frag.childNodes];
    if (!nodes.length) return;
    const isBlockNode = (n: Node) => n.nodeType === Node.ELEMENT_NODE && /^(P|DIV|H[1-6]|UL|OL|TABLE|BLOCKQUOTE|PRE|HR|FIGURE|SECTION)$/.test((n as Element).tagName);
    const container = (r.startContainer.nodeType === Node.ELEMENT_NODE ? (r.startContainer as Element) : r.startContainer.parentElement)?.closest('.page-content, .flow-sheet > .md') ?? null;
    const block = container ? topBlock(r.startContainer, container) : null;
    let last: Node = nodes[nodes.length - 1];
    if (!nodes.some(isBlockNode) || !block || !container) {
      r.insertNode(frag);
    } else {
      const tail = document.createRange();
      tail.setStart(r.startContainer, r.startOffset);
      tail.setEndAfter(block);
      const after = tail.extractContents();
      const afterNodes = [...after.childNodes].filter((n) => n.nodeType === Node.ELEMENT_NODE && hasContent(n as Element));
      block.after(...nodes, ...afterNodes);
      if (!hasContent(block)) block.remove();
      last = nodes[nodes.length - 1];
    }
    const pos = document.createRange();
    if (last.nodeType === Node.ELEMENT_NODE && isBlockNode(last) && !(last as Element).matches('hr, figure, table, .table-wrap')) {
      const [n, o] = deepEnd(last as Element);
      pos.setStart(n, o);
    } else pos.setStartAfter(last);
    pos.collapse(true);
    sel.removeAllRanges();
    sel.addRange(pos);
    this.pending = true;
    this.d.rerender();
  }

  /* ------------------------------------------------------------------ */
  /* Formatting                                                          */
  /* ------------------------------------------------------------------ */

  private restoreRange(): void {
    const sel = getSelection();
    if (!sel) return;
    const hasInHost = sel.rangeCount > 0 && this.d.host.contains(sel.getRangeAt(0).commonAncestorContainer);
    const r = hasInHost ? sel.getRangeAt(0).cloneRange() : this.savedRange;
    if (!r || !r.startContainer.isConnected || !this.d.host.contains(r.startContainer)) return;
    if (!this.hasFocus()) this.d.host.focus({ preventScroll: true });
    sel.removeAllRanges();
    sel.addRange(r);
  }

  private selectBlockIfCollapsed(): boolean {
    const sel = getSelection();
    if (!sel || !sel.rangeCount) return false;
    if (!sel.isCollapsed) return true;
    const n = sel.anchorNode;
    const el = n ? (n.nodeType === Node.ELEMENT_NODE ? (n as Element) : n.parentElement) : null;
    const blk = el?.closest('p, h1, h2, h3, h4, h5, h6, li, blockquote, td, th');
    if (!blk || !this.d.host.contains(blk) || !(blk.textContent ?? '').trim()) return false;
    const r = document.createRange();
    r.selectNodeContents(blk);
    sel.removeAllRanges();
    sel.addRange(r);
    this.savedRange = r.cloneRange();
    return true;
  }

  private exec(cmd: string, value?: string): void {
    this.restoreRange();
    const css = cmd.startsWith('justify');
    if (css) document.execCommand('styleWithCSS', false, 'true');
    document.execCommand(cmd, false, value);
    if (css) document.execCommand('styleWithCSS', false, 'false');
    this.pending = true;
    this.scheduleIdle();
    this.updateBar();
  }

  private color(c: string, kind: 'fore' | 'back'): void {
    this.restoreRange();
    this.selectBlockIfCollapsed();
    document.execCommand('styleWithCSS', false, 'true');
    document.execCommand(kind === 'fore' ? 'foreColor' : 'hiliteColor', false, c);
    document.execCommand('styleWithCSS', false, 'false');
    this.pending = true;
    this.scheduleIdle();
    const bar = this.d.bar.querySelector<HTMLElement>(`[data-a="${kind === 'fore' ? 'color' : 'hilite'}"] .bar`);
    if (bar && c !== 'transparent') bar.style.background = c;
  }

  private size(em: string): void {
    this.restoreRange();
    if (!this.selectBlockIfCollapsed()) return this.d.toast('Select some text first');
    const sel = getSelection()!;
    document.execCommand('styleWithCSS', false, 'false');
    document.execCommand('fontSize', false, '7');
    const fonts = [...this.d.host.querySelectorAll('font[size="7"]')];
    const spans: HTMLElement[] = [];
    for (const f of fonts) {
      const s = document.createElement('span');
      if (em !== '1') s.style.fontSize = `${em}em`;
      for (const inner of f.querySelectorAll<HTMLElement>('[style*="font-size"]')) inner.style.removeProperty('font-size');
      s.append(...f.childNodes);
      f.replaceWith(s);
      spans.push(s);
    }
    if (spans.length) {
      const r = document.createRange();
      r.setStartBefore(spans[0]);
      r.setEndAfter(spans[spans.length - 1]);
      sel.removeAllRanges();
      sel.addRange(r);
    }
    this.pending = true;
    this.scheduleIdle();
  }

  private block(tag: string): void {
    this.exec('formatBlock', tag === 'p' ? 'p' : tag);
    this.noScroll = !this.hasFocus();
    this.d.rerender();
  }

  private insertPageBreak(): void {
    const frag = document.createDocumentFragment();
    const hr = document.createElement('hr');
    hr.className = 'page-break';
    const p = document.createElement('p');
    p.appendChild(document.createElement('br'));
    frag.append(hr, p);
    this.insertFragment(frag);
  }

  private resetEdits(): void {
    if (!confirm('Discard all page edits, pictures and pen drawings and show the Markdown render again?\n(You can still Undo this.)')) return;
    this.flushNow();
    const orig = this.doc.mdOrig;
    this.doc.dirty = false;
    this.doc.html = '';
    this.doc.mdBase = '';
    this.doc.mdOrig = undefined;
    this.doc.floats = [];
    this.doc.ink = [];
    this.mdLossy = [];
    if (orig !== undefined && orig !== this.d.markdown()) this.d.setMarkdown(orig);
    this.sel = null;
    this.commitDoc();
    this.d.toast('Page edits discarded — Undo brings them back');
  }

  /* ------------------------------------------------------------------ */
  /* Toolbar                                                             */
  /* ------------------------------------------------------------------ */

  private buildBar(): void {
    const b = this.d.bar;
    const btn = (a: string, title: string, inner: string, cls = '') => `<button type="button" class="ed-btn ${cls}" data-a="${a}" title="${title}" aria-label="${title}">${inner}</button>`;
    b.innerHTML = `
      <div class="ed-row" data-row="off">
        ${btn('toggle', 'Edit the page directly', `${svg(I.pencil)}<span>Edit page</span>`, 'ed-toggle')}
        <span class="ed-tip">Type, delete, colour text and add pictures right on the page</span>
      </div>
      <div class="ed-row" data-row="text">
        ${btn('toggle', 'Finish editing (lock the page)', `${svg(I.check)}<span>Done</span>`, 'ed-toggle on')}
        <i class="ed-sep"></i>
        ${btn('ink-pen', 'Pen — write and draw (S Pen button held = eraser)', svg(I.pen), 'ink')}
        ${btn('ink-hl', 'Highlighter pen', svg(I.marker), 'ink')}
        ${btn('ink-eraser', 'Eraser — removes whole strokes', svg(I.eraser), 'ink')}
        ${btn('ink-opts', 'Pen colour and thickness', '<span class="ink-dot"></span>', 'ink-opts')}
        <i class="ed-sep"></i>
        ${btn('undo', 'Undo (Ctrl+Z)', svg(I.undo))}
        ${btn('redo', 'Redo (Ctrl+Y)', svg(I.redo))}
        <i class="ed-sep"></i>
        ${btn('bold', 'Bold (Ctrl+B)', '<b>B</b>', 'txt')}
        ${btn('underline', 'Underline (Ctrl+U)', '<u>U</u>', 'txt')}
        ${btn('italic', 'Italic (Ctrl+I)', '<i>I</i>', 'txt')}
        ${btn('strikeThrough', 'Strikethrough', '<s>S</s>', 'txt')}
        ${btn('hilite', 'Text highlight colour', `<span class="ed-a">${svg(I.hilite)}<i class="bar" style="background:#fff3a3"></i></span>`)}
        ${btn('color', 'Text colour', '<span class="ed-a">A<i class="bar" style="background:#d92d20"></i></span>', 'txt')}
        <select class="ed-sel narrow" data-a="size" title="Text size">${SIZES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
        <select class="ed-sel" data-a="block" title="Paragraph style">${BLOCKS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
        <i class="ed-sep"></i>
        ${btn('justifyLeft', 'Align left', svg(I.left))}
        ${btn('justifyCenter', 'Center', svg(I.center))}
        ${btn('justifyRight', 'Align right', svg(I.right))}
        ${btn('justifyFull', 'Justify', svg(I.justify))}
        <i class="ed-sep"></i>
        ${btn('insertUnorderedList', 'Bulleted list', svg(I.ul))}
        ${btn('insertOrderedList', 'Numbered list', svg(I.ol))}
        <i class="ed-sep"></i>
        ${btn('picture', 'Insert picture', `${svg(I.pic)}<span>Picture</span>`, 'wide')}
        ${btn('pagebreak', 'Insert page break', svg(I.pagebreak))}
        ${btn('removeFormat', 'Clear formatting of the selection', svg(I.clear))}
        ${btn('reset', 'Discard all page edits (back to the Markdown render)', svg(I.reset))}
      </div>
      <div class="ed-row" data-row="img">
        ${btn('deselect', 'Done with the picture', `${svg(I.check)}<span>Done</span>`, 'ed-toggle on')}
        <i class="ed-sep"></i>
        <div class="seg ed-seg" role="group" aria-label="Position">
          <button type="button" class="seg-btn" data-a="mode-fixed" title="Stays at this spot on this page; text moves around it">Fixed</button>
          <button type="button" class="seg-btn" data-a="mode-inline" title="Part of the text: moves together with the text around it">In line</button>
        </div>
        <div class="seg ed-seg" role="group" aria-label="Text" data-only="float">
          <button type="button" class="seg-btn" data-a="wrap-push" title="Text moves above and below the picture">Push text</button>
          <button type="button" class="seg-btn" data-a="wrap-front" title="Picture sits on top of the text">In front</button>
        </div>
        <i class="ed-sep"></i>
        ${btn('al-left', 'Align left', svg(I.left))}
        ${btn('al-center', 'Center', svg(I.center))}
        ${btn('al-right', 'Align right', svg(I.right))}
        <span data-only="fig" class="ed-inline">
          ${btn('al-float-left', 'Picture left, text wraps on its right', svg(I.wrapL))}
          ${btn('al-float-right', 'Picture right, text wraps on its left', svg(I.wrapR))}
        </span>
        <i class="ed-sep"></i>
        <select class="ed-sel narrow" data-a="imgsize" title="Picture width"><option value="">Width</option><option value="0.25">25%</option><option value="0.33">33%</option><option value="0.5">50%</option><option value="0.75">75%</option><option value="1">100%</option></select>
        ${btn('crop', 'Crop the picture', `${svg(I.crop)}<span>Crop</span>`, 'wide')}
        ${btn('delete', 'Delete the picture', `${svg(I.trash)}<span>Delete</span>`, 'wide danger')}
        <span class="ed-tip" data-only="float">Drag to move · drag a corner to resize</span>
        <span class="ed-tip" data-only="fig">Drag to move · drag a corner to resize</span>
      </div>`;
    // Keep the caret / selection in the page while using the toolbar.
    b.addEventListener('pointerdown', (e) => { if (!(e.target as Element).closest('select')) e.preventDefault(); });
    b.addEventListener('mousedown', (e) => { if (!(e.target as Element).closest('select')) e.preventDefault(); });
    b.addEventListener('click', (e) => {
      const el = (e.target as Element).closest<HTMLElement>('[data-a]');
      if (!el || el.tagName === 'SELECT') return;
      this.action(el.dataset.a!, el);
    });
    b.addEventListener('change', (e) => {
      const s = e.target as HTMLSelectElement;
      const a = s.dataset.a;
      const v = s.value;
      if (a === 'block') this.block(v);
      else if (a === 'size' && v) this.size(v);
      else if (a === 'imgsize' && v) this.imgWidth(Number(v));
      if (a !== 'block') s.value = '';
    });
  }

  private action(a: string, el: HTMLElement): void {
    switch (a) {
      case 'toggle': {
        const s = this.d.settings();
        if (s.editMode) this.flushNow();
        s.editMode = !s.editMode;
        this.d.saveSettings();
        this.sel = null;
        this.setInkTool(null, false);
        // Leaving / entering edit mode must not jump to the old caret position.
        if (!s.editMode) (document.activeElement as HTMLElement | null)?.blur?.();
        getSelection()?.removeAllRanges();
        this.noScroll = true;
        this.d.rerender();
        if (s.editMode) this.d.toast(this.d.isMobile() ? 'Tap the page to type' : 'Click anywhere on the page to type');
        return;
      }
      case 'ink-pen': return this.setInkTool(this.inkTool === 'pen' ? null : 'pen');
      case 'ink-hl': return this.setInkTool(this.inkTool === 'hl' ? null : 'hl');
      case 'ink-eraser': return this.setInkTool(this.inkTool === 'eraser' ? null : 'eraser');
      case 'ink-opts': return this.inkOptions(el);
      case 'undo': return this.undo();
      case 'redo': return this.redo();
      case 'bold': case 'italic': case 'underline': case 'strikeThrough':
      case 'justifyLeft': case 'justifyCenter': case 'justifyRight': case 'justifyFull':
      case 'insertUnorderedList': case 'insertOrderedList': case 'removeFormat':
        this.exec(a);
        if (a.startsWith('insert') || a === 'removeFormat') this.scheduleIdle(200);
        return;
      case 'color': return this.palette(el, COLORS, 'fore');
      case 'hilite': return this.palette(el, HILITES, 'back');
      case 'picture':
        this.restoreRange();
        this.fileInput.click();
        return;
      case 'pagebreak': return this.insertPageBreak();
      case 'reset': return this.resetEdits();
      case 'deselect': return this.select(null);
      case 'mode-fixed': return this.toFixed();
      case 'mode-inline': return this.toInline();
      case 'wrap-push': case 'wrap-front': {
        const f = this.selFloat();
        if (!f) return;
        f.wrap = a === 'wrap-push' ? 'push' : 'front';
        return this.commitDoc();
      }
      case 'crop': return void this.cropSelected();
      case 'delete': return this.deleteSelected();
      default:
        if (a.startsWith('al-')) return this.alignSelected(a.slice(3));
    }
  }

  private palette(anchor: HTMLElement, colors: string[], kind: 'fore' | 'back'): void {
    this.closePop();
    const pop = document.createElement('div');
    pop.className = 'ed-pop';
    const sw = colors.map((c) => `<button type="button" class="ed-sw" data-c="${c}" style="background:${c}" title="${c}"></button>`).join('');
    pop.innerHTML = `<div class="ed-sws">${sw}</div>
      <div class="ed-pop-row"><button type="button" class="mini-btn" data-c="${kind === 'fore' ? DEFAULT_COLOR : 'transparent'}">${kind === 'fore' ? 'Automatic' : 'No highlight'}</button>
      <label class="mini-btn ed-custom">Custom… <input type="color" value="${kind === 'fore' ? '#d92d20' : '#fff3a3'}" /></label></div>`;
    document.body.appendChild(pop);
    const r = anchor.getBoundingClientRect();
    const w = pop.offsetWidth;
    pop.style.left = `${clamp(r.left, 8, innerWidth - w - 8)}px`;
    pop.style.top = `${r.bottom + 6}px`;
    pop.addEventListener('pointerdown', (e) => { if (!(e.target as Element).closest('input, label')) e.preventDefault(); });
    pop.addEventListener('mousedown', (e) => { if (!(e.target as Element).closest('input, label')) e.preventDefault(); });
    pop.addEventListener('click', (e) => {
      const c = (e.target as HTMLElement).closest<HTMLElement>('[data-c]')?.dataset.c;
      if (!c) return;
      this.color(c, kind);
      this.closePop();
    });
    pop.querySelector('input')!.addEventListener('change', (e) => {
      this.color((e.target as HTMLInputElement).value, kind);
      this.closePop();
    });
    const outside = (e: PointerEvent) => {
      if (!pop.contains(e.target as Node) && !anchor.contains(e.target as Node)) this.closePop();
    };
    setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
    this.pop = pop;
    (pop as HTMLElement & { _off?: () => void })._off = () => document.removeEventListener('pointerdown', outside, true);
  }

  private closePop(): void {
    if (!this.pop) return;
    (this.pop as HTMLElement & { _off?: () => void })._off?.();
    this.pop.remove();
    this.pop = null;
  }

  private updateBar(): void {
    const b = this.d.bar;
    const row = !this.enabled ? 'off' : this.sel ? 'img' : 'text';
    b.dataset.row = row;
    b.dataset.kind = this.sel?.kind ?? '';
    if (row === 'text') {
      for (const t of ['pen', 'hl', 'eraser'] as const) b.querySelector(`[data-a="ink-${t}"]`)?.setAttribute('aria-pressed', String(this.inkTool === t));
      const dot = b.querySelector<HTMLElement>('.ink-dot');
      if (dot) {
        const hl = this.inkTool === 'hl';
        dot.style.background = hl ? this.inkPrefs.hlColor : this.inkPrefs.penColor;
        dot.style.width = dot.style.height = `${hl ? 14 : Math.round(6 + this.inkPrefs.penW * 5)}px`;
      }
      b.classList.toggle('inking', !!this.inkTool);
      const q = (c: string) => { try { return document.queryCommandState(c); } catch { return false; } };
      for (const c of ['bold', 'italic', 'underline', 'strikeThrough', 'insertUnorderedList', 'insertOrderedList']) {
        b.querySelector(`[data-a="${c}"]`)?.setAttribute('aria-pressed', String(q(c)));
      }
      const s = getSelection();
      const node = s && s.rangeCount && this.d.host.contains(s.anchorNode) ? s.anchorNode : null;
      const el = node ? (node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement) : null;
      const blk = el?.closest('h1, h2, h3, h4, h5, h6, blockquote, pre, p, li, div');
      const tag = blk?.tagName.toLowerCase() ?? 'p';
      const sel = b.querySelector<HTMLSelectElement>('[data-a="block"]')!;
      sel.value = BLOCKS.some(([v]) => v === tag) ? tag : 'p';
      const align = blk ? getComputedStyle(blk).textAlign : 'start';
      const map: Record<string, string> = { justifyLeft: 'left|start', justifyCenter: 'center', justifyRight: 'right|end', justifyFull: 'justify' };
      for (const [k, v] of Object.entries(map)) b.querySelector(`[data-a="${k}"]`)?.setAttribute('aria-pressed', String(new RegExp(`^(${v})$`).test(align) && !!blk));
      b.querySelector<HTMLButtonElement>('[data-a="undo"]')!.disabled = this.undoStack.length === 0 && !this.pending;
      b.querySelector<HTMLButtonElement>('[data-a="redo"]')!.disabled = this.redoStack.length === 0;
    } else if (row === 'img') {
      const float = this.sel?.kind === 'float';
      b.querySelector('[data-a="mode-fixed"]')!.setAttribute('aria-pressed', String(float));
      b.querySelector('[data-a="mode-inline"]')!.setAttribute('aria-pressed', String(!float));
      const f = this.selFloat();
      b.querySelector('[data-a="wrap-push"]')!.setAttribute('aria-pressed', String(f?.wrap === 'push'));
      b.querySelector('[data-a="wrap-front"]')!.setAttribute('aria-pressed', String(f?.wrap === 'front'));
      const fig = this.selFig();
      const al = fig?.dataset.align ?? '';
      for (const k of ['left', 'center', 'right', 'float-left', 'float-right']) b.querySelector(`[data-a="al-${k}"]`)?.setAttribute('aria-pressed', String(!float && al === k));
    }
  }

  private updateBanner(): void {
    const b = this.d.banner;
    const md = this.d.markdown();
    const diverged = this.doc.dirty && !md.startsWith(this.doc.mdBase);
    b.hidden = !diverged;
    if (!diverged || b.dataset.ready) return;
    b.dataset.ready = '1';
    b.innerHTML = `<span><b>The Markdown was edited by hand.</b> The page keeps its own edits until you choose.</span>
      <span class="ed-banner-actions">
        <button type="button" class="tb-btn primary" data-b="usemd" title="Re-render the page from the Markdown (pen drawings and fixed pictures stay)">Use Markdown</button>
        <button type="button" class="tb-btn" data-b="append" title="Add the whole Markdown below what is on the page">Add to end of page</button>
        <button type="button" class="tb-btn" data-b="keep" title="Keep the page and rewrite the Markdown from it">Keep page</button>
      </span>`;
    b.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest<HTMLElement>('[data-b]')?.dataset.b;
      if (!a) return;
      this.flushNow();
      const mdNow = this.d.markdown();
      if (a === 'append') {
        this.doc.html += safeMd(mdNow);
        this.syncMarkdown();
      } else if (a === 'usemd') {
        // The Markdown mirror now carries the formatting, so the page can be rebuilt from it.
        this.doc.html = safeMd(mdNow);
        this.doc.mdBase = mdNow;
        this.mdLossy = htmlToMarkdown(this.doc.html).lossy;
      } else this.syncMarkdown();
      this.commitDoc();
      this.updateBanner();
      if (a === 'usemd') this.d.toast('Page rebuilt from the Markdown — Undo brings the old page back');
    });
  }

  /** Short note for the Markdown pane when the page holds formatting Markdown cannot store. */
  get lossyNote(): string {
    return this.doc.dirty && this.mdLossy.length ? `Page-only formatting (not in Markdown): ${this.mdLossy.join(', ')}` : '';
  }

  /* ------------------------------------------------------------------ */
  /* Ink: pen, highlighter, eraser                                       */
  /* ------------------------------------------------------------------ */

  setInkTool(t: InkTool | null, rerender = true): void {
    if (t && !this.pagesView) {
      this.d.toast('Pen tools work in Pages view');
      t = null;
    }
    if (t === this.inkTool) return;
    this.inkTool = t;
    if (t) {
      this.flushNow();
      this.select(null);
      (document.activeElement as HTMLElement | null)?.blur?.();
      getSelection()?.removeAllRanges();
    }
    const host = this.d.host;
    host.classList.toggle('ink-mode', !!t);
    host.dataset.inkTool = t ?? '';
    if (this.enabled && !t) host.setAttribute('contenteditable', 'true');
    else host.removeAttribute('contenteditable');
    this.updateBar();
    void rerender;
  }

  private inkOptions(anchor: HTMLElement): void {
    this.closePop();
    const p = this.inkPrefs;
    const hl = this.inkTool === 'hl';
    const colors = hl ? HL_COLORS : PEN_COLORS;
    const widths = hl ? HL_WIDTHS : PEN_WIDTHS;
    const cur = hl ? p.hlColor : p.penColor;
    const curW = hl ? p.hlW : p.penW;
    const pop = document.createElement('div');
    pop.className = 'ed-pop ink-pop';
    pop.innerHTML = `<div class="ink-pop-title">${hl ? 'Highlighter' : 'Pen'}</div>
      <div class="ed-sws">${colors.map((c) => `<button type="button" class="ed-sw${c === cur ? ' on' : ''}" data-c="${c}" style="background:${c}" title="${c}"></button>`).join('')}</div>
      <div class="ink-widths">${widths.map((w) => `<button type="button" class="ink-w${w === curW ? ' on' : ''}" data-w="${w}" title="${w} mm"><i style="height:${Math.max(2, Math.min(14, w * (hl ? 1.6 : 5)))}px;background:${cur}"></i></button>`).join('')}</div>
      <label class="check ink-finger"><input type="checkbox" ${p.fingerDraws ? 'checked' : ''} /> Draw with finger too</label>
      <div class="ink-pop-row"><button type="button" class="mini-btn" data-clear="page">Clear page ink</button></div>`;
    document.body.appendChild(pop);
    const r = anchor.getBoundingClientRect();
    pop.style.left = `${clamp(r.left, 8, innerWidth - pop.offsetWidth - 8)}px`;
    pop.style.top = `${r.bottom + 6}px`;
    pop.addEventListener('pointerdown', (e) => { if (!(e.target as Element).closest('input, label')) e.preventDefault(); });
    pop.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const c = t.closest<HTMLElement>('[data-c]')?.dataset.c;
      const w = t.closest<HTMLElement>('[data-w]')?.dataset.w;
      if (c) { if (hl) p.hlColor = c; else p.penColor = c; }
      if (w) { if (hl) p.hlW = Number(w); else p.penW = Number(w); }
      if (t.closest('[data-clear]')) this.clearPageInk();
      if (c || w || t.closest('[data-clear]')) {
        saveInkPrefs(p);
        this.closePop();
        this.updateBar();
        if (!this.inkTool) this.setInkTool(hl ? 'hl' : 'pen');
      }
    });
    pop.querySelector('input')!.addEventListener('change', (e) => {
      p.fingerDraws = (e.target as HTMLInputElement).checked;
      saveInkPrefs(p);
    });
    const outside = (e: PointerEvent) => { if (!pop.contains(e.target as Node) && !anchor.contains(e.target as Node)) this.closePop(); };
    setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
    this.pop = pop;
    (pop as HTMLElement & { _off?: () => void })._off = () => document.removeEventListener('pointerdown', outside, true);
  }

  /** Removes the ink of the page that is most visible on screen. */
  private clearPageInk(): void {
    const pages = [...(this.d.pages()?.querySelectorAll<HTMLElement>(':scope > .page') ?? [])];
    const box = this.d.scroller.getBoundingClientRect();
    let best = -1;
    let bestVis = 0;
    pages.forEach((p, i) => {
      const r = p.getBoundingClientRect();
      const vis = Math.min(r.bottom, box.bottom) - Math.max(r.top, box.top);
      if (vis > bestVis) { bestVis = vis; best = i; }
    });
    if (best < 0) return;
    const before = (this.doc.ink ?? []).length;
    this.doc.ink = (this.doc.ink ?? []).filter((s) => s.page !== best);
    if (this.doc.ink.length === before) return this.d.toast('No pen drawing on this page');
    this.noScroll = true;
    this.commitDoc();
  }

  /** Pointer → page millimetres. */
  private pagePoint(page: HTMLElement, x: number, y: number): [number, number] {
    const r = page.getBoundingClientRect();
    const g = geometry(this.d.settings());
    return [((x - r.left) / r.width) * g.pageW, ((y - r.top) / r.height) * g.pageH];
  }

  private pageAt(x: number, y: number): HTMLElement | null {
    const el = document.elementFromPoint(x, y);
    return (el?.closest('.page') as HTMLElement | null) ?? null;
  }

  /** Which tool a pointer should use: the S Pen side button (or a pen eraser tip) erases while held. */
  private toolFor(e: PointerEvent): InkTool {
    if (e.pointerType === 'pen' && ((e.buttons & 32) || (e.buttons & 2) || e.button === 5 || e.button === 2 || this.hoverButton)) return 'eraser';
    return this.inkTool ?? 'pen';
  }

  /** Called from pointerdown (capture) on the host. Returns true when the event was taken. */
  private inkDown(e: PointerEvent): boolean {
    if (!this.inkTool || !this.pagesView) return false;
    if (e.pointerType === 'pen') this.penSeen = true;
    const finger = e.pointerType === 'touch';
    if (finger && (this.penSeen || !this.inkPrefs.fingerDraws)) return this.panDown(e);
    if (this.inkPtr !== null) return true;
    const page = this.pageAt(e.clientX, e.clientY);
    if (!page) return false;
    e.preventDefault();
    e.stopPropagation();
    this.inkPtr = e.pointerId;
    try { this.d.host.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const pageIdx = Number(page.dataset.page ?? '0');
    const tool = this.toolFor(e);
    if (tool === 'eraser') {
      this.erasing = { page: pageIdx, removed: false };
      this.eraseAt(page, e.clientX, e.clientY);
      return true;
    }
    const p = this.inkPrefs;
    const [x, y] = this.pagePoint(page, e.clientX, e.clientY);
    const s: InkStroke = {
      id: uid('k'), page: pageIdx, tool,
      color: tool === 'hl' ? p.hlColor : p.penColor,
      w: tool === 'hl' ? p.hlW : p.penW,
      pts: [x, y],
    };
    const layer = page.querySelector('.ink-layer');
    const g = layer?.querySelector(tool === 'hl' ? '.ink-g-hl' : '.ink-g-pen');
    const path = strokePath(s);
    g?.appendChild(path);
    this.stroke = { s, path, page, raf: 0 };
    return true;
  }

  private inkMove(e: PointerEvent): void {
    if (this.pan && e.pointerId === this.pan.id) return this.panMove(e);
    if (e.pointerId !== this.inkPtr) return;
    e.preventDefault();
    // A stylus that starts holding the side button mid-stroke switches to erasing.
    if (this.stroke && this.toolFor(e) === 'eraser') {
      this.finishStroke();
      const page = this.pageAt(e.clientX, e.clientY);
      this.erasing = { page: Number(page?.dataset.page ?? '0'), removed: false };
    }
    if (this.erasing) {
      const events = (e.getCoalescedEvents?.() ?? []).length ? e.getCoalescedEvents() : [e];
      for (const ev of events) {
        const page = this.pageAt(ev.clientX, ev.clientY);
        if (page) this.eraseAt(page, ev.clientX, ev.clientY);
      }
      return;
    }
    const st = this.stroke;
    if (!st) return;
    const events = (e.getCoalescedEvents?.() ?? []).length ? e.getCoalescedEvents() : [e];
    for (const ev of events) {
      const [x, y] = this.pagePoint(st.page, ev.clientX, ev.clientY);
      st.s.pts.push(x, y);
    }
    if (!st.raf) {
      st.raf = requestAnimationFrame(() => {
        st.raf = 0;
        st.path.setAttribute('d', pathD(st.s.pts));
      });
    }
  }

  private inkUp(e: PointerEvent): void {
    if (this.pan && e.pointerId === this.pan.id) return this.panUp();
    if (e.pointerId !== this.inkPtr) return;
    try { this.d.host.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    this.inkPtr = null;
    if (this.erasing) {
      const removed = this.erasing.removed;
      this.erasing = null;
      if (removed) this.commitInk();
      return;
    }
    this.finishStroke();
  }

  private finishStroke(): void {
    const st = this.stroke;
    if (!st) return;
    this.stroke = null;
    cancelAnimationFrame(st.raf);
    st.s.pts = simplify(st.s.pts);
    st.path.setAttribute('d', pathD(st.s.pts));
    (this.doc.ink ??= []).push(st.s);
    this.commitInk();
  }

  private eraseAt(page: HTMLElement, x: number, y: number): void {
    const [mx, my] = this.pagePoint(page, x, y);
    const idx = Number(page.dataset.page ?? '0');
    const r = 2.5 / Math.max(0.3, this.d.zoom()); // ~2.5 mm at 100 %
    const ink = this.doc.ink ?? [];
    const keep: InkStroke[] = [];
    for (const s of ink) {
      if (s.page === idx && hitStroke(s, mx, my, r)) {
        page.querySelector(`.ink-layer path[data-id="${s.id}"]`)?.remove();
        if (this.erasing) this.erasing.removed = true;
      } else keep.push(s);
    }
    if (keep.length !== ink.length) this.doc.ink = keep;
  }

  /** Ink changes: saved and undoable, but the pages are not rebuilt (the SVG is already up to date). */
  private commitInk(): void {
    this.pushState(this.state());
    this.scheduleSave();
    this.updateBar();
    // A stroke on a page that did not exist yet needs a new page: rare, rebuild then.
    const pages = this.d.pages()?.querySelectorAll(':scope > .page').length ?? 0;
    if (this.minPages() > pages) {
      this.noScroll = true;
      this.d.rerender();
    }
  }

  /* Finger scrolling while a pen tool is active (the page has touch-action:none). */
  private panDown(e: PointerEvent): boolean {
    if (this.pan) return true;
    this.pan = { id: e.pointerId, y: e.clientY, x: e.clientX, vy: 0, t: performance.now() };
    try { this.d.host.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    return true;
  }

  private panMove(e: PointerEvent): void {
    const p = this.pan!;
    const dy = e.clientY - p.y;
    const dx = e.clientX - p.x;
    const now = performance.now();
    p.vy = dy / Math.max(1, now - p.t);
    p.t = now;
    p.y = e.clientY;
    p.x = e.clientX;
    this.d.scroller.scrollTop -= dy;
    this.d.scroller.scrollLeft -= dx;
  }

  private panUp(): void {
    const p = this.pan;
    this.pan = null;
    if (!p) return;
    let v = -p.vy * 16; // px per frame
    const step = () => {
      if (Math.abs(v) < 0.5 || this.pan) return;
      this.d.scroller.scrollTop += v;
      v *= 0.94;
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /* ------------------------------------------------------------------ */
  /* Pictures                                                            */
  /* ------------------------------------------------------------------ */

  private float(id: string): FloatImg | undefined {
    return this.doc.floats.find((f) => f.id === id);
  }

  private selFloat(): FloatImg | undefined {
    return this.sel?.kind === 'float' ? this.float(this.sel.id) : undefined;
  }

  private selFig(): HTMLElement | null {
    return this.sel?.kind === 'fig' ? this.d.host.querySelector<HTMLElement>(`figure.ed-fig[data-id="${this.sel.id}"]`) : null;
  }

  private selEl(): HTMLElement | null {
    if (!this.sel) return null;
    return this.sel.kind === 'float' ? this.d.host.querySelector<HTMLElement>(`.fimg[data-id="${this.sel.id}"]`) : this.selFig();
  }

  private select(s: Sel): void {
    this.sel = s;
    if (s) {
      const sel = getSelection();
      sel?.removeAllRanges();
      if (this.d.isMobile() && this.hasFocus()) (document.activeElement as HTMLElement | null)?.blur?.();
    }
    this.applySel();
    this.updateBar();
  }

  private applySel(): void {
    for (const el of this.d.host.querySelectorAll('.sel')) el.classList.remove('sel');
    for (const el of this.d.host.querySelectorAll('.ed-ui')) el.remove();
    if (!this.enabled) this.sel = null;
    const el = this.selEl();
    if (!el) {
      this.sel = null;
      return;
    }
    el.classList.add('sel');
    for (const h of ['nw', 'ne', 'sw', 'se']) {
      const s = document.createElement('span');
      s.className = `ed-ui ed-h ed-h-${h}`;
      s.dataset.h = h;
      el.appendChild(s);
    }
  }

  private onPointerDown(e: PointerEvent): void {
    if (!this.enabled || this.inkTool) return;
    const t = e.target as Element;
    const pic = t.closest<HTMLElement>('.fimg, figure.ed-fig');
    if (!pic) {
      if (this.sel) this.select(null);
      return;
    }
    e.preventDefault();
    const kind = pic.classList.contains('fimg') ? 'float' : 'fig';
    const id = pic.dataset.id ?? '';
    const handle = t.closest<HTMLElement>('.ed-h');
    if (handle && this.sel?.id === id) return this.startResize(e, pic, handle.dataset.h!);
    if (this.sel?.id === id || e.pointerType === 'mouse') {
      if (this.sel?.id !== id) this.select({ kind, id });
      const active = this.selEl();
      if (active) {
        if (kind === 'float') this.startDrag(e, active);
        else this.startFigDrag(e, active);
      }
      return;
    }
    // Touch: select on a tap; a swipe keeps scrolling the page.
    const up = () => {
      pic.removeEventListener('pointerup', up);
      pic.removeEventListener('pointercancel', cancel);
      this.select({ kind, id });
    };
    const cancel = () => {
      pic.removeEventListener('pointerup', up);
      pic.removeEventListener('pointercancel', cancel);
    };
    pic.addEventListener('pointerup', up);
    pic.addEventListener('pointercancel', cancel);
  }

  private startDrag(e: PointerEvent, el: HTMLElement): void {
    const f = this.selFloat();
    const page = el.closest<HTMLElement>('.page');
    if (!f || !page) return;
    const z = this.d.zoom();
    const sx = e.clientX;
    const sy = e.clientY;
    let moved = false;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - sx) / z;
      const dy = (ev.clientY - sy) / z;
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
      if (!moved) {
        moved = true;
        page.classList.add('drag-host');
        el.classList.add('dragging');
      }
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      this.autoScroll(ev.clientY);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      if (!moved) return;
      const rect = el.getBoundingClientRect();
      el.style.transform = '';
      page.classList.remove('drag-host');
      el.classList.remove('dragging');
      const pages = [...(this.d.pages()?.querySelectorAll<HTMLElement>(':scope > .page') ?? [])];
      const cy = rect.top + rect.height / 2;
      let best = 0;
      let bestD = Infinity;
      pages.forEach((p, i) => {
        const r = p.getBoundingClientRect();
        const dist = cy < r.top ? r.top - cy : cy > r.bottom ? cy - r.bottom : 0;
        if (dist < bestD) { bestD = dist; best = i; }
      });
      const pr = pages[best].getBoundingClientRect();
      f.page = best;
      f.x = (rect.left - pr.left) / z / MM_PX;
      f.y = (rect.top - pr.top) / z / MM_PX;
      this.snapFloat(f);
      this.commitDoc();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  private startFigDrag(e: PointerEvent, fig: HTMLElement): void {
    const page = fig.closest<HTMLElement>('.page');
    const z = this.d.zoom();
    const sx = e.clientX;
    const sy = e.clientY;
    let moved = false;
    fig.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - sx) / z;
      const dy = (ev.clientY - sy) / z;
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
      if (!moved) {
        moved = true;
        page?.classList.add('drag-host');
        fig.classList.add('dragging');
      }
      fig.style.transform = `translate(${dx}px, ${dy}px)`;
      this.autoScroll(ev.clientY);
    };
    const up = (ev: PointerEvent) => {
      fig.removeEventListener('pointermove', move);
      fig.removeEventListener('pointerup', up);
      fig.removeEventListener('pointercancel', up);
      if (!moved) return;
      fig.style.transform = '';
      page?.classList.remove('drag-host');
      fig.classList.remove('dragging');
      if (this.pagesView) {
        const g = geometry(this.d.settings());
        const pages = [...(this.d.pages()?.querySelectorAll<HTMLElement>(':scope > .page') ?? [])];
        let best = 0;
        let bestD = Infinity;
        pages.forEach((p, i) => {
          const r = p.getBoundingClientRect();
          const dist = ev.clientY < r.top ? r.top - ev.clientY : ev.clientY > r.bottom ? ev.clientY - r.bottom : 0;
          if (dist < bestD) { bestD = dist; best = i; }
        });
        const pc = pages[best]?.querySelector<HTMLElement>(':scope > .page-content');
        if (pc) {
          const pr = pages[best].getBoundingClientRect();
          insertAtY(pc, fig, (ev.clientY - pr.top) / z - g.mt * MM_PX);
        }
      } else {
        const md = this.d.flowMd();
        if (md) {
          let placed = false;
          for (const c of [...md.children] as HTMLElement[]) {
            if (c === fig) continue;
            const r = c.getBoundingClientRect();
            if (r.top + r.height / 2 >= ev.clientY) {
              c.before(fig);
              placed = true;
              break;
            }
          }
          if (!placed) md.appendChild(fig);
        }
      }
      this.pending = true;
      this.commitDoc();
    };
    fig.addEventListener('pointermove', move);
    fig.addEventListener('pointerup', up);
    fig.addEventListener('pointercancel', up);
  }

  private autoScroll(clientY: number): void {
    const r = this.d.scroller.getBoundingClientRect();
    const edge = 40;
    if (clientY < r.top + edge) this.d.scroller.scrollTop -= 12;
    else if (clientY > r.bottom - edge) this.d.scroller.scrollTop += 12;
  }

  private snapFloat(f: FloatImg): void {
    const g = geometry(this.d.settings());
    const s = 3; // mm
    if (Math.abs(f.x + f.w / 2 - g.pageW / 2) < s) f.x = (g.pageW - f.w) / 2;
    else if (Math.abs(f.x - g.ml) < s) f.x = g.ml;
    else if (Math.abs(f.x + f.w - (g.pageW - g.mr)) < s) f.x = g.pageW - g.mr - f.w;
    if (Math.abs(f.y - g.mt) < s) f.y = g.mt;
    this.clampFloat(f);
  }

  private clampFloat(f: FloatImg): void {
    const g = geometry(this.d.settings());
    f.w = clamp(f.w, 5, g.pageW);
    const ratio = picHeight({ ...f, w: 1 });
    if (f.w * ratio > g.pageH) f.w = Math.max(5, g.pageH / ratio);
    const h = f.w * ratio;
    f.x = clamp(f.x, 0, Math.max(0, g.pageW - f.w));
    f.y = clamp(f.y, 0, Math.max(0, g.pageH - h));
  }

  private startResize(e: PointerEvent, el: HTMLElement, corner: string): void {
    const z = this.d.zoom();
    const sx = e.clientX;
    const sy = e.clientY;
    const east = corner.includes('e');
    const south = corner.includes('s');
    const f = this.selFloat();
    const fig = this.selFig();
    const g = geometry(this.d.settings());
    const data: PicData | undefined = f ?? (fig ? figData(fig) : undefined);
    if (!data) return;
    const ratio = picHeight({ ...data, w: 1 });
    const startW = data.w;
    const startH = startW * ratio;
    const startX = f?.x ?? 0;
    const startY = f?.y ?? 0;
    const centered = fig?.dataset.align === 'center';
    const maxW = f ? g.pageW : (fig?.parentElement?.clientWidth ?? g.pageW * MM_PX) / MM_PX;
    const target = e.target as HTMLElement;
    target.setPointerCapture(e.pointerId);
    let w = startW;
    const move = (ev: PointerEvent) => {
      const dxm = ((ev.clientX - sx) / z / MM_PX) * (east ? 1 : -1);
      const dym = ((ev.clientY - sy) / z / MM_PX) * (south ? 1 : -1);
      const wx = startW + dxm * (centered ? 2 : 1);
      const wy = (startH + dym) / ratio;
      w = clamp((wx + wy) / 2, 8, maxW);
      if (f) {
        const h = w * ratio;
        el.style.width = `${w}mm`;
        el.style.left = `${east ? startX : startX + startW - w}mm`;
        el.style.top = `${south ? startY : startY + startH - h}mm`;
      } else if (fig) {
        fig.style.width = `${w}mm`;
      }
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      if (Math.abs(w - startW) < 0.2) return;
      if (f) {
        const h = w * ratio;
        f.x = east ? startX : startX + startW - w;
        f.y = south ? startY : startY + startH - h;
        f.w = w;
        this.clampFloat(f);
        this.commitDoc();
      } else if (fig) {
        fig.dataset.w = String(+w.toFixed(2));
        hydrateFigure(fig);
        this.pending = true;
        this.commitDoc();
      }
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  }

  private alignSelected(where: string): void {
    const g = geometry(this.d.settings());
    const f = this.selFloat();
    if (f) {
      if (where === 'left') f.x = g.ml;
      else if (where === 'center') f.x = (g.pageW - f.w) / 2;
      else if (where === 'right') f.x = g.pageW - g.mr - f.w;
      else return;
      this.clampFloat(f);
      return this.commitDoc();
    }
    const fig = this.selFig();
    if (!fig) return;
    fig.dataset.align = where;
    this.pending = true;
    this.commitDoc();
  }

  private imgWidth(frac: number): void {
    const g = geometry(this.d.settings());
    const contentW = g.pageW - g.ml - g.mr;
    const f = this.selFloat();
    if (f) {
      const cx = f.x + f.w / 2;
      f.w = contentW * frac;
      const maxH = (g.pageH - g.mt - g.mb) * 0.95;
      if (picHeight(f) > maxH) f.w = maxH / picHeight({ ...f, w: 1 });
      f.x = cx - f.w / 2;
      this.clampFloat(f);
      return this.commitDoc();
    }
    const fig = this.selFig();
    if (!fig) return;
    fig.dataset.w = String(+(contentW * frac).toFixed(2));
    hydrateFigure(fig);
    this.pending = true;
    this.commitDoc();
  }

  private async cropSelected(): Promise<void> {
    const f = this.selFloat();
    const fig = this.selFig();
    const data: PicData | undefined = f ?? (fig ? figData(fig) : undefined);
    if (!data) return;
    const url = imageUrl(data.img);
    if (!url) return this.d.toast('The picture file is missing', 'error');
    const crop = await openCrop(url, data.nw, data.nh, { crop: data.crop });
    if (!crop) return;
    if (f) {
      f.crop = crop;
      this.clampFloat(f);
      return this.commitDoc();
    }
    const live = this.selFig();
    if (!live) return;
    live.dataset.crop = crop.map((n) => +n.toFixed(5)).join(',');
    hydrateFigure(live);
    this.pending = true;
    this.commitDoc();
  }

  private deleteSelected(): void {
    if (!this.sel) return;
    if (this.sel.kind === 'float') {
      const id = this.sel.id;
      this.doc.floats = this.doc.floats.filter((f) => f.id !== id);
    } else {
      this.selFig()?.remove();
      this.pending = true;
    }
    this.sel = null;
    this.commitDoc();
  }

  /** In line → fixed at the same spot on its page. */
  private toFixed(): void {
    const fig = this.selFig();
    if (!fig) return;
    if (!this.pagesView) return this.d.toast('Switch to Pages view to fix a picture to a page');
    const page = fig.closest<HTMLElement>('.page');
    const pages = [...(this.d.pages()?.querySelectorAll<HTMLElement>(':scope > .page') ?? [])];
    if (!page) return;
    const z = this.d.zoom();
    const pr = page.getBoundingClientRect();
    const box = (fig.querySelector('.ed-crop') ?? fig).getBoundingClientRect();
    const p = figData(fig);
    const f: FloatImg = {
      id: uid('p'), img: p.img, nw: p.nw, nh: p.nh, crop: p.crop, w: p.w, wrap: 'push',
      page: Math.max(0, pages.indexOf(page)),
      x: (box.left - pr.left) / z / MM_PX,
      y: (box.top - pr.top) / z / MM_PX,
    };
    fig.remove();
    this.pending = true;
    this.clampFloat(f);
    this.doc.floats.push(f);
    this.sel = { kind: 'float', id: f.id };
    this.commitDoc();
  }

  /** Fixed → in line, placed in the text where the picture was. */
  private toInline(): void {
    const f = this.selFloat();
    const pagesEl = this.d.pages();
    if (!f || !pagesEl) return;
    const g = geometry(this.d.settings());
    const page = pagesEl.querySelectorAll<HTMLElement>(':scope > .page')[f.page];
    const pc = page?.querySelector<HTMLElement>(':scope > .page-content');
    if (!pc) return;
    const fig = makeFigure(f, alignFor(f, g), uid('g'));
    insertAtY(pc, fig, (f.y - g.mt) * MM_PX);
    this.doc.floats = this.doc.floats.filter((x) => x.id !== f.id);
    this.pending = true;
    this.sel = { kind: 'fig', id: fig.dataset.id! };
    this.commitDoc();
  }

  async insertPictureFile(file: File, at?: { x: number; y: number }): Promise<void> {
    if (!this.enabled) {
      this.d.settings().editMode = true;
      this.d.saveSettings();
      this.d.rerender();
    }
    let rec: { blob: Blob; nw: number; nh: number };
    try {
      rec = await readImageFile(file);
    } catch {
      return this.d.toast('That file is not a picture this browser can read', 'error', 4000);
    }
    const id = await putImage(rec.blob, rec.nw, rec.nh);
    const url = imageUrl(id)!;
    const crop = await openCrop(url, rec.nw, rec.nh, { confirmLabel: 'Insert', title: 'Insert picture', crop: [0, 0, 1, 1] });
    if (!crop) return;
    const g = geometry(this.d.settings());
    const contentW = g.pageW - g.ml - g.mr;
    const contentH = g.pageH - g.mt - g.mb;
    const natural = (crop[2] * rec.nw) / MM_PX;
    const ratio = (crop[3] * rec.nh) / (crop[2] * rec.nw);
    let w = Math.min(contentW * 0.7, Math.max(25, natural));
    if (w * ratio > contentH * 0.8) w = (contentH * 0.8) / ratio;
    const pic: PicData = { img: id, nw: rec.nw, nh: rec.nh, crop, w };

    if (!this.pagesView) {
      this.insertFragment(fragOf(makeFigure(pic, 'center', uid('g'))));
      return;
    }
    // Fixed on the page where the caret (or drop point) is, text pushed below it.
    const pagesEl = this.d.pages();
    const pages = [...(pagesEl?.querySelectorAll<HTMLElement>(':scope > .page') ?? [])];
    if (!pages.length) return;
    const z = this.d.zoom();
    let pageIdx = -1;
    let yPx = 0;
    const pickPage = (clientY: number) => {
      let best = 0;
      let bestD = Infinity;
      pages.forEach((p, i) => {
        const r = p.getBoundingClientRect();
        const dist = clientY < r.top ? r.top - clientY : clientY > r.bottom ? clientY - r.bottom : 0;
        if (dist < bestD) { bestD = dist; best = i; }
      });
      return best;
    };
    if (at) {
      pageIdx = pickPage(at.y);
      yPx = at.y;
    } else {
      const r = this.savedRange;
      if (r && r.startContainer.isConnected && this.d.host.contains(r.startContainer)) {
        let rect = r.getBoundingClientRect();
        if (!rect.height) {
          const el = r.startContainer.nodeType === Node.ELEMENT_NODE ? (r.startContainer as Element) : r.startContainer.parentElement;
          if (el) rect = el.getBoundingClientRect();
        }
        if (rect.height) {
          pageIdx = pickPage(rect.top);
          yPx = rect.top;
        }
      }
      if (pageIdx < 0) {
        const sr = this.d.scroller.getBoundingClientRect();
        pageIdx = pickPage(sr.top + sr.height / 3);
        const pr = pages[pageIdx].getBoundingClientRect();
        yPx = Math.max(pr.top + g.mt * MM_PX * z, sr.top + 20);
      }
    }
    const pr = pages[pageIdx].getBoundingClientRect();
    const f: FloatImg = {
      id: uid('p'), ...pic, wrap: 'push', page: pageIdx,
      x: (g.pageW - w) / 2,
      y: clamp((yPx - pr.top) / z / MM_PX, g.mt, Math.max(g.mt, g.pageH - g.mb - w * ratio)),
    };
    if (at) f.x = clamp((at.x - pr.left) / z / MM_PX - w / 2, 0, g.pageW - w);
    this.doc.floats.push(f);
    this.sel = { kind: 'float', id: f.id };
    this.commitDoc();
    this.d.toast('Picture added — drag it to move, drag a corner to resize');
  }

  /** Document flow for exports, with fixed pictures placed in the text where they sit. */
  exportFlow(pages: HTMLElement): HTMLElement {
    const g = geometry(this.d.settings());
    const pageEls = [...pages.querySelectorAll<HTMLElement>(':scope > .page')];
    const floats = [...this.doc.floats].sort((a, b) => a.page - b.page || a.y - b.y);
    // Insert from the bottom up so earlier insertions do not shift later targets.
    for (const f of floats.reverse()) {
      const pc = pageEls[f.page]?.querySelector<HTMLElement>(':scope > .page-content');
      if (!pc) continue;
      insertAtY(pc, makeFigure(f, alignFor(f, g), f.id), (f.y - g.mt) * MM_PX);
    }
    return extractFlow(pages);
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Picture ids referenced by `<!-- picture {...} -->` markers in Markdown. */
export function mdImageIds(md: string): string[] {
  return [...md.matchAll(/"img":"([\w-]+)"/g)].map((m) => m[1]);
}

function safeMd(md: string): string {
  try {
    return markdownToHtml(md);
  } catch (err) {
    console.error(err);
    return `<p>${md.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>`;
  }
}

function fragOf(...nodes: Node[]): DocumentFragment {
  const f = document.createDocumentFragment();
  f.append(...nodes);
  return f;
}

function alignFor(f: FloatImg, g: Geometry): 'left' | 'center' | 'right' {
  const c = f.x + f.w / 2;
  if (Math.abs(c - g.pageW / 2) < 12) return 'center';
  return c < g.pageW / 2 ? 'left' : 'right';
}

/** Inserts `node` before the first block of `pc` that starts at or below `y` (px). */
function insertAtY(pc: HTMLElement, node: Node, y: number): void {
  for (const c of [...pc.children] as HTMLElement[]) {
    if (c.classList.contains('ex-spacer') || c.matches('.page-num, .page-label, .fimg')) continue;
    if (c.offsetTop + c.offsetHeight / 2 >= y) {
      c.before(node);
      return;
    }
  }
  pc.appendChild(node);
}

function topBlock(node: Node, container: Element): Element | null {
  let n: Node | null = node;
  while (n && n.parentNode !== container) n = n.parentNode;
  return n && n.nodeType === Node.ELEMENT_NODE ? (n as Element) : null;
}

function prevEl(el: Element): Element | null {
  let p = el.previousElementSibling;
  while (p && p.matches('.page-num, .page-label, .fimg, .ed-ui')) p = p.previousElementSibling;
  return p;
}

function nextEl(el: Element): Element | null {
  let p = el.nextElementSibling;
  while (p && p.matches('.page-num, .page-label, .fimg, .ed-ui')) p = p.nextElementSibling;
  return p;
}

function lastBlockOf(pc: Element): Element | null {
  let c = pc.lastElementChild;
  while (c && c.matches('.ex-spacer, .page-num, .page-label, .fimg, hr.page-break')) c = c.previousElementSibling;
  return c;
}

function firstBlockOf(pc: Element): Element | null {
  let c = pc.firstElementChild;
  while (c && c.matches('.ex-spacer, .page-num, .page-label, .fimg')) c = c.nextElementSibling;
  return c;
}

function isBlankRange(r: Range): boolean {
  if (r.toString().replace(/[\n\r\t\u200b]/g, '') !== '') return false;
  return !r.cloneContents().querySelector('img, .katex, br, figure, hr, input');
}

function isIsland(n: Node): boolean {
  return n.nodeType === Node.ELEMENT_NODE && ((n as Element).getAttribute('contenteditable') === 'false' || (n as Element).matches('.katex, figure, hr, br, img, input'));
}

function meaningful(n: Node): boolean {
  return !(n.nodeType === Node.TEXT_NODE && !(n.textContent ?? '').replace(/[\n\r\t]/g, ''));
}

function deepEnd(el: Element): [Node, number] {
  let n: Node = el;
  for (;;) {
    let last = n.lastChild;
    while (last && !meaningful(last)) last = last.previousSibling;
    if (!last) return [n, n.childNodes.length];
    if (last.nodeType === Node.TEXT_NODE) return [last, (last.textContent ?? '').length];
    if (isIsland(last)) {
      const idx = [...n.childNodes].indexOf(last as ChildNode);
      return [n, (last as Element).tagName === 'BR' ? idx : idx + 1];
    }
    n = last;
  }
}

function deepStart(el: Element): [Node, number] {
  let n: Node = el;
  for (;;) {
    let first = n.firstChild;
    while (first && !meaningful(first)) first = first.nextSibling;
    if (!first) return [n, 0];
    if (first.nodeType === Node.TEXT_NODE) return [first, 0];
    if (isIsland(first)) return [n, [...n.childNodes].indexOf(first as ChildNode)];
    n = first;
  }
}

function setCaret([node, off]: [Node, number]): void {
  const r = document.createRange();
  r.setStart(node, off);
  r.collapse(true);
  const s = getSelection();
  s?.removeAllRanges();
  s?.addRange(r);
}

function isTextBlock(el: Element): boolean {
  if (!TEXT_BLOCK.test(el.tagName) || el.matches('.ex-spacer, .table-wrap, .math-display, .blank-lines')) return false;
  for (const c of el.children) if (/^(P|DIV|UL|OL|TABLE|BLOCKQUOTE|PRE|H[1-6]|FIGURE|HR)$/.test(c.tagName)) return false;
  return true;
}

function lastTextBlock(el: Element): Element | null {
  let cur: Element | null = el;
  while (cur && !isTextBlock(cur)) {
    let c: Element | null = cur.lastElementChild;
    while (c && c.matches('[contenteditable="false"], .ed-ui')) c = c.previousElementSibling;
    cur = c;
  }
  return cur;
}

function firstTextBlock(el: Element): Element | null {
  let cur: Element | null = el;
  while (cur && !isTextBlock(cur)) {
    let c: Element | null = cur.firstElementChild;
    while (c && c.matches('[contenteditable="false"], .ed-ui')) c = c.nextElementSibling;
    cur = c;
  }
  return cur;
}

export type { Crop };
