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
        async (updatesList) => {
          await this.commitTaskUpdates(updatesList);
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

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.closeAllModals();
        return;
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

    const [draggedTask] = this.tasks.splice(draggedIdx, 1);

    if (targetCategory && targetCategory !== draggedTask.category) {
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

    this.renderAll();
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
        if (!this.selectedTask) return;
        const newTitle = titleInput.value.trim() || this.selectedTask.title;

        const updated = await API.updateTask(this.selectedTask.id, {
          title: newTitle,
          icon: this.previewTaskState.icon,
          color: this.previewTaskState.color,
          category: this.previewTaskState.category
        });

        const idx = this.tasks.findIndex(t => t.id === updated.id);
        if (idx !== -1) {
          this.tasks[idx] = updated;
        }

        this.closeAllModals();
        this.renderAll();
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

        const newSettings = await API.updateSettings({
          bucketHours,
          snapToRuler,
          tickPercent
        });

        this.settings = { ...this.settings, ...newSettings };
        this.closeAllModals();
        // Bucket size and tick density are draw-time only; geometry is unchanged.
        this.renderAll();
      });
    }
  }

  async loadTasks() {
    const startDate = this.days[0].startTimestamp;
    const endDate = this.days[6].endTimestamp;
    this.tasks = await API.getTasks(startDate, endDate);
    this.renderAll();
  }

  async commitTaskUpdates(updatesList) {
    const updated = await API.batchUpdateTasks(updatesList);
    updated.forEach(u => {
      const idx = this.tasks.findIndex(t => t.id === u.id);
      if (idx !== -1) {
        this.tasks[idx] = u;
      } else {
        this.tasks.push(u);
      }
    });
    this.renderAll();
  }

  async handleTaskInteraction(action, payload) {
    switch (action) {
      case 'toggleComplete': {
        const { taskId, completed } = payload;
        const task = this.tasks.find(t => t.id === taskId);
        if (task) {
          task.completed = completed;
          await API.updateTask(taskId, { completed });
          this.renderAll();
        }
        break;
      }

      case 'createInlineTask': {
        const newTask = await API.createTask(payload);
        this.tasks.push(newTask);
        this.renderAll();
        break;
      }

      case 'openEditModal': {
        this.openBlockPreviewModal(payload.task);
        break;
      }

      case 'openContextMenu': {
        this.openContextMenu(payload.task, payload.clientX, payload.clientY);
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

  openContextMenu(task, clientX, clientY) {
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

    const editOpt = document.getElementById('ctxEdit');
    const lockOpt = document.getElementById('ctxToggleLock');
    const unscheduleOpt = document.getElementById('ctxUnschedule');
    const deleteOpt = document.getElementById('ctxDelete');

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
        const updated = await API.updateTask(task.id, { is_locked: !isLocked });
        const idx = this.tasks.findIndex(t => t.id === updated.id);
        if (idx !== -1) this.tasks[idx] = updated;
        this.renderAll();
      };
    }

    if (unscheduleOpt) {
      unscheduleOpt.onclick = async () => {
        this.closeAllModals();
        const updated = await API.updateTask(task.id, { start_times: [], durations: [] });
        const idx = this.tasks.findIndex(t => t.id === updated.id);
        if (idx !== -1) this.tasks[idx] = updated;
        this.renderAll();
      };
    }

    if (deleteOpt) {
      deleteOpt.onclick = async () => {
        this.closeAllModals();
        if (confirm(`Delete "${task.title}"?`)) {
          await API.deleteTask(task.id);
          this.tasks = this.tasks.filter(t => t.id !== task.id);
          this.renderAll();
        }
      };
    }

    const closeContext = () => {
      menu.classList.remove('active');
      window.removeEventListener('click', closeContext);
    };
    setTimeout(() => window.addEventListener('click', closeContext), 10);
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
