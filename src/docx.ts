// Native .docx export: walks the Markdown AST and writes WordprocessingML with
// real Word lists, tables (fit to page width) and OMML equations.
import JSZip from 'jszip';
import type * as M from 'mdast';
import { parseMarkdown, texToMathML } from './markdown';
import { mathmlToOmml } from './omml';
import { FONTS, geometry, type Settings } from './settings';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

const TWIP_PER_MM = 1440 / 25.4;
const tw = (mm: number) => Math.round(mm * TWIP_PER_MM);

interface Fmt {
  b?: boolean;
  i?: boolean;
  strike?: boolean;
  code?: boolean;
  link?: boolean;
  size?: number; // half-points override
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
  align?: 'left' | 'center' | 'right' | null;
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
    if (f.size) rpr += `<w:sz w:val="${f.size}"/><w:szCs w:val="${f.size}"/>`;
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
    if (ctx.align && ctx.align !== 'left') p += `<w:jc w:val="${ctx.align === 'center' ? 'center' : 'right'}"/>`;
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
    const g = geometry(this.s);
    // Schema order: footerReference, pgSz, pgMar.
    const sectFixed =
      '<w:sectPr>' +
      (this.s.pageNumbers ? '<w:footerReference w:type="default" r:id="rIdFooter"/>' : '') +
      `<w:pgSz w:w="${tw(g.pageW)}" w:h="${tw(g.pageH)}"${this.s.landscape ? ' w:orient="landscape"' : ''}/>` +
      `<w:pgMar w:top="${tw(g.mt)}" w:right="${tw(g.mr)}" w:bottom="${tw(g.mb)}" w:left="${tw(g.ml)}" w:header="${tw(Math.min(g.mt, 12.7) / 2)}" w:footer="${tw(Math.min(g.mb, 12.7) / 2)}" w:gutter="0"/>` +
      '</w:sectPr>';

    const document =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><w:body>${this.body.join('')}${sectFixed}</w:body></w:document>`;

    const zip = new JSZip();
    zip.file('[Content_Types].xml', CONTENT_TYPES(this.s.pageNumbers));
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

/* ---------------- static parts ---------------- */

const CONTENT_TYPES = (footer: boolean) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
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
