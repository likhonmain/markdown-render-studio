// "Word copy": puts Word-friendly rich HTML on the clipboard.
//
// Word turns MathML inside pasted HTML into native, editable equations, so
// every KaTeX node is reduced to its <math> element (KaTeX's visual HTML layer
// would otherwise paste as broken text). Tables, lists and fonts get inline
// styles because Word ignores stylesheet classes on paste.
import { FONTS, type Settings } from './settings';

const BORDER = '1px solid #bfc5cc';

function styleTree(root: HTMLElement, s: Settings): void {
  const font = FONTS[s.font].word;
  const pt = (px: number) => `${(px * 0.75).toFixed(1)}pt`;
  const k = s.fontSize / 14;

  // Math: keep only MathML.
  for (const html of root.querySelectorAll('.katex-html')) html.remove();
  for (const disp of root.querySelectorAll('.math-display, .katex-display')) {
    const math = disp.querySelector('math');
    if (!math) continue;
    math.setAttribute('display', 'block');
    const p = document.createElement('p');
    p.setAttribute('align', 'center');
    p.style.cssText = 'text-align:center;margin:6pt 0;';
    p.appendChild(math);
    disp.replaceWith(p);
  }
  for (const k2 of root.querySelectorAll('.katex, .katex-mathml')) {
    const math = k2.querySelector('math');
    if (math) k2.replaceWith(math);
    else k2.replaceWith(document.createTextNode(k2.textContent ?? ''));
  }
  for (const ann of root.querySelectorAll('annotation, annotation-xml')) ann.remove();
  for (const sem of root.querySelectorAll('semantics')) sem.replaceWith(...sem.childNodes);

  // Structure clean-up.
  for (const b of root.querySelectorAll<HTMLElement>('.blank-lines')) {
    const n = Math.max(1, Number(b.dataset.lines ?? '1') || 1);
    const ps = Array.from({ length: n }, () => {
      const p = document.createElement('p');
      p.style.cssText = 'margin:0;';
      p.innerHTML = '&nbsp;';
      return p;
    });
    b.replaceWith(...ps);
  }
  for (const run of root.querySelectorAll('.li-run')) run.replaceWith(...run.childNodes);
  for (const wrap of root.querySelectorAll('.table-wrap')) wrap.replaceWith(...wrap.childNodes);
  for (const el of root.querySelectorAll('[data-shell], [data-cols]')) {
    el.removeAttribute('data-shell');
    el.removeAttribute('data-cols');
  }

  // Inline styles.
  root.style.cssText = `font-family:'${font}',sans-serif;font-size:${pt(s.fontSize)};line-height:${(1.5 * s.lineSpacing).toFixed(2)};color:#0f1115;`;
  for (const p of root.querySelectorAll<HTMLElement>('p')) {
    if (!p.style.cssText) p.style.cssText = 'margin:0 0 8pt 0;';
  }
  const hs: Record<string, number> = { H1: 21, H2: 19, H3: 18, H4: 14, H5: 14, H6: 14 };
  for (const h of root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')) {
    h.style.cssText = `font-family:'${font}',sans-serif;font-size:${pt(hs[h.tagName] * k)};font-weight:bold;margin:14pt 0 6pt 0;color:#0f1115;`;
  }
  for (const l of root.querySelectorAll<HTMLElement>('ul,ol')) l.style.cssText = 'margin-top:4pt;margin-bottom:4pt;';
  for (const li of root.querySelectorAll<HTMLElement>('li')) li.style.cssText = 'margin:2pt 0;';
  for (const li of root.querySelectorAll<HTMLElement>('li.cont')) li.style.listStyleType = 'none';
  for (const t of root.querySelectorAll<HTMLElement>('table')) {
    t.removeAttribute('style');
    t.querySelector('colgroup')?.remove();
    t.setAttribute('border', '1');
    t.setAttribute('cellspacing', '0');
    t.setAttribute('cellpadding', '6');
    t.setAttribute('width', '100%');
    t.style.cssText = `width:100%;border-collapse:collapse;border:${BORDER};margin:6pt 0 10pt 0;font-size:${pt(s.fontSize * (13 / 14))};`;
  }
  for (const c of root.querySelectorAll<HTMLElement>('th,td')) {
    const align = c.getAttribute('align') ?? (c.style.textAlign || '');
    const head = c.tagName === 'TH';
    c.style.cssText =
      `border:${BORDER};padding:4pt 6pt;vertical-align:${head ? 'bottom' : 'middle'};` +
      `font-size:${pt(s.fontSize * (13 / 14))};${head ? 'background:#f2f3f5;font-weight:bold;' : ''}` +
      (align ? `text-align:${align};` : 'text-align:left;');
  }
  for (const pre of root.querySelectorAll<HTMLElement>('pre')) {
    pre.style.cssText = "font-family:Consolas,'Courier New',monospace;font-size:9pt;background:#f3f4f6;padding:6pt;white-space:pre-wrap;";
  }
  for (const code of root.querySelectorAll<HTMLElement>(':not(pre) > code')) {
    code.style.cssText = "font-family:Consolas,'Courier New',monospace;font-size:0.9em;background:#f3f4f6;";
  }
  for (const q of root.querySelectorAll<HTMLElement>('blockquote')) {
    q.style.cssText = 'border-left:2px solid #9ba0a6;margin:8pt 0;padding-left:10pt;';
  }
  for (const hr of root.querySelectorAll<HTMLElement>('hr')) {
    hr.style.cssText = 'border:none;border-top:1px solid #d0d4d9;margin:12pt 0;';
  }
  for (const a of root.querySelectorAll<HTMLElement>('a')) a.style.color = '#3964fe';
  for (const el of root.querySelectorAll<HTMLElement>('[class]')) el.removeAttribute('class');
}

export function wordHtmlFromNodes(nodes: Node | DocumentFragment, s: Settings): string {
  const root = document.createElement('div');
  root.appendChild(nodes);
  styleTree(root, s);
  return root.outerHTML;
}

export function wordHtmlFromHtml(html: string, s: Settings): string {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  return wordHtmlFromNodes(tpl.content, s);
}

export function wrapClipboardHtml(fragment: string): string {
  return (
    '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns:m="http://schemas.microsoft.com/office/2004/12/omml" xmlns="http://www.w3.org/TR/REC-html40">' +
    '<head><meta charset="utf-8"></head><body><!--StartFragment-->' +
    fragment +
    '<!--EndFragment--></body></html>'
  );
}

/** Copies rich HTML + plain text. Uses a synchronous copy event so the HTML is not sanitised. */
export async function copyRich(html: string, plain: string): Promise<void> {
  let ok = false;
  const onCopy = (e: ClipboardEvent) => {
    if (!e.clipboardData) return;
    e.clipboardData.setData('text/html', html);
    e.clipboardData.setData('text/plain', plain);
    e.preventDefault();
    e.stopImmediatePropagation();
    ok = true;
  };
  document.addEventListener('copy', onCopy, true);
  try {
    document.execCommand('copy');
  } finally {
    document.removeEventListener('copy', onCopy, true);
  }
  if (ok) return;
  if (navigator.clipboard && 'write' in navigator.clipboard && typeof ClipboardItem !== 'undefined') {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([plain], { type: 'text/plain' }),
      }),
    ]);
    return;
  }
  throw new Error('Clipboard access was blocked by the browser.');
}
