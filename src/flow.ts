// DOM helpers shared by the page editor: joining paginated fragments back into
// one document flow, picture markup, caret markers and paste sanitising.
import { imageUrl, type Crop } from './store';

const CARET = 'data-caret';

/* ------------------------------------------------------------------ */
/* Paginated pages → document flow                                     */
/* ------------------------------------------------------------------ */

const CHROME = '.page-num, .page-label, .fimg, .ed-ui, .ex-spacer, .ink-layer';

function lastNode(target: Node): Node | null {
  for (let n = target.lastChild; n; n = n.previousSibling) {
    if (n.nodeType === Node.TEXT_NODE && !(n.textContent ?? '').trim()) continue;
    return n;
  }
  return null;
}

/** Appends a run of nodes, joining the first one with a fragment of the same split element. */
function appendSegment(target: Element, nodes: Node[]): void {
  let first = true;
  for (const n of nodes) {
    if (n.nodeType === Node.TEXT_NODE && !(n.textContent ?? '').trim()) {
      target.appendChild(n);
      continue;
    }
    if (first && n.nodeType === Node.ELEMENT_NODE) {
      const el = n as Element;
      const sid = el.getAttribute('data-sid');
      const last = lastNode(target);
      if (sid && last && last.nodeType === Node.ELEMENT_NODE && (last as Element).getAttribute('data-sid') === sid && (last as Element).tagName === el.tagName) {
        const host = last as Element;
        const kids = [...el.childNodes].filter((k) => {
          if (k.nodeType !== Node.ELEMENT_NODE) return true;
          const ke = k as Element;
          if (ke.hasAttribute('data-repeat')) return false;
          if (ke.tagName === 'COLGROUP' && host.querySelector(':scope > colgroup')) return false;
          return true;
        });
        appendSegment(host, kids);
        first = false;
        continue;
      }
    }
    first = false;
    target.appendChild(n);
  }
}

function segmentsOf(container: Element, out: Node[][]): void {
  let seg: Node[] = [];
  for (const n of [...container.childNodes]) {
    if (n.nodeType === Node.ELEMENT_NODE && (n as Element).classList.contains('ex-spacer')) {
      out.push(seg);
      seg = [];
      continue;
    }
    if (n.nodeType === Node.ELEMENT_NODE && (n as Element).matches(CHROME)) continue;
    seg.push(n);
  }
  out.push(seg);
}

/** Rebuilds the unpaginated document from a `.pages` element (works on a clone). */
export function extractFlow(pages: HTMLElement): HTMLElement {
  const clone = pages.cloneNode(true) as HTMLElement;
  normalizeEdits(clone);
  const segs: Node[][] = [];
  for (const child of [...clone.childNodes]) {
    if (child.nodeType !== Node.ELEMENT_NODE) {
      if ((child.textContent ?? '').trim()) segs.push([child]);
      continue;
    }
    const el = child as Element;
    if (!el.classList.contains('page')) {
      if (!el.matches(CHROME)) segs.push([el]);
      continue;
    }
    for (const part of [...el.childNodes]) {
      if (part.nodeType === Node.ELEMENT_NODE && (part as Element).classList.contains('page-content')) segmentsOf(part as Element, segs);
      else if (part.nodeType === Node.ELEMENT_NODE && (part as Element).matches(CHROME)) continue;
      else if ((part.textContent ?? '').trim() || (part.nodeType === Node.ELEMENT_NODE && (part as Element).querySelector('img, [data-caret]'))) segs.push([part]);
    }
  }
  const out = document.createElement('div');
  for (const s of segs) appendSegment(out, s);
  cleanFlow(out);
  return out;
}

/** Flow of a single editable element (Flow view). */
export function extractSimple(md: HTMLElement): HTMLElement {
  const out = md.cloneNode(true) as HTMLElement;
  cleanFlow(out);
  return out;
}

export function cleanFlow(root: HTMLElement): void {
  for (const el of root.querySelectorAll(CHROME + ', [data-repeat]')) el.remove();
  for (const el of root.querySelectorAll<HTMLElement>('*')) {
    el.removeAttribute('data-sid');
    el.removeAttribute('data-shell');
    el.removeAttribute('contenteditable');
    el.removeAttribute('spellcheck');
    if (el.classList.length) {
      el.classList.remove('split-head', 'split-tail', 'cont', 'sel', 'dragging');
      if (!el.classList.length) el.removeAttribute('class');
    }
    if (el.tagName === 'LI') el.removeAttribute('value');
    if (el.tagName === 'IMG' && el.hasAttribute('data-img')) el.removeAttribute('src');
    // Chrome sometimes wraps edits in spans that only restate the defaults.
    if (el.tagName === 'SPAN' && el.getAttribute('style') !== null) {
      el.style.removeProperty('font-family');
      el.style.removeProperty('line-height');
      el.style.removeProperty('letter-spacing');
      el.style.removeProperty('word-spacing');
      if (!el.getAttribute('style')) el.removeAttribute('style');
    }
  }
  // Unwrap spans left with no attributes at all.
  for (const sp of [...root.querySelectorAll('span')]) {
    if (sp.attributes.length === 0 && !sp.closest('.katex')) sp.replaceWith(...sp.childNodes);
  }
  // Empty formatting wrappers (left behind when Enter splits bold text) eat a keypress.
  for (const el of [...root.querySelectorAll('strong, b, em, i, u, s, del, span, font, a, code')].reverse()) {
    if (el.closest('.katex') || el.childNodes.length || el.hasAttribute(CARET)) continue;
    el.remove();
  }
  root.normalize();
}

/* ------------------------------------------------------------------ */
/* Keeping split markers honest while editing                          */
/* ------------------------------------------------------------------ */

function meaningfulSibling(el: Element, dir: 'prev' | 'next'): Element | null | 'boundary' {
  let n = dir === 'prev' ? el.previousSibling : el.nextSibling;
  while (n) {
    if (n.nodeType === Node.ELEMENT_NODE) {
      const e = n as Element;
      if (e.classList.contains('ex-spacer')) return 'boundary';
      if (!e.matches(CHROME) && !e.hasAttribute(CARET)) return e;
    } else if (n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim()) return null;
    n = dir === 'prev' ? n.previousSibling : n.nextSibling;
  }
  return 'boundary';
}

/** True when `el` touches the start (or end) edge of its page region at every level. */
function atEdge(el: Element, stop: Element, dir: 'prev' | 'next'): boolean {
  for (let cur: Element | null = el; cur && cur !== stop; cur = cur.parentElement) {
    if (meaningfulSibling(cur, dir) !== 'boundary') return false;
  }
  return true;
}

/**
 * Pressing Enter copies the attributes of the paragraph being split, so markers
 * that tie page fragments together (and list continuation styles) end up on new
 * blocks. Keep them only where a fragment really meets a page boundary.
 */
export function normalizeEdits(root: HTMLElement): void {
  for (const pc of root.querySelectorAll<HTMLElement>('.page-content')) {
    for (const el of pc.querySelectorAll<HTMLElement>('[data-sid], .split-head, .split-tail, li.cont')) {
      const start = atEdge(el, pc, 'prev');
      const end = atEdge(el, pc, 'next');
      if (!start && !end) el.removeAttribute('data-sid');
      if (!end) el.classList.remove('split-head');
      if (!start) el.classList.remove('split-tail', 'cont');
    }
  }
}

/* ------------------------------------------------------------------ */
/* Caret markers                                                       */
/* ------------------------------------------------------------------ */

/** Marks the current selection with two empty spans (they survive re-pagination). */
export function insertCaretMarkers(host: HTMLElement): boolean {
  const sel = getSelection();
  if (!sel || sel.rangeCount === 0) return false;
  const r = sel.getRangeAt(0);
  if (!host.contains(r.startContainer) || !host.contains(r.endContainer)) return false;
  // Never inside non-editable islands (math, pictures).
  const island = (n: Node) => (n.nodeType === Node.ELEMENT_NODE ? (n as Element) : n.parentElement)?.closest('[contenteditable="false"]');
  if (island(r.startContainer) || island(r.endContainer)) return false;
  const mk = (k: string) => {
    const s = document.createElement('span');
    s.setAttribute(CARET, k);
    return s;
  };
  const end = r.cloneRange();
  end.collapse(false);
  if (!r.collapsed) end.insertNode(mk('e'));
  const start = r.cloneRange();
  start.collapse(true);
  start.insertNode(mk('s'));
  return true;
}

export function removeCaretMarkers(root: ParentNode): void {
  for (const m of root.querySelectorAll(`[${CARET}]`)) {
    const p = m.parentNode;
    m.remove();
    p?.normalize();
  }
}

export function stripCaretMarkers(html: string): string {
  return html.replace(/<span data-caret="[se]"><\/span>/g, '');
}

function pointAt(marker: Element): [Node, number] {
  const prev = marker.previousSibling;
  if (prev && prev.nodeType === Node.TEXT_NODE) return [prev, (prev.textContent ?? '').length];
  const next = marker.nextSibling;
  if (next && next.nodeType === Node.TEXT_NODE) return [next, 0];
  const parent = marker.parentNode!;
  return [parent, [...parent.childNodes].indexOf(marker as ChildNode)];
}

/** Restores the selection from markers (if any) and removes them. */
export function restoreCaret(host: HTMLElement, apply: boolean): boolean {
  const s = host.querySelector(`[${CARET}="s"]`);
  const e = host.querySelector(`[${CARET}="e"]`);
  if (!s) {
    e?.remove();
    return false;
  }
  let ok = false;
  if (apply) {
    const range = document.createRange();
    const [sn, so] = pointAt(s);
    range.setStart(sn, so);
    if (e) {
      const [en, eo] = pointAt(e);
      range.setEnd(en, eo);
    } else range.collapse(true);
    s.remove();
    e?.remove();
    const sel = getSelection();
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(range);
      ok = true;
    }
  } else {
    s.remove();
    e?.remove();
  }
  return ok;
}

/* ------------------------------------------------------------------ */
/* Pictures                                                            */
/* ------------------------------------------------------------------ */

export interface PicData {
  img: string;
  nw: number;
  nh: number;
  crop: Crop;
  w: number; // mm
}

/** Height in mm of a picture of width `w` mm with this crop. */
export function picHeight(p: { nw: number; nh: number; crop: Crop; w: number }): number {
  return (p.w * (p.crop[3] * p.nh)) / Math.max(1e-6, p.crop[2] * p.nw);
}

/** Fills a crop box (aspect-ratio box with the picture positioned inside). */
export function fillCropBox(box: HTMLElement, p: PicData): void {
  box.classList.add('ed-crop');
  const [cx, cy, cw, ch] = p.crop;
  box.style.aspectRatio = `${(cw * p.nw).toFixed(3)} / ${(ch * p.nh).toFixed(3)}`;
  let img = box.querySelector<HTMLImageElement>('img');
  if (!img) {
    img = document.createElement('img');
    img.alt = '';
    img.draggable = false;
    box.appendChild(img);
  }
  img.setAttribute('data-img', p.img);
  const url = imageUrl(p.img);
  if (url) img.src = url;
  else img.removeAttribute('src');
  img.style.width = `${(100 / cw).toFixed(4)}%`;
  img.style.height = `${(100 / ch).toFixed(4)}%`;
  img.style.left = `${(-(cx / cw) * 100).toFixed(4)}%`;
  img.style.top = `${(-(cy / ch) * 100).toFixed(4)}%`;
}

export function parseCrop(s: string | null | undefined): Crop {
  const v = (s ?? '').split(',').map(Number);
  if (v.length === 4 && v.every((n) => Number.isFinite(n)) && v[2] > 0 && v[3] > 0) return v as Crop;
  return [0, 0, 1, 1];
}

export function figData(fig: HTMLElement): PicData {
  return {
    img: fig.dataset.img ?? '',
    nw: Number(fig.dataset.nw) || 1,
    nh: Number(fig.dataset.nh) || 1,
    crop: parseCrop(fig.dataset.crop),
    w: Number(fig.dataset.w) || 60,
  };
}

/** Creates an in-line picture block (moves with the text). */
export function makeFigure(p: PicData, align: 'left' | 'center' | 'right', id: string): HTMLElement {
  const fig = document.createElement('figure');
  fig.className = 'ed-fig';
  fig.dataset.id = id;
  fig.dataset.img = p.img;
  fig.dataset.nw = String(p.nw);
  fig.dataset.nh = String(p.nh);
  fig.dataset.crop = p.crop.map((n) => +n.toFixed(5)).join(',');
  fig.dataset.w = String(+p.w.toFixed(2));
  fig.dataset.align = align;
  hydrateFigure(fig);
  return fig;
}

export function hydrateFigure(fig: HTMLElement): void {
  const p = figData(fig);
  fig.style.width = `${p.w}mm`;
  let box = fig.querySelector<HTMLElement>(':scope > .ed-crop');
  if (!box) {
    fig.replaceChildren();
    box = document.createElement('span');
    fig.appendChild(box);
  }
  fillCropBox(box, p);
}

export function hydrateFigures(root: ParentNode): void {
  for (const fig of root.querySelectorAll<HTMLElement>('figure.ed-fig')) hydrateFigure(fig);
}

export function figureImageIds(html: string): string[] {
  return [...html.matchAll(/data-img="([^"]+)"/g)].map((m) => m[1]);
}

/* ------------------------------------------------------------------ */
/* Paste                                                               */
/* ------------------------------------------------------------------ */

const KEEP = new Set(['P', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'DEL', 'STRIKE', 'SUB', 'SUP', 'A', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'BLOCKQUOTE', 'CODE', 'PRE', 'SPAN', 'HR', 'IMG', 'MARK']);
const BLOCKISH = new Set(['DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'MAIN', 'ASIDE', 'NAV', 'FIGURE', 'DL', 'DT', 'DD']);
const DROP = new Set(['SCRIPT', 'STYLE', 'META', 'LINK', 'TITLE', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'SVG', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'TEMPLATE']);
const STYLE_KEEP = ['color', 'background-color', 'font-weight', 'font-style', 'text-decoration-line', 'text-align'];

/** Keeps only simple formatting from pasted rich text. */
export function sanitizeHtml(html: string): DocumentFragment {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out = document.createDocumentFragment();
  const walk = (src: Node, dst: Node) => {
    for (const n of [...src.childNodes]) {
      if (n.nodeType === Node.TEXT_NODE) {
        dst.appendChild(document.createTextNode(n.textContent ?? ''));
        continue;
      }
      if (n.nodeType !== Node.ELEMENT_NODE) continue;
      const el = n as HTMLElement;
      if (DROP.has(el.tagName)) continue;
      if (KEEP.has(el.tagName)) {
        const c = document.createElement(el.tagName === 'MARK' ? 'span' : el.tagName.toLowerCase());
        if (el.tagName === 'MARK') c.style.backgroundColor = '#fff59d';
        if (el.tagName === 'A') {
          const href = el.getAttribute('href') ?? '';
          if (/^(https?:|mailto:)/i.test(href)) c.setAttribute('href', href);
        }
        if (el.tagName === 'IMG') {
          const src = el.getAttribute('src') ?? '';
          if (!/^(https?:|data:image\/)/i.test(src)) continue;
          c.setAttribute('src', src);
        }
        if (el.tagName === 'TD' || el.tagName === 'TH') {
          for (const a of ['colspan', 'rowspan', 'align']) if (el.hasAttribute(a)) c.setAttribute(a, el.getAttribute(a)!);
        }
        for (const p of STYLE_KEEP) {
          const v = el.style.getPropertyValue(p);
          if (v && !/inherit|initial|unset|normal|none|transparent|rgba\(0, 0, 0, 0\)/.test(v)) (c as HTMLElement).style.setProperty(p, v);
        }
        if (c.tagName === 'SPAN' && !c.getAttribute('style')) {
          walk(el, dst);
          continue;
        }
        if (c.tagName === 'TABLE') {
          const wrap = document.createElement('div');
          wrap.className = 'table-wrap';
          wrap.appendChild(c);
          dst.appendChild(wrap);
        } else dst.appendChild(c);
        walk(el, c);
      } else if (BLOCKISH.has(el.tagName)) {
        const hasBlocks = [...el.children].some((k) => KEEP.has(k.tagName) && /^(P|UL|OL|TABLE|H[1-6]|BLOCKQUOTE|PRE)$/.test(k.tagName) || BLOCKISH.has(k.tagName));
        if (hasBlocks) walk(el, dst);
        else {
          const p = document.createElement('p');
          dst.appendChild(p);
          walk(el, p);
        }
      } else walk(el, dst);
    }
  };
  walk(doc.body, out);
  return out;
}

/** Plain text that is most likely Markdown (an AI answer). */
export function looksLikeMarkdown(text: string): boolean {
  if (!text || text.length < 3) return false;
  const lines = text.split(/\r?\n/);
  let score = 0;
  for (const l of lines) {
    if (/^\s{0,3}#{1,6}\s+\S/.test(l)) score += 2;
    else if (/^\s*([-*+]|\d{1,3}[.)])\s+\S/.test(l)) score += 1;
    else if (/^\s*\|.*\|\s*$/.test(l)) score += 1;
    else if (/^\s*(```|~~~|\$\$|\\\[)/.test(l)) score += 2;
    if (/\*\*[^*\n]+\*\*/.test(l)) score += 1;
    if (/(^|[^$])\$[^$\n]+\$([^$]|$)|\\\(.+?\\\)/.test(l)) score += 1;
  }
  return score >= 2;
}
