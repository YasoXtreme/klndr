// Klndr Application Coordinator & Main Controller

class KlndrApp {
  constructor() {
    this.user = null;
    this.tasks = [];
    this.settings = {
      bucketHours: 2,
      snapToRuler: false,
      tickPercent: 25
    };

    this.weekOffset = 0;
    this.MAX_MONTH_WEEKS = 4;
    this.days = [];

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
      const authData = await API.getMe();
      if (!authData || !authData.user) {
        window.location.href = '/login';
        return;
      }
      this.user = authData.user;
      this.updateUserUI();

      try {
        const userSettings = await API.getSettings();
        if (userSettings) {
          this.settings = { ...this.settings, ...userSettings };
        }
      } catch (e) {
        console.warn('Using default settings', e);
      }

      this.computeWeekDays();

      const canvasEl = document.getElementById('timelineCanvas');
      const rulerCanvasEl = document.getElementById('timelineRulerCanvas');
      const gutterCanvasEl = document.getElementById('timelineGutterCanvas');
      const scrollContainer = document.getElementById('timeline-workspace');
      const domContainer = document.getElementById('timelineDomOverlay');
      const sidebarContainer = document.getElementById('tasks-sidebar-pane');

      const sharedState = {
        get tasks() { return window.klndr.tasks; },
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

      this.sidebarController = new TasksSidebar(
        sidebarContainer,
        sharedState,
        (action, payload) => {
          this.handleTaskInteraction(action, payload);
        },
        (task, clientX, clientY) => {
          this.dragController.startSidebarTaskDrag(task, clientX, clientY);
        },
        (tasksCollapsed) => {
          this.handleTasksPanelCollapse(tasksCollapsed);
        }
      );

      // Alt-click on a block cuts it where the pointer is, skipping the menu.
      this.dragController.onSplitSegment = (task, segmentId, timestamp) => {
        this.splitSegmentAt(task, segmentId, timestamp);
      };

      this.initKeyboardListeners();
      this.initUIEventListeners();
      this.initAccountModal();
      this.initFloatingBlockEditor();
      this.initSettingsModal();
      this.initCalendarCollapse();
      this.initAnnouncementsTab();

      await this.loadTasks();
      await this.initMissedAnnouncementsCarousel();

    } catch (err) {
      console.error('Failed to initialize Klndr:', err);
    }
  }

  updateUserUI() {
    const usernameEl = document.getElementById('topbarUsername');
    if (usernameEl && this.user) {
      usernameEl.textContent = this.user.username;
    }
    const adminTabBtn = document.getElementById('tabBtnAdmin');
    if (adminTabBtn) {
      adminTabBtn.style.display = this.user.role === 'admin' ? 'block' : 'none';
    }
    const createAnnouncementBtn = document.getElementById('btnCreateAnnouncement');
    if (createAnnouncementBtn) {
      createAnnouncementBtn.style.display = this.user.role === 'admin' ? 'flex' : 'none';
    }
  }

  computeWeekDays() {
    const now = new Date();
    const baseDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + (this.weekOffset * 7));

    const currentDayOfWeek = baseDate.getDay();
    const diffToSat = (currentDayOfWeek + 1) % 7;
    const satDate = new Date(baseDate);
    satDate.setDate(baseDate.getDate() - diffToSat);
    satDate.setHours(0, 0, 0, 0);

    const dayNames = ['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
    this.days = [];

    for (let i = 0; i < 7; i++) {
      const d = new Date(satDate);
      d.setDate(satDate.getDate() + i);
      const startTimestamp = Math.floor(d.getTime() / 1000);
      const endTimestamp = startTimestamp + 86400;

      this.days.push({
        name: dayNames[i],
        date: d,
        startTimestamp,
        endTimestamp,
        isToday: d.toDateString() === now.toDateString()
      });
    }

    this.updateDateRangeUI();
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
    const dateLabelEl = document.getElementById('calendarDateRangeLabel');
    if (!dateLabelEl || this.days.length === 0) return;

    const first = this.days[0].date;
    const last = this.days[6].date;
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    
    const rangeText = `${months[first.getMonth()]} ${first.getDate()} – ${months[last.getMonth()]} ${last.getDate()}, ${last.getFullYear()}`;
    dateLabelEl.textContent = rangeText;

    const prevBtn = document.getElementById('btnPrevWeek');
    const nextBtn = document.getElementById('btnNextWeek');
    if (prevBtn) prevBtn.disabled = this.weekOffset <= -this.MAX_MONTH_WEEKS;
    if (nextBtn) nextBtn.disabled = this.weekOffset >= this.MAX_MONTH_WEEKS;
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
    const calPane = document.getElementById('calendarPane');

    if (calCollapseBtn && calPane) {
      calCollapseBtn.addEventListener('click', () => {
        // If tasks was collapsed, uncollapse tasks first
        if (this.isTasksCollapsed) {
          this.isTasksCollapsed = false;
          this.sidebarController.isCollapsed = false;
          document.getElementById('tasks-sidebar-pane').classList.remove('is-collapsed');
          const tasksCollapseIcon = document.getElementById('sidebarCollapseBtn')?.querySelector('.material-symbols-outlined');
          if (tasksCollapseIcon) tasksCollapseIcon.textContent = 'chevron_right';
        }

        this.isCalendarCollapsed = !this.isCalendarCollapsed;
        calPane.classList.toggle('is-collapsed', this.isCalendarCollapsed);

        const iconSpan = calCollapseBtn.querySelector('.material-symbols-outlined');
        if (iconSpan) {
          iconSpan.textContent = this.isCalendarCollapsed ? 'chevron_right' : 'chevron_left';
        }

        // Toggle multi-column full view on task panel
        this.sidebarController.setFullView(this.isCalendarCollapsed);
        // The canvas relayout is driven by the ResizeObserver, so it lands when
        // the pane transition actually settles rather than on a guessed timer.
      });
    }
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

    if (targetCategory && targetCategory !== draggedTask.category) {
      changes.push({
        kind: 'update', via: 'patch', id: draggedTask.id,
        before: { category: draggedTask.category },
        after: { category: targetCategory }
      });
      draggedTask.category = targetCategory;
      API.updateTask(draggedTask.id, { category: targetCategory });
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

    if (prevBtn) {
      prevBtn.addEventListener('click', () => {
        if (this.weekOffset > -this.MAX_MONTH_WEEKS) {
          this.weekOffset--;
          this.computeWeekDays();
          this.renderAll();
        }
      });
    }

    if (nextBtn) {
      nextBtn.addEventListener('click', () => {
        if (this.weekOffset < this.MAX_MONTH_WEEKS) {
          this.weekOffset++;
          this.computeWeekDays();
          this.renderAll();
        }
      });
    }

    if (todayBtn) {
      todayBtn.addEventListener('click', () => {
        this.weekOffset = 0;
        this.computeWeekDays();
        this.renderAll();
      });
    }

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
      el.addEventListener('click', () => this.closeAllModals());
    });
  }

  // ==========================================
  // TABBED ACCOUNT MODAL
  // ==========================================
  initAccountModal() {
    const tabBtnSettings = document.getElementById('tabBtnSettings');
    const tabBtnAdmin = document.getElementById('tabBtnAdmin');
    const tabBtnAnnouncements = document.getElementById('tabBtnAnnouncements');
    const panelSettings = document.getElementById('tabPanelSettings');
    const panelAdmin = document.getElementById('tabPanelAdmin');
    const panelAnnouncements = document.getElementById('tabPanelAnnouncements');

    const allTabBtns = [tabBtnSettings, tabBtnAdmin, tabBtnAnnouncements].filter(Boolean);
    const allPanels = [panelSettings, panelAdmin, panelAnnouncements].filter(Boolean);

    const switchTab = (activeBtn, activePanel) => {
      allTabBtns.forEach(b => b.classList.remove('active'));
      allPanels.forEach(p => p.style.display = 'none');
      activeBtn.classList.add('active');
      activePanel.style.display = 'block';
    };

    if (tabBtnSettings) {
      tabBtnSettings.addEventListener('click', () => switchTab(tabBtnSettings, panelSettings));
    }

    if (tabBtnAdmin) {
      tabBtnAdmin.addEventListener('click', async () => {
        switchTab(tabBtnAdmin, panelAdmin);
        await this.loadAdminUsersList();
      });
    }

    if (tabBtnAnnouncements) {
      tabBtnAnnouncements.addEventListener('click', async () => {
        switchTab(tabBtnAnnouncements, panelAnnouncements);
        await this.loadAnnouncementsList();
      });
    }

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
          <td><span class="role-badge ${u.role}">${u.role}</span></td>
          <td>${new Date(u.created_at * 1000).toLocaleDateString()}</td>
          <td>
            ${u.username !== this.user.username ? `
              <button type="button" class="btn-delete-user" data-username="${u.username}" title="Delete User">
                <span class="material-symbols-outlined" style="font-size: 16px;">delete</span>
              </button>
            ` : '<span style="color:#9ca3af;font-size:12px;">(You)</span>'}
          </td>
        `;
        listContainer.appendChild(tr);
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

    if (iconPopup && this.sidebarController) {
      iconPopup.innerHTML = '';
      this.sidebarController.availableIcons.forEach(iconName => {
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

    if (colorPopup && this.sidebarController) {
      colorPopup.innerHTML = '';
      this.sidebarController.availableColors.forEach(colorHex => {
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

    if (categoryPopup && this.sidebarController) {
      categoryPopup.innerHTML = '';
      this.sidebarController.availableCategories.forEach(cat => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'picker-item-category';
        item.textContent = cat;
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          this.previewTaskState.category = cat;
          categoryBtn.title = `Category: ${cat}`;
          closePopups();
        });
        categoryPopup.appendChild(item);
      });
    }

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
        categoryPopup.style.display = isOpen ? 'none' : 'flex';
      });
    }

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
    const endDate = this.days[6].endTimestamp;
    this.tasks = await API.getTasks(startDate, endDate);
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
      category: payload.category || 'General',
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

      case 'openEditModal': {
        this.openBlockPreviewModal(payload.task);
        break;
      }

      case 'openContextMenu': {
        this.openContextMenu(payload);
        break;
      }
    }
  }

  openBlockPreviewModal(task) {
    this.closeAllModals();
    if (this.canvasRenderer) {
      this.canvasRenderer.setPlayhead(null);
      this.canvasRenderer.setSnapGuide(null);
    }
    this.selectedTask = task;
    this.previewTaskState = {
      icon: task.icon || 'task_alt',
      color: task.color || '#3ba4f6',
      category: task.category || 'General'
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
      categoryBtn.title = `Category: ${this.previewTaskState.category}`;

      const scopeNote = document.getElementById('previewScopeNote');
      if (scopeNote) {
        const blocks = (task.segments || []).length;
        scopeNote.textContent = blocks > 1
          ? `Editing the task — applies to all ${blocks} of its blocks`
          : '';
        scopeNote.style.display = blocks > 1 ? 'block' : 'none';
      }

      modal.classList.add('active');
      titleInput.focus();
    }
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
      this.canvasRenderer.setCutMarker(canSplit ? this.cutMarkerXFor(task, segment, splitTimestamp) : null);
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

    menu.style.left = `${Math.min(window.innerWidth - 200, clientX)}px`;
    menu.style.top = `${Math.min(window.innerHeight - 200, clientY)}px`;
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
      splitOpt.onclick = async () => {
        if (!canSplit) return;
        this.closeAllModals();
        await this.splitSegmentAt(task, segmentId, splitTimestamp);
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
      if (this.canvasRenderer) this.canvasRenderer.setCutMarker(null);
      window.removeEventListener('click', closeContext);
    };
    setTimeout(() => window.addEventListener('click', closeContext), 10);
  }

  // Mirrors the clamping splitSegmentAt applies, so the marker cannot promise a
  // cut in a place the split would refuse.
  cutMarkerXFor(task, segment, rawTimestamp) {
    if (!segment) return null;
    const dayIndex = this.days.findIndex(
      d => segment.start_time >= d.startTimestamp && segment.start_time < d.startTimestamp + 86400
    );
    if (dayIndex === -1) return null;

    const floor = TaskModel.MIN_SEGMENT_MINUTES * 60;
    const end = segment.start_time + segment.duration * 60;

    let cut = rawTimestamp;
    const snap = this.dragController ? this.dragController.snapMinutes() : 0;
    if (snap > 0) cut = PhysicsEngine.snapTimestamp(cut, snap);
    cut = Math.max(segment.start_time + floor, Math.min(end - floor, cut));

    const day = this.days[dayIndex];
    return {
      x: this.canvasRenderer.timeToX((cut - day.startTimestamp) / 60),
      top: this.canvasRenderer.dayIndexToY(dayIndex),
      height: this.canvasRenderer.rowHeight
    };
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
            // Re-open account modal on announcements tab and refresh list
            this.openAccountModal();
            const tabBtnAnnouncements = document.getElementById('tabBtnAnnouncements');
            const tabPanelAnnouncements = document.getElementById('tabPanelAnnouncements');
            if (tabBtnAnnouncements && tabPanelAnnouncements) {
              document.querySelectorAll('.modal-tab-btn').forEach(b => b.classList.remove('active'));
              document.querySelectorAll('.modal-tab-panel').forEach(p => p.style.display = 'none');
              tabBtnAnnouncements.classList.add('active');
              tabPanelAnnouncements.style.display = 'block';
            }
            this.loadAnnouncementsList();
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

  closeAllModals() {
    document.querySelectorAll('.modal-container, .context-menu').forEach(m => m.classList.remove('active'));
    this.selectedTask = null;
    if (this.canvasRenderer) {
      this.canvasRenderer.setPlayhead(null);
      this.canvasRenderer.setSnapGuide(null);
      // Every menu and modal close funnels through here, so the cut marker
      // cannot outlive the menu that placed it.
      this.canvasRenderer.setCutMarker(null);
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
