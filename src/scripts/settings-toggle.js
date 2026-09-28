/* ============================================================
   SETTINGS TOGGLE — opens the water-controls panel
   Hover alone can't drive the panel on touch screens, and
   Safari never focuses a <button> on tap, so :focus-within
   is unreliable there too. This module owns the open state:

     open    tap / click / Enter / Space on the Settings pill
     close   the same again, a tap or click outside the group,
             Escape, or keyboard focus leaving the group

   The state is exposed as .is-open on .sea-controls (styled in
   components.css) and aria-expanded on the toggle. Hover still
   opens the panel for real pointers via @media (hover: hover).
   ============================================================ */

export function initSettingsToggle(){
  const group  = document.querySelector('.sea-controls');
  const toggle = group ? group.querySelector('.sea-status') : null;
  const panel  = document.getElementById('sea-panel');
  if (!group || !toggle || !panel) return;

  let open = false;

  /* returnFocus: move focus back to the toggle (keyboard close).
     Otherwise any focused slider is blurred, because iOS does not
     blur on a tap outside and the focus ring would linger. */
  function setOpen(next, returnFocus = false){
    if (next === open) return;
    open = next;
    group.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', String(open));

    if (!open){
      const active = document.activeElement;
      if (active && panel.contains(active)){
        if (returnFocus) toggle.focus();
        else active.blur();
      }
    }
  }

  toggle.addEventListener('click', () => setOpen(!open));

  /* Tap or click anywhere outside the controls closes the panel.
     The group itself ignores the pointer, so only the pill and the
     open panel can ever be the target inside it. */
  document.addEventListener('pointerdown', (e) => {
    if (open && !group.contains(e.target)) setOpen(false);
  }, { passive: true });

  document.addEventListener('keydown', (e) => {
    if (open && e.key === 'Escape') setOpen(false, true);
  });

  /* Tabbing out of the group closes it. A null relatedTarget (focus
     dropped by a tap, or the blur in setOpen) is ignored here; the
     pointerdown handler covers taps. */
  group.addEventListener('focusout', (e) => {
    if (open && e.relatedTarget && !group.contains(e.relatedTarget)) setOpen(false);
  });
}
