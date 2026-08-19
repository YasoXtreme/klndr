// Klndr Tasks Sidebar Controller
// Handles single-column and multi-column category views, 5-second completed task grace period,
// filter tabs (default: Uncompleted & Unscheduled), inline task creation with dynamic background color.

class TasksSidebar {
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

    this.newTaskState = {
      icon: 'task_alt',
      color: '#3ba4f6',
      category: 'General'
    };

    // 20 Curated Google Icons
    this.availableIcons = [
      'square_foot', 'balance', 'science', 'bolt', 'menu_book',
      'code', 'psychology', 'fitness_center', 'calculate', 'draw',
      'palette', 'music_note', 'laptop_mac', 'history_edu', 'biotech',
      'functions', 'auto_stories', 'school', 'edit_note', 'task_alt'
    ];

    // 20 Curated Palette Colors
    this.availableColors = [
      '#3ba4f6', '#9ae659', '#d985f5', '#d1d5db', '#fb923c',
      '#fde047', '#38bdf8', '#4ade80', '#e879f9', '#f472b6',
      '#a78bfa', '#fb7185', '#facc15', '#67e8f9', '#86efac',
      '#fbcfe8', '#fed7aa', '#e2e8f0', '#a5f3fc', '#c7d2fe'
    ];

    // Categories including new ones requested
    this.availableCategories = [
      'Mathematics', 'Arabic', 'French', 'German', 'Biology',
      'Geology', 'Mechanics', 'Physics', 'Chemistry', 'Break', 'General'
    ];

    this.initControls();
  }

  setFullView(isFull) {
    this.isFullView = isFull;
    this.container.classList.toggle('is-full-view', isFull);
    this.render();
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

    // Filter pills
    const filterPills = document.querySelectorAll('.category-filter-pill');
    filterPills.forEach(pill => {
      pill.addEventListener('click', () => {
        filterPills.forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        this.activeCategoryFilter = pill.dataset.category || 'UNCOMPLETED_UNSCHEDULED';
        this.render();
      });
    });

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
      createBox.style.backgroundColor = this.newTaskState.color;
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
        item.style.backgroundColor = colorHex;
        item.title = colorHex;
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          this.newTaskState.color = colorHex;
          if (createBox) createBox.style.backgroundColor = colorHex;
          closeAllPopups();
        });
        colorPopup.appendChild(item);
      });
    }

    // Populate Category Popup
    if (categoryPopup) {
      categoryPopup.innerHTML = '';
      this.availableCategories.forEach(cat => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'picker-item-category';
        item.textContent = cat;
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          this.newTaskState.category = cat;
          categoryBtn.title = `Category: ${cat}`;
          closeAllPopups();
        });
        categoryPopup.appendChild(item);
      });
    }

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
        categoryPopup.style.display = isOpen ? 'none' : 'flex';
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
            category: this.newTaskState.category || 'General',
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

  // Handle task completion with 5-second grace period animation
  handleTaskCompletionToggle(task) {
    const taskId = task.id;
    const isNowCompleted = !task.completed;
    task.completed = isNowCompleted;

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
    card.dataset.taskId = task.id;
    card.style.backgroundColor = task.color || '#3ba4f6';

    // Circular Category Badge
    const badge = document.createElement('div');
    badge.className = 'task-badge-circle';
    badge.innerHTML = `<span class="material-symbols-outlined task-icon-symbol">${task.icon || 'task_alt'}</span>`;
    card.appendChild(badge);

    // Checkbox
    const checkbox = document.createElement('button');
    checkbox.type = 'button';
    checkbox.className = `task-checkbox ${task.completed ? 'checked' : ''}`;
    checkbox.title = task.completed ? 'Mark uncompleted' : 'Mark completed';
    checkbox.innerHTML = task.completed ? `
      <span class="material-symbols-outlined" style="font-size: 16px; color: #000; font-weight: 800;">check</span>
    ` : '';
    checkbox.addEventListener('click', (e) => {
      e.stopPropagation();
      this.handleTaskCompletionToggle(task);
    });
    card.appendChild(checkbox);

    // Content Body
    const content = document.createElement('div');
    content.className = 'task-content-inner';

    const titleEl = document.createElement('div');
    titleEl.className = 'task-title-text';
    titleEl.textContent = task.title;
    content.appendChild(titleEl);

    const metaEl = document.createElement('div');
    metaEl.className = 'task-meta-text';
    const dur = task.default_timing || task.total_duration || 120;
    metaEl.textContent = `${dur} min${isScheduled ? ' • Scheduled' : ' • Drag to schedule'}`;
    content.appendChild(metaEl);

    card.appendChild(content);

    // Drag initiation handler
    card.addEventListener('mousedown', (e) => {
      if (e.target.closest('.task-checkbox')) return;
      e.preventDefault();
      this.onDragStart(task, e.clientX, e.clientY);
    });

    // Double click & Context Menu
    card.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      this.onTaskInteraction('openEditModal', { task });
    });

    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.onTaskInteraction('openContextMenu', { task, clientX: e.clientX, clientY: e.clientY });
    });

    return card;
  }

  render() {
    const listEl = document.getElementById('sidebarTasksList');
    const multicolumnEl = document.getElementById('tasksMulticolumnContainer');
    if (!listEl) return;

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
    if (this.isFullView) {
      listEl.style.display = 'none';
      if (!multicolumnEl) return;
      multicolumnEl.style.display = 'flex';
      multicolumnEl.innerHTML = '';

      // Determine active categories to render columns for
      const categoriesToRender = this.availableCategories;

      categoriesToRender.forEach(cat => {
        const catTasks = sortedTasks.filter(t => (t.category || 'General') === cat);

        const col = document.createElement('div');
        col.className = 'task-category-column';

        const header = document.createElement('div');
        header.className = 'category-column-header';
        header.innerHTML = `
          <span>${cat}</span>
          <span class="category-column-count">${catTasks.length}</span>
        `;
        col.appendChild(header);

        const body = document.createElement('div');
        body.className = 'category-column-body';
        body.dataset.category = cat;

        if (catTasks.length === 0) {
          const empty = document.createElement('div');
          empty.style.fontSize = '12px';
          empty.style.color = '#9ca3af';
          empty.style.textAlign = 'center';
          empty.style.padding = '20px 0';
          empty.textContent = 'No tasks in this category';
          body.appendChild(empty);
        } else {
          catTasks.forEach(task => {
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
  }
}
