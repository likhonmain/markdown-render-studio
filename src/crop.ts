// Crop dialog: shows the whole picture with a movable, resizable crop frame.
// Works with mouse, touch and pen (pointer events). Resolves to the crop
// rectangle (fractions of the picture) or null when cancelled.
import type { Crop } from './store';

interface CropOptions {
  crop?: Crop;
  confirmLabel?: string;
  title?: string;
}

const RATIOS: Array<[string, number | null]> = [
  ['Free', null],
  ['Original', -1],
  ['1:1', 1],
  ['4:3', 4 / 3],
  ['3:4', 3 / 4],
  ['16:9', 16 / 9],
];

export function openCrop(url: string, nw: number, nh: number, opts: CropOptions = {}): Promise<Crop | null> {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'crop-dialog';
    dlg.innerHTML = `
      <div class="crop-head"><b>${opts.title ?? 'Crop picture'}</b><span class="crop-hint">Drag the frame or its corners</span></div>
      <div class="crop-area"><div class="crop-stage"><img alt="" draggable="false" /><div class="crop-frame">
        <span class="ch ch-nw" data-h="nw"></span><span class="ch ch-n" data-h="n"></span><span class="ch ch-ne" data-h="ne"></span>
        <span class="ch ch-e" data-h="e"></span><span class="ch ch-se" data-h="se"></span><span class="ch ch-s" data-h="s"></span>
        <span class="ch ch-sw" data-h="sw"></span><span class="ch ch-w" data-h="w"></span>
        <i class="grid"></i></div></div></div>
      <div class="crop-ratios"></div>
      <div class="dialog-actions">
        <button type="button" class="tb-btn" data-act="reset">Reset</button>
        <span class="spacer"></span>
        <button type="button" class="tb-btn" data-act="cancel">Cancel</button>
        <button type="button" class="tb-btn primary" data-act="ok">${opts.confirmLabel ?? 'Apply'}</button>
      </div>`;
    document.body.appendChild(dlg);
    const stage = dlg.querySelector<HTMLElement>('.crop-stage')!;
    const area = dlg.querySelector<HTMLElement>('.crop-area')!;
    const img = dlg.querySelector<HTMLImageElement>('img')!;
    const frame = dlg.querySelector<HTMLElement>('.crop-frame')!;
    img.src = url;

    // Crop in picture pixels.
    let c = { x: 0, y: 0, w: nw, h: nh };
    if (opts.crop) c = { x: opts.crop[0] * nw, y: opts.crop[1] * nh, w: opts.crop[2] * nw, h: opts.crop[3] * nh };
    let ratio: number | null = null;
    let scale = 1; // screen px per picture px

    const layout = () => {
      const aw = Math.max(100, area.clientWidth);
      const ah = Math.max(100, area.clientHeight);
      scale = Math.min(aw / nw, ah / nh);
      stage.style.width = `${nw * scale}px`;
      stage.style.height = `${nh * scale}px`;
      draw();
    };
    const draw = () => {
      frame.style.left = `${c.x * scale}px`;
      frame.style.top = `${c.y * scale}px`;
      frame.style.width = `${c.w * scale}px`;
      frame.style.height = `${c.h * scale}px`;
    };
    const minSize = () => Math.max(8, Math.min(nw, nh) * 0.03);
    const clampMove = () => {
      c.x = Math.min(Math.max(0, c.x), nw - c.w);
      c.y = Math.min(Math.max(0, c.y), nh - c.h);
    };
    const applyRatio = (r: number | null) => {
      ratio = r === -1 ? nw / nh : r;
      if (!ratio) return;
      const cx = c.x + c.w / 2;
      const cy = c.y + c.h / 2;
      let w = c.w;
      let h = w / ratio;
      if (h > nh) { h = nh; w = h * ratio; }
      if (w > nw) { w = nw; h = w / ratio; }
      c = { x: cx - w / 2, y: cy - h / 2, w, h };
      clampMove();
      draw();
    };

    const ratioBox = dlg.querySelector<HTMLElement>('.crop-ratios')!;
    for (const [label, r] of RATIOS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = label;
      b.setAttribute('aria-pressed', String(r === null));
      b.addEventListener('click', () => {
        for (const x of ratioBox.children) x.setAttribute('aria-pressed', 'false');
        b.setAttribute('aria-pressed', 'true');
        applyRatio(r);
      });
      ratioBox.appendChild(b);
    }

    frame.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const h = (e.target as HTMLElement).dataset.h ?? 'move';
      const start = { ...c };
      const sx = e.clientX;
      const sy = e.clientY;
      frame.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        const dx = (ev.clientX - sx) / scale;
        const dy = (ev.clientY - sy) / scale;
        if (h === 'move') {
          c = { ...start, x: start.x + dx, y: start.y + dy };
          clampMove();
          draw();
          return;
        }
        let { x, y, w, h: hh } = start;
        const m = minSize();
        if (h.includes('e')) w = Math.min(nw - x, Math.max(m, start.w + dx));
        if (h.includes('s')) hh = Math.min(nh - y, Math.max(m, start.h + dy));
        if (h.includes('w')) {
          const nx = Math.min(start.x + start.w - m, Math.max(0, start.x + dx));
          w = start.x + start.w - nx;
          x = nx;
        }
        if (h.includes('n')) {
          const ny = Math.min(start.y + start.h - m, Math.max(0, start.y + dy));
          hh = start.y + start.h - ny;
          y = ny;
        }
        if (ratio) {
          // Keep the ratio: follow the dominant drag direction.
          if (h === 'n' || h === 's') w = hh * ratio;
          else if (h === 'e' || h === 'w') hh = w / ratio;
          else if (Math.abs(dx) >= Math.abs(dy)) hh = w / ratio;
          else w = hh * ratio;
          if (h.includes('w')) x = start.x + start.w - w;
          if (h.includes('n')) y = start.y + start.h - hh;
          if (x < 0 || y < 0 || x + w > nw + 0.5 || y + hh > nh + 0.5) return; // would leave the picture
        }
        c = { x, y, w, h: hh };
        draw();
      };
      const up = () => {
        frame.removeEventListener('pointermove', move);
        frame.removeEventListener('pointerup', up);
        frame.removeEventListener('pointercancel', up);
      };
      frame.addEventListener('pointermove', move);
      frame.addEventListener('pointerup', up);
      frame.addEventListener('pointercancel', up);
    });

    const finish = (result: Crop | null) => {
      ro.disconnect();
      dlg.close();
      dlg.remove();
      resolve(result);
    };
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      finish(null);
    });
    dlg.querySelector('[data-act="cancel"]')!.addEventListener('click', () => finish(null));
    dlg.querySelector('[data-act="reset"]')!.addEventListener('click', () => {
      c = { x: 0, y: 0, w: nw, h: nh };
      ratio = null;
      for (const x of ratioBox.children) x.setAttribute('aria-pressed', String(x.textContent === 'Free'));
      draw();
    });
    dlg.querySelector('[data-act="ok"]')!.addEventListener('click', () => {
      const r: Crop = [c.x / nw, c.y / nh, c.w / nw, c.h / nh].map((v) => Math.min(1, Math.max(0, v))) as Crop;
      if (r[2] < 0.001 || r[3] < 0.001) return finish([0, 0, 1, 1]);
      finish(r);
    });

    const ro = new ResizeObserver(layout);
    dlg.showModal();
    ro.observe(area);
    layout();
  });
}
