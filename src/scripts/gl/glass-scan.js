/* ============================================================
   GLASS SCAN — which DOM elements are glass, on which layer
   Panels, cards and buttons are glass. Chips and result pills
   are printed flat onto their card (see components.css).
   Each item also carries its dye (see seasons.css):
   [r, g, b, strength] in 0..1, strength 0 = clear glass.

   Caching: computed-style reads force the browser to bring style
   up to date, so they are not done every frame. Each element's
   style-derived data (opacity, visibility, z-index, radius, dye,
   type) is cached and re-read only when something can have
   changed it:
     - a class / hidden attribute changes anywhere (selectors)
     - a style attribute changes on glass or an ancestor of glass
     - the window resizes (media queries)
     - a transition runs on the element (read every frame until
       it ends, then once more for the settled value)
   Elements are re-queried only when the DOM tree changes.
   Rects are still read every frame; they move with scrolling.
   The returned lists and items are reused between calls.
   ============================================================ */
const SELECTOR = '.glass, .btn';

const NO_TINT = Object.freeze([0, 0, 0, 0]);

/* Parsed tints keyed by their raw CSS strings; there are only a
   handful of distinct values, so this avoids re-parsing. */
const tintCache = new Map();

/* Last geometry written to each blur box, so unchanged boxes are not
   re-styled every frame (each write invalidates style and forces the
   backdrop-filter layer to be recomposited). */
const blurKeys = new WeakMap();

let elements = [];
let listDirty = true;
let styleEpoch = 0;
let observing = false;

const items = new Map();     // element -> cached item
const running = new Map();   // element -> number of running transitions

const baseList = [];
const uiList = [];
const result = { base: baseList, ui: uiList };

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

/* 0 frosted panel · 1 gel button · 2 clear button · 3 thin clear card */
function glassType(el){
  if (el.classList.contains('btn')) return el.classList.contains('ghost') ? 2 : 1;
  if (el.classList.contains('card')) return 3;
  return 0;
}

function containsGlass(node){
  return node instanceof Element && (node.matches(SELECTOR) || node.querySelector(SELECTOR) !== null);
}

function onMutations(mutations){
  for (const m of mutations){
    if (m.type === 'childList'){
      listDirty = true;
      styleEpoch++;
    } else if (m.attributeName === 'style'){
      /* Inline styles written every frame elsewhere (splash veil,
         blur boxes, overlays) hold no glass and are ignored. */
      if (containsGlass(m.target)) styleEpoch++;
    } else {
      styleEpoch++;
    }
  }
}

function onTransition(e){
  if (e.pseudoElement) return;
  const el = e.target;
  if (!(el instanceof Element) || !el.matches(SELECTOR)) return;

  const n = running.get(el) || 0;
  if (e.type === 'transitionrun'){
    running.set(el, n + 1);
    return;
  }
  if (n <= 1) running.delete(el);
  else running.set(el, n - 1);
  styleEpoch++;   // pick up the settled values
}

function observe(){
  observing = true;
  new MutationObserver(onMutations).observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'hidden']
  });
  for (const type of ['transitionrun', 'transitionend', 'transitioncancel']){
    document.addEventListener(type, onTransition, true);
  }
  window.addEventListener('resize', () => { styleEpoch++; });
}

function createItem(el){
  return {
    el,
    style: window.getComputedStyle(el),   // live declaration
    type: 0,
    z: 1,
    op: 1,
    hidden: false,
    radius: '0px',
    tint: NO_TINT,
    rect: null,
    epoch: -1
  };
}

function readStyle(item){
  const { el, style } = item;

  let op = parseFloat(style.opacity);
  if (isNaN(op)) op = 1;
  item.op = op;
  item.hidden = op === 0 || style.visibility === 'hidden';

  let z = parseInt(style.zIndex, 10);
  if (isNaN(z)) z = (el.closest('header') || el.closest('.sea-controls')) ? 100 : 1;
  item.z = z;

  item.radius = style.borderRadius;
  item.tint = readTint(style);
  item.type = glassType(el);
  item.epoch = styleEpoch;
}

function byZ(a, b){ return a.z - b.z; }

/* Elements at z >= 20 (header, water controls) sit above the page
   content and render on the transparent UI canvas; the rest render
   on the base canvas beneath the DOM. */
export function scanGlass(){
  if (!observing) observe();

  if (listDirty){
    listDirty = false;
    elements = Array.from(document.querySelectorAll(SELECTOR));
    for (const el of items.keys()){
      if (!el.isConnected){ items.delete(el); running.delete(el); }
    }
  }

  baseList.length = 0;
  uiList.length = 0;

  for (let i = 0; i < elements.length; i++){
    const el = elements[i];
    let item = items.get(el);
    if (!item){
      item = createItem(el);
      items.set(el, item);
    }
    if (item.epoch !== styleEpoch || running.has(el)) readStyle(item);
    if (item.hidden) continue;

    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) continue;
    item.rect = rect;

    (item.z >= 20 ? uiList : baseList).push(item);
  }

  baseList.sort(byZ);
  uiList.sort(byZ);
  return result;
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
      const { rect, radius } = uiItems[i];
      const key = rect.left + ',' + rect.top + ',' + rect.width + ',' + rect.height + ',' + radius;
      if (blurKeys.get(box) === key) continue;
      blurKeys.set(box, key);

      box.style.display = 'block';
      box.style.left = rect.left + 'px';
      box.style.top = rect.top + 'px';
      box.style.width = rect.width + 'px';
      box.style.height = rect.height + 'px';
      box.style.borderRadius = radius;
    } else if (blurKeys.get(box) !== 'hidden'){
      blurKeys.set(box, 'hidden');
      box.style.display = 'none';
    }
  }
}
