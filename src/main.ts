import 'katex/dist/katex.min.css';
import './styles/markdown.css';
import './styles/app.css';
import './styles/print.css';
import sampleMarkdown from './sample.md?raw';
import { markdownToHtml } from './markdown';
import { paginate } from './paginate';
import {
  DEFAULTS, FONTS, MARGIN_PRESETS, MM_PX, geometry, loadSettings, saveSettings,
  type FontId, type Margins, type PaperId, type Settings,
} from './settings';
import { copyRich, wordHtmlFromNodes, wrapClipboardHtml } from './wordcopy';
import { PageEditor } from './editor';
import { hydrateFigures, figData, picHeight } from './flow';
import { croppedDataUrl } from './store';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const app = $('app');
const source = $<HTMLTextAreaElement>('source');
const stage = $('stage');
const scroller = $('preview-scroll');
const measure = $('measure');
const printRoot = $('print-root');
const toastEl = $('toast');

const SOURCE_KEY = 'mdstudio.source.v1';
let settings: Settings = loadSettings();

/* ------------------------------------------------------------------ */
/* State of the current render                                         */
/* ------------------------------------------------------------------ */

let html = '';
let htmlFor = '\u0000';
let pagesEl: HTMLElement | null = null;
let zoomBox: HTMLElement | null = null;
let pageCount = 0;
let lastZoom = 1;
let lastPagesHtml = '\u0000';
let lastBuiltHtml = '';
let flowMdEl: HTMLElement | null = null;
let editor: PageEditor | null = null;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

let toastTimer = 0;
function toast(msg: string, kind: 'ok' | 'error' = 'ok', ms = 2600): void {
  toastEl.textContent = msg;
  toastEl.classList.toggle('error', kind === 'error');
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove('show'), ms);
}

function mdClassName(): string {
  return [
    'md',
    settings.tableStyle === 'grid' ? 'tables-grid' : '',
    settings.fitTables ? 'fit-tables' : 'dsh-tables',
    settings.fitMath ? 'fit-math' : '',
  ].filter(Boolean).join(' ');
}

function applyMdVars(el: HTMLElement): void {
  const k = settings.fontSize / 14;
  el.style.setProperty('--md-font', FONTS[settings.font].css);
  el.style.setProperty('--k', String(k));
  el.style.setProperty('--ls', String(settings.lineSpacing));
  el.style.setProperty('--md-fs', `${settings.fontSize}px`);
  el.style.setProperty('--md-tfs', `${(13 * k).toFixed(2)}px`);
}

function createMd(): HTMLElement {
  const el = document.createElement('div');
  el.className = mdClassName();
  applyMdVars(el);
  return el;
}

/** HTML the preview shows: the edited page document, or the Markdown render. */
function currentHtml(): string {
  return editor ? editor.pageHtml(() => mdHtml()) : mdHtml();
}

function mdHtml(): string {
  if (htmlFor !== source.value) {
    try {
      html = markdownToHtml(source.value);
    } catch (err) {
      console.error(err);
      html = `<pre>${String(err)}</pre>`;
    }
    htmlFor = source.value;
  }
  return html;
}

/* ------------------------------------------------------------------ */
/* Fitting wide tables and equations                                   */
/* ------------------------------------------------------------------ */

/** Shrinks tables / display equations that are wider than their column. Must run while laid out. */
function fitContent(md: HTMLElement): void {
  for (const wrap of md.querySelectorAll<HTMLElement>('.table-wrap')) {
    const table = wrap.querySelector('table');
    if (!table) continue;
    table.style.removeProperty('zoom');
    table.style.removeProperty('width');
    if (!settings.fitTables) {
      const cols = Number(wrap.dataset.cols ?? '0');
      wrap.classList.toggle('wide', cols >= 4);
      continue;
    }
    const avail = wrap.clientWidth;
    if (avail <= 0) continue;
    // Narrowest width at which no word has to be broken.
    table.style.width = 'min-content';
    const minW = table.getBoundingClientRect().width;
    // Phone flow view: a readable, horizontally scrollable table beats a squashed one.
    const phoneFlow = isMobile() && settings.view === 'flow' && !md.closest('#measure');
    if (phoneFlow && minW > avail * 1.15) {
      table.style.width = `${Math.min(minW * 1.25, Math.max(avail * 1.6, minW))}px`;
      wrap.classList.add('scroll-x');
      continue;
    }
    wrap.classList.remove('scroll-x');
    if (minW > avail + 0.5) {
      // Scale down so whole words fit; below 55 % text gets unreadable, so stop
      // there and let over-long words wrap inside their cell instead.
      const z = Math.max(0.55, avail / minW);
      table.style.width = `${(avail / z).toFixed(2)}px`;
      table.style.zoom = String(z);
    } else {
      table.style.width = '100%';
    }
  }
  for (const disp of md.querySelectorAll<HTMLElement>('.katex-display')) {
    disp.style.removeProperty('zoom');
    disp.style.removeProperty('width');
    if (!settings.fitMath) continue;
    const avail = disp.clientWidth;
    const inner = disp.querySelector<HTMLElement>('.katex');
    if (!inner || avail <= 0) continue;
    const need = Math.max(disp.scrollWidth, inner.scrollWidth);
    if (need > avail + 1) {
      const z = Math.max(0.35, (avail - 1) / need);
      disp.style.width = `${(avail / z).toFixed(2)}px`;
      disp.style.zoom = String(z);
    }
  }
  // Very long inline equations inside text are allowed to wrap at operators by KaTeX;
  // ones that still overflow (e.g. a single huge fraction) are scaled down too.
  if (settings.fitMath) {
    for (const k of md.querySelectorAll<HTMLElement>(':not(.katex-display) > .katex')) {
      k.style.removeProperty('zoom');
      const host = k.closest<HTMLElement>('p, li, td, th, div, blockquote');
      if (!host) continue;
      const avail = host.clientWidth;
      const w = k.getBoundingClientRect().width;
      if (avail > 0 && w > avail + 1 && k.querySelectorAll('.base').length <= 1) {
        k.style.zoom = String(Math.max(0.4, avail / w));
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function stagePad(): number {
  return isMobile() ? 20 : 48;
}

function previewWidth(): number {
  return Math.max(120, scroller.clientWidth - stagePad());
}

function computeZoom(pageWpx: number, pageHpx: number): number {
  if (settings.view === 'flow') return settings.zoomMode === 'custom' ? settings.zoom : 1;
  const availW = previewWidth();
  const availH = Math.max(120, scroller.clientHeight - stagePad());
  if (settings.zoomMode === 'width') return Math.min(3, availW / pageWpx);
  if (settings.zoomMode === 'page') return Math.min(availW / pageWpx, availH / pageHpx);
  return settings.zoom;
}

function renderFlow(): void {
  const z = computeZoom(1, 1);
  lastZoom = z;
  stage.style.setProperty('--iz', String(1 / z));
  const avail = previewWidth();
  const css = settings.flowFull || isMobile() ? avail / z : Math.min(avail / z, 920);
  const sheet = document.createElement('div');
  sheet.className = 'flow-sheet';
  sheet.style.width = `${css}px`;
  const padV = isMobile() ? 18 : Math.min(40, css * 0.05);
  const padH = isMobile() ? 16 : Math.min(48, css * 0.06);
  sheet.style.padding = `${padV}px ${padH}px`;
  sheet.style.zoom = String(z);
  const md = createMd();
  md.innerHTML = currentHtml();
  hydrateFigures(md);
  editor?.decorateFlow(md);
  sheet.appendChild(md);
  const top = scroller.scrollTop;
  stage.replaceChildren(sheet);
  fitContent(md);
  scroller.scrollTop = top;
  flowMdEl = md;
  lastPagesHtml = '\u0000';
  pagesEl = null;
  zoomBox = null;
  pageCount = 0;
}

function footerReserve(mbMm: number): number {
  return settings.pageNumbers && mbMm < 8 ? 8 - mbMm : 0;
}

function buildPages(target: HTMLElement): { el: HTMLElement; count: number } {
  const g = geometry(settings);
  const reserve = footerReserve(g.mb);
  const contentWmm = g.pageW - g.ml - g.mr;
  const contentHmm = g.pageH - g.mt - g.mb - reserve;
  const contentW = contentWmm * MM_PX;
  const contentH = contentHmm * MM_PX - 1; // 1px safety for print rounding

  // Lay the document out once at the page's text width, fit tables/equations there.
  const src = createMd();
  src.style.width = `${contentW}px`;
  const docHtml = currentHtml();
  src.innerHTML = docHtml;
  hydrateFigures(src);
  measure.replaceChildren(src);
  fitContent(src);

  const pages = document.createElement('div');
  pages.className = 'pages';
  target.replaceChildren(pages);

  const newSlot = () => {
    const page = document.createElement('div');
    page.className = 'page' + (settings.guides ? ' guides' : '');
    page.style.width = `${g.pageW}mm`;
    page.style.height = `${g.pageH}mm`;
    const content = createMd();
    content.classList.add('page-content');
    content.style.left = `${g.ml}mm`;
    content.style.top = `${g.mt}mm`;
    content.style.width = `${contentWmm}mm`;
    content.style.height = `${contentHmm}mm`;
    page.appendChild(content);
    pages.appendChild(page);
    return { page, content };
  };

  const slots = paginate(src, contentH, newSlot, editor ? { bands: editor.bands(g), minPages: editor.minPages() } : {});
  measure.replaceChildren();
  slots.forEach((s, i) => {
    if (settings.pageNumbers) {
      const n = document.createElement('div');
      n.className = 'page-num';
      n.textContent = `${i + 1} / ${slots.length}`;
      const zone = g.mb + reserve;
      n.style.bottom = `${Math.max(2, zone / 2 - 1.6)}mm`;
      s.page.appendChild(n);
    }
    const label = document.createElement('div');
    label.className = 'page-label';
    s.page.appendChild(label);
  });
  editor?.decoratePages(pages);
  lastBuiltHtml = docHtml;
  return { el: pages, count: slots.length };
}

function renderPages(keepAbsolute = false): void {
  const g = geometry(settings);
  const keepRatio = scroller.scrollHeight > scroller.clientHeight ? scroller.scrollTop / scroller.scrollHeight : 0;
  const keepTop = scroller.scrollTop;
  const box = document.createElement('div');
  box.className = 'zoom-box';
  // Paginate inside the off-screen sandbox, then move into view.
  const holder = document.createElement('div');
  measure.after(holder);
  holder.style.cssText = 'position:absolute;left:-100000px;top:0;visibility:hidden;';
  const built = buildPages(holder);
  holder.remove();
  box.appendChild(built.el);
  stage.replaceChildren(box);
  pagesEl = built.el;
  zoomBox = box;
  pageCount = built.count;
  flowMdEl = null;
  lastPagesHtml = lastBuiltHtml;
  applyPageZoom(g.pageW * MM_PX, g.pageH * MM_PX);
  scroller.scrollTop = keepAbsolute ? keepTop : keepRatio * scroller.scrollHeight;
}

function applyPageZoom(pageWpx?: number, pageHpx?: number): void {
  if (!pagesEl || !zoomBox) return;
  const g = geometry(settings);
  const w = pageWpx ?? g.pageW * MM_PX;
  const h = pageHpx ?? g.pageH * MM_PX;
  const z = computeZoom(w, h);
  lastZoom = z;
  stage.style.setProperty('--iz', String(1 / z));
  pagesEl.style.transform = `scale(${z})`;
  pagesEl.style.transformOrigin = 'top left';
  const natW = pagesEl.offsetWidth;
  const natH = pagesEl.offsetHeight;
  zoomBox.style.width = `${natW * z}px`;
  zoomBox.style.height = `${natH * z}px`;
  updateStatus();
}

function render(keepAbsolute = false): void {
  // On phones the preview is hidden behind other tabs; it renders when shown.
  if (scroller.clientWidth === 0) {
    updateStatus();
    return;
  }
  editor?.prepareRender();
  if (settings.view === 'flow') renderFlow();
  else renderPages(keepAbsolute || !!editor?.enabled);
  editor?.afterRender();
  if (editor?.enabled) keepCaretVisible();
  updateStatus();
}

/** After a re-layout, scroll just enough to keep the caret on screen. */
function keepCaretVisible(): void {
  const sel = getSelection();
  if (!sel || !sel.rangeCount || !stage.contains(sel.anchorNode)) return;
  const r = sel.getRangeAt(0);
  let rect = r.getBoundingClientRect();
  if (!rect.height) {
    const el = r.startContainer.nodeType === Node.ELEMENT_NODE ? (r.startContainer as Element) : r.startContainer.parentElement;
    if (!el) return;
    rect = el.getBoundingClientRect();
  }
  const box = scroller.getBoundingClientRect();
  if (rect.bottom > box.bottom - 24) scroller.scrollTop += rect.bottom - box.bottom + 60;
  else if (rect.top < box.top + 8) scroller.scrollTop -= box.top - rect.top + 60;
}

function updateStatus(): void {
  const g = geometry(settings);
  $('status-pages').textContent = settings.view === 'pages' ? `${pageCount} page${pageCount === 1 ? '' : 's'}` : 'Flow view';
  const paperName = settings.paper === 'Custom' ? `${g.pageW}×${g.pageH} mm` : settings.paper;
  $('status-paper').textContent = isMobile()
    ? `${paperName} · ${fmt(g.mt)} mm margins`
    : `${paperName} ${settings.landscape ? 'landscape' : 'portrait'} · margins ${fmt(g.mt)}/${fmt(g.mr)}/${fmt(g.mb)}/${fmt(g.ml)} mm`;
  $('status-zoom').textContent = `${Math.round(lastZoom * 100)}%`;
  const sel = $<HTMLSelectElement>('zoom-select');
  if (settings.zoomMode !== 'custom') sel.value = settings.zoomMode;
  else {
    const match = [...sel.options].find((o) => Math.abs(Number(o.value) - settings.zoom) < 0.001);
    const custom = sel.querySelector<HTMLOptionElement>('option[value="custom"]')!;
    if (match) sel.value = match.value;
    else {
      custom.textContent = `${Math.round(settings.zoom * 100)}%`;
      sel.value = 'custom';
    }
  }
}

const fmt = (n: number) => (Math.round(n * 10) / 10).toString();

/* debounced re-render */
let renderTimer = 0;
let renderRaf = 0;
function scheduleRender(delay = 0): void {
  clearTimeout(renderTimer);
  cancelAnimationFrame(renderRaf);
  renderTimer = window.setTimeout(() => {
    renderRaf = requestAnimationFrame(() => render());
  }, delay);
}

/* ------------------------------------------------------------------ */
/* Settings UI                                                         */
/* ------------------------------------------------------------------ */

function commit(rerender = true): void {
  saveSettings(settings);
  syncUi();
  if (rerender) scheduleRender(30);
}

function setPressed(id: string, on: boolean): void {
  $(id).setAttribute('aria-pressed', String(on));
}

function syncUi(): void {
  app.classList.toggle('no-editor', !settings.editorOpen);
  app.classList.toggle('no-setup', !settings.setupOpen);
  setPressed('btn-editor', settings.editorOpen);
  setPressed('btn-setup', settings.setupOpen);
  setPressed('view-pages', settings.view === 'pages');
  setPressed('view-flow', settings.view === 'flow');
  setPressed('orient-portrait', !settings.landscape);
  setPressed('orient-landscape', settings.landscape);
  setPressed('tables-minimal', settings.tableStyle === 'minimal');
  setPressed('tables-grid', settings.tableStyle === 'grid');
  if (settings.editorWidth > 0) $('editor-pane').style.width = `${settings.editorWidth}px`;

  $<HTMLSelectElement>('paper').value = settings.paper;
  $('custom-size').classList.toggle('show', settings.paper === 'Custom');
  $<HTMLInputElement>('custom-w').value = String(settings.customW);
  $<HTMLInputElement>('custom-h').value = String(settings.customH);

  for (const side of ['top', 'right', 'bottom', 'left'] as const) {
    const v = String(settings.margins[side]);
    const num = $<HTMLInputElement>(`m-${side}`);
    if (document.activeElement !== num) num.value = v;
    $<HTMLInputElement>(`m-${side}-r`).value = v;
  }
  $<HTMLInputElement>('link-margins').checked = settings.linkMargins;
  $<HTMLInputElement>('guides').checked = settings.guides;
  for (const chip of document.querySelectorAll<HTMLButtonElement>('#margin-presets .chip')) {
    const p = MARGIN_PRESETS[chip.dataset.preset!];
    const same = p && (['top', 'right', 'bottom', 'left'] as const).every((k) => Math.abs(p[k] - settings.margins[k]) < 0.05);
    chip.setAttribute('aria-pressed', String(!!same));
  }
  const g = geometry(settings);
  const inner = $('m-inner');
  inner.style.left = `${(g.ml / g.pageW) * 100}%`;
  inner.style.right = `${(g.mr / g.pageW) * 100}%`;
  inner.style.top = `${(g.mt / g.pageH) * 100}%`;
  inner.style.bottom = `${(g.mb / g.pageH) * 100}%`;
  const diagram = inner.parentElement!;
  const ratio = g.pageW / g.pageH;
  diagram.style.width = `${ratio >= 1 ? 78 : 78 * ratio}px`;
  diagram.style.height = `${ratio >= 1 ? 78 / ratio : 78}px`;

  $<HTMLSelectElement>('font').value = settings.font;
  $<HTMLInputElement>('font-size').value = String(settings.fontSize);
  $('font-size-out').textContent = `${settings.fontSize}px (${fmt(settings.fontSize * 0.75)}pt)`;
  $<HTMLInputElement>('line-spacing').value = String(settings.lineSpacing);
  $('line-out').textContent = `${settings.lineSpacing.toFixed(2)}×`;
  $<HTMLInputElement>('fit-tables').checked = settings.fitTables;
  $<HTMLInputElement>('fit-math').checked = settings.fitMath;
  $<HTMLInputElement>('page-numbers').checked = settings.pageNumbers;
  $<HTMLInputElement>('flow-full').checked = settings.flowFull;
}

function setMargin(side: keyof Margins, value: number): void {
  if (!Number.isFinite(value)) return;
  value = Math.max(0, Math.min(100, value));
  if (settings.linkMargins) settings.margins = { top: value, right: value, bottom: value, left: value };
  else settings.margins = { ...settings.margins, [side]: value };
}

function initSetup(): void {
  const fontSel = $<HTMLSelectElement>('font');
  for (const [id, f] of Object.entries(FONTS)) fontSel.add(new Option(f.label, id));
  const chips = $('margin-presets');
  for (const name of Object.keys(MARGIN_PRESETS)) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.type = 'button';
    b.dataset.preset = name;
    b.textContent = name;
    b.addEventListener('click', () => {
      settings.margins = { ...MARGIN_PRESETS[name] };
      const m = settings.margins;
      settings.linkMargins = m.top === m.right && m.right === m.bottom && m.bottom === m.left;
      commit();
    });
    chips.appendChild(b);
  }

  $('paper').addEventListener('change', (e) => {
    settings.paper = (e.target as HTMLSelectElement).value as PaperId;
    commit();
  });
  $('custom-w').addEventListener('change', (e) => {
    settings.customW = Math.max(50, Math.min(1000, Number((e.target as HTMLInputElement).value) || 210));
    commit();
  });
  $('custom-h').addEventListener('change', (e) => {
    settings.customH = Math.max(50, Math.min(2000, Number((e.target as HTMLInputElement).value) || 297));
    commit();
  });
  $('orient-portrait').addEventListener('click', () => { settings.landscape = false; commit(); });
  $('orient-landscape').addEventListener('click', () => { settings.landscape = true; commit(); });

  for (const side of ['top', 'right', 'bottom', 'left'] as const) {
    const range = $<HTMLInputElement>(`m-${side}-r`);
    const num = $<HTMLInputElement>(`m-${side}`);
    range.addEventListener('input', () => { setMargin(side, Number(range.value)); commit(); });
    num.addEventListener('input', () => {
      if (num.value === '') return;
      setMargin(side, Number(num.value));
      commit();
    });
    num.addEventListener('blur', () => syncUi());
  }
  $('link-margins').addEventListener('change', (e) => {
    settings.linkMargins = (e.target as HTMLInputElement).checked;
    if (settings.linkMargins) setMargin('top', settings.margins.top);
    commit();
  });
  $('guides').addEventListener('change', (e) => { settings.guides = (e.target as HTMLInputElement).checked; commit(); });
  fontSel.addEventListener('change', () => { settings.font = fontSel.value as FontId; commit(); });
  $('font-size').addEventListener('input', (e) => { settings.fontSize = Number((e.target as HTMLInputElement).value); commit(); });
  $('line-spacing').addEventListener('input', (e) => { settings.lineSpacing = Number((e.target as HTMLInputElement).value); commit(); });
  $('tables-minimal').addEventListener('click', () => { settings.tableStyle = 'minimal'; commit(); });
  $('tables-grid').addEventListener('click', () => { settings.tableStyle = 'grid'; commit(); });
  $('fit-tables').addEventListener('change', (e) => { settings.fitTables = (e.target as HTMLInputElement).checked; commit(); });
  $('fit-math').addEventListener('change', (e) => { settings.fitMath = (e.target as HTMLInputElement).checked; commit(); });
  $('page-numbers').addEventListener('change', (e) => { settings.pageNumbers = (e.target as HTMLInputElement).checked; commit(); });
  $('flow-full').addEventListener('change', (e) => { settings.flowFull = (e.target as HTMLInputElement).checked; commit(); });
  $('btn-reset').addEventListener('click', () => {
    const keep = { editorOpen: settings.editorOpen, setupOpen: settings.setupOpen, editorWidth: settings.editorWidth, view: settings.view };
    settings = { ...structuredClone(DEFAULTS), ...keep };
    commit();
    toast('Settings restored to defaults');
  });
}

/* ------------------------------------------------------------------ */
/* Zoom                                                                */
/* ------------------------------------------------------------------ */

const STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

function setZoom(z: number): void {
  settings.zoom = Math.max(0.2, Math.min(4, Math.round(z * 100) / 100));
  settings.zoomMode = 'custom';
  saveSettings(settings);
  if (settings.view === 'pages') applyPageZoom();
  else scheduleRender(0);
  updateStatus();
}

function stepZoom(dir: 1 | -1): void {
  const cur = lastZoom;
  const next = dir > 0 ? STEPS.find((s) => s > cur + 0.005) ?? STEPS[STEPS.length - 1] : [...STEPS].reverse().find((s) => s < cur - 0.005) ?? STEPS[0];
  setZoom(next);
}

function initZoom(): void {
  $('zoom-in').addEventListener('click', () => stepZoom(1));
  $('zoom-out').addEventListener('click', () => stepZoom(-1));
  $<HTMLSelectElement>('zoom-select').addEventListener('change', (e) => {
    const v = (e.target as HTMLSelectElement).value;
    if (v === 'width' || v === 'page') {
      settings.zoomMode = v;
      saveSettings(settings);
      if (settings.view === 'pages') applyPageZoom();
      else scheduleRender(0);
      updateStatus();
    } else if (v !== 'custom') setZoom(Number(v));
  });
  scroller.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.0015);
      // Keep the point under the cursor steady.
      const rect = scroller.getBoundingClientRect();
      const px = e.clientX - rect.left + scroller.scrollLeft;
      const py = e.clientY - rect.top + scroller.scrollTop;
      const before = lastZoom;
      setZoom(before * factor);
      const ratio = lastZoom / before;
      scroller.scrollLeft = px * ratio - (e.clientX - rect.left);
      scroller.scrollTop = py * ratio - (e.clientY - rect.top);
    },
    { passive: false },
  );
}

/* ------------------------------------------------------------------ */
/* PDF                                                                 */
/* ------------------------------------------------------------------ */

let pageStyle: HTMLStyleElement | null = null;

function preparePrint(): void {
  const g = geometry(settings);
  pageStyle ??= document.head.appendChild(document.createElement('style'));
  pageStyle.textContent = `@page { size: ${g.pageW}mm ${g.pageH}mm; margin: 0; }`;
  const built = buildPagesForPrint();
  printRoot.replaceChildren(built);
}

function buildPagesForPrint(): HTMLElement {
  editor?.flushNow();
  // Reuse the on-screen pagination when it is current, otherwise build fresh.
  let clone: HTMLElement;
  if (settings.view === 'pages' && pagesEl && pagesEl.isConnected && scroller.clientWidth > 0 && lastPagesHtml === currentHtml()) {
    clone = pagesEl.cloneNode(true) as HTMLElement;
    clone.style.transform = 'none';
  } else {
    const holder = document.createElement('div');
    holder.style.cssText = 'position:absolute;left:-100000px;top:0;visibility:hidden;';
    document.body.appendChild(holder);
    clone = buildPages(holder).el;
    holder.remove();
  }
  for (const el of clone.querySelectorAll('.ed-ui')) el.remove();
  for (const el of clone.querySelectorAll('.sel')) el.classList.remove('sel');
  for (const el of clone.querySelectorAll('[contenteditable]')) el.removeAttribute('contenteditable');
  return clone;
}

function exportPdf(): void {
  const dialog = $<HTMLDialogElement>('pdf-dialog');
  if (localStorage.getItem('mdstudio.pdfhint') === 'off' || typeof dialog.showModal !== 'function') {
    doPrint();
    return;
  }
  dialog.showModal();
}

function doPrint(): void {
  const title = document.title;
  document.title = suggestedName();
  preparePrint();
  // Let layout settle (fonts are already loaded), then open the dialog.
  requestAnimationFrame(() => {
    window.print();
    document.title = title;
  });
}

function suggestedName(): string {
  const m = /^\s*#{1,6}\s+(.+)$/m.exec(source.value) ?? /^\s*\*\*(.+?)\*\*/m.exec(source.value);
  const base = (m?.[1] ?? 'document').replace(/[$*_`\\]/g, '').replace(/[<>:"/|?*\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return base.slice(0, 80) || 'document';
}

/* ------------------------------------------------------------------ */
/* Word                                                                */
/* ------------------------------------------------------------------ */

/** The document laid out at page text width (for Word copy / .docx). */
function exportMd(): HTMLElement {
  const g = geometry(settings);
  const md = createMd();
  md.style.width = `${(g.pageW - g.ml - g.mr) * MM_PX}px`;
  if (editor?.edited) {
    editor.flushNow();
    // Fixed pictures go into the text where they sit on the page.
    const pages = buildPagesForPrint();
    measure.replaceChildren(pages);
    md.innerHTML = editor.exportFlow(pages).innerHTML;
  } else md.innerHTML = currentHtml();
  hydrateFigures(md);
  measure.replaceChildren(md);
  return md;
}

/** Word copy: pictures become cropped <img> data URLs Word can paste. */
async function inlinePictures(root: DocumentFragment): Promise<void> {
  for (const fig of root.querySelectorAll<HTMLElement>('figure.ed-fig')) {
    const p = figData(fig);
    const url = await croppedDataUrl(p.img, p.crop);
    const wPx = Math.round(p.w * MM_PX);
    const hPx = Math.round(picHeight(p) * MM_PX);
    const para = document.createElement('p');
    const al = fig.dataset.align ?? 'center';
    para.setAttribute('align', al.includes('right') ? 'right' : al.includes('left') ? 'left' : 'center');
    para.style.textAlign = para.getAttribute('align')!;
    if (url) {
      const img = document.createElement('img');
      img.src = url;
      img.width = wPx;
      img.height = hPx;
      img.style.cssText = `width:${wPx}px;height:${hPx}px;`;
      para.appendChild(img);
    }
    fig.replaceWith(para);
  }
}

async function wordCopy(): Promise<void> {
  const btn = $<HTMLButtonElement>('btn-wordcopy');
  try {
    const md = exportMd();
    const frag = document.createDocumentFragment();
    frag.append(...[...md.childNodes].map((n) => n.cloneNode(true)));
    measure.replaceChildren();
    if (editor?.edited) await inlinePictures(frag);
    const fragment = wordHtmlFromNodes(frag, settings);
    await copyRich(wrapClipboardHtml(fragment), editor?.edited ? (md.innerText || md.textContent || '') : source.value);
    for (const b of [btn, $('m-wordcopy')]) {
      b.classList.add('ok');
      setTimeout(() => b.classList.remove('ok'), 1800);
    }
    btn.querySelector('span')!.textContent = 'Copied!';
    setTimeout(() => {
      btn.querySelector('span')!.textContent = 'Word copy';
    }, 1800);
    toast(isMobile() ? 'Copied — paste into Word' : 'Copied — paste into Word with Ctrl+V (equations arrive as editable Word equations)');
  } catch (err) {
    toast(`Copy failed: ${(err as Error).message}`, 'error', 4000);
  }
}

async function downloadDocx(): Promise<void> {
  const btn = $<HTMLButtonElement>('btn-docx');
  btn.disabled = true;
  try {
    const docx = await import('./docx');
    let blob: Blob;
    if (editor?.edited) {
      const md = exportMd();
      blob = await docx.htmlToDocx(md, settings);
      measure.replaceChildren();
    } else blob = await docx.markdownToDocx(source.value, settings);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${suggestedName()}.docx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast('Word document downloaded');
  } catch (err) {
    console.error(err);
    toast(`.docx export failed: ${(err as Error).message}`, 'error', 4000);
  } finally {
    btn.disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* Editor                                                              */
/* ------------------------------------------------------------------ */

function updateStats(): void {
  const text = source.value;
  const words = (text.match(/[\p{L}\p{N}]+/gu) ?? []).length;
  $('editor-stats').textContent = `${words.toLocaleString()} words · ${text.length.toLocaleString()} characters`;
}

let saveTimer = 0;
function saveSource(): void {
  clearTimeout(saveTimer);
  saveTimer = 0;
  try { localStorage.setItem(SOURCE_KEY, source.value); } catch { /* ignore */ }
}

function onSourceChange(): void {
  updateStats();
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(saveSource, 400);
  editor?.onMarkdownChange();
  scheduleRender(source.value.length > 40000 ? 450 : 200);
}

function setSource(text: string): void {
  source.value = text;
  onSourceChange();
}

function initEditor(): void {
  const saved = localStorage.getItem(SOURCE_KEY);
  source.value = saved && saved !== sampleMarkdown ? saved : '';
  updateStats();
  source.addEventListener('input', onSourceChange);
  source.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      const { selectionStart: s, selectionEnd: t } = source;
      source.setRangeText('    ', s, t, 'end');
      onSourceChange();
    }
  });
  $('btn-sample').addEventListener('click', () => {
    setSource(sampleMarkdown);
    toast('Sample loaded');
  });
  $('btn-clear').addEventListener('click', () => {
    setSource('');
    source.focus();
  });
  $('btn-paste').addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return toast('Clipboard is empty', 'error');
      setSource(text);
      toast('Pasted from clipboard');
    } catch {
      source.focus();
      source.select();
      toast('Clipboard read was blocked — press Ctrl+V in the editor instead', 'error', 3500);
    }
  });
  const fileInput = $<HTMLInputElement>('file-input');
  $('btn-open').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files?.[0];
    if (f) setSource(await f.text());
    fileInput.value = '';
  });
  // Drag & drop a file anywhere.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    e.preventDefault();
    if (f.type.startsWith('image/')) {
      if (editor) void editor.insertPictureFile(f);
      return;
    }
    setSource(await f.text());
  });
  window.addEventListener('pagehide', saveSource);

  // Splitter
  const splitter = $('splitter');
  const pane = $('editor-pane');
  splitter.addEventListener('pointerdown', (e) => {
    splitter.setPointerCapture(e.pointerId);
    splitter.classList.add('dragging');
    const startX = e.clientX;
    const startW = pane.getBoundingClientRect().width;
    const move = (ev: PointerEvent) => {
      const w = Math.max(240, Math.min(window.innerWidth * 0.7, startW + ev.clientX - startX));
      pane.style.width = `${w}px`;
    };
    const up = () => {
      splitter.classList.remove('dragging');
      splitter.removeEventListener('pointermove', move);
      splitter.removeEventListener('pointerup', up);
      settings.editorWidth = Math.round(pane.getBoundingClientRect().width);
      saveSettings(settings);
    };
    splitter.addEventListener('pointermove', move);
    splitter.addEventListener('pointerup', up);
  });
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

function initToolbar(): void {
  $('btn-editor').addEventListener('click', () => { settings.editorOpen = !settings.editorOpen; commit(false); });
  $('btn-setup').addEventListener('click', () => { settings.setupOpen = !settings.setupOpen; commit(false); });
  $('view-pages').addEventListener('click', () => { settings.view = 'pages'; commit(); });
  $('view-flow').addEventListener('click', () => { settings.view = 'flow'; commit(); });
  $('btn-pdf').addEventListener('click', exportPdf);
  $('btn-wordcopy').addEventListener('click', () => void wordCopy());
  $('btn-docx').addEventListener('click', () => void downloadDocx());

  const dialog = $<HTMLDialogElement>('pdf-dialog');
  dialog.addEventListener('close', () => {
    if ($<HTMLInputElement>('pdf-dont-show').checked) localStorage.setItem('mdstudio.pdfhint', 'off');
    if (dialog.returnValue === 'ok') setTimeout(doPrint, 50);
  });

  window.addEventListener('beforeprint', () => {
    if (!printRoot.firstChild) preparePrint();
  });
  window.addEventListener('afterprint', () => printRoot.replaceChildren());

  window.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    const k = e.key.toLowerCase();
    if (k === 'p') {
      e.preventDefault();
      exportPdf();
    } else if (k === 'e') {
      e.preventDefault();
      settings.editorOpen = !settings.editorOpen;
      commit(false);
    } else if ((k === '=' || k === '+') && document.activeElement !== source) {
      e.preventDefault();
      stepZoom(1);
    } else if (k === '-' && document.activeElement !== source) {
      e.preventDefault();
      stepZoom(-1);
    } else if (k === '0' && document.activeElement !== source) {
      e.preventDefault();
      settings.zoomMode = 'width';
      commit(settings.view === 'flow');
      applyPageZoom();
    }
  });

  // Re-fit when the preview area changes size.
  let lastW = 0;
  let lastH = 0;
  new ResizeObserver(() => {
    const w = scroller.clientWidth;
    const h = scroller.clientHeight;
    if (w === 0 || h === 0) return; // hidden (another tab on phones)
    if (w === lastW && h === lastH) return;
    const widthChanged = w !== lastW;
    lastW = w;
    lastH = h;
    if (settings.view === 'flow') {
      if (widthChanged) scheduleRender(60);
    } else applyPageZoom();
  }).observe(scroller);
}

/* ------------------------------------------------------------------ */
/* Phone layout                                                        */
/* ------------------------------------------------------------------ */

type Tab = 'edit' | 'preview' | 'setup' | 'export';
const mobileQuery = window.matchMedia('(max-width: 820px)');
let tab: Tab = 'preview';

function isMobile(): boolean {
  return mobileQuery.matches;
}

function setTab(next: Tab): void {
  const prev = tab;
  tab = next;
  app.dataset.tab = next;
  for (const b of document.querySelectorAll<HTMLButtonElement>('#bottom-nav button')) {
    if (b.dataset.tab === next) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  if (next === 'export') updateExportSummary();
  // The preview may have been laid out while hidden (zero size): refresh it on show.
  if (next === 'preview' && prev !== 'preview') requestAnimationFrame(() => render());
  if (next !== 'edit') source.blur();
}

function updateExportSummary(): void {
  const g = geometry(settings);
  const paper = settings.paper === 'Custom' ? `${g.pageW}×${g.pageH} mm` : settings.paper;
  $('m-export-summary').textContent = `${paper} ${settings.landscape ? 'landscape' : 'portrait'} · margins ${fmt(g.mt)} mm${pageCount ? ` · ${pageCount} page${pageCount === 1 ? '' : 's'}` : ''}`;
}

function applyLayout(): void {
  const mobile = isMobile();
  app.classList.toggle('mobile', mobile);
  if (mobile) setTab(tab);
  else delete app.dataset.tab;
}

/** Two-finger pinch zoom on the preview (pages and flow). */
function initPinchZoom(): void {
  let startDist = 0;
  let startZoom = 1;
  let pinching = false;
  const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  scroller.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      pinching = true;
      startDist = dist(e.touches);
      startZoom = lastZoom;
    }
  }, { passive: true });
  scroller.addEventListener('touchmove', (e) => {
    if (!pinching || e.touches.length !== 2) return;
    e.preventDefault();
    const z = Math.max(0.2, Math.min(4, startZoom * (dist(e.touches) / startDist)));
    if (settings.view === 'pages' && pagesEl && zoomBox) {
      // Cheap live preview: rescale only; the full re-layout runs when the fingers lift.
      settings.zoom = z;
      settings.zoomMode = 'custom';
      applyPageZoom();
    } else {
      settings.zoom = z;
      settings.zoomMode = 'custom';
    }
  }, { passive: false });
  scroller.addEventListener('touchend', (e) => {
    if (!pinching || e.touches.length > 0) return;
    pinching = false;
    setZoom(settings.zoom);
  });
}

function initMobile(): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>('#bottom-nav button')) {
    b.addEventListener('click', () => setTab(b.dataset.tab as Tab));
  }
  $('m-pdf').addEventListener('click', exportPdf);
  $('m-docx').addEventListener('click', () => void downloadDocx());
  $('m-wordcopy').addEventListener('click', () => void wordCopy());
  $('m-goto-setup').addEventListener('click', () => setTab('setup'));
  // A fresh visit on a phone opens on the editor when empty, or preview when text is saved.
  tab = source.value.trim() ? 'preview' : 'edit';
  // First visit on a phone: start in the readable Flow view (an explicit choice is kept).
  if (isMobile() && localStorage.getItem('mdstudio.settings.v1') === null) settings.view = 'flow';
  mobileQuery.addEventListener('change', () => {
    applyLayout();
    scheduleRender(30);
  });
  applyLayout();
  initPinchZoom();
}

async function initPageEditor(): Promise<void> {
  const ed = new PageEditor({
    host: stage,
    bar: $('edit-bar'),
    banner: $('edit-banner'),
    scroller,
    settings: () => settings,
    saveSettings: () => saveSettings(settings),
    pages: () => pagesEl,
    flowMd: () => flowMdEl,
    zoom: () => lastZoom,
    rerender: () => render(true),
    markdown: () => source.value,
    toast,
    status: (m) => { $('status-msg').textContent = m; },
    isMobile,
  });
  try {
    await ed.init();
  } catch (err) {
    console.error(err);
    toast('Page editing could not start in this browser', 'error', 5000);
    return;
  }
  editor = ed;
  // Phones/tablets: while typing on the page, hide the tab bar to make room for the keyboard.
  stage.addEventListener('focusin', () => app.classList.add('typing'));
  stage.addEventListener('focusout', () => setTimeout(() => {
    if (!stage.contains(document.activeElement)) app.classList.remove('typing');
  }, 0));
  if (isMobile() && ed.edited) setTab('preview');
}

async function boot(): Promise<void> {
  initSetup();
  initZoom();
  initEditor();
  initToolbar();
  initMobile();
  syncUi();
  const editorReady = initPageEditor();
  // KaTeX metrics depend on its web fonts: wait for them before the first measurement.
  try {
    await Promise.race([
      Promise.all(['KaTeX_Main', 'KaTeX_Math', 'KaTeX_Size1', 'KaTeX_Size2'].map((f) => document.fonts.load(`16px ${f}`))),
      new Promise((r) => setTimeout(r, 2500)),
    ]);
    await document.fonts.ready;
  } catch { /* render anyway */ }
  await editorReady;
  render();
  // Late-loading fonts (bold/italic variants) change metrics: re-render once more.
  document.fonts.addEventListener?.('loadingdone', () => scheduleRender(50));
}

void boot();
