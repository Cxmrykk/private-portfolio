/* ============================================================
   SAND TEXTURE — the seabed albedo, shared by both contexts
   The image is decoded once (loadSand) and uploaded separately
   into each WebGL2 context (createSandTexture), since texture
   objects cannot be shared between contexts.

   - Uploaded as SRGB8_ALPHA8, so the shader samples linear light
     like the rest of its maths. (SRGB8 is not colour-renderable,
     so generateMipmap would fail on it.)
   - Full mip chain + anisotropic filtering: the seabed is seen at
     grazing angles out to ~240 units, which aliases badly without.
   - REPEAT wrapping; the shader breaks up the tiling itself.
   - The photo's mean linear colour is measured once and handed to
     the shader (uSandMean), which divides it out and substitutes
     the tuned sand colour. The texture only contributes detail, so
     the day / sunset / night grading stays as authored.
   - Until the image arrives, each context holds a 1x1 texture in
     the fallback colour, so the sampler is always complete and
     nothing flashes black.

   Avoiding hitches when the photo arrives:
   - Decoded with createImageBitmap (off the main thread, and a
     cheaper texture source than an <img>).
   - The mean is summed in row bands, yielding whenever a slice
     runs past SLICE_MS, instead of in one long loop. The sum is
     the same, in the same order.
   - Uploads (texImage2D + generateMipmap) are queued and run one
     per animation frame, so the two contexts never upload in the
     same frame.
   ============================================================ */
import sandUrl from '../../assets/sand.jpg';

/* 1x1 placeholder, sRGB bytes. Its mean is itself, so the shader's
   normalisation yields exactly the tuned sand colour. */
const FALLBACK_BYTES = new Uint8Array([214, 200, 164, 255]);

/* sRGB byte -> linear, as a lookup table */
const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++){
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

const FALLBACK_MEAN = Object.freeze([
  SRGB_TO_LINEAR[FALLBACK_BYTES[0]],
  SRGB_TO_LINEAR[FALLBACK_BYTES[1]],
  SRGB_TO_LINEAR[FALLBACK_BYTES[2]]
]);

const MAX_ANISOTROPY = 8;

/* Mean measurement: rows per getImageData call, and the longest
   stretch of main-thread work before yielding */
const BAND_ROWS = 64;
const SLICE_MS = 4;

let pending = null;

/* ---------- one upload per animation frame ---------- */
const uploadQueue = [];
let uploadRaf = 0;

function drainUploads(){
  uploadRaf = 0;
  const job = uploadQueue.shift();
  if (job) job();
  if (uploadQueue.length) uploadRaf = requestAnimationFrame(drainUploads);
}

function scheduleUpload(job){
  uploadQueue.push(job);
  if (!uploadRaf) uploadRaf = requestAnimationFrame(drainUploads);
}

/* ---------- decode + measure ---------- */
function yieldToBrowser(){
  return new Promise((resolve) => {
    if ('requestIdleCallback' in window) window.requestIdleCallback(() => resolve(), { timeout: 100 });
    else setTimeout(resolve, 0);
  });
}

async function decode(){
  if ('createImageBitmap' in window){
    try {
      const response = await fetch(sandUrl);
      const blob = await response.blob();
      return await createImageBitmap(blob);
    } catch (_){
      /* fall through to <img> */
    }
  }
  const image = new Image();
  image.decoding = 'async';
  image.src = sandUrl;
  await image.decode();
  return image;
}

/* Mean linear colour of the whole image, in time slices */
async function measureMean(image){
  const w = image.naturalWidth || image.width;
  const h = image.naturalHeight || image.height;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return FALLBACK_MEAN.slice();
  ctx.drawImage(image, 0, 0, w, h);

  let r = 0, g = 0, b = 0;
  let sliceStart = performance.now();

  for (let y = 0; y < h; y += BAND_ROWS){
    const rows = Math.min(BAND_ROWS, h - y);
    const data = ctx.getImageData(0, y, w, rows).data;
    for (let i = 0; i < data.length; i += 4){
      r += SRGB_TO_LINEAR[data[i]];
      g += SRGB_TO_LINEAR[data[i + 1]];
      b += SRGB_TO_LINEAR[data[i + 2]];
    }
    if (performance.now() - sliceStart > SLICE_MS){
      await yieldToBrowser();
      sliceStart = performance.now();
    }
  }

  /* release the backing store */
  canvas.width = canvas.height = 0;

  const n = Math.max(1, w * h);
  return [r / n, g / n, b / n];
}

/* Decodes and measures the image once. Resolves to { image, mean },
   or null if it failed (the fallback texture then simply stays). */
export function loadSand(){
  if (!pending){
    pending = (async () => {
      const image = await decode();
      const mean = await measureMean(image);
      return { image, mean };
    })().catch((err) => {
      console.warn('Sand texture failed to load; using the flat fallback.', err);
      return null;
    });
  }
  return pending;
}

/* Creates this context's sand texture on unit 1 (unit 0 belongs to
   the ocean render target). Always leaves TEXTURE0 active.
   onUploaded is called once the photo is in this context. */
export function createSandTexture(gl, onUploaded = null){
  const tex = gl.createTexture();
  const aniso = gl.getExtension('EXT_texture_filter_anisotropic');

  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, FALLBACK_BYTES);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.activeTexture(gl.TEXTURE0);

  const handle = {
    tex,
    mean: FALLBACK_MEAN.slice(),
    ready: false,

    upload(image, mean){
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, image);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      if (aniso){
        const max = gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
        gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(MAX_ANISOTROPY, max));
      }
      gl.activeTexture(gl.TEXTURE0);

      handle.mean = mean.slice();
      handle.ready = true;
    }
  };

  loadSand().then((data) => {
    if (!data) return;
    scheduleUpload(() => {
      if (gl.isContextLost()) return;
      handle.upload(data.image, data.mean);
      if (onUploaded) onUploaded();
    });
  });

  return handle;
}
