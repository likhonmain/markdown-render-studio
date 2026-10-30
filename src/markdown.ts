// Markdown → HTML pipeline modelled on DeepSeek Harness's renderer:
// micromark/mdast + GFM + math, KaTeX 0.16 (htmlAndMathml output) with the
// same "throw, then retry leniently" error policy. DSH also accepts
// same-line `$$…$$` display blocks and `\(…\)` / `\[…\]` delimiters, which
// stock remark-math does not, so those are normalised in `preprocess`.
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';
import { visit, SKIP } from 'unist-util-visit';
import katex from 'katex';
import type { Root as MdRoot, Parent as MdParent } from 'mdast';
import type { Root as HRoot, Element, ElementContent, Text as HText } from 'hast';

/* ------------------------------------------------------------------ */
/* KaTeX                                                               */
/* ------------------------------------------------------------------ */

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function renderTex(tex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(tex, { displayMode, throwOnError: true });
  } catch (err) {
    try {
      return katex.renderToString(tex, { displayMode, strict: 'ignore', throwOnError: false });
    } catch {
      return `<span class="katex-error" title="${escapeHtml(String(err))}">${escapeHtml(tex)}</span>`;
    }
  }
}

/** Presentation MathML only (no annotation) — used for DOCX/OMML conversion. */
export function texToMathML(tex: string, displayMode: boolean): string {
  let html: string;
  try {
    html = katex.renderToString(tex, { displayMode, output: 'mathml', throwOnError: false, strict: 'ignore' });
  } catch {
    return '';
  }
  const m = /<math[\s\S]*<\/math>/.exec(html);
  if (!m) return '';
  return m[0]
    .replace(/<annotation[\s\S]*?<\/annotation>/g, '')
    .replace(/<semantics>/g, '')
    .replace(/<\/semantics>/g, '');
}

/* ------------------------------------------------------------------ */
/* Source normalisation                                                */
/* ------------------------------------------------------------------ */

function inlineDelimiters(line: string): string {
  // Leave inline code spans untouched.
  const parts = line.split(/(`+[^`]*?`+)/);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part;
      return part
        .replace(/(^|[^\\])\\\((.+?)\\\)/g, (_m, lead: string, tex: string) => `${lead}$${tex.trim()}$`)
        .replace(/(^|[^\\])\\\[(.+?)\\\]/g, (_m, lead: string, tex: string) => `${lead}$$${tex.trim()}$$`);
    })
    .join('');
}

/**
 * Rewrites the math forms DSH understands but remark-math does not into the
 * canonical fenced/`$` forms, keeping list/blockquote indentation intact.
 */
export function preprocess(src: string): string {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let fence: { ch: string; len: number } | null = null;
  let mode: 'none' | 'dollar' | 'bracket' = 'none';
  let mathPrefix = '';

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    // Several blank lines in a row: Markdown would collapse them into one paragraph
    // gap. Keep the extra ones as real vertical space (one text line each).
    if (!fence && mode === 'none' && line.trim() === '' && out.length > 0) {
      let j = li;
      while (j < lines.length && lines[j].trim() === '') j++;
      const blanks = j - li;
      const next = lines[j];
      if (blanks >= 2 && next !== undefined) {
        const indent = /^[ ]*/.exec(next)![0];
        if (indent.length < 4 && !next.startsWith('\t')) {
          out.push('', `${indent}<!-- blank-lines:${Math.min(blanks - 1, 60)} -->`, '');
          li = j - 1;
          continue;
        }
      }
    }
    const fm = /^(\s*(?:>\s?)*)(`{3,}|~{3,})/.exec(line);
    if (fence) {
      out.push(line);
      if (fm && fm[2][0] === fence.ch && fm[2].length >= fence.len && line.slice(fm[0].length).trim() === '') fence = null;
      continue;
    }

    if (mode === 'bracket') {
      const t = line.trimEnd();
      if (t.endsWith('\\]')) {
        const body = t.slice(0, -2);
        if (body.trim()) out.push(body);
        out.push(mathPrefix + '$$');
        mode = 'none';
      } else out.push(line);
      continue;
    }
    if (mode === 'dollar') {
      const t = line.trimEnd();
      if (t.trim() === '$$') {
        out.push(line);
        mode = 'none';
      } else if (t.endsWith('$$') && !t.endsWith('\\$$')) {
        out.push(t.slice(0, -2));
        out.push(mathPrefix + '$$');
        mode = 'none';
      } else out.push(line);
      continue;
    }

    if (fm) {
      fence = { ch: fm[2][0], len: fm[2].length };
      out.push(line);
      continue;
    }

    const pm = /^(\s*(?:>\s?)*)((?:[*+-]|\d{1,9}[.)])[ \t]+)?(.*)$/.exec(line);
    const pre = pm?.[1] ?? '';
    const marker = pm?.[2] ?? '';
    const body = pm?.[3] ?? line;
    const cont = pre + ' '.repeat(marker.replace(/\t/g, '    ').length);
    const open = pre + marker;

    let m: RegExpExecArray | null;
    if ((m = /^\$\$(.+?)\$\$\s*$/.exec(body)) && m[1].trim() && !m[1].includes('$$')) {
      out.push(open + '$$', cont + m[1].trim(), cont + '$$');
    } else if ((m = /^\\\[(.+?)\\\]\s*$/.exec(body)) && m[1].trim()) {
      out.push(open + '$$', cont + m[1].trim(), cont + '$$');
    } else if (body.trim() === '\\[') {
      out.push(open + '$$');
      mode = 'bracket';
      mathPrefix = cont;
    } else if (/^\\\[/.test(body) && !body.includes('\\]')) {
      out.push(open + '$$');
      const rest = body.slice(2);
      if (rest.trim()) out.push(cont + rest.trim());
      mode = 'bracket';
      mathPrefix = cont;
    } else if (body.trim() === '$$') {
      out.push(line);
      mode = 'dollar';
      mathPrefix = cont;
    } else if (/^\$\$/.test(body) && !body.slice(2).includes('$$')) {
      out.push(open + '$$', cont + body.slice(2).trim());
      mode = 'dollar';
      mathPrefix = cont;
    } else {
      out.push(inlineDelimiters(line));
    }
  }
  return out.join('\n');
}

/* ------------------------------------------------------------------ */
/* mdast                                                               */
/* ------------------------------------------------------------------ */

// Inline formatting tags the page editor writes back into the Markdown. Anything
// else in raw HTML stays literal text (AI answers often contain stray `<tags>`).
const INLINE_OPEN = /^<(span|u|mark|sub|sup)(\s+style="([^"<>]*)")?\s*>$/i;
const INLINE_CLOSE = /^<\/(span|u|mark|sub|sup)\s*>$/i;
const SAFE_STYLE = /^(?:\s*(?:color|background-color|font-size)\s*:\s*[#\w(),.%\s-]+;?)+$/i;

/** Pairs inline open/close html nodes inside one phrasing parent into real elements. */
function pairInlineTags(p: MdParent): void {
  const kids = p.children as unknown as Array<{ type: string; value?: string; children?: unknown[]; data?: unknown }>;
  for (let i = 0; i < kids.length; i++) {
    const k = kids[i];
    if (k.type !== 'html') continue;
    const m = INLINE_OPEN.exec((k.value ?? '').trim());
    if (!m) continue;
    const tag = m[1].toLowerCase();
    const style = m[3] ?? '';
    if (tag === 'span' && (!style || !SAFE_STYLE.test(style))) continue;
    // Find the matching close tag at the same level (nesting-aware).
    let depth = 0;
    let j = i + 1;
    for (; j < kids.length; j++) {
      const v = kids[j].type === 'html' ? (kids[j].value ?? '').trim() : '';
      if (!v) continue;
      const o = INLINE_OPEN.exec(v);
      if (o && o[1].toLowerCase() === tag) depth++;
      const c = INLINE_CLOSE.exec(v);
      if (c && c[1].toLowerCase() === tag) {
        if (depth === 0) break;
        depth--;
      }
    }
    if (j >= kids.length) continue;
    const inner = kids.slice(i + 1, j);
    const node = {
      type: 'mdInline',
      children: inner,
      data: { hName: tag, hProperties: style ? { style: style.trim() } : {} },
    };
    pairInlineTags(node as unknown as MdParent);
    kids.splice(i, j - i + 1, node);
  }
}

/** `<br>` becomes a hard break; page-break markers become page breaks; other raw HTML stays literal text. */
function remarkHtmlAsText() {
  const pageBreak = () => ({ type: 'thematicBreak', data: { hProperties: { className: ['page-break'] }, pageBreak: true } });
  return (tree: MdRoot) => {
    // Inline formatting tags first, inside every parent that holds phrasing content.
    visit(tree, (node) => {
      const n = node as unknown as MdParent;
      if (Array.isArray(n.children) && n.children.some((c) => c.type === 'html')) pairInlineTags(n);
    });
    visit(tree, 'html', (node, index, parent) => {
      if (!parent || index === undefined) return undefined;
      const p = parent as MdParent;
      const v = node.value.trim();
      if (/^<br\s*\/?>$/i.test(v)) {
        (p.children as unknown[])[index] = { type: 'break' };
        return undefined;
      }
      if (/^<!--\s*(page-?break|new-?page)\s*-->$/i.test(v) || /^<div\s+style=["']\s*page-break-(before|after)\s*:\s*always;?\s*["']\s*>\s*<\/div>$/i.test(v)) {
        (p.children as unknown[])[index] = pageBreak();
        return undefined;
      }
      const pic = /^<!--\s*picture\s+(\{[\s\S]*\})\s*-->$/.exec(v);
      if (pic && (p.type === 'root' || p.type === 'listItem' || p.type === 'blockquote')) {
        try {
          const d = JSON.parse(pic[1]) as Record<string, unknown>;
          const str = (x: unknown, re: RegExp, dflt: string) => (typeof x === 'string' && re.test(x) ? x : dflt);
          (p.children as unknown[])[index] = {
            type: 'paragraph',
            children: [],
            data: {
              hName: 'figure',
              hProperties: {
                className: ['ed-fig'],
                dataId: str(d.id, /^[\w-]{1,40}$/, `g${index}`),
                dataImg: str(d.img, /^[\w-]{1,40}$/, ''),
                dataNw: Number(d.nw) || 1,
                dataNh: Number(d.nh) || 1,
                dataCrop: str(d.crop, /^[\d.,]+$/, '0,0,1,1'),
                dataW: Number(d.w) || 60,
                dataAlign: str(d.align, /^(left|center|right|float-left|float-right)$/, 'center'),
              },
            },
          };
          return undefined;
        } catch { /* fall through: drop as a comment */ }
      }
      const blank = /^<!--\s*blank-lines:(\d+)\s*-->$/.exec(v);
      if (blank && (p.type === 'root' || p.type === 'listItem' || p.type === 'blockquote')) {
        const n = Math.max(1, Math.min(60, Number(blank[1])));
        (p.children as unknown[])[index] = {
          type: 'paragraph',
          children: [],
          data: { blankLines: n, hName: 'div', hProperties: { className: ['blank-lines'], dataLines: n, style: `--n:${n}` } },
        };
        return undefined;
      }
      if (/^<!--[\s\S]*-->$/.test(v)) {
        (p.children as unknown[]).splice(index, 1);
        return index;
      }
      const text = { type: 'text', value: node.value };
      const blockParent = p.type === 'root' || p.type === 'listItem' || p.type === 'blockquote' || p.type === 'footnoteDefinition';
      (p.children as unknown[])[index] = blockParent ? { type: 'paragraph', children: [text] } : text;
      return undefined;
    });
    // A paragraph that is only `\newpage` / `\pagebreak` is a page break too.
    visit(tree, 'paragraph', (node, index, parent) => {
      if (!parent || index === undefined) return;
      const only = node.children.length === 1 && node.children[0].type === 'text' ? node.children[0].value.trim() : '';
      if (only === '\\newpage' || only === '\\pagebreak' || only === '\\clearpage') {
        (parent as MdParent).children[index] = pageBreak() as never;
      }
    });
  };
}

const mdProcessor = unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkHtmlAsText);

export function parseMarkdown(src: string): MdRoot {
  const tree = mdProcessor.parse(preprocess(src));
  return mdProcessor.runSync(tree) as MdRoot;
}

/* ------------------------------------------------------------------ */
/* hast                                                                */
/* ------------------------------------------------------------------ */

const BLOCK_TAGS = new Set(['p', 'ul', 'ol', 'div', 'pre', 'table', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'section']);

function textOf(node: Element | ElementContent): string {
  if (node.type === 'text') return node.value;
  if (node.type === 'element') return node.children.map(textOf).join('');
  return '';
}

function classes(el: Element): string[] {
  const c: unknown = el.properties?.className;
  return Array.isArray(c) ? c.map(String) : typeof c === 'string' ? c.split(/\s+/) : [];
}

function rehypeDsh() {
  return (tree: HRoot) => {
    visit(tree, 'element', (node, index, parent) => {
      if (!parent || index === undefined) return;
      const cls = classes(node);

      // Display math: <pre><code class="language-math math-display">
      if (node.tagName === 'pre') {
        const code = node.children.find((c): c is Element => c.type === 'element' && c.tagName === 'code');
        if (code && classes(code).includes('math-display')) {
          const raw = { type: 'raw', value: renderTex(textOf(code), true) } as unknown as ElementContent;
          parent.children[index] = { type: 'element', tagName: 'div', properties: { className: ['math-display'] }, children: [raw] };
          return SKIP;
        }
      }
      // Inline math: <code class="language-math math-inline">
      if (node.tagName === 'code' && cls.includes('math-inline')) {
        parent.children[index] = { type: 'raw', value: renderTex(textOf(node), false) } as unknown as ElementContent;
        return SKIP;
      }
      if (node.tagName === 'table') {
        const head = node.children.find((c): c is Element => c.type === 'element' && c.tagName === 'thead');
        const row = head?.children.find((c): c is Element => c.type === 'element' && c.tagName === 'tr');
        const cols = row ? row.children.filter((c) => c.type === 'element').length : 0;
        parent.children[index] = {
          type: 'element',
          tagName: 'div',
          properties: { className: ['table-wrap'], dataCols: cols },
          children: [node],
        };
        return SKIP; // table contents need no rewriting except math, handled below
      }
      if (node.tagName === 'a') {
        node.properties = { ...node.properties, target: '_blank', rel: ['noopener', 'noreferrer'] };
      }
      // Tight list items mix inline runs with nested blocks; give each inline
      // run its own block box so pagination can split between them.
      if (node.tagName === 'li') {
        const hasBlock = node.children.some((c) => c.type === 'element' && BLOCK_TAGS.has(c.tagName));
        const hasInline = node.children.some(
          (c) => (c.type === 'text' && c.value.trim() !== '') || (c.type === 'element' && !BLOCK_TAGS.has(c.tagName)) || (c as { type: string }).type === 'raw',
        );
        if (hasBlock && hasInline) {
          const next: ElementContent[] = [];
          let run: ElementContent[] = [];
          const flush = () => {
            if (run.some((c) => !(c.type === 'text' && c.value.trim() === ''))) {
              next.push({ type: 'element', tagName: 'div', properties: { className: ['li-run'] }, children: run });
            } else next.push(...run);
            run = [];
          };
          for (const c of node.children) {
            if (c.type === 'element' && BLOCK_TAGS.has(c.tagName)) {
              flush();
              next.push(c);
            } else run.push(c);
          }
          flush();
          node.children = next;
        }
      }
      return undefined;
    });
    // Math inside tables (skipped above) still has to be rendered.
    visit(tree, 'element', (node, index, parent) => {
      if (!parent || index === undefined) return;
      if (node.tagName === 'code' && classes(node).includes('math-inline')) {
        parent.children[index] = { type: 'raw', value: renderTex(textOf(node), false) } as unknown as ElementContent;
        return SKIP;
      }
      return undefined;
    });
    // HTML collapses runs of spaces into one; keep what the author typed (the last
    // space of each run stays a normal space so lines can still wrap there).
    visit(tree, 'text', (node, _index, parent) => {
      if (!parent || (parent.type === 'element' && (parent.tagName === 'code' || parent.tagName === 'pre'))) return;
      if (node.value.includes('  ')) node.value = node.value.replace(/ {2,}/g, (m) => '\u00a0'.repeat(m.length - 1) + ' ');
    });
    // Trim whitespace-only text between block children (keeps DOM tidy for pagination).
    visit(tree, 'element', (node) => {
      if (['ul', 'ol', 'blockquote', 'table', 'thead', 'tbody', 'tr', 'section'].includes(node.tagName)) {
        node.children = node.children.filter((c) => !(c.type === 'text' && (c as HText).value.trim() === ''));
      }
    });
  };
}

const htmlProcessor = unified()
  .use(remarkRehype, { footnoteLabel: 'Footnotes' })
  .use(rehypeDsh)
  .use(rehypeStringify, { allowDangerousHtml: true });

export function markdownToHtml(src: string): string {
  const mdast = parseMarkdown(src);
  const hast = htmlProcessor.runSync(mdast as never);
  return htmlProcessor.stringify(hast as never) as string;
}
