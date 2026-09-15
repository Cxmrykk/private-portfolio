/* ============================================================
   Bubbles
   ============================================================ */
export function initBubbles() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const host = document.getElementById('bubbles');
  const frag = document.createDocumentFragment();
  for (let i = 0; i < 22; i++){
    const b = document.createElement('b');
    const size = 6 + Math.random() * 44;
    b.style.width = b.style.height = size + 'px';
    b.style.left = (Math.random() * 100) + 'vw';
    b.style.setProperty('--drift', (Math.random() * 140 - 70) + 'px');
    b.style.animationDuration = (11 + Math.random() * 18) + 's';
    b.style.animationDelay = (-Math.random() * 30) + 's';
    b.style.opacity = '';
    frag.appendChild(b);
  }
  host.appendChild(frag);
}
