// Klndr Application Coordinator & Main Controller

class KlndrApp {
  constructor() {
    this.user = null;
    this.tasks = [];
    // The person's categories. Empty is the honest starting point: klndr ships
    // none, and an existing user's are migrated server-side on first read.
    this.categories = [];
    this.settings = {
      bucketHours: 2,
      snapToRuler: false,
      tickPercent: 25
    };

    // Where the view starts, as a whole number of days from today, and how
    // many days it shows.
    //
    // Days rather than weeks because the count is now variable: at seven this
    // steps by a week and behaves exactly as it always did, but a three-day
    // view that jumped by a week would skip four days on every press.
    this.dayOffset = 0;
    this.dayCount = KlndrApp.readStoredDayCount();
    this.days = [];

    // Guards the range fetch below - see reloadTasksPreservingHistory.
    this._rangeToken = 0;

    this.canvasRenderer = null;
    this.domRenderer = null;
    this.dragController = null;
    this.sidebarController = null;

    this.selectedTask = null;
    this.previewTaskState = null;

    this.isCalendarCollapsed = false;
    this.isTasksCollapsed = false;

    // Optimistic writes: every local edit bumps a task's revision. A server
    // response is only allowed to overwrite a task whose revision still matches
    // the one that request was issued at, so a slow reply can never resurrect
    // stale values over a newer edit.
    this.taskRevisions = new Map();
    this.pendingWrites = 0;

    // One entry per user gesture, holding both sides of every field it touched.
    this.history = new HistoryStack();

    // Tasks created locally that the server has not acknowledged yet. A task can
    // be dragged onto the calendar the instant it appears, and the server drops
    // updates for ids it has never seen, so every write waits here first.
    this.pendingCreates = new Map();
  }

  /**
   * Hold a write until any task it touches has actually been created. Resolves
   * immediately for tasks the server already knows about, which is all of them
   * in the normal case.
   */
  async awaitCreates(taskIds) {
    const waits = taskIds
      .map(id => this.pendingCreates.get(id))
      .filter(Boolean);
    if (waits.length) await Promise.allSettled(waits);
  }

  bumpRevision(taskId) {
    const rev = (this.taskRevisions.get(taskId) || 0) + 1;
    this.taskRevisions.set(taskId, rev);
    return rev;
  }

  // Mutate in place rather than replacing the object: an in-flight drag holds a
  // direct reference to its task, and swapping the object out from under it
  // would leave the drag editing an orphan.
  static mergeTask(target, source) {
    Object.assign(target, source);
  }

  setPending(delta) {
    this.pendingWrites = Math.max(0, this.pendingWrites + delta);
    const chip = document.getElementById('syncStatusChip');
    if (chip) chip.classList.toggle('is-visible', this.pendingWrites > 0);
  }

  showToast(message, kind = 'info') {
    let el = document.getElementById('klndrToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'klndrToast';
      el.className = 'klndr-toast';
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.className = `klndr-toast is-visible ${kind === 'error' ? 'is-error' : ''}`;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.remove('is-visible'), 4000);
  }

  async init() {
    try {
      // Which days we are looking at is arithmetic on today's date, so it can
      // be settled before the network is touched. That is what lets the tasks
      // request go out alongside the other three instead of behind them.
      this.computeVisibleDays();

      // One round trip of latency instead of four. None of these depend on
      // each other, and on a cold serverless start that difference is most of
      // the wait. Settings and categories degrade to defaults, so they catch
      // their own failures; auth and tasks do not, and are allowed to throw.
      const [authData, userSettings, categories, tasks] = await Promise.all([
        API.getMe(),
        API.getSettings().catch(e => {
          console.warn('Using default settings', e);
          return null;
        }),
        API.getCategories().catch(e => {
          console.warn('Could not load categories', e);
          return null;
        }),
        API.getTasks(this.days[0].startTimestamp, this.lastVisibleDay.endTimestamp).catch(e => {
          // An account awaiting an admin-reset password change is refused by
          // every data endpoint, this one included. That is not a boot failure
          // - it is the forced-password screen below - so swallow it here and
          // let the must_change_password check answer it. Keeping the four
          // calls parallel is worth more than the three wasted 403s, which
          // only happen in that one rare state.
          if (e && e.code === 'password_change_required') return null;
          throw e;
        })
      ]);

      // A 401 in any of the four has already pointed the browser at /login.
      // Leave the boot overlay standing on this path: the page is on its way
      // out, and fading it to reveal an empty board would misdescribe what is
      // about to happen.
      if (!authData || !authData.user) {
        window.location.href = '/login';
        return;
      }
      this.user = authData.user;

      // An admin reset leaves this account able to do exactly one thing, and
      // the server enforces that on every endpoint. Nothing below would have a
      // board to draw, so stop here and put up the screen that lets them
      // comply.
      if (this.user.must_change_password) {
        this.showForcedPasswordChange();
        return;
      }

      this.updateUserUI();

      if (userSettings) {
        this.settings = { ...this.settings, ...userSettings };
      }

      // Before the controllers are built: the sidebar renders its filter pills
      // and its kanban columns from this, and both run during construction.
      this.categories = categories || [];

      const canvasEl = document.getElementById('timelineCanvas');
      const rulerCanvasEl = document.getElementById('timelineRulerCanvas');
      const gutterCanvasEl = document.getElementById('timelineGutterCanvas');
      const scrollContainer = document.getElementById('timeline-workspace');
      const domContainer = document.getElementById('timelineDomOverlay');
      const sidebarContainer = document.getElementById('tasks-sidebar-pane');

      const sharedState = {
        get tasks() { return window.klndr.tasks; },
        get categories() { return window.klndr.categories; },
        get days() { return window.klndr.days; },
        get bucketHours() { return window.klndr.settings.bucketHours; },
        get snapToRuler() { return window.klndr.settings.snapToRuler; },
        get tickPercent() { return window.klndr.settings.tickPercent; }
      };

      this.canvasRenderer = new TimelineCanvas({
        bodyCanvas: canvasEl,
        rulerCanvas: rulerCanvasEl,
        gutterCanvas: gutterCanvasEl,
        scrollContainer,
        viewport: document.getElementById('timelineViewport'),
        domOverlay: domContainer,
        state: sharedState,
        // Geometry and the DOM task blocks must never re-render independently,
        // or the blocks end up positioned against a grid that no longer exists.
        onLayoutChange: () => this.renderTimeline()
      });

      this.domRenderer = new TimelineDOM(domContainer, this.canvasRenderer, sharedState, (action, payload) => {
        this.handleTaskInteraction(action, payload);
      });

      this.dragController = new DragController(
        this.canvasRenderer,
        this.domRenderer,
        sharedState,
        async (updatesList, label) => {
          await this.commitTaskUpdates(updatesList, { label });
        },
        (draggedTaskId, targetTaskId, targetCategory) => {
          this.reorderTasksInList(draggedTaskId, targetTaskId, targetCategory);
        }
      );

      // A drag that starts in the tasks list has to be able to reach the
      // calendar, and on a phone the calendar is not on screen when that drag
      // begins. Handed over as a callback rather than reached through the
      // shared state, because revealing a pane is the app's business.
      this.dragController.onNeedsCalendar = () => {
        if (!this.isCalendarCollapsed) return false;
        this.setCalendarCollapsed(false);
        // Immediately, not on the ResizeObserver: on a coarse pointer that sits
        // behind a 150ms settle timer, and a drag already in flight would spend
        // those frames reading the geometry of a pane that was hidden.
        if (this.canvasRenderer) this.canvasRenderer.resize();
        return true;
      };

      this.sidebarController = new TasksSidebar(
        sidebarContainer,
        sharedState,
        (action, payload) => {
          this.handleTaskInteraction(action, payload);
        },
        (task, clientX, clientY, pointerId) => {
          this.dragController.startSidebarTaskDrag(task, clientX, clientY, pointerId);
        },
        (tasksCollapsed) => {
          this.handleTasksPanelCollapse(tasksCollapsed);
        }
      );

      // Alt-click on a block cuts it where the pointer is, skipping the menu.
      this.dragController.onSplitSegment = (task, segmentId, timestamp) => {
        this.splitSegmentAt(task, segmentId, timestamp);
      };

      this.initInputMode();
      this.initMobileLayout();
      // After initMobileLayout, which is what settles the orientation - and
      // unconditionally, because setOrientation only fires when the orientation
      // actually changes and a desktop boot never changes it.
      if (this.canvasRenderer) this.canvasRenderer.scrollToNow();
      // Stored per device, so it has to be pushed into the controller on every
      // boot rather than only when the select changes.
      this.setTouchSnapPreference(this.touchSnapPreference);
      this.initSwipeNavigation();
      this.initPlacementBar();
      this.initKeyboardListeners();
      this.initUIEventListeners();
      this.initAccountModal();
      this.initFloatingBlockEditor();
      this.initSettingsModal();
      this.initCalendarCollapse();
      this.initAnnouncementsTab();

      // Before loadTasks, not after: this is the only feedback someone gets
      // from a connect attempt, and burying it behind two awaits means a
      // failure anywhere in them swallows the explanation as well as the board.
      this.handleIntegrationRedirect();

      this.applyTasks(tasks);

      // The board is on screen. Everything past this point is allowed to be
      // slow, so nothing past this point is awaited before the overlay lifts.
      const shown = window.KlndrBoot ? KlndrBoot.ready() : Promise.resolve();

      // Chained off the overlay rather than fired here, so an announcement
      // never materialises through the fade.
      shown.then(() => this.initMissedAnnouncementsCarousel());
      // Throttled server-side, so calling it on every load is cheap.
      void this.syncIntegrationsInBackground();

    } catch (err) {
      // Anything thrown above leaves the board half-built, with the date range
      // still reading "Loading...". A console line is not a failure state a
      // person can act on, so say it on screen and name the reason.
      console.error('Failed to initialize klndr:', err);
      const label = document.getElementById('calendarDateRangeLabel');
      if (label) label.textContent = 'Failed to load';
      // The overlay is still up and is the only thing on screen, so the
      // explanation goes there. The toast below still runs, for the case
      // where the overlay has already lifted.
      if (window.KlndrBoot) KlndrBoot.fail(err);
      try {
        this.showToast(`Could not load your board: ${err.message}. Try reloading.`, 'error');
      } catch (toastErr) {
        console.error('Could not surface the failure either:', toastErr);
      }
    }
  }

  /**
   * Reads the `?integration=` the OAuth callback comes back with, says how it
   * went, then strips it so a reload does not repeat the message.
   */
  handleIntegrationRedirect() {
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get('integration');
    if (!outcome) return;

    const detail = params.get('detail');
    const messages = {
      connected: ['Connected. Your outstanding work is in the tasks panel.', 'success'],
      denied: ['Connection cancelled.', 'error'],
      bad_state: ['That connection attempt expired. Try again.', 'error'],
      unknown_provider: ['That integration does not exist.', 'error']
    };
    const [text, kind] = messages[outcome] || [detail || 'Connection failed.', 'error'];
    this.showToast(text, kind);

    params.delete('integration');
    params.delete('detail');
    const query = params.toString();
    window.history.replaceState({}, '', query ? `/?${query}` : '/');
  }

  /**
   * Pulls fresh work from every connected app on load.
   *
   * Silent by design: nobody asked for it, so a source app being down is a
   * console line, not a toast. The tasks panel only repaints when something
   * actually changed, and never through loadTasks(), which would clear undo.
   */
  async syncIntegrationsInBackground() {
    try {
      const providers = await API.getIntegrations();
      const connected = providers.filter(p => p.connected && p.status !== 'reauth_required');
      if (!connected.length) return;

      let changed = false;
      for (const provider of connected) {
        try {
          const result = await API.syncIntegration(provider.id, false);
          if (result && !result.skipped) {
            changed = changed || Boolean(
              result.created || result.updated || result.removed || result.detached
            );
          }
        } catch (err) {
          console.error(`Background sync failed for ${provider.id}:`, err.message);
        }
      }

      // A sync can invent categories as well as tasks - a subject klndr has
      // never seen becomes one - so the list has to be re-read too.
      if (changed) {
        await this.refreshCategories();
        await this.reloadTasksPreservingHistory();
      }
    } catch (err) {
      console.error('Could not check integrations:', err.message);
    }
  }

  updateUserUI() {
    const usernameEl = document.getElementById('topbarUsername');
    if (usernameEl && this.user) {
      usernameEl.textContent = this.user.username;
    }
    const adminTabBtn = document.getElementById('tabBtnAdmin');
    if (adminTabBtn) {
      // '' not 'block': the nav item is a flex row of icon and label, and an
      // inline display would flatten it.
      adminTabBtn.style.display = this.user.role === 'admin' ? '' : 'none';
    }
    const createAnnouncementBtn = document.getElementById('btnCreateAnnouncement');
    if (createAnnouncementBtn) {
      createAnnouncementBtn.style.display = this.user.role === 'admin' ? 'flex' : 'none';
    }
  }

  // Indexed off the end rather than off 6: the strip is only seven days long
  // in one of the four day counts, and every hardcoded 6 was a crash at the
  // other three.
  get lastVisibleDay() {
    return this.days[this.days.length - 1];
  }

  /**
   * Build the visible day strip: `dayCount` days starting `dayOffset` days from
   * today.
   *
   * The seven-day view still snaps back to the Saturday containing its base
   * date, so a week is always a whole week and this reproduces the old
   * computeWeekDays() exactly. Below seven it deliberately does not snap - a
   * three-day view that could only ever start on a Saturday would be unable to
   * show you tomorrow.
   */
  computeVisibleDays() {
    const now = new Date();
    const base = new Date(now.getFullYear(), now.getMonth(), now.getDate() + this.dayOffset);

    // (getDay() + 1) % 7 is the distance back to the containing Saturday.
    if (this.dayCount === 7) base.setDate(base.getDate() - ((base.getDay() + 1) % 7));

    // Normalised AFTER the snap, never before it. setDate carries the
    // wall-clock time along with it, so an anchor that landed on a day whose
    // midnight does not exist - Cairo skips one every spring - would hand its
    // 01:00 to the snapped Saturday, and every day in the strip would inherit
    // it and sit an hour late.
    base.setHours(0, 0, 0, 0);

    this.days = [];

    for (let i = 0; i < this.dayCount; i++) {
      const d = new Date(base);
      d.setDate(base.getDate() + i);
      const startTimestamp = Math.floor(d.getTime() / 1000);

      this.days.push({
        // Read off the date, not off the position in the strip. The old code
        // indexed a Saturday-first name list by i, which is only correct while
        // the strip IS a snapped week - against any other anchor it would
        // quietly label a Tuesday "Sat".
        name: KlndrApp.DAY_NAMES[d.getDay()],
        date: d,
        startTimestamp,
        endTimestamp: startTimestamp + 86400,
        isToday: d.toDateString() === now.toDateString()
      });
    }

    this.updateDateRangeUI();
  }

  /**
   * Move the view, then catch the data up to it.
   *
   * Rendering before the fetch is deliberate: the grid and the date label are
   * pure arithmetic on the anchor, so they can move on the same frame as the
   * press, and the request only fills blocks in behind them. Waiting on the
   * network to redraw the grid would make every arrow press feel like a page
   * load.
   */
  async showRange() {
    const before = this.days.length;
    this.computeVisibleDays();

    // How many days are on screen is a geometry input - a lane is availCross
    // divided by the day count - so changing it has to relayout the canvas, the
    // same way a rotation does. Stepping the arrows changes only which dates
    // the lanes carry, not how many there are, so that stays on the cheap path.
    if (this.canvasRenderer && this.days.length !== before) this.canvasRenderer.resize();

    this.renderAll();
    try {
      await this.reloadTasksPreservingHistory();
    } catch (err) {
      console.error('Could not load that range', err);
      this.showToast("Couldn't load that range. Try again.", 'error');
    }
  }

  /**
   * Step by a whole view rather than by a fixed week, so an arrow always moves
   * you exactly as far as you can see. At seven days that is the week step this
   * has always had.
   */
  stepRange(direction) {
    const next = this.dayOffset + direction * this.dayCount;
    if (Math.abs(next) > KlndrApp.MAX_RANGE_DAYS) return;
    this.dayOffset = next;
    void this.showRange();
  }

  /**
   * How many days are on screen.
   *
   * A separate axis of control from zoom, not another notch on it: time zoom is
   * a magnification the main axis always carries a scrollbar for, while this is
   * a RANGE - it decides which days get fetched. Folding it into `zoom` would
   * make a network request depend on a rendering control.
   */
  async setDayCount(n) {
    if (!KlndrApp.DAY_COUNTS.includes(n) || n === this.dayCount) return;
    this.dayCount = n;
    try {
      localStorage.setItem(KlndrApp.DAY_COUNT_STORAGE_KEY, String(n));
    } catch (e) { /* storage unavailable; the session still honours it */ }
    this.syncDayCountUI();
    await this.showRange();
  }

  /**
   * localStorage is per browser, so this is never shared between someone's
   * phone and their desktop - which is what makes a screen-dependent first-run
   * default safe. Seven columns on a phone are 44px wide and cannot carry a
   * title, so a phone opens at three. Anything stored beats both.
   */
  static readStoredDayCount() {
    try {
      const raw = parseInt(localStorage.getItem(KlndrApp.DAY_COUNT_STORAGE_KEY), 10);
      if (KlndrApp.DAY_COUNTS.includes(raw)) return raw;
    } catch (e) { /* storage unavailable */ }

    // The SCREEN, not the window, and not the phone media query the rest of
    // this file uses. Nothing is stored yet, so this is re-decided on every
    // reload until the person picks for themselves - and a window measured
    // while it is still being restored can be briefly narrow, which would make
    // the default flip between two reloads of the same app on the same machine.
    // Screen width is a fact about the device and does not move.
    const screenWidth = (window.screen && window.screen.width) || window.innerWidth;
    return screenWidth < 768 ? 3 : 7;
  }

  syncDayCountUI() {
    document.querySelectorAll('.day-count-btn').forEach(btn => {
      const on = Number(btn.dataset.days) === this.dayCount;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-pressed', String(on));
    });
    const select = document.getElementById('settingsDayCount');
    if (select) select.value = String(this.dayCount);
  }

  updateZoomUI() {
    if (!this.canvasRenderer) return;
    const zoom = this.canvasRenderer.zoom;
    const undoBtn = document.getElementById('btnUndo');
    const redoBtn = document.getElementById('btnRedo');
    if (undoBtn) undoBtn.addEventListener('click', () => this.undo());
    if (redoBtn) redoBtn.addEventListener('click', () => this.redo());

    const zoomInBtn = document.getElementById('btnZoomIn');
    const zoomOutBtn = document.getElementById('btnZoomOut');
    const zoomFitBtn = document.getElementById('btnZoomFit');

    if (zoomInBtn) zoomInBtn.disabled = zoom >= TimelineCanvas.MAX_ZOOM;
    if (zoomOutBtn) zoomOutBtn.disabled = zoom <= TimelineCanvas.MIN_ZOOM;
    if (zoomFitBtn) zoomFitBtn.disabled = zoom === 1;
  }

  updateDateRangeUI() {
    if (this.days.length === 0) return;

    const dateLabelEl = document.getElementById('calendarDateRangeLabel');
    if (dateLabelEl) dateLabelEl.textContent = this.formatRangeLabel();

    // The arrows step by a view, so what they can reach depends on how wide the
    // view is. Disabling on "the next step would leave the window" keeps them
    // from landing outside it, and at seven days reproduces the old
    // weekOffset +/- 4 bounds exactly.
    const unit = this.dayCount === 7 ? 'week'
      : this.dayCount === 1 ? 'day'
      : `${this.dayCount} days`;

    const prevBtn = document.getElementById('btnPrevWeek');
    if (prevBtn) {
      prevBtn.disabled = this.dayOffset - this.dayCount < -KlndrApp.MAX_RANGE_DAYS;
      prevBtn.title = `Previous ${unit}`;
    }

    const nextBtn = document.getElementById('btnNextWeek');
    if (nextBtn) {
      nextBtn.disabled = this.dayOffset + this.dayCount > KlndrApp.MAX_RANGE_DAYS;
      nextBtn.title = `Next ${unit}`;
    }
  }

  formatRangeLabel() {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const first = this.days[0].date;
    const last = this.lastVisibleDay.date;

    // A single day names itself: there is nothing to range, and the room the
    // dash would have taken says which weekday it is instead.
    if (this.days.length === 1) {
      return `${this.days[0].name}, ${months[first.getMonth()]} ${first.getDate()}`;
    }

    // The year is spelled out on the week view only - it is the one people
    // navigate far enough for it to matter, and it is what that view has always
    // said.
    if (this.days.length === 7) {
      return `${months[first.getMonth()]} ${first.getDate()} – ${months[last.getMonth()]} ${last.getDate()}, ${last.getFullYear()}`;
    }

    // Repeating the month inside a single month reads as two separate dates
    // rather than as one span.
    const to = first.getMonth() === last.getMonth()
      ? `${last.getDate()}`
      : `${months[last.getMonth()]} ${last.getDate()}`;
    return `${months[first.getMonth()]} ${first.getDate()} – ${to}`;
  }

  /**
   * One app-wide record of how the user is actually pointing, stamped on <body>
   * so JS and CSS can both answer it.
   *
   * Deliberately not a device test: a laptop with a touchscreen is whichever
   * one the hand just used, and that changes mid-session. The media query only
   * seeds the first answer, before any pointer has said otherwise.
   */
  initInputMode() {
    const stamp = (mode) => {
      if (document.body.dataset.input !== mode) document.body.dataset.input = mode;
    };

    const coarse = window.matchMedia && window.matchMedia('(hover: none)').matches;
    stamp(coarse ? 'touch' : 'mouse');

    window.addEventListener(
      'pointerdown',
      (e) => stamp(e.pointerType === 'mouse' ? 'mouse' : 'touch'),
      { capture: true, passive: true }
    );
  }

  initKeyboardListeners() {
    const isCalendarFocused = () => {
      const isModalOpen = Boolean(document.querySelector('.modal-container.active, .context-menu.active'));
      if (isModalOpen) return false;

      const activeEl = document.activeElement;
      if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'SELECT' || activeEl.isContentEditable)) {
        return false;
      }

      const calPane = document.getElementById('calendarPane');
      if (calPane && calPane.classList.contains('is-collapsed')) return false;

      return true;
    };

    // Undo is gated on its own terms, not on isCalendarFocused(): it belongs to
    // the whole board, so it still works with the calendar pane collapsed. What
    // it must never do is steal Ctrl+Z from a text field.
    const isTypingTarget = () => {
      const el = document.activeElement;
      return Boolean(el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ||
        el.tagName === 'SELECT' || el.isContentEditable));
    };

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        // Placing a split is the innermost thing Escape can back out of, so it
        // answers first and does not fall through to closing modals.
        if (this.placementActive) {
          void this.cancelPlacement();
          return;
        }
        // A stacked modal dismisses only itself, so escaping out of the
        // category editor leaves the block editor underneath still open.
        if (this.closeTopModal()) return;
        this.closeAllModals();
        return;
      }

      if ((e.ctrlKey || e.metaKey) && !isTypingTarget()) {
        const key = (e.key || '').toLowerCase();
        if (key === 'z') {
          e.preventDefault();
          if (e.shiftKey) this.redo(); else this.undo();
          return;
        }
        // Ctrl+Y is the other redo people reach for on Windows.
        if (key === 'y') {
          e.preventDefault();
          this.redo();
          return;
        }
      }

      if (!isCalendarFocused()) {
        return;
      }

      if (e.key === 'Shift') {
        this.dragController.setModifiers(true, e.ctrlKey || e.metaKey);
      }
      if (e.key === 'Control' || e.key === 'Meta') {
        this.dragController.setModifiers(e.shiftKey, true);
      }
    });

    window.addEventListener('keyup', (e) => {
      if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Meta') {
        if (!isCalendarFocused()) {
          this.dragController.setModifiers(false, false);
          return;
        }
        if (e.key === 'Shift') {
          this.dragController.setModifiers(false, e.ctrlKey || e.metaKey);
        }
        if (e.key === 'Control' || e.key === 'Meta') {
          this.dragController.setModifiers(e.shiftKey, false);
        }
      }
    });

    window.addEventListener('blur', () => {
      if (this.dragController) {
        this.dragController.setModifiers(false, false);
      }
    });

    // An async click handler that throws rejects a promise nobody is holding,
    // so the action silently does nothing at all. Say so instead: a button that
    // appears to work and doesn't is the worst version of a bug.
    window.addEventListener('unhandledrejection', (e) => {
      console.error('Unhandled error', e.reason);
      this.showToast('Something went wrong — that action did not go through.', 'error');
    });
  }

  // Mutual exclusion: Collapsing Calendar expands Task Panel to full multi-column view
  initCalendarCollapse() {
    const calCollapseBtn = document.getElementById('btnCalendarCollapse');
    if (calCollapseBtn) {
      calCollapseBtn.addEventListener('click', () => {
        this.setCalendarCollapsed(!this.isCalendarCollapsed);
      });
    }
  }

  /**
   * The single place the calendar/tasks split is decided.
   *
   * The desktop chevron and the phone tab bar are two ways INTO this, not two
   * implementations of it - which is what keeps the phone layout from needing a
   * state machine of its own. On a phone the collapsed pane is hidden outright
   * rather than reduced to a rail; the stylesheet decides which, so this method
   * is the same on every size.
   */
  setCalendarCollapsed(collapsed) {
    const calPane = document.getElementById('calendarPane');
    if (!calPane) return;

    // Both panes collapsed would leave an empty workspace with no way back.
    if (collapsed && this.isTasksCollapsed) {
      this.isTasksCollapsed = false;
      this.sidebarController.isCollapsed = false;
      document.getElementById('tasks-sidebar-pane').classList.remove('is-collapsed');
      const tasksCollapseIcon = document.getElementById('sidebarCollapseBtn')?.querySelector('.material-symbols-outlined');
      if (tasksCollapseIcon) tasksCollapseIcon.textContent = 'chevron_right';
    }

    this.isCalendarCollapsed = collapsed;
    calPane.classList.toggle('is-collapsed', collapsed);

    const iconSpan = document.getElementById('btnCalendarCollapse')?.querySelector('.material-symbols-outlined');
    if (iconSpan) {
      iconSpan.textContent = collapsed ? 'chevron_right' : 'chevron_left';
    }

    // Toggle multi-column full view on task panel
    this.sidebarController.setFullView(collapsed);
    this.syncMobileTabs();
    // The canvas relayout is driven by the ResizeObserver, so it lands when
    // the pane transition actually settles rather than on a guessed timer.
  }

  /**
   * Which layout the viewport is in, stamped on <body> for the stylesheet and
   * read back by anything whose behaviour differs (the sidebar's kanban, for
   * one). Phone and tablet are genuinely different shapes rather than degrees
   * of the same one: a tablet still fits both panes, a phone never does.
   */
  initMobileLayout() {
    // A phone on its side is 844x390: wide enough to pass a max-width test, and
    // nowhere near tall enough for the two-pane shape that test would hand it.
    // Height is what actually runs out there, so it gets its own clause.
    const phone = window.matchMedia(
      '(max-width: 767px), (max-height: 500px) and (orientation: landscape)'
    );
    const tablet = window.matchMedia('(min-width: 768px) and (max-width: 1023px)');
    // Days become COLUMNS, so what decides this is which way round the screen
    // is, not how big it is: a portrait tablet wants columns as much as a phone
    // does, and a phone on its side wants rows again - it has 844px of width to
    // spend on time and only 390px to divide between days.
    const portrait = window.matchMedia('(max-width: 1023px) and (orientation: portrait)');

    const applyLayout = () => {
      const mode = phone.matches ? 'phone' : (tablet.matches ? 'tablet' : 'desktop');
      const orientation = this.resolveOrientation(portrait.matches);

      // Decided BEFORE the early return below: orientation can change without
      // the mode changing at all - a tablet rotated from landscape to portrait
      // is still 'tablet' - so gating it on the mode would miss the rotation
      // that matters most.
      if (document.body.dataset.orientation !== orientation) {
        document.body.dataset.orientation = orientation;
        if (this.canvasRenderer) this.canvasRenderer.setOrientation(orientation);
      }

      if (document.body.dataset.layout === mode) return;
      document.body.dataset.layout = mode;

      // Growing out of the phone layout must not strand the calendar collapsed:
      // off a phone that state means a 64px rail nobody asked for.
      if (mode !== 'phone' && this.isCalendarCollapsed) {
        this.setCalendarCollapsed(false);
      }
      this.sidebarController.render();
      this.syncMobileTabs();
    };

    applyLayout();
    phone.addEventListener('change', applyLayout);
    tablet.addEventListener('change', applyLayout);
    portrait.addEventListener('change', applyLayout);
    // Belt and braces. The media-query listeners are the precise signal, but
    // they are not always delivered - devtools viewport emulation drops them,
    // and a coalesced window drag can too. applyLayout() returns immediately
    // when the mode has not actually changed, so paying for it on every resize
    // costs nothing and makes an orientation change impossible to miss.
    window.addEventListener('resize', applyLayout);

    document.getElementById('mobileTabCalendar')
      ?.addEventListener('click', () => this.setCalendarCollapsed(false));
    document.getElementById('mobileTabTasks')
      ?.addEventListener('click', () => this.setCalendarCollapsed(true));
  }

  /**
   * Auto by default, but overridable.
   *
   * The override is not only a preference: with no test framework here, being
   * able to force vertical at desktop width is the only practical way to
   * exercise that renderer on a screen big enough to see what is wrong with it.
   */
  // Indexed by Date#getDay(), so Sunday is 0. Deriving the label from the date
  // is what makes an arbitrary anchor safe.
  static DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  static DAY_COUNTS = [1, 3, 5, 7];
  static DAY_COUNT_STORAGE_KEY = 'klndr_day_count';
  // Four weeks either side of today, which is what MAX_MONTH_WEEKS = 4 meant.
  static MAX_RANGE_DAYS = 28;

  static ORIENTATION_STORAGE_KEY = 'klndr_orientation_pref';

  /**
   * Swipe left/right to step the visible range.
   *
   * Three things already want a horizontal touch gesture on this element, so
   * this one stands down for all of them: a long-press drag (body carries
   * is-touch-dragging), a pinch, and - the one that is easy to miss - the cross
   * axis's own scrolling. In vertical mode days are COLUMNS, so when they do not
   * all fit, dragging sideways is how you reach the ones off screen; stealing
   * that would break the seven-day view to improve the three-day one. Hence the
   * crossOverflows check rather than a phone-width check.
   *
   * Passive listeners throughout: this never calls preventDefault, it only
   * watches a gesture the browser is already free to handle, and decides on
   * release.
   */
  initSwipeNavigation() {
    const el = document.getElementById('timeline-workspace');
    if (!el) return;

    // A swipe has to be clearly sideways and clearly deliberate. The 2:1 ratio
    // is what keeps a slightly-diagonal scroll down the time axis from reading
    // as a page turn.
    const MIN_DISTANCE_PX = 60;
    const AXIS_RATIO = 2;
    const MAX_DURATION_MS = 600;

    let start = null;

    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') return;
      start = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId };
    }, { passive: true });

    const clear = () => { start = null; };
    el.addEventListener('pointercancel', clear, { passive: true });

    el.addEventListener('pointerup', (e) => {
      const from = start;
      start = null;
      if (!from || e.pointerId !== from.id) return;

      if (document.body.classList.contains('is-touch-dragging')) return;
      if (this.canvasRenderer && this.canvasRenderer.isPinching && this.canvasRenderer.isPinching()) return;
      if (this.canvasRenderer && this.canvasRenderer.crossOverflows) return;
      if (document.querySelector('.modal-container.active, .context-menu.active')) return;

      const dx = e.clientX - from.x;
      const dy = e.clientY - from.y;
      if (performance.now() - from.t > MAX_DURATION_MS) return;
      if (Math.abs(dx) < MIN_DISTANCE_PX) return;
      if (Math.abs(dx) < Math.abs(dy) * AXIS_RATIO) return;

      // Swiping left drags the days leftward, which brings LATER ones in - the
      // same direction of travel as flicking through photos.
      this.stepRange(dx < 0 ? 1 : -1);
    }, { passive: true });
  }

  /**
   * Which grid a finger drags against.
   *
   * Shift is a held modifier, and there is no held anything on a touchscreen -
   * so the touch translation of it has to be a sticky choice rather than a
   * transient one. Stored per device, and read only while the input is actually
   * touch, so setting it on a touchscreen laptop leaves the Shift key alone.
   */
  static TOUCH_SNAP_STORAGE_KEY = 'klndr_touch_snap';
  static TOUCH_SNAP_MODES = ['off', 'tick', 'bucket'];

  get touchSnapPreference() {
    try {
      const raw = localStorage.getItem(KlndrApp.TOUCH_SNAP_STORAGE_KEY);
      return KlndrApp.TOUCH_SNAP_MODES.includes(raw) ? raw : 'auto';
    } catch (e) {
      return 'auto';
    }
  }

  setTouchSnapPreference(value) {
    const mode = KlndrApp.TOUCH_SNAP_MODES.includes(value) ? value : null;
    try {
      if (mode) localStorage.setItem(KlndrApp.TOUCH_SNAP_STORAGE_KEY, mode);
      else localStorage.removeItem(KlndrApp.TOUCH_SNAP_STORAGE_KEY);
    } catch (e) { /* storage unavailable; the session still honours it */ }
    if (this.dragController) this.dragController.setTouchSnapMode(mode);
  }

  get orientationPreference() {
    try {
      const raw = localStorage.getItem(KlndrApp.ORIENTATION_STORAGE_KEY);
      return raw === 'horizontal' || raw === 'vertical' ? raw : 'auto';
    } catch (e) {
      return 'auto';
    }
  }

  setOrientationPreference(value) {
    try {
      if (value === 'auto') localStorage.removeItem(KlndrApp.ORIENTATION_STORAGE_KEY);
      else localStorage.setItem(KlndrApp.ORIENTATION_STORAGE_KEY, value);
    } catch (e) { /* storage unavailable; the session still honours it */ }
    this._orientationOverride = value === 'auto' ? null : value;
    window.dispatchEvent(new Event('resize'));
  }

  resolveOrientation(autoWantsVertical) {
    const pref = this._orientationOverride || this.orientationPreference;
    if (pref === 'horizontal' || pref === 'vertical') return pref;
    return autoWantsVertical ? 'vertical' : 'horizontal';
  }

  syncMobileTabs() {
    const onTasks = Boolean(this.isCalendarCollapsed);
    const pairs = [
      [document.getElementById('mobileTabCalendar'), !onTasks],
      [document.getElementById('mobileTabTasks'), onTasks]
    ];
    pairs.forEach(([el, active]) => {
      if (!el) return;
      el.classList.toggle('is-active', active);
      el.setAttribute('aria-pressed', String(active));
    });
  }

  // Mutual exclusion: Collapsing Tasks panel
  handleTasksPanelCollapse(tasksCollapsed) {
    this.isTasksCollapsed = tasksCollapsed;

    // If calendar was collapsed, uncollapse calendar first
    if (this.isTasksCollapsed && this.isCalendarCollapsed) {
      this.isCalendarCollapsed = false;
      const calPane = document.getElementById('calendarPane');
      calPane.classList.remove('is-collapsed');
      const calIcon = document.getElementById('btnCalendarCollapse')?.querySelector('.material-symbols-outlined');
      if (calIcon) calIcon.textContent = 'chevron_left';
      this.sidebarController.setFullView(false);
    }
    // Relayout is handled by the ResizeObserver on the timeline scroll container.
  }

  // In-list reordering mechanism
  async reorderTasksInList(draggedTaskId, targetTaskId, targetCategory) {
    const draggedIdx = this.tasks.findIndex(t => t.id === draggedTaskId);
    if (draggedIdx === -1) return;

    const orderBefore = this.tasks.map(t => t.id);
    const changes = [];

    const [draggedTask] = this.tasks.splice(draggedIdx, 1);

    // The uncategorised column hands back a sentinel rather than an empty
    // string, so that dropping into it reads as a real target here instead of
    // as "no column was under the pointer".
    const nextCategory =
      targetCategory === CategoryPicker.UNCATEGORIZED ? null : targetCategory;

    if (targetCategory !== null && nextCategory !== draggedTask.category) {
      changes.push({
        kind: 'update', via: 'patch', id: draggedTask.id,
        before: { category: draggedTask.category },
        after: { category: nextCategory }
      });
      draggedTask.category = nextCategory;
      API.updateTask(draggedTask.id, { category: nextCategory });
    }

    if (targetTaskId && targetTaskId !== draggedTaskId) {
      const targetIdx = this.tasks.findIndex(t => t.id === targetTaskId);
      if (targetIdx !== -1) {
        this.tasks.splice(targetIdx, 0, draggedTask);
      } else {
        this.tasks.push(draggedTask);
      }
    } else {
      this.tasks.push(draggedTask);
    }

    changes.push({ kind: 'order', before: orderBefore, after: this.tasks.map(t => t.id) });
    this.recordHistory({ label: 'Reorder tasks' }, changes);
    this.renderAll();
  }

  /**
   * Swap a task with the row above or below it.
   *
   * Reads the order off the DOM rather than off this.tasks, because what the
   * arrows have to move past is the row the person can actually see - filters
   * and the completed toggle both take rows out, and stepping over a hidden one
   * would look like the press did nothing.
   */
  moveTaskInList(taskId, direction) {
    const rows = [...document.querySelectorAll('#sidebarTasksList .sidebar-task-card')]
      .map(el => el.dataset.taskId);
    const at = rows.indexOf(taskId);
    const neighbour = rows[at + direction];
    if (at === -1 || !neighbour) return;

    const a = this.tasks.findIndex(t => t.id === taskId);
    const b = this.tasks.findIndex(t => t.id === neighbour);
    if (a === -1 || b === -1) return;

    const orderBefore = this.tasks.map(t => t.id);
    [this.tasks[a], this.tasks[b]] = [this.tasks[b], this.tasks[a]];
    this.recordHistory({ label: 'Reorder tasks' },
      [{ kind: 'order', before: orderBefore, after: this.tasks.map(t => t.id) }]);
    this.renderAll();

    // The row is a new element after that render, and pressing the arrow
    // repeatedly walks a task down a list longer than the screen.
    document.querySelector(`#sidebarTasksList .sidebar-task-card[data-task-id="${taskId}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }

  // Rearrange the list to match a recorded order. Anything the order does not
  // mention (created since) keeps its place at the end rather than vanishing.
  applyTaskOrder(ids) {
    const byId = new Map(this.tasks.map(t => [t.id, t]));
    const known = new Set(ids);
    this.tasks = [
      ...ids.map(id => byId.get(id)).filter(Boolean),
      ...this.tasks.filter(t => !known.has(t.id))
    ];
  }

  initUIEventListeners() {
    const prevBtn = document.getElementById('btnPrevWeek');
    const nextBtn = document.getElementById('btnNextWeek');
    const todayBtn = document.getElementById('btnTodayWeek');

    if (prevBtn) prevBtn.addEventListener('click', () => this.stepRange(-1));
    if (nextBtn) nextBtn.addEventListener('click', () => this.stepRange(1));

    if (todayBtn) {
      todayBtn.addEventListener('click', () => {
        if (this.dayOffset === 0) return;
        this.dayOffset = 0;
        void this.showRange();
      });
    }

    document.querySelectorAll('.day-count-btn').forEach(btn => {
      btn.addEventListener('click', () => void this.setDayCount(Number(btn.dataset.days)));
    });
    this.syncDayCountUI();

    const zoomInBtn = document.getElementById('btnZoomIn');
    const zoomOutBtn = document.getElementById('btnZoomOut');
    const zoomFitBtn = document.getElementById('btnZoomFit');

    if (zoomInBtn) {
      zoomInBtn.addEventListener('click', () => {
        this.canvasRenderer.zoomIn();
        this.updateZoomUI();
      });
    }

    if (zoomOutBtn) {
      zoomOutBtn.addEventListener('click', () => {
        this.canvasRenderer.zoomOut();
        this.updateZoomUI();
      });
    }

    if (zoomFitBtn) {
      zoomFitBtn.addEventListener('click', () => {
        this.canvasRenderer.zoomToFit();
        this.updateZoomUI();
      });
    }

    this.updateZoomUI();

    const profilePill = document.getElementById('userProfileTrigger');
    if (profilePill) {
      profilePill.addEventListener('click', () => {
        this.openAccountModal();
      });
    }

    const calSlidersBtn = document.getElementById('btnCalendarSliders');
    if (calSlidersBtn) {
      calSlidersBtn.addEventListener('click', () => {
        this.openSettingsModal();
      });
    }

    document.querySelectorAll('.modal-close-btn, .modal-backdrop').forEach(el => {
      el.addEventListener('click', () => {
        // Same reason as Escape: closeAllModals() also nulls selectedTask,
        // which would leave the block editor on screen editing nothing.
        if (el.closest('.modal-container.modal-layer-top')) this.closeTopModal();
        else this.closeAllModals();
      });
    });
  }

  // ==========================================
  // TABBED ACCOUNT MODAL
  // ==========================================
  /**
   * Show one section of the account modal.
   *
   * Driven by the markup - each nav button names its panel and its heading in
   * data attributes - rather than by two parallel arrays that had to be edited
   * in step. Adding a section is now a button in index.html and nothing here.
   */
  switchAccountTab(btnOrId) {
    const btn = typeof btnOrId === 'string'
      ? document.getElementById(btnOrId)
      : btnOrId;
    if (!btn) return;

    const panel = document.getElementById(btn.dataset.panel);
    if (!panel) return;

    document.querySelectorAll('#accountModal .modal-tab-btn')
      .forEach(b => b.classList.remove('active'));
    document.querySelectorAll('#accountModal .modal-tab-panel')
      .forEach(p => (p.style.display = 'none'));

    btn.classList.add('active');
    panel.style.display = 'block';

    const heading = document.getElementById('accountPanelTitle');
    if (heading) heading.textContent = btn.dataset.title || '';

    // Sections that need data fetch it on the way in, not on every modal open.
    const loaders = {
      tabBtnAdmin: () => this.loadAdminUsersList(),
      tabBtnIntegrations: () => this.loadIntegrationsList(),
      tabBtnAnnouncements: () => this.loadAnnouncementsList(),
      tabBtnCategories: () => this.loadCategoriesTab()
    };
    const load = loaders[btn.id];
    if (load) void load();
  }

  initAccountModal() {
    document.querySelectorAll('#accountModal .modal-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => this.switchAccountTab(btn));
    });

    this.initCategoriesTab();

    // Change Username Form
    const changeUserForm = document.getElementById('changeUsernameForm');
    if (changeUserForm) {
      changeUserForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const newUsername = document.getElementById('inputNewUsername').value.trim();
        const msgEl = document.getElementById('usernameStatusMsg');

        try {
          const res = await API.request('/api/auth/change-username', {
            method: 'POST',
            body: JSON.stringify({ newUsername })
          });
          this.user = res.user;
          this.updateUserUI();
          msgEl.textContent = 'Username updated successfully';
          msgEl.className = 'status-msg success';
        } catch (err) {
          msgEl.textContent = err.message;
          msgEl.className = 'status-msg error';
        }
      });
    }

    // Change Password Form
    const changePassForm = document.getElementById('changePasswordForm');
    if (changePassForm) {
      changePassForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const currentPassword = document.getElementById('inputCurrentPassword').value;
        const newPassword = document.getElementById('inputNewPassword').value;
        const confirmPassword = document.getElementById('inputConfirmPassword').value;
        const msgEl = document.getElementById('passwordStatusMsg');

        try {
          await API.request('/api/auth/change-password', {
            method: 'POST',
            body: JSON.stringify({ currentPassword, newPassword, confirmPassword })
          });
          msgEl.textContent = 'Password updated successfully';
          msgEl.className = 'status-msg success';
          changePassForm.reset();
        } catch (err) {
          msgEl.textContent = err.message;
          msgEl.className = 'status-msg error';
        }
      });
    }

    const logoutBtn = document.getElementById('btnAccountLogout');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', async () => {
        await API.logout();
      });
    }

    // Admin Add Beta User Form
    const adminCreateUserForm = document.getElementById('adminAddUserForm');
    if (adminCreateUserForm) {
      adminCreateUserForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = document.getElementById('adminNewUsername').value.trim();
        const password = document.getElementById('adminNewPassword').value;
        const role = document.getElementById('adminNewRole').value;
        const msgEl = document.getElementById('adminUserStatusMsg');

        try {
          await API.createBetaUser(username, password, role);
          msgEl.textContent = `Created user "${username}" successfully`;
          msgEl.className = 'status-msg success';
          adminCreateUserForm.reset();
          await this.loadAdminUsersList();
        } catch (err) {
          msgEl.textContent = err.message;
          msgEl.className = 'status-msg error';
        }
      });
    }
  }

  // ==========================================
  // INTEGRATIONS
  // ==========================================

  /**
   * Renders one row per provider from the server's connector registry. Nothing
   * here names a particular app, so a new integration appears on its own.
   */
  async loadIntegrationsList() {
    const listEl = document.getElementById('integrationsList');
    const msgEl = document.getElementById('integrationsStatusMsg');
    if (!listEl) return;

    listEl.innerHTML = '<div style="padding:12px 0;font-size:13px;color:#6b7280;">Loading…</div>';
    if (msgEl) { msgEl.textContent = ''; msgEl.className = 'status-msg'; }

    let providers;
    try {
      providers = await API.getIntegrations();
    } catch (err) {
      listEl.innerHTML = '';
      if (msgEl) {
        msgEl.textContent = err.message;
        msgEl.className = 'status-msg error';
      }
      return;
    }

    listEl.innerHTML = '';
    if (!providers.length) {
      listEl.innerHTML = '<div style="padding:12px 0;font-size:13px;color:#6b7280;">No integrations available.</div>';
      return;
    }

    providers.forEach(provider => {
      listEl.appendChild(this.buildIntegrationRow(provider, msgEl));
    });
  }

  buildIntegrationRow(provider, msgEl) {
    const row = document.createElement('div');
    row.style.cssText =
      'display:flex;align-items:flex-start;gap:12px;padding:12px;border:1.5px solid #000;' +
      'border-radius:10px;margin-bottom:10px;background:#fff;';

    const icon = document.createElement('span');
    icon.className = 'material-symbols-outlined';
    icon.style.cssText = 'font-size:24px;flex-shrink:0;margin-top:2px;';
    icon.textContent = provider.icon || 'extension';
    row.appendChild(icon);

    const body = document.createElement('div');
    body.style.cssText = 'flex:1;min-width:0;';

    const title = document.createElement('div');
    title.style.cssText = 'font-weight:700;font-size:14px;';
    title.textContent = provider.label;
    body.appendChild(title);

    const status = document.createElement('div');
    status.style.cssText = 'font-size:12.5px;color:#4b5563;margin-top:2px;line-height:1.45;';
    status.textContent = this.integrationStatusText(provider);
    body.appendChild(status);
    row.appendChild(body);

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:6px;flex-shrink:0;flex-wrap:wrap;';

    if (!provider.available) {
      // Say so rather than offering a button that fails: the only symptom of a
      // missing environment variable is otherwise a dead click.
      const note = document.createElement('span');
      note.style.cssText = 'font-size:12px;color:#9ca3af;';
      note.textContent = 'Not configured';
      actions.appendChild(note);
    } else if (!provider.connected) {
      // A real navigation, not a fetch: this 302s off to the other app.
      const connect = document.createElement('a');
      connect.href = `/api/integrations/${provider.id}/connect`;
      connect.className = 'btn-modal-primary';
      connect.style.cssText = 'height:34px;display:inline-flex;align-items:center;text-decoration:none;';
      connect.textContent = 'Connect';
      actions.appendChild(connect);
    } else {
      const sync = document.createElement('button');
      sync.type = 'button';
      sync.className = 'btn-modal-secondary';
      sync.style.height = '34px';
      sync.textContent = 'Sync now';
      sync.addEventListener('click', async () => {
        sync.disabled = true;
        sync.textContent = 'Syncing…';
        try {
          const result = await API.syncIntegration(provider.id, true);
          await this.reloadTasksPreservingHistory();
          if (msgEl) {
            msgEl.textContent = this.syncSummary(result);
            msgEl.className = 'status-msg success';
          }
        } catch (err) {
          if (msgEl) {
            msgEl.textContent = err.message;
            msgEl.className = 'status-msg error';
          }
        } finally {
          await this.loadIntegrationsList();
        }
      });
      actions.appendChild(sync);

      if (provider.dismissed_count > 0) {
        const restore = document.createElement('button');
        restore.type = 'button';
        restore.className = 'btn-modal-secondary';
        restore.style.height = '34px';
        restore.textContent = `Restore ${provider.dismissed_count}`;
        restore.title = 'Bring back imported tasks you deleted here';
        restore.addEventListener('click', async () => {
          restore.disabled = true;
          try {
            await API.undismissIntegration(provider.id);
            await this.reloadTasksPreservingHistory();
          } catch (err) {
            if (msgEl) {
              msgEl.textContent = err.message;
              msgEl.className = 'status-msg error';
            }
          } finally {
            await this.loadIntegrationsList();
          }
        });
        actions.appendChild(restore);
      }

      const disconnect = document.createElement('button');
      disconnect.type = 'button';
      disconnect.className = 'btn-modal-danger';
      disconnect.style.height = '34px';
      disconnect.textContent = 'Disconnect';
      disconnect.addEventListener('click', async () => {
        const ok = window.confirm(
          `Disconnect ${provider.label}?\n\n` +
            'Imported tasks you have already placed on the calendar stay, as ordinary ' +
            'klndr tasks. Ones still waiting in the tasks panel are removed.'
        );
        if (!ok) return;
        disconnect.disabled = true;
        try {
          const result = await API.disconnectIntegration(provider.id);
          await this.reloadTasksPreservingHistory();
          if (msgEl) {
            msgEl.textContent = `Disconnected. Kept ${result.kept} scheduled task${result.kept === 1 ? '' : 's'}, removed ${result.deleted}.`;
            msgEl.className = 'status-msg success';
          }
        } catch (err) {
          if (msgEl) {
            msgEl.textContent = err.message;
            msgEl.className = 'status-msg error';
          }
        } finally {
          await this.loadIntegrationsList();
        }
      });
      actions.appendChild(disconnect);
    }

    row.appendChild(actions);
    return row;
  }

  integrationStatusText(provider) {
    if (!provider.available) {
      return 'This integration is not set up on the server yet.';
    }
    if (!provider.connected) return 'Not connected.';
    if (provider.status === 'reauth_required') {
      return 'The connection expired. Disconnect and connect again to resume syncing.';
    }

    const parts = [];
    parts.push(provider.account_label ? `Connected as ${provider.account_label}` : 'Connected');
    if (provider.last_synced_at) {
      parts.push(`synced ${KlndrApp.relativeTime(provider.last_synced_at)}`);
    }
    if (provider.last_sync_error) parts.push(`last error: ${provider.last_sync_error}`);
    return parts.join(' · ');
  }

  syncSummary(result) {
    if (!result) return 'Sync finished.';
    if (result.skipped) return 'Already up to date.';
    const bits = [];
    if (result.created) bits.push(`${result.created} imported`);
    if (result.updated) bits.push(`${result.updated} updated`);
    if (result.removed) bits.push(`${result.removed} removed`);
    if (result.completionPushed) bits.push(`${result.completionPushed} pushed`);
    return bits.length ? `Sync finished: ${bits.join(', ')}.` : 'Sync finished, nothing changed.';
  }

  static relativeTime(unixSeconds) {
    const seconds = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  /**
   * Re-fetch the week after a sync without calling loadTasks(), which clears
   * the undo stack. A sync is a background event and must not silently throw
   * away work the person could still undo.
   */
  async reloadTasksPreservingHistory() {
    const token = ++this._rangeToken;
    const startDate = this.days[0].startTimestamp;
    const endDate = this.lastVisibleDay.endTimestamp;
    const tasks = await API.getTasks(startDate, endDate);

    // A held arrow key and a background sync both issue these, and a slow one
    // can come back after the view has already moved on - which would repaint
    // a range nobody is looking at any more. Only the newest may publish.
    if (token !== this._rangeToken) return;

    tasks.forEach(t => TaskModel.ensureSegments(t));
    this.tasks = tasks;
    this.renderAll();
  }

  /**
   * Tells a source app that an imported task's completion changed.
   *
   * Completion reaches the server by two different paths - a task with no
   * segments goes through optimisticTaskUpdate, one with segments through
   * commitTaskUpdates - so this is called from both rather than living inside
   * either. Failures are ignored on purpose: the next sync reconciles, and a
   * toast about a background push would be noise.
   */
  pushSourceCompletion(taskIds) {
    const seen = new Set();
    taskIds.forEach(id => {
      if (seen.has(id)) return;
      seen.add(id);
      const task = this.tasks.find(t => t.id === id);
      if (!task || !task.source_app) return;
      if (Boolean(task.completed) === Boolean(task.source_completed)) return;
      task.source_completed = Boolean(task.completed);
      API.pushIntegrationCompletion(task.source_app, task.id);
    });
  }

  /**
   * The one state where the board is unreachable: an admin reset the password,
   * and the server refuses every call but the change itself until it is
   * replaced. Deliberately offers no dismiss - the only ways out are setting a
   * password or logging out.
   */
  showForcedPasswordChange() {
    const modal = document.getElementById('forcedPasswordModal');
    const form = document.getElementById('forcedPasswordForm');
    const msgEl = document.getElementById('forcedPasswordStatusMsg');

    if (!modal || !form) {
      // No markup to render into. Say it plainly rather than stranding someone
      // on a board that will refuse every single thing they try.
      if (window.KlndrBoot) KlndrBoot.ready();
      this.showToast(
        'Your password was reset by an administrator. Log out and sign in again to set a new one.',
        'error'
      );
      return;
    }

    // init returned early, so the boot overlay is still up - and at z-index
    // 9999 it would bury this. Chained rather than fired alongside, so the
    // card does not materialise through the fade.
    const shown = window.KlndrBoot ? KlndrBoot.ready() : Promise.resolve();
    shown.then(() => {
      modal.classList.add('active');
      const firstField = document.getElementById('forcedCurrentPassword');
      if (firstField) firstField.focus();
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const currentPassword = document.getElementById('forcedCurrentPassword').value;
      const newPassword = document.getElementById('forcedNewPassword').value;
      const confirmPassword = document.getElementById('forcedConfirmPassword').value;

      try {
        await API.request('/api/auth/change-password', {
          method: 'POST',
          body: JSON.stringify({ currentPassword, newPassword, confirmPassword })
        });
        msgEl.textContent = 'Password set. Loading your board...';
        msgEl.className = 'status-msg success';
        // Reload rather than resuming init: the flag is cleared server-side
        // now, and a clean boot is simpler than unwinding one that stopped
        // half way through.
        window.location.reload();
      } catch (err) {
        msgEl.textContent = err.message;
        msgEl.className = 'status-msg error';
      }
    });

    const logoutBtn = document.getElementById('forcedPasswordLogout');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', async () => {
        await API.logout();
      });
    }
  }

  /**
   * The one and only time this password is legible. Nothing stores it in
   * recoverable form, so it stays on screen until the admin navigates away
   * rather than auto-dismissing. Built with textContent, not innerHTML: the
   * username is echoed back and has never been escaped anywhere.
   */
  showTempPassword(username, tempPassword) {
    const anchor = document.getElementById('adminUserStatusMsg');
    if (!anchor) return;
    document.querySelectorAll('.admin-temp-password').forEach(el => el.remove());

    const box = document.createElement('div');
    box.className = 'admin-temp-password';

    const code = document.createElement('code');
    code.textContent = tempPassword;

    const note = document.createElement('p');
    note.textContent =
      `Temporary password for ${username}. Hand it over directly — it will not ` +
      `be shown again. They are signed out everywhere as of now, and must set ` +
      `their own password at their next login.`;

    box.append(code, note);
    anchor.insertAdjacentElement('afterend', box);
  }

  async loadAdminUsersList() {
    const listContainer = document.getElementById('adminUsersTableBody');
    if (!listContainer) return;
    listContainer.innerHTML = '<tr><td colspan="4" style="text-align:center;">Loading users...</td></tr>';

    try {
      const data = await API.request('/api/admin/users');
      listContainer.innerHTML = '';

      if (!data.users || data.users.length === 0) {
        listContainer.innerHTML = '<tr><td colspan="4" style="text-align:center;">No users registered</td></tr>';
        return;
      }

      data.users.forEach(u => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td><strong>${u.username}</strong></td>
          <td>
            <span class="role-badge ${u.role}">${u.role}</span>
            ${u.must_change_password ? '<span class="reset-pending-badge">reset pending</span>' : ''}
          </td>
          <td>${new Date(u.created_at * 1000).toLocaleDateString()}</td>
          <td>
            ${u.username !== this.user.username ? `
              <div class="admin-user-actions">
                <button type="button" class="btn-reset-user" data-username="${u.username}" title="Reset Password">
                  <span class="material-symbols-outlined" style="font-size: 16px;">lock_reset</span>
                </button>
                <button type="button" class="btn-delete-user" data-username="${u.username}" title="Delete User">
                  <span class="material-symbols-outlined" style="font-size: 16px;">delete</span>
                </button>
              </div>
            ` : '<span style="color:#9ca3af;font-size:12px;">(You)</span>'}
          </td>
        `;
        listContainer.appendChild(tr);
      });

      listContainer.querySelectorAll('.btn-reset-user').forEach(btn => {
        btn.addEventListener('click', async () => {
          const username = btn.dataset.username;
          if (!confirm(`Reset the password for "${username}"?\n\nThis signs them out of every device immediately, and they must set a new password at their next login.`)) {
            return;
          }
          const msgEl = document.getElementById('adminUserStatusMsg');
          try {
            const res = await API.resetUserPassword(username);
            if (msgEl) {
              msgEl.textContent = '';
              msgEl.className = 'status-msg';
            }
            this.showTempPassword(res.username, res.tempPassword);
            await this.loadAdminUsersList();
          } catch (err) {
            if (msgEl) {
              msgEl.textContent = err.message;
              msgEl.className = 'status-msg error';
            }
          }
        });
      });

      listContainer.querySelectorAll('.btn-delete-user').forEach(btn => {
        btn.addEventListener('click', async () => {
          const username = btn.dataset.username;
          if (confirm(`Are you sure you want to delete user "${username}"?`)) {
            await API.request(`/api/admin/users/${username}`, { method: 'DELETE' });
            await this.loadAdminUsersList();
          }
        });
      });
    } catch (err) {
      listContainer.innerHTML = `<tr><td colspan="4" style="color:red;">${err.message}</td></tr>`;
    }
  }

  // ==========================================
  // FLOATING BLOCK PREVIEW MODAL (Pure card with Cancel / Apply)
  // ==========================================
  initFloatingBlockEditor() {
    const previewCard = document.getElementById('previewCardElement');
    const titleInput = document.getElementById('previewTaskTitleInput');
    const iconBtn = document.getElementById('btnPreviewIcon');
    const colorBtn = document.getElementById('btnPreviewColor');
    const categoryBtn = document.getElementById('btnPreviewCategory');

    const iconPopup = document.getElementById('previewIconPopup');
    const colorPopup = document.getElementById('previewColorPopup');
    const categoryPopup = document.getElementById('previewCategoryPopup');

    const applyBtn = document.getElementById('btnApplyBlockPreview');
    const cancelBtn = document.getElementById('btnCancelBlockPreview');

    const closePopups = () => {
      if (iconPopup) iconPopup.style.display = 'none';
      if (colorPopup) colorPopup.style.display = 'none';
      if (categoryPopup) categoryPopup.style.display = 'none';
    };

    if (iconPopup) {
      iconPopup.innerHTML = '';
      KlndrPalette.icons.forEach(iconName => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'picker-item-icon';
        item.innerHTML = `<span class="material-symbols-outlined">${iconName}</span>`;
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          this.previewTaskState.icon = iconName;
          document.getElementById('previewCardBadgeIcon').textContent = iconName;
          iconBtn.querySelector('.material-symbols-outlined').textContent = iconName;
          closePopups();
        });
        iconPopup.appendChild(item);
      });
    }

    if (colorPopup) {
      colorPopup.innerHTML = '';
      KlndrPalette.colors.forEach(colorHex => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'picker-item-color';
        item.style.backgroundColor = colorHex;
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          this.previewTaskState.color = colorHex;
          previewCard.style.backgroundColor = colorHex;
          closePopups();
        });
        colorPopup.appendChild(item);
      });
    }

    // Built on open rather than here: this runs before the first task load, so
    // anything populated now would be a snapshot of nothing.
    const renderCategoryPopup = () => {
      CategoryPicker.render(categoryPopup, {
        categories: this.categories,
        selectedName: this.previewTaskState && this.previewTaskState.category,
        onPick: (category) => {
          this.applyCategoryToPreview(category, previewCard, iconBtn);
          closePopups();
        },
        onEdit: (category) => {
          closePopups();
          this.openCategoryEditModal(category);
        },
        onCreate: () => {
          closePopups();
          this.openCategoryEditModal(null);
        }
      });
    };

    if (iconBtn) {
      iconBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = iconPopup.style.display === 'grid';
        closePopups();
        iconPopup.style.display = isOpen ? 'none' : 'grid';
      });
    }

    if (colorBtn) {
      colorBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = colorPopup.style.display === 'grid';
        closePopups();
        colorPopup.style.display = isOpen ? 'none' : 'grid';
      });
    }

    if (categoryBtn) {
      categoryBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = categoryPopup.style.display === 'flex';
        closePopups();
        if (isOpen) return;
        renderCategoryPopup();
        categoryPopup.style.display = 'flex';
      });
    }

    // The sidebar's pickers have always closed on any outside click; this one
    // never did, so a popup could be left hanging over the card.
    const card = document.getElementById('previewCardElement');
    if (card) card.addEventListener('click', () => closePopups());

    if (applyBtn) {
      applyBtn.addEventListener('click', async () => {
        // Read everything BEFORE closing: closeAllModals() clears selectedTask,
        // so reaching for it afterwards throws and the edit is lost in silence.
        const task = this.selectedTask;
        if (!task) return;

        const patch = {
          title: titleInput.value.trim() || task.title,
          icon: this.previewTaskState.icon,
          color: this.previewTaskState.color,
          category: this.previewTaskState.category
        };

        this.closeAllModals();
        await this.optimisticTaskUpdate(task.id, patch, { label: 'Edit task' });
      });
    }

    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        this.closeAllModals();
      });
    }
  }

  // ==========================================
  // CATEGORIES
  // ==========================================

  initCategoriesTab() {
    const createBtn = document.getElementById('btnCreateCategory');
    if (createBtn) {
      createBtn.addEventListener('click', () => this.openCategoryEditModal(null));
    }

    const form = document.getElementById('categoryEditForm');
    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        void this.saveCategoryEdit();
      });
    }

    const cancelBtn = document.getElementById('btnCancelCategoryEdit');
    if (cancelBtn) cancelBtn.addEventListener('click', () => this.closeTopModal());

    const deleteBtn = document.getElementById('btnDeleteCategory');
    if (deleteBtn) deleteBtn.addEventListener('click', () => void this.deleteEditedCategory());
  }

  /**
   * Open the category editor ON TOP of whatever is already open.
   *
   * No closeAllModals() here, unlike every other open*Modal: this is reachable
   * from the pencil inside the block editor's category picker, and closing that
   * would discard the block being edited along with it.
   */
  openCategoryEditModal(category) {
    const modal = document.getElementById('categoryEditModal');
    if (!modal) return;

    this.editingCategory = category;
    this.categoryDraft = {
      color: (category && category.color) || KlndrPalette.colors[0],
      icon: (category && category.icon) || KlndrPalette.DEFAULT_ICON
    };

    document.getElementById('categoryEditTitle').textContent =
      category ? 'Edit Category' : 'New Category';

    const nameInput = document.getElementById('categoryNameInput');
    nameInput.value = category ? category.name : '';

    const msg = document.getElementById('categoryEditStatusMsg');
    msg.textContent = '';
    msg.className = 'status-msg';

    const deleteBtn = document.getElementById('btnDeleteCategory');
    if (deleteBtn) deleteBtn.style.display = category ? '' : 'none';

    this.renderCategorySwatchGrids();

    modal.classList.add('active');
    nameInput.focus();
    nameInput.select();
  }

  // The colour and icon grids are inline rather than pop-ups: a popup inside a
  // stacked modal is a third layer for no gain, and both fit on one row of ten.
  renderCategorySwatchGrids() {
    const colorGrid = document.getElementById('categoryColorGrid');
    const iconGrid = document.getElementById('categoryIconGrid');

    if (colorGrid) {
      colorGrid.innerHTML = '';
      KlndrPalette.colors.forEach(colorHex => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'picker-item-color';
        item.style.backgroundColor = colorHex;
        item.title = colorHex;
        item.classList.toggle('is-selected', colorHex === this.categoryDraft.color);
        item.addEventListener('click', () => {
          this.categoryDraft.color = colorHex;
          this.renderCategorySwatchGrids();
        });
        colorGrid.appendChild(item);
      });
    }

    if (iconGrid) {
      iconGrid.innerHTML = '';
      KlndrPalette.icons.forEach(iconName => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'picker-item-icon';
        item.title = iconName;
        item.innerHTML = `<span class="material-symbols-outlined">${iconName}</span>`;
        item.classList.toggle('is-selected', iconName === this.categoryDraft.icon);
        item.addEventListener('click', () => {
          this.categoryDraft.icon = iconName;
          this.renderCategorySwatchGrids();
        });
        iconGrid.appendChild(item);
      });
    }
  }

  async saveCategoryEdit() {
    const msg = document.getElementById('categoryEditStatusMsg');
    const name = document.getElementById('categoryNameInput').value.trim();
    const { color, icon } = this.categoryDraft;
    const editing = this.editingCategory;

    try {
      if (!editing) {
        await API.createCategory({ name, color, icon });
        await this.refreshCategories();
        this.closeTopModal();
        this.renderAll();
        void this.loadCategoriesTab();
        return;
      }

      // The colour and icon are defaults for the NEXT task that picks this
      // category. Pushing them onto tasks that already carry it is a separate,
      // destructive thing, so it is asked for rather than assumed - and the
      // count comes from the server, because this client only ever holds the
      // current week plus whatever is unscheduled.
      const restyled = color !== editing.color || icon !== editing.icon;
      let applyToTasks = false;
      if (restyled && editing.task_count > 0) {
        applyToTasks = window.confirm(
          `Apply the new colour and icon to all ${editing.task_count} ` +
          `task${editing.task_count === 1 ? '' : 's'} in "${editing.name}"? ` +
          'This cannot be undone.'
        );
      }

      const result = await API.updateCategory(editing.id, { name, color, icon, applyToTasks });
      await this.refreshCategories();
      this.closeTopModal();

      // A rename or a mass recolour rewrote tasks this client never loaded, so
      // re-read the week rather than trying to patch it in place.
      if (result.renamedFrom || result.recoloured) {
        await this.afterCategoryCascade(result.renamedFrom, result.category.name);
      } else {
        this.renderAll();
      }
      void this.loadCategoriesTab();
    } catch (err) {
      msg.textContent = err.message;
      msg.className = 'status-msg error';
    }
  }

  async deleteEditedCategory() {
    const category = this.editingCategory;
    if (!category) return;

    const owned = category.task_count || 0;
    const warning = owned
      ? `Delete "${category.name}"? Its ${owned} task${owned === 1 ? '' : 's'} ` +
        'will become uncategorised - they are not deleted.'
      : `Delete "${category.name}"?`;
    if (!window.confirm(warning)) return;

    const msg = document.getElementById('categoryEditStatusMsg');
    try {
      await API.deleteCategory(category.id);
      await this.refreshCategories();
      this.closeTopModal();
      await this.afterCategoryCascade(category.name);
      void this.loadCategoriesTab();
    } catch (err) {
      msg.textContent = err.message;
      msg.className = 'status-msg error';
      this.showToast(err.message, 'error');
    }
  }

  /**
   * Settle the board after the server rewrote tasks behind our back.
   *
   * `goneName` is the name that no longer exists; `newName` is what it became,
   * or null when it was deleted outright. Everything still holding the old name
   * has to be caught here - the tasks are re-read, but the filter and the two
   * half-written drafts are only in memory and would otherwise keep pointing at
   * a category nothing can resolve.
   *
   * The undo stack has to go too: its entries describe a list that no longer
   * exists, and one holding `{ category: 'OldName' }` would put a dead name
   * back onto a task. Same reasoning as loadTasks().
   */
  async afterCategoryCascade(goneName, newName = null) {
    if (goneName) {
      const sidebar = this.sidebarController;
      if (sidebar) {
        // A rename keeps you where you were; a delete has nowhere to keep you,
        // and leaving the filter there would empty the panel with no pill to
        // explain why.
        if (sidebar.activeCategoryFilter === goneName) {
          sidebar.activeCategoryFilter = newName || 'UNCOMPLETED_UNSCHEDULED';
        }
        if (sidebar.newTaskState.category === goneName) {
          sidebar.newTaskState.category = newName;
        }
      }
      if (this.previewTaskState && this.previewTaskState.category === goneName) {
        this.previewTaskState.category = newName;
        const categoryBtn = document.getElementById('btnPreviewCategory');
        if (categoryBtn) categoryBtn.title = KlndrApp.categoryButtonTitle(newName);
      }
    }

    await this.reloadTasksPreservingHistory();
    this.history.clear();
    this.updateHistoryButtons();
  }

  async refreshCategories() {
    this.categories = (await API.getCategories()) || [];
    return this.categories;
  }

  async loadCategoriesTab() {
    const listEl = document.getElementById('categoriesList');
    if (!listEl) return;

    const msg = document.getElementById('categoriesStatusMsg');
    try {
      await this.refreshCategories();
    } catch (err) {
      if (msg) {
        msg.textContent = err.message;
        msg.className = 'status-msg error';
      }
      return;
    }

    listEl.innerHTML = '';

    if (!this.categories.length) {
      const empty = document.createElement('div');
      empty.className = 'categories-empty-state';
      empty.innerHTML = `
        <p>You have no categories yet.</p>
        <span>Add one and it shows up in every category picker, in the filter
        bar and as a column on the board.</span>
      `;
      listEl.appendChild(empty);
      return;
    }

    this.categories.forEach(category => {
      const row = document.createElement('div');
      row.className = 'category-row';

      const swatch = document.createElement('span');
      swatch.className = 'category-row-swatch';
      swatch.style.backgroundColor = category.color;
      swatch.innerHTML = `<span class="material-symbols-outlined">${category.icon}</span>`;
      row.appendChild(swatch);

      const name = document.createElement('span');
      name.className = 'category-row-name';
      name.textContent = category.name;
      row.appendChild(name);

      const count = document.createElement('span');
      count.className = 'category-row-count';
      count.textContent = `${category.task_count} task${category.task_count === 1 ? '' : 's'}`;
      row.appendChild(count);

      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'category-row-action';
      edit.title = `Edit ${category.name}`;
      edit.innerHTML = '<span class="material-symbols-outlined">edit</span>';
      edit.addEventListener('click', () => this.openCategoryEditModal(category));
      row.appendChild(edit);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'category-row-action is-danger';
      remove.title = `Delete ${category.name}`;
      remove.innerHTML = '<span class="material-symbols-outlined">delete</span>';
      remove.addEventListener('click', () => {
        this.editingCategory = category;
        void this.deleteEditedCategory();
      });
      row.appendChild(remove);

      listEl.appendChild(row);
    });
  }

  // ==========================================
  // SETTINGS MODAL
  // ==========================================
  initSettingsModal() {
    const form = document.getElementById('settingsForm');
    if (form) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const bucketHours = parseInt(document.getElementById('settingsBucketHours').value, 10);
        const snapToRuler = document.getElementById('settingsSnapToRuler').checked;
        const tickPercent = parseFloat(document.getElementById('settingsTickPercent').value);

        const previous = { ...this.settings };
        const patch = { bucketHours, snapToRuler, tickPercent };

        // Applied first, saved behind it: these are draw-time only, so the grid
        // can redraw at the new settings before the write completes.
        this.settings = { ...this.settings, ...patch };
        this.closeAllModals();
        this.renderAll();
        this.setPending(1);

        try {
          const saved = await API.updateSettings(patch);
          if (saved) {
            this.settings = { ...this.settings, ...saved };
            this.renderAll();
          }
        } catch (err) {
          console.error('Failed to save settings', err);
          this.settings = previous;
          this.renderAll();
          this.showToast("Couldn't save those settings — reverted.", 'error');
        } finally {
          this.setPending(-1);
        }
      });
    }
  }

  async loadTasks() {
    const startDate = this.days[0].startTimestamp;
    const endDate = this.lastVisibleDay.endTimestamp;
    this.applyTasks(await API.getTasks(startDate, endDate));
  }

  /**
   * Adopt a freshly fetched week.
   *
   * Split out from loadTasks so the boot path can fetch the week alongside
   * everything else and hand the result in, rather than paying for its own
   * round trip once the others have finished.
   */
  applyTasks(tasks) {
    this.tasks = tasks;
    // Records written before segments existed are migrated here, once, on read.
    this.tasks.forEach(t => TaskModel.ensureSegments(t));
    // History describes edits to the list that was just replaced.
    this.history.clear();
    this.updateHistoryButtons();
    this.renderAll();
  }

  // ==========================================
  // UNDO / REDO
  // ==========================================

  /**
   * Record one gesture, unless this call IS a replay. Replays pass
   * `{ record: false }` explicitly rather than setting a flag on the app: a
   * replay awaits the network, and a flag left standing across those awaits
   * would swallow whatever the user did in the meantime.
   */
  recordHistory(options, changes) {
    if (!this.history || options.record === false) return;
    const real = (changes || []).filter(KlndrApp.isRealChange);
    if (!real.length) return;

    this.history.push({ label: options.label || 'Change', changes: real });
    this.updateHistoryButtons();
  }

  // The schedule fields, detached from whatever object they came from. Works on
  // both a live task and a commit payload, which is what lets a change record
  // its two sides in the same shape.
  static scheduleSnapshot(source) {
    const segments = (source.segments || []).map(seg => ({ ...seg }));
    return {
      segments,
      start_times: [...(source.start_times || [])],
      durations: [...(source.durations || [])],
      total_duration: source.total_duration,
      completed: source.completed
    };
  }

  static cloneValue(value) {
    if (Array.isArray(value)) return value.map(v => KlndrApp.cloneValue(v));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, KlndrApp.cloneValue(v)]));
    }
    return value;
  }

  // A gesture that changed nothing must not eat a press of Ctrl+Z.
  static isRealChange(change) {
    if (!change) return false;
    if (change.kind !== 'update') return true;
    return JSON.stringify(change.before) !== JSON.stringify(change.after);
  }

  async undo() { return this.replayHistory('undo'); }
  async redo() { return this.replayHistory('redo'); }

  /**
   * Step one gesture in either direction. Undo and redo run the same code — the
   * only difference is which side of each change gets applied, so there is no
   * inverse operation to keep correct separately.
   */
  async replayHistory(direction) {
    // Mid-drag the screen is showing a projection, not committed state; landing
    // an undo underneath it would commit against a board that is about to move.
    if (this.dragController && this.dragController.activeDrag) return false;

    const entry = direction === 'undo' ? this.history.undo() : this.history.redo();
    if (!entry) {
      this.showToast(direction === 'undo' ? 'Nothing to undo' : 'Nothing to redo');
      return false;
    }

    this.updateHistoryButtons();
    this.showToast(`${direction === 'undo' ? 'Undid' : 'Redid'}: ${entry.label}`);

    // Not awaited: an undo is on screen before the request leaves, like every
    // other edit. Only the bookkeeping waits for the write.
    this._historySettled = this.applyHistoryEntry(entry, direction).then(ok => {
      if (ok) return true;
      // The write did not land and the operation already reverted itself, so the
      // step never happened. Put the entry back, or the stacks now describe a
      // board that never existed.
      this.history.rollback(direction);
      this.updateHistoryButtons();
      return false;
    });

    return true;
  }

  async applyHistoryEntry(entry, direction) {
    const side = direction === 'undo' ? 'before' : 'after';
    const changes = entry.changes;
    const results = [];

    // Order first: it only rearranges the list, and doing it before the content
    // edits means their re-renders already draw the restored positions.
    const order = changes.find(c => c.kind === 'order');
    if (order) {
      this.applyTaskOrder(order[side]);
      this.renderAll();
    }

    // Existence next, so a schedule change that belongs to a task being brought
    // back has something to apply to.
    for (const change of changes.filter(c => c.kind === 'create' || c.kind === 'delete')) {
      const shouldExist = (change.kind === 'create') === (direction === 'redo');
      const present = this.tasks.some(t => t.id === change.id);

      if (shouldExist && !present) {
        results.push(await this.insertTask(
          KlndrApp.cloneValue(change.snapshot), change.index, "Couldn't bring that task back."
        ));
      } else if (!shouldExist && present) {
        results.push(await this.optimisticDeleteTask(change.id, { record: false }));
      }
    }

    // One request for every schedule change in the gesture: a drag that moved
    // four blocks undoes as one write, exactly as it was saved.
    const schedule = changes
      .filter(c => c.kind === 'update' && c.via === 'schedule')
      .filter(c => this.tasks.some(t => t.id === c.id))
      .map(c => ({ id: c.id, ...c[side] }));
    if (schedule.length) {
      results.push(await this.commitTaskUpdates(schedule, { record: false }));
    }

    for (const change of changes.filter(c => c.kind === 'update' && c.via === 'patch')) {
      if (!this.tasks.some(t => t.id === change.id)) continue;
      results.push(await this.optimisticTaskUpdate(change.id, change[side], { record: false }));
    }

    return results.every(Boolean);
  }

  updateHistoryButtons() {
    const labels = this.history.peekLabels();
    const set = (id, enabled, verb, label) => {
      const btn = document.getElementById(id);
      if (!btn) return;
      btn.disabled = !enabled;
      btn.title = enabled ? `${verb}: ${label}` : `Nothing to ${verb.toLowerCase()}`;
    };
    set('btnUndo', this.history.canUndo(), 'Undo', labels.undo);
    set('btnRedo', this.history.canRedo(), 'Redo', labels.redo);
  }

  /**
   * Apply a drag's result to the screen immediately, then persist it in the
   * background. The user never waits on the network to see where their block
   * landed; if the write fails the affected tasks snap back and say so.
   */
  async commitTaskUpdates(updatesList, options = {}) {
    if (!updatesList || !updatesList.length) return false;

    const rollback = new Map();
    const issuedRevisions = new Map();
    const changes = [];

    updatesList.forEach(u => {
      const task = this.tasks.find(t => t.id === u.id);
      if (!task) return;

      rollback.set(u.id, {
        segments: TaskModel.cloneSegments(task),
        total_duration: task.total_duration,
        completed: task.completed
      });

      // Captured before the mutation below, which is the only moment the old
      // schedule still exists anywhere.
      changes.push({
        kind: 'update',
        via: 'schedule',
        id: u.id,
        before: KlndrApp.scheduleSnapshot(task),
        after: KlndrApp.scheduleSnapshot(u)
      });

      if (u.segments) {
        TaskModel.setSegments(task, u.segments.map(seg => ({ ...seg })));
      } else {
        KlndrApp.mergeTask(task, {
          start_times: [...u.start_times],
          durations: [...u.durations],
          total_duration: u.total_duration
        });
        TaskModel.ensureSegments(task);
      }

      issuedRevisions.set(u.id, this.bumpRevision(u.id));
    });

    this.recordHistory(options, changes);
    this.renderAll();
    this.setPending(1);

    try {
      await this.awaitCreates(updatesList.map(u => u.id));
      const updated = await API.batchUpdateTasks(updatesList);

      let diverged = false;
      updated.forEach(serverTask => {
        // A newer local edit already superseded this reply — keep the screen.
        if (this.taskRevisions.get(serverTask.id) !== issuedRevisions.get(serverTask.id)) return;

        const task = this.tasks.find(t => t.id === serverTask.id);
        if (!task) {
          this.tasks.push(serverTask);
          diverged = true;
          return;
        }
        if (!KlndrApp.sameSchedule(task, serverTask)) diverged = true;
        KlndrApp.mergeTask(task, serverTask);
        TaskModel.ensureSegments(task);
      });

      // Normally the server agrees with what is already drawn, so there is
      // nothing to repaint. Never repaint mid-drag: render() rebuilds the block
      // layer and would tear the element out from under the pointer.
      if (diverged && !(this.dragController && this.dragController.activeDrag)) {
        this.renderAll();
      }

      // Ticking a scheduled task's blocks arrives here, not in
      // optimisticTaskUpdate, so the source app has to be told from both.
      this.pushSourceCompletion(updatesList.map(u => u.id));
      return true;
    } catch (err) {
      console.error('Failed to save schedule change', err);

      rollback.forEach((snapshot, id) => {
        if (this.taskRevisions.get(id) !== issuedRevisions.get(id)) return;
        const task = this.tasks.find(t => t.id === id);
        if (!task) return;
        task.total_duration = snapshot.total_duration;
        task.completed = snapshot.completed;
        TaskModel.setSegments(task, snapshot.segments);
      });

      this.renderAll();
      this.showToast("Couldn't save that change — reverted.", 'error');
      return false;
    } finally {
      this.setPending(-1);
    }
  }

  /**
   * Single-task edits, applied to the screen first and persisted behind it.
   * Same revision guard as commitTaskUpdates: a reply may only touch a task that
   * has not been edited again since that request went out.
   */
  async optimisticTaskUpdate(taskId, patch, options = {}) {
    const task = this.tasks.find(t => t.id === taskId);
    if (!task) return false;

    // Deep-copied: `segments` is an array the task keeps mutating in place, and
    // a snapshot holding the live reference would silently follow it.
    const previous = {};
    Object.keys(patch).forEach(key => { previous[key] = KlndrApp.cloneValue(task[key]); });

    this.recordHistory(options, [{
      kind: 'update', via: 'patch', id: taskId,
      before: previous, after: KlndrApp.cloneValue(patch)
    }]);

    KlndrApp.mergeTask(task, patch);
    const rev = this.bumpRevision(taskId);
    this.renderAll();
    this.setPending(1);

    try {
      await this.awaitCreates([taskId]);
      const updated = await API.updateTask(taskId, patch);
      if (updated && this.taskRevisions.get(taskId) === rev) {
        KlndrApp.mergeTask(task, updated);
        TaskModel.ensureSegments(task);
        if (!(this.dragController && this.dragController.activeDrag)) this.renderAll();
      }

      // The other half of the completion push: an unscheduled task carries the
      // flag itself and never goes through commitTaskUpdates.
      if ('completed' in patch) this.pushSourceCompletion([taskId]);
      return true;
    } catch (err) {
      console.error('Failed to save task update', err);
      if (this.taskRevisions.get(taskId) === rev) {
        KlndrApp.mergeTask(task, previous);
        this.renderAll();
        this.showToast("Couldn't save that change — reverted.", 'error');
      }
      return false;
    } finally {
      this.setPending(-1);
    }
  }

  async optimisticDeleteTask(taskId, options = {}) {
    const index = this.tasks.findIndex(t => t.id === taskId);
    if (index === -1) return false;

    const snapshot = KlndrApp.cloneValue(this.tasks[index]);
    this.recordHistory(options, [{ kind: 'delete', id: taskId, snapshot, index }]);

    const [removed] = this.tasks.splice(index, 1);
    this.renderAll();
    this.setPending(1);

    try {
      await this.awaitCreates([taskId]);
      await API.deleteTask(taskId);
      return true;
    } catch (err) {
      console.error('Failed to delete task', err);
      this.tasks.splice(index, 0, removed);
      this.renderAll();
      this.showToast("Couldn't delete that task — it's back.", 'error');
      return false;
    } finally {
      this.setPending(-1);
    }
  }

  /**
   * Create a task without waiting for the server. The id is minted locally and
   * sent with the request, so the task that appears on screen IS the task the
   * server stores — there is no temporary id to swap out afterwards, and nothing
   * holding a reference to it (a drag, a modal, the calendar) ever sees it
   * change identity.
   *
   * The tradeoff is ordering: until the create lands, the server would drop any
   * edit naming this id. `pendingCreates` makes every other write wait on it.
   *
   * Deliberately not awaited by its caller — the point is that the caller does
   * not block.
   */
  optimisticCreateTask(payload, options = {}) {
    const task = {
      id: TaskModel.newTaskId(),
      title: payload.title || 'Untitled Task',
      // The rest of the server's defaults, applied here so the card cannot
      // change under the user when the real record arrives.
      start_times: [],
      durations: [],
      segments: [],
      total_duration: Number(payload.total_duration || payload.default_timing || 60),
      default_timing: Number(payload.default_timing || 60),
      is_locked: payload.is_locked !== undefined ? Boolean(payload.is_locked) : true,
      color: payload.color || '#3ba4f6',
      icon: payload.icon || 'task_alt',
      category: payload.category || null,
      completed: false,
      metadata: payload.metadata || {}
    };

    const index = this.tasks.length;
    this.recordHistory(options, [{
      kind: 'create', id: task.id, snapshot: KlndrApp.cloneValue(task), index
    }]);

    this.insertTask(task, index, "Couldn't create that task — removed.");
    return task;
  }

  /**
   * Put a task into the list and behind it into the database, without waiting.
   * Shared by first creation and by undoing a delete: both are "this task should
   * exist, with this id", and the server keeps whatever id it is handed.
   *
   * Deliberately not awaited by its callers — the point is that they do not block.
   */
  insertTask(task, index, failureMessage) {
    this.tasks.splice(Math.min(index, this.tasks.length), 0, task);
    TaskModel.ensureSegments(task);
    this.renderAll();
    this.setPending(1);

    const inFlight = (async () => {
      try {
        const created = await API.createTask(task);
        // Anything the user changed while the request was in the air outranks
        // the server's echo of what it was first told.
        if (created && !this.taskRevisions.get(task.id)) {
          KlndrApp.mergeTask(task, created);
          TaskModel.ensureSegments(task);
        }
        return true;
      } catch (err) {
        console.error('Failed to create task', err);
        const at = this.tasks.findIndex(t => t.id === task.id);
        if (at !== -1) this.tasks.splice(at, 1);
        this.renderAll();
        this.showToast(failureMessage, 'error');
        return false;
      } finally {
        this.pendingCreates.delete(task.id);
        this.setPending(-1);
      }
    })();

    this.pendingCreates.set(task.id, inFlight);
    return inFlight;
  }

  /**
   * Build a commit payload from a set of segments WITHOUT touching the live
   * task, so commitTaskUpdates can still snapshot the pre-edit state for its
   * rollback. Callers mutate a clone and hand it here.
   */
  payloadWithSegments(task, segments) {
    return TaskModel.payloadFrom(task, segments);
  }

  /**
   * Cut one block in two at the point the user right-clicked. The position is
   * snapped like a drag, then clamped so neither half falls under the minimum —
   * the cut marker has already shown where it will land.
   */
  async splitSegmentAt(task, segmentId, rawTimestamp) {
    const segments = TaskModel.cloneSegments(task);
    const segment = segments.find(seg => seg.id === segmentId);
    if (!segment || segment.duration < TaskModel.MIN_SEGMENT_MINUTES * 2) return;

    const floor = TaskModel.MIN_SEGMENT_MINUTES * 60;
    const end = segment.start_time + segment.duration * 60;

    let cut = rawTimestamp;
    const snap = this.dragController ? this.dragController.snapMinutes() : 0;
    if (snap > 0) cut = PhysicsEngine.snapTimestamp(cut, snap);
    cut = Math.max(segment.start_time + floor, Math.min(end - floor, cut));

    const leftMinutes = Math.round((cut - segment.start_time) / 60);
    segments.push({
      id: TaskModel.newSegmentId(),
      start_time: segment.start_time + leftMinutes * 60,
      duration: segment.duration - leftMinutes,
      completed: segment.completed
    });
    segment.duration = leftMinutes;

    await this.commitTaskUpdates([this.payloadWithSegments(task, segments)], { label: 'Split block' });
  }

  // Removing the last block is an unschedule, not a delete: the task goes back
  // to the panel rather than disappearing.
  async removeSegment(task, segmentId) {
    const segments = TaskModel.cloneSegments(task).filter(seg => seg.id !== segmentId);
    if (!segments.length) {
      await this.optimisticTaskUpdate(
        task.id, { segments: [], start_times: [], durations: [] }, { label: 'Unschedule task' }
      );
      return;
    }
    await this.commitTaskUpdates([this.payloadWithSegments(task, segments)], { label: 'Remove block' });
  }

  static sameSchedule(a, b) {
    const starts = b.start_times || [];
    const durations = b.durations || [];
    if (a.start_times.length !== starts.length) return false;
    if (a.durations.length !== durations.length) return false;
    return starts.every((v, i) => v === a.start_times[i]) &&
      durations.every((v, i) => v === a.durations[i]);
  }

  async handleTaskInteraction(action, payload) {
    switch (action) {
      // Ticking the task in the panel drives every one of its blocks.
      case 'toggleComplete': {
        const { taskId, completed } = payload;
        const task = this.tasks.find(t => t.id === taskId);
        if (!task) break;

        const segments = TaskModel.cloneSegments(task);
        if (!segments.length) {
          await this.optimisticTaskUpdate(
            taskId, { completed }, { label: completed ? 'Complete task' : 'Uncomplete task' }
          );
          break;
        }
        segments.forEach(seg => { seg.completed = completed; });
        await this.commitTaskUpdates(
          [this.payloadWithSegments(task, segments)],
          { label: completed ? 'Complete task' : 'Uncomplete task' }
        );
        break;
      }

      // Ticking one block on the calendar affects only that block; the task
      // reads as done once every block is.
      case 'toggleSegmentComplete': {
        const { taskId, segmentId, completed } = payload;
        const task = this.tasks.find(t => t.id === taskId);
        if (!task) break;

        const segments = TaskModel.cloneSegments(task);
        const segment = segments.find(seg => seg.id === segmentId);
        if (!segment) break;

        segment.completed = completed;
        await this.commitTaskUpdates(
          [this.payloadWithSegments(task, segments)],
          { label: completed ? 'Complete block' : 'Uncomplete block' }
        );
        break;
      }

      case 'createInlineTask': {
        this.optimisticCreateTask(payload, { label: 'Create task' });
        break;
      }

      case 'moveTaskInList': {
        this.moveTaskInList(payload.task.id, payload.direction);
        break;
      }

      case 'openEditModal': {
        this.openBlockPreviewModal(payload.task, payload.segmentId);
        break;
      }

      // Raised by the category picker in the tasks panel: the pencil on a row,
      // and the "New category" entry at the bottom of the list.
      case 'editCategory': {
        this.openCategoryEditModal(payload.category);
        break;
      }

      case 'createCategory': {
        this.openCategoryEditModal(null);
        break;
      }

      case 'openContextMenu': {
        this.openContextMenu(payload);
        break;
      }
    }
  }

  // "Category: null" is not a tooltip.
  static categoryButtonTitle(name) {
    return name ? `Category: ${name}` : 'Category: none';
  }

  /**
   * Give the block being edited the look of the category just picked.
   *
   * Mirrors TasksSidebar.applyCategoryToDraft, including its early-out:
   * re-picking the category already selected must not throw away a colour the
   * person chose by hand afterwards.
   */
  applyCategoryToPreview(category, previewCard, iconBtn) {
    const nextName = category.name || null;
    const categoryBtn = document.getElementById('btnPreviewCategory');
    const badgeIcon = document.getElementById('previewCardBadgeIcon');

    if (nextName !== this.previewTaskState.category) {
      this.previewTaskState.category = nextName;
      if (category.color) this.previewTaskState.color = category.color;
      if (category.icon) this.previewTaskState.icon = category.icon;

      if (previewCard) previewCard.style.backgroundColor = this.previewTaskState.color;
      if (badgeIcon) badgeIcon.textContent = this.previewTaskState.icon;
      if (iconBtn) {
        iconBtn.querySelector('.material-symbols-outlined').textContent =
          this.previewTaskState.icon;
      }
    }

    if (categoryBtn) categoryBtn.title = KlndrApp.categoryButtonTitle(nextName);
  }

  openBlockPreviewModal(task, segmentId = null) {
    this.closeAllModals();
    // Remembered for the "More actions" route below, which hands it straight
    // back to the same menu a right-click opens.
    this._editorSegmentId = segmentId;
    if (this.canvasRenderer) {
      this.canvasRenderer.setPlayhead(null);
      this.canvasRenderer.setSnapGuide(null);
    }
    this.selectedTask = task;
    this.previewTaskState = {
      icon: task.icon || KlndrPalette.DEFAULT_ICON,
      color: task.color || KlndrPalette.DEFAULT_COLOR,
      category: task.category || null
    };

    const modal = document.getElementById('blockPreviewModal');
    const previewCard = document.getElementById('previewCardElement');
    const titleInput = document.getElementById('previewTaskTitleInput');
    const badgeIcon = document.getElementById('previewCardBadgeIcon');
    const iconBtn = document.getElementById('btnPreviewIcon');
    const categoryBtn = document.getElementById('btnPreviewCategory');

    if (modal && previewCard && titleInput) {
      titleInput.value = task.title;
      previewCard.style.backgroundColor = this.previewTaskState.color;
      badgeIcon.textContent = this.previewTaskState.icon;
      iconBtn.querySelector('.material-symbols-outlined').textContent = this.previewTaskState.icon;
      categoryBtn.title = KlndrApp.categoryButtonTitle(this.previewTaskState.category);

      const scopeNote = document.getElementById('previewScopeNote');
      if (scopeNote) {
        const blocks = (task.segments || []).length;
        scopeNote.textContent = blocks > 1
          ? `Editing the task — applies to all ${blocks} of its blocks`
          : '';
        scopeNote.style.display = blocks > 1 ? 'block' : 'none';
      }

      const scheduleBtn = document.getElementById('btnScheduleFromEditor');
      if (scheduleBtn) scheduleBtn.onclick = () => void this.scheduleTaskNearNow(task);

      const moreBtn = document.getElementById('btnBlockMoreActions');
      if (moreBtn) {
        // Everything on that menu except "Edit Details" is otherwise reachable
        // only by right-clicking, which a finger cannot do. Rather than rebuild
        // six actions here, hand off to the menu that already has them wired -
        // it renders as a sheet at phone width.
        moreBtn.onclick = () => this.openBlockActionsForTouch(task);
      }

      modal.classList.add('active');
      // Not on touch: focusing the title raises the keyboard over the sheet
      // before the person has said they want to rename anything.
      if (!TimelineDOM.isTouchInput()) titleInput.focus();
    }
  }

  /**
   * The block action list, opened from the editor rather than from a right
   * click.
   *
   * The split point is the block's midpoint, because there is no click point to
   * take it from - which is the same answer Phase 1 settled on, and it composes:
   * split at the middle, then drag the seam to where you actually wanted it.
   */
  openBlockActionsForTouch(task) {
    const segmentId = this._editorSegmentId;
    const segment = segmentId ? TaskModel.segmentById(task, segmentId) : null;
    const splitTimestamp = segment
      ? segment.start_time + (segment.duration * 60) / 2
      : null;

    this.openContextMenu({
      task,
      segmentId,
      splitTimestamp,
      // Ignored at phone width, where the menu is a full-width sheet pinned to
      // the bottom; still used on a tablet, where it stays a popup.
      clientX: window.innerWidth / 2,
      clientY: window.innerHeight / 2
    });
  }

  openAccountModal() {
    this.closeAllModals();
    if (this.canvasRenderer) {
      this.canvasRenderer.setPlayhead(null);
      this.canvasRenderer.setSnapGuide(null);
    }
    const modal = document.getElementById('accountModal');
    if (modal) {
      document.getElementById('displayCurrentUsername').textContent = this.user.username;
      document.getElementById('displayCurrentRole').textContent = this.user.role;
      modal.classList.add('active');
    }
  }

  openSettingsModal() {
    this.closeAllModals();
    if (this.canvasRenderer) {
      this.canvasRenderer.setPlayhead(null);
      this.canvasRenderer.setSnapGuide(null);
    }
    const modal = document.getElementById('settingsModal');
    if (modal) {
      document.getElementById('settingsBucketHours').value = this.settings.bucketHours || 2;
      document.getElementById('settingsSnapToRuler').checked = Boolean(this.settings.snapToRuler);
      document.getElementById('settingsTickPercent').value = this.settings.tickPercent || 25;

      // Applied on change rather than on save, because it is a device
      // preference and never travels to the server with the rest of this form.
      const orientationSelect = document.getElementById('settingsOrientation');
      if (orientationSelect) {
        orientationSelect.value = this.orientationPreference;
        orientationSelect.onchange = () => this.setOrientationPreference(orientationSelect.value);
      }

      // The same setting as the header's 1/3/5/7 control, which only appears on
      // a phone - this is how it is reached, and tested, at every other width.
      const dayCountSelect = document.getElementById('settingsDayCount');
      if (dayCountSelect) {
        dayCountSelect.value = String(this.dayCount);
        dayCountSelect.onchange = () => void this.setDayCount(Number(dayCountSelect.value));
      }

      const snapSelect = document.getElementById('settingsTouchSnap');
      if (snapSelect) {
        snapSelect.value = this.touchSnapPreference;
        snapSelect.onchange = () => this.setTouchSnapPreference(snapSelect.value);
      }

      modal.classList.add('active');
    }
  }

  /**
   * `payload` carries the block that was right-clicked and the timestamp under
   * the pointer AT THAT MOMENT. The pointer has to travel to reach the menu, so
   * the split position must be captured on contextmenu, never read later.
   */
  openContextMenu(payload) {
    const { task, segmentId, splitTimestamp, clientX, clientY } = payload;

    this.closeAllModals();
    if (this.canvasRenderer) {
      this.canvasRenderer.setPlayhead(null);
      this.canvasRenderer.setSnapGuide(null);
    }
    this.selectedTask = task;
    const menu = document.getElementById('taskContextMenu');
    if (!menu) return;

    const isScheduled = task.start_times && task.start_times.length > 0;
    const isLocked = task.is_locked !== false;
    const segment = segmentId ? TaskModel.segmentById(task, segmentId) : null;
    const canSplit = Boolean(segment) && segment.duration >= TaskModel.MIN_SEGMENT_MINUTES * 2;

    const editOpt = document.getElementById('ctxEdit');
    const lockOpt = document.getElementById('ctxToggleLock');
    const splitOpt = document.getElementById('ctxSplit');
    const removeBlockOpt = document.getElementById('ctxRemoveBlock');
    const unscheduleOpt = document.getElementById('ctxUnschedule');
    const deleteOpt = document.getElementById('ctxDelete');

    if (splitOpt) {
      splitOpt.style.display = segment ? 'flex' : 'none';
      splitOpt.classList.toggle('is-disabled', !canSplit);
      splitOpt.title = canSplit
        ? 'Cut this block in two at the marked point'
        : `A block needs at least ${TaskModel.MIN_SEGMENT_MINUTES * 2} minutes to split`;
    }

    // Only worth offering once a task has more than one block; with a single
    // block "remove this block" and "remove from calendar" are the same thing.
    if (removeBlockOpt) {
      removeBlockOpt.style.display = segment && TaskModel.isSplit(task) ? 'flex' : 'none';
    }

    // Show where the cut will land while the menu covers the block.
    if (this.canvasRenderer) {
      this.canvasRenderer.setCutMarker(canSplit ? this.cutMarkerFor(task, segment, splitTimestamp) : null);
    }

    if (lockOpt) {
      lockOpt.innerHTML = `
        <span class="material-symbols-outlined">${isLocked ? 'lock_open' : 'lock'}</span>
        <span>${isLocked ? 'Unlock Duration' : 'Lock Duration'}</span>
      `;
    }

    if (unscheduleOpt) {
      unscheduleOpt.style.display = isScheduled ? 'flex' : 'none';
    }

    // At phone width the stylesheet makes this a full-width sheet pinned to the
    // bottom, so the coordinates are cleared rather than written: an inline
    // left/top would beat any rule that is not !important, and the point of
    // keeping responsive.css free of those is that it stays revertible.
    const asSheet = document.body.dataset.layout === 'phone';
    menu.style.left = asSheet ? '' : `${Math.min(window.innerWidth - 200, clientX)}px`;
    menu.style.top = asSheet ? '' : `${Math.min(window.innerHeight - 200, clientY)}px`;
    menu.classList.add('active');

    if (editOpt) {
      editOpt.onclick = () => {
        this.closeAllModals();
        this.openBlockPreviewModal(task);
      };
    }

    if (lockOpt) {
      lockOpt.onclick = async () => {
        this.closeAllModals();
        await this.optimisticTaskUpdate(
          task.id, { is_locked: !isLocked }, { label: isLocked ? 'Unlock task' : 'Lock task' }
        );
      };
    }

    if (splitOpt) {
      splitOpt.onclick = () => {
        if (!canSplit) return;
        // Places the cut rather than making it: the menu is covering the block,
        // so this is the first moment the person can actually see where the
        // line falls.
        this.beginSplitPlacement(task, segmentId, splitTimestamp);
      };
    }

    if (removeBlockOpt) {
      removeBlockOpt.onclick = async () => {
        this.closeAllModals();
        await this.removeSegment(task, segmentId);
      };
    }

    if (unscheduleOpt) {
      unscheduleOpt.onclick = async () => {
        this.closeAllModals();
        await this.optimisticTaskUpdate(
          task.id, { segments: [], start_times: [], durations: [] }, { label: 'Unschedule task' }
        );
      };
    }

    if (deleteOpt) {
      deleteOpt.onclick = async () => {
        this.closeAllModals();
        if (confirm(`Delete "${task.title}"?`)) {
          await this.optimisticDeleteTask(task.id, { label: 'Delete task' });
        }
      };
    }

    const closeContext = () => {
      menu.classList.remove('active');
      // This path does NOT go through closeAllModals, so it has to release the
      // tooltip itself or a dismissed menu leaves one stranded on screen.
      if (this.domRenderer) this.domRenderer.unpinTooltip();
      // Not while a split is being placed: this fires on the very click that
      // started it, and the marker is now that mode's, not this menu's.
      if (this.canvasRenderer && !this.pendingSplit) this.canvasRenderer.setCutMarker(null);
      window.removeEventListener('click', closeContext);
    };
    setTimeout(() => window.addEventListener('click', closeContext), 10);
  }

  // Mirrors the clamping splitSegmentAt applies, so the marker cannot promise a
  // cut in a place the split would refuse.
  /**
   * Where a cut would actually land: snapped to whatever grid is in force, then
   * pulled inside the block far enough that neither half is shorter than a
   * segment is allowed to be.
   *
   * The marker, the confirm label and the commit all have to agree about this
   * or the line is drawn somewhere the cut does not happen - so all three ask
   * here rather than each doing the arithmetic. It used to be spelled out twice.
   */
  clampedCutTimestamp(segment, rawTimestamp) {
    const floor = TaskModel.MIN_SEGMENT_MINUTES * 60;
    const end = segment.start_time + segment.duration * 60;
    let cut = rawTimestamp;
    const snap = this.dragController ? this.dragController.snapMinutes() : 0;
    if (snap > 0) cut = PhysicsEngine.snapTimestamp(cut, snap);
    return Math.max(segment.start_time + floor, Math.min(end - floor, cut));
  }

  dayIndexOfSegment(segment) {
    return this.days.findIndex(
      d => segment.start_time >= d.startTimestamp && segment.start_time < d.startTimestamp + 86400
    );
  }

  cutMarkerFor(task, segment, rawTimestamp) {
    if (!segment) return null;
    const dayIndex = this.dayIndexOfSegment(segment);
    if (dayIndex === -1) return null;

    const cut = this.clampedCutTimestamp(segment, rawTimestamp);
    const day = this.days[dayIndex];
    return this.canvasRenderer.cutRectFor(dayIndex, (cut - day.startTimestamp) / 60);
  }

  /**
   * Show the cut and let it be moved before it happens.
   *
   * A right click already puts the line exactly where the pointer was, so this
   * earns its keep mainly on touch, where the split point can only start at the
   * block's midpoint - there is no click point to take it from. Dragging is how
   * you say where you actually meant.
   *
   * Deliberately not a DragController drag type. It has no block to move and no
   * physics to run; it is a mode that ends in one commit, and the controller is
   * the riskiest file here. It borrows the controller's silence through
   * isModalOrOverlayActive() and owns nothing else.
   */
  beginSplitPlacement(task, segmentId, rawTimestamp) {
    const segment = TaskModel.segmentById(task, segmentId);
    if (!segment || segment.duration < TaskModel.MIN_SEGMENT_MINUTES * 2) return;

    const dayIndex = this.dayIndexOfSegment(segment);
    if (dayIndex === -1) return;

    this.endAnyPlacement();

    // Set before closing anything: both the modal teardown and the context
    // menu's own deferred window-click handler clear the cut marker, and the
    // marker now belongs to this mode rather than to the menu that opened it.
    // The click that chose "Split here" is still bubbling as this runs.
    this.pendingSplit = {
      task, segmentId, dayIndex,
      timestamp: this.clampedCutTimestamp(segment, rawTimestamp)
    };
    document.body.classList.add('is-placing-split');
    this.closeAllModals();

    this.bindPlacementSurface((x, y) => this.moveSplitPlacement(x, y));
    this.renderSplitPlacement();
  }

  // ==========================================
  // PLACEMENT MODES
  // ==========================================
  // Two things get positioned before they happen: where a block will be cut,
  // and where a task will land on the calendar. Both are a MODE rather than a
  // modal - the board stays visible and gets pointed at - so both borrow the
  // same bottom bar, the same pointer plumbing, and the same silence from the
  // drag controller. Only one can be active at a time, which is why they share
  // one bar rather than owning two that must never both appear.

  get placementActive() {
    return Boolean(this.pendingSplit);
  }

  endAnyPlacement() {
    if (this.pendingSplit) void this.endSplitPlacement(false);
  }

  /**
   * The pointer plumbing both modes share.
   *
   * Capture phase, so it sees the pointer before anything that might still want
   * to act on it. The pointer-type split is the important part: a mouse drags
   * to position, because its wheel still scrolls the timeline - but a finger's
   * move belongs to the scroll. At any useful zoom the day is several screens
   * tall, and taking the move would make every time off screen unreachable, so
   * touch positions by tapping and keeps its scrolling.
   */
  bindPlacementSurface(onMove) {
    const surface = document.getElementById('timeline-workspace');
    if (!surface) return;

    this._placementMove = (e) => {
      if (!this.placementActive) return;
      if (e.type === 'pointermove') {
        if (e.pointerType !== 'mouse') return;
        // Otherwise the line would chase the mouse on its way to the button.
        if (!(e.buttons & 1)) return;
      }
      // Never on touch: preventDefault here cannot stop a pan the browser has
      // already claimed, and only risks the tap it is about to deliver.
      if (e.pointerType === 'mouse') e.preventDefault();
      onMove(e.clientX, e.clientY);
    };

    surface.addEventListener('pointerdown', this._placementMove, { capture: true });
    surface.addEventListener('pointermove', this._placementMove, { capture: true, passive: false });
    this._placementSurface = surface;
  }

  unbindPlacementSurface() {
    if (this._placementSurface && this._placementMove) {
      this._placementSurface.removeEventListener('pointerdown', this._placementMove, { capture: true });
      this._placementSurface.removeEventListener('pointermove', this._placementMove, { capture: true });
    }
    this._placementSurface = null;
    this._placementMove = null;
  }

  showPlacementBar(label, confirmText) {
    const bar = document.getElementById('placementBar');
    if (!bar) return;
    const labelEl = document.getElementById('placementLabel');
    if (labelEl) labelEl.textContent = label;
    const confirmEl = document.getElementById('placementConfirm');
    if (confirmEl) confirmEl.textContent = confirmText;
    bar.classList.add('is-visible');
  }

  hidePlacementBar() {
    const bar = document.getElementById('placementBar');
    if (bar) bar.classList.remove('is-visible');
  }

  initPlacementBar() {
    const confirm = document.getElementById('placementConfirm');
    const cancel = document.getElementById('placementCancel');
    if (confirm) confirm.addEventListener('click', () => void this.confirmPlacement());
    if (cancel) cancel.addEventListener('click', () => void this.cancelPlacement());
  }

  async confirmPlacement() {
    if (this.pendingSplit) return this.endSplitPlacement(true);
  }

  async cancelPlacement() {
    if (this.pendingSplit) return this.endSplitPlacement(false);
  }

  /**
   * Put a task on the calendar without a drag, near the current time.
   *
   * The discoverable route, and the fallback for anyone who never finds the
   * long press. It commits rather than opening a mode: a real block that can be
   * seen and then dragged beats a preview that has to be aimed, which is what
   * the placement mode got wrong. PhysicsEngine flows it around whatever is
   * already there, so "near now" means the first slot that actually fits, and
   * undo is one press away if it is the wrong day entirely.
   */
  async scheduleTaskNearNow(task) {
    if (!task || !this.dragController || !this.days.length) return;

    const now = this.canvasRenderer ? this.canvasRenderer.nowPosition() : null;
    const dayIndex = now ? now.dayIndex : 0;
    const day = this.days[dayIndex];
    const duration = task.default_timing || task.total_duration || 120;
    const minutes = Math.max(0, Math.min(1440 - duration,
      this.dragController.snapMinutesValue(now ? now.minutes : 9 * 60)));

    // The same object a real drop builds, so a button and a drag land in the
    // same place by the same physics.
    const updates = this.dragController.resolveDragOutcome({
      type: 'sidebar-drop',
      taskId: task.id,
      taskRef: task,
      segmentId: null,
      currentStartTime: day.startTimestamp + minutes * 60,
      currentDayIndex: dayIndex,
      initialDuration: duration,
      currentDuration: duration
    });
    if (!updates.length) return;

    this.closeAllModals();
    this.setCalendarCollapsed(false);
    await this.commitTaskUpdates(updates, { label: 'Schedule task' });

    if (this.canvasRenderer) this.canvasRenderer.scrollToNow();
    // Say where it went, using the flash the focus machinery already owns.
    if (this.domRenderer) this.domRenderer.flashTask(task.id);
  }

  static clockLabel(date) {
    const h = date.getHours() % 12 || 12;
    const m = String(date.getMinutes()).padStart(2, '0');
    return `${h}:${m} ${date.getHours() < 12 ? 'AM' : 'PM'}`;
  }

  moveSplitPlacement(clientX, clientY) {
    const pending = this.pendingSplit;
    if (!pending) return;
    const segment = TaskModel.segmentById(pending.task, pending.segmentId);
    if (!segment) return;

    const day = this.days[pending.dayIndex];
    if (!day) return;

    const { minutes } = this.canvasRenderer.pointToTimeDay(clientX, clientY);
    pending.timestamp = this.clampedCutTimestamp(segment, day.startTimestamp + minutes * 60);
    this.renderSplitPlacement();
  }

  renderSplitPlacement() {
    const pending = this.pendingSplit;
    if (!pending) return;
    const segment = TaskModel.segmentById(pending.task, pending.segmentId);
    if (!segment) return this.endSplitPlacement(false);

    this.canvasRenderer.setCutMarker(
      this.cutMarkerFor(pending.task, segment, pending.timestamp)
    );

    const left = Math.round((pending.timestamp - segment.start_time) / 60);
    const right = segment.duration - left;
    this.showPlacementBar(
      `Cut at ${KlndrApp.clockLabel(new Date(pending.timestamp * 1000))} — ${left}m + ${right}m`,
      'Split'
    );
  }

  async endSplitPlacement(commit) {
    const pending = this.pendingSplit;
    this.pendingSplit = null;
    document.body.classList.remove('is-placing-split');

    this.unbindPlacementSurface();
    this.hidePlacementBar();
    if (this.canvasRenderer) this.canvasRenderer.setCutMarker(null);

    if (commit && pending) {
      await this.splitSegmentAt(pending.task, pending.segmentId, pending.timestamp);
    }
  }

  // ==========================================
  // ANNOUNCEMENT HELPERS
  // ==========================================

  formatDate(unixTs) {
    const d = new Date(unixTs * 1000);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
  }

  formatDateTime(unixTs) {
    const d = new Date(unixTs * 1000);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    let hours = d.getHours();
    const minutes = String(d.getMinutes()).padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12 || 12;
    return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}, ${hours}:${minutes} ${ampm}`;
  }

  // ==========================================
  // ANNOUNCEMENTS TAB (Settings Modal)
  // ==========================================

  async loadAnnouncementsList() {
    const listEl = document.getElementById('announcementsList');
    if (!listEl) return;
    listEl.innerHTML = '';

    try {
      const data = await API.getAnnouncements();
      const announcements = (data && data.announcements) ? data.announcements : [];

      if (announcements.length === 0) {
        // The CSS :empty::after pseudo-element will show the "No announcements yet." text
        return;
      }

      // Show newest first in the list
      [...announcements].reverse().forEach(a => {
        const item = document.createElement('div');
        item.className = 'announcement-list-item';
        item.innerHTML = `
          <span class="announcement-list-item-title">${this._escapeHtml(a.title)}</span>
          <span class="announcement-list-item-date">${this.formatDate(a.created_at)}</span>
          <span class="material-symbols-outlined announcement-list-item-chevron" style="font-size: 16px">chevron_right</span>
        `;
        item.addEventListener('click', () => this.openAnnouncementViewModal(a));
        listEl.appendChild(item);
      });
    } catch (err) {
      listEl.innerHTML = `<div style="padding: 16px; color: #ef4444; font-size: 13px; font-weight: 600;">${err.message}</div>`;
    }
  }


  openAnnouncementViewModal(announcement) {
    this.closeAllModals();
    if (this.canvasRenderer) {
      this.canvasRenderer.setPlayhead(null);
      this.canvasRenderer.setSnapGuide(null);
    }
    const modal = document.getElementById('announcementViewModal');
    const titleEl = document.getElementById('announcementViewTitle');
    const metaEl = document.getElementById('announcementViewMeta');
    const contentEl = document.getElementById('announcementViewContent');
    const headerImgWrap = document.getElementById('announcementViewHeaderImg');
    const headerImgEl = document.getElementById('announcementHeaderImgEl');

    if (!modal) return;

    titleEl.textContent = announcement.title;
    metaEl.textContent = this.formatDateTime(announcement.created_at);
    contentEl.innerHTML = this.renderMarkdown(announcement.content);

    if (announcement.header_image_url) {
      headerImgEl.src = announcement.header_image_url;
      headerImgWrap.style.display = 'block';
    } else {
      headerImgWrap.style.display = 'none';
    }

    modal.classList.add('active');
  }

  initAnnouncementsTab() {
    // Wire close buttons for announcement view modal
    const btnCloseView = document.getElementById('btnCloseAnnouncementView');
    if (btnCloseView) {
      btnCloseView.addEventListener('click', () => {
        this.closeAllModals();
      });
    }

    // Wire backdrop click for announcement view modal
    const viewModal = document.getElementById('announcementViewModal');
    if (viewModal) {
      viewModal.querySelector('.modal-backdrop').addEventListener('click', () => {
        this.closeAllModals();
      });
    }

    // Wire "New Announcement" button (admin only)
    const btnCreate = document.getElementById('btnCreateAnnouncement');
    if (btnCreate) {
      btnCreate.addEventListener('click', () => {
        this.openAnnouncementCreateModal();
      });
    }

    // Wire create modal close/cancel buttons
    const btnCloseCreate = document.getElementById('btnCloseAnnouncementCreate');
    const btnCancelCreate = document.getElementById('btnCancelAnnouncementCreate');
    const createModal = document.getElementById('announcementCreateModal');

    if (btnCloseCreate) {
      btnCloseCreate.addEventListener('click', () => this.closeAllModals());
    }
    if (btnCancelCreate) {
      btnCancelCreate.addEventListener('click', () => this.closeAllModals());
    }
    if (createModal) {
      createModal.querySelector('.modal-backdrop').addEventListener('click', () => {
        this.closeAllModals();
      });
    }

    // Wire create announcement form submission
    const form = document.getElementById('announcementCreateForm');
    if (form) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const title = document.getElementById('announcementTitleInput').value.trim();
        const content = document.getElementById('announcementContentInput').value.trim();
        const msgEl = document.getElementById('announcementCreateStatusMsg');

        try {
          await API.createAnnouncement(title, content, null);
          msgEl.textContent = 'Announcement posted successfully.';
          msgEl.className = 'status-msg success';
          form.reset();
          setTimeout(() => {
            this.closeAllModals();
            msgEl.className = 'status-msg';
            // Re-open account modal on announcements tab; switchAccountTab
            // refreshes the list on the way in.
            this.openAccountModal();
            this.switchAccountTab('tabBtnAnnouncements');
          }, 800);
        } catch (err) {
          msgEl.textContent = err.message;
          msgEl.className = 'status-msg error';
        }
      });
    }
  }

  openAnnouncementCreateModal() {
    this.closeAllModals();
    if (this.canvasRenderer) {
      this.canvasRenderer.setPlayhead(null);
      this.canvasRenderer.setSnapGuide(null);
    }
    const modal = document.getElementById('announcementCreateModal');
    if (!modal) return;
    document.getElementById('announcementCreateForm').reset();
    const msgEl = document.getElementById('announcementCreateStatusMsg');
    if (msgEl) msgEl.className = 'status-msg';
    modal.classList.add('active');
    setTimeout(() => {
      document.getElementById('announcementTitleInput')?.focus();
    }, 40);
  }

  // ==========================================
  // MISSED ANNOUNCEMENTS CAROUSEL
  // ==========================================

  async initMissedAnnouncementsCarousel() {
    try {
      const missed = await API.getMissedAnnouncements();
      if (!missed || missed.length === 0) return;

      let currentIndex = 0;

      const modal = document.getElementById('missedAnnouncementsModal');
      const counterEl = document.getElementById('carouselCounter');
      const titleEl = document.getElementById('carouselTitle');
      const metaEl = document.getElementById('carouselMeta');
      const contentEl = document.getElementById('carouselContent');
      const headerImgWrap = document.getElementById('carouselHeaderImg');
      const headerImgEl = document.getElementById('carouselHeaderImgEl');
      const prevBtn = document.getElementById('carouselPrevBtn');
      const nextBtn = document.getElementById('carouselNextBtn');
      const dismissBtn = document.getElementById('carouselDismissBtn');

      if (!modal) return;

      const renderSlide = (index) => {
        const a = missed[index];
        counterEl.textContent = `${index + 1} / ${missed.length}`;
        titleEl.textContent = a.title;
        metaEl.textContent = this.formatDateTime(a.created_at);
        contentEl.innerHTML = this.renderMarkdown(a.content);

        if (a.header_image_url) {
          headerImgEl.src = a.header_image_url;
          headerImgWrap.style.display = 'block';
        } else {
          headerImgWrap.style.display = 'none';
        }

        prevBtn.disabled = index === 0;
        nextBtn.disabled = index === missed.length - 1;
      };

      const dismiss = async () => {
        modal.classList.remove('active');
        const lastId = missed[missed.length - 1].id;
        try {
          await API.markAnnouncementsSeen(lastId);
        } catch (e) {
          console.warn('Could not mark announcements as seen', e);
        }
      };

      prevBtn.addEventListener('click', () => {
        if (currentIndex > 0) {
          currentIndex--;
          renderSlide(currentIndex);
        }
      });

      nextBtn.addEventListener('click', () => {
        if (currentIndex < missed.length - 1) {
          currentIndex++;
          renderSlide(currentIndex);
        }
      });

      dismissBtn.addEventListener('click', dismiss);

      // Backdrop click also dismisses
      modal.querySelector('.modal-backdrop').addEventListener('click', dismiss);

      renderSlide(0);
      if (this.canvasRenderer) {
        this.canvasRenderer.setPlayhead(null);
        this.canvasRenderer.setSnapGuide(null);
      }
      modal.classList.add('active');
    } catch (err) {
      console.warn('Could not load missed announcements:', err);
    }
  }

  renderMarkdown(rawText) {
    if (!rawText) return '';

    // First escape HTML entities to prevent XSS
    const escaped = this._escapeHtml(rawText);
    const lines = escaped.split(/\r?\n/);
    const result = [];
    let inList = false;

    const formatInline = (str) => {
      return str
        .replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>')
        .replace(/_([^_\n]+)_/g, '<em>$1</em>');
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const listMatch = line.match(/^(\s*)\*\s+(.+)$/);

      if (listMatch) {
        if (!inList) {
          inList = true;
          result.push('<ul class="announcement-ul">');
        }
        result.push(`<li>${formatInline(listMatch[2])}</li>`);
      } else {
        if (inList) {
          inList = false;
          result.push('</ul>');
        }
        if (line.trim() === '') {
          result.push('<div class="announcement-spacer"></div>');
        } else {
          result.push(`<p class="announcement-p">${formatInline(line)}</p>`);
        }
      }
    }

    if (inList) {
      result.push('</ul>');
    }

    return result.join('');
  }

  _escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * Dismiss the topmost stacked modal, if one is open, and say whether it did.
   *
   * Deliberately does NOT touch selectedTask or the canvas overlays: whatever
   * is underneath is still open and still being edited.
   */
  closeTopModal() {
    const top = document.querySelector('.modal-container.modal-layer-top.active');
    if (!top) return false;
    top.classList.remove('active');
    return true;
  }

  closeAllModals() {
    document.querySelectorAll('.modal-container, .context-menu').forEach(m => m.classList.remove('active'));
    this.selectedTask = null;
    // The one place a pinned tooltip is released. Every menu and modal close
    // funnels through here, so it cannot be left hanging on screen.
    if (this.domRenderer) this.domRenderer.unpinTooltip();
    if (this.canvasRenderer) {
      this.canvasRenderer.setPlayhead(null);
      this.canvasRenderer.setSnapGuide(null);
      // Every menu and modal close funnels through here, so the cut marker
      // cannot outlive the menu that placed it - unless a split placement has
      // taken ownership of it, which is a mode rather than a menu.
      if (!this.pendingSplit) this.canvasRenderer.setCutMarker(null);
    }
  }

  // Canvas grid and DOM task blocks share one geometry, so they always redraw
  // as a pair. Anything that changes layout goes through here.
  renderTimeline() {
    if (this.canvasRenderer) this.canvasRenderer.render();
    if (this.domRenderer) this.domRenderer.render();
    this.updateZoomUI();
  }

  renderAll() {
    this.renderTimeline();
    if (this.sidebarController) this.sidebarController.render();
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.klndr = new KlndrApp();
  window.klndr.init();
});
