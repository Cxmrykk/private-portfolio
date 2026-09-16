/* ============================================================
   Sidebar gadget: validation-loss sparkline (Canvas 2D)
   ============================================================ */
export function initSparkline() {
  const c = document.getElementById('spark');
  if (!c) return;
  const loss = [0.94,0.81,0.72,0.66,0.60,0.55,0.51,0.47,0.44,0.41,0.39,0.36,
                0.34,0.32,0.31,0.29,0.28,0.27,0.26,0.25,0.24,0.23,0.22,0.21];

  function render(){
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    c.width = w * dpr; c.height = h * dpr;
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const padX = 12, padY = 14;
    const max = Math.max(...loss), min = Math.min(...loss);
    const pt = (i) => [
      padX + (i / (loss.length - 1)) * (w - padX * 2),
      padY + (1 - (loss[i] - min) / (max - min)) * (h - padY * 2)
    ];

    /* Update to a light, translucent grid for Dark Aero contrast */
    ctx.strokeStyle = 'rgba(255,255,255,.15)';
    ctx.lineWidth = 1;
    for (let g = 1; g < 4; g++){
      const y = padY + (g / 4) * (h - padY * 2);
      ctx.beginPath(); ctx.moveTo(padX, y); ctx.lineTo(w - padX, y); ctx.stroke();
    }

    /* Update line to brighter glowing cyan tones */
    const line = ctx.createLinearGradient(0, 0, w, 0);
    line.addColorStop(0, '#3fc0f0'); line.addColorStop(1, '#a5e4ff');

    /* Update area wash to a translucent glowing cyan */
    const area = ctx.createLinearGradient(0, 0, 0, h);
    area.addColorStop(0, 'rgba(165,228,255,.4)');
    area.addColorStop(1, 'rgba(165,228,255,0)');

    ctx.beginPath();
    loss.forEach((_, i) => { const [x, y] = pt(i); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.save();
    ctx.lineTo(w - padX, h - padY); ctx.lineTo(padX, h - padY); ctx.closePath();
    ctx.fillStyle = area; ctx.fill();
    ctx.restore();

    ctx.beginPath();
    loss.forEach((_, i) => { const [x, y] = pt(i); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.strokeStyle = line; ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.stroke();

    const [lx, ly] = pt(loss.length - 1);
    ctx.beginPath(); ctx.arc(lx, ly, 4.2, 0, Math.PI * 2);
    ctx.fillStyle = '#fff'; ctx.fill();
    ctx.strokeStyle = '#a5e4ff'; ctx.lineWidth = 2; ctx.stroke();
  }

  render();
  let t; window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(render, 150); });
}

