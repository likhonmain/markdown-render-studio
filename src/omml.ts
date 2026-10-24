// KaTeX MathML → Office Math (OMML) converter for native Word equations.
// Covers the MathML subset KaTeX emits: tokens, scripts, fractions,
// radicals, accents/limits, n-ary operators, stretchy fences, matrices,
// spaces, phantoms and enclosures.

const NARY = new Set(['∑', '∏', '∐', '∫', '∬', '∭', '⨌', '∮', '∯', '∰', '⋃', '⋂', '⋁', '⋀', '⨁', '⨂', '⨀', '⨄', '⨆']);
const INTEGRALS = new Set(['∫', '∬', '∭', '⨌', '∮', '∯', '∰']);
const RELATIONS = new Set(['=', '≠', '<', '>', '≤', '≥', '≈', '≡', '∼', '≃', '≅', '∝', '→', '←', '⇒', '⇐', '⇔', '↔', '∈', '∉', '⊂', '⊃', '⊆', '⊇']);

const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

interface Ctx {
  variant: string | null; // inherited mathvariant
  color: string | null;
}

function kids(el: Element): Element[] {
  return [...el.children];
}

function text(el: Element): string {
  return (el.textContent ?? '').replace(/\u2061/g, '').replace(/\u2062/g, '').replace(/\u2063/g, '');
}

function sty(variant: string | null, tag: string, t: string): string {
  // returns OMML m:rPr inner (sty / nor / scr)
  const v = variant;
  if (tag === 'mtext') {
    const b = v === 'bold' || v === 'bold-italic';
    return `<m:nor/>${b ? '<m:sty m:val="b"/>' : ''}`;
  }
  switch (v) {
    case 'bold':
      return '<m:sty m:val="b"/>';
    case 'bold-italic':
      return '<m:sty m:val="bi"/>';
    case 'italic':
      return '<m:sty m:val="i"/>';
    case 'normal':
      return '<m:sty m:val="p"/>';
    case 'double-struck':
      return '<m:scr m:val="double-struck"/><m:sty m:val="p"/>';
    case 'script':
      return '<m:scr m:val="script"/>';
    case 'fraktur':
      return '<m:scr m:val="fraktur"/>';
    case 'monospace':
      return '<m:scr m:val="monospace"/><m:sty m:val="p"/>';
    case 'sans-serif':
      return '<m:scr m:val="sans-serif"/><m:sty m:val="p"/>';
    default:
      break;
  }
  if (tag === 'mi') return [...t].length > 1 ? '<m:sty m:val="p"/>' : '';
  return '<m:sty m:val="p"/>';
}

function run(t: string, mrpr: string, ctx: Ctx, bold = false): string {
  if (t === '') return '';
  const wr = `<w:rPr><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math"/>${bold ? '<w:b/>' : ''}${
    ctx.color ? `<w:color w:val="${ctx.color}"/>` : ''
  }</w:rPr>`;
  return `<m:r>${mrpr ? `<m:rPr>${mrpr}</m:rPr>` : ''}${wr}<m:t xml:space="preserve">${xmlEscape(t)}</m:t></m:r>`;
}

function colorHex(c: string | null): string | null {
  if (!c) return null;
  if (/^#[0-9a-f]{6}$/i.test(c)) return c.slice(1).toUpperCase();
  if (/^#[0-9a-f]{3}$/i.test(c)) return c.slice(1).split('').map((x) => x + x).join('').toUpperCase();
  const named: Record<string, string> = { red: 'FF0000', blue: '0000FF', green: '008000', black: '000000', gray: '808080', orange: 'FFA500', purple: '800080' };
  return named[c.toLowerCase()] ?? null;
}

function spaceFor(widthAttr: string | null): string {
  if (!widthAttr) return '';
  const m = /^(-?[\d.]+)(em|ex|mu|pt|px)?$/.exec(widthAttr.trim());
  if (!m) return '';
  let em = parseFloat(m[1]);
  if (m[2] === 'mu') em /= 18;
  else if (m[2] === 'ex') em *= 0.43;
  else if (m[2] === 'pt') em /= 10;
  else if (m[2] === 'px') em /= 13;
  if (em <= 0.05) return '';
  if (em >= 0.9) return '\u2003'.repeat(Math.max(1, Math.round(em)));
  if (em >= 0.45) return '\u2002';
  if (em >= 0.24) return '\u2005';
  if (em >= 0.2) return '\u2004';
  return '\u2009';
}

function ctxFor(el: Element, ctx: Ctx): Ctx {
  const v = el.getAttribute('mathvariant');
  const c = colorHex(el.getAttribute('mathcolor'));
  if (!v && !c) return ctx;
  return { variant: v ?? ctx.variant, color: c ?? ctx.color };
}

function isFence(el: Element | undefined): boolean {
  return !!el && el.tagName === 'mo' && el.getAttribute('fence') === 'true';
}

function isNaryBase(el: Element | undefined): string | null {
  if (!el) return null;
  if (el.tagName === 'mo' || el.tagName === 'mi') {
    const t = text(el).trim();
    if (NARY.has(t)) return t;
  }
  return null;
}

/** Converts a list of sibling nodes, merging n-ary operators with their operand. */
function seq(nodes: Element[], ctx: Ctx): string {
  let out = '';
  for (let i = 0; i < nodes.length; i++) {
    const el = nodes[i];
    const naryHead = naryParts(el);
    if (naryHead) {
      // Absorb following siblings until a relation operator as the operand.
      const body: Element[] = [];
      let j = i + 1;
      for (; j < nodes.length; j++) {
        const n = nodes[j];
        if (n.tagName === 'mo' && RELATIONS.has(text(n).trim())) break;
        body.push(n);
      }
      out += nary(naryHead, body, ctx);
      i = j - 1;
      continue;
    }
    out += node(el, ctx);
    // KaTeX marks function names (sin, log…) with U+2061; Word needs an
    // explicit thin space when the argument is not parenthesised.
    if (el.tagName === 'mi' && [...text(el)].length > 1) {
      const next = nodes[i + 1];
      if (next && next.tagName === 'mo' && (next.textContent ?? '').includes('\u2061')) {
        const arg = nodes[i + 2];
        const argText = arg ? (arg.textContent ?? '').trim() : '';
        if (arg && !argText.startsWith('(') && !argText.startsWith('[')) out += run('\u2009', '<m:sty m:val="p"/>', ctx);
        i++;
      }
    }
  }
  return out;
}

interface NaryHead {
  chr: string;
  sub: Element | null;
  sup: Element | null;
  undOvr: boolean;
}

function naryParts(el: Element): NaryHead | null {
  const tag = el.tagName;
  if (tag === 'mo' || tag === 'mi') {
    const c = isNaryBase(el);
    return c ? { chr: c, sub: null, sup: null, undOvr: false } : null;
  }
  if (['msub', 'msup', 'msubsup', 'munder', 'mover', 'munderover'].includes(tag)) {
    const k = kids(el);
    const c = isNaryBase(k[0]);
    if (!c) return null;
    const under = tag === 'munder' || tag === 'munderover';
    const over = tag === 'mover' || tag === 'munderover';
    let sub: Element | null = null;
    let sup: Element | null = null;
    if (tag === 'msub' || tag === 'munder') sub = k[1] ?? null;
    else if (tag === 'msup' || tag === 'mover') sup = k[1] ?? null;
    else {
      sub = k[1] ?? null;
      sup = k[2] ?? null;
    }
    return { chr: c, sub, sup, undOvr: (under || over) && !INTEGRALS.has(c) };
  }
  return null;
}

function nary(h: NaryHead, body: Element[], ctx: Ctx): string {
  const pr =
    `<m:naryPr>${h.chr === '∫' ? '' : `<m:chr m:val="${xmlEscape(h.chr)}"/>`}` +
    `<m:limLoc m:val="${h.undOvr ? 'undOvr' : 'subSup'}"/>` +
    (h.sub ? '' : '<m:subHide m:val="1"/>') +
    (h.sup ? '' : '<m:supHide m:val="1"/>') +
    '<m:ctrlPr/></m:naryPr>';
  return `<m:nary>${pr}<m:sub>${h.sub ? node(h.sub, ctx) : ''}</m:sub><m:sup>${h.sup ? node(h.sup, ctx) : ''}</m:sup><m:e>${seq(body, ctx)}</m:e></m:nary>`;
}

function arg(el: Element | undefined, ctx: Ctx): string {
  return el ? node(el, ctx) : '';
}

function mrow(el: Element, ctx: Ctx): string {
  const k = kids(el);
  if (k.length >= 2 && isFence(k[0]) && isFence(k[k.length - 1])) {
    const beg = text(k[0]);
    const end = text(k[k.length - 1]);
    const inner = k.slice(1, -1);
    // \middle separators split the delimiter into several elements.
    const parts: Element[][] = [[]];
    let sep: string | null = null;
    for (const c of inner) {
      if (isFence(c)) {
        sep = text(c);
        parts.push([]);
      } else parts[parts.length - 1].push(c);
    }
    const pr =
      `<m:dPr><m:begChr m:val="${xmlEscape(beg)}"/>` +
      (sep !== null ? `<m:sepChr m:val="${xmlEscape(sep)}"/>` : '') +
      `<m:endChr m:val="${xmlEscape(end)}"/><m:ctrlPr/></m:dPr>`;
    return `<m:d>${pr}${parts.map((p) => `<m:e>${seq(p, ctx)}</m:e>`).join('')}</m:d>`;
  }
  return seq(k, ctx);
}

function token(el: Element, ctx: Ctx): string {
  const c = ctxFor(el, ctx);
  const tag = el.tagName;
  let t = text(el);
  if (tag === 'mo' && t.trim() === '') return '';
  if (tag === 'mtext') t = t.replace(/\u00a0/g, ' ');
  const bold = c.variant === 'bold' || c.variant === 'bold-italic';
  return run(t, sty(c.variant, tag, t), c, bold);
}

function table(el: Element, ctx: Ctx): string {
  const rows = kids(el).filter((r) => r.tagName === 'mtr' || r.tagName === 'mlabeledtr');
  const cols = Math.max(1, ...rows.map((r) => kids(r).filter((c) => c.tagName === 'mtd').length));
  const aligns = (el.getAttribute('columnalign') ?? '').split(/\s+/).filter(Boolean);
  // Two-column right/left alignment (aligned, align*) → equation array.
  if (cols <= 2 && aligns[0] === 'right' && (aligns[1] ?? 'left') === 'left') {
    const es = rows
      .map((r) => {
        const cells = kids(r).filter((c) => c.tagName === 'mtd');
        const left = cells[0] ? node(cells[0], ctx) : '';
        const right = cells[1] ? node(cells[1], ctx) : '';
        return `<m:e>${left}${cells.length > 1 ? '<m:r><m:t>&amp;</m:t></m:r>' : ''}${right}</m:e>`;
      })
      .join('');
    return `<m:eqArr><m:eqArrPr><m:ctrlPr/></m:eqArrPr>${es}</m:eqArr>`;
  }
  const mcs = Array.from({ length: cols }, (_, i) => {
    const a = aligns[Math.min(i, aligns.length - 1)] ?? 'center';
    return `<m:mc><m:mcPr><m:count m:val="1"/><m:mcJc m:val="${a === 'left' ? 'left' : a === 'right' ? 'right' : 'center'}"/></m:mcPr></m:mc>`;
  }).join('');
  const mrs = rows
    .map((r) => {
      const cells = kids(r).filter((c) => c.tagName === 'mtd');
      let es = cells.map((c) => `<m:e>${node(c, ctx)}</m:e>`).join('');
      for (let i = cells.length; i < cols; i++) es += '<m:e></m:e>';
      return `<m:mr>${es}</m:mr>`;
    })
    .join('');
  return `<m:m><m:mPr><m:mcs>${mcs}</m:mcs><m:ctrlPr/></m:mPr>${mrs}</m:m>`;
}

function accentChar(mo: Element): string {
  const t = text(mo).trim();
  const map: Record<string, string> = { '^': '\u0302', ˆ: '\u0302', '~': '\u0303', '˜': '\u0303', '¯': '\u0305', ˉ: '\u0305', '‾': '\u0305', '→': '\u20D7', '←': '\u20D6', '˙': '\u0307', '¨': '\u0308', '´': '\u0301', '`': '\u0300', ˇ: '\u030C', '˘': '\u0306', '˚': '\u030A', '⃗': '\u20D7' };
  return map[t] ?? t;
}

function node(el: Element, ctx: Ctx): string {
  const tag = el.tagName;
  const k = kids(el);
  switch (tag) {
    case 'math':
    case 'semantics':
    case 'mrow':
    case 'mpadded':
    case 'mtd':
      return tag === 'mrow' ? mrow(el, ctx) : seq(k.filter((c) => c.tagName !== 'annotation' && c.tagName !== 'annotation-xml'), ctx);
    case 'mstyle':
      return seq(k, ctxFor(el, ctx));
    case 'annotation':
    case 'annotation-xml':
      return '';
    case 'mi':
    case 'mn':
    case 'mo':
    case 'mtext':
    case 'ms':
      return token(el, ctx);
    case 'mspace': {
      const s = spaceFor(el.getAttribute('width'));
      return s ? run(s, '<m:sty m:val="p"/>', ctx) : '';
    }
    case 'msub':
      return `<m:sSub><m:sSubPr><m:ctrlPr/></m:sSubPr><m:e>${arg(k[0], ctx)}</m:e><m:sub>${arg(k[1], ctx)}</m:sub></m:sSub>`;
    case 'msup':
      return `<m:sSup><m:sSupPr><m:ctrlPr/></m:sSupPr><m:e>${arg(k[0], ctx)}</m:e><m:sup>${arg(k[1], ctx)}</m:sup></m:sSup>`;
    case 'msubsup':
      return `<m:sSubSup><m:sSubSupPr><m:ctrlPr/></m:sSubSupPr><m:e>${arg(k[0], ctx)}</m:e><m:sub>${arg(k[1], ctx)}</m:sub><m:sup>${arg(k[2], ctx)}</m:sup></m:sSubSup>`;
    case 'mfrac': {
      const lt = el.getAttribute('linethickness');
      const noBar = lt !== null && parseFloat(lt) === 0;
      return `<m:f><m:fPr><m:type m:val="${noBar ? 'noBar' : 'bar'}"/><m:ctrlPr/></m:fPr><m:num>${arg(k[0], ctx)}</m:num><m:den>${arg(k[1], ctx)}</m:den></m:f>`;
    }
    case 'msqrt':
      return `<m:rad><m:radPr><m:degHide m:val="1"/><m:ctrlPr/></m:radPr><m:deg/><m:e>${seq(k, ctx)}</m:e></m:rad>`;
    case 'mroot':
      return `<m:rad><m:radPr><m:ctrlPr/></m:radPr><m:deg>${arg(k[1], ctx)}</m:deg><m:e>${arg(k[0], ctx)}</m:e></m:rad>`;
    case 'mover': {
      const accent = el.getAttribute('accent') === 'true';
      const over = k[1];
      if (over && over.tagName === 'mo') {
        const t = text(over).trim();
        if (t === '‾' || t === '¯' || (t === '―' && !accent)) {
          return `<m:bar><m:barPr><m:pos m:val="top"/><m:ctrlPr/></m:barPr><m:e>${arg(k[0], ctx)}</m:e></m:bar>`;
        }
        if (accent) {
          return `<m:acc><m:accPr><m:chr m:val="${xmlEscape(accentChar(over))}"/><m:ctrlPr/></m:accPr><m:e>${arg(k[0], ctx)}</m:e></m:acc>`;
        }
        if (t === '⏞' || t === '⏟') {
          return `<m:groupChr><m:groupChrPr><m:chr m:val="${t}"/><m:pos m:val="top"/><m:vertJc m:val="bot"/><m:ctrlPr/></m:groupChrPr><m:e>${arg(k[0], ctx)}</m:e></m:groupChr>`;
        }
      }
      return `<m:limUpp><m:limUppPr><m:ctrlPr/></m:limUppPr><m:e>${arg(k[0], ctx)}</m:e><m:lim>${arg(k[1], ctx)}</m:lim></m:limUpp>`;
    }
    case 'munder': {
      const under = k[1];
      if (under && under.tagName === 'mo') {
        const t = text(under).trim();
        if (t === '_' || t === '‾' || t === '―') {
          return `<m:bar><m:barPr><m:pos m:val="bot"/><m:ctrlPr/></m:barPr><m:e>${arg(k[0], ctx)}</m:e></m:bar>`;
        }
        if (t === '⏟') {
          return `<m:groupChr><m:groupChrPr><m:chr m:val="⏟"/><m:ctrlPr/></m:groupChrPr><m:e>${arg(k[0], ctx)}</m:e></m:groupChr>`;
        }
      }
      return `<m:limLow><m:limLowPr><m:ctrlPr/></m:limLowPr><m:e>${arg(k[0], ctx)}</m:e><m:lim>${arg(k[1], ctx)}</m:lim></m:limLow>`;
    }
    case 'munderover':
      return `<m:limUpp><m:limUppPr><m:ctrlPr/></m:limUppPr><m:e><m:limLow><m:limLowPr><m:ctrlPr/></m:limLowPr><m:e>${arg(k[0], ctx)}</m:e><m:lim>${arg(k[1], ctx)}</m:lim></m:limLow></m:e><m:lim>${arg(k[2], ctx)}</m:lim></m:limUpp>`;
    case 'mtable':
      return table(el, ctx);
    case 'mphantom':
      return `<m:phant><m:phantPr><m:show m:val="0"/><m:ctrlPr/></m:phantPr><m:e>${seq(k, ctx)}</m:e></m:phant>`;
    case 'menclose': {
      const n = el.getAttribute('notation') ?? 'box';
      if (/strike|cancel/.test(n) || /(up|down)diagonal/.test(n)) {
        const tl = /downdiagonal/.test(n) ? '<m:strikeTLBR m:val="1"/>' : '';
        const bl = /updiagonal/.test(n) ? '<m:strikeBLTR m:val="1"/>' : '';
        const h = /horizontalstrike/.test(n) ? '<m:strikeH m:val="1"/>' : '';
        return `<m:borderBox><m:borderBoxPr><m:hideTop m:val="1"/><m:hideBot m:val="1"/><m:hideLeft m:val="1"/><m:hideRight m:val="1"/>${h}${bl}${tl}<m:ctrlPr/></m:borderBoxPr><m:e>${seq(k, ctx)}</m:e></m:borderBox>`;
      }
      return `<m:borderBox><m:borderBoxPr><m:ctrlPr/></m:borderBoxPr><m:e>${seq(k, ctx)}</m:e></m:borderBox>`;
    }
    case 'merror':
      return seq(k, { ...ctx, color: 'CC0000' });
    default:
      return seq(k, ctx);
  }
}

let parser: DOMParser | null = null;

/** Returns `<m:oMath>` XML for a MathML string (empty string on failure). */
export function mathmlToOmml(mathml: string): string {
  if (!mathml) return '';
  parser ??= new DOMParser();
  const doc = parser.parseFromString(mathml.replace(/&nbsp;/g, '&#160;'), 'application/xml');
  const root = doc.documentElement;
  if (!root || root.tagName !== 'math' || doc.getElementsByTagName('parsererror').length) return '';
  const body = node(root, { variant: null, color: null });
  return `<m:oMath>${body}</m:oMath>`;
}
