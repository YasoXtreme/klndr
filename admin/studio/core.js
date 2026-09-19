// Announcement Studio - shared pieces.
//
// The Studio is the Announcements section of the admin page. It is split
// across a few files in admin/studio/, each adding to one global, KlndrStudio,
// the way the app's own scripts share KlndrPalette and friends. This one holds
// what every view needs: page state, small DOM builders, formatting, and the
// router. admin/announcements.js registers it with the admin shell.

const KlndrStudio = (() => {
  const Rules = KlndrAnnouncementRules;
  // The pieces every admin section shares live in the shell; the Studio's
  // views keep reaching them through KlndrStudio.
  const { h, icon, button, iconButton, toast, confirmDialog, menu, errorBox } = KlndrAdmin.ui;

  const BASE = '/admin/announcements';

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

  const main = () => KlndrAdmin.content();

  // ==========================================
  // DOM
  // ==========================================

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
      else node.classList.add('is-icon');
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

  /**
   * A labelled slider with its value read out beside it. `format` turns the
   * number into the words shown and announced ("2.5 s").
   */
  function slider({ label, id, min, max, step, value, format = String, onInput, hint }) {
    const wrap = h('div', 'st-field st-slider');
    const row = h('div', 'st-label-row');
    const input = h('input', 'st-range');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    const output = h('output', 'st-range-value');
    output.setAttribute('aria-hidden', 'true');

    if (id) {
      input.id = id;
      const text = h('label', 'st-label', label);
      text.htmlFor = id;
      row.appendChild(text);
    } else {
      input.setAttribute('aria-label', label);
      row.appendChild(h('span', 'st-label', label));
    }
    row.appendChild(output);

    const sync = () => {
      const n = Number(input.value);
      output.textContent = format(n);
      input.setAttribute('aria-valuetext', format(n));
      input.style.setProperty('--st-range-fill', `${((n - min) / (max - min)) * 100}%`);
    };
    input.addEventListener('input', () => {
      sync();
      onInput(Number(input.value));
    });
    sync();

    wrap.append(row, input);
    if (hint) wrap.appendChild(h('p', 'st-hint', hint));
    wrap.input = input;
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
  // PAGE
  // ==========================================

  /**
   * Open the app with this post playing as it would arrive. Opened before any
   * await, so a popup blocker still sees it as the direct result of a click.
   *
   * previewFrom tells the app how to come back when the preview ends: by closing
   * the tab opened here, or by stepping back to this page when it had to use
   * this tab.
   */
  function previewInApp(id, beforeNavigate) {
    const tab = window.open('', '_blank');
    const url = `/?announcementPreview=${encodeURIComponent(id)}&previewFrom=${tab ? 'tab' : 'studio'}`;
    Promise.resolve(beforeNavigate ? beforeNavigate() : null).finally(() => {
      if (tab) {
        tab.opener = null;
        tab.location.href = url;
      } else if (window.KlndrBoot) {
        // This tab is going to the app, so the logo carries it over.
        KlndrBoot.leave(url, { variant: 'app' });
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

  // The Studio's own paths - '/', '/new', '/edit/12', '/stats/12' - hang off
  // /admin/announcements. The shell hands over whatever follows that.
  let current = '/';

  function href(path) {
    return path === '/' ? BASE : `${BASE}${path}`;
  }

  /** Still on this Studio path? For a view whose data arrives after a wait. */
  function isAt(path) {
    return KlndrAdmin.isAt('announcements', path === '/' ? '' : path);
  }

  function teardownView() {
    if (state.view && state.view.cleanup) state.view.cleanup();
    state.view = null;
  }

  function route(subpath = current) {
    current = subpath || '/';
    const [name, rawId] = current.replace(/^\/+/, '').split('/');
    const id = Number(rawId);
    teardownView();
    window.scrollTo(0, 0);
    if (name === 'edit' && id && routes.edit) return routes.edit(id);
    if (name === 'stats' && id && routes.stats) return routes.stats(id);
    if (name === 'new' && routes.create) return routes.create();
    return routes.list ? routes.list() : undefined;
  }

  /** Go to a Studio path. Going to where you already are draws it again. */
  function go(path, options) {
    KlndrAdmin.navigate(href(path), options);
  }

  /** The header while a post loads: the way back, and nothing to act on yet. */
  function loadingHeader() {
    KlndrAdmin.header({
      back: { label: 'All announcements', href: href('/') },
      title: '',
      documentTitle: 'Announcements'
    });
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
    slider,
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
    previewInApp,
    emptyStats,
    updateListEntry,
    routes,
    route,
    go,
    href,
    isAt,
    loadingHeader,
    teardownView
  };
})();
