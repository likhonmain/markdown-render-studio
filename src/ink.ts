// Pen / highlighter ink drawn on top of the pages (S Pen, Apple Pencil, mouse).
// Strokes are anchored to a page like fixed pictures: they stay where they were
// drawn and do not move with the text. Coordinates are millimetres from the
// page's top-left corner, so they survive zoom changes and print 1:1.

export type InkTool = 'pen' | 'hl' | 'eraser';

export interface InkStroke {
  id: string;
  page: number;
  tool: 'pen' | 'hl';
  color: string;
  w: number; // stroke width, mm
  pts: number[]; // flat [x0, y0, x1, y1, …] in mm
}

export interface InkPrefs {
  penColor: string;
  penW: number;
  hlColor: string;
  hlW: number;
  fingerDraws: boolean; // false: fingers scroll, only pen/mouse draws
}

const PREFS_KEY = 'mdstudio.ink.v1';
export const INK_DEFAULTS: InkPrefs = { penColor: '#1d3fcc', penW: 0.6, hlColor: '#ffe14d', hlW: 5, fingerDraws: false };
export const PEN_COLORS = ['#0f1115', '#1d3fcc', '#d92d20', '#2b8a3e', '#7048e8', '#e8590c'];
export const HL_COLORS = ['#ffe14d', '#8ce99a', '#74c0fc', '#ffa8d5', '#ffc078'];
export const PEN_WIDTHS = [0.35, 0.6, 1, 1.6];
export const HL_WIDTHS = [3, 5, 8];

export function loadInkPrefs(): InkPrefs {
  try {
    return { ...INK_DEFAULTS, ...(JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<InkPrefs>) };
  } catch {
    return { ...INK_DEFAULTS };
  }
}

export function saveInkPrefs(p: InkPrefs): void {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* ignore */ }
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Smooth path through the points (quadratic curves through segment midpoints). */
export function pathD(pts: number[]): string {
  const n = pts.length / 2;
  if (n === 0) return '';
  const f = (v: number) => v.toFixed(2);
  if (n === 1) return `M${f(pts[0])} ${f(pts[1])}l0.01 0`;
  if (n === 2) return `M${f(pts[0])} ${f(pts[1])}L${f(pts[2])} ${f(pts[3])}`;
  let d = `M${f(pts[0])} ${f(pts[1])}`;
  for (let i = 1; i < n - 1; i++) {
    const x = pts[i * 2];
    const y = pts[i * 2 + 1];
    const mx = (x + pts[i * 2 + 2]) / 2;
    const my = (y + pts[i * 2 + 3]) / 2;
    d += `Q${f(x)} ${f(y)} ${f(mx)} ${f(my)}`;
  }
  d += `L${f(pts[(n - 1) * 2])} ${f(pts[(n - 1) * 2 + 1])}`;
  return d;
}

export function strokePath(s: InkStroke): SVGPathElement {
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', pathD(s.pts));
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke', s.color);
  p.setAttribute('stroke-width', String(s.w));
  p.setAttribute('stroke-linecap', 'round');
  p.setAttribute('stroke-linejoin', 'round');
  p.setAttribute('class', s.tool === 'hl' ? 'ink-hl' : 'ink-pen');
  p.dataset.id = s.id;
  return p;
}

/** One SVG overlay per page (viewBox in mm), highlighter strokes under pen strokes. */
export function inkLayer(pageWmm: number, pageHmm: number, strokes: InkStroke[]): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'ink-layer');
  svg.setAttribute('viewBox', `0 0 ${pageWmm} ${pageHmm}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('contenteditable', 'false');
  svg.setAttribute('aria-hidden', 'true');
  const hl = document.createElementNS(SVG_NS, 'g');
  hl.setAttribute('class', 'ink-g-hl');
  const pen = document.createElementNS(SVG_NS, 'g');
  pen.setAttribute('class', 'ink-g-pen');
  svg.append(hl, pen);
  for (const s of strokes) (s.tool === 'hl' ? hl : pen).appendChild(strokePath(s));
  return svg;
}

function segDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  let t = len > 0 ? ((px - ax) * dx + (py - ay) * dy) / len : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx - px;
  const cy = ay + t * dy - py;
  return cx * cx + cy * cy;
}

/** Whether the eraser circle (x, y, r in mm) touches the stroke. */
export function hitStroke(s: InkStroke, x: number, y: number, r: number): boolean {
  const lim = r + s.w / 2;
  const lim2 = lim * lim;
  const p = s.pts;
  if (p.length === 2) return (p[0] - x) ** 2 + (p[1] - y) ** 2 <= lim2;
  for (let i = 0; i + 3 < p.length; i += 2) {
    if (segDist2(x, y, p[i], p[i + 1], p[i + 2], p[i + 3]) <= lim2) return true;
  }
  return false;
}

/** Drops points closer than `min` mm to the previous one (keeps files small). */
export function simplify(pts: number[], min = 0.15): number[] {
  if (pts.length <= 4) return pts;
  const out = [pts[0], pts[1]];
  for (let i = 2; i < pts.length - 2; i += 2) {
    const lx = out[out.length - 2];
    const ly = out[out.length - 1];
    if ((pts[i] - lx) ** 2 + (pts[i + 1] - ly) ** 2 >= min * min) out.push(pts[i], pts[i + 1]);
  }
  out.push(pts[pts.length - 2], pts[pts.length - 1]);
  return out.map((v) => Math.round(v * 100) / 100);
}
