// klndr admin - the shell.
//
// Every admin tool lives on this one page, as a section in the sidebar. The
// shell owns what they share: the sidebar and its drawer on narrow screens, the
// page header, the router, and the small building blocks - buttons, menus,
// dialogs, the toast - so that a page in one section looks and behaves like a
// page in any other.
//
// A section is one script that calls KlndrAdmin.section() when it loads. The
// order those scripts load in is the order of the sidebar, so adding a tool is
// a file and a <script> tag in admin/index.html.
//
// Hiding the way in from people who are not admins is presentation. The page
// and every endpoint behind it are guarded on the server.

const KlndrAdmin = (() => {
  const BASE = '/admin';
  const LAST_PAGE_KEY = 'klndr:admin:last';
  const NARROW = window.matchMedia('(max-width: 1023px)');

  const sections = [];
  const navLinks = new Map();
  const state = { me: null, current: null, subpath: '', started: false };

  const $ = (id) => document.getElementById(id);

  // ==========================================
  // DOM
  // ==========================================

  function h(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function icon(name) {
    const glyph = h('span', 'material-symbols-outlined', name);
    glyph.setAttribute('aria-hidden', 'true');
    return glyph;
  }

  /**
   * `labelNarrow: false` drops the label on a phone and leaves the icon, which
   * is what a header action does when it runs out of room.
   */
  function button(label, { icon: glyph, variant = 'secondary', small = false, onClick, title, ariaLabel, labelNarrow = true } = {}) {
    const node = h('button', `ann-btn ann-btn-${variant}${small ? ' ann-btn-small' : ''}`);
    node.type = 'button';
    if (glyph) node.appendChild(icon(glyph));
    if (label) node.appendChild(h('span', `ann-btn-label${labelNarrow ? '' : ' adm-hide-narrow'}`, label));
    if (title) node.title = title;
    if (ariaLabel || !labelNarrow) node.setAttribute('aria-label', ariaLabel || label);
    if (onClick) node.addEventListener('click', onClick);
    return node;
  }

  function iconButton(glyph, label, onClick) {
    const node = h('button', 'ann-icon-btn');
    node.type = 'button';
    node.setAttribute('aria-label', label);
    node.title = label;
    node.appendChild(icon(glyph));
    if (onClick) node.addEventListener('click', onClick);
    return node;
  }

  function errorBox(err) {
    const box = h('div', 'an-error');
    box.appendChild(h('p', null,
      err && err.status === 403
        ? 'This page is for admins. Your account does not have access.'
        : "Couldn't load that."));
    if (err && err.message && err.status !== 403) box.appendChild(h('p', 'an-error-detail', err.message));
    return box;
  }

  // ==========================================
  // FEEDBACK: TOAST, DIALOG, MENU
  // ==========================================

  let toastTimer = 0;
  function toast(message, kind = 'info') {
    const node = $('admToast');
    if (!node) return;
    node.textContent = message;
    node.className = `adm-toast${kind === 'error' ? ' is-error' : kind === 'success' ? ' is-success' : ''}`;
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      node.hidden = true;
    }, kind === 'error' ? 7000 : 3500);
  }

  let dialogCount = 0;

  /**
   * A modal in the house style. `content` goes under the title and `text`;
   * `actions` are the buttons along the bottom. With `onSubmit` the dialog is a
   * form, so Enter in a field submits it.
   *
   * Returns { node, close(value), closed }, where `closed` resolves with the
   * value it was closed with - '' for Escape.
   */
  function dialog({ title, text, content, actions = [], onSubmit }) {
    const node = h('dialog', 'adm-dialog');
    const frame = h(onSubmit ? 'form' : 'div', 'adm-dialog-frame');
    const body = h('div', 'adm-dialog-body');
    const heading = h('h2', null, title);
    heading.id = `admDialogTitle${++dialogCount}`;
    node.setAttribute('aria-labelledby', heading.id);
    body.appendChild(heading);
    if (text) body.appendChild(h('p', null, text));
    if (content) body.append(...[].concat(content));
    const bar = h('div', 'adm-dialog-actions');
    bar.append(...actions);
    frame.append(body, bar);
    node.appendChild(frame);

    if (onSubmit) {
      frame.addEventListener('submit', (event) => {
        event.preventDefault();
        onSubmit(event);
      });
    }

    const closed = new Promise((resolve) => {
      node.addEventListener('close', () => {
        node.remove();
        resolve(node.returnValue);
      });
    });
    document.body.appendChild(node);
    node.showModal();
    return { node, close: (value = '') => node.close(value), closed };
  }

  function confirmDialog({ title, body, confirm = 'Confirm', danger = false }) {
    let modal = null;
    const cancel = button('Cancel', { onClick: () => modal.close('cancel') });
    const ok = button(confirm, { variant: danger ? 'danger' : 'primary', onClick: () => modal.close('ok') });
    modal = dialog({ title, text: body, actions: [cancel, ok] });
    // A destructive choice should never be the one Enter lands on.
    (danger ? cancel : ok).focus();
    return modal.closed.then((value) => value === 'ok');
  }

  /** A button that opens a small menu. items: [{ label, icon, onClick, danger } | { separator } | null] */
  function menu(trigger, items) {
    const wrap = h('div', 'adm-menu-wrap');
    const list = h('div', 'adm-menu');
    list.hidden = true;
    list.setAttribute('role', 'menu');
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'false');

    const close = () => {
      list.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', onKey, true);
    };
    const outside = (event) => {
      if (!wrap.contains(event.target)) close();
    };
    const onKey = (event) => {
      if (event.key === 'Escape') {
        close();
        trigger.focus();
      }
    };

    trigger.addEventListener('click', () => {
      if (!list.hidden) return close();
      list.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      document.addEventListener('pointerdown', outside, true);
      document.addEventListener('keydown', onKey, true);
      const first = list.querySelector('button');
      if (first) first.focus();
      return undefined;
    });

    for (const item of items) {
      if (!item) continue;
      if (item.separator) {
        list.appendChild(h('div', 'adm-menu-sep'));
        continue;
      }
      const row = h('button', `adm-menu-item${item.danger ? ' is-danger' : ''}`);
      row.type = 'button';
      row.setAttribute('role', 'menuitem');
      row.append(icon(item.icon), h('span', null, item.label));
      row.addEventListener('click', () => {
        close();
        item.onClick();
      });
      list.appendChild(row);
    }

    // Drop a trailing or doubled separator left by items that did not apply.
    list.querySelectorAll('.adm-menu-sep').forEach((sep) => {
      const next = sep.nextElementSibling;
      if (!next || next.classList.contains('adm-menu-sep') || !sep.previousElementSibling) sep.remove();
    });

    wrap.append(trigger, list);
    return wrap;
  }

  // ==========================================
  // PAGE HEADER
  // ==========================================

  /**
   * The one header every admin page has: where you are on the left, what you
   * can do on the right. Navigation belongs to the sidebar, filters to the list
   * they filter - this holds the title and the page's own actions.
   *
   * { back: { label, href }, eyebrow, lead: [nodes], title: string | node,
   *   meta: [nodes], subtitle, actions: [nodes], documentTitle }
   *
   * Returns the title node, so a page can keep it up to date in place.
   */
  function header({ back, eyebrow, lead = [], title = '', meta = [], subtitle, actions = [], documentTitle } = {}) {
    const root = $('admHeader');
    const parts = [];

    if (back) {
      const link = h('a', 'ann-link-btn adm-header-back');
      link.href = back.href;
      link.setAttribute('aria-label', back.label);
      link.append(icon('arrow_back'), h('span', 'adm-hide-narrow', back.label));
      parts.push(link);
    }

    const main = h('div', 'adm-header-main');
    if (eyebrow) main.appendChild(h('p', 'adm-eyebrow', eyebrow));
    const titleNode = typeof title === 'string' ? h('h1', null, title) : title;
    titleNode.classList.add('adm-title');
    const line = h('div', 'adm-header-line');
    line.append(...lead, titleNode, ...meta);
    main.appendChild(line);
    if (subtitle) main.appendChild(h('p', 'adm-subtitle', subtitle));
    parts.push(main);

    if (actions.length) {
      const tools = h('div', 'adm-header-actions');
      tools.append(...actions);
      parts.push(tools);
    }

    root.replaceChildren(...parts);
    const name = documentTitle || titleNode.textContent;
    document.title = name ? `${name} · klndr admin` : 'klndr admin';
    return titleNode;
  }

  // The sticky rows' real heights, for anything that has to sit under them.
  function publishHeights() {
    const bar = $('admMobilebar');
    const head = $('admHeader');
    const style = document.documentElement.style;
    style.setProperty('--adm-topbar', `${bar ? Math.round(bar.getBoundingClientRect().height) : 0}px`);
    style.setProperty('--adm-header', `${head ? Math.round(head.getBoundingClientRect().height) : 0}px`);
  }

  // ==========================================
  // SIDEBAR
  // ==========================================

  const pathFor = (section, subpath = '') => `${BASE}/${section.id}${subpath}`;
  const homePath = () => (sections.length ? pathFor(sections[0]) : BASE);

  function buildNav() {
    const list = h('ul', 'adm-nav-list');
    navLinks.clear();
    for (const section of sections) {
      const item = h('li', 'adm-nav-group');
      const link = h('a', 'adm-nav-link');
      link.href = pathFor(section, section.pages ? section.pages[0].path : '');
      link.append(icon(section.icon), h('span', null, section.label));
      item.appendChild(link);

      const pages = [];
      if (section.pages) {
        const sub = h('ul', 'adm-nav-pages');
        for (const page of section.pages) {
          const row = h('li');
          const pageLink = h('a', 'adm-nav-link adm-nav-page', page.label);
          pageLink.href = pathFor(section, page.path);
          row.appendChild(pageLink);
          sub.appendChild(row);
          pages.push([page.path, pageLink]);
        }
        item.appendChild(sub);
      }
      list.appendChild(item);
      navLinks.set(section, { item, link, pages });
    }
    $('admNav').replaceChildren(list);
    document.querySelectorAll('[data-adm-home]').forEach((link) => {
      link.href = homePath();
    });
  }

  // Exactly one row is the current page. A section with pages is open while
  // you are in it, but it is one of its pages that is current, not the section.
  function syncNav() {
    const mark = (link, on) => {
      if (on) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    };
    for (const [section, { item, link, pages }] of navLinks) {
      const open = section === state.current;
      item.classList.toggle('is-open', open);
      mark(link, open && !section.pages);
      for (const [path, pageLink] of pages) mark(pageLink, open && path === state.subpath);
    }
  }

  const isDrawerOpen = () => document.body.classList.contains('adm-drawer-open');

  function openDrawer() {
    if (!NARROW.matches || isDrawerOpen()) return;
    document.body.classList.add('adm-drawer-open');
    $('admScrim').hidden = false;
    $('admMain').inert = true;
    $('admMobilebar').inert = true;
    $('admMenuButton').setAttribute('aria-expanded', 'true');
    const current = $('admSidebar').querySelector('[aria-current="page"]') || $('admSidebar').querySelector('a');
    if (current) current.focus({ preventScroll: true });
  }

  function closeDrawer({ restoreFocus = false } = {}) {
    if (!isDrawerOpen()) return false;
    document.body.classList.remove('adm-drawer-open');
    $('admScrim').hidden = true;
    $('admMain').inert = false;
    $('admMobilebar').inert = false;
    $('admMenuButton').setAttribute('aria-expanded', 'false');
    if (restoreFocus) $('admMenuButton').focus({ preventScroll: true });
    return true;
  }

  // ==========================================
  // ROUTER
  // ==========================================

  function resolve(pathname) {
    if (pathname !== BASE && !pathname.startsWith(`${BASE}/`)) return null;
    const parts = pathname.slice(BASE.length).split('/').filter(Boolean);
    const section = sections.find((s) => s.id === parts[0]);
    if (!section) return null;
    const subpath = parts.length > 1 ? `/${parts.slice(1).join('/')}` : '';
    if (section.pages && !section.pages.some((page) => page.path === subpath)) return null;
    return { section, subpath };
  }

  // A page with a place in the sidebar, never a post being edited or a draft
  // about to be made: reopening one of those later is not "where I was".
  function remember(section, subpath) {
    try {
      localStorage.setItem(LAST_PAGE_KEY, pathFor(section, section.pages ? subpath : ''));
    } catch (err) {
      // Private windows and blocked storage: /admin just opens the first page.
    }
  }

  function fallbackPath() {
    let last = null;
    try {
      last = localStorage.getItem(LAST_PAGE_KEY);
    } catch (err) {
      last = null;
    }
    return last && resolve(last) ? last : homePath();
  }

  function route() {
    let found = resolve(window.location.pathname);
    if (!found) {
      if (!sections.length) return;
      window.history.replaceState(null, '', fallbackPath());
      found = resolve(window.location.pathname);
      if (!found) return;
    }

    const { section, subpath } = found;
    const fromDrawer = closeDrawer();

    if (section !== state.current) {
      const previous = state.current;
      if (previous && previous.leave) previous.leave();
      state.current = section;
      state.subpath = subpath;
      content().replaceChildren();
      header({ title: section.label });
      if (section.enter) section.enter();
    }
    state.subpath = subpath;
    remember(section, subpath);
    syncNav();
    window.scrollTo(0, 0);
    section.show(subpath);
    if (fromDrawer) content().focus({ preventScroll: true });
  }

  /** Go to an admin URL. Going to where you already are draws it again. */
  function navigate(path, { replace = false } = {}) {
    if (path !== window.location.pathname) {
      window.history[replace ? 'replaceState' : 'pushState'](null, '', path);
    }
    route();
  }

  function onLinkClick(event) {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest('a[href]');
    if (!link || link.target || link.hasAttribute('download')) return;
    const url = new URL(link.href, window.location.href);
    if (url.origin !== window.location.origin) return;
    if (url.pathname !== BASE && !url.pathname.startsWith(`${BASE}/`)) return;
    event.preventDefault();
    navigate(url.pathname);
  }

  // ==========================================
  // START
  // ==========================================

  const content = () => $('adminContent');

  /**
   * Register a section. { id, label, icon, pages?: [{ path, label }],
   * enter?(), show(subpath), leave?() }
   *
   * `pages` are its entries in the sidebar; the first one's path is '' and is
   * the section's own URL. A section without pages gets every URL under its id
   * and reads the rest itself - the Studio routes /edit/12 that way.
   */
  function section(definition) {
    sections.push(definition);
    if (state.started) buildNav();
  }

  function isAt(id, subpath) {
    return Boolean(state.current && state.current.id === id && (subpath === undefined || state.subpath === subpath));
  }

  async function start() {
    state.started = true;
    buildNav();

    document.addEventListener('click', onLinkClick);
    window.addEventListener('popstate', route);

    $('admMenuButton').addEventListener('click', () => (isDrawerOpen() ? closeDrawer() : openDrawer()));
    $('admScrim').addEventListener('click', () => closeDrawer({ restoreFocus: true }));
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && isDrawerOpen()) closeDrawer({ restoreFocus: true });
    });
    NARROW.addEventListener('change', () => {
      closeDrawer();
      publishHeights();
    });
    new ResizeObserver(publishHeights).observe($('admHeader'));
    new ResizeObserver(publishHeights).observe($('admMobilebar'));
    publishHeights();

    try {
      const me = await API.getMe();
      if (!me || !me.user) return; // request() has already gone to /login
      state.me = me.user;
    } catch (err) {
      content().replaceChildren(errorBox(err));
      return;
    }
    if (state.me.role !== 'admin') {
      content().replaceChildren(errorBox({ status: 403 }));
      return;
    }
    $('admWhoami').textContent = `Signed in as ${state.me.username}`;
    route();
  }

  if (document.readyState === 'loading') {
    // Scripts at the end of <body> have all run by then, so every section has
    // registered before the first route.
    document.addEventListener('DOMContentLoaded', start);
  } else {
    setTimeout(start, 0);
  }

  return {
    get me() {
      return state.me;
    },
    section,
    navigate,
    isAt,
    header,
    content,
    ui: { h, icon, button, iconButton, errorBox, toast, dialog, confirmDialog, menu }
  };
})();
