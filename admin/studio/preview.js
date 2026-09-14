// Announcement Studio - the live preview.
//
// Built from the app's own pieces - KlndrAnnouncementReader, the header media,
// announcements.css - so what an admin sees here is what people get. The story,
// inbox, banner and card views are only frames around those pieces, placed
// the way each one sits in the app.

(() => {
  const S = KlndrStudio;
  const { state, h, icon, button, iconButton, segment } = S;

  function previewMedia(ed) {
    const media = ed.draft.media;
    if (!media) return null;
    if (media.type === 'scene' || media.url) return S.clone(media);
    const file = ed.files.get(media.media_id);
    if (!file) return null;
    return { ...S.clone(media), url: file.url, poster_url: file.poster_url, width: file.width, height: file.height };
  }

  function reactionCounts(ed) {
    const counts = { ...((ed.stats && ed.stats.reactions) || {}) };
    if (ed.previewReaction) counts[ed.previewReaction] = (counts[ed.previewReaction] || 0) + 1;
    return counts;
  }

  function asAnnouncement(ed) {
    const d = ed.draft;
    return {
      id: ed.id,
      title: d.title,
      summary: d.summary,
      body: d.body,
      body_format: 'md',
      kind: d.kind,
      media: previewMedia(ed),
      cta: d.cta,
      delivery: d.delivery,
      pinned: d.pinned,
      reactions_enabled: d.reactions_enabled,
      publish_at: ed.doc.publish_at || S.nowSeconds(),
      updated_at: null,
      reaction: ed.previewReaction,
      reactions: reactionCounts(ed),
      unread: true,
      read: false,
      deliverable: true,
      delivered: false
    };
  }

  function announceTheme() {
    const theme = window.KlndrTheme ? KlndrTheme.resolved() : 'light';
    window.dispatchEvent(new CustomEvent('klndr:themechange', { detail: { mode: theme, theme } }));
  }

  // Flips the whole page for as long as this editor is open, without touching
  // the stored preference - closing the editor puts it back.
  function setTheme(ed, theme) {
    if (!ed.themeRestore) {
      const original = document.documentElement.getAttribute('data-theme');
      ed.themeRestore = () => {
        if (original) document.documentElement.setAttribute('data-theme', original);
        else document.documentElement.removeAttribute('data-theme');
        announceTheme();
      };
    }
    document.documentElement.setAttribute('data-theme', theme);
    announceTheme();
  }

  function kindThumb(a, cleanups, className) {
    const thumb = h('span', className);
    if (a.media) {
      const mounted = KlndrAnnouncementMedia.mount(thumb, { ...a.media, aspect: '16:9' }, { thumbnail: true });
      cleanups.push(() => mounted.destroy());
    } else {
      thumb.classList.add('is-icon');
      thumb.dataset.kind = a.kind;
      thumb.appendChild(icon(KlndrAnnouncementRules.kind(a.kind).icon));
    }
    return thumb;
  }

  function excerpt(a, max) {
    return a.summary || KlndrMarkdown.toPlainText(a.body, { max });
  }

  function storyMock(ed, a, cleanups) {
    const card = h('div', 'st-mock-card');
    const top = h('div', 'st-mock-top');
    const progress = h('div', 'ann-story-progress');
    progress.appendChild(h('span', 'ann-story-segment is-done'));
    top.append(progress, iconButton('close', 'Close'));

    const reader = KlndrAnnouncementReader.render(a, {
      mode: 'preview',
      mediaOptions: { controls: true },
      onReact: (reaction) => {
        ed.previewReaction = ed.previewReaction === reaction ? null : reaction;
        reader.setReactions(ed.previewReaction, reactionCounts(ed));
      },
      onCta: (announcement, event) => event.preventDefault()
    });
    cleanups.push(() => reader.destroy());

    const scroll = h('div', 'ann-scroll');
    scroll.appendChild(reader.element);
    const foot = h('div', 'st-mock-foot');
    foot.append(
      button('Skip all', { variant: 'ghost', small: true }),
      button('Done', { variant: 'primary', small: true, icon: 'arrow_forward' })
    );
    card.append(top, scroll, foot);
    return { node: card, player: reader.media ? reader.media.player : null };
  }

  function skeletonRow(width) {
    const row = h('div', 'st-skeleton');
    const lines = h('div');
    const long = h('span');
    long.style.width = `${width}%`;
    const short = h('span');
    short.style.width = `${Math.round(width * 0.6)}%`;
    lines.append(long, short);
    row.append(h('span', 'st-skeleton-thumb'), lines);
    return row;
  }

  function inboxMock(a, cleanups) {
    const inbox = h('div', 'st-mock-inbox');
    const head = h('div', 'ann-inbox-head');
    head.append(h('h2', null, "What's new"), h('span', 'ann-link-btn', 'Mark all read'));

    const row = h('div', 'ann-inbox-item is-unread');
    const text = h('span', 'ann-inbox-text');
    const meta = h('span', 'ann-inbox-meta');
    meta.appendChild(KlndrAnnouncementReader.kindChip(a.kind));
    if (a.pinned) meta.appendChild(icon('keep'));
    meta.appendChild(h('span', 'ann-inbox-when', 'just now'));
    text.append(meta, h('span', 'ann-inbox-title', a.title || 'Untitled'), h('span', 'ann-inbox-summary', excerpt(a, 120)));
    const dot = h('span', 'ann-unread-dot');
    dot.setAttribute('aria-hidden', 'true');
    row.append(kindThumb(a, cleanups, 'ann-inbox-thumb'), text, dot);

    inbox.append(head, row, skeletonRow(80), skeletonRow(64));
    return inbox;
  }

  function appMock(a, mode, cleanups) {
    const app = h('div', 'st-mock-app');
    const topbar = h('div', 'st-mock-topbar');
    topbar.append(h('span', 'st-mock-plate', 'k'), h('span', 'st-mock-pill'));
    app.append(topbar, h('div', 'st-mock-grid'));

    if (mode === 'banner') {
      const notice = h('div', 'ann-notice is-in');
      notice.dataset.kind = a.kind;
      const text = h('div', 'ann-notice-text');
      text.appendChild(h('strong', 'ann-notice-title', a.title || 'Untitled'));
      if (a.summary) text.appendChild(h('span', 'ann-notice-summary', a.summary));
      notice.append(
        KlndrAnnouncementReader.kindChip(a.kind),
        text,
        button('Read', { variant: 'primary', small: true }),
        iconButton('close', 'Dismiss')
      );
      app.appendChild(notice);
      return app;
    }

    const card = h('div', 'ann-toast-card is-in');
    card.dataset.kind = a.kind;
    if (a.media) card.appendChild(kindThumb(a, cleanups, 'ann-toast-thumb'));
    const text = h('div', 'ann-toast-text');
    const actions = h('div', 'ann-toast-actions');
    actions.append(button('Read', { variant: 'primary', small: true }), button('Later', { variant: 'ghost', small: true }));
    text.append(
      KlndrAnnouncementReader.kindChip(a.kind),
      h('strong', 'ann-toast-title', a.title || 'Untitled'),
      h('span', 'ann-toast-summary', excerpt(a, 90)),
      actions
    );
    card.append(text, h('span', 'ann-toast-timer'));
    app.appendChild(card);
    return app;
  }

  function render(ed) {
    const stage = ed.dom.stage;
    if (!stage) return;

    const a = asAnnouncement(ed);
    const sceneId = a.media && a.media.type === 'scene' ? a.media.scene.id : null;
    const aspect = a.media ? a.media.aspect : null;

    // An edit to the words should not restart the animation it sits under.
    const before = ed.preview;
    const resumeAt = before && before.player && before.sceneId === sceneId && before.aspect === aspect
      ? before.player.frame
      : null;
    if (before) before.destroy();

    const cleanups = [];
    const mock = h('div', 'st-mock');
    let player = null;

    if (ed.previewMode === 'story') {
      const story = storyMock(ed, a, cleanups);
      player = story.player;
      mock.appendChild(story.node);
    } else if (ed.previewMode === 'inbox') {
      mock.appendChild(inboxMock(a, cleanups));
    } else {
      mock.appendChild(appMock(a, ed.previewMode, cleanups));
    }

    stage.replaceChildren(mock);
    if (player && resumeAt != null) player.seek(resumeAt);

    ed.preview = {
      player,
      sceneId,
      aspect,
      destroy: () => cleanups.splice(0).forEach((fn) => fn())
    };
  }

  function schedule(ed, { sceneOnly = false } = {}) {
    const media = ed.draft.media;
    const current = ed.preview;
    if (sceneOnly && current && current.player && media && media.type === 'scene' &&
      current.sceneId === media.scene.id && current.aspect === media.aspect) {
      current.player.update(media.scene.props);
      return;
    }
    clearTimeout(ed.previewTimer);
    ed.previewTimer = setTimeout(() => {
      if (state.editor === ed) render(ed);
    }, 180);
  }

  function panel(ed) {
    const aside = h('aside', 'st-preview');
    aside.setAttribute('aria-label', 'Live preview');

    const stage = h('div', 'st-preview-stage');
    stage.dataset.device = ed.previewDevice;
    ed.dom.stage = stage;

    const modes = segment(
      [
        { id: 'story', label: 'Story' },
        { id: 'inbox', label: 'Inbox' },
        { id: 'banner', label: 'Banner' },
        { id: 'card', label: 'Card' }
      ],
      ed.previewMode,
      (mode) => {
        ed.previewMode = mode;
        render(ed);
      },
      'Preview as'
    );
    ed.dom.previewModes = modes;

    const device = segment(
      [
        { id: 'desktop', icon: 'desktop_windows', ariaLabel: 'Desktop width' },
        { id: 'phone', icon: 'smartphone', ariaLabel: 'Phone width' }
      ],
      ed.previewDevice,
      (value) => {
        ed.previewDevice = value;
        stage.dataset.device = value;
      },
      'Width'
    );

    const theme = segment(
      [
        { id: 'light', icon: 'light_mode', ariaLabel: 'Light theme' },
        { id: 'dark', icon: 'dark_mode', ariaLabel: 'Dark theme' }
      ],
      window.KlndrTheme ? KlndrTheme.resolved() : 'light',
      (value) => setTheme(ed, value),
      'Theme'
    );

    const bar = h('div', 'st-preview-bar');
    const tools = h('div', 'st-bar-actions');
    tools.append(device, theme);
    bar.append(modes, tools);

    aside.append(
      bar,
      stage,
      h('p', 'st-preview-note', 'Drawn by the same code the app uses. Reactions here are pretend, and the buttons go nowhere.')
    );
    return aside;
  }

  S.preview = { panel, render, schedule };
})();
