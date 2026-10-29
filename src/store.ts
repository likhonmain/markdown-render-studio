// Persistence for the edited page document: the document itself (HTML flow +
// pictures fixed to pages) and the picture files. IndexedDB holds everything;
// a synchronous localStorage mirror of the document (without the picture data)
// survives even a crash that happens before an asynchronous write finishes.

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
  mdBase: string; // the Markdown the page edits started from
  floats: FloatImg[];
  updated: number;
}

export const emptyDoc = (): EditDoc => ({ v: 1, dirty: false, html: '', mdBase: '', floats: [], updated: 0 });

const DB_NAME = 'mdstudio';
const LS_KEY = 'mdstudio.doc.v1';
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
  cache.set(id, { url: URL.createObjectURL(blob), nw, nh, blob });
  await req((await store('images', 'readwrite')).put({ blob, nw, nh } satisfies ImgRecord, id));
  return id;
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

/** Deletes stored pictures that nothing refers to any more. */
export async function gcImages(keep: Set<string>): Promise<void> {
  try {
    const s = await store('images', 'readwrite');
    const keys = (await req(s.getAllKeys())) as string[];
    for (const k of keys) if (!keep.has(k)) s.delete(k);
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
