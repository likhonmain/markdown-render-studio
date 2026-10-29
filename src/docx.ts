// Native .docx export: walks the Markdown AST and writes WordprocessingML with
// real Word lists, tables (fit to page width) and OMML equations.
import JSZip from 'jszip';
import type * as M from 'mdast';
import { parseMarkdown, texToMathML } from './markdown';
import { mathmlToOmml } from './omml';
import { FONTS, geometry, type Settings } from './settings';
import { figData, picHeight } from './flow';
import { croppedDataUrl } from './store';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

const TWIP_PER_MM = 1440 / 25.4;
const tw = (mm: number) => Math.round(mm * TWIP_PER_MM);

interface Fmt {
  b?: boolean;
  i?: boolean;
  u?: boolean;
  strike?: boolean;
  code?: boolean;
  link?: boolean;
  size?: number; // half-points override
  color?: string; // RRGGBB
  shade?: string; // RRGGBB background
  vert?: 'superscript' | 'subscript';
}

interface Media {
  name: string;
  data: string; // base64
}

interface ListCtx {
  numId: number;
  level: number;
}

interface Ctx {
  list: ListCtx | null;
  indent: number; // twips for continuation blocks inside list items
  quote: boolean;
  inTable: boolean;
  align?: 'left' | 'center' | 'right' | 'justify' | null;
}

class DocxWriter {
  private rels: string[] = [];
  private relId = 10;
  private nums: string[] = [];
  private nextNum = 3;
  private body: string[] = [];
  private textWidth: number; // twips
  private fnDefs = new Map<string, M.FootnoteDefinition>();
  private fnOrder: string[] = [];

  constructor(private s: Settings) {
    const g = geometry(s);
    this.textWidth = tw(g.pageW - g.ml - g.mr);
  }

  /* ---------------- inline ---------------- */

  private run(text: string, f: Fmt): string {
    if (!text) return '';
    let rpr = '';
    if (f.link) rpr += '<w:rStyle w:val="Hyperlink"/>';
    if (f.code) rpr += '<w:rStyle w:val="InlineCode"/>';
    if (f.b) rpr += '<w:b/><w:bCs/>';
    if (f.i) rpr += '<w:i/><w:iCs/>';
    if (f.strike) rpr += '<w:strike/>';
    if (f.color) rpr += `<w:color w:val="${f.color}"/>`;
    if (f.size) rpr += `<w:sz w:val="${f.size}"/><w:szCs w:val="${f.size}"/>`;
    if (f.u) rpr += '<w:u w:val="single"/>';
    if (f.shade) rpr += `<w:shd w:val="clear" w:color="auto" w:fill="${f.shade}"/>`;
    if (f.vert) rpr += `<w:vertAlign w:val="${f.vert}"/>`;
    const parts = text.split('\n');
    return parts
      .map((p, i) => `${i ? `<w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ''}<w:br/></w:r>` : ''}<w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ''}<w:t xml:space="preserve">${esc(p)}</w:t></w:r>`)
      .join('');
  }

  private math(tex: string, display: boolean, f: Fmt): string {
    const omml = mathmlToOmml(texToMathML(tex, display));
    if (!omml) return this.run(display ? tex : `$${tex}$`, { ...f, code: true });
    if (!f.size) return omml;
    // Table cells: shrink math runs to the cell font size.
    return omml.replace(/<w:rPr>/g, `<w:rPr><w:sz w:val="${f.size}"/><w:szCs w:val="${f.size}"/>`);
  }

  private inlines(nodes: M.PhrasingContent[], f: Fmt): string {
    return nodes.map((n) => this.inline(n, f)).join('');
  }

  private inline(n: M.PhrasingContent, f: Fmt): string {
    switch (n.type) {
      case 'text':
        return this.run(n.value.replace(/\n/g, ' '), f);
      case 'strong':
        return this.inlines(n.children, { ...f, b: true });
      case 'emphasis':
        return this.inlines(n.children, { ...f, i: true });
      case 'delete':
        return this.inlines(n.children, { ...f, strike: true });
      case 'inlineCode':
        return this.run(n.value, { ...f, code: true });
      case 'inlineMath':
        return this.math(n.value, false, f);
      case 'break':
        return '<w:r><w:br/></w:r>';
      case 'link': {
        const id = `rId${this.relId++}`;
        this.rels.push(`<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${esc(n.url)}" TargetMode="External"/>`);
        return `<w:hyperlink r:id="${id}">${this.inlines(n.children, { ...f, link: true })}</w:hyperlink>`;
      }
      case 'image':
        return this.run(n.alt ? `[${n.alt}]` : '[image]', { ...f, i: true });
      case 'footnoteReference': {
        if (!this.fnOrder.includes(n.identifier)) this.fnOrder.push(n.identifier);
        const num = this.fnOrder.indexOf(n.identifier) + 1;
        return `<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:t>${num}</w:t></w:r>`;
      }
      case 'html':
        return this.run(n.value, f);
      default:
        return 'children' in n ? this.inlines((n as M.Parent).children as M.PhrasingContent[], f) : 'value' in n ? this.run(String((n as M.Literal).value), f) : '';
    }
  }

  /* ---------------- blocks ---------------- */

  private pPr(ctx: Ctx, style: string | null, extra = '', numbered = false): string {
    let p = '';
    if (style) p += `<w:pStyle w:val="${style}"/>`;
    if (numbered && ctx.list) p += `<w:numPr><w:ilvl w:val="${ctx.list.level}"/><w:numId w:val="${ctx.list.numId}"/></w:numPr>`;
    if (ctx.quote) p += '<w:pBdr><w:left w:val="single" w:sz="12" w:space="8" w:color="9BA0A6"/></w:pBdr>';
    if (!numbered && ctx.indent > 0 && !ctx.inTable) p += `<w:ind w:left="${ctx.indent + (ctx.quote ? 200 : 0)}"/>`;
    else if (ctx.quote && !numbered) p += '<w:ind w:left="200"/>';
    if (ctx.align && ctx.align !== 'left') p += `<w:jc w:val="${ctx.align === 'center' ? 'center' : ctx.align === 'justify' ? 'both' : 'right'}"/>`;
    p += extra;
    return p ? `<w:pPr>${p}</w:pPr>` : '';
  }

  private para(content: string, ctx: Ctx, style: string | null = null, extra = '', numbered = false): string {
    return `<w:p>${this.pPr(ctx, style, extra, numbered)}${content}</w:p>`;
  }

  private newNum(ordered: boolean, start: number): number {
    const id = this.nextNum++;
    this.nums.push(
      `<w:num w:numId="${id}"><w:abstractNumId w:val="${ordered ? 2 : 1}"/>${
        ordered
          ? Array.from({ length: 9 }, (_, l) => `<w:lvlOverride w:ilvl="${l}"><w:startOverride w:val="${l === 0 ? start : 1}"/></w:lvlOverride>`).join('')
          : ''
      }</w:num>`,
    );
    return id;
  }

  private blocks(nodes: M.RootContent[], ctx: Ctx): string[] {
    const out: string[] = [];
    for (const n of nodes) out.push(...this.block(n, ctx));
    return out;
  }

  private block(n: M.RootContent, ctx: Ctx, firstInItem = false): string[] {
    const cellSize = ctx.inTable ? this.cellHalfPts() : undefined;
    switch (n.type) {
      case 'heading':
        return [this.para(this.inlines(n.children, {}), ctx, `Heading${n.depth}`)];
      case 'paragraph': {
        const blank = (n.data as { blankLines?: number } | undefined)?.blankLines;
        if (blank) return Array.from({ length: blank }, () => this.para('', ctx, ctx.list ? 'ListParagraph' : null, '<w:spacing w:before="0" w:after="0"/>'));
        return [this.para(this.inlines(n.children, { size: cellSize }), ctx, ctx.inTable ? 'TableText' : ctx.list ? 'ListParagraph' : null, '', firstInItem)];
      }
      case 'math':
        return [this.para(`<m:oMathPara><m:oMathParaPr><m:jc m:val="center"/></m:oMathParaPr>${this.math(n.value, true, { size: cellSize })}</m:oMathPara>`, ctx, ctx.inTable ? 'TableText' : 'MathBlock', '', firstInItem)];
      case 'code': {
        if (n.lang === 'math') return this.block({ type: 'math', value: n.value } as unknown as M.RootContent, ctx, firstInItem);
        const lines = n.value.split('\n');
        return lines.map((l, i) =>
          this.para(this.run(l || ' ', {}), ctx, 'CodeBlock', i === 0 ? '' : '<w:spacing w:before="0"/>', firstInItem && i === 0),
        );
      }
      case 'blockquote':
        return this.blocks(n.children, { ...ctx, quote: true });
      case 'thematicBreak':
        if ((n.data as { pageBreak?: boolean } | undefined)?.pageBreak) return ['<w:p><w:r><w:br w:type="page"/></w:r></w:p>'];
        return [this.para('', ctx, 'Rule')];
      case 'list':
        return this.list(n, ctx);
      case 'table':
        return [this.table(n, ctx)];
      case 'html':
        if (/^<br\s*\/?>$/i.test(n.value.trim())) return [];
        return [this.para(this.run(n.value, {}), ctx, null, '', firstInItem)];
      case 'definition':
        return [];
      case 'footnoteDefinition':
        this.fnDefs.set(n.identifier, n);
        return [];
      default:
        return [];
    }
  }

  private list(n: M.List, ctx: Ctx): string[] {
    const level = ctx.list ? Math.min(ctx.list.level + 1, 8) : 0;
    const numId = this.newNum(!!n.ordered, n.start ?? 1);
    const lctx: Ctx = { ...ctx, list: { numId, level }, indent: 360 * (level + 1) + 0 };
    const out: string[] = [];
    for (const item of n.children) {
      const kids = item.children;
      if (kids.length === 0) {
        out.push(this.para('', lctx, 'ListParagraph', '', true));
        continue;
      }
      let first = true;
      for (const k of kids) {
        if (first && typeof item.checked === 'boolean' && k.type === 'paragraph') {
          const box = this.run(item.checked ? '☑ ' : '☐ ', {});
          out.push(this.para(box + this.inlines(k.children, {}), lctx, 'ListParagraph', '', true));
        } else if (first && (k.type === 'list' || k.type === 'table')) {
          out.push(this.para('', lctx, 'ListParagraph', '', true));
          out.push(...this.block(k, lctx));
        } else {
          out.push(...this.block(k, lctx, first));
        }
        first = false;
      }
    }
    return out;
  }

  private cellHalfPts(): number {
    // Table text is 13px in DSH vs. 14px body; mirror that ratio.
    return Math.max(14, Math.round(this.s.fontSize * (13 / 14) * 0.75 * 2));
  }

  private table(n: M.Table, ctx: Ctx): string {
    const rows = n.children;
    const cols = Math.max(1, ...rows.map((r) => r.children.length));
    const avail = Math.max(1440, this.textWidth - (ctx.list ? ctx.indent : 0));
    // Column widths proportional to content length (clamped), like a browser's auto layout.
    const weights = Array.from({ length: cols }, (_, c) => {
      let max = 4;
      for (const r of rows) {
        const cell = r.children[c];
        if (!cell) continue;
        const len = mdText(cell).length;
        max = Math.max(max, Math.min(len, 60));
      }
      return Math.sqrt(max) + 1.5;
    });
    const total = weights.reduce((a, b) => a + b, 0);
    const widths = weights.map((w) => Math.floor((w / total) * avail));
    const grid = widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('');
    const border = (k: string) => `<w:${k} w:val="single" w:sz="4" w:space="0" w:color="BFC5CC"/>`;
    const tblPr =
      `<w:tblPr><w:tblStyle w:val="MdTable"/><w:tblW w:w="${avail}" w:type="dxa"/>` +
      (ctx.list ? `<w:tblInd w:w="${ctx.indent}" w:type="dxa"/>` : '') +
      `<w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(border).join('')}</w:tblBorders>` +
      '<w:tblLayout w:type="autofit"/><w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar>' +
      '<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="1" w:noVBand="1"/></w:tblPr>';
    const trs = rows
      .map((r, ri) => {
        const header = ri === 0;
        const trPr = header ? '<w:trPr><w:tblHeader/><w:cantSplit/></w:trPr>' : '<w:trPr><w:cantSplit/></w:trPr>';
        let tcs = '';
        for (let c = 0; c < cols; c++) {
          const cell = r.children[c];
          const align = n.align?.[c] ?? null;
          const cctx: Ctx = { list: null, indent: 0, quote: false, inTable: true, align };
          const content = cell ? this.inlines(cell.children, { b: header || undefined, size: this.cellHalfPts() }) : '';
          const tcPr = `<w:tcPr><w:tcW w:w="${widths[c]}" w:type="dxa"/>${header ? '<w:shd w:val="clear" w:color="auto" w:fill="F2F3F5"/>' : ''}<w:vAlign w:val="${header ? 'bottom' : 'center'}"/></w:tcPr>`;
          tcs += `<w:tc>${tcPr}${this.para(content, cctx, 'TableText')}</w:tc>`;
        }
        return `<w:tr>${trPr}${tcs}</w:tr>`;
      })
      .join('');
    // Word needs a paragraph between consecutive tables; add spacing after.
    return `<w:tbl>${tblPr}<w:tblGrid>${grid}</w:tblGrid>${trs}</w:tbl><w:p><w:pPr><w:pStyle w:val="TableGap"/></w:pPr></w:p>`;
  }

  /* ---------------- package ---------------- */

  build(root: M.Root): Promise<Blob> {
    const ctx: Ctx = { list: null, indent: 0, quote: false, inTable: false };
    for (const n of root.children) if (n.type === 'footnoteDefinition') this.fnDefs.set(n.identifier, n);
    this.body = this.blocks(root.children, ctx);
    if (this.fnOrder.length) {
      this.body.push(this.para('', ctx, 'Rule'));
      this.fnOrder.forEach((id, i) => {
        const def = this.fnDefs.get(id);
        if (!def) return;
        const paras = def.children.filter((c): c is M.Paragraph => c.type === 'paragraph');
        const txt = paras.map((p) => this.inlines(p.children, {})).join(' ');
        this.body.push(this.para(this.run(`${i + 1}. `, {}) + txt, ctx, 'Footnote'));
      });
    }
    return this.pack();
  }

  /* ---------------- edited page (DOM) ---------------- */

  private media: Media[] = [];
  private picSrc = new Map<Element, { data: string; ext: string }>();
  private drawId = 1;

  async buildDom(root: HTMLElement): Promise<Blob> {
    for (const fig of root.querySelectorAll<HTMLElement>('figure.ed-fig')) {
      const p = figData(fig);
      const url = await croppedDataUrl(p.img, p.crop);
      const m = url ? /^data:image\/(png|jpeg);base64,(.*)$/.exec(url) : null;
      if (m) this.picSrc.set(fig, { ext: m[1] === 'jpeg' ? 'jpeg' : 'png', data: m[2] });
    }
    const ctx: Ctx = { list: null, indent: 0, quote: false, inTable: false };
    this.body = this.domBlocks(root, ctx);
    return this.pack();
  }

  private baseHalfPts(): number {
    return Math.round(this.s.fontSize * 0.75 * 2);
  }

  private domFmt(el: HTMLElement, f: Fmt): Fmt {
    const n: Fmt = { ...f };
    const st = el.style;
    const col = hexColor(st.color || el.getAttribute('color') || '');
    if (col) n.color = col;
    const bg = hexColor(st.backgroundColor);
    if (bg && bg !== 'FFFFFF') n.shade = bg;
    const fw = st.fontWeight;
    if (fw === 'bold' || Number(fw) >= 600) n.b = true;
    if (st.fontStyle === 'italic') n.i = true;
    const deco = `${st.textDecorationLine} ${st.textDecoration}`;
    if (/underline/.test(deco)) n.u = true;
    if (/line-through/.test(deco)) n.strike = true;
    const fs = st.fontSize;
    const base = f.size ?? this.baseHalfPts();
    const em = /^([\d.]+)em$/.exec(fs);
    const px = /^([\d.]+)px$/.exec(fs);
    if (em) n.size = Math.max(8, Math.round(base * Number(em[1])));
    else if (px) n.size = Math.max(8, Math.round(Number(px[1]) * 1.5));
    return n;
  }

  private domInlines(parent: Node, f: Fmt): string {
    let out = '';
    for (const c of parent.childNodes) out += this.domInline(c, f);
    return out;
  }

  private domInline(node: Node, f: Fmt): string {
    if (node.nodeType === Node.TEXT_NODE) return this.run((node.textContent ?? '').replace(/[\n\r\t]+/g, ' '), f);
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const el = node as HTMLElement;
    if (el.classList.contains('katex')) {
      const tex = el.querySelector('annotation[encoding="application/x-tex"]')?.textContent ?? el.textContent ?? '';
      return this.math(tex, false, f);
    }
    if (el.classList.contains('ex-spacer') || el.classList.contains('ed-ui')) return '';
    switch (el.tagName) {
      case 'BR': return '<w:r><w:br/></w:r>';
      case 'STRONG': case 'B': return this.domInlines(el, this.domFmt(el, { ...f, b: true }));
      case 'EM': case 'I': return this.domInlines(el, this.domFmt(el, { ...f, i: true }));
      case 'U': return this.domInlines(el, this.domFmt(el, { ...f, u: true }));
      case 'S': case 'DEL': case 'STRIKE': return this.domInlines(el, this.domFmt(el, { ...f, strike: true }));
      case 'SUP': return this.domInlines(el, { ...f, vert: 'superscript' });
      case 'SUB': return this.domInlines(el, { ...f, vert: 'subscript' });
      case 'CODE': return this.run(el.textContent ?? '', { ...f, code: true });
      case 'INPUT': return this.run((el as HTMLInputElement).checked ? '☑ ' : '☐ ', f);
      case 'IMG': return this.run('[image]', { ...f, i: true });
      case 'A': {
        const href = el.getAttribute('href') ?? '';
        if (!/^(https?:|mailto:)/i.test(href)) return this.domInlines(el, f);
        const id = `rId${this.relId++}`;
        this.rels.push(`<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${esc(href)}" TargetMode="External"/>`);
        return `<w:hyperlink r:id="${id}">${this.domInlines(el, { ...f, link: true })}</w:hyperlink>`;
      }
      default:
        return this.domInlines(el, this.domFmt(el, f));
    }
  }

  private picture(fig: HTMLElement): string {
    const src = this.picSrc.get(fig);
    const p = figData(fig);
    if (!src) return this.run('[picture]', { i: true });
    const n = this.media.length + 1;
    const name = `image${n}.${src.ext === 'jpeg' ? 'jpeg' : 'png'}`;
    this.media.push({ name, data: src.data });
    const rid = `rIdImg${n}`;
    this.rels.push(`<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${name}"/>`);
    const maxW = this.textWidth / TWIP_PER_MM;
    const wmm = Math.min(p.w, maxW);
    const cx = Math.round(wmm * 36000);
    const cy = Math.round(picHeight({ ...p, w: wmm }) * 36000);
    const id = this.drawId++;
    return (
      `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="Picture ${id}"/>` +
      '<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
      '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
      `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${id}" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr>` +
      `<pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
      `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>` +
      '</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>'
    );
  }

  private alignOf(el: HTMLElement, ctx: Ctx): Ctx {
    const a = (el.style.textAlign || el.getAttribute('align') || '').toLowerCase();
    if (a === 'center' || a === 'right' || a === 'justify' || a === 'left') return { ...ctx, align: a };
    if (a === 'end') return { ...ctx, align: 'right' };
    return ctx;
  }

  private domBlocks(parent: Element, ctx: Ctx, firstInItem = false): string[] {
    const out: string[] = [];
    let run: Node[] = [];
    let first = firstInItem;
    const flush = () => {
      const meaningful = run.some((n) => n.nodeType === Node.ELEMENT_NODE || (n.textContent ?? '').trim() !== '');
      if (meaningful) {
        const f: Fmt = { size: ctx.inTable ? this.cellHalfPts() : undefined };
        const content = run.map((n) => this.domInline(n, f)).join('');
        out.push(this.para(content, ctx, ctx.inTable ? 'TableText' : ctx.list ? 'ListParagraph' : null, '', first));
        first = false;
      }
      run = [];
    };
    for (const node of [...parent.childNodes]) {
      if (node.nodeType === Node.ELEMENT_NODE && isDomBlock(node as Element)) {
        flush();
        out.push(...this.domBlock(node as HTMLElement, ctx, first));
        first = false;
      } else run.push(node);
    }
    flush();
    return out;
  }

  private domBlock(el: HTMLElement, ctx: Ctx, firstInItem: boolean): string[] {
    const cellSize = ctx.inTable ? this.cellHalfPts() : undefined;
    const actx = this.alignOf(el, ctx);
    const tag = el.tagName;
    if (el.classList.contains('ex-spacer') || el.classList.contains('page-num') || el.classList.contains('fimg')) return [];
    if (el.classList.contains('blank-lines')) {
      const n = Math.max(1, Number(el.dataset.lines ?? '1') || 1);
      return Array.from({ length: n }, () => this.para('', ctx, ctx.list ? 'ListParagraph' : null, '<w:spacing w:before="0" w:after="0"/>'));
    }
    if (el.classList.contains('math-display') || el.classList.contains('katex-display')) {
      const tex = el.querySelector('annotation[encoding="application/x-tex"]')?.textContent ?? el.textContent ?? '';
      return [this.para(`<m:oMathPara><m:oMathParaPr><m:jc m:val="center"/></m:oMathParaPr>${this.math(tex, true, { size: cellSize })}</m:oMathPara>`, ctx, ctx.inTable ? 'TableText' : 'MathBlock', '', firstInItem)];
    }
    if (el.classList.contains('table-wrap')) {
      const t = el.querySelector('table');
      return t ? [this.domTable(t, ctx)] : [];
    }
    if (tag === 'FIGURE' && el.classList.contains('ed-fig')) {
      const al = el.dataset.align ?? 'center';
      const align = al.includes('right') ? 'right' : al.includes('left') ? 'left' : 'center';
      return [this.para(this.picture(el), { ...ctx, align }, null, '<w:spacing w:before="60" w:after="120"/>', firstInItem)];
    }
    switch (tag) {
      case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6':
        return [this.para(this.domInlines(el, this.domFmt(el, {})), actx, `Heading${tag[1]}`)];
      case 'UL': case 'OL':
        return this.domList(el, ctx);
      case 'BLOCKQUOTE':
        return this.domBlocks(el, { ...actx, quote: true }, firstInItem);
      case 'PRE': {
        const lines = (el.textContent ?? '').replace(/\n$/, '').split('\n');
        return lines.map((l, i) => this.para(this.run(l || ' ', {}), ctx, 'CodeBlock', i === 0 ? '' : '<w:spacing w:before="0"/>', firstInItem && i === 0));
      }
      case 'TABLE':
        return [this.domTable(el as HTMLTableElement, ctx)];
      case 'HR':
        if (el.classList.contains('page-break')) return ['<w:p><w:r><w:br w:type="page"/></w:r></w:p>'];
        return [this.para('', ctx, 'Rule')];
      case 'P':
        if ([...el.children].some((c) => isDomBlock(c))) return this.domBlocks(el, actx, firstInItem);
        return [this.para(this.domInlines(el, this.domFmt(el, { size: cellSize })), actx, ctx.inTable ? 'TableText' : ctx.list ? 'ListParagraph' : null, '', firstInItem)];
      default:
        // DIV, SECTION, li-run …
        return this.domBlocks(el, actx, firstInItem);
    }
  }

  private domList(el: HTMLElement, ctx: Ctx): string[] {
    const level = ctx.list ? Math.min(ctx.list.level + 1, 8) : 0;
    const ordered = el.tagName === 'OL';
    const numId = this.newNum(ordered, Number(el.getAttribute('start') ?? '1') || 1);
    const lctx: Ctx = { ...ctx, list: { numId, level }, indent: 360 * (level + 1) };
    const out: string[] = [];
    for (const li of el.children) {
      if (li.tagName !== 'LI') {
        if (isDomBlock(li)) out.push(...this.domBlock(li as HTMLElement, lctx, false));
        continue;
      }
      const kids = [...li.childNodes].filter((n) => n.nodeType === Node.ELEMENT_NODE || (n.textContent ?? '').trim());
      const firstEl = kids[0];
      if (!firstEl) {
        out.push(this.para('', lctx, 'ListParagraph', '', true));
        continue;
      }
      if (firstEl.nodeType === Node.ELEMENT_NODE && /^(UL|OL|TABLE)$/.test((firstEl as Element).tagName)) out.push(this.para('', lctx, 'ListParagraph', '', true));
      out.push(...this.domBlocks(li, this.alignOf(li as HTMLElement, lctx), true));
    }
    return out;
  }

  private domTable(t: HTMLTableElement, ctx: Ctx): string {
    const rows = [...t.querySelectorAll('tr')].filter((r) => r.closest('table') === t);
    if (!rows.length) return '';
    const cols = Math.max(1, ...rows.map((r) => r.cells.length));
    const avail = Math.max(1440, this.textWidth - (ctx.list ? ctx.indent : 0));
    const weights = Array.from({ length: cols }, (_, c) => {
      let max = 4;
      for (const r of rows) {
        const cell = r.cells[c];
        if (cell) max = Math.max(max, Math.min((cell.textContent ?? '').length, 60));
      }
      return Math.sqrt(max) + 1.5;
    });
    const total = weights.reduce((a, b) => a + b, 0);
    const widths = weights.map((w) => Math.floor((w / total) * avail));
    const grid = widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('');
    const border = (k: string) => `<w:${k} w:val="single" w:sz="4" w:space="0" w:color="BFC5CC"/>`;
    const tblPr =
      `<w:tblPr><w:tblStyle w:val="MdTable"/><w:tblW w:w="${avail}" w:type="dxa"/>` +
      (ctx.list ? `<w:tblInd w:w="${ctx.indent}" w:type="dxa"/>` : '') +
      `<w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(border).join('')}</w:tblBorders>` +
      '<w:tblLayout w:type="autofit"/><w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar>' +
      '<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="1" w:noVBand="1"/></w:tblPr>';
    const trs = rows
      .map((r) => {
        const header = r.parentElement?.tagName === 'THEAD' || (r.cells.length > 0 && [...r.cells].every((c) => c.tagName === 'TH'));
        const trPr = header ? '<w:trPr><w:tblHeader/><w:cantSplit/></w:trPr>' : '<w:trPr><w:cantSplit/></w:trPr>';
        let tcs = '';
        for (let c = 0; c < cols; c++) {
          const cell = r.cells[c] as HTMLElement | undefined;
          const cctx: Ctx = this.alignOf(cell ?? document.createElement('td'), { list: null, indent: 0, quote: false, inTable: true, align: null });
          let paras = cell ? this.domBlocks(cell, cctx) : [];
          if (header && cell) paras = [this.para(this.domInlines(cell, { b: true, size: this.cellHalfPts() }), cctx, 'TableText')];
          if (!paras.length) paras = [this.para('', cctx, 'TableText')];
          const tcPr = `<w:tcPr><w:tcW w:w="${widths[c]}" w:type="dxa"/>${header ? '<w:shd w:val="clear" w:color="auto" w:fill="F2F3F5"/>' : ''}<w:vAlign w:val="${header ? 'bottom' : 'center'}"/></w:tcPr>`;
          tcs += `<w:tc>${tcPr}${paras.join('')}</w:tc>`;
        }
        return `<w:tr>${trPr}${tcs}</w:tr>`;
      })
      .join('');
    return `<w:tbl>${tblPr}<w:tblGrid>${grid}</w:tblGrid>${trs}</w:tbl><w:p><w:pPr><w:pStyle w:val="TableGap"/></w:pPr></w:p>`;
  }

  private pack(): Promise<Blob> {
    const g = geometry(this.s);
    // Schema order: footerReference, pgSz, pgMar.
    const sectFixed =
      '<w:sectPr>' +
      (this.s.pageNumbers ? '<w:footerReference w:type="default" r:id="rIdFooter"/>' : '') +
      `<w:pgSz w:w="${tw(g.pageW)}" w:h="${tw(g.pageH)}"${this.s.landscape ? ' w:orient="landscape"' : ''}/>` +
      `<w:pgMar w:top="${tw(g.mt)}" w:right="${tw(g.mr)}" w:bottom="${tw(g.mb)}" w:left="${tw(g.ml)}" w:header="${tw(Math.min(g.mt, 12.7) / 2)}" w:footer="${tw(Math.min(g.mb, 12.7) / 2)}" w:gutter="0"/>` +
      '</w:sectPr>';

    const document =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body>${this.body.join('')}${sectFixed}</w:body></w:document>`;

    const zip = new JSZip();
    zip.file('[Content_Types].xml', CONTENT_TYPES(this.s.pageNumbers));
    for (const m of this.media) zip.file(`word/media/${m.name}`, m.data, { base64: true });
    zip.file('_rels/.rels', ROOT_RELS);
    zip.file('word/document.xml', document);
    zip.file('word/styles.xml', stylesXml(this.s));
    zip.file('word/numbering.xml', numberingXml(this.nums.join('')));
    zip.file('word/settings.xml', SETTINGS_XML);
    if (this.s.pageNumbers) zip.file('word/footer1.xml', FOOTER_XML);
    zip.file(
      'word/_rels/document.xml.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>' +
        '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>' +
        (this.s.pageNumbers ? '<Relationship Id="rIdFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>' : '') +
        this.rels.join('') +
        '</Relationships>',
    );
    zip.file('docProps/core.xml', CORE_XML());
    return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  }
}

function mdText(n: M.Node): string {
  if ('value' in n && typeof (n as M.Literal).value === 'string') return (n as M.Literal).value;
  if ('children' in n) return ((n as M.Parent).children as M.Node[]).map(mdText).join('');
  return '';
}

export async function markdownToDocx(src: string, s: Settings): Promise<Blob> {
  const root = parseMarkdown(src);
  return new DocxWriter(s).build(root);
}

/** .docx from the edited page document (a laid-out `.md` element). */
export async function htmlToDocx(root: HTMLElement, s: Settings): Promise<Blob> {
  return new DocxWriter(s).buildDom(root);
}

const DOM_BLOCK = /^(P|DIV|H[1-6]|UL|OL|TABLE|BLOCKQUOTE|PRE|HR|FIGURE|SECTION)$/;
function isDomBlock(el: Element): boolean {
  return DOM_BLOCK.test(el.tagName);
}

function hexColor(c: string): string | null {
  if (!c) return null;
  let m = /^#([0-9a-f]{3})$/i.exec(c);
  if (m) return m[1].split('').map((x) => x + x).join('').toUpperCase();
  m = /^#([0-9a-f]{6})$/i.exec(c);
  if (m) return m[1].toUpperCase();
  const r = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(c);
  if (r) {
    if (r[4] !== undefined && Number(r[4]) === 0) return null;
    return [r[1], r[2], r[3]].map((v) => Number(v).toString(16).padStart(2, '0')).join('').toUpperCase();
  }
  return null;
}

/* ---------------- static parts ---------------- */

const CONTENT_TYPES = (footer: boolean) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Default Extension="png" ContentType="image/png"/>' +
  '<Default Extension="jpeg" ContentType="image/jpeg"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
  '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
  '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>' +
  (footer ? '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' : '') +
  '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
  '</Types>';

const ROOT_RELS =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
  '</Relationships>';

const CORE_XML = () =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>Markdown export</dc:title><dc:creator>Markdown Render Studio</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</dcterms:created></cp:coreProperties>`;

const SETTINGS_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">` +
  '<w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/>' +
  '<m:mathPr><m:mathFont m:val="Cambria Math"/><m:brkBin m:val="before"/><m:brkBinSub m:val="--"/><m:smallFrac m:val="0"/><m:dispDef/><m:lMargin m:val="0"/><m:rMargin m:val="0"/><m:defJc m:val="centerGroup"/><m:wrapIndent m:val="1440"/><m:intLim m:val="subSup"/><m:naryLim m:val="undOvr"/></m:mathPr>' +
  '<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat>' +
  '</w:settings>';

const FOOTER_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:pStyle w:val="Footer"/><w:jc w:val="center"/></w:pPr>` +
  '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>' +
  '<w:r><w:t xml:space="preserve"> / </w:t></w:r>' +
  '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> NUMPAGES </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>' +
  '</w:p></w:ftr>';

function numberingXml(nums: string): string {
  const bullets = ['•', '◦', '▪', '•', '◦', '▪', '•', '◦', '▪'];
  const fmts = ['decimal', 'decimal', 'lowerLetter', 'lowerRoman', 'decimal', 'lowerLetter', 'lowerRoman', 'decimal', 'lowerLetter'];
  const lvl = (i: number, ordered: boolean) => {
    const left = 360 * (i + 1);
    return (
      `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${ordered ? fmts[i] : 'bullet'}"/>` +
      `<w:lvlText w:val="${ordered ? `%${i + 1}.` : bullets[i]}"/><w:lvlJc w:val="left"/>` +
      `<w:pPr><w:ind w:left="${left}" w:hanging="${ordered ? 300 : 240}"/></w:pPr>` +
      (ordered ? '' : `<w:rPr><w:rFonts w:ascii="Segoe UI" w:hAnsi="Segoe UI"/><w:color w:val="61666B"/></w:rPr>`) +
      '</w:lvl>'
    );
  };
  const abs = (id: number, ordered: boolean) =>
    `<w:abstractNum w:abstractNumId="${id}"><w:multiLevelType w:val="hybridMultilevel"/>${Array.from({ length: 9 }, (_, i) => lvl(i, ordered)).join('')}</w:abstractNum>`;
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    abs(1, false) +
    abs(2, true) +
    nums +
    '</w:numbering>'
  );
}

function stylesXml(s: Settings): string {
  const font = FONTS[s.font].word;
  const sz = Math.round(s.fontSize * 0.75 * 2); // half-points
  const line = Math.round(240 * 1.15 * s.lineSpacing);
  const h = (lvl: number, pt: number, before: number, after: number) =>
    `<w:style w:type="paragraph" w:styleId="Heading${lvl}"><w:name w:val="heading ${lvl}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>` +
    `<w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="${before}" w:after="${after}"/><w:outlineLvl w:val="${lvl - 1}"/></w:pPr>` +
    `<w:rPr><w:b/><w:bCs/><w:sz w:val="${Math.round(pt * 2)}"/><w:szCs w:val="${Math.round(pt * 2)}"/></w:rPr></w:style>`;
  const k = s.fontSize / 14;
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:eastAsia="${font}" w:cs="${font}"/><w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/><w:color w:val="0F1115"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault>` +
    `<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="${line}" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>` +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
    h(1, 21 * 0.75 * k, 480, 200) +
    h(2, 19 * 0.75 * k, 420, 180) +
    h(3, 18 * 0.75 * k, 360, 160) +
    h(4, 14 * 0.75 * k, 240, 120) +
    h(5, 14 * 0.75 * k, 240, 120) +
    h(6, 14 * 0.75 * k, 240, 120) +
    '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="40" w:after="40"/><w:contextualSpacing/></w:pPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="MathBlock"><w:name w:val="Math Block"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="80" w:after="80"/><w:jc w:val="center"/></w:pPr></w:style>' +
    `<w:style w:type="paragraph" w:styleId="TableText"><w:name w:val="Table Text"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="0" w:after="0" w:line="${Math.round(line * 0.98)}" w:lineRule="auto"/></w:pPr></w:style>` +
    '<w:style w:type="paragraph" w:styleId="TableGap"><w:name w:val="Table Gap"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="0" w:after="120" w:line="120" w:lineRule="exact"/></w:pPr><w:rPr><w:sz w:val="4"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="CodeBlock"><w:name w:val="Code Block"/><w:basedOn w:val="Normal"/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F3F4F6"/><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="18"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Rule"><w:name w:val="Horizontal Rule"/><w:basedOn w:val="Normal"/><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="4" w:space="1" w:color="D0D4D9"/></w:pBdr><w:spacing w:before="120" w:after="240" w:line="120" w:lineRule="exact"/></w:pPr><w:rPr><w:sz w:val="4"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Footnote"><w:name w:val="Footnote"/><w:basedOn w:val="Normal"/><w:rPr><w:sz w:val="18"/><w:color w:val="61666B"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Footer"><w:name w:val="footer"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0"/></w:pPr><w:rPr><w:sz w:val="16"/><w:color w:val="8A9099"/></w:rPr></w:style>' +
    '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="3964FE"/><w:u w:val="single"/></w:rPr></w:style>' +
    '<w:style w:type="character" w:styleId="InlineCode"><w:name w:val="Inline Code"/><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="18"/><w:shd w:val="clear" w:color="auto" w:fill="F3F4F6"/></w:rPr></w:style>' +
    '<w:style w:type="table" w:styleId="MdTable"><w:name w:val="Markdown Table"/><w:tblPr><w:tblCellMar><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>' +
    '</w:styles>'
  );
}
