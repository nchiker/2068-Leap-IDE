/**
 * src/tools/asset-gallery.js — the gallery strip of the asset editors (stage 5, S1): a row of small pictures, one per asset of the
 * editor's kind, the edited one highlighted, a click selects. DOM only; the pictures come from asset-thumbs.js (pure). Every string goes
 * through textContent, never innerHTML.
 *
 *   createGallery(opts) -> { el, render({names, current, describe?}), destroy(), count() }
 *     opts.label      the strip's aria-label ("Sprites")
 *     opts.box        the picture box in pixels (default 36: the strip stays under 72 pixels high with its caption and scroll bar)
 *     opts.get(name)  the stored asset (null when it is gone)
 *     opts.thumb(name, asset, ctx) -> {w, h, rgba}   one of asset-thumbs.js's functions, with the editor's options
 *     opts.onSelect(name)      a click on a picture that is not the current one
 *   render: names in list order; `current` the edited asset's name or null; `describe(name, asset)` (optional) -> {key, ctx}: whatever else the
 *     picture depends on (a map's tile set), as a string `key` that changes with it and the `ctx` handed to thumb.
 *   A picture is redrawn only when its asset's JSON text (plus describe's key) changed, so an edit redraws the edited asset's picture only.
 *   The strip scrolls sideways when it is long. A picture is `<button data-role="gallery-item" data-asset="NAME" class="agal-item [current]">`
 *   in `<div data-role="gallery-strip">`; `data-draws` counts how often its canvas was painted.
 *   galleryCss(scope, vars, canvasBg): the rules, for the editor's own variable names {bg, border, borderHi, hover, active, amber, muted, fg}.
 */

"use strict";

/** The picture box of the strip (pixels); the editors hand it to asset-thumbs.js too. */
export const GALLERY_BOX = 36;
const CLS = 'agal';

export function galleryCss(scope, v, canvasBg = 'transparent') {
  return `
${scope} .${CLS}-strip { display: flex; flex-wrap: nowrap; gap: 4px; align-items: flex-start; box-sizing: border-box; width: 100%; min-width: 0; max-height: 72px; padding: 2px;
  overflow-x: auto; overflow-y: hidden; scrollbar-width: thin; position: relative; border: 1px solid var(${v.border}); border-radius: 4px; background: var(${v.bg}); }
${scope} .${CLS}-item { flex: none; display: flex; flex-direction: column; align-items: center; gap: 1px; padding: 2px; border: 1px solid var(${v.border}); border-radius: 3px;
  background: var(${v.bg}); cursor: pointer; font: 10px var(--font-code, monospace); color: var(${v.muted}); }
${scope} .${CLS}-item:hover { border-color: var(${v.borderHi}); background: var(${v.hover}); }
${scope} .${CLS}-item.current { border-color: var(${v.amber}); color: var(${v.amber}); background: var(${v.active}); }
${scope} .${CLS}-thumb { display: flex; align-items: center; justify-content: center; }
${scope} .${CLS}-thumb canvas { image-rendering: pixelated; display: block; background: ${canvasBg}; }
${scope} .${CLS}-cap { display: block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; line-height: 12px; }
${scope} .${CLS}-item:focus-visible { outline: 2px solid var(${v.amber}); outline-offset: 1px; }
`;
}

export function createGallery(opts) {
  const box = Number.isInteger(opts?.box) && opts.box >= 8 ? opts.box : GALLERY_BOX;
  const strip = document.createElement('div');
  strip.className = `${CLS}-strip`;
  strip.dataset.role = 'gallery-strip';
  strip.setAttribute('aria-label', opts?.label ?? 'Assets');
  strip.hidden = true;
  const entries = new Map();             // name -> {el, canvas, key}
  let lastCurrent = null, destroyed = false;

  // a vertical wheel scrolls the strip sideways when it is wide enough to scroll (the page does not move)
  strip.addEventListener('wheel', (e) => {
    if (strip.scrollWidth <= strip.clientWidth || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    strip.scrollLeft += e.deltaY;
    e.preventDefault();
  }, { passive: false });

  function make(name) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `${CLS}-item`;
    b.dataset.role = 'gallery-item';
    b.dataset.asset = name;
    b.dataset.draws = '0';
    b.title = name;
    b.style.width = `${box + 8}px`;
    const holder = document.createElement('span');
    holder.className = `${CLS}-thumb`;
    holder.style.width = `${box}px`; holder.style.height = `${box}px`;
    const canvas = document.createElement('canvas');
    canvas.width = 1; canvas.height = 1;
    holder.append(canvas);
    const cap = document.createElement('span');
    cap.className = `${CLS}-cap`;
    cap.textContent = name;
    b.append(holder, cap);
    b.addEventListener('mousedown', (e) => e.preventDefault());            // the editor keeps the keyboard focus (its shortcuts keep working)
    b.addEventListener('click', () => { if (!b.classList.contains('current')) { try { opts?.onSelect?.(name); } catch { /* the editor reports its own errors */ } } });
    return { el: b, canvas, key: null };
  }
  function paint(entry, thumb) {
    const c = entry.canvas;
    c.width = Math.max(1, thumb.w | 0); c.height = Math.max(1, thumb.h | 0);
    c.style.width = `${c.width}px`; c.style.height = `${c.height}px`;
    const ctx = c.getContext('2d');
    ctx.putImageData(new ImageData(thumb.rgba, c.width, c.height), 0, 0);
    entry.el.dataset.draws = String(+entry.el.dataset.draws + 1);
  }
  function render({ names, current = null, describe } = {}) {
    if (destroyed) return;
    const list = Array.isArray(names) ? names : [];
    strip.hidden = list.length === 0;
    const keep = new Set(list);
    for (const [n, e] of entries) if (!keep.has(n)) { e.el.remove(); entries.delete(n); }
    list.forEach((name, i) => {
      let entry = entries.get(name);
      if (!entry) { entry = make(name); entries.set(name, entry); }
      let asset = null;
      try { asset = opts.get(name) ?? null; } catch { asset = null; }
      let d = null;
      try { d = describe ? describe(name, asset) : null; } catch { d = null; }
      const key = JSON.stringify(asset) + '|' + (d?.key ?? '');
      if (entry.key !== key) {
        entry.key = key;
        let thumb;
        try { thumb = opts.thumb(name, asset, d?.ctx); } catch { thumb = null; }
        if (thumb?.rgba) paint(entry, thumb);
      }
      const on = name === current;
      entry.el.classList.toggle('current', on);
      if (on) entry.el.setAttribute('aria-current', 'true'); else entry.el.removeAttribute('aria-current');
      if (strip.children[i] !== entry.el) strip.insertBefore(entry.el, strip.children[i] ?? null);
    });
    if (current !== lastCurrent && strip.clientWidth > 0) {                  // (a strip in a hidden tab has no width: the scroll waits for the next render)
      lastCurrent = current;
      const e = current !== null ? entries.get(current) : null;
      if (e) {                                                               // bring the edited picture into sight (this strip only: the page never moves)
        const l = e.el.offsetLeft, r = l + e.el.offsetWidth;
        if (l < strip.scrollLeft) strip.scrollLeft = Math.max(0, l - 4);
        else if (r > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = r - strip.clientWidth + 4;
      }
    }
  }
  return {
    el: strip,
    render,
    count: () => entries.size,
    destroy() { destroyed = true; entries.clear(); strip.remove(); },
  };
}
