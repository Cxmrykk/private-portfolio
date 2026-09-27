/* ============================================================
   GLASS SCAN — which DOM elements are glass, on which layer
   Panels, cards and buttons are glass. Chips and result pills
   are printed flat onto their card (see components.css).
   Each item also carries its dye (see seasons.css):
   [r, g, b, strength] in 0..1, strength 0 = clear glass.
   ============================================================ */
const SELECTOR = '.glass, .btn';

const NO_TINT = Object.freeze([0, 0, 0, 0]);

/* Parsed tints keyed by their raw CSS strings; there are only a
   handful of distinct values, so this avoids re-parsing per frame. */
const tintCache = new Map();

function clamp01(v){ return Math.min(1, Math.max(0, v)); }

function readTint(style){
  const k = parseFloat(style.getPropertyValue('--glass-tint-strength'));
  if (!(k > 0)) return NO_TINT;

  const raw = style.getPropertyValue('--glass-tint').trim();
  if (!raw) return NO_TINT;

  const key = raw + '|' + k;
  let tint = tintCache.get(key);
  if (!tint){
    const n = raw.split(/[\s,\/]+/).filter(Boolean).map(Number);
    const ok = n.length >= 3 && n.slice(0, 3).every(Number.isFinite);
    tint = ok
      ? Object.freeze([clamp01(n[0] / 255), clamp01(n[1] / 255), clamp01(n[2] / 255), clamp01(k)])
      : NO_TINT;
    tintCache.set(key, tint);
  }
  return tint;
}

/* Elements at z >= 20 (header, water controls) sit above the page
   content and render on the transparent UI canvas; the rest render
   on the base canvas beneath the DOM. */
export function scanGlass(){
  const base = [], ui = [];

  document.querySelectorAll(SELECTOR).forEach(el => {
    const style = window.getComputedStyle(el);
    let op = parseFloat(style.opacity);
    if (isNaN(op)) op = 1;
    if (op === 0 || style.visibility === 'hidden') return;

    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;

    let z = parseInt(style.zIndex, 10);
    if (isNaN(z)) z = (el.closest('header') || el.closest('.sea-controls')) ? 100 : 1;

    const item = { el, style, rect, z, op, tint: readTint(style) };
    (z >= 20 ? ui : base).push(item);
  });

  base.sort((a, b) => a.z - b.z);
  ui.sort((a, b) => a.z - b.z);
  return { base, ui };
}

/* Keep one CSS backdrop-blur box under each UI panel so page text
   sliding beneath the header is frosted; the shader frosts the ocean. */
export function syncBlurLayer(uiItems){
  const layer = document.getElementById('ui-blur-layer');
  if (!layer) return;

  while (layer.children.length < uiItems.length){
    const box = document.createElement('div');
    box.style.position = 'absolute';
    box.style.backdropFilter = 'blur(12px)';
    box.style.webkitBackdropFilter = 'blur(12px)';
    layer.appendChild(box);
  }

  for (let i = 0; i < layer.children.length; i++){
    const box = layer.children[i];
    if (i < uiItems.length){
      const { rect, style } = uiItems[i];
      box.style.display = 'block';
      box.style.left = rect.left + 'px';
      box.style.top = rect.top + 'px';
      box.style.width = rect.width + 'px';
      box.style.height = rect.height + 'px';
      box.style.borderRadius = style.borderRadius;
    } else {
      box.style.display = 'none';
    }
  }
}
