// Announcement Studio - shared pieces.
//
// The Studio is split across a few files in admin/studio/, each adding to one
// global, KlndrStudio, the way the app's own scripts share KlndrPalette and
// friends. This one holds what every view needs: page state, small DOM
// builders, formatting, and the router. admin/announcements.js boots it.

const KlndrStudio = (() => {
  const Rules = KlndrAnnouncementRules;

  const STATUS_LABELS = {
    draft: 'Draft',
    scheduled: 'Scheduled',
    live: 'Live',
    expired: 'Expired',
    archived: 'Archived'
  };

  const MEDIA_LABELS = {
    image: 'Image',
    animated_image: 'Animation',
    svg: 'SVG',
    video: 'Video',
    lottie: 'Lottie',
    scene: 'Motion scene'
  };

  const ASPECT_LABELS = {
    '2:1': 'Wide (2:1)',
    '16:9': 'Video (16:9)',
    '3:1': 'Banner (3:1)',
    '1:1': 'Square (1:1)'
  };

  const TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'your time zone';

  // Everything the page knows. Views read it; only the loaders and the editor
  // write it.
  const state = {
    me: null,
    users: [],
    list: [],
    storage: null,
    library: null,
    tab: null,
    search: '',
    view: null,
    editor: null
  };

  const main = () => document.getElementById('stMain');

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

  function button(label, { icon: glyph, variant = 'secondary', small = false, onClick, title, ariaLabel } = {}) {
    const node = h('button', `ann-btn ann-btn-${variant}${small ? ' ann-btn-small' : ''}`);
    node.type = 'button';
    if (glyph) node.appendChild(icon(glyph));
    if (label) node.appendChild(h('span', 'ann-btn-label', label));
    if (title) node.title = title;
    if (ariaLabel) node.setAttribute('aria-label', ariaLabel);
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

  function checkbox(label, checked, onChange, hint) {
    const wrap = h('label', 'st-check');
    const input = h('input');
    input.type = 'checkbox';
    input.checked = Boolean(checked);
    input.addEventListener('change', () => onChange(input.checked, input));
    const text = h('span');
    text.appendChild(document.createTextNode(label));
    if (hint) text.appendChild(h('small', null, hint));
    wrap.append(input, text);
    wrap.input = input;
    return wrap;
  }

  function select(options, value, onChange) {
    const node = h('select', 'st-select');
    for (const [optionValue, label] of options) {
      const option = h('option', null, label);
      option.value = optionValue;
      node.appendChild(option);
    }
    node.value = value;
    node.addEventListener('change', () => onChange(node.value));
    return node;
  }

  /** A row of mutually exclusive buttons. options: [{ id, label, icon, ariaLabel }] */
  function segment(options, value, onChange, label) {
    const group = h('div', 'st-segment');
    group.setAttribute('role', 'radiogroup');
    if (label) group.setAttribute('aria-label', label);
    const buttons = options.map((option) => {
      const node = h('button', 'st-segment-btn');
      node.type = 'button';
      node.setAttribute('role', 'radio');
      if (option.icon) node.appendChild(icon(option.icon));
      if (option.label) node.appendChild(document.createTextNode(option.label));
      if (option.ariaLabel) {
        node.setAttribute('aria-label', option.ariaLabel);
        node.title = option.ariaLabel;
      }
      node.addEventListener('click', () => {
        sync(option.id);
        onChange(option.id);
      });
      group.appendChild(node);
      return [option.id, node];
    });
    function sync(current) {
      for (const [id, node] of buttons) {
        node.classList.toggle('is-active', id === current);
        node.setAttribute('aria-checked', String(id === current));
      }
    }
    sync(value);
    group.sync = sync;
    return group;
  }

  /** Mark one .st-choice / .st-tile in a group as the selected one. */
  function selectIn(container, chosen) {
    container.querySelectorAll(':scope > .st-choice, :scope > .st-tile, :scope .st-tile').forEach((node) => {
      const on = node === chosen;
      node.classList.toggle('is-selected', on);
      if (node.hasAttribute('role')) node.setAttribute('aria-checked', String(on));
    });
  }

  /** An analytics-style card: a head with a title, and a body to fill. */
  function section(id, title, subtitle) {
    const box = h('section', 'an-card st-section');
    if (id) box.id = `st-${id}`;
    const head = h('header', 'an-card-head');
    head.appendChild(h('h2', 'an-card-title', title));
    if (subtitle) head.appendChild(h('p', 'an-card-sub', subtitle));
    const body = h('div', 'an-card-body');
    box.append(head, body);
    return { box, body };
  }

  function counterFor(input, max) {
    const counter = h('span', 'st-counter');
    const update = () => {
      const n = input.value.length;
      counter.textContent = `${n}/${max}`;
      counter.classList.toggle('is-near', n > max * 0.9);
    };
    input.addEventListener('input', update);
    update();
    return counter;
  }

  /** A labelled control. Pass `id` to tie a real <label> to it. */
  function field({ label, control, hint, counter, id }) {
    const wrap = h('div', 'st-field');
    const row = h('div', 'st-label-row');
    if (id) {
      control.id = id;
      const text = h('label', 'st-label', label);
      text.htmlFor = id;
      row.appendChild(text);
    } else {
      row.appendChild(h('span', 'st-label', label));
    }
    if (counter) row.appendChild(counter);
    wrap.append(row, control);
    if (hint) wrap.appendChild(h('p', 'st-hint', hint));
    return wrap;
  }

  function statusPill(status) {
    const pill = h('span', 'st-status', STATUS_LABELS[status] || status);
    pill.dataset.status = status;
    return pill;
  }

  function note(kind, glyph, content) {
    const box = h('div', `st-note${kind ? ` is-${kind}` : ''}`);
    box.appendChild(icon(glyph));
    const text = h('div');
    if (typeof content === 'string') text.textContent = content;
    else text.appendChild(content);
    box.appendChild(text);
    return box;
  }

  function storageNote() {
    const text = h('span');
    text.append(
      h('strong', null, 'Uploads are off until storage is set up. '),
      document.createTextNode('Add '),
      h('code', null, 'R2_ACCOUNT_ID'),
      document.createTextNode(', '),
      h('code', null, 'R2_ACCESS_KEY_ID'),
      document.createTextNode(', '),
      h('code', null, 'R2_SECRET_ACCESS_KEY'),
      document.createTextNode(' and '),
      h('code', null, 'R2_BUCKET'),
      document.createTextNode(' to the server environment, then run '),
      h('code', null, 'npm run r2:check'),
      document.createTextNode('. Motion scenes work without it.')
    );
    return note(null, 'cloud_off', text);
  }

  // Cleanups that belong to one part of a view, run before that part redraws.
  function resetPane(node) {
    if (node._studioCleanup) node._studioCleanup();
    node._studioCleanup = null;
  }

  function onReset(node, fn) {
    const previous = node._studioCleanup;
    node._studioCleanup = () => {
      if (previous) previous();
      fn();
    };
  }

  // ==========================================
  // FORMATTING
  // ==========================================

  const nowSeconds = () => Math.floor(Date.now() / 1000);
  const clone = (value) => (value == null ? value : JSON.parse(JSON.stringify(value)));

  const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
  const shortDateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

  function fmtDateTime(seconds) {
    return seconds ? dateTimeFormat.format(new Date(seconds * 1000)) : '';
  }

  function fmtShortDate(date) {
    return shortDateFormat.format(date);
  }

  function fmtBytes(bytes) {
    if (!Number.isFinite(bytes)) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  }

  function fmtPercent(part, whole) {
    return whole ? `${Math.round((part / whole) * 100)}%` : '-';
  }

  function plural(n, one, many) {
    return `${n} ${n === 1 ? one : many}`;
  }

  function toLocalInput(seconds) {
    if (!seconds) return '';
    const d = new Date(seconds * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function fromLocalInput(value) {
    const time = new Date(value).getTime();
    return Number.isFinite(time) ? Math.floor(time / 1000) : null;
  }

  function nextHour() {
    const d = new Date();
    d.setMinutes(0, 0, 0);
    d.setHours(d.getHours() + 1);
    return Math.floor(d.getTime() / 1000);
  }

  function audienceLabel(a) {
    const audience = a.audience || { type: 'everyone' };
    if (audience.type === 'admins') return 'Admins';
    if (audience.type === 'users') return plural((audience.user_ids || []).length, 'person', 'people');
    return 'Everyone';
  }

  function deliveryLabel(id) {
    const delivery = Rules.DELIVERIES.find((d) => d.id === id);
    return delivery ? delivery.label : id;
  }

  // ==========================================
  // FEEDBACK: TOAST, DIALOG, MENU
  // ==========================================

  let toastTimer = 0;
  function toast(message, kind = 'info') {
    const node = document.getElementById('stToast');
    if (!node) return;
    node.textContent = message;
    node.className = `st-toast${kind === 'error' ? ' is-error' : kind === 'success' ? ' is-success' : ''}`;
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      node.hidden = true;
    }, kind === 'error' ? 7000 : 3500);
  }

  function confirmDialog({ title, body, confirm = 'Confirm', danger = false }) {
    return new Promise((resolve) => {
      const dialog = h('dialog', 'st-dialog');
      const content = h('div', 'st-dialog-body');
      content.appendChild(h('h2', null, title));
      if (body) content.appendChild(h('p', null, body));
      const actions = h('div', 'st-dialog-actions');
      const cancel = button('Cancel', { onClick: () => dialog.close('cancel') });
      const ok = button(confirm, { variant: danger ? 'danger' : 'primary', onClick: () => dialog.close('ok') });
      actions.append(cancel, ok);
      dialog.append(content, actions);
      dialog.addEventListener('close', () => {
        dialog.remove();
        resolve(dialog.returnValue === 'ok');
      });
      document.body.appendChild(dialog);
      dialog.showModal();
      // A destructive choice should never be the one Enter lands on.
      (danger ? cancel : ok).focus();
    });
  }

  /** A button that opens a small menu. items: [{ label, icon, onClick, danger } | { separator } | null] */
  function menu(trigger, items) {
    const wrap = h('div', 'st-menu-wrap');
    const list = h('div', 'st-menu');
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
        list.appendChild(h('div', 'st-menu-sep'));
        continue;
      }
      const row = h('button', `st-menu-item${item.danger ? ' is-danger' : ''}`);
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
    list.querySelectorAll('.st-menu-sep').forEach((sep) => {
      const next = sep.nextElementSibling;
      if (!next || next.classList.contains('st-menu-sep') || !sep.previousElementSibling) sep.remove();
    });

    wrap.append(trigger, list);
    return wrap;
  }

  function errorBox(err) {
    const box = h('div', 'an-error');
    box.appendChild(h('p', null,
      err && err.status === 403
        ? 'The studio is for admins. Your account does not have access.'
        : "Couldn't load that."));
    if (err && err.message && err.status !== 403) box.appendChild(h('p', 'an-error-detail', err.message));
    return box;
  }

  // ==========================================
  // PAGE
  // ==========================================

  // The sticky editor bar sits under the sticky topbar, and the preview under
  // both, so their real heights go into custom properties.
  function measureChrome() {
    const topbar = document.querySelector('.an-topbar');
    if (topbar) document.body.style.setProperty('--st-topbar', `${topbar.offsetHeight}px`);
    const bar = document.querySelector('.st-bar');
    if (bar) document.body.style.setProperty('--st-bar', `${bar.offsetHeight}px`);
  }

  /**
   * Open the app with this post playing as it would arrive. Opened before any
   * await, so a popup blocker still sees it as the direct result of a click.
   */
  function previewInApp(id, beforeNavigate) {
    const url = `/?announcementPreview=${encodeURIComponent(id)}`;
    const tab = window.open('', '_blank');
    Promise.resolve(beforeNavigate ? beforeNavigate() : null).finally(() => {
      if (tab) {
        tab.opener = null;
        tab.location.href = url;
      } else {
        window.location.href = url;
      }
    });
  }

  function emptyStats() {
    return { audience: 0, delivered: 0, opened: 0, clicked: 0, reactions: {} };
  }

  function updateListEntry(doc) {
    const index = state.list.findIndex((a) => a.id === doc.id);
    const stats = index >= 0 ? state.list[index].stats : emptyStats();
    if (index >= 0) state.list[index] = { ...doc, stats };
    else state.list.unshift({ ...doc, stats });
  }

  // ==========================================
  // ROUTER
  // ==========================================

  // Filled in by the view files: routes[name](id).
  const routes = {};

  function teardownView() {
    if (state.view && state.view.cleanup) state.view.cleanup();
    state.view = null;
  }

  function route() {
    const [name, rawId] = window.location.hash.replace(/^#\/?/, '').split('/');
    const id = Number(rawId);
    teardownView();
    window.scrollTo(0, 0);
    if (name === 'edit' && id && routes.edit) return routes.edit(id);
    if (name === 'stats' && id && routes.stats) return routes.stats(id);
    if (name === 'new' && routes.create) return routes.create();
    return routes.list ? routes.list() : undefined;
  }

  function go(path) {
    if (window.location.hash === `#${path}`) route();
    else window.location.hash = path;
  }

  return {
    Rules,
    STATUS_LABELS,
    MEDIA_LABELS,
    ASPECT_LABELS,
    TIMEZONE,
    state,
    main,
    h,
    icon,
    button,
    iconButton,
    checkbox,
    select,
    segment,
    selectIn,
    section,
    counterFor,
    field,
    statusPill,
    note,
    storageNote,
    resetPane,
    onReset,
    nowSeconds,
    clone,
    fmtDateTime,
    fmtShortDate,
    fmtBytes,
    fmtPercent,
    plural,
    toLocalInput,
    fromLocalInput,
    nextHour,
    audienceLabel,
    deliveryLabel,
    toast,
    confirmDialog,
    menu,
    errorBox,
    measureChrome,
    previewInApp,
    emptyStats,
    updateListEntry,
    routes,
    route,
    go,
    teardownView
  };
})();
