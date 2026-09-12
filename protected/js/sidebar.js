// Klndr Tasks Sidebar Controller
// Handles single-column and multi-column category views, 5-second completed task grace period,
// filter tabs (default: Uncompleted & Unscheduled), inline task creation with dynamic background color.

const UNCATEGORIZED = CategoryPicker.UNCATEGORIZED;

class TasksSidebar {
  // A drag has to earn the gesture. Starting one on the bare press built a ghost
  // on every click, and on touch it made the list unscrollable: the first
  // finger-down became a drag and the scroll never happened.
  static MOUSE_DRAG_THRESHOLD_PX = 4;
  static TOUCH_SLOP_PX = 10;
  static LONG_PRESS_MS = 400;

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

    // 5-second grace period timeouts map for completed tasks: taskId -> timeoutId
    this.completedGraceTimeouts = new Map();

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

  setFullView(isFull) {
    this.isFullView = isFull;
    this.container.classList.toggle('is-full-view', isFull);
    this.render();
  }

  /**
   * Filling the workspace and showing a kanban are two different questions, and
   * on a phone they have different answers: the pane should fill the screen,
   * but 280px columns on a 375px screen are a board you can only ever see one
   * column of. The flat list says more at the same width.
   */
  get usesKanban() {
    return this.isFullView && document.body.dataset.layout !== 'phone';
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

  toggleCollapse() {
    this.isCollapsed = !this.isCollapsed;
    this.container.classList.toggle('is-collapsed', this.isCollapsed);

    const collapseBtn = document.getElementById('sidebarCollapseBtn');
    if (collapseBtn) {
      const iconSpan = collapseBtn.querySelector('.material-symbols-outlined');
      if (iconSpan) {
        iconSpan.textContent = this.isCollapsed ? 'chevron_left' : 'chevron_right';
      }
    }

    if (this.onToggleCollapse) {
      this.onToggleCollapse(this.isCollapsed);
    }
  }

  // Handle task completion with 5-second grace period animation.
  // Ticking here drives every block of the task; a part-done task is treated as
  // not done, so this always completes it rather than toggling from 'partial'.
  handleTaskCompletionToggle(task) {
    const taskId = task.id;
    const isNowCompleted = TaskModel.completionState(task) !== 'all';
    TaskModel.setAllSegmentsCompleted(task, isNowCompleted);

    // Immediately update UI visually
    this.render();

    // If marked completed, start 5-second grace timer to move to bottom
    if (isNowCompleted) {
      if (this.completedGraceTimeouts.has(taskId)) {
        clearTimeout(this.completedGraceTimeouts.get(taskId));
      }

      const timeoutId = setTimeout(() => {
        this.completedGraceTimeouts.delete(taskId);
        
        // Move task to the bottom of the state tasks array
        const idx = this.state.tasks.findIndex(t => t.id === taskId);
        if (idx !== -1) {
          const [movedTask] = this.state.tasks.splice(idx, 1);
          this.state.tasks.push(movedTask);
        }

        // Animate re-render
        this.render();
      }, 5000);

      this.completedGraceTimeouts.set(taskId, timeoutId);
    } else {
      // User reverted choice within grace period
      if (this.completedGraceTimeouts.has(taskId)) {
        clearTimeout(this.completedGraceTimeouts.get(taskId));
        this.completedGraceTimeouts.delete(taskId);
      }
    }

    // Sync completion status to backend
    this.onTaskInteraction('toggleComplete', { taskId, completed: isNowCompleted });
  }

  // Filter helper
  filterTasks(tasks) {
    return tasks.filter(task => {
      if (this.searchQuery && !task.title.toLowerCase().includes(this.searchQuery)) {
        return false;
      }
      const isScheduled = task.start_times && task.start_times.length > 0;

      if (this.activeCategoryFilter === 'UNCOMPLETED_UNSCHEDULED') {
        return !task.completed && !isScheduled;
      }
      if (this.activeCategoryFilter === 'UNCOMPLETED') {
        return !task.completed;
      }
      if (this.activeCategoryFilter === 'COMPLETED') {
        return task.completed;
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

    // Circular Category Badge
    const badge = document.createElement('div');
    badge.className = 'task-badge-circle';
    badge.innerHTML = `<span class="material-symbols-outlined task-icon-symbol">${task.icon || 'task_alt'}</span>`;
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
    checkbox.innerHTML = completionState === 'all' ? `
      <span class="material-symbols-outlined" style="font-size: 16px; color: var(--on-color-ink); font-weight: 800;">check</span>
    ` : completionState === 'partial' ? '<span class="task-checkbox-partial"></span>' : '';
    checkbox.addEventListener('click', (e) => {
      e.stopPropagation();
      this.handleTaskCompletionToggle(task);
    });
    card.appendChild(checkbox);

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

    const titleEl = document.createElement('div');
    titleEl.className = 'task-title-text';
    titleEl.textContent = task.title;
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

    // Reordering by drag is gone on a phone: a long press in this list now
    // hands the gesture to the calendar, because that is the only way a task
    // can reach it there. These put the ordering back, and the stylesheet shows
    // them only where that trade was actually made.
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
      card.appendChild(btn);
    };
    nudge(-1, 'keyboard_arrow_up', 'Move up');
    nudge(1, 'keyboard_arrow_down', 'Move down');


    // Drag initiation. Deferred rather than immediate - see the thresholds on
    // the class. No preventDefault: on touch it would kill the scroll we are
    // deliberately leaving to the browser, and .sidebar-task-card is already
    // user-select:none, which was all it bought for the mouse.
    card.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.task-checkbox, .btn-task-nudge')) return;
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
    const listEl = document.getElementById('sidebarTasksList');
    const multicolumnEl = document.getElementById('tasksMulticolumnContainer');
    if (!listEl) return;

    this.renderCategoryFilterPills();

    const allTasks = this.state.tasks || [];
    const filteredTasks = this.filterTasks(allTasks);

    // Sort: Uncompleted tasks on top, completed tasks on bottom
    const sortedTasks = [...filteredTasks].sort((a, b) => {
      if (a.completed === b.completed) return 0;
      return a.completed ? 1 : -1;
    });

    // ==========================================
    // MULTI-COLUMN KANBAN VIEW (When Calendar is Collapsed)
    // ==========================================
    if (this.usesKanban) {
      listEl.style.display = 'none';
      if (!multicolumnEl) return;
      multicolumnEl.style.display = 'flex';
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
          swatch.innerHTML = `<span class="material-symbols-outlined">${category.icon}</span>`;
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
    if (multicolumnEl) multicolumnEl.style.display = 'none';
    listEl.style.display = 'flex';
    listEl.innerHTML = '';

    if (sortedTasks.length === 0) {
      const emptyNotice = document.createElement('div');
      emptyNotice.className = 'sidebar-empty-state';
      emptyNotice.innerHTML = `
        <p>No tasks found</p>
        <span>Type in "Write your task here" below to create a task</span>
      `;
      listEl.appendChild(emptyNotice);
      return;
    }

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
}
