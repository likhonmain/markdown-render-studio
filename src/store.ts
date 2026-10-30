// Persistence for the edited page document, picture files, and multi-session
// workspace management (including native .mdstudio.json session export/import).
// IndexedDB holds everything; a synchronous localStorage mirror of the active
// session (without picture blobs) survives even a crash before async writes finish.
import type { Settings } from './settings';
import type { InkStroke } from './ink';

/** Crop rectangle as fractions of the original picture: x, y, width, height. */
export type Crop = [number, number, number, number];

export interface FloatImg {
  id: string;
  img: string; // picture id in the image store
  nw: number; // natural pixel size of the stored picture
  nh: number;
  crop: Crop;
  page: number; // 0-based page index
  x: number; // mm from the page's top-left corner
  y: number;
  w: number; // mm
  wrap: 'push' | 'front'; // push text out of its way, or sit in front of the text
}

export interface EditDoc {
  v: 1;
  dirty: boolean; // the page has been edited: `html` is the source of truth
  html: string; // the document flow (unpaginated)
  mdBase: string; // the Markdown mirror of the page (kept in sync with page edits)
  mdOrig?: string; // the Markdown before the first page edit (for "Discard page edits")
  floats: FloatImg[];
  ink?: InkStroke[]; // pen / highlighter strokes, anchored to pages
  updated: number;
}

export interface SessionMeta {
  id: string;
  name: string;
  updated: number;
  edited: boolean;
  picCount: number;
}

export interface SessionRecord {
  id: string;
  name: string;
  updated: number;
  markdown: string;
  doc: EditDoc;
  settings: Partial<Settings>;
  scrollRatio: number;
}

export interface SessionExportImage {
  nw: number;
  nh: number;
  dataUrl: string;
}

export interface SessionExportFile {
  magic: 'mdstudio-session';
  version: 1;
  id: string;
  name: string;
  exportedAt: number;
  markdown: string;
  settings: Partial<Settings>;
  doc: EditDoc;
  scrollRatio: number;
  images: Record<string, SessionExportImage>;
}

export const emptyDoc = (): EditDoc => ({ v: 1, dirty: false, html: '', mdBase: '', floats: [], ink: [], updated: 0 });

const DB_NAME = 'mdstudio';
const LS_KEY = 'mdstudio.doc.v1';
const ACTIVE_ID_KEY = 'mdstudio.session.active.v1';
const ACTIVE_NAME_KEY = 'mdstudio.session.name.v1';
const SCROLL_KEY = 'mdstudio.scroll.v1';
let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
      if (!d.objectStoreNames.contains('images')) d.createObjectStore('images');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function store(name: 'kv' | 'images', mode: IDBTransactionMode): Promise<IDBObjectStore> {
  return (await db()).transaction(name, mode).objectStore(name);
}

/* ------------------------------------------------------------------ */
/* Active session metadata & scroll position                           */
/* ------------------------------------------------------------------ */

export function getActiveSessionId(): string {
  try {
    return localStorage.getItem(ACTIVE_ID_KEY) || 'default';
  } catch {
    return 'default';
  }
}

export function setActiveSessionId(id: string): void {
  try { localStorage.setItem(ACTIVE_ID_KEY, id); } catch { /* ignore */ }
}

export function getActiveSessionName(): string {
  try {
    return localStorage.getItem(ACTIVE_NAME_KEY) || '';
  } catch {
    return '';
  }
}

export function setActiveSessionName(name: string): void {
  try { localStorage.setItem(ACTIVE_NAME_KEY, name); } catch { /* ignore */ }
}

export function getSavedScrollRatio(): number {
  try {
    const n = Number(localStorage.getItem(SCROLL_KEY));
    return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0;
  } catch {
    return 0;
  }
}

export function saveScrollRatio(ratio: number): void {
  try {
    const r = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
    localStorage.setItem(SCROLL_KEY, r.toFixed(5));
  } catch { /* ignore */ }
}

/* ------------------------------------------------------------------ */
/* Document                                                            */
/* ------------------------------------------------------------------ */

function valid(d: unknown): d is EditDoc {
  return !!d && typeof d === 'object' && (d as EditDoc).v === 1 && typeof (d as EditDoc).html === 'string' && Array.isArray((d as EditDoc).floats);
}

export async function loadDoc(): Promise<EditDoc> {
  let fromLs: EditDoc | null = null;
  try {
    const raw = localStorage.getItem(LS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (valid(parsed)) fromLs = parsed;
  } catch { /* ignore */ }
  let fromDb: EditDoc | null = null;
  try {
    const d = await req((await store('kv', 'readonly')).get('doc'));
    if (valid(d)) fromDb = d;
  } catch { /* IndexedDB unavailable */ }
  const best = [fromLs, fromDb].filter(Boolean).sort((a, b) => b!.updated - a!.updated)[0];
  return best ? { ...emptyDoc(), ...best } : emptyDoc();
}

let lsFailed = false;
export async function saveDoc(doc: EditDoc): Promise<void> {
  doc.updated = Date.now();
  const json = JSON.stringify(doc);
  try {
    localStorage.setItem(LS_KEY, json);
    lsFailed = false;
  } catch {
    // Too big for localStorage: IndexedDB alone keeps it.
    if (!lsFailed) try { localStorage.removeItem(LS_KEY); } catch { /* ignore */ }
    lsFailed = true;
  }
  try {
    await req((await store('kv', 'readwrite')).put(JSON.parse(json), 'doc'));
  } catch (err) {
    if (lsFailed) throw err;
  }
}

/* ------------------------------------------------------------------ */
/* Pictures                                                            */
/* ------------------------------------------------------------------ */

interface ImgRecord {
  blob: Blob;
  nw: number;
  nh: number;
}

const cache = new Map<string, { url: string; nw: number; nh: number; blob: Blob }>();

export function imageUrl(id: string): string | undefined {
  return cache.get(id)?.url;
}

export function imageBlob(id: string): Blob | undefined {
  return cache.get(id)?.blob;
}

export async function putImage(blob: Blob, nw: number, nh: number): Promise<string> {
  const id = `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  await putImageWithId(id, blob, nw, nh);
  return id;
}

export async function putImageWithId(id: string, blob: Blob, nw: number, nh: number): Promise<void> {
  const prev = cache.get(id);
  if (prev) URL.revokeObjectURL(prev.url);
  cache.set(id, { url: URL.createObjectURL(blob), nw, nh, blob });
  try {
    await req((await store('images', 'readwrite')).put({ blob, nw, nh } satisfies ImgRecord, id));
  } catch { /* keep in-memory cache even if IDB fails */ }
}

export async function loadImages(ids: Iterable<string>): Promise<void> {
  const want = [...new Set(ids)].filter((id) => !cache.has(id));
  if (!want.length) return;
  try {
    const s = await store('images', 'readonly');
    const recs = await Promise.all(want.map((id) => req(s.get(id) as IDBRequest<ImgRecord | undefined>)));
    recs.forEach((r, i) => {
      if (r?.blob) cache.set(want[i], { url: URL.createObjectURL(r.blob), nw: r.nw, nh: r.nh, blob: r.blob });
    });
  } catch { /* missing pictures show as placeholders */ }
}

async function getImageRecord(id: string): Promise<ImgRecord | null> {
  const mem = cache.get(id);
  if (mem) return { blob: mem.blob, nw: mem.nw, nh: mem.nh };
  try {
    const s = await store('images', 'readonly');
    const r = await req(s.get(id) as IDBRequest<ImgRecord | undefined>);
    if (r?.blob) {
      cache.set(id, { url: URL.createObjectURL(r.blob), nw: r.nw, nh: r.nh, blob: r.blob });
      return r;
    }
  } catch { /* ignore */ }
  return null;
}

export function docImageIds(doc: EditDoc): string[] {
  const inlineIds = [...doc.html.matchAll(/data-img="([^"]+)"/g)].map((m) => m[1]);
  const floatIds = doc.floats.map((f) => f.img);
  return [...new Set([...inlineIds, ...floatIds])];
}

/** Deletes stored pictures that no saved session (and not the active doc) refers to. */
export async function gcImages(keep: Set<string>): Promise<void> {
  try {
    const allKeep = new Set(keep);
    const kv = await store('kv', 'readonly');
    const keys = (await req(kv.getAllKeys())) as string[];
    const sessionKeys = keys.filter((k) => typeof k === 'string' && k.startsWith('session:'));
    const recs = await Promise.all(sessionKeys.map((k) => req(kv.get(k) as IDBRequest<SessionRecord | undefined>)));
    for (const r of recs) {
      if (r?.doc && valid(r.doc)) {
        for (const id of docImageIds(r.doc)) allKeep.add(id);
      }
      for (const m of (r?.markdown ?? '').matchAll(/"img":"([\w-]+)"/g)) allKeep.add(m[1]);
    }
    const s = await store('images', 'readwrite');
    const imgKeys = (await req(s.getAllKeys())) as string[];
    for (const k of imgKeys) if (!allKeep.has(k)) s.delete(k);
  } catch { /* ignore */ }
}

/** Reads a picture file, downscaling very large photos (keeps PDFs small and editing fast). */
export async function readImageFile(file: Blob): Promise<{ blob: Blob; nw: number; nh: number }> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const w = img.naturalWidth || 800;
    const h = img.naturalHeight || 600;
    const MAX = 2400;
    const scale = Math.min(1, MAX / Math.max(w, h));
    const keep = scale === 1 && file.size < 4_000_000 && /^image\/(png|jpeg|webp|gif)$/.test(file.type);
    if (keep) return { blob: file, nw: w, nh: h };
    const cw = Math.max(1, Math.round(w * scale));
    const ch = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d')!;
    const png = file.type === 'image/png' || file.type === 'image/svg+xml' || file.type === 'image/gif';
    if (!png) {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, cw, ch);
    }
    ctx.drawImage(img, 0, 0, cw, ch);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, png ? 'image/png' : 'image/jpeg', 0.9));
    if (!blob) throw new Error('Could not process the picture');
    return { blob, nw: cw, nh: ch };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** A cropped copy of a stored picture as a data URL (for Word export). */
export async function croppedDataUrl(id: string, crop: Crop, maxW = 1600): Promise<string | null> {
  const rec = cache.get(id);
  if (!rec) return null;
  const img = new Image();
  img.src = rec.url;
  try { await img.decode(); } catch { return null; }
  const sx = crop[0] * rec.nw;
  const sy = crop[1] * rec.nh;
  const sw = crop[2] * rec.nw;
  const sh = crop[3] * rec.nh;
  const scale = Math.min(1, maxW / sw);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sw * scale));
  canvas.height = Math.max(1, Math.round(sh * scale));
  canvas.getContext('2d')!.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL(rec.blob.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.9);
}

/* ------------------------------------------------------------------ */
/* Multi-session storage & Native Session Export / Import              */
/* ------------------------------------------------------------------ */

export function newSessionId(): string {
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function deriveSessionName(markdown: string, doc: EditDoc, customName?: string): string {
  const trimmed = (customName ?? '').trim();
  if (trimmed) return trimmed.slice(0, 80);
  if (doc.dirty && doc.html) {
    const tmp = document.createElement('div');
    tmp.innerHTML = doc.html;
    const h = tmp.querySelector('h1, h2, h3, h4, p, li')?.textContent?.trim();
    if (h) return h.replace(/\s+/g, ' ').slice(0, 60);
  }
  const m = /^\s*#{1,6}\s+(.+)$/m.exec(markdown) ?? /^\s*\*\*(.+?)\*\*/m.exec(markdown) ?? /^\s*(\S.+)$/m.exec(markdown);
  if (m?.[1]) {
    const clean = m[1].replace(/[$*_`#\\]/g, '').replace(/\s+/g, ' ').trim();
    if (clean) return clean.slice(0, 60);
  }
  return 'Untitled session';
}

function metaOf(r: SessionRecord): SessionMeta {
  const pics = docImageIds(r.doc).length;
  return {
    id: r.id,
    name: deriveSessionName(r.markdown, r.doc, r.name),
    updated: r.updated || Date.now(),
    edited: !!(r.doc.dirty || r.doc.floats.length > 0 || (r.doc.ink?.length ?? 0) > 0),
    picCount: pics,
  };
}

export async function saveSessionRecord(rec: SessionRecord): Promise<void> {
  rec.updated = Date.now();
  try {
    const s = await store('kv', 'readwrite');
    await req(s.put(JSON.parse(JSON.stringify(rec)), `session:${rec.id}`));
  } catch { /* ignore if IDB unavailable */ }
}

export async function loadSessionRecord(id: string): Promise<SessionRecord | null> {
  try {
    const s = await store('kv', 'readonly');
    const r = await req(s.get(`session:${id}`) as IDBRequest<SessionRecord | undefined>);
    if (r && typeof r === 'object' && typeof r.id === 'string' && valid(r.doc)) return r;
  } catch { /* ignore */ }
  return null;
}

export async function listSessions(): Promise<SessionMeta[]> {
  try {
    const s = await store('kv', 'readonly');
    const keys = (await req(s.getAllKeys())) as string[];
    const sessionKeys = keys.filter((k) => typeof k === 'string' && k.startsWith('session:'));
    const recs = await Promise.all(sessionKeys.map((k) => req(s.get(k) as IDBRequest<SessionRecord | undefined>)));
    return recs
      .filter((r): r is SessionRecord => !!r && typeof r === 'object' && typeof r.id === 'string' && valid(r.doc))
      .map(metaOf)
      .sort((a, b) => b.updated - a.updated);
  } catch {
    return [];
  }
}

export async function deleteSessionRecord(id: string): Promise<void> {
  try {
    const s = await store('kv', 'readwrite');
    await req(s.delete(`session:${id}`));
  } catch { /* ignore */ }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
  if (!m) throw new Error('Invalid image data URL');
  const mime = m[1] || 'image/png';
  const b64 = m[3];
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/** Packages a complete session (Markdown, page edits, settings, scroll, and all pictures) for export. */
export async function buildSessionExport(rec: SessionRecord): Promise<SessionExportFile> {
  const ids = [...new Set([...docImageIds(rec.doc), ...[...rec.markdown.matchAll(/"img":"([\w-]+)"/g)].map((m) => m[1])])];
  await loadImages(ids);
  const images: Record<string, SessionExportImage> = {};
  for (const id of ids) {
    const img = await getImageRecord(id);
    if (!img) continue;
    images[id] = {
      nw: img.nw,
      nh: img.nh,
      dataUrl: await blobToDataUrl(img.blob),
    };
  }
  return {
    magic: 'mdstudio-session',
    version: 1,
    id: rec.id,
    name: deriveSessionName(rec.markdown, rec.doc, rec.name),
    exportedAt: Date.now(),
    markdown: rec.markdown,
    settings: rec.settings,
    doc: rec.doc,
    scrollRatio: rec.scrollRatio ?? 0,
    images,
  };
}

export function isSessionJson(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith('{') && t.includes('"mdstudio-session"');
}

/** Restores a session from an exported `.mdstudio.json` file, saving its pictures and session record. */
export async function importSessionJson(text: string): Promise<SessionRecord> {
  let parsed: Partial<SessionExportFile>;
  try {
    parsed = JSON.parse(text) as Partial<SessionExportFile>;
  } catch {
    throw new Error('The file is not valid JSON');
  }
  if (parsed?.magic !== 'mdstudio-session' || !parsed.doc || !valid(parsed.doc)) {
    throw new Error('This file is not a valid Markdown Render Studio session');
  }
  const images = parsed.images ?? {};
  for (const [id, info] of Object.entries(images)) {
    if (!info?.dataUrl) continue;
    const blob = await dataUrlToBlob(info.dataUrl);
    await putImageWithId(id, blob, Number(info.nw) || 800, Number(info.nh) || 600);
  }
  const doc: EditDoc = {
    v: 1,
    dirty: !!parsed.doc.dirty,
    html: String(parsed.doc.html ?? ''),
    mdBase: String(parsed.doc.mdBase ?? ''),
    mdOrig: typeof parsed.doc.mdOrig === 'string' ? parsed.doc.mdOrig : undefined,
    floats: Array.isArray(parsed.doc.floats) ? parsed.doc.floats : [],
    ink: Array.isArray(parsed.doc.ink) ? parsed.doc.ink : [],
    updated: Date.now(),
  };
  const rec: SessionRecord = {
    id: typeof parsed.id === 'string' && parsed.id ? parsed.id : newSessionId(),
    name: typeof parsed.name === 'string' ? parsed.name : '',
    updated: Date.now(),
    markdown: typeof parsed.markdown === 'string' ? parsed.markdown : '',
    doc,
    settings: parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : {},
    scrollRatio: Number.isFinite(parsed.scrollRatio) ? Number(parsed.scrollRatio) : 0,
  };
  await saveSessionRecord(rec);
  return rec;
}
