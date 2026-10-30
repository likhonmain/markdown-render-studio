// Edited page HTML → Markdown, so the Markdown editor always mirrors the page.
// Standard Markdown covers most of it. Formatting Markdown cannot express is
// written as a small set of inline HTML tags that the renderer understands
// (<span style>, <u>, <mark>, <sub>, <sup>), plus comment markers for pictures
// and extra blank lines. What still cannot be stored (text alignment, blocks
// inside table cells…) is reported in `lossy`.

export interface MdResult {
  md: string;
  lossy: string[];
}

type Item = { text: string } | { blank: number };

interface Ctx {
  lossy: Set<string>;
}

const SKIP = '.ex-spacer, .page-num, .page-label, .fimg, .ed-ui, .ink-layer, [data-repeat], [data-caret]';
const BLOCK_TAGS = /^(P|DIV|H[1-6]|UL|OL|TABLE|BLOCKQUOTE|PRE|HR|FIGURE|SECTION|DL|ARTICLE|HEADER|FOOTER|MAIN|ASIDE|NAV)$/;
const STYLE_PROPS = ['color', 'background-color', 'font-size'] as const;

function isBlockEl(n: Node): boolean {
  return n.nodeType === Node.ELEMENT_NODE && (BLOCK_TAGS.test((n as Element).tagName) || (n as Element).classList.contains('math-display') || (n as Element).classList.contains('table-wrap'));
}

function escText(t: string): string {
  return t.replace(/[\\`*_[\]<>$~|]/g, '\\$&');
}

/** Escapes characters that would start a block construct at the beginning of a line. */
function escLineStart(line: string): string {
  if (/^(#{1,6}(\s|$)|[>+=-](\s|$)|-{3,}\s*$|={3,}\s*$)/.test(line)) return '\\' + line;
  const m = /^(\d{1,9})([.)])(\s|$)/.exec(line);
  if (m) return `${m[1]}\\${line.slice(m[1].length)}`;
  return line;
}

function texOf(el: Element): string {
  return (el.querySelector('annotation[encoding="application/x-tex"]')?.textContent ?? el.textContent ?? '').trim();
}

function alignOf(el: Element): string {
  const a = ((el as HTMLElement).style?.textAlign || el.getAttribute('align') || '').toLowerCase();
  return a === 'start' || a === 'left' ? '' : a;
}

function cleanStyle(el: HTMLElement): string {
  const parts: string[] = [];
  for (const p of STYLE_PROPS) {
    const v = el.style.getPropertyValue(p).trim();
    if (v && /^[#\w(),.%\s-]+$/.test(v) && !/^(inherit|initial|unset|transparent|rgba\(0, 0, 0, 0\))$/.test(v)) parts.push(`${p}:${v}`);
  }
  if (el.tagName === 'FONT' && el.getAttribute('color')) {
    const c = el.getAttribute('color')!;
    if (/^[#\w]+$/.test(c)) parts.push(`color:${c}`);
  }
  return parts.join(';');
}

/** Moves leading/trailing spaces outside a delimiter pair (`** a **` is not bold in Markdown). */
function wrap(inner: string, open: string, close = open): string {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner)!;
  if (!m[2]) return inner;
  return `${m[1]}${open}${m[2]}${close}${m[3]}`;
}

function codeSpan(t: string): string {
  const runs = t.match(/`+/g) ?? [];
  const n = runs.reduce((a, r) => Math.max(a, r.length), 0) + 1;
  const tick = '`'.repeat(n);
  const pad = t.startsWith('`') || t.endsWith('`') ? ' ' : '';
  return `${tick}${pad}${t}${pad}${tick}`;
}

function inline(node: Node, ctx: Ctx): string {
  if (node.nodeType === Node.TEXT_NODE) return escText((node.textContent ?? '').replace(/\u00a0/g, ' ').replace(/[\r\n\t]+/g, ' '));
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const el = node as HTMLElement;
  if (el.matches(SKIP)) return '';
  if (el.classList.contains('katex')) {
    const tex = texOf(el);
    return tex ? `$${tex}$` : '';
  }
  if (el.classList.contains('katex-error')) return `$${el.textContent ?? ''}$`;
  const kids = () => [...el.childNodes].map((c) => inline(c, ctx)).join('');
  switch (el.tagName) {
    case 'BR': return '<br>';
    case 'STRONG': case 'B': return styled(el, wrap(kids(), '**'));
    case 'EM': case 'I': return styled(el, wrap(kids(), '*'));
    case 'S': case 'DEL': case 'STRIKE': return styled(el, wrap(kids(), '~~'));
    case 'U': case 'INS': return styled(el, wrap(kids(), '<u>', '</u>'));
    case 'MARK': return wrap(kids(), '<mark>', '</mark>');
    case 'SUB': return wrap(kids(), '<sub>', '</sub>');
    case 'SUP': {
      const a = el.querySelector('a[data-footnote-ref]');
      if (a) return `[^${footLabel(a.getAttribute('href') ?? '')}]`;
      return wrap(kids(), '<sup>', '</sup>');
    }
    case 'CODE': return codeSpan((el.textContent ?? '').replace(/\u00a0/g, ' '));
    case 'A': {
      if (el.hasAttribute('data-footnote-backref')) return '';
      const href = el.getAttribute('href') ?? '';
      const text = kids();
      if (!href || href.startsWith('#')) return text;
      return `[${text}](${href.replace(/[()\s]/g, (c) => encodeURIComponent(c))})`;
    }
    case 'IMG': {
      const src = el.getAttribute('src') ?? '';
      if (/^https?:/i.test(src)) return `![${escText(el.getAttribute('alt') ?? '')}](${src.replace(/[()\s]/g, (c) => encodeURIComponent(c))})`;
      if (src) ctx.lossy.add('pasted pictures');
      return '';
    }
    case 'INPUT': return '';
    case 'SPAN': case 'FONT': return styled(el, kids());
    default: return styled(el, kids());
  }
}

function styled(el: HTMLElement, inner: string): string {
  if (el.tagName === 'SPAN' && el.parentElement?.closest('.katex')) return inner;
  const st = cleanStyle(el);
  if (!st || !inner.trim()) return inner;
  return wrap(inner, `<span style="${st}">`, '</span>');
}

function footLabel(href: string): string {
  const m = /fn-?(.+)$/.exec(href);
  return m ? decodeURIComponent(m[1]) : '1';
}

/** Inline content of an element as one paragraph; trailing <br>s dropped. */
function para(el: Element, ctx: Ctx): string {
  let s = [...el.childNodes].map((c) => inline(c, ctx)).join('');
  s = s.replace(/(<br>\s*)+$/, '').replace(/^\s+|\s+$/g, '');
  return s.split('<br>').map((l, i) => (i === 0 ? escLineStart(l.replace(/^\s+/, '')) : l)).join('<br>');
}

function emptyBlock(el: Element): boolean {
  return !(el.textContent ?? '').replace(/[\u00a0\s\u200b]/g, '') && !el.querySelector('img, .katex, figure, input, table');
}

function indent(text: string, pad: string): string {
  return text.split('\n').map((l, i) => (i === 0 || !l ? l : pad + l)).join('\n');
}

function listBlock(el: Element, ctx: Ctx): string {
  const ordered = el.tagName === 'OL';
  let n = Number(el.getAttribute('start') ?? '') || 0;
  const items = [...el.children].filter((c) => c.tagName === 'LI');
  if (!n) n = Number(items[0]?.getAttribute('value') ?? '') || 1;
  const loose = items.some((li) => [...li.children].some((c) => c.tagName === 'P') && li.children.length > 1);
  const out: string[] = [];
  for (const li of items) {
    const marker = ordered ? `${n++}. ` : '- ';
    const pad = ' '.repeat(marker.length);
    let box = '';
    const cb = li.querySelector(':scope > input[type="checkbox"], :scope > p > input[type="checkbox"], :scope > .li-run > input[type="checkbox"]');
    if (cb) box = (cb as HTMLInputElement).checked || cb.hasAttribute('checked') ? '[x] ' : '[ ] ';
    const parts = blocks(li, ctx).filter((it): it is { text: string } => 'text' in it).map((it) => it.text);
    const body = parts.join(loose ? '\n\n' : '\n') || '';
    out.push(marker + box + indent(body, pad));
  }
  return out.join(loose ? '\n\n' : '\n');
}

function tableBlock(t: HTMLTableElement, ctx: Ctx): string {
  const rows = [...t.querySelectorAll('tr')].filter((r) => r.closest('table') === t);
  if (!rows.length) return '';
  const cols = Math.max(...rows.map((r) => r.cells.length), 1);
  const cell = (c: HTMLTableCellElement | undefined) => {
    if (!c) return '';
    if ([...c.children].some((k) => isBlockEl(k) && k.tagName !== 'P')) ctx.lossy.add('lists or blocks inside table cells');
    const parts = [...c.childNodes].map((k) => (k.nodeType === Node.ELEMENT_NODE && (k as Element).tagName === 'P' ? para(k as Element, ctx) : inline(k, ctx)));
    return parts.join('<br>').replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();
  };
  const head = rows[0];
  const aligns = Array.from({ length: cols }, (_, i) => {
    const c = head.cells[i];
    const a = c ? (c.getAttribute('align') || c.style.textAlign || '').toLowerCase() : '';
    return a === 'center' ? ':---:' : a === 'right' ? '---:' : a === 'left' ? ':---' : '---';
  });
  const line = (r: HTMLTableRowElement) => `| ${Array.from({ length: cols }, (_, i) => cell(r.cells[i])).join(' | ')} |`;
  return [line(head), `| ${aligns.join(' | ')} |`, ...rows.slice(1).map(line)].join('\n');
}

function figureMarker(el: HTMLElement): string {
  const d = el.dataset;
  const data = { id: d.id ?? '', img: d.img ?? '', nw: Number(d.nw) || 1, nh: Number(d.nh) || 1, crop: d.crop ?? '0,0,1,1', w: Number(d.w) || 60, align: d.align ?? 'center' };
  return `<!-- picture ${JSON.stringify(data)} -->`;
}

function footnotes(sec: Element, ctx: Ctx): string {
  const out: string[] = [];
  for (const li of sec.querySelectorAll('li[id]')) {
    const label = footLabel(li.id);
    const parts = blocks(li, ctx).filter((it): it is { text: string } => 'text' in it).map((it) => it.text);
    out.push(`[^${label}]: ${indent(parts.join('\n\n'), '    ')}`);
  }
  return out.join('\n');
}

function blockOf(el: HTMLElement, ctx: Ctx): Item[] {
  if (el.matches(SKIP)) return [];
  if (alignOf(el) && !el.closest('td, th')) ctx.lossy.add('text alignment');
  if (el.classList.contains('blank-lines')) return [{ blank: Math.max(1, Number(el.dataset.lines) || 1) }];
  if (el.classList.contains('math-display') || el.classList.contains('katex-display')) {
    const tex = texOf(el);
    return tex ? [{ text: `$$\n${tex}\n$$` }] : [];
  }
  if (el.classList.contains('table-wrap')) {
    const t = el.querySelector('table');
    return t ? [{ text: tableBlock(t, ctx) }] : [];
  }
  if (el.tagName === 'FIGURE' && el.classList.contains('ed-fig')) return [{ text: figureMarker(el) }];
  if (el.tagName === 'SECTION' && el.hasAttribute('data-footnotes')) return [{ text: footnotes(el, ctx) }];
  if (el.matches('h2.sr-only, #footnote-label')) return [];
  switch (el.tagName) {
    case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': {
      const t = para(el, ctx).replace(/<br>/g, ' ');
      return [{ text: `${'#'.repeat(Number(el.tagName[1]))} ${t}` }];
    }
    case 'UL': case 'OL': return [{ text: listBlock(el, ctx) }];
    case 'BLOCKQUOTE': {
      const inner = joinItems(blocks(el, ctx));
      return [{ text: inner.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n') }];
    }
    case 'PRE': {
      const code = el.querySelector('code');
      const lang = /language-(\S+)/.exec(code?.className ?? '')?.[1] ?? '';
      const body = (el.textContent ?? '').replace(/\u00a0/g, ' ').replace(/\n$/, '');
      const runs = body.match(/^`{3,}/gm) ?? [];
      const fence = '`'.repeat(Math.max(3, ...runs.map((r) => r.length + 1)));
      return [{ text: `${fence}${lang}\n${body}\n${fence}` }];
    }
    case 'TABLE': return [{ text: tableBlock(el as HTMLTableElement, ctx) }];
    case 'HR': return [{ text: el.classList.contains('page-break') ? '\\newpage' : '---' }];
    case 'P':
    default: {
      if ([...el.childNodes].some(isBlockEl)) return blocks(el, ctx);
      if (emptyBlock(el)) return [{ blank: 0 }];
      return [{ text: para(el, ctx) }];
    }
  }
}

function blocks(parent: Element, ctx: Ctx): Item[] {
  const out: Item[] = [];
  let run: Node[] = [];
  const flush = () => {
    const box = document.createElement('div');
    box.append(...run.map((n) => n.cloneNode(true)));
    run = [];
    if (emptyBlock(box)) return;
    out.push({ text: para(box, ctx) });
  };
  for (const n of [...parent.childNodes]) {
    if (n.nodeType === Node.ELEMENT_NODE && (n as Element).matches(SKIP)) continue;
    if (n.nodeType === Node.ELEMENT_NODE && (n as Element).tagName === 'INPUT') continue;
    if (isBlockEl(n)) {
      flush();
      out.push(...blockOf(n as HTMLElement, ctx));
    } else run.push(n);
  }
  flush();
  return out;
}

/** Joins block items: one blank line between blocks, extra blank lines for spacing. */
function joinItems(items: Item[]): string {
  // Runs of empty paragraphs (Enter pressed on an empty line) become extra blank lines.
  const merged: Item[] = [];
  let empties = 0;
  const flushEmpties = () => {
    if (empties) merged.push({ blank: Math.max(1, Math.round(empties * 1.6)) });
    empties = 0;
  };
  for (const it of items) {
    if ('blank' in it && it.blank === 0) {
      empties++;
      continue;
    }
    flushEmpties();
    merged.push(it);
  }
  flushEmpties();
  let s = '';
  let extra = 0;
  let prevList = '';
  for (const it of merged) {
    if ('blank' in it) {
      extra += it.blank;
      continue;
    }
    if (s) {
      // Two lists of the same kind next to each other would merge into one.
      const kind = /^(- |\d+\. )/.test(it.text) ? (it.text.startsWith('- ') ? 'ul' : 'ol') : '';
      if (kind && kind === prevList && !extra) s += '\n\n<!-- -->';
      s += '\n\n' + '\n'.repeat(extra);
    }
    extra = 0;
    s += it.text;
    prevList = /^(- |\d+\. )/.test(it.text) ? (it.text.startsWith('- ') ? 'ul' : 'ol') : '';
  }
  return s;
}

export function htmlToMarkdown(html: string): MdResult {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const root = document.createElement('div');
  root.append(tpl.content);
  const ctx: Ctx = { lossy: new Set() };
  const md = joinItems(blocks(root, ctx)).replace(/[ \t]+$/gm, '');
  return { md: md ? md + '\n' : '', lossy: [...ctx.lossy] };
}
