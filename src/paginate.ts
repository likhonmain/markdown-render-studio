// Fragmenting paginator: flows a rendered `.md` block into fixed-size pages.
//
// Blocks are cloned into the current page one at a time and measured. Content
// that overflows is split at the deepest sensible point: containers (lists,
// list items, blockquotes, tables) split between children, the open ancestor
// chain is re-created on the next page, and inline content (paragraphs,
// list-item text) splits between lines. Atomic blocks (headings, display math,
// table rows, rules, pictures) move to the next page whole.
//
// Pages can contain "bands" (areas covered by pictures fixed to the page) that
// text must skip: the page is then cut into several vertical regions and
// content flows from one region into the next exactly as it flows between pages.
//
// Every element that gets split carries a `data-sid` shared by all of its
// fragments, so an editor can join the fragments back into one flow.

export interface PageSlot {
  page: HTMLElement;
  content: HTMLElement;
}

export interface Band {
  top: number; // px from the top of the content box
  bottom: number;
}

export interface PaginateOptions {
  /** Areas text has to avoid, per page index (content-box pixels). */
  bands?: (page: number) => Band[];
  /** Never produce fewer pages than this (pages holding only fixed pictures). */
  minPages?: number;
}

interface StackEntry {
  src: Element;
  clone: Element;
  cursor: Element | null;
}

interface Region {
  top: number;
  bottom: number;
}

const ATOMIC = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'TR', 'THEAD', 'IMG', 'svg', 'math']);
const INLINE_ATOM_SELECTOR = '.katex, img, br, input';
const MIN_REGION = 14; // px; a gap smaller than a text line is not worth filling

let sidCounter = 0;
const newSid = () => `f${(++sidCounter).toString(36)}`;

function isAtomic(el: Element): boolean {
  return ATOMIC.has(el.tagName) || el.classList.contains('math-display') || el.classList.contains('katex-display') || el.classList.contains('ed-fig');
}

function isBlock(el: Element): boolean {
  const d = getComputedStyle(el).display;
  return !(d === 'inline' || d === 'inline-block' || d === 'inline-flex' || d === 'contents' || d === 'none');
}

function hasBlockChildren(el: Element): boolean {
  for (const c of el.children) if (isBlock(c)) return true;
  return false;
}

export function hasContent(el: Element): boolean {
  if (el.classList.contains('ex-spacer')) return false;
  if (el.tagName === 'TABLE') return el.querySelector('tbody tr') !== null;
  if (el.tagName === 'TBODY') return el.querySelector('tr') !== null;
  if (el.classList.contains('table-wrap')) return el.querySelector('tbody tr') !== null;
  if (el.tagName === 'BR' || el.classList.contains('blank-lines') || el.classList.contains('ed-fig')) return true;
  for (const c of el.childNodes) {
    if (c.nodeType === Node.TEXT_NODE && (c.textContent ?? '').trim() !== '') return true;
    if (c.nodeType === Node.ELEMENT_NODE && hasContent(c as Element)) return true;
  }
  return ATOMIC.has(el.tagName) || el.classList.contains('katex') || el.tagName === 'IMG';
}

function keepsWithNext(el: Element): boolean {
  if (/^H[1-6]$/.test(el.tagName)) return true;
  if (el.hasAttribute('data-shell') || el.classList.contains('split-tail') || el.classList.contains('split-head')) return false;
  if (el.tagName !== 'P' && !el.classList.contains('li-run')) return false;
  const text = (el.textContent ?? '').trim();
  if (!text) return false;
  // A block made only of bold text works as a heading ("**Q1: …**", "**Applications:**").
  const bold = [...el.querySelectorAll('strong, b')].map((b) => b.textContent ?? '').join('').trim();
  if (bold && bold.replace(/\s+/g, '') === text.replace(/\s+/g, '')) return true;
  // Short lead-in lines that introduce what follows ("Thus:", "is:").
  return text.length <= 90 && /:\s*$/.test(text);
}

export function paginate(
  source: HTMLElement,
  contentHeight: number,
  newSlot: () => PageSlot,
  opts: PaginateOptions = {},
): PageSlot[] {
  const slots: PageSlot[] = [];
  let cur!: PageSlot;
  let placed = 0; // leaf nodes placed in the current region
  let regions: Region[] = [{ top: 0, bottom: contentHeight }];
  let ri = 0; // current region index
  const stack: StackEntry[] = [];
  const LIMIT_SLACK = 0.5;

  // Number ordered list items so continuations can restart at the right value.
  for (const ol of source.querySelectorAll('ol')) {
    let n = Number(ol.getAttribute('start') ?? '1') || 1;
    for (const li of ol.children) if (li.tagName === 'LI') li.setAttribute('value', String(n++));
  }

  const contentTop = () => cur.content.getBoundingClientRect().top;
  const limit = () => contentTop() + regions[ri].bottom + LIMIT_SLACK;
  const overflows = (el: Element) => el.getBoundingClientRect().bottom > limit();
  const top = () => stack[stack.length - 1];

  function computeRegions(pageIndex: number): Region[] {
    const bands = (opts.bands?.(pageIndex) ?? [])
      .map((b) => ({ top: Math.max(0, b.top), bottom: Math.min(contentHeight, b.bottom) }))
      .filter((b) => b.bottom > b.top)
      .sort((a, b) => a.top - b.top);
    const out: Region[] = [];
    let start = 0;
    for (const b of bands) {
      if (b.top - start >= MIN_REGION) out.push({ top: start, bottom: b.top });
      start = Math.max(start, b.bottom);
    }
    if (contentHeight - start >= MIN_REGION || out.length === 0) out.push({ top: Math.min(start, contentHeight), bottom: contentHeight });
    return out;
  }

  /** Starts filling region `i` of the current page (a spacer skips any band above it). */
  function enterRegion(i: number): void {
    ri = i;
    placed = 0;
    const target = regions[i].top;
    if (target <= 0.5) return;
    const sp = document.createElement('div');
    sp.className = 'ex-spacer';
    sp.setAttribute('contenteditable', 'false');
    sp.setAttribute('aria-hidden', 'true');
    cur.content.appendChild(sp);
    const y = sp.getBoundingClientRect().top - contentTop();
    sp.style.height = `${Math.max(0, target - y).toFixed(2)}px`;
  }

  const open = () => {
    cur = newSlot();
    slots.push(cur);
    regions = computeRegions(slots.length - 1);
    enterRegion(0);
  };
  open();
  stack.push({ src: source, clone: cur.content, cursor: null });

  function dropEmptyShells(): void {
    for (let i = stack.length - 1; i >= 1; i--) {
      const shell = stack[i].clone;
      if (shell.isConnected && !hasContent(shell)) shell.remove();
    }
  }

  /** Re-creates the chain of open containers at the current insertion point. */
  function reopenShells(): void {
    let parent: Element = cur.content;
    stack[0].clone = parent;
    for (let i = 1; i < stack.length; i++) {
      const entry = stack[i];
      const continued = entry.clone.isConnected;
      const shell = entry.src.cloneNode(false) as Element;
      shell.setAttribute('data-shell', '');
      if (continued) {
        shell.classList.add('split-tail');
        if (shell.tagName === 'LI') shell.classList.add('cont');
      }
      if (shell.tagName === 'TABLE') {
        // Repeat the header row on every page the table continues onto.
        const thead = entry.src.querySelector(':scope > thead');
        const colgroup = entry.src.querySelector(':scope > colgroup');
        if (colgroup) shell.appendChild(colgroup.cloneNode(true));
        if (thead) {
          const t = thead.cloneNode(true) as Element;
          t.setAttribute('data-repeat', '');
          shell.appendChild(t);
        }
      }
      parent.appendChild(shell);
      entry.clone = shell;
      parent = shell;
    }
  }

  /** Moves on to the next region of this page (around a fixed picture). */
  function softBreak(): void {
    dropEmptyShells();
    enterRegion(ri + 1);
    reopenShells();
  }

  function breakPage(): void {
    const old = cur;
    dropEmptyShells();
    // Keep a heading-like last block together with what follows it (at any depth).
    let carried: Element | null = null;
    let carriedDepth = -1;
    for (let i = stack.length - 1; i >= 0; i--) {
      const clone = stack[i].clone;
      if (!clone.isConnected) continue;
      const kids = [...clone.children].filter((c) => hasContent(c));
      if (kids.length === 0) continue;
      const last = kids[kids.length - 1];
      if (!last.hasAttribute('data-shell') && keepsWithNext(last)) {
        // Only if something else remains on the old page.
        last.remove();
        if (hasContent(old.content)) {
          carried = last;
          carriedDepth = i;
        } else clone.appendChild(last);
      }
      break;
    }
    if (carried) dropEmptyShells();
    open();
    reopenShells();
    if (carried && carriedDepth >= 0) {
      const host = stack[carriedDepth].clone;
      let ref = host.firstChild;
      while (ref && ref.nodeType === Node.ELEMENT_NODE && (ref as Element).classList.contains('ex-spacer')) ref = ref.nextSibling;
      host.insertBefore(carried, ref);
      placed = 1;
    }
  }

  /** Next region on this page, or a new page. */
  function advance(): void {
    if (ri < regions.length - 1) softBreak();
    else breakPage();
  }

  /** True on an untouched page whose region spans the whole page (nothing better to move to). */
  function freshFullPage(): boolean {
    const r = regions[ri];
    return r.top <= 0.5 && r.bottom >= contentHeight - 0.5 && !hasContent(cur.content);
  }

  /** Splits an inline container instance (already in the page) between lines. */
  function splitLines(el: Element): Element | null {
    const positions: Array<{ node: Node; offset: number } | { after: Node }> = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode(n) {
        if (n.nodeType === Node.ELEMENT_NODE) {
          return (n as Element).matches(INLINE_ATOM_SELECTOR) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        }
        return (n.parentElement?.closest('.katex') ?? null) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType === Node.ELEMENT_NODE) {
        positions.push({ after: n });
        continue;
      }
      const text = n.textContent ?? '';
      const re = /\s+/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) positions.push({ node: n, offset: m.index + m[0].length });
    }
    if (positions.length === 0) return null;
    const range = document.createRange();
    const lim = limit();
    const fits = (i: number) => {
      const p = positions[i];
      range.setStart(el, 0);
      if ('after' in p) range.setEndAfter(p.after);
      else range.setEnd(p.node, p.offset);
      const rects = range.getClientRects();
      let bottom = -Infinity;
      for (const r of rects) if (r.width > 0 || r.height > 0) bottom = Math.max(bottom, r.bottom);
      return bottom <= lim;
    };
    let lo = 0;
    let hi = positions.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (fits(mid)) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (best < 0) return null;
    const p = positions[best];
    if ('after' in p) range.setStartAfter(p.after);
    else range.setStart(p.node, p.offset);
    range.setEnd(el, el.childNodes.length);
    const frag = range.extractContents();
    // Nothing meaningful left behind or moved → not a real split.
    if (!(frag.textContent ?? '').trim() && !frag.querySelector?.(INLINE_ATOM_SELECTOR)) {
      el.appendChild(frag);
      return null;
    }
    if (!hasContent(el)) {
      el.appendChild(frag);
      return null;
    }
    if (!el.hasAttribute('data-sid')) el.setAttribute('data-sid', newSid());
    const rest = el.cloneNode(false) as Element;
    rest.appendChild(frag);
    el.classList.add('split-head');
    rest.classList.add('split-tail');
    rest.classList.remove('split-head');
    if (rest.tagName === 'LI') rest.classList.add('cont');
    rest.removeAttribute('data-shell');
    return rest;
  }

  /** Places an element instance (a detached clone) into the current page. */
  function placeInstance(inst: Element, src: Element | null): void {
    for (let guard = 0; guard < 500; guard++) {
      const parent = top().clone;
      parent.appendChild(inst);
      if (!overflows(inst)) {
        placed++;
        return;
      }
      if (!isAtomic(inst) && !hasBlockChildren(inst)) {
        const rest = splitLines(inst);
        if (rest) {
          placed++;
          advance();
          inst = rest;
          src = null;
          continue;
        }
      } else if (!isAtomic(inst) && src) {
        // Container: split between its children.
        inst.remove();
        placeContainer(src);
        return;
      } else if (!isAtomic(inst) && !src) {
        // A split-off container fragment (rare): place its children one by one.
        inst.remove();
        const shellSrc = inst.cloneNode(false) as Element;
        if (!shellSrc.hasAttribute('data-sid')) shellSrc.setAttribute('data-sid', newSid());
        const kids = [...inst.childNodes];
        const shell = shellSrc.cloneNode(false) as Element;
        shell.setAttribute('data-shell', '');
        top().clone.appendChild(shell);
        stack.push({ src: shellSrc, clone: shell, cursor: null });
        for (const k of kids) placeNode(k, null);
        stack.pop();
        return;
      }
      // Atomic or unsplittable: try the next region / page unless nothing better exists.
      if (placed > 0 || !freshFullPage()) {
        inst.remove();
        advance();
        continue;
      }
      placed++; // taller than a page: let it overflow rather than loop
      return;
    }
  }

  function placeContainer(src: Element): void {
    if (!src.hasAttribute('data-sid')) src.setAttribute('data-sid', newSid());
    const shell = src.cloneNode(false) as Element;
    shell.setAttribute('data-shell', '');
    top().clone.appendChild(shell);
    const entry: StackEntry = { src, clone: shell, cursor: null };
    stack.push(entry);
    for (const child of [...src.childNodes]) {
      if (child.nodeType === Node.ELEMENT_NODE) entry.cursor = child as Element;
      placeNode(child, child.nodeType === Node.ELEMENT_NODE ? (child as Element) : null);
    }
    stack.pop();
  }

  function placeNode(node: Node, src: Element | null): void {
    if (node.nodeType !== Node.ELEMENT_NODE) {
      if ((node.textContent ?? '').trim() === '') {
        top().clone.appendChild(node.cloneNode(true));
        return;
      }
      // Bare text inside a block container: wrap so it can be measured.
      const span = document.createElement('div');
      span.className = 'li-run';
      span.appendChild(node.cloneNode(true));
      placeInstance(span, null);
      return;
    }
    const el = node as Element;
    if (el.tagName === 'HR' && el.classList.contains('page-break')) {
      // Keep the marker (an editor needs it back) at the end of the page, then break.
      const had = hasContent(cur.content);
      top().clone.appendChild(el.cloneNode(true));
      if (had) breakPage();
      return;
    }
    if (el.tagName === 'COLGROUP') {
      top().clone.appendChild(el.cloneNode(true));
      return;
    }
    placeInstance(el.cloneNode(true) as Element, src ?? el);
  }

  for (const child of [...source.childNodes]) {
    if (child.nodeType === Node.ELEMENT_NODE) stack[0].cursor = child as Element;
    placeNode(child, child.nodeType === Node.ELEMENT_NODE ? (child as Element) : null);
  }

  const minPages = Math.max(1, opts.minPages ?? 1);
  while (slots.length < minPages) open();

  // Remove trailing empty shells and blank final page.
  for (const s of slots) {
    for (const shell of [...s.content.querySelectorAll('[data-shell]')].reverse()) {
      if (!hasContent(shell)) shell.remove();
    }
  }
  while (slots.length > minPages && !hasContent(slots[slots.length - 1].content)) {
    slots.pop()!.page.remove();
  }
  return slots;
}
