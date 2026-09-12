/* ====================================================
   KLNDR THEME CONTROLLER
   ====================================================
   Owns one fact: what `data-theme` on <html> says. theme.css owns what that
   means; nothing here knows a single colour except the two address-bar tints,
   which have to be literal because a <meta> cannot read a custom property.

   Three modes, not two. The design system's colors-dark.css follows
   prefers-color-scheme and treats data-theme as an override in EITHER
   direction, so "system" is the real default and the attribute is absent in
   that state - which is also why there has to be a way back to it once a
   choice has been pinned.

   The stamp itself is applied by a short inline script in the <head> of every
   page, BEFORE the stylesheets. It has to be, and it has to be inline: an
   external file - even a blocking one - is a round trip during which the
   browser has already painted, which is exactly the flash a dark theme exists
   to avoid. Note the inline stamp only ever writes an ATTRIBUTE; the
   system-default case needs no JavaScript at all, because the media query in
   theme.css already handles it.

   Choice is remembered per browser rather than per account. It is a property
   of the screen you are looking at, not of who you are: the same user on a
   bright desk and a dark bedroom wants two different answers, and a server
   round trip on a preference this cheap would only slow the page down.
   ==================================================== */

window.KlndrTheme = (function () {
  const STORAGE_KEY = 'klndr:theme';
  const MODES = ['system', 'light', 'dark'];

  // Matches the first stop of the two --bg-gradient values in theme.css.
  const BAR_COLOR = { light: '#f2ffec', dark: '#1e1e17' };

  const darkQuery = window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;

  function stored() {
    try {
      const value = localStorage.getItem(STORAGE_KEY);
      return MODES.includes(value) ? value : 'system';
    } catch (err) {
      // Private mode, or storage disabled. Not worth a broken page.
      return 'system';
    }
  }

  /** What the user asked for: 'system', 'light' or 'dark'. */
  function mode() {
    const attr = document.documentElement.getAttribute('data-theme');
    return attr === 'dark' || attr === 'light' ? attr : 'system';
  }

  /** What is actually on screen: 'light' or 'dark'. */
  function resolved() {
    const chosen = mode();
    if (chosen !== 'system') return chosen;
    return darkQuery && darkQuery.matches ? 'dark' : 'light';
  }

  function apply(next) {
    if (next === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', next);

    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', BAR_COLOR[resolved()]);
  }

  function announce() {
    window.dispatchEvent(
      new CustomEvent('klndr:themechange', {
        detail: { mode: mode(), theme: resolved() }
      })
    );
  }

  /**
   * The one entry point that changes anything. Surfaces that paint outside the
   * cascade - today only the timeline canvas - listen for klndr:themechange
   * rather than being called directly, so a new one can join without this file
   * learning about it.
   */
  function set(next) {
    const chosen = MODES.includes(next) ? next : 'system';
    apply(chosen);

    try {
      localStorage.setItem(STORAGE_KEY, chosen);
    } catch (err) {
      // It still applies to this page; it just will not survive it.
    }

    syncControls(chosen);
    announce();
    return chosen;
  }

  /** Light and dark only, skipping system. For a keyboard shortcut or a test. */
  function toggle() {
    return set(resolved() === 'dark' ? 'light' : 'dark');
  }

  /**
   * Paint a category's colour onto an element.
   *
   * Deliberately NOT element.style.backgroundColor. A task's colour is a
   * database hex, and the dark theme takes every one of them down toward the
   * page ground - so the colour goes in as a custom property and app.css's
   * --task-fill applies whatever transform the theme in force asks for. That
   * also means a theme change needs no re-render: the property already on the
   * element resolves to the new colour on its own.
   *
   * There used to be a lookup here holding the design system's exact dark
   * value for the six accents it names. It is gone on purpose. Those values
   * desaturate, app.css's rule does not, and running two rules over one
   * palette meant six colours drifting away from the other fourteen - which
   * is most of what made the dark theme read as one colour.
   */
  function paint(el, hex) {
    if (!el) return;

    if (!hex) {
      el.style.removeProperty('--task-color');
      return;
    }

    el.style.setProperty('--task-color', hex);
  }

  function syncControls(chosen) {
    document.querySelectorAll('[data-theme-choice]').forEach((btn) => {
      const isOn = btn.dataset.themeChoice === chosen;
      btn.classList.toggle('is-active', isOn);
      btn.setAttribute('aria-checked', String(isOn));
      // Only the selected option stays in the tab order; the arrow keys move
      // between them, which is what a radiogroup is supposed to do.
      btn.tabIndex = isOn ? 0 : -1;
    });
  }

  function onKeydown(event, buttons) {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const index = buttons.indexOf(document.activeElement);
    const next = buttons[(index + step + buttons.length) % buttons.length];
    next.focus();
    set(next.dataset.themeChoice);
  }

  function mount() {
    const buttons = Array.from(document.querySelectorAll('[data-theme-choice]'));
    if (!buttons.length) return;

    buttons.forEach((btn) => {
      btn.addEventListener('click', () => set(btn.dataset.themeChoice));
      btn.addEventListener('keydown', (event) => onKeydown(event, buttons));
    });

    syncControls(mode());
  }

  // On 'system', the OS flipping at sunset has to reach the canvas the same
  // way pressing the button does - the cascade handles itself, the canvas does
  // not.
  if (darkQuery) {
    const onSystemChange = () => {
      if (mode() !== 'system') return;
      apply('system');
      announce();
    };
    if (darkQuery.addEventListener) darkQuery.addEventListener('change', onSystemChange);
    else if (darkQuery.addListener) darkQuery.addListener(onSystemChange);
  }

  // A choice made in one tab should not leave the others stale.
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY) return;
    const chosen = stored();
    apply(chosen);
    syncControls(chosen);
    announce();
  });

  // The inline stamp sets the attribute and nothing else, because at that
  // point it is the only thing that has to be true before the first paint.
  // Re-applying here picks up the rest of it - today, the address-bar tint.
  apply(stored());

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }

  return { STORAGE_KEY, mode, resolved, set, toggle, paint, mount };
})();
