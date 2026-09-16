// Announcement Studio - the list, and the actions a post's card offers.

(() => {
  const S = KlndrStudio;
  const { Rules, state, h, icon, button, iconButton, statusPill, menu, toast, confirmDialog, go } = S;

  const TABS = [
    { id: 'live', label: 'Live' },
    { id: 'scheduled', label: 'Scheduled' },
    { id: 'draft', label: 'Drafts' },
    { id: 'expired', label: 'Expired' },
    { id: 'archived', label: 'Archived' }
  ];

  // Each tab sorts by the date that matters to it: what went out most recently,
  // what goes out next, what was touched last.
  const SORTS = {
    live: (a, b) => (b.publish_at || 0) - (a.publish_at || 0),
    scheduled: (a, b) => (a.publish_at || 0) - (b.publish_at || 0),
    draft: (a, b) => (b.updated_at || 0) - (a.updated_at || 0),
    expired: (a, b) => (b.expires_at || 0) - (a.expires_at || 0),
    archived: (a, b) => (b.updated_at || 0) - (a.updated_at || 0)
  };

  async function refreshList() {
    const data = await API.listStudioAnnouncements();
    if (data) state.list = data.announcements || [];
    return state.list;
  }

  function counts() {
    const out = {};
    for (const a of state.list) out[a.studio_status] = (out[a.studio_status] || 0) + 1;
    return out;
  }

  function whenLine(a) {
    const parts = [];
    switch (a.studio_status) {
      case 'draft':
        parts.push(`Edited ${KlndrAnnouncementReader.formatAgo(a.updated_at)}`);
        if (a.publish_at) parts.push(`planned for ${S.fmtDateTime(a.publish_at)}`);
        break;
      case 'scheduled':
        parts.push(`Goes out ${S.fmtDateTime(a.publish_at)}`);
        break;
      case 'live':
        parts.push(`Went out ${S.fmtDateTime(a.publish_at)}`);
        if (a.expires_at) parts.push(`until ${S.fmtDateTime(a.expires_at)}`);
        break;
      case 'expired':
        parts.push(`Expired ${S.fmtDateTime(a.expires_at)}`);
        break;
      default:
        parts.push(`Archived ${KlndrAnnouncementReader.formatAgo(a.updated_at)}`);
    }
    parts.push(S.deliveryLabel(a.delivery), S.audienceLabel(a));
    return parts.join(' · ');
  }

  function statsLine(a) {
    const s = a.stats || S.emptyStats();
    const wrap = h('div', 'st-card-stats');
    const add = (glyph, text, title) => {
      const stat = h('span', 'st-stat');
      stat.append(icon(glyph), document.createTextNode(text));
      if (title) stat.title = title;
      wrap.appendChild(stat);
    };
    add('visibility', `${S.fmtPercent(s.opened, s.audience)} opened`, `${s.opened} of ${s.audience}`);
    const reacted = Object.values(s.reactions || {}).reduce((sum, n) => sum + n, 0);
    if (reacted) add('add_reaction', S.plural(reacted, 'reaction', 'reactions'));
    if (a.cta) add('ads_click', `${S.fmtPercent(s.clicked, s.audience)} clicked`, `${s.clicked} of ${s.audience}`);
    return wrap;
  }

  async function transition(a, action, message, confirm) {
    if (confirm && !(await confirmDialog(confirm))) return null;
    try {
      const doc = await API.transitionStudioAnnouncement(a.id, action, { revision: a.revision });
      S.updateListEntry(doc);
      toast(message, 'success');
      return doc;
    } catch (err) {
      toast(err.status === 409 ? 'It changed somewhere else first. Have another look and try again.' : err.message, 'error');
      await refreshList().catch(() => null);
      return null;
    } finally {
      if (state.view && state.view.name === 'list') showList();
    }
  }

  async function duplicate(a) {
    try {
      const copy = await API.transitionStudioAnnouncement(a.id, 'duplicate');
      S.updateListEntry(copy);
      toast('Copied into a new draft.', 'success');
      go(`/edit/${copy.id}`);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function removeAnnouncement(a, { afterwards } = {}) {
    const live = a.studio_status === 'live';
    const ok = await confirmDialog({
      title: `Delete "${a.title || 'Untitled'}"?`,
      body: `${live ? 'It disappears from everyone\'s inbox, and its' : 'Its'} stats and reactions go with it. Uploaded files stay in the library. This can't be undone.`,
      confirm: 'Delete',
      danger: true
    });
    if (!ok) return;
    try {
      await API.deleteStudioAnnouncement(a.id);
      state.list = state.list.filter((item) => item.id !== a.id);
      toast('Deleted.', 'success');
      if (afterwards) afterwards();
      else if (state.view && state.view.name === 'list') showList();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function cardMenu(a) {
    return [
      { label: 'Preview in app', icon: 'open_in_new', onClick: () => S.previewInApp(a.id) },
      { label: 'Duplicate', icon: 'content_copy', onClick: () => duplicate(a) },
      { separator: true },
      a.studio_status === 'archived'
        ? { label: 'Restore to drafts', icon: 'unarchive', onClick: () => transition(a, 'unpublish', 'Back in drafts.') }
        : {
            label: 'Archive',
            icon: 'archive',
            onClick: () => transition(a, 'archive', 'Archived.', a.studio_status === 'live'
              ? { title: 'Archive it?', body: 'It disappears from inboxes. You can restore it to drafts later.', confirm: 'Archive' }
              : null)
          },
      { label: 'Delete', icon: 'delete', danger: true, onClick: () => removeAnnouncement(a) }
    ];
  }

  function card(a, mounted) {
    const article = h('article', 'st-card');

    const media = h('button', 'st-card-media');
    media.type = 'button';
    media.setAttribute('aria-label', `Edit "${a.title || 'Untitled'}"`);
    media.addEventListener('click', () => go(`/edit/${a.id}`));
    if (a.media_resolved) {
      mounted.push(KlndrAnnouncementMedia.mount(media, { ...a.media_resolved, aspect: '16:9' }, { thumbnail: true }));
    } else {
      const placeholder = h('span', 'st-card-placeholder st-kind');
      placeholder.dataset.kind = a.kind;
      placeholder.appendChild(icon(Rules.kind(a.kind).icon));
      media.appendChild(placeholder);
    }

    const body = h('div', 'st-card-body');
    const meta = h('div', 'st-card-meta');
    meta.append(KlndrAnnouncementReader.kindChip(a.kind), statusPill(a.studio_status));
    if (a.pinned) meta.appendChild(icon('keep'));
    const title = h('h3', 'st-card-title');
    const link = h('a', null, a.title || 'Untitled');
    link.href = `#/edit/${a.id}`;
    title.appendChild(link);
    body.append(meta, title, h('p', 'st-card-when', whenLine(a)));
    if (a.published_at && a.studio_status !== 'scheduled' && a.studio_status !== 'draft') {
      body.appendChild(statsLine(a));
    }

    const actions = h('div', 'st-card-actions');
    actions.appendChild(button('Edit', { icon: 'edit', small: true, onClick: () => go(`/edit/${a.id}`) }));
    if (a.published_at) {
      actions.appendChild(button('Stats', { icon: 'monitoring', small: true, variant: 'ghost', onClick: () => go(`/stats/${a.id}`) }));
    }
    actions.append(h('span', 'st-spacer'), menu(iconButton('more_horiz', 'More actions'), cardMenu(a)));

    article.append(media, body, actions);
    return article;
  }

  function emptyState(query, mounted) {
    const empty = h('div', 'st-empty');
    const art = h('div', 'st-empty-art');
    mounted.push(KlndrAnnouncementMedia.mount(art, {
      type: 'scene',
      aspect: '2:1',
      decorative: true,
      scene: { id: 'stamp', props: { label: query ? '?' : 'NEW', sublabel: query ? 'No match' : 'Your first post' } }
    }, { thumbnail: true }));
    empty.appendChild(art);

    if (query) {
      empty.append(h('h3', null, 'Nothing matches'), h('p', null, `No ${state.tab} announcement has "${query}" in it.`));
      return empty;
    }
    const lines = {
      live: ['Nothing is live', 'Published posts show here while they are in people\'s inboxes.'],
      scheduled: ['Nothing scheduled', 'Give a draft a date and it waits here for its moment.'],
      draft: ['No drafts', 'Everything you start, and have not published yet.'],
      expired: ['Nothing has expired', 'Posts that reach their take-down date end up here.'],
      archived: ['Nothing archived', 'Archived posts are out of every inbox, but not gone.']
    }[state.tab];
    empty.append(h('h3', null, lines[0]), h('p', null, lines[1]));
    if (state.tab === 'live' || state.tab === 'draft') {
      empty.appendChild(button('New announcement', { icon: 'add', variant: 'primary', onClick: () => go('/new') }));
    }
    return empty;
  }

  function showList({ fresh = true } = {}) {
    document.title = 'klndr · Announcement Studio';
    const mounted = [];
    state.view = { name: 'list', cleanup: () => mounted.splice(0).forEach((m) => m.destroy()) };

    const tally = counts();
    if (!state.tab || (!tally[state.tab] && !state.search)) {
      state.tab = ['live', 'draft', 'scheduled', 'expired', 'archived'].find((id) => tally[id]) || state.tab || 'live';
    }

    const view = h('section', 'st-view');
    const head = h('div', 'st-list-head');
    const titles = h('div');
    titles.append(
      h('h2', 'st-heading', 'Announcements'),
      h('p', 'st-subheading', "What people find in klndr's What's new inbox, and how each post reaches them.")
    );
    const search = h('label', 'st-search');
    const input = h('input');
    input.type = 'search';
    input.placeholder = 'Search titles';
    input.value = state.search;
    input.setAttribute('aria-label', 'Search announcements');
    search.append(icon('search'), input);
    head.append(titles, search);
    view.appendChild(head);

    if (state.storage && !state.storage.configured) view.appendChild(S.storageNote());

    const tabs = h('div', 'st-tabs');
    tabs.setAttribute('role', 'tablist');
    for (const tab of TABS) {
      const node = h('button', `an-tab${state.tab === tab.id ? ' active' : ''}`);
      node.type = 'button';
      node.setAttribute('role', 'tab');
      node.setAttribute('aria-selected', String(state.tab === tab.id));
      node.append(document.createTextNode(tab.label), h('span', 'st-count', String(tally[tab.id] || 0)));
      node.addEventListener('click', () => {
        state.tab = tab.id;
        S.teardownView();
        showList({ fresh: false });
      });
      tabs.appendChild(node);
    }
    view.appendChild(tabs);

    const grid = h('div', 'st-cards');
    view.appendChild(grid);
    S.main().replaceChildren(view);

    const renderCards = () => {
      mounted.splice(0).forEach((m) => m.destroy());
      const query = state.search.trim().toLowerCase();
      const items = state.list
        .filter((a) => a.studio_status === state.tab)
        .filter((a) => !query || `${a.title} ${a.summary}`.toLowerCase().includes(query))
        .sort(SORTS[state.tab]);
      grid.className = items.length ? 'st-cards' : '';
      grid.replaceChildren(...(items.length ? items.map((a) => card(a, mounted)) : [emptyState(query, mounted)]));
    };
    input.addEventListener('input', () => {
      state.search = input.value;
      renderCards();
    });
    renderCards();

    // Drawn from what is already known, then brought up to date - the stats
    // may have moved since the list was last fetched.
    if (fresh) {
      const shown = state.view;
      refreshList()
        .then(() => {
          if (state.view === shown) {
            S.teardownView();
            showList({ fresh: false });
          }
        })
        .catch(() => null);
    }
  }

  async function createAndEdit() {
    S.main().replaceChildren(h('p', 'an-loading', 'Starting a draft…'));
    try {
      const created = await API.createStudioAnnouncement({
        kind: 'feature',
        delivery: 'story',
        reactions_enabled: true,
        audience: { type: 'everyone', user_ids: [] },
        media: {
          type: 'scene',
          aspect: '2:1',
          fit: 'cover',
          alt: '',
          decorative: false,
          focal: { x: 0.5, y: 0.5 },
          background: null,
          // New headers play once; looping is a switch away.
          scene: { loop: false, clips: [{ id: 'pop-reveal', props: {}, hold: KlndrMotionTimeline.HOLD_DEFAULT }] }
        }
      });
      S.updateListEntry(created);
      window.history.replaceState(null, '', `#/edit/${created.id}`);
      S.route();
    } catch (err) {
      S.main().replaceChildren(S.errorBox(err));
    }
  }

  S.routes.list = showList;
  S.routes.create = createAndEdit;
  S.actions = { refreshList, transition, duplicate, removeAnnouncement };
})();
