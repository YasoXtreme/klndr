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

      this.canvasRenderer = new TimelineCanvas(canvasEl, scrollContainer, sharedState);
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

      await this.loadTasks();

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
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Shift') {
        this.dragController.setModifiers(true, e.ctrlKey || e.metaKey);
      }
      if (e.key === 'Control' || e.key === 'Meta') {
        this.dragController.setModifiers(e.shiftKey, true);
      }
      if (e.key === 'Escape') {
        this.closeAllModals();
      }
    });

    window.addEventListener('keyup', (e) => {
      if (e.key === 'Shift') {
        this.dragController.setModifiers(false, e.ctrlKey || e.metaKey);
      }
      if (e.key === 'Control' || e.key === 'Meta') {
        this.dragController.setModifiers(e.shiftKey, false);
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

        setTimeout(() => this.canvasRenderer.resize(), 240);
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

    setTimeout(() => this.canvasRenderer.resize(), 240);
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
    const panelSettings = document.getElementById('tabPanelSettings');
    const panelAdmin = document.getElementById('tabPanelAdmin');

    if (tabBtnSettings && tabBtnAdmin) {
      tabBtnSettings.addEventListener('click', () => {
        tabBtnSettings.classList.add('active');
        tabBtnAdmin.classList.remove('active');
        panelSettings.style.display = 'block';
        panelAdmin.style.display = 'none';
      });

      tabBtnAdmin.addEventListener('click', async () => {
        tabBtnAdmin.classList.add('active');
        tabBtnSettings.classList.remove('active');
        panelAdmin.style.display = 'block';
        panelSettings.style.display = 'none';
        await this.loadAdminUsersList();
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
        this.canvasRenderer.resize();
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
    const modal = document.getElementById('accountModal');
    if (modal) {
      document.getElementById('displayCurrentUsername').textContent = this.user.username;
      document.getElementById('displayCurrentRole').textContent = this.user.role;
      modal.classList.add('active');
    }
  }

  openSettingsModal() {
    this.closeAllModals();
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

  closeAllModals() {
    document.querySelectorAll('.modal-container, .context-menu').forEach(m => m.classList.remove('active'));
    this.selectedTask = null;
  }

  renderAll() {
    if (this.canvasRenderer) this.canvasRenderer.render();
    if (this.domRenderer) this.domRenderer.render();
    if (this.sidebarController) this.sidebarController.render();
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.klndr = new KlndrApp();
  window.klndr.init();
});
