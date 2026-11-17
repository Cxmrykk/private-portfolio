/* ============================================================
   RENDERER — one WebGL2 context, three draws
   Pass 1:  ocean → framebuffer texture
   Pass 1b: bubbles → the same texture, one instanced quad per
            bubble, blended over the ocean (bubbles.glsl.js)
            (+ mipmaps for frost)
   Pass 2:  glass composite → canvas, sampling that texture
   On the UI canvas every pass is scissored to the panels
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

   Vertex arrays:
   - The full-screen passes use an empty vertex array (the triangle
     comes from gl_VertexID) and it is the one left bound.
   - The bubble pass has its own, holding the per-instance buffer;
     it is bound only around that draw.

   Sizing:
   - The drawing buffer follows the canvas's own CSS box, not the
     window. The canvases are sized to the large viewport (100lvh,
     see environment.css), so on mobile the URL bar collapsing and
     expanding no longer changes the buffer size or reallocates the
     ocean texture mid-scroll.
   - The CSS box is tracked with a ResizeObserver instead of being
     read each frame, so drawing never forces a synchronous layout.
     opts.onResize is called when it changes.
   - The ocean texture has its own size (ow x oh), which equals the
     drawing buffer on both canvases. The glass pass samples it
     through normalised coordinates, so the two could differ; see
     UI_OCEAN_MATCH_BASE for why they do not.

   Assets:
   - opts.onAssetReady is called once the sand image has been
     uploaded into this context, so a paused or reduced-motion
     page can redraw with it.

   GPU budget:
   - The base canvas is capped to a pixel budget (BASE_MAX_PIXELS)
     so very large / high-DPI screens don't render 4+ MP per pass.
   - Bubbles only shade the pixels inside their own bounding quads,
     and the pass is skipped while none are visible (above water).
   - Mipmaps are only rebuilt when a panel on this canvas actually
     samples a blurred level (gel buttons, dyed panels, or the base
     layer's screen-space reflection), and only up to the deepest
     level anything samples (OCEAN_MAX_LEVEL). Otherwise the texture
     uses plain LINEAR filtering and the mip chain is skipped.
   - Per-frame constants (lighting, camera) arrive in state.frame
     (see lighting.js) and bubble instances in state.bubbles /
     state.bubbleCount (see bubble-field.js), shared by both canvases.
   ============================================================ */
import { FULLSCREEN_VERT } from './shaders/common.glsl.js';
import { OCEAN_FRAG } from './shaders/ocean.glsl.js';
import { GLASS_FRAG } from './shaders/glass.glsl.js';
import { BUBBLE_VERT, BUBBLE_FRAG } from './shaders/bubbles.glsl.js';
import { BUBBLE_COUNT, BUBBLE_STRIDE } from './bubble-field.js';
import { clamp, smoothstep } from './camera.js';
import { createSandTexture } from './sand-texture.js';

export const MAX_GLASS = 60;

/* CSS px of ocean rendered around each UI panel (covers shadow + refraction reach).
   Must stay >= the glass shader's UI-layer discard margin (28 px). */
const SCISSOR_MARGIN = 28;

/* Largest drawing buffer (in device pixels) for the full-screen base
   canvas. 1080p-class displays already render below this, so it only
   kicks in on large / high-DPI screens. */
const BASE_MAX_PIXELS = 1920 * 1080;

/* The UI canvas renders its own copy of the ocean behind its panels
   (textures cannot be shared between the two contexts). Turning this
   on renders that copy at the base canvas's lower pixel density
   instead of the UI canvas's own.

   Left OFF: it is cheaper, but it shows. The glass does not display
   the ocean texture 1:1. The bevels magnify it several times (the
   refraction offset reaches ~2.5x the bevel width, and at rounded
   corners the samples converge on a point), so coarser texels become
   visible blocks along the rims: steps on the header's corners and
   across the settings panel's wide bevels. The UI's ocean therefore
   needs the UI canvas's full density. */
const UI_OCEAN_MATCH_BASE = false;

/* Device pixels per CSS pixel the base canvas last rendered at.
   Published by the base renderer each time it draws; only read by
   the UI renderer when UI_OCEAN_MATCH_BASE is on. */
let baseDensity = 0;

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

/* Bubble pass. Must match the ocean pass (ocean.glsl.js main()):
   the underwater uv shimmer amplitude, and the dive range over
   which the bubbles fade in. */
const BUBBLE_WARP = 0.0045;
const BUBBLE_MIN_AMOUNT = 0.001;
const BUBBLE_BYTES = BUBBLE_STRIDE * Float32Array.BYTES_PER_ELEMENT;

/* Per-frame constants shared by both passes (GLSL_COMMON) */
const FRAME_UNIFORMS = ['uSunDir', 'uMoonDir', 'uPhase', 'uPrimaryDir', 'uShaftDir', 'uPrimaryCol',
                        'uEnvLight', 'uSkyAmbient', 'uCamOrigin', 'uCamPitch', 'uSubmergence'];

const OCEAN_UNIFORMS = ['uRes', 'uTime', 'uMouse', 'uScroll', 'uChop', 'uShallow', 'uDive',
                        'uSand', 'uSandMean', ...FRAME_UNIFORMS];
const BUBBLE_UNIFORMS = ['uRes', 'uTime', 'uWarp', 'uAmount', 'uCamPitch', 'uPhase'];
const GLASS_UNIFORMS = ['uRes', 'uTime', 'uMouse', 'uCursor', 'uPx', 'uScroll', 'uDive', 'uShallow',
                        'uLayerRender', 'uOcean', 'uOceanLod', 'uGlassCount', 'uGlassRects',
                        'uGlassParams', 'uGlassTints', ...FRAME_UNIFORMS];

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
  const bubbleVs = compileShader(gl, gl.VERTEX_SHADER, BUBBLE_VERT);
  const pendingOcean = startProgram(gl, vs, OCEAN_FRAG);
  const pendingBubbles = startProgram(gl, bubbleVs, BUBBLE_FRAG);
  const pendingGlass = startProgram(gl, vs, GLASS_FRAG);
  let ocean = null, bubbles = null, glass = null;
  let programState = 'pending';

  function status(){
    if (programState !== 'pending') return programState;
    if (gl.isContextLost()) return programState;
    if (!linkComplete(gl, parallel, pendingOcean) ||
        !linkComplete(gl, parallel, pendingBubbles) ||
        !linkComplete(gl, parallel, pendingGlass)) return programState;

    ocean = finishProgram(gl, pendingOcean, OCEAN_UNIFORMS);
    bubbles = finishProgram(gl, pendingBubbles, BUBBLE_UNIFORMS);
    glass = finishProgram(gl, pendingGlass, GLASS_UNIFORMS);
    programState = (ocean && bubbles && glass) ? 'ready' : 'failed';
    return programState;
  }

  /* ---- vertex arrays ----
     Bubbles: one instance = BUBBLE_STRIDE floats (bubble-field.js);
     attribute 0 = aBubble, 1 = aRect (bubbles.glsl.js). */
  const fullscreenVao = gl.createVertexArray();
  const bubbleVao = gl.createVertexArray();
  const bubbleBuf = gl.createBuffer();

  gl.bindVertexArray(bubbleVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, bubbleBuf);
  gl.bufferData(gl.ARRAY_BUFFER, BUBBLE_COUNT * BUBBLE_BYTES, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 4, gl.FLOAT, false, BUBBLE_BYTES, 0);
  gl.vertexAttribDivisor(0, 1);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 4, gl.FLOAT, false, BUBBLE_BYTES, 16);
  gl.vertexAttribDivisor(1, 1);

  gl.bindVertexArray(fullscreenVao);

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

  /* Current size of the ocean texture (0 until first allocated) */
  let texW = 0, texH = 0;

  /* ---- sand albedo (unit 1): fallback now, the photo once decoded ---- */
  const sand = createSandTexture(gl, onAssetReady);

  /* Tracks the current min filter so it is only changed when needed.
     Without a mip chain the texture must use LINEAR, or it would be
     incomplete and sample as black. */
  let mipFiltering = false;

  const rectsData  = new Float32Array(MAX_GLASS * 4);
  const paramsData = new Float32Array(MAX_GLASS * 4);
  const tintsData  = new Float32Array(MAX_GLASS * 4); // dye r, g, b, strength

  /* UI canvas: one scissor box per panel, in canvas pixels (glass
     pass) and in ocean-texture pixels (ocean and bubble passes).
     The two are the same boxes while the texture matches the canvas. */
  const scissors = [];
  const oceanScissors = [];
  let scissorCount = 0;

  /* Instances drawn by drawBubbleQuads() */
  let bubbleInstances = 0;

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

  /* w, h: drawing buffer. ow, oh: ocean texture. */
  function resize(w, h, ow, oh){
    if (canvas.width !== w || canvas.height !== h){
      canvas.width = w; canvas.height = h;
    }
    if (texW === ow && texH === oh) return;
    texW = ow; texH = oh;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, ow, oh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /* Packs visible panels into the uniform arrays.
     rx, ry: ocean-texture pixels per canvas pixel (<= 1).
     Returns { count, needsMips }: needsMips is true when any packed
     panel samples a blurred mip level (see glass.glsl.js material()
     and tintFrostLod()). */
  function pack(items, h, sx, sy, rx, ry){
    let count = 0;
    let needsMips = !isUI; // base layer's screen-space reflection reads LOD 1.5
    scissorCount = 0;

    /* A smaller ocean texture is magnified with bilinear filtering,
       which reads one texel beyond the sample point: render one more
       texel around each box so that neighbour is always valid. */
    const pad = (rx < 1 || ry < 1) ? 1 : 0;

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

        /* The same box in ocean-texture pixels */
        let o = oceanScissors[scissorCount];
        if (!o) o = oceanScissors[scissorCount] = [0, 0, 0, 0];
        const x0 = Math.floor(s[0] * rx) - pad;
        const y0 = Math.floor(s[1] * ry) - pad;
        o[0] = x0;
        o[1] = y0;
        o[2] = Math.ceil((s[0] + s[2]) * rx) + pad - x0;
        o[3] = Math.ceil((s[1] + s[3]) * ry) + pad - y0;

        scissorCount++;
      }
      count++;
    }
    return { count, needsMips };
  }

  /* Full-screen triangle (empty vertex array bound) */
  function drawTriangle(){
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /* One quad per visible bubble (bubble vertex array bound) */
  function drawBubbleQuads(){
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, bubbleInstances);
  }

  /* Runs a draw call over the whole target; on the UI canvas, once
     per panel scissor box in `boxes` instead. */
  function drawScissored(drawCall, boxes){
    if (isUI){
      gl.enable(gl.SCISSOR_TEST);
      for (let i = 0; i < scissorCount; i++){
        const s = boxes[i];
        gl.scissor(s[0], s[1], s[2], s[3]);
        drawCall();
      }
      gl.disable(gl.SCISSOR_TEST);
    } else {
      drawCall();
    }
  }

  /* Pass 1b: bubbles blended over the ocean, into the bound ocean
     framebuffer (ow x oh). Each bubble shades only its own bounding quad. */
  function drawBubbles(state, ow, oh){
    const d = clamp(state.dive, 0, 1);
    const amount = smoothstep(0.10, 0.32, d);
    bubbleInstances = state.bubbleCount;
    if (bubbleInstances <= 0 || amount <= BUBBLE_MIN_AMOUNT) return;
    if (isUI && scissorCount === 0) return;

    gl.useProgram(bubbles.prog);
    gl.uniform2f(bubbles.u.uRes, ow, oh);
    gl.uniform1f(bubbles.u.uTime, state.clock);
    gl.uniform1f(bubbles.u.uWarp, BUBBLE_WARP * smoothstep(0.15, 0.60, d));
    gl.uniform1f(bubbles.u.uAmount, amount);
    gl.uniform1f(bubbles.u.uCamPitch, state.frame.camPitch);
    gl.uniform3f(bubbles.u.uPhase, state.frame.phase[0], state.frame.phase[1], state.frame.phase[2]);

    gl.bindVertexArray(bubbleVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, bubbleBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, state.bubbles, 0, bubbleInstances * BUBBLE_STRIDE);

    /* rgb: bubble light over the scene darkened by the bubble's alpha.
       The target's own alpha is left untouched. */
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
    drawScissored(drawBubbleQuads, oceanScissors);
    gl.disable(gl.BLEND);

    gl.bindVertexArray(fullscreenVao);
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
    const sx = w / cssW, sy = h / cssH;

    /* Ocean texture size: the drawing buffer. (With
       UI_OCEAN_MATCH_BASE on, the UI canvas would use the base
       canvas's lower density instead; see the note on that constant.) */
    let ow = w, oh = h;
    if (!isUI){
      baseDensity = sx;
    } else if (UI_OCEAN_MATCH_BASE && baseDensity > 0 && baseDensity < sx){
      const r = baseDensity / sx;
      ow = Math.max(1, Math.round(w * r));
      oh = Math.max(1, Math.round(h * r));
    }

    resize(w, h, ow, oh);
    const { count, needsMips } = pack(items, h, sx, sy, ow / w, oh / h);

    /* ---- pass 1: ocean into the texture ---- */
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, ow, oh);
    gl.useProgram(ocean.prog);
    gl.uniform2f(ocean.u.uRes, ow, oh);
    gl.uniform1f(ocean.u.uTime, state.clock);
    gl.uniform2f(ocean.u.uMouse, state.mouseX, state.mouseY);
    gl.uniform1f(ocean.u.uScroll, state.scroll);
    gl.uniform1f(ocean.u.uChop, state.chop);
    gl.uniform1f(ocean.u.uShallow, state.shallow);
    gl.uniform1f(ocean.u.uDive, state.dive);
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
    drawScissored(drawTriangle, oceanScissors);

    /* ---- pass 1b: bubbles over the ocean, same texture ---- */
    drawBubbles(state, ow, oh);

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

    /* Blurred lookups are authored in canvas pixels; shift them by the
       ocean texture's size relative to the canvas (0 when equal). */
    gl.uniform1f(glass.u.uOceanLod, Math.log2(ow / w));

    /* UI layer: the shader discards everything farther than 28 px from a
       panel, so scissoring to the same margin gives identical output
       without running the fragment shader over the rest of the screen. */
    drawScissored(drawTriangle, scissors);
    return true;
  }

  return {
    canvas,
    draw,
    status,
    aspect: () => cssW / cssH
  };
}
