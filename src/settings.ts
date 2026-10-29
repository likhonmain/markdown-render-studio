export type PaperId = 'A4' | 'Letter' | 'Legal' | 'A5' | 'A3' | 'Custom';
export type FontId = 'dsh' | 'calibri' | 'arial' | 'serif' | 'georgia';

export interface Margins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface Settings {
  view: 'flow' | 'pages';
  zoom: number; // 1 = 100 %
  zoomMode: 'width' | 'page' | 'custom';
  flowFull: boolean; // flow view: full window width instead of a reading column
  paper: PaperId;
  customW: number; // mm
  customH: number; // mm
  landscape: boolean;
  margins: Margins; // mm
  linkMargins: boolean;
  font: FontId;
  fontSize: number; // px (DSH default 14)
  lineSpacing: number; // multiplier on DSH line heights
  tableStyle: 'minimal' | 'grid';
  fitTables: boolean;
  fitMath: boolean;
  pageNumbers: boolean;
  guides: boolean;
  editorOpen: boolean;
  setupOpen: boolean;
  editorWidth: number; // px
  editMode: boolean; // the rendered page can be edited directly
}

export const PAPERS: Record<Exclude<PaperId, 'Custom'>, [number, number]> = {
  A4: [210, 297],
  Letter: [215.9, 279.4],
  Legal: [215.9, 355.6],
  A5: [148, 210],
  A3: [297, 420],
};

export const MARGIN_PRESETS: Record<string, Margins> = {
  Normal: { top: 25.4, right: 25.4, bottom: 25.4, left: 25.4 },
  Moderate: { top: 25.4, right: 19.1, bottom: 25.4, left: 19.1 },
  Narrow: { top: 12.7, right: 12.7, bottom: 12.7, left: 12.7 },
  Compact: { top: 8, right: 8, bottom: 8, left: 8 },
  Wide: { top: 25.4, right: 50.8, bottom: 25.4, left: 50.8 },
  None: { top: 0, right: 0, bottom: 0, left: 0 },
};

export const FONTS: Record<FontId, { label: string; css: string; word: string }> = {
  dsh: {
    label: 'DeepSeek Harness (Segoe UI)',
    css: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif',
    word: 'Segoe UI',
  },
  calibri: { label: 'Calibri (Word default)', css: 'Calibri, Carlito, "Segoe UI", Arial, sans-serif', word: 'Calibri' },
  arial: { label: 'Arial / Helvetica', css: 'Arial, Helvetica, "Liberation Sans", sans-serif', word: 'Arial' },
  serif: { label: 'Times New Roman', css: '"Times New Roman", Times, "Liberation Serif", serif', word: 'Times New Roman' },
  georgia: { label: 'Georgia', css: 'Georgia, Cambria, "Times New Roman", serif', word: 'Georgia' },
};

export const DEFAULTS: Settings = {
  view: 'pages',
  zoom: 1,
  zoomMode: 'width',
  flowFull: false,
  paper: 'A4',
  customW: 210,
  customH: 297,
  landscape: false,
  margins: { ...MARGIN_PRESETS.Narrow },
  linkMargins: true,
  font: 'dsh',
  fontSize: 14,
  lineSpacing: 1,
  tableStyle: 'minimal',
  fitTables: true,
  fitMath: true,
  pageNumbers: true,
  guides: false,
  editorOpen: true,
  setupOpen: true,
  editorWidth: 0,
  editMode: true,
};

const KEY = 'mdstudio.settings.v1';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULTS);
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return { ...structuredClone(DEFAULTS), ...parsed, margins: { ...DEFAULTS.margins, ...(parsed.margins ?? {}) } };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage full or disabled */
  }
}

/** Page size in mm, orientation applied. */
export function pageSize(s: Settings): [number, number] {
  const [w, h] = s.paper === 'Custom' ? [s.customW, s.customH] : PAPERS[s.paper];
  return s.landscape ? [Math.max(w, h), Math.min(w, h)] : [Math.min(w, h), Math.max(w, h)];
}

export interface Geometry {
  pageW: number;
  pageH: number;
  mt: number;
  mr: number;
  mb: number;
  ml: number;
}

export function geometry(s: Settings): Geometry {
  const [pageW, pageH] = pageSize(s);
  const clamp = (v: number, max: number) => Math.min(Math.max(0, Number.isFinite(v) ? v : 0), max);
  const ml = clamp(s.margins.left, pageW * 0.4);
  const mr = clamp(s.margins.right, pageW * 0.4);
  const mt = clamp(s.margins.top, pageH * 0.4);
  const mb = clamp(s.margins.bottom, pageH * 0.4);
  return { pageW, pageH, mt, mr, mb, ml };
}

export const MM_PX = 96 / 25.4;
