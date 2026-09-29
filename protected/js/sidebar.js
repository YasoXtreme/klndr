// Klndr Tasks Sidebar Controller
// Handles single-column and multi-column category views, the tick (and the pause
// before a ticked row moves on), the list's motion, filter tabs (default:
// Uncompleted & Unscheduled), and inline task creation with dynamic background color.

const UNCATEGORIZED = CategoryPicker.UNCATEGORIZED;

class TasksSidebar {
  // A drag has to earn the gesture. Starting one on the bare press built a ghost
  // on every click, and on touch it made the list unscrollable: the first
  // finger-down became a drag and the scroll never happened.
  static MOUSE_DRAG_THRESHOLD_PX = 4;
  static TOUCH_SLOP_PX = 10;
  static LONG_PRESS_MS = 400;

  // The tick. Every part of it is over by CHECK_MS (the streaks finish last,
  // 225ms in + 440ms); a card built after that draws its resting state.
  static CHECK_MS = 700;
  static UNCHECK_MS = 300;

  // How long a ticked row keeps its place before it moves on: long enough to
  // see the tick land and to take it back with a second click, short enough
  // that clearing a list never waits on it.
  static CHECK_PAUSE_MS = 1000;
  static UNCHECK_PAUSE_MS = 500;

  // How long after a list change render() measures before it rebuilds: long
  // enough for a reorder's moves. A settle's close-up runs longer, and
  // playFlip stretches the window to cover it.
  static MOTION_WINDOW_MS = 560;
  static LIST_EASING = 'cubic-bezier(0.2, 0.9, 0.3, 1.15)';

  // A leaving row lifts, then slides clean out of the list. Nothing below it
  // moves until it has gone: two rows crossing each other read as a collision.
  static EXIT_MS = 400;

  // The rows then close up one after another rather than as one block, each on
  // a spring. Row n waits STAGGER_MS * ln(1 + n): the first goes at once and
  // each one after waits a little less extra than the one before, so a long
  // list still closes up in a moment rather than rippling for seconds.
  static STAGGER_MS = 70;

  // One damped spring, sampled once and scaled to each row's distance. Lightly
  // underdamped: it overshoots by about 7% and settles in about 450ms.
  static SPRING = (() => {
    const omega = 20;
    const zeta = 0.65;
    const damped = omega * Math.sqrt(1 - zeta * zeta);
    const at = t => Math.exp(-zeta * omega * t) *
      (Math.cos(damped * t) + (zeta * omega / damped) * Math.sin(damped * t));
    const step = 1 / 60;
    const steps = Math.ceil(Math.log(1 / 0.003) / (zeta * omega) / step);
    const points = Array.from({ length: steps + 1 }, (_, i) => ({
      offset: i / steps,
      k: i === steps ? 0 : at(i * step)
    }));
    return { points, duration: steps * step * 1000 };
  })();

  // Eight streaks around the checkbox, long and short in turn. The 64-unit
  // box is sized off the checkbox in CSS, so a phone's bigger box throws them
  // further.
  static BURST_SVG = (() => {
    const lines = Array.from({ length: 8 }, (_, k) => {
      const angle = (k * 45 + 22.5) * Math.PI / 180;
      const at = r => [r * Math.cos(angle), r * Math.sin(angle)].map(v => v.toFixed(2));
      const [x1, y1] = at(13);
      const [x2, y2] = at(k % 2 ? 19 : 24);
      return `<line pathLength="10" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
    }).join('');
    return `<svg class="task-check-burst" viewBox="-32 -32 64 64" aria-hidden="true">${lines}</svg>`;
  })();

  static prefersReducedMotion() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  // Done means every block is: a part-done task is not.
  static isDone(task) {
    return TaskModel.completionState(task) === 'all';
  }

  constructor(containerElement, state, onTaskInteraction, onDragStart, onToggleCollapse) {
    this.container = containerElement;
    this.state = state;
    this.onTaskInteraction = onTaskInteraction;
    this.onDragStart = onDragStart;
    this.onToggleCollapse = onToggleCollapse;

    this.searchQuery = '';
    this.activeCategoryFilter = 'UNCOMPLETED_UNSCHEDULED'; // Default filter: Uncompleted & Unscheduled
    this.isSearchOpen = false;
    this.isCollapsed = false;
    this.isFullView = false; // True when calendar is collapsed -> multi-column mode

    // Ticks in flight: taskId -> { at, to, layoutAs }. See noteCompletion.
    this.checkMotion = new Map();
    this.settleTimers = new Map();

    // The row a move just landed, and until when it keeps its slab.
    this.justMoved = null;
    // Until when render() carries on the list's motion. See animateChange.
    this.motionUntil = 0;
    this.inChange = false;
    // When each row closing up behind a settle is due to start: taskId -> ms.
    // A rebuild before then must keep it waiting - see playFlip.
    this.closeUpStarts = new Map();

    // When a tick emptied the list, which then says "All clear" until it
    // changes. pendingClear is raised only for the settle render that might.
    this.clearedAt = null;
    this.pendingClear = false;

    // A fresh draft carries no category. klndr ships none, so there is nothing
    // to fall back to and nothing to pretend with.
    this.newTaskState = {
      icon: KlndrPalette.DEFAULT_ICON,
      color: KlndrPalette.DEFAULT_COLOR,
      category: null
    };

    this.availableIcons = KlndrPalette.icons;
    this.availableColors = KlndrPalette.colors;

    this.initControls();
  }

  // The categories this person owns, in their own order.
  get categories() {
    return this.state.categories || [];
  }

  /**
   * Every category the board must be able to show a column for: the ones the
   * person owns, plus any name still sitting on a task that no category covers.
   *
   * The union is not decoration. The multi-column view iterates categories, not
   * tasks, so a name missing from this list is a task that silently disappears,
   * and a stale name stays reachable: a rename whose cascade half-failed, a
   * second tab that renamed it, a task belonging to a week this client never
   * loaded. Orphans render without a swatch, which is the visible tell that
   * something needs re-tagging.
   */
  get categoryColumns() {
    const owned = this.categories;
    const known = new Set(owned.map(cat => cat.name));
    const orphans = [...new Set(
      (this.state.tasks || [])
        .map(task => task.category)
        .filter(name => name && !known.has(name))
    )];
    return [...owned, ...orphans.map(name => ({ id: null, name, color: null, icon: null }))];
  }

  /**
   * Records which shape the pane is in. It deliberately does NOT render: during
   * a split the app builds the incoming list at its final width BEFORE the pane
   * starts moving, and owns the cross-fade timing from there. Rendering here
   * would put the rebuild back in the same tick as the class toggle, which is
   * what used to make the whole transition skip on a busy board.
   */
  setFullView(isFull) {
    this.isFullView = isFull;
    this.container.classList.toggle('is-full-view', isFull);
  }

  /**
   * Filling the workspace and showing a kanban are two different questions, and
   * on a phone they have different answers: the pane should fill the screen,
   * but 280px columns on a 375px screen are a board you can only ever see one
   * column of. The flat list says more at the same width.
   */
  get listMode() {
    return this.listModeFor(this.isFullView);
  }

  // The same question asked of a state this pane is not in yet - the split
  // orchestrator uses it to build the incoming shape before anything changes.
  listModeFor(isFull) {
    return (isFull && document.body.dataset.layout !== 'phone') ? 'kanban' : 'list';
  }

  bodyEl(mode) {
    return document.getElementById(
      mode === 'kanban' ? 'tasksMulticolumnContainer' : 'sidebarTasksList'
    );
  }

  // Visibility is a class, never `display`: the two shapes are stacked in the
  // same box so one can dissolve into the other, and a display swap cannot be
  // cross-faded.
  setActiveBody(mode) {
    ['kanban', 'list'].forEach(candidate => {
      const el = this.bodyEl(candidate);
      if (el) el.classList.toggle('is-active', candidate === mode);
    });
  }

  // Dropping the shape that is no longer showing, once the cross-fade is over.
  // Task cards carry their own pointer listeners, so leaving a stale set of
  // them alive is a leak that also doubles up on the next drag.
  clearBody(mode) {
    const el = this.bodyEl(mode);
    if (el) el.innerHTML = '';
  }

  initControls() {
    const searchBtn = document.getElementById('sidebarSearchBtn');
    const filterBtn = document.getElementById('sidebarFilterBtn');
    const collapseBtn = document.getElementById('sidebarCollapseBtn');
    const searchInput = document.getElementById('sidebarSearchInput');
    const searchBarContainer = document.getElementById('sidebarSearchBar');

    if (searchBtn && searchBarContainer) {
      searchBtn.addEventListener('click', () => {
        this.isSearchOpen = !this.isSearchOpen;
        searchBarContainer.style.display = this.isSearchOpen ? 'block' : 'none';
        if (this.isSearchOpen && searchInput) {
          searchInput.focus();
        }
      });
    }

    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        this.searchQuery = e.target.value.toLowerCase().trim();
        this.clearedAt = null;
        this.render();
      });
    }

    if (filterBtn) {
      filterBtn.addEventListener('click', () => {
        const filterBar = document.getElementById('sidebarFilterBar');
        if (filterBar) {
          filterBar.style.display = filterBar.style.display === 'none' ? 'flex' : 'none';
        }
      });
    }

    if (collapseBtn) {
      collapseBtn.addEventListener('click', () => {
        this.toggleCollapse();
      });
    }

    // Filter pills. Delegated rather than bound per pill: the category pills are
    // rebuilt whenever the category list changes, and per-pill handlers would go
    // with them.
    const filterBar = document.getElementById('sidebarFilterBar');
    if (filterBar) {
      filterBar.addEventListener('click', (e) => {
        const pill = e.target.closest('.category-filter-pill');
        if (!pill || !filterBar.contains(pill)) return;
        filterBar.querySelectorAll('.category-filter-pill')
          .forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        this.activeCategoryFilter = pill.dataset.category || 'UNCOMPLETED_UNSCHEDULED';
        // "All clear" was about the list that was just emptied, not this one.
        this.clearedAt = null;
        this.render();
      });
    }

    this.initInlineCreationBar();
  }

  initInlineCreationBar() {
    const textInput = document.getElementById('inlineTaskInput');
    const createBox = document.querySelector('.inline-create-box');
    const iconBtn = document.getElementById('btnInlineIcon');
    const colorBtn = document.getElementById('btnInlineColor');
    const categoryBtn = document.getElementById('btnInlineCategory');

    const iconPopup = document.getElementById('inlineIconPopup');
    const colorPopup = document.getElementById('inlineColorPopup');
    const categoryPopup = document.getElementById('inlineCategoryPopup');

    if (createBox) {
      KlndrTheme.paint(createBox, this.newTaskState.color);
    }

    const closeAllPopups = () => {
      if (iconPopup) iconPopup.style.display = 'none';
      if (colorPopup) colorPopup.style.display = 'none';
      if (categoryPopup) categoryPopup.style.display = 'none';
    };

    // Populate Icon Popup (20 Google Icons)
    if (iconPopup) {
      iconPopup.innerHTML = '';
      this.availableIcons.forEach(iconName => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'picker-item-icon';
        item.title = iconName;
        item.innerHTML = `<span class="material-symbols-outlined">${iconName}</span>`;
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          this.newTaskState.icon = iconName;
          iconBtn.querySelector('.material-symbols-outlined').textContent = iconName;
          closeAllPopups();
        });
        iconPopup.appendChild(item);
      });
    }

    // Populate Color Popup (20 Colors)
    if (colorPopup) {
      colorPopup.innerHTML = '';
      this.availableColors.forEach(colorHex => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'picker-item-color';
        KlndrTheme.paint(item, colorHex);
        item.title = colorHex;
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          this.newTaskState.color = colorHex;
          if (createBox) KlndrTheme.paint(createBox, colorHex);
          closeAllPopups();
        });
        colorPopup.appendChild(item);
      });
    }

    // The category popup is built on OPEN, not here. It has to show whatever
    // the person owns right now, and this runs before the categories have even
    // been fetched.
    this.renderCategoryPopup = () => {
      CategoryPicker.render(categoryPopup, {
        categories: this.categories,
        selectedName: this.newTaskState.category,
        onPick: (category) => {
          this.applyCategoryToDraft(this.newTaskState, category, createBox);
          categoryBtn.title = KlndrApp.categoryButtonTitle(this.newTaskState.category);
          if (iconBtn) {
            iconBtn.querySelector('.material-symbols-outlined').textContent =
              this.newTaskState.icon;
          }
          closeAllPopups();
        },
        onEdit: (category) => {
          closeAllPopups();
          this.onTaskInteraction('editCategory', { category });
        },
        onCreate: () => {
          closeAllPopups();
          this.onTaskInteraction('createCategory', {});
        }
      });
    };

    if (iconBtn) {
      iconBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = iconPopup.style.display === 'grid';
        closeAllPopups();
        iconPopup.style.display = isOpen ? 'none' : 'grid';
      });
    }

    if (colorBtn) {
      colorBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = colorPopup.style.display === 'grid';
        closeAllPopups();
        colorPopup.style.display = isOpen ? 'none' : 'grid';
      });
    }

    if (categoryBtn) {
      categoryBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = categoryPopup.style.display === 'flex';
        closeAllPopups();
        if (isOpen) return;
        this.renderCategoryPopup();
        categoryPopup.style.display = 'flex';
      });
    }

    window.addEventListener('click', () => closeAllPopups());

    if (textInput) {
      textInput.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const title = textInput.value.trim();
          if (!title) return;

          await this.onTaskInteraction('createInlineTask', {
            title,
            default_timing: 120,
            total_duration: 120,
            icon: this.newTaskState.icon || 'task_alt',
            color: this.newTaskState.color || '#3ba4f6',
            category: this.newTaskState.category || null,
            is_locked: true,
            start_times: [],
            durations: []
          });

          textInput.value = '';
          closeAllPopups();
        }
      });
    }
  }

  /**
   * Give a draft the look of the category it just joined.
   *
   * The early-out is the whole rule the person asked for: picking a category
   * hands over its default colour and icon, but re-picking the one already
   * selected must not undo a colour they deliberately chose afterwards. Nothing
   * else re-applies a category's defaults, so a manual pick always wins from
   * there on and no "has the user touched this?" bookkeeping is needed.
   */
  applyCategoryToDraft(draft, category, createBox) {
    const nextName = category.name || null;
    if (nextName === draft.category) return;

    draft.category = nextName;
    if (category.color) draft.color = category.color;
    if (category.icon) draft.icon = category.icon;
    if (createBox) KlndrTheme.paint(createBox, draft.color);
  }

  /**
   * Asks for the collapse; it does not perform it. The app owns the split -
   * the classes, the frozen widths and the cross-fade all have to be applied in
   * one order by one place, and this used to toggle .is-collapsed itself and
   * then let the app toggle the other pane, which is how the two panes ended up
   * able to disagree about the state they were in.
   */
  toggleCollapse() {
    if (this.onToggleCollapse) {
      this.onToggleCollapse(!this.isCollapsed);
    }
  }

  // Called by the app once the split has been decided, so the chevron always
  // points at what the button will actually do next.
  setCollapsed(collapsed) {
    this.isCollapsed = collapsed;
    this.container.classList.toggle('is-collapsed', collapsed);

    const iconSpan = document
      .getElementById('sidebarCollapseBtn')
      ?.querySelector('.material-symbols-outlined');
    if (iconSpan) {
      iconSpan.textContent = collapsed ? 'chevron_left' : 'chevron_right';
    }
  }

  // ==========================================
  // THE TICK
  // ==========================================

  /**
   * The checkbox. Ticking drives every block of the task; a part-done task
   * counts as not done, so this always completes it rather than toggling from
   * 'partial'.
   *
   * It does not touch the task itself. The app's optimistic update does that,
   * and it has to be the one to: it snapshots the task for undo and for rolling
   * back a failed save, and a task this had already changed handed it a
   * "before" equal to the "after" - so a tick from here could never be undone.
   */
  handleTaskCompletionToggle(task, pointerType) {
    const completed = !TasksSidebar.isDone(task);
    this.noteCompletion(task, completed);
    // A finger covers the box it taps, so the tick lands out of sight; the
    // buzz is the part of it that reaches.
    if (completed && pointerType && pointerType !== 'mouse' && navigator.vibrate) {
      navigator.vibrate(12);
    }
    this.onTaskInteraction('toggleComplete', { taskId: task.id, completed });
  }

  /**
   * Starts a tick's motion: the celebration on the card, a pause in place, and
   * then the settle that sends the row where its new state belongs. Called
   * BEFORE the change is applied - by the checkbox, and by the app when a
   * calendar pill is what finished the task - because the pause has to know
   * where the row was laid out until now.
   */
  noteCompletion(task, completed) {
    const pending = this.checkMotion.get(task.id);
    // A second click during the pause keeps the ORIGINAL place: the row has
    // not moved yet, whichever way it is heading now. Unless an undo already
    // moved it, in which case where it is now is where it was.
    const layoutAs = pending && pending.to === TasksSidebar.isDone(task)
      ? pending.layoutAs
      : Boolean(task.completed);
    this.checkMotion.set(task.id, { at: performance.now(), to: completed, layoutAs });
    this.scheduleSettle(task.id,
      completed ? TasksSidebar.CHECK_PAUSE_MS : TasksSidebar.UNCHECK_PAUSE_MS);
  }

  scheduleSettle(taskId, delay) {
    clearTimeout(this.settleTimers.get(taskId));
    this.settleTimers.set(taskId, setTimeout(() => this.settleCheck(taskId), delay));
  }

  // The pause is over: the row goes where its state says it belongs - off the
  // list, or down to its done end - and the rest close up behind it.
  settleCheck(taskId) {
    this.settleTimers.delete(taskId);
    // Never under a drag: the rebuild would tear out the row it is holding.
    if (this.state.isDragging) {
      this.scheduleSettle(taskId, 250);
      return;
    }
    const motion = this.checkMotion.get(taskId);
    this.checkMotion.delete(taskId);
    if (!motion) return;

    // Only a tick that still stands, on a row that was in the list, can be what
    // cleared it - a calendar tick on a task this filter hides is not.
    const task = (this.state.tasks || []).find(t => t.id === taskId);
    const shown = this.bodyEl(this.listMode)
      ?.querySelector(`.sidebar-task-card[data-task-id="${taskId}"]`);
    this.pendingClear = Boolean(task && shown && motion.to && TasksSidebar.isDone(task));
    try {
      this.animateChange(() => this.render(), { settledId: taskId });
    } finally {
      this.pendingClear = false;
    }
  }

  // The completion a row is LAID OUT by, which is what filtering and sorting
  // read. During the pause after a tick it is the state the row had before, so
  // the row holds its place while the tick lands; everything else on the card
  // already shows the new state.
  layoutCompleted(task) {
    const motion = this.checkMotion.get(task.id);
    if (motion && motion.to === TasksSidebar.isDone(task)) return motion.layoutAs;
    return Boolean(task.completed);
  }

  /**
   * How far into its tick a card is, if it is in one.
   *
   * Asked of the clock rather than of an element: the list is rebuilt from
   * scratch on every render, and the save's own reply lands mid-tick. Each new
   * card starts its animation at the elapsed time instead (a negative delay -
   * see --check-t), so a rebuild is invisible. A tick the task no longer agrees
   * with - an undo, a failed save - is not played at all, and with motion
   * reduced none is: the row simply shows its new state for the pause.
   */
  tickMotion(task) {
    const motion = this.checkMotion.get(task.id);
    if (!motion || motion.to !== TasksSidebar.isDone(task)) return null;
    if (TasksSidebar.prefersReducedMotion()) return null;
    const elapsed = performance.now() - motion.at;
    const span = motion.to ? TasksSidebar.CHECK_MS : TasksSidebar.UNCHECK_MS;
    return elapsed < span ? { completed: motion.to, elapsed } : null;
  }

  // Filter helper. Completion is read as laid out - see layoutCompleted.
  filterTasks(tasks) {
    return tasks.filter(task => {
      if (this.searchQuery && !task.title.toLowerCase().includes(this.searchQuery)) {
        return false;
      }
      const isScheduled = task.start_times && task.start_times.length > 0;
      const isDone = this.layoutCompleted(task);

      if (this.activeCategoryFilter === 'UNCOMPLETED_UNSCHEDULED') {
        return !isDone && !isScheduled;
      }
      if (this.activeCategoryFilter === 'UNCOMPLETED') {
        return !isDone;
      }
      if (this.activeCategoryFilter === 'COMPLETED') {
        return isDone;
      }
      if (this.activeCategoryFilter === 'UNSCHEDULED') {
        return !isScheduled;
      }
      if (this.activeCategoryFilter === UNCATEGORIZED) {
        return !task.category;
      }
      if (this.activeCategoryFilter !== 'ALL') {
        return task.category === this.activeCategoryFilter;
      }
      return true;
    });
  }

  createTaskCardElement(task) {
    const isScheduled = task.start_times && task.start_times.length > 0;

    const card = document.createElement('div');
    card.className = `sidebar-task-card ${task.completed ? 'is-completed' : ''}`;
    if (TaskModel.isSplit(task)) card.dataset.blockCount = (task.segments || []).length;
    card.dataset.taskId = task.id;
    KlndrTheme.paint(card, task.color || KlndrPalette.DEFAULT_COLOR);

    const tick = this.tickMotion(task);
    if (tick) {
      card.classList.add(tick.completed ? 'is-checking' : 'is-unchecking');
      card.style.setProperty('--check-t', `${-Math.round(tick.elapsed)}ms`);
    }
    // A rebuild must not take the slab out from under a row that just landed.
    const slabLeft = this.justMoved && this.justMoved.id === task.id
      ? this.justMoved.until - performance.now()
      : 0;
    if (slabLeft > 0) TasksSidebar.holdSlab(card, slabLeft);

    // Circular Category Badge
    const badge = document.createElement('div');
    badge.className = 'task-badge-circle';
    badge.appendChild(TimelineDOM.getCategoryIconElement(task.icon));
    card.appendChild(badge);

    // Checkbox. A split task has three states, not two: the middle one means
    // some of its blocks are done, and must not read as "not started".
    const completionState = TaskModel.completionState(task);
    const checkbox = document.createElement('button');
    checkbox.type = 'button';
    checkbox.className = [
      'task-checkbox',
      completionState === 'all' ? 'checked' : '',
      completionState === 'partial' ? 'is-partial' : ''
    ].filter(Boolean).join(' ');
    checkbox.title = completionState === 'all'
      ? 'Mark uncompleted'
      : completionState === 'partial'
        ? `${(task.segments || []).filter(seg => seg.completed).length} of ${(task.segments || []).length} blocks done — click to finish all`
        : 'Mark completed';
    // The fill and the tick are always in the box, and the state only decides
    // whether they show. That is what lets a tick grow them in and an untick
    // drain them away, rather than one glyph simply swapping for another.
    checkbox.innerHTML = `
      <span class="task-checkbox-fill"></span>
      <svg class="task-checkbox-tick" viewBox="0 0 16 16" aria-hidden="true"><path pathLength="1" d="${TimelineDOM.TICK_PATH}"/></svg>
      ${completionState === 'partial' ? '<span class="task-checkbox-partial"></span>' : ''}
      ${tick && tick.completed ? TasksSidebar.BURST_SVG : ''}
    `;
    checkbox.addEventListener('click', (e) => {
      e.stopPropagation();
      this.handleTaskCompletionToggle(task, e.pointerType);
    });

    // Content Body
    const content = document.createElement('div');
    content.className = 'task-content-inner';

    // Same line, same style, same position as on a calendar block. An imported
    // title reads "M1 S3", which names the session but not the subject, and in
    // the flat list beside the calendar nothing else says it. Hidden inside a
    // kanban column, where the column header has already said it.
    if (task.category) {
      const categoryEl = document.createElement('div');
      categoryEl.className = 'task-category-text';
      categoryEl.textContent = task.category;
      content.appendChild(categoryEl);
    }

    // The words sit in an inline span of their own: the strike is drawn along
    // it rather than as a line-through, which cannot be animated. See
    // .task-title-ink.
    const titleEl = document.createElement('div');
    titleEl.className = 'task-title-text';
    const titleInk = document.createElement('span');
    titleInk.className = 'task-title-ink';
    titleInk.textContent = task.title;
    titleEl.appendChild(titleInk);
    content.appendChild(titleEl);

    const metaEl = document.createElement('div');
    metaEl.className = 'task-meta-text';
    const dur = task.default_timing || task.total_duration || 120;
    // "Drag to schedule" was a tutorial, not information: it said the same
    // thing on every unscheduled card forever. "Scheduled" stays, because in a
    // list that mixes both it is the one thing the card does not otherwise say.
    metaEl.textContent = `${dur} min${isScheduled ? ' • Scheduled' : ''}`;
    content.appendChild(metaEl);

    card.appendChild(content);

    // The controls on the card's right edge, as one group. On a desktop it
    // is display:contents and the checkbox keeps its corner; on a phone it is
    // a column of its own beside the text, so the two can never overlap.
    const actions = document.createElement('div');
    actions.className = 'task-card-actions';
    actions.appendChild(checkbox);

    // Reordering by drag is gone on a phone: a long press in this list now
    // hands the gesture to the calendar, because that is the only way a task
    // can reach it there. These put the ordering back, and the stylesheet shows
    // them only where that trade was actually made.
    const nudges = document.createElement('div');
    nudges.className = 'task-nudge-group';
    const nudge = (direction, icon, label) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `btn-task-nudge is-${direction < 0 ? 'up' : 'down'}`;
      btn.title = label;
      btn.innerHTML = `<span class="material-symbols-outlined">${icon}</span>`;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onTaskInteraction('moveTaskInList', { task, direction });
      });
      nudges.appendChild(btn);
    };
    nudge(-1, 'keyboard_arrow_up', 'Move up');
    nudge(1, 'keyboard_arrow_down', 'Move down');
    actions.appendChild(nudges);
    card.appendChild(actions);


    // Drag initiation. Deferred rather than immediate - see the thresholds on
    // the class. No preventDefault: on touch it would kill the scroll we are
    // deliberately leaving to the browser, and .sidebar-task-card is already
    // user-select:none, which was all it bought for the mouse.
    card.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.task-checkbox, .task-nudge-group')) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;

      const isTouch = e.pointerType !== 'mouse';
      const pointerId = e.pointerId;
      const startX = e.clientX;
      const startY = e.clientY;
      let armed = false;
      let timer = null;

      const cleanup = () => {
        clearTimeout(timer);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
      };

      const start = () => {
        if (armed) return;
        armed = true;
        clearTimeout(timer);
        if (isTouch && navigator.vibrate) navigator.vibrate(10);
        this.onDragStart(task, startX, startY, pointerId);
      };

      const onMove = (ev) => {
        if (ev.pointerId !== pointerId || armed) return;
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        // The same travel means opposite things: for a mouse it is intent to
        // drag, for a finger it is the list being scrolled.
        if (isTouch) {
          if (dist > TasksSidebar.TOUCH_SLOP_PX) cleanup();
        } else if (dist > TasksSidebar.MOUSE_DRAG_THRESHOLD_PX) {
          start();
        }
      };

      const onUp = (ev) => {
        if (ev.pointerId !== pointerId) return;
        const wasArmed = armed;
        cleanup();
        // A press that never became a drag is a tap, and on touch that opens
        // the editor - the job dblclick does for a mouse.
        if (!wasArmed && isTouch) {
          this.onTaskInteraction('openEditModal', { task });
        }
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);

      if (isTouch) timer = setTimeout(start, TasksSidebar.LONG_PRESS_MS);
    });

    // Double click & Context Menu
    card.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      this.onTaskInteraction('openEditModal', { task });
    });

    card.addEventListener('contextmenu', (e) => {
      // preventDefault unconditionally - that is what refuses the OS callout.
      // But only a mouse gets the app's menu: Android raises this ~500ms into
      // the very press that armed the drag at 400ms, and opening a menu there
      // does not merely interrupt the drag, it freezes it, because
      // handleDragMove stands down while one is open. A finger reaches these
      // actions by tapping the task and using More... in the editor.
      e.preventDefault();
      e.stopPropagation();
      if (TimelineDOM.isTouchInput()) return;
      this.onTaskInteraction('openContextMenu', { task, clientX: e.clientX, clientY: e.clientY });
    });

    return card;
  }

  /**
   * One pill per category, after the five status pills that live in the markup.
   *
   * Rebuilt from scratch on every render because a category can be added,
   * renamed or deleted from three different places. If the active filter names
   * a category that has just gone, fall back to the default rather than leaving
   * the panel filtered to nothing with no pill to explain why.
   */
  renderCategoryFilterPills() {
    const bar = document.getElementById('sidebarFilterBar');
    if (!bar) return;

    bar.querySelectorAll('.category-filter-pill.is-category').forEach(p => p.remove());

    const names = this.categoryColumns.map(cat => cat.name);
    const hasLoose = (this.state.tasks || []).some(task => !task.category);
    const entries = names.map(name => ({ value: name, label: name }));
    if (hasLoose) entries.push({ value: UNCATEGORIZED, label: 'Uncategorized' });

    const stillThere = entries.some(entry => entry.value === this.activeCategoryFilter);
    const isStatusFilter = ['ALL', 'UNCOMPLETED_UNSCHEDULED', 'UNCOMPLETED', 'COMPLETED', 'UNSCHEDULED']
      .includes(this.activeCategoryFilter);
    if (!isStatusFilter && !stillThere) {
      this.activeCategoryFilter = 'UNCOMPLETED_UNSCHEDULED';
    }

    entries.forEach(entry => {
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'category-filter-pill is-category';
      pill.dataset.category = entry.value;
      pill.textContent = entry.label;
      bar.appendChild(pill);
    });

    bar.querySelectorAll('.category-filter-pill').forEach(pill => {
      pill.classList.toggle('active', pill.dataset.category === this.activeCategoryFilter);
    });
  }

  render() {
    const mode = this.listMode;
    // A render that lands while rows are still moving - the save's reply to
    // the tick before, say - measures where they are now and carries on from
    // there, instead of snapping them to the end of a move nobody saw finish.
    const before = !this.inChange && performance.now() < this.motionUntil
      ? this.measureCards()
      : null;
    this.renderInto(mode);
    this.setActiveBody(mode);
    if (before) this.playFlip(before);
  }

  /**
   * Fills one of the two shapes. Split apart from render() so the orchestrator
   * can build the INCOMING shape at its final width while the outgoing one is
   * still the visible, active one.
   */
  renderInto(mode = this.listMode) {
    const listEl = document.getElementById('sidebarTasksList');
    const multicolumnEl = document.getElementById('tasksMulticolumnContainer');
    if (!listEl) return;

    this.renderCategoryFilterPills();

    const allTasks = this.state.tasks || [];
    const filteredTasks = this.filterTasks(allTasks);

    // Uncompleted on top, completed at the bottom - as laid out, so a row
    // pausing after its tick is still sorted where it was.
    const sortedTasks = [...filteredTasks].sort((a, b) =>
      Number(this.layoutCompleted(a)) - Number(this.layoutCompleted(b)));

    // ==========================================
    // MULTI-COLUMN KANBAN VIEW (When Calendar is Collapsed)
    // ==========================================
    if (mode === 'kanban') {
      if (!multicolumnEl) return;
      multicolumnEl.innerHTML = '';

      const columns = this.categoryColumns.map(category => ({
        category,
        key: category.name,
        tasks: sortedTasks.filter(t => t.category === category.name)
      }));

      // Uncategorised only earns a column when something is actually in it -
      // an always-present empty bucket is noise on a board that starts with no
      // categories at all. It is still a drop target once it is there, which is
      // how a task gets un-filed.
      const loose = sortedTasks.filter(t => !t.category);
      if (loose.length) {
        columns.push({
          category: { id: null, name: 'Uncategorized', color: null, icon: null },
          key: UNCATEGORIZED,
          tasks: loose
        });
      }

      if (!columns.length) {
        const empty = document.createElement('div');
        empty.className = 'sidebar-empty-state multicolumn-empty-state';
        empty.innerHTML = `
          <p>No categories yet</p>
          <span>Add one from Account &amp; Settings, or from the category picker below</span>
        `;
        multicolumnEl.appendChild(empty);
        return;
      }

      columns.forEach(({ category, key, tasks }) => {
        const col = document.createElement('div');
        col.className = 'task-category-column';

        const header = document.createElement('div');
        header.className = 'category-column-header';

        // A column with no swatch is the visible tell that its name is on tasks
        // but has no category record behind it any more.
        const swatch = document.createElement('span');
        swatch.className = `category-column-swatch ${category.color ? '' : 'is-blank'}`.trim();
        if (category.color) KlndrTheme.paint(swatch, category.color);
        if (category.icon) {
          swatch.appendChild(CategoryPicker.buildIcon(category.icon));
        }
        header.appendChild(swatch);

        const label = document.createElement('span');
        label.className = 'category-column-name';
        label.textContent = category.name;
        header.appendChild(label);

        const count = document.createElement('span');
        count.className = 'category-column-count';
        count.textContent = tasks.length;
        header.appendChild(count);
        col.appendChild(header);

        const body = document.createElement('div');
        body.className = 'category-column-body';
        body.dataset.category = key;

        if (tasks.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'category-column-empty';
          empty.textContent = 'No tasks in this category';
          body.appendChild(empty);
        } else {
          tasks.forEach(task => {
            body.appendChild(this.createTaskCardElement(task));
          });
        }

        col.appendChild(body);
        multicolumnEl.appendChild(col);
      });
      return;
    }

    // ==========================================
    // STANDARD SINGLE-COLUMN SIDEBAR VIEW
    // ==========================================
    listEl.innerHTML = '';

    if (sortedTasks.length === 0) {
      if (this.pendingClear) this.clearedAt = performance.now();
      if (this.clearedAt) {
        listEl.appendChild(this.allClearElement());
        return;
      }
      const emptyNotice = document.createElement('div');
      emptyNotice.className = 'sidebar-empty-state';
      emptyNotice.innerHTML = `
        <p>No tasks found</p>
        <span>Type in "Write your task here" below to create a task</span>
      `;
      listEl.appendChild(emptyNotice);
      return;
    }
    this.clearedAt = null;

    sortedTasks.forEach(task => {
      listEl.appendChild(this.createTaskCardElement(task));
    });

    // The ends of the list have nowhere to go. Done here rather than in the
    // card, because a card does not know where it sits once filters have had
    // their say.
    const cards = listEl.querySelectorAll('.sidebar-task-card');
    cards.forEach((card, i) => {
      const up = card.querySelector('.btn-task-nudge.is-up');
      const down = card.querySelector('.btn-task-nudge.is-down');
      if (up) up.disabled = i === 0;
      if (down) down.disabled = i === cards.length - 1;
    });
  }

  /**
   * What the list says when a tick is what emptied it: a plate stamped down
   * onto its slab, the way the rows were. It stays until the list changes; a
   * list that is empty for any other reason keeps the ordinary notice.
   */
  allClearElement() {
    const el = document.createElement('div');
    el.className = 'sidebar-empty-state is-all-clear';
    // Played by elapsed time, like a tick: a rebuild during the drop carries
    // on from where it was, and a much later one draws it already landed.
    el.style.setProperty('--check-t', `${-Math.round(performance.now() - this.clearedAt)}ms`);
    el.innerHTML = `
      <div class="all-clear-plate">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path pathLength="1" d="${TimelineDOM.TICK_PATH}"/></svg>
      </div>
      <p>All clear</p>
      <span>Everything on this list is done.</span>
    `;
    return el;
  }

  // ==========================================
  // LIST MOTION
  // ==========================================

  /**
   * Run a change that re-renders the list, and animate the result.
   *
   * A rebuild is a cut between two frames: the rows are simply somewhere else,
   * and nothing says which one moved. Measured before and after (FLIP), each
   * row that changed place slides from where it was to where it is. The app's
   * reorders come through here, and so does a tick's settle.
   *
   * `movedId` is the row the person moved: it rides above the rest and keeps
   * a slab under it for a moment after it lands. `from` overrides where it
   * starts - a drag drops it at the pointer, not back where it was picked up.
   * `settledId` is a row whose tick has just settled: it rides the same way if
   * it went anywhere, and leaves on its own if the filter now hides it.
   */
  animateChange(change, { movedId = null, from = null, settledId = null } = {}) {
    const before = this.measureCards();
    if (movedId && from) {
      before.cards.set(movedId, { ...before.cards.get(movedId), rect: from });
    }
    // Renders for a while after this one measure first too - see render().
    this.motionUntil = performance.now() + TasksSidebar.MOTION_WINDOW_MS;
    this.inChange = true;
    try {
      change();
    } finally {
      this.inChange = false;
    }
    this.playFlip(before, { movedId, settledId });
  }

  // Where every row of the showing shape is, and the scroller that clips it.
  measureCards() {
    const mode = this.listMode;
    const cards = new Map();
    this.bodyEl(mode)?.querySelectorAll('.sidebar-task-card').forEach(el => {
      const scroller = el.closest('.sidebar-tasks-scroll, .category-column-body');
      cards.set(el.dataset.taskId, {
        el,
        rect: el.getBoundingClientRect(),
        clip: scroller ? scroller.getBoundingClientRect() : null
      });
    });
    return { mode, cards };
  }

  playFlip(before, { movedId = null, settledId = null } = {}) {
    // A list that changed shape has nothing to slide from, and while the split
    // is moving the pane its own cross-fade is the animation.
    if (before.mode !== this.listMode) return;
    if (this.container.classList.contains('is-animating')) return;

    const reduced = TasksSidebar.prefersReducedMotion();
    const rows = [...(this.bodyEl(before.mode)?.querySelectorAll('.sidebar-task-card') || [])]
      .map(el => ({ el, id: el.dataset.taskId, rect: el.getBoundingClientRect() }));

    const leaving = Boolean(settledId) && before.cards.has(settledId) &&
      !rows.some(row => row.id === settledId);
    if (leaving) this.exitRow(before.cards.get(settledId), reduced);

    const now = performance.now();
    const moves = rows.map(row => {
      const was = before.cards.get(row.id);
      const dx = was ? was.rect.left - row.rect.left : 0;
      const dy = was ? was.rect.top - row.rect.top : 0;
      return { ...row, dx, dy, moved: Math.abs(dx) >= 1 || Math.abs(dy) >= 1 };
    });

    // A settle's close-up: top to bottom, each row due a little after the one
    // above it, and none before the leaving row is out of the way.
    if (settledId && !reduced) {
      const wait = leaving ? TasksSidebar.EXIT_MS : 0;
      moves
        .filter(m => m.moved && m.id !== settledId)
        .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)
        .forEach((m, n) => {
          this.closeUpStarts.set(m.id, now + wait + TasksSidebar.STAGGER_MS * Math.log(1 + n));
        });
    }

    let lastEnd = now;
    moves.forEach(({ el, id, dx, dy, moved }) => {
      // A moved row lands on its slab even when it went nowhere - it was
      // still picked up. A settled one only if it actually travelled.
      const rides = id === movedId || (id === settledId && moved);
      if (rides) {
        const hold = reduced ? 700 : 900;
        this.justMoved = { id, until: now + hold };
        TasksSidebar.holdSlab(el, hold);
      }
      if (reduced || !moved) return;

      // A row still due to close up springs, from wherever a rebuild found it
      // and not before its turn - so a save reply landing mid-settle neither
      // releases a waiting row early nor flattens the ripple into a block.
      const start = rides ? undefined : this.closeUpStarts.get(id);
      if (start !== undefined) {
        const delay = Math.max(0, start - now);
        const { points, duration } = TasksSidebar.SPRING;
        el.animate(points.map(({ offset, k }) => ({
          offset,
          transform: `translate(${dx * k}px, ${dy * k}px)`
        })), { duration, delay, easing: 'linear', fill: 'backwards' });
        lastEnd = Math.max(lastEnd, now + delay + duration);
        return;
      }

      el.animate(rides ? [
        { transform: `translate(${dx}px, ${dy}px) scale(1)` },
        { transform: `translate(${dx * 0.4}px, ${dy * 0.4}px) scale(1.04)`, offset: 0.45 },
        { transform: 'translate(0, 0) scale(1)' }
      ] : [
        { transform: `translate(${dx}px, ${dy}px)` },
        { transform: 'translate(0, 0)' }
      ], {
        duration: rides ? 420 : 340,
        easing: TasksSidebar.LIST_EASING,
        fill: 'backwards'
      });
      lastEnd = Math.max(lastEnd, now + (rides ? 420 : 340));
    });

    // A staggered close-up outlasts the usual window; renders keep carrying the
    // motion on until the last row has come to rest.
    this.motionUntil = Math.max(this.motionUntil, lastEnd + 50);
    this.closeUpStarts.forEach((start, id) => {
      if (start + TasksSidebar.SPRING.duration < now) this.closeUpStarts.delete(id);
    });
  }

  // The slab a moved row keeps under it for a beat after it lands.
  static holdSlab(el, ms) {
    el.classList.add('is-just-moved');
    setTimeout(() => el.classList.remove('is-just-moved'), ms);
  }

  /**
   * A settled row the filter now hides. The rebuild has already dropped it, so
   * the old element - still in hand from the measure - goes back up in a frame
   * over the list and leaves the way a moved row travels: lifted onto its
   * slab, then away to the right. The frame is clipped to the row's own
   * scroller, so in a kanban it never draws over a column header, and it is
   * the frame that fades, because .is-completed pins the row's own opacity.
   */
  exitRow({ el, rect, clip }, reduced) {
    const host = document.getElementById('sidebarBody');
    if (!host || !clip) return;
    const origin = host.getBoundingClientRect();

    const frame = document.createElement('div');
    frame.className = 'task-exit-frame';
    Object.assign(frame.style, {
      left: `${clip.left - origin.left - host.clientLeft}px`,
      top: `${clip.top - origin.top - host.clientTop}px`,
      width: `${clip.width}px`,
      height: `${clip.height}px`
    });

    el.classList.remove('is-checking', 'is-unchecking', 'is-just-moved', 'is-drag-source');
    el.querySelector('.task-check-burst')?.remove();
    Object.assign(el.style, {
      left: `${rect.left - clip.left}px`,
      top: `${rect.top - clip.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`
    });
    frame.appendChild(el);
    host.appendChild(frame);

    const duration = reduced ? 200 : TasksSidebar.EXIT_MS;
    const fade = frame.animate(reduced
      ? [{ opacity: 1 }, { opacity: 0 }]
      : [{ opacity: 1 }, { opacity: 1, offset: 0.5 }, { opacity: 0 }],
    { duration, easing: 'ease-in', fill: 'forwards' });
    // Finished or cancelled, the frame goes - and on the clock as well, because
    // a hidden tab never starts the animation at all, and a frame left waiting
    // for it would play a stale exit the moment the person came back.
    const remove = () => frame.remove();
    fade.finished.then(remove, remove);
    setTimeout(remove, duration + 250);

    if (!reduced) {
      // Read off the row, so the slab is the one the stylesheet draws.
      const styles = getComputedStyle(el);
      const depth = parseFloat(styles.getPropertyValue('--slab-float')) || 6;
      const ink = styles.getPropertyValue('--on-color-border').trim();
      const lifted = `${depth}px ${depth}px 0 ${ink}`;
      const rise = depth / 2;
      // All the way past the scroller's edge, slab included, where the frame
      // clips it: out of the rows' way before any of them moves into its place.
      const away = clip.right - rect.left + depth;
      el.animate([
        { transform: 'none', boxShadow: `0 0 0 ${ink}`, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)' },
        { transform: `translate(${-rise}px, ${-rise}px)`, boxShadow: lifted, offset: 0.25,
          easing: 'cubic-bezier(0.5, 0, 0.75, 0)' },
        { transform: `translate(${away}px, ${-rise}px)`, boxShadow: lifted }
      ], { duration, fill: 'forwards' });
    }
  }
}
