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

/* ------------------------------------------------------------------ */
/* Stylus side-button latch (modelled on xnotes StylusButtons.kt)      */
/* ------------------------------------------------------------------ */

/** Barrel (2), secondary/middle barrel (4), and eraser tip/tail (32) button bits. */
export const STYLUS_BTN_MASK = 2 | 4 | 32;

export function isStylusEvent(e: { pointerType?: string }): boolean {
  return e.pointerType === 'pen' || e.pointerType === 'eraser';
}

export function isSideButtonCode(button: number): boolean {
  return button === 2 || button === 5 || button === 1;
}

/**
 * True when a pointer event carries a stylus side-button signal (either via standard barrel/eraser
 * button bits 2/4/32, or on Samsung Galaxy Tab S9 where holding the S Pen button in the air fires
 * `pointerdown` / `pointermove` with `pressure === 0` and `buttons !== 0`).
 */
export function isPenSideButtonRaw(e: PointerEvent): boolean {
  if (e.pointerType === 'eraser') return true;
  if (isStylusEvent(e)) {
    if ((e.buttons & STYLUS_BTN_MASK) !== 0) return true;
    if (e.type === 'pointerdown' && isSideButtonCode(e.button)) return true;
    // Physical S Pen tip contact on the screen always has `pressure > 0`. In the air (`pressure === 0`),
    // `buttons !== 0` (or `pointerdown`) only occurs when the S Pen side button is pressed.
    if (
      e.pressure === 0 &&
      (e.buttons !== 0 || e.type === 'pointerdown') &&
      e.type !== 'pointerup' &&
      e.type !== 'pointercancel' &&
      e.type !== 'pointerout' &&
      e.type !== 'pointerleave'
    ) {
      return true;
    }
  }
  if (e.pointerType === 'mouse') {
    return (e.buttons & (2 | 32)) !== 0 || (e.type === 'pointerdown' && (e.button === 2 || e.button === 5));
  }
  return false;
}

export function isStylusHoverOnly(e: PointerEvent): boolean {
  return isStylusEvent(e) && e.pressure === 0 && e.buttons === 0;
}

export function isStylusButtonKey(e: KeyboardEvent): boolean {
  const k = e.key || '';
  const c = e.code || '';
  return k === 'F21' || c === 'F21' || /^StylusButton/i.test(k) || /^StylusButton/i.test(c);
}

/**
 * Tracks whether the stylus side button (or mouse right-button override) is currently held across
 * all browser delivery routes on Android / Samsung Galaxy Tab S9 (Chrome & Samsung Internet),
 * both while hovering in the air (`pressure === 0`) and while touching the screen (`pressure > 0`).
 */
export class StylusButtonLatch {
  private motionHeld = false;
  private keyHeld = false;
  private airLatched = false; // button press began in the air (`pressure === 0`)
  private hoverGraceUntil = 0; // bridges the hover-exit -> screen-touch transition gap
  private contactLatched = false; // keeps button latched when transitioning from air hold to screen touch
  private contactSawBit = false; // true once screen contact reported explicit bit 2/4/32
  private inContact = false;
  private zeroMoveCount = 0;
  private releaseTimer = 0;
  private lastEv: Event | null = null;

  constructor(private onChange?: () => void) {}

  /** Whether the side button is currently held (for toolbar highlight & tool override). */
  get held(): boolean {
    return this.motionHeld || this.keyHeld || this.airLatched || this.contactLatched || performance.now() < this.hoverGraceUntil;
  }

  private notify(prev: boolean): void {
    if (this.held !== prev) this.onChange?.();
  }

  private armReleaseTimer(ms: number): void {
    clearTimeout(this.releaseTimer);
    this.releaseTimer = window.setTimeout(() => {
      this.releaseTimer = 0;
      if (!this.contactLatched) {
        this.motionHeld = false;
        this.airLatched = false;
      }
      this.hoverGraceUntil = 0;
      this.onChange?.();
    }, ms);
  }

  /** Observe any window-level pointer event (in the air or on the screen) to keep button state fresh. */
  onPointer(e: PointerEvent): void {
    if (e === this.lastEv) return;
    this.lastEv = e;
    const stylus = isStylusEvent(e);
    if (!stylus && e.pointerType !== 'mouse') return;

    const prev = this.held;
    const now = performance.now();
    const explicitBit =
      e.pointerType === 'eraser' ||
      (stylus && ((e.buttons & STYLUS_BTN_MASK) !== 0 || (e.type === 'pointerdown' && isSideButtonCode(e.button)))) ||
      (e.pointerType === 'mouse' && ((e.buttons & (2 | 32)) !== 0 || (e.type === 'pointerdown' && (e.button === 2 || e.button === 5))));
    const rawBtn = explicitBit || isPenSideButtonRaw(e);

    // 1. Stylus in the air (`pressure === 0`):
    if (stylus && e.pressure === 0) {
      if (rawBtn && e.type !== 'pointerup' && e.type !== 'pointercancel' && e.type !== 'pointerout' && e.type !== 'pointerleave') {
        clearTimeout(this.releaseTimer);
        this.releaseTimer = 0;
        this.zeroMoveCount = 0;
        this.motionHeld = true;
        this.airLatched = true;
        this.hoverGraceUntil = now + 220;
      } else if (e.type === 'pointermove' && e.buttons === 0) {
        // Button released while hovering in the air: bridge 1-3 transitional hover frames right
        // before screen contact, then clear once genuinely hovering idle.
        this.zeroMoveCount++;
        if (this.zeroMoveCount >= 4 || !this.airLatched) {
          clearTimeout(this.releaseTimer);
          this.releaseTimer = 0;
          this.motionHeld = false;
          this.airLatched = false;
          this.contactLatched = false;
          this.inContact = false;
          this.hoverGraceUntil = 0;
        } else if (this.motionHeld || this.airLatched) {
          this.motionHeld = false;
          this.hoverGraceUntil = Math.min(this.hoverGraceUntil || now + 90, now + 90);
          this.armReleaseTimer(95);
        }
      } else if (e.type === 'pointerup' || e.type === 'pointercancel') {
        if (this.inContact) {
          // Physical screen contact lifted OR Samsung One UI split a button-held screen drag into
          // 200ms segments (`id: 96 b:5 bs:32` -> 33ms gap -> `id: 97 b:0 bs:1 pr:0.25` -> ...).
          // If this contact was erasing via the side button, keep a 95ms bridge so the next segment
          // (arriving ~20-46ms later with `pressure > 0`) continues erasing seamlessly, while a real
          // lift (followed by idle hover `buttons === 0, pressure === 0`) clears immediately!
          const wasErasingContact = this.contactLatched || this.motionHeld || this.airLatched;
          this.inContact = false;
          this.contactLatched = false;
          this.contactSawBit = false;
          this.airLatched = false;
          this.motionHeld = (e.buttons & STYLUS_BTN_MASK) !== 0;
          if (wasErasingContact && !this.motionHeld) {
            this.hoverGraceUntil = now + 95;
            this.armReleaseTimer(100);
          } else {
            clearTimeout(this.releaseTimer);
            this.releaseTimer = 0;
            this.hoverGraceUntil = 0;
          }
        } else if (this.motionHeld || this.airLatched || now < this.hoverGraceUntil) {
          // Air stream ended (either user released button in air, or pen is touching down onto glass):
          // keep a brief 180ms bridge so if the pen is touching down onto the screen, screen contact latches it!
          this.motionHeld = false;
          this.hoverGraceUntil = now + 180;
          this.armReleaseTimer(185);
        }
      }
      this.notify(prev);
      return;
    }

    // 2. Active screen contact (`pressure > 0` on stylus, or mouse):
    this.zeroMoveCount = 0;
    if (e.type === 'pointerup' || e.type === 'pointercancel') {
      const wasErasingContact = stylus && (this.contactLatched || this.motionHeld || this.airLatched);
      this.inContact = false;
      this.contactLatched = false;
      this.contactSawBit = false;
      this.airLatched = false;
      this.motionHeld = stylus && (e.buttons & STYLUS_BTN_MASK) !== 0;
      if (wasErasingContact && !this.motionHeld) {
        this.hoverGraceUntil = now + 95;
        this.armReleaseTimer(100);
      } else {
        clearTimeout(this.releaseTimer);
        this.releaseTimer = 0;
        this.hoverGraceUntil = 0;
      }
      this.notify(prev);
      return;
    }

    if (e.type === 'pointerdown' || e.type === 'pointermove' || e.type === 'pointerrawupdate') {
      const wasInContact = this.inContact;
      this.inContact = true;
      if (explicitBit) {
        clearTimeout(this.releaseTimer);
        this.releaseTimer = 0;
        this.motionHeld = true;
        // If the button was already held when screen contact began (either via `pointerdown`
        // button=2/buttons=2 or carried in from air hover), latch it for the entire screen drag
        // because Android Chrome's `ACTION_MOVE` often reports `buttons === 1` (`button === -1`)
        // on subsequent move frames even while the barrel button remains physically held!
        if (!wasInContact || e.type === 'pointerdown' || this.airLatched || this.contactLatched) {
          this.contactLatched = true;
          this.contactSawBit = false;
        } else {
          this.contactSawBit = true;
        }
        this.hoverGraceUntil = 0;
      } else if (!wasInContact && stylus && (this.airLatched || this.motionHeld || now < this.hoverGraceUntil)) {
        // Pen was holding the button in the air and just touched the screen!
        // Latch Eraser for this screen contact even if the touch stream reports `buttons === 1`.
        clearTimeout(this.releaseTimer);
        this.releaseTimer = 0;
        this.contactLatched = true;
        this.contactSawBit = false;
        this.motionHeld = false;
        this.hoverGraceUntil = 0;
      } else if ((this.contactSawBit && !this.contactLatched) || e.pointerType === 'mouse') {
        // Mid-stroke chorded button press was released:
        this.motionHeld = false;
        this.contactLatched = false;
        this.airLatched = false;
      }
    }
    this.notify(prev);
  }

  /** Whether this pointer event should act as the eraser via the side button. */
  heldFor(e: PointerEvent): boolean {
    if (isPenSideButtonRaw(e)) return true;
    if (isStylusEvent(e)) return this.held;
    return false;
  }

  onKey(e: KeyboardEvent, down: boolean): boolean {
    if (!isStylusButtonKey(e)) return false;
    const prev = this.held;
    this.keyHeld = down;
    this.notify(prev);
    return true;
  }

  endContact(keepMotion = false): void {
    const prev = this.held;
    this.inContact = false;
    this.contactLatched = false;
    this.contactSawBit = false;
    if (!keepMotion && !this.releaseTimer) {
      this.airLatched = false;
      this.hoverGraceUntil = 0;
      this.motionHeld = false;
    }
    this.notify(prev);
  }

  reset(): void {
    clearTimeout(this.releaseTimer);
    this.releaseTimer = 0;
    const prev = this.held;
    this.inContact = false;
    this.motionHeld = false;
    this.keyHeld = false;
    this.airLatched = false;
    this.hoverGraceUntil = 0;
    this.contactLatched = false;
    this.contactSawBit = false;
    this.zeroMoveCount = 0;
    this.notify(prev);
  }
}
