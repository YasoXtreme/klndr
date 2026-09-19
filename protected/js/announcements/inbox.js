// Klndr Announcements (in the app)
//
// Everything a person sees of announcements inside klndr: the unread dot on the
// avatar and the What's new entry in the account menu, the inbox, the reader,
// and the way a new post arrives - as a story, a banner, a corner card, or just
// the dot, whichever it asked for.
//
// It owns its own DOM and needs little from KlndrApp: closing modals, a toast,
// the person's settings, and the screens a post's button can open.

class KlndrAnnouncements {
  // More stories than this at once is a queue, not news. The rest are marked
  // delivered - they will not pop up later - and wait in the inbox, unread.
  static STORY_LIMIT = 3;
  // How long a story has to be on screen before it counts as read. Long enough
  // to rule out tapping straight through, short enough for a one-line post.
  static STORY_DWELL_MS = 1200;
  static CARD_MS = 10000;
  // The beat between a preview ending and heading back to the Studio - long
  // enough to see it ended on purpose.
  static PREVIEW_EXIT_MS = 700;
  static PULSE_MS = 5 * 60 * 1000;
  static PULSE_GAP_MS = 30 * 1000;

  constructor(app) {
    this.app = app;
    this.items = [];
    this.byId = new Map();
    this.unread = 0;
    this.filter = 'all';
    this.preview = false;
    this.previewId = null;
    this.previewFrom = null;
    this.previewNote = null;
    this.previewEnding = false;

    this.reader = null;
    this.readerList = [];
    this.readerIndex = -1;
    this.story = null;
    this.banner = null;
    this.card = null;
    this.thumbs = [];
    this.returnFocus = null;

    this.lastPulseAt = 0;
    this.pulseLatest = undefined;
    this.pulsing = false;

    const $ = (id) => document.getElementById(id);
    this.dom = {
      // The way in is an entry in the account menu; all that shows up top is
      // a dot on the avatar while something is unread.
      trigger: $('userProfileTrigger'),
      dot: $('userUnreadDot'),
      sr: $('userUnreadSr'),
      entry: $('userMenuWhatsNew'),
      count: $('userMenuWhatsNewCount'),
      inbox: $('annInboxModal'),
      filters: $('annInboxFilters'),
      list: $('annInboxList'),
      markAll: $('annMarkAllRead'),
      studio: $('annOpenStudio'),
      readerModal: $('annReaderModal'),
      readerCard: $('annReaderCard'),
      readerHost: $('annReaderHost'),
      readerPrev: $('annReaderPrev'),
      readerNext: $('annReaderNext'),
      readerPosition: $('annReaderPosition'),
      storyModal: $('annStoryModal'),
      storyCard: $('annStoryCard'),
      storyHost: $('annStoryHost'),
      storyProgress: $('annStoryProgress'),
      storySkip: $('annStorySkip'),
      storyBack: $('annStoryBack'),
      storyNext: $('annStoryNext'),
      storyCount: $('annStoryCount'),
      noticeHost: $('annNoticeHost'),
      cardHost: $('annCardHost'),
      live: $('annLive')
    };

    if (this.dom.inbox) this.bind();
  }

  // ==========================================
  // WIRING
  // ==========================================

  bind() {
    const d = this.dom;
    if (d.entry) d.entry.addEventListener('click', () => this.openInbox());
    d.markAll.addEventListener('click', () => this.markAllRead());
    d.readerPrev.addEventListener('click', () => this.readerStep(-1));
    d.readerNext.addEventListener('click', () => this.readerStep(1));
    d.storySkip.addEventListener('click', () => this.app.closeAllModals());
    d.storyBack.addEventListener('click', () => this.storyStep(-1));
    d.storyNext.addEventListener('click', () => this.storyStep(1));
    this.enableSwipe(d.readerHost, (step) => this.readerStep(step));
    this.enableSwipe(d.storyHost, (step) => this.storyStep(step));
    document.addEventListener('keydown', (event) => this.onKeydown(event));
  }

  onKeydown(event) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' ||
      target.tagName === 'SELECT' || target.isContentEditable)) return;

    const step = event.key === 'ArrowRight' ? 1 : -1;
    if (this.story) {
      event.preventDefault();
      this.storyStep(step);
    } else if (this.reader && this.isOpen(this.dom.readerModal)) {
      event.preventDefault();
      this.readerStep(step);
    }
  }

  // Touch only, and only a clearly sideways swipe: the same surface scrolls
  // vertically, and a mouse drag across it is someone selecting text.
  enableSwipe(surface, onStep) {
    let start = null;
    surface.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'touch') start = { x: event.clientX, y: event.clientY };
    });
    surface.addEventListener('pointerup', (event) => {
      if (!start || event.pointerType !== 'touch') return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      start = null;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) onStep(dx < 0 ? 1 : -1);
    });
    surface.addEventListener('pointercancel', () => {
      start = null;
    });
  }

  /**
   * Called by KlndrApp.closeAllModals, which is where every modal close funnels
   * - Escape, a backdrop, a close button, another modal opening. Whatever of
   * ours is no longer open gets torn down here, so a story closed any of those
   * ways still records what was skipped.
   */
  onModalsClosed() {
    if (this.story && !this.isOpen(this.dom.storyModal)) this.closeStories();
    if (this.reader && !this.isOpen(this.dom.readerModal)) {
      this.reader.destroy();
      this.reader = null;
      this.restoreFocus();
    }
    if (!this.isOpen(this.dom.inbox) && this.thumbs.length) {
      this.clearThumbs();
      this.restoreFocus();
    }
    this.checkPreviewOver();
  }

  isOpen(modal) {
    return Boolean(modal && modal.classList.contains('active'));
  }

  el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  icon(name) {
    const glyph = this.el('span', 'material-symbols-outlined', name);
    glyph.setAttribute('aria-hidden', 'true');
    return glyph;
  }

  rememberFocus() {
    if (!this.returnFocus) this.returnFocus = document.activeElement;
  }

  restoreFocus() {
    const target = this.returnFocus;
    this.returnFocus = null;
    if (target && document.contains(target) && typeof target.focus === 'function') {
      target.focus({ preventScroll: true });
    }
  }

  say(message) {
    if (!this.dom.live) return;
    this.dom.live.textContent = '';
    // A change the screen reader can notice, even for the same sentence twice.
    requestAnimationFrame(() => {
      this.dom.live.textContent = message;
    });
  }

  // ==========================================
  // LIFECYCLE
  // ==========================================

  async start() {
    if (!this.dom.inbox) return;
    const admin = Boolean(this.app.user && this.app.user.role === 'admin');
    if (this.dom.studio) this.dom.studio.hidden = !admin;

    const params = new URLSearchParams(window.location.search);
    const previewId = Number(params.get('announcementPreview'));
    const previewFrom = params.get('previewFrom');
    const openId = Number(params.get('announcement'));
    if (params.has('announcementPreview') || params.has('announcement')) {
      params.delete('announcementPreview');
      params.delete('previewFrom');
      params.delete('announcement');
      const query = params.toString();
      window.history.replaceState({}, '', query ? `/?${query}` : '/');
    }

    await this.refresh();

    if (previewId && this.app.user && this.app.user.role === 'admin') {
      await this.playPreview(previewId, previewFrom);
    } else if (openId) {
      await this.openById(openId);
    } else {
      this.arrive({ atBoot: true });
    }

    this.startPulse();
  }

  async refresh() {
    try {
      const data = await API.getAnnouncementFeed();
      if (data) this.setItems(data.announcements || []);
    } catch (err) {
      console.warn('Could not load announcements:', err.message);
    }
  }

  setItems(items) {
    this.items = items;
    this.byId = new Map(items.map((a) => [a.id, a]));
    this.unread = items.filter((a) => a.unread).length;
    this.renderUnread();

    if (this.banner && !this.byId.has(this.banner.item.id)) this.hideBanner();
    if (this.isOpen(this.dom.inbox)) this.renderInbox();
  }

  recount() {
    this.unread = this.items.filter((a) => a.unread).length;
    this.renderUnread();
    if (this.isOpen(this.dom.inbox)) this.renderInbox();
  }

  // Deliberately quiet: a dot on the avatar and a count inside the account
  // menu. A new post has already announced itself by arriving; this is only
  // the reminder that it is there.
  renderUnread() {
    const { dot, sr, count, entry } = this.dom;
    const n = this.unread;
    const label = `${n} unread ${n === 1 ? 'update' : 'updates'}`;
    if (dot) dot.hidden = n === 0;
    if (sr) sr.textContent = n ? `, ${label}` : '';
    if (count) {
      count.hidden = n === 0;
      count.textContent = n > 9 ? '9+' : String(n);
    }
    if (entry) entry.setAttribute('aria-label', n ? `What's new, ${label}` : "What's new");
  }

  // ==========================================
  // RECEIPTS
  // ==========================================

  record(a, event) {
    if (this.preview || !a) return;
    if (event === 'delivered' && a.delivered) return;
    a.delivered = true;
    API.recordAnnouncementEvent(a.id, event);
  }

  markOpened(a) {
    if (this.banner && this.banner.item.id === a.id) this.hideBanner();
    if (a.read) return;
    a.read = true;
    a.unread = false;
    this.record(a, 'opened');
    this.recount();
  }

  async markAllRead() {
    const unread = this.items.filter((a) => a.unread);
    if (!unread.length) return;
    unread.forEach((a) => {
      a.unread = false;
      a.read = true;
      a.delivered = true;
    });
    this.recount();
    if (this.preview) return;
    try {
      await API.markAllAnnouncementsRead();
    } catch (err) {
      this.app.showToast("Couldn't mark those as read. Try again in a moment.", 'error');
      await this.refresh();
    }
  }

  async react(a, reactionId, mounted) {
    const before = { reaction: a.reaction, reactions: { ...a.reactions } };
    const next = a.reaction === reactionId ? null : reactionId;

    // Optimistic, and reconciled with the server's counts when they come back.
    const counts = { ...a.reactions };
    if (a.reaction) counts[a.reaction] = Math.max(0, (counts[a.reaction] || 1) - 1);
    if (next) counts[next] = (counts[next] || 0) + 1;
    a.reaction = next;
    a.reactions = counts;
    if (mounted) mounted.setReactions(a.reaction, a.reactions);
    if (this.preview) return;

    try {
      const result = await API.reactToAnnouncement(a.id, next);
      if (result) {
        a.reaction = result.reaction;
        a.reactions = result.reactions;
        if (mounted) mounted.setReactions(a.reaction, a.reactions);
      }
    } catch (err) {
      a.reaction = before.reaction;
      a.reactions = before.reactions;
      if (mounted) mounted.setReactions(a.reaction, a.reactions);
      this.app.showToast("Couldn't save that reaction.", 'error');
    }
  }

  followCta(a, event) {
    this.record(a, 'cta');
    this.markOpened(a);
    if (!a.cta || !a.cta.app_action) return;
    event.preventDefault();
    this.app.closeAllModals();
    this.runAppAction(a.cta.app_action);
  }

  runAppAction(action) {
    const app = this.app;
    const account = (tab) => {
      app.openAccountModal();
      app.switchAccountTab(tab);
    };
    switch (action) {
      case 'open_categories':
        return account('tabBtnCategories');
      case 'open_integrations':
        return account('tabBtnIntegrations');
      case 'open_account':
        return account('tabBtnSettings');
      case 'open_settings':
        return app.openSettingsModal();
      case 'open_analytics':
        if (app.user && app.user.role === 'admin') {
          // Leaving for another page is not a preview ending: nothing to close.
          if (this.preview) this.previewEnding = true;
          // The logo carries you over, the same as the Admin menu entry.
          if (window.KlndrBoot) KlndrBoot.leave('/admin/analytics', { variant: 'admin' });
          else window.location.href = '/admin/analytics';
        }
        return undefined;
      default:
        return undefined;
    }
  }

  // ==========================================
  // ARRIVAL
  // ==========================================

  /**
   * Put new posts in front of the person, each the way it asked to arrive.
   *
   * Only at boot can a story open. Mid-session nothing blocking ever does -
   * someone could be halfway through dragging a block - so a post that lands
   * while they work arrives as a corner card, whatever it asked for.
   */
  arrive({ atBoot }) {
    const fresh = this.items
      .filter((a) => a.deliverable && !a.delivered)
      .sort((a, b) => (a.publish_at || 0) - (b.publish_at || 0));
    if (!fresh.length) return;

    // A banner stays up until it is dismissed or read, so it is not delivered
    // by being shown - only by being dealt with.
    const banners = fresh.filter((a) => a.delivery === 'banner');
    if (banners.length && (!this.banner || this.banner.item.id !== banners[banners.length - 1].id)) {
      this.showBanner(banners[banners.length - 1], banners.length);
    }

    // "Inbox only" in Settings silences stories and cards; a banner does not
    // block anything, so it still shows.
    if (this.app.settings && this.app.settings.announcementPopups === 'inbox') return;

    const stories = fresh.filter((a) => a.delivery === 'story');
    const cards = fresh.filter((a) => a.delivery === 'card');

    if (atBoot && stories.length && !document.querySelector('.modal-container.active')) {
      this.openStories(stories);
      if (cards.length) this.showCard(cards[cards.length - 1], cards.length - 1);
      return;
    }

    const quiet = atBoot ? cards : [...stories, ...cards];
    if (quiet.length) {
      quiet.slice(0, -1).forEach((a) => this.record(a, 'delivered'));
      this.showCard(quiet[quiet.length - 1], quiet.length - 1);
    }
  }

  startPulse() {
    const beat = () => {
      if (!document.hidden) void this.pulse();
    };
    setInterval(beat, KlndrAnnouncements.PULSE_MS);
    document.addEventListener('visibilitychange', beat);
    window.addEventListener('focus', beat);
  }

  async pulse() {
    if (this.pulsing || this.preview) return;
    if (Date.now() - this.lastPulseAt < KlndrAnnouncements.PULSE_GAP_MS) return;
    this.pulsing = true;
    this.lastPulseAt = Date.now();
    try {
      const data = await API.getAnnouncementPulse();
      if (!data) return;
      const undelivered = this.items.filter((a) => a.deliverable && !a.delivered).length;
      const changed = data.unread !== this.unread ||
        data.undelivered !== undelivered ||
        (this.pulseLatest !== undefined && data.latest_at !== this.pulseLatest);
      this.pulseLatest = data.latest_at;
      if (changed) {
        await this.refresh();
        this.arrive({ atBoot: false });
      }
    } catch (err) {
      console.warn('Could not check for announcements:', err.message);
    } finally {
      this.pulsing = false;
    }
  }

  // ==========================================
  // INBOX
  // ==========================================

  openInbox() {
    // Opened from the account menu, focus sits on a row that is about to be
    // hidden and could not take it back - so the pill the menu hangs from does.
    const fromMenu = Boolean(document.activeElement && document.activeElement.closest('#userMenu'));
    this.app.closeAllModals();
    if (fromMenu && this.dom.trigger) this.returnFocus = this.dom.trigger;
    this.rememberFocus();
    this.dom.inbox.classList.add('active');
    this.renderInbox();
    const first = this.dom.list.querySelector('.ann-inbox-item') || this.dom.markAll;
    if (first) first.focus({ preventScroll: true });
    void this.refresh();
  }

  filteredItems() {
    if (this.filter === 'unread') return this.items.filter((a) => a.unread);
    if (this.filter !== 'all') return this.items.filter((a) => a.kind === this.filter);
    return this.items;
  }

  clearThumbs() {
    this.thumbs.splice(0).forEach((thumb) => thumb.destroy());
  }

  renderInbox() {
    const d = this.dom;
    this.clearThumbs();

    const present = new Set(this.items.map((a) => a.kind));
    const filters = [
      { id: 'all', label: 'All' },
      { id: 'unread', label: this.unread ? `Unread · ${this.unread}` : 'Unread' },
      ...KlndrAnnouncementRules.KINDS.filter((k) => present.has(k.id)).map((k) => ({ id: k.id, label: k.label }))
    ];
    if (!filters.some((f) => f.id === this.filter)) this.filter = 'all';

    d.filters.replaceChildren(...filters.map((filter) => {
      const chip = this.el('button', 'ann-filter', filter.label);
      chip.type = 'button';
      const active = filter.id === this.filter;
      chip.classList.toggle('is-active', active);
      chip.setAttribute('aria-pressed', String(active));
      chip.addEventListener('click', () => {
        this.filter = filter.id;
        this.renderInbox();
      });
      return chip;
    }));
    d.markAll.disabled = this.unread === 0;

    const items = this.filteredItems();
    if (!items.length) {
      d.list.replaceChildren(this.emptyInbox());
      return;
    }
    d.list.replaceChildren(...items.map((a) => this.inboxRow(a, items)));
  }

  emptyInbox() {
    const empty = this.el('div', 'ann-inbox-empty');
    const art = this.el('div', 'ann-inbox-empty-art');
    this.thumbs.push(KlndrAnnouncementMedia.mount(art, {
      type: 'scene',
      aspect: '2:1',
      decorative: true,
      scene: {
        id: 'checklist',
        props: { title: 'All caught up', items: ['Read the news', 'Back to planning'], badge: 'Nice!' }
      }
    }, { thumbnail: true }));
    const title = this.filter === 'unread' || this.items.length ? "You're all caught up" : 'Nothing here yet';
    const note = this.items.length
      ? 'New posts show up here, with a dot on your avatar.'
      : 'When there is news about klndr, it lands here.';
    empty.append(art, this.el('p', 'ann-inbox-empty-title', title), this.el('p', 'ann-inbox-empty-note', note));
    return empty;
  }

  inboxRow(a, list) {
    const row = this.el('button', `ann-inbox-item${a.unread ? ' is-unread' : ''}`);
    row.type = 'button';

    const thumb = this.el('span', 'ann-inbox-thumb');
    if (a.media) {
      this.thumbs.push(KlndrAnnouncementMedia.mount(thumb, { ...a.media, aspect: '16:9' }, { thumbnail: true }));
    } else {
      thumb.classList.add('is-icon');
      thumb.dataset.kind = a.kind;
      thumb.appendChild(this.icon(KlndrAnnouncementRules.kind(a.kind).icon));
    }

    const text = this.el('span', 'ann-inbox-text');
    const meta = this.el('span', 'ann-inbox-meta');
    meta.appendChild(KlndrAnnouncementReader.kindChip(a.kind));
    if (a.pinned) meta.appendChild(this.icon('keep'));
    meta.appendChild(this.el('span', 'ann-inbox-when', KlndrAnnouncementReader.formatAgo(a.publish_at)));

    const title = this.el('span', 'ann-inbox-title');
    if (a.unread) title.appendChild(this.el('span', 'ann-sr-only', 'Unread: '));
    title.appendChild(document.createTextNode(a.title || 'Untitled'));

    const summary = this.el(
      'span',
      'ann-inbox-summary',
      a.summary || KlndrMarkdown.toPlainText(a.body, { format: a.body_format, max: 120 })
    );

    text.append(meta, title, summary);
    row.append(thumb, text);
    if (a.unread) {
      const dot = this.el('span', 'ann-unread-dot');
      dot.setAttribute('aria-hidden', 'true');
      row.appendChild(dot);
    }
    row.addEventListener('click', () => this.openReader(a.id, list));
    return row;
  }

  // ==========================================
  // READER
  // ==========================================

  async openById(id) {
    if (!this.byId.has(id)) {
      try {
        const a = await API.getAnnouncement(id);
        if (!a) return;
        this.items.push(a);
        this.byId.set(a.id, a);
      } catch (err) {
        this.app.showToast("That announcement isn't available.", 'error');
        return;
      }
    }
    this.openReader(id, this.items);
  }

  openReader(id, list) {
    if (!this.byId.has(id)) return;
    const ids = (list || this.items).map((a) => a.id);
    this.readerList = ids.includes(id) ? ids : [id];
    this.rememberFocus();
    this.app.closeAllModals();
    this.dom.readerModal.classList.add('active');
    this.showInReader(id);
    this.dom.readerCard.focus({ preventScroll: true });
  }

  showInReader(id) {
    const d = this.dom;
    const a = this.byId.get(id);
    if (!a) return;
    if (this.reader) this.reader.destroy();

    const mounted = KlndrAnnouncementReader.render(a, {
      mode: 'reader',
      onReact: (reaction) => this.react(a, reaction, mounted),
      onCta: (item, event) => this.followCta(item, event)
    });
    this.reader = mounted;
    d.readerHost.replaceChildren(mounted.element);
    d.readerHost.scrollTop = 0;
    d.readerCard.setAttribute('aria-labelledby', mounted.titleId);

    this.readerIndex = this.readerList.indexOf(id);
    const many = this.readerList.length > 1;
    d.readerPrev.hidden = !many;
    d.readerNext.hidden = !many;
    d.readerPrev.disabled = this.readerIndex <= 0;
    d.readerNext.disabled = this.readerIndex >= this.readerList.length - 1;
    d.readerPosition.textContent = many ? `${this.readerIndex + 1} of ${this.readerList.length}` : '';

    this.markOpened(a);
  }

  readerStep(step) {
    const next = this.readerIndex + step;
    if (next < 0 || next >= this.readerList.length) return;
    this.showInReader(this.readerList[next]);
  }

  // ==========================================
  // STORIES
  // ==========================================

  openStories(items) {
    const limit = KlndrAnnouncements.STORY_LIMIT;
    const queue = items.slice(-limit);
    const overflow = items.slice(0, Math.max(0, items.length - limit));
    overflow.forEach((a) => this.record(a, 'delivered'));

    this.rememberFocus();
    this.app.closeAllModals();
    this.story = { queue, overflow: overflow.length, index: 0, mounted: null, dwell: 0, raf: 0 };
    this.dom.storyModal.classList.add('active');
    this.renderStory();
    this.dom.storyNext.focus({ preventScroll: true });
  }

  storyTotal() {
    return this.story.queue.length + (this.story.overflow ? 1 : 0);
  }

  renderStory() {
    const d = this.dom;
    const s = this.story;
    clearTimeout(s.dwell);
    cancelAnimationFrame(s.raf);
    if (s.mounted) s.mounted.destroy();
    s.mounted = null;

    const total = this.storyTotal();
    d.storyProgress.replaceChildren(...Array.from({ length: total }, (_, i) => {
      const segment = this.el('span', 'ann-story-segment');
      segment.classList.toggle('is-done', i < s.index);
      segment.classList.toggle('is-current', i === s.index);
      return segment;
    }));

    if (s.index < s.queue.length) {
      const a = s.queue[s.index];
      this.record(a, 'delivered');
      const mounted = KlndrAnnouncementReader.render(a, {
        mode: 'story',
        onReact: (reaction) => this.react(a, reaction, mounted),
        onCta: (item, event) => this.followCta(item, event)
      });
      s.mounted = mounted;
      d.storyHost.replaceChildren(mounted.element);
      d.storyCard.setAttribute('aria-labelledby', mounted.titleId);
      s.dwell = setTimeout(() => this.markOpened(a), KlndrAnnouncements.STORY_DWELL_MS);

      // The story's segment is its header's playhead.
      const segment = d.storyProgress.children[s.index];
      let shown = null;
      const follow = () => {
        const progress = mounted.media ? mounted.media.progress() : null;
        const value = progress == null ? '1' : progress.toFixed(3);
        if (value !== shown) segment.style.setProperty('--ann-progress', (shown = value));
        s.raf = requestAnimationFrame(follow);
      };
      follow();
    } else {
      d.storyHost.replaceChildren(this.storyMore(s.overflow));
      d.storyCard.removeAttribute('aria-labelledby');
    }
    d.storyHost.scrollTop = 0;

    d.storyCount.textContent = total > 1 ? `${s.index + 1} of ${total}` : '';
    d.storyBack.hidden = total < 2;
    d.storyBack.disabled = s.index === 0;
    d.storySkip.hidden = s.index >= total - 1;
    d.storyNext.querySelector('.ann-btn-label').textContent = s.index >= total - 1 ? 'Done' : 'Next';
  }

  storyMore(count) {
    const more = this.el('div', 'ann-story-more');
    const art = this.el('div', 'ann-story-more-art');
    art.appendChild(this.icon('inbox'));
    const open = this.el('button', 'ann-btn ann-btn-secondary', 'Open the inbox');
    open.type = 'button';
    open.addEventListener('click', () => this.openInbox());
    more.append(
      art,
      this.el('h2', 'ann-story-more-title', `${count} more ${count === 1 ? 'update is' : 'updates are'} waiting`),
      this.el('p', 'ann-story-more-note', "They're under What's new in your account menu, whenever you want them."),
      open
    );
    return more;
  }

  storyStep(step) {
    if (!this.story) return;
    const next = this.story.index + step;
    if (next < 0) return;
    if (next >= this.storyTotal()) {
      this.app.closeAllModals();
      return;
    }
    this.story.index = next;
    this.renderStory();
  }

  closeStories() {
    const s = this.story;
    if (!s) return;
    this.story = null;
    clearTimeout(s.dwell);
    cancelAnimationFrame(s.raf);
    // Everything after the story they were on was skipped: it will not pop up
    // again, and stays unread in the inbox.
    s.queue.slice(s.index + 1).forEach((a) => this.record(a, 'dismissed'));
    if (s.mounted) s.mounted.destroy();
    this.dom.storyHost.replaceChildren();
    this.dom.storyModal.classList.remove('active');
    this.restoreFocus();
  }

  // ==========================================
  // BANNER AND CORNER CARD
  // ==========================================

  showBanner(a, count = 1) {
    this.hideBanner();
    const notice = this.el('div', 'ann-notice');
    notice.dataset.kind = a.kind;
    notice.setAttribute('role', 'region');
    notice.setAttribute('aria-label', 'Announcement');

    const text = this.el('div', 'ann-notice-text');
    text.appendChild(this.el('strong', 'ann-notice-title', a.title));
    const detail = a.summary || (count > 1 ? `and ${count - 1} more` : '');
    if (detail) text.appendChild(this.el('span', 'ann-notice-summary', detail));

    const read = this.el('button', 'ann-btn ann-btn-primary ann-btn-small', 'Read');
    read.type = 'button';
    read.addEventListener('click', () => this.openReader(a.id, [a]));

    const dismiss = this.el('button', 'ann-icon-btn');
    dismiss.type = 'button';
    dismiss.setAttribute('aria-label', 'Dismiss announcement');
    dismiss.appendChild(this.icon('close'));
    dismiss.addEventListener('click', () => {
      this.record(a, 'dismissed');
      this.hideBanner();
    });

    notice.append(KlndrAnnouncementReader.kindChip(a.kind), text, read, dismiss);
    this.dom.noticeHost.appendChild(notice);
    this.banner = { item: a, element: notice };
    requestAnimationFrame(() => notice.classList.add('is-in'));
  }

  hideBanner() {
    if (!this.banner) return;
    this.banner.element.remove();
    this.banner = null;
    this.checkPreviewOver();
  }

  showCard(a, more = 0) {
    this.hideCard();
    this.record(a, 'delivered');

    const card = this.el('div', 'ann-toast-card');
    card.dataset.kind = a.kind;
    card.setAttribute('role', 'region');
    card.setAttribute('aria-label', 'New announcement');
    const thumbs = [];

    if (a.media) {
      const thumb = this.el('div', 'ann-toast-thumb');
      thumbs.push(KlndrAnnouncementMedia.mount(thumb, { ...a.media, aspect: '16:9' }, { thumbnail: true }));
      card.appendChild(thumb);
    }

    const text = this.el('div', 'ann-toast-text');
    text.append(
      KlndrAnnouncementReader.kindChip(a.kind),
      this.el('strong', 'ann-toast-title', a.title),
      this.el('span', 'ann-toast-summary', more
        ? `and ${more} more in your inbox`
        : a.summary || KlndrMarkdown.toPlainText(a.body, { format: a.body_format, max: 90 }))
    );

    const actions = this.el('div', 'ann-toast-actions');
    const read = this.el('button', 'ann-btn ann-btn-primary ann-btn-small', 'Read');
    read.type = 'button';
    read.addEventListener('click', () => {
      this.hideCard();
      this.openReader(a.id, this.items);
    });
    const later = this.el('button', 'ann-btn ann-btn-ghost ann-btn-small', 'Later');
    later.type = 'button';
    later.addEventListener('click', () => this.hideCard());
    actions.append(read, later);
    text.appendChild(actions);

    const timer = this.el('span', 'ann-toast-timer');
    timer.style.setProperty('--ann-card-ms', `${KlndrAnnouncements.CARD_MS}ms`);
    card.append(text, timer);
    this.dom.cardHost.appendChild(card);

    const state = {
      item: a,
      element: card,
      thumbs,
      remaining: KlndrAnnouncements.CARD_MS,
      startedAt: performance.now(),
      timeout: 0
    };
    const run = () => {
      state.startedAt = performance.now();
      state.timeout = setTimeout(() => this.hideCard(), state.remaining);
      card.classList.remove('is-paused');
    };
    const hold = () => {
      clearTimeout(state.timeout);
      state.remaining = Math.max(1500, state.remaining - (performance.now() - state.startedAt));
      card.classList.add('is-paused');
    };
    card.addEventListener('pointerenter', hold);
    card.addEventListener('pointerleave', run);
    card.addEventListener('focusin', hold);
    card.addEventListener('focusout', (event) => {
      if (!card.contains(event.relatedTarget)) run();
    });

    this.card = state;
    run();
    requestAnimationFrame(() => card.classList.add('is-in'));
    this.say(`New announcement: ${a.title}`);
  }

  hideCard() {
    if (!this.card) return;
    clearTimeout(this.card.timeout);
    this.card.thumbs.forEach((thumb) => thumb.destroy());
    this.card.element.remove();
    this.card = null;
    this.checkPreviewOver();
  }

  // ==========================================
  // PREVIEW (admins, from the Studio)
  // ==========================================

  async playPreview(id, from) {
    let a;
    try {
      a = await API.previewAnnouncement(id);
    } catch (err) {
      this.app.showToast(`Couldn't preview that announcement: ${err.message}`, 'error');
      return;
    }
    if (!a) return;

    this.preview = true;
    this.previewId = a.id;
    this.previewFrom = from;
    this.items = [a, ...this.items.filter((item) => item.id !== a.id)];
    this.byId.set(a.id, a);

    const ribbon = this.el('div', 'ann-preview-ribbon');
    ribbon.setAttribute('role', 'status');
    this.previewNote = this.el('span', null, 'Preview - nothing you do here is recorded');
    ribbon.append(this.icon('visibility'), this.previewNote);
    const end = this.el('a', 'ann-preview-end', 'End preview');
    end.href = `/admin/announcements/edit/${a.id}`;
    end.addEventListener('click', (event) => {
      event.preventDefault();
      this.endPreview();
    });
    ribbon.appendChild(end);
    document.body.appendChild(ribbon);

    if (a.delivery === 'story') this.openStories([a]);
    else if (a.delivery === 'banner') this.showBanner(a);
    else if (a.delivery === 'card') this.showCard(a);
    else this.openReader(a.id, [a]);
  }

  /**
   * A preview is over once nothing of it is left on screen: the story or the
   * reader closed, the banner dismissed, the card gone - and nothing it led to,
   * like the screen its button opened, still open. Checked a tick later, so a
   * hand-off such as a card's Read opening the reader is not taken for an end.
   */
  checkPreviewOver() {
    if (!this.preview || this.previewEnding) return;
    setTimeout(() => {
      if (this.previewEnding || this.story || this.banner || this.card) return;
      if (document.querySelector('.modal-container.active')) return;
      this.endPreview({ finished: true });
    }, 0);
  }

  /**
   * Back to the Studio, as it was left. The Studio opened this tab for the
   * preview, so a script may close it and the browser shows the Studio's tab
   * again; where it had to use its own tab, the Studio is one step back.
   */
  endPreview({ finished = false } = {}) {
    if (this.previewEnding) return;
    this.previewEnding = true;
    if (finished && this.previewNote) this.previewNote.textContent = 'Preview over - back to the studio';

    const leave = () => {
      if (this.previewFrom === 'studio' && window.history.length > 1) {
        window.history.back();
        return;
      }
      if (this.previewFrom === 'tab') window.close();
      // A tab the browser would not let a script close, or a preview opened
      // some other way, goes to the post's editor instead.
      setTimeout(() => {
        if (!window.closed) window.location.replace(`/admin/announcements/edit/${this.previewId}`);
      }, this.previewFrom === 'tab' ? 150 : 0);
    };
    setTimeout(leave, finished ? KlndrAnnouncements.PREVIEW_EXIT_MS : 0);
  }
}
