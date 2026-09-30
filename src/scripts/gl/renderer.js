/* ============================================================
   RENDERER — one WebGL2 context, two passes
   Pass 1: ocean → framebuffer texture (+ mipmaps for frost)
   Pass 2: glass composite → canvas, sampling that texture
   On the UI canvas both passes are scissored to the panels
   (plus their shadow / refraction margin); everything outside
   is transparent, so no fragments are spent there.

   Shader compilation:
   - Programs are compiled and linked at creation, but their
     status is only queried once KHR_parallel_shader_compile
     reports completion, so the main thread never blocks on the
     driver. status() returns 'pending' | 'ready' | 'failed';
     draw() does nothing until 'ready'. Without the extension the
     first status() call waits, as the old synchronous path did.

   Texture units:
   - Unit 0: the ocean render target (sampled by the glass pass).
   - Unit 1: the sand albedo (sampled by the ocean pass; see
     sand-texture.js). TEXTURE0 is always left active, so every
     bind of the ocean texture lands on unit 0.

   Sizing:
   - The drawing buffer follows the canvas's own CSS box, not the
     window. The canvases are sized to the large viewport (100lvh,
     see environment.css), so on mobile the URL bar collapsing and
     expanding no longer changes the buffer size or reallocates the
     ocean texture mid-scroll.
   - The CSS box is tracked with a ResizeObserver instead of being
     read each frame, so drawing never forces a synchronous layout.
     opts.onResize is called when it changes.

   Assets:
   - opts.onAssetReady is called once the sand image has been
     uploaded into this context, so a paused or reduced-motion
     page can redraw with it.

   GPU budget:
   - The base canvas is capped to a pixel budget (BASE_MAX_PIXELS)
     so very large / high-DPI screens don't render 4+ MP per pass.
   - Mipmaps are only rebuilt when a panel on this canvas actually
     samples a blurred level (gel buttons, dyed panels, or the base
     layer's screen-space reflection), and only up to the deepest
     level anything samples (OCEAN_MAX_LEVEL). Otherwise the texture
     uses plain LINEAR filtering and the mip chain is skipped.
   - Per-frame constants (lighting, camera) arrive in state.frame
     (see lighting.js) and bubble positions in state.bubbles /
     state.bubbleCount (see bubble-field.js), shared by both canvases.
   ============================================================ */
import { FULLSCREEN_VERT } from './shaders/common.glsl.js';
import { OCEAN_FRAG } from './shaders/ocean.glsl.js';
import { GLASS_FRAG } from './shaders/glass.glsl.js';
import { createSandTexture } from './sand-texture.js';

export const MAX_GLASS = 60;

/* CSS px of ocean rendered around each UI panel (covers shadow + refraction reach).
   Must stay >= the glass shader's UI-layer discard margin (28 px). */
const SCISSOR_MARGIN = 28;

/* Largest drawing buffer (in device pixels) for the full-screen base
   canvas. 1080p-class displays already render below this, so it only
   kicks in on large / high-DPI screens. */
const BASE_MAX_PIXELS = 1920 * 1080;

/* Three vec4 arrays of MAX_GLASS (rects, params, tints) plus the
   scalar and per-frame uniforms. WebGL2 only guarantees 224
   fragment vectors. */
const GLASS_UNIFORM_VECTORS = MAX_GLASS * 3 + 24;

/* Texture unit the sand albedo lives on (see sand-texture.js) */
const SAND_UNIT = 1;

/* Deepest mip level the glass pass samples: the screen-space
   reflection reads LOD 1.5 and the frost at most ~1.4, so levels
   0..2 cover every lookup exactly. */
const OCEAN_MAX_LEVEL = 2;

/* Per-frame constants shared by both passes (GLSL_COMMON) */
const FRAME_UNIFORMS = ['uSunDir', 'uMoonDir', 'uPhase', 'uPrimaryDir', 'uShaftDir', 'uPrimaryCol',
                        'uEnvLight', 'uSkyAmbient', 'uCamOrigin', 'uCamPitch', 'uSubmergence'];

const OCEAN_UNIFORMS = ['uRes', 'uTime', 'uMouse', 'uScroll', 'uChop', 'uShallow', 'uDive',
                        'uBubbles', 'uBubbleCount', 'uSand', 'uSandMean', ...FRAME_UNIFORMS];
const GLASS_UNIFORMS = ['uRes', 'uTime', 'uMouse', 'uCursor', 'uPx', 'uScroll', 'uDive', 'uShallow',
                        'uLayerRender', 'uOcean', 'uGlassCount', 'uGlassRects', 'uGlassParams',
                        'uGlassTints', ...FRAME_UNIFORMS];

function compileShader(gl, type, src){
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  return sh;
}

/* Kick off compile + link without querying any status */
function startProgram(gl, vs, fragSrc){
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  return { prog, vs, fs };
}

function linkComplete(gl, parallel, p){
  return !parallel || gl.getProgramParameter(p.prog, parallel.COMPLETION_STATUS_KHR) === true;
}

/* Status queries are safe (non-blocking) once the link is complete */
function finishProgram(gl, p, uniformNames){
  if (!gl.getProgramParameter(p.prog, gl.LINK_STATUS)){
    for (const sh of [p.vs, p.fs]){
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(sh));
    }
    console.error(gl.getProgramInfoLog(p.prog));
    return null;
  }
  const u = {};
  for (const name of uniformNames) u[name] = gl.getUniformLocation(p.prog, name);
  return { prog: p.prog, u };
}

function setFrameUniforms(gl, u, state){
  const f = state.frame;
  gl.uniform3f(u.uSunDir, state.sunDir[0], state.sunDir[1], state.sunDir[2]);
  gl.uniform3f(u.uMoonDir, state.moonDir[0], state.moonDir[1], state.moonDir[2]);
  gl.uniform3f(u.uPhase, f.phase[0], f.phase[1], f.phase[2]);
  gl.uniform3f(u.uPrimaryDir, f.primaryDir[0], f.primaryDir[1], f.primaryDir[2]);
  gl.uniform3f(u.uShaftDir, f.shaftDir[0], f.shaftDir[1], f.shaftDir[2]);
  gl.uniform3f(u.uPrimaryCol, f.primaryCol[0], f.primaryCol[1], f.primaryCol[2]);
  gl.uniform1f(u.uEnvLight, f.envLight);
  gl.uniform1f(u.uSkyAmbient, f.skyAmbient);
  gl.uniform3f(u.uCamOrigin, f.camOrigin[0], f.camOrigin[1], f.camOrigin[2]);
  gl.uniform1f(u.uCamPitch, f.camPitch);
  gl.uniform1f(u.uSubmergence, f.submergence);
}

export function createRenderer(canvasId, { isUI, maxPixels = isUI ? Infinity : BASE_MAX_PIXELS, onResize = null, onAssetReady = null }){
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

  /* ---- programs: compiled in the background where supported ---- */
  const parallel = gl.getExtension('KHR_parallel_shader_compile');
  const vs = compileShader(gl, gl.VERTEX_SHADER, FULLSCREEN_VERT);
  const pendingOcean = startProgram(gl, vs, OCEAN_FRAG);
  const pendingGlass = startProgram(gl, vs, GLASS_FRAG);
  let ocean = null, glass = null;
  let programState = 'pending';

  function status(){
    if (programState !== 'pending') return programState;
    if (gl.isContextLost()) return programState;
    if (!linkComplete(gl, parallel, pendingOcean) || !linkComplete(gl, parallel, pendingGlass)) return programState;

    ocean = finishProgram(gl, pendingOcean, OCEAN_UNIFORMS);
    glass = finishProgram(gl, pendingGlass, GLASS_UNIFORMS);
    programState = (ocean && glass) ? 'ready' : 'failed';
    return programState;
  }

  gl.bindVertexArray(gl.createVertexArray());

  /* ---- ocean render target (unit 0) ---- */
  gl.activeTexture(gl.TEXTURE0);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, OCEAN_MAX_LEVEL);
  const fbo = gl.createFramebuffer();

  /* ---- sand albedo (unit 1): fallback now, the photo once decoded ---- */
  const sand = createSandTexture(gl, onAssetReady);

  /* Tracks the current min filter so it is only changed when needed.
     Without a mip chain the texture must use LINEAR, or it would be
     incomplete and sample as black. */
  let mipFiltering = false;

  const rectsData  = new Float32Array(MAX_GLASS * 4);
  const paramsData = new Float32Array(MAX_GLASS * 4);
  const tintsData  = new Float32Array(MAX_GLASS * 4); // dye r, g, b, strength
  const scissors = [];
  let scissorCount = 0;

  /* ---- CSS box of the canvas ----
     Panel rects (viewport CSS px) map onto the buffer through this box.
     Both canvases are pinned to the top-left of the viewport, so the
     mapping is a pure scale. */
  let cssW = canvas.clientWidth  || window.innerWidth;
  let cssH = canvas.clientHeight || window.innerHeight;

  function setCssSize(w, h){
    if (!(w >= 1 && h >= 1)) return;
    if (w === cssW && h === cssH) return;
    cssW = w; cssH = h;
    if (onResize) onResize();
  }

  if ('ResizeObserver' in window){
    new ResizeObserver((entries) => {
      const box = entries[entries.length - 1].contentRect;
      setCssSize(box.width, box.height);
    }).observe(canvas);
  } else {
    window.addEventListener('resize', () => {
      setCssSize(canvas.clientWidth || window.innerWidth,
                 canvas.clientHeight || window.innerHeight);
    });
  }

  /* Drawing-buffer size for a requested DPR, shrunk uniformly if it
     would exceed this canvas's pixel budget. */
  function bufferSize(dpr){
    let w = cssW * dpr;
    let h = cssH * dpr;
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
    gl.activeTexture(gl.TEXTURE0);
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
    scissorCount = 0;
    for (const it of items){
      if (count >= MAX_GLASS) break;
      const { rect, op, tint, type, radius } = it;
      if (rect.bottom < -150 || rect.top > cssH + 150) continue;

      const tk = tint ? tint[3] : 0;
      if (type === 1 || tk > 0) needsMips = true;

      const i = count * 4;
      rectsData[i]     = rect.left * sx;
      rectsData[i + 1] = h - rect.bottom * sy;
      rectsData[i + 2] = rect.width * sx;
      rectsData[i + 3] = rect.height * sy;

      let br = parseFloat(radius) || 0;
      if (radius.includes('%') || br > Math.min(rect.width, rect.height) / 2){
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
        let s = scissors[scissorCount];
        if (!s) s = scissors[scissorCount] = [0, 0, 0, 0];
        s[0] = Math.floor(rectsData[i] - m);
        s[1] = Math.floor(rectsData[i + 1] - m);
        s[2] = Math.ceil(rectsData[i + 2] + 2 * m);
        s[3] = Math.ceil(rectsData[i + 3] + 2 * m);
        scissorCount++;
      }
      count++;
    }
    return { count, needsMips };
  }

  /* Full-screen triangle; on the UI canvas, only inside the panel scissors */
  function drawFullscreen(){
    if (isUI){
      gl.enable(gl.SCISSOR_TEST);
      for (let i = 0; i < scissorCount; i++){
        const s = scissors[i];
        gl.scissor(s[0], s[1], s[2], s[3]);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      gl.disable(gl.SCISSOR_TEST);
    } else {
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  }

  /* Builds the mip chain (levels 1..OCEAN_MAX_LEVEL) only when
     something will sample it; otherwise drops to LINEAR so the
     texture stays complete without one. */
  function prepareOceanTexture(needsMips){
    gl.activeTexture(gl.TEXTURE0);
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

  /* state: { clock, sunDir, moonDir, mouseX, mouseY, cursorX, cursorY, cursorOn,
              scroll, chop, shallow, dive, bubbles, bubbleCount, frame }
     Returns false if the programs are not ready yet. */
  function draw(state, items, dpr){
    if (status() !== 'ready') return false;

    const [w, h] = bufferSize(dpr);
    resize(w, h);
    const sx = w / cssW, sy = h / cssH;
    const { count, needsMips } = pack(items, h, sx, sy);

    /* ---- pass 1: ocean into the texture ---- */
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, w, h);
    gl.useProgram(ocean.prog);
    gl.uniform2f(ocean.u.uRes, w, h);
    gl.uniform1f(ocean.u.uTime, state.clock);
    gl.uniform2f(ocean.u.uMouse, state.mouseX, state.mouseY);
    gl.uniform1f(ocean.u.uScroll, state.scroll);
    gl.uniform1f(ocean.u.uChop, state.chop);
    gl.uniform1f(ocean.u.uShallow, state.shallow);
    gl.uniform1f(ocean.u.uDive, state.dive);
    gl.uniform4fv(ocean.u.uBubbles, state.bubbles);
    gl.uniform1i(ocean.u.uBubbleCount, state.bubbleCount);
    setFrameUniforms(gl, ocean.u, state);

    /* Sand on unit 1. The sampler must never default to unit 0: that
       unit holds the texture this pass is rendering into. */
    gl.activeTexture(gl.TEXTURE0 + SAND_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, sand.tex);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(ocean.u.uSand, SAND_UNIT);
    gl.uniform3f(ocean.u.uSandMean, sand.mean[0], sand.mean[1], sand.mean[2]);

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
    setFrameUniforms(gl, glass.u, state);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(glass.u.uOcean, 0);

    /* UI layer: the shader discards everything farther than 28 px from a
       panel, so scissoring to the same margin gives identical output
       without running the fragment shader over the rest of the screen. */
    drawFullscreen();
    return true;
  }

  return {
    canvas,
    draw,
    status,
    aspect: () => cssW / cssH
  };
}
