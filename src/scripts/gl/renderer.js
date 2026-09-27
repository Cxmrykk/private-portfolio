/* ============================================================
   RENDERER — one WebGL2 context, two passes
   Pass 1: ocean → framebuffer texture (+ mipmaps for frost)
   Pass 2: glass composite → canvas, sampling that texture
   On the UI canvas both passes are scissored to the panels
   (plus their shadow / refraction margin); everything outside
   is transparent, so no fragments are spent there.

   GPU budget:
   - The base canvas is capped to a pixel budget (BASE_MAX_PIXELS)
     so very large / high-DPI screens don't render 4+ MP per pass.
   - Mipmaps are only rebuilt when a panel on this canvas actually
     samples a blurred level (gel buttons, dyed panels, or the base
     layer's screen-space reflection). Otherwise the texture uses
     plain LINEAR filtering and the mip chain is skipped entirely.
   - Bubble positions arrive precomputed in state.bubbles (see
     bubble-field.js), shared by both canvases.
   ============================================================ */
import { FULLSCREEN_VERT } from './shaders/common.glsl.js';
import { OCEAN_FRAG } from './shaders/ocean.glsl.js';
import { GLASS_FRAG } from './shaders/glass.glsl.js';

export const MAX_GLASS = 60;

/* CSS px of ocean rendered around each UI panel (covers shadow + refraction reach).
   Must stay >= the glass shader's UI-layer discard margin (28 px). */
const SCISSOR_MARGIN = 28;

/* Largest drawing buffer (in device pixels) for the full-screen base
   canvas. 1080p-class displays already render below this, so it only
   kicks in on large / high-DPI screens. */
const BASE_MAX_PIXELS = 1920 * 1080;

/* Three vec4 arrays of MAX_GLASS (rects, params, tints) plus the
   scalar uniforms. WebGL2 only guarantees 224 fragment vectors. */
const GLASS_UNIFORM_VECTORS = MAX_GLASS * 3 + 16;

const OCEAN_UNIFORMS = ['uRes', 'uTime', 'uMouse', 'uScroll', 'uChop', 'uShallow', 'uDive', 'uSunDir', 'uMoonDir', 'uBubbles'];
/* uShallow: the glass pass rebuilds the ocean camera (shared GLSL) so its
   glints can use real view rays, camera depth and beam positions. */
const GLASS_UNIFORMS = ['uRes', 'uTime', 'uMouse', 'uCursor', 'uPx', 'uScroll', 'uDive', 'uShallow',
                        'uLayerRender', 'uOcean', 'uGlassCount', 'uGlassRects', 'uGlassParams',
                        'uGlassTints', 'uSunDir', 'uMoonDir'];

function compile(gl, type, src){
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)){
    console.error(gl.getShaderInfoLog(sh));
    return null;
  }
  return sh;
}

function buildProgram(gl, vs, fragSrc, uniformNames){
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragSrc);
  if (!fs) return null;
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)){
    console.error(gl.getProgramInfoLog(prog));
    return null;
  }
  const u = {};
  for (const name of uniformNames) u[name] = gl.getUniformLocation(prog, name);
  return { prog, u };
}

/* 0 frosted panel · 1 gel button · 2 clear button · 3 thin clear card */
function glassType(el){
  if (el.classList.contains('btn')) return el.classList.contains('ghost') ? 2 : 1;
  if (el.classList.contains('card')) return 3;
  return 0;
}

export function createRenderer(canvasId, { isUI, maxPixels = isUI ? Infinity : BASE_MAX_PIXELS }){
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;

  const gl = canvas.getContext('webgl2', {
    antialias: false,
    alpha: isUI,
    premultipliedAlpha: true,
    depth: false, stencil: false,
    powerPreference: 'high-performance'
  });
  if (!gl) return null;

  const maxFragVectors = gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS);
  if (maxFragVectors < GLASS_UNIFORM_VECTORS){
    console.warn(`Glass pass needs ~${GLASS_UNIFORM_VECTORS} fragment uniform vectors; ` +
                 `this device offers ${maxFragVectors}. Lower MAX_GLASS if linking fails.`);
  }

  const vs = compile(gl, gl.VERTEX_SHADER, FULLSCREEN_VERT);
  if (!vs) return null;
  const ocean = buildProgram(gl, vs, OCEAN_FRAG, OCEAN_UNIFORMS);
  const glass = buildProgram(gl, vs, GLASS_FRAG, GLASS_UNIFORMS);
  if (!ocean || !glass) return null;
  gl.bindVertexArray(gl.createVertexArray());

  /* ---- ocean render target ---- */
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fbo = gl.createFramebuffer();

  /* Tracks the current min filter so it is only changed when needed.
     Without a mip chain the texture must use LINEAR, or it would be
     incomplete and sample as black. */
  let mipFiltering = false;

  const rectsData  = new Float32Array(MAX_GLASS * 4);
  const paramsData = new Float32Array(MAX_GLASS * 4);
  const tintsData  = new Float32Array(MAX_GLASS * 4); // dye r, g, b, strength
  const scissors = [];

  /* Drawing-buffer size for a requested DPR, shrunk uniformly if it
     would exceed this canvas's pixel budget. */
  function bufferSize(dpr){
    let w = window.innerWidth * dpr;
    let h = window.innerHeight * dpr;
    const px = w * h;
    if (px > maxPixels){
      const k = Math.sqrt(maxPixels / px);
      w *= k; h *= k;
    }
    return [Math.max(1, Math.round(w)), Math.max(1, Math.round(h))];
  }

  function resize(w, h){
    if (canvas.width === w && canvas.height === h) return;
    canvas.width = w; canvas.height = h;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /* Packs visible panels into the uniform arrays.
     Returns { count, needsMips }: needsMips is true when any packed
     panel samples a blurred mip level (see glass.glsl.js material()
     and tintFrostLod()). */
  function pack(items, h, sx, sy){
    let count = 0;
    let needsMips = !isUI; // base layer's screen-space reflection reads LOD 1.5
    scissors.length = 0;
    for (const it of items){
      if (count >= MAX_GLASS) break;
      const { el, style, rect, op, tint } = it;
      if (rect.bottom < -150 || rect.top > window.innerHeight + 150) continue;

      const type = glassType(el);
      const tk = tint ? tint[3] : 0;
      if (type === 1 || tk > 0) needsMips = true;

      const i = count * 4;
      rectsData[i]     = rect.left * sx;
      rectsData[i + 1] = h - rect.bottom * sy;
      rectsData[i + 2] = rect.width * sx;
      rectsData[i + 3] = rect.height * sy;

      let br = parseFloat(style.borderRadius) || 0;
      if (style.borderRadius.includes('%') || br > Math.min(rect.width, rect.height) / 2){
        br = Math.min(rect.width, rect.height) / 2;
      }
      paramsData[i]     = br * sx;
      paramsData[i + 1] = type;
      paramsData[i + 2] = 0; // padding, previously hover
      paramsData[i + 3] = op;

      tintsData[i]     = tint ? tint[0] : 0;
      tintsData[i + 1] = tint ? tint[1] : 0;
      tintsData[i + 2] = tint ? tint[2] : 0;
      tintsData[i + 3] = tk;

      if (isUI){
        const m = SCISSOR_MARGIN * sx;
        scissors.push([
          Math.floor(rectsData[i] - m),
          Math.floor(rectsData[i + 1] - m),
          Math.ceil(rectsData[i + 2] + 2 * m),
          Math.ceil(rectsData[i + 3] + 2 * m)
        ]);
      }
      count++;
    }
    return { count, needsMips };
  }

  /* Full-screen triangle; on the UI canvas, only inside the panel scissors */
  function drawFullscreen(){
    if (isUI){
      gl.enable(gl.SCISSOR_TEST);
      for (const s of scissors){
        gl.scissor(s[0], s[1], s[2], s[3]);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      gl.disable(gl.SCISSOR_TEST);
    } else {
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  }

  /* Builds the mip chain only when something will sample it; otherwise
     drops to LINEAR so the texture stays complete without one. */
  function prepareOceanTexture(needsMips){
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (needsMips){
      if (!mipFiltering){
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        mipFiltering = true;
      }
      gl.generateMipmap(gl.TEXTURE_2D);
    } else if (mipFiltering){
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      mipFiltering = false;
    }
  }

  /* state: { clock, dayTime, sunDir, moonDir, mouseX, mouseY, cursorX, cursorY, cursorOn,
              scroll, chop, shallow, dive, bubbles }
     bubbles: Float32Array(BUBBLE_COUNT * 4), camera-relative xyz + radius */
  function draw(state, items, dpr){
    const [w, h] = bufferSize(dpr);
    resize(w, h);
    const sx = w / window.innerWidth, sy = h / window.innerHeight;
    const { count, needsMips } = pack(items, h, sx, sy);

    /* ---- pass 1: ocean into the texture ---- */
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, w, h);
    gl.useProgram(ocean.prog);
    gl.uniform2f(ocean.u.uRes, w, h);
    gl.uniform1f(ocean.u.uTime, state.clock);
    gl.uniform3f(ocean.u.uSunDir, state.sunDir[0], state.sunDir[1], state.sunDir[2]);
    gl.uniform3f(ocean.u.uMoonDir, state.moonDir[0], state.moonDir[1], state.moonDir[2]);
    gl.uniform2f(ocean.u.uMouse, state.mouseX, state.mouseY);
    gl.uniform1f(ocean.u.uScroll, state.scroll);
    gl.uniform1f(ocean.u.uChop, state.chop);
    gl.uniform1f(ocean.u.uShallow, state.shallow);
    gl.uniform1f(ocean.u.uDive, state.dive);
    gl.uniform4fv(ocean.u.uBubbles, state.bubbles);

    if (isUI){
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    drawFullscreen();

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    prepareOceanTexture(needsMips);

    /* ---- pass 2: glass over the texture, onto the canvas ---- */
    gl.viewport(0, 0, w, h);
    gl.useProgram(glass.prog);
    if (isUI){
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.uniform2f(glass.u.uRes, w, h);
    gl.uniform1f(glass.u.uTime, state.clock);
    gl.uniform3f(glass.u.uSunDir, state.sunDir[0], state.sunDir[1], state.sunDir[2]);
    gl.uniform3f(glass.u.uMoonDir, state.moonDir[0], state.moonDir[1], state.moonDir[2]);
    gl.uniform2f(glass.u.uMouse, state.mouseX, state.mouseY);
    gl.uniform3f(glass.u.uCursor, state.cursorX * sx, h - state.cursorY * sy, state.cursorOn);
    gl.uniform1f(glass.u.uPx, sx);
    gl.uniform1f(glass.u.uScroll, state.scroll);
    gl.uniform1f(glass.u.uDive, state.dive);
    gl.uniform1f(glass.u.uShallow, state.shallow);
    gl.uniform1i(glass.u.uLayerRender, isUI ? 1 : 0);
    gl.uniform1i(glass.u.uGlassCount, count);
    gl.uniform4fv(glass.u.uGlassRects, rectsData);
    gl.uniform4fv(glass.u.uGlassParams, paramsData);
    gl.uniform4fv(glass.u.uGlassTints, tintsData);
    
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(glass.u.uOcean, 0);

    /* UI layer: the shader discards everything farther than 28 px from a
       panel, so scissoring to the same margin gives identical output
       without running the fragment shader over the rest of the screen. */
    drawFullscreen();
  }

  return { canvas, draw };
}
