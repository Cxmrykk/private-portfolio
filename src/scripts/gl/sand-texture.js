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

let pending = null;

/* Mean linear colour of the whole image */
function measureMean(image){
  const w = image.naturalWidth || image.width;
  const h = image.naturalHeight || image.height;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return FALLBACK_MEAN.slice();
  ctx.drawImage(image, 0, 0, w, h);

  const data = ctx.getImageData(0, 0, w, h).data;
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < data.length; i += 4){
    r += SRGB_TO_LINEAR[data[i]];
    g += SRGB_TO_LINEAR[data[i + 1]];
    b += SRGB_TO_LINEAR[data[i + 2]];
  }
  const n = Math.max(1, data.length / 4);
  return [r / n, g / n, b / n];
}

/* Decodes the image once. Resolves to { image, mean }, or null if
   it failed (the fallback texture then simply stays in place). */
export function loadSand(){
  if (!pending){
    pending = (async () => {
      const image = new Image();
      image.decoding = 'async';
      image.src = sandUrl;
      await image.decode();
      return { image, mean: measureMean(image) };
    })().catch((err) => {
      console.warn('Sand texture failed to load; using the flat fallback.', err);
      return null;
    });
  }
  return pending;
}

/* Creates this context's sand texture on unit 1 (unit 0 belongs to
   the ocean render target). Always leaves TEXTURE0 active. */
export function createSandTexture(gl){
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
  return handle;
}
