// Klndr Real-Time Drag & Drop, Resizing, and Physics Controller

class DragController {
  constructor(canvasRenderer, domRenderer, state, onCommitChanges, onReorderTasks) {
    this.canvas = canvasRenderer;
    this.dom = domRenderer;
    this.state = state;
    this.onCommitChanges = onCommitChanges;
    this.onReorderTasks = onReorderTasks;

    this.activeDrag = null;
    this.isShiftPressed = false;
    this.isCtrlPressed = false;

    this.globalGhostEl = null;

    this.initListeners();
  }

  setModifiers(shift, ctrl) {
    if (!this.isCalendarActiveAndFocused()) {
      if (this.isShiftPressed || this.isCtrlPressed) {
        this.isShiftPressed = false;
        this.isCtrlPressed = false;
        this.canvas.setShiftMode(false);
      }
      return;
    }

    const activeEl = document.activeElement;
    if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'SELECT' || activeEl.isContentEditable)) {
      if (this.isShiftPressed || this.isCtrlPressed) {
        this.isShiftPressed = false;
        this.isCtrlPressed = false;
        this.canvas.setShiftMode(false);
      }
      return;
    }

    const newShift = Boolean(shift);
    const newCtrl = Boolean(ctrl);

    if (this.isShiftPressed !== newShift || this.isCtrlPressed !== newCtrl) {
      this.isShiftPressed = newShift;
      this.isCtrlPressed = newCtrl;
      this.canvas.setShiftMode(this.isShiftPressed);
    }
  }

  isModalOrOverlayActive() {
    return Boolean(document.querySelector('.modal-container.active, .context-menu.active'));
  }

  isCalendarActiveAndFocused() {
    if (this.isModalOrOverlayActive()) return false;
    const calPane = document.getElementById('calendarPane');
    if (calPane && calPane.classList.contains('is-collapsed')) return false;
    return true;
  }

  initListeners() {
    const timelineContainer = document.getElementById('timeline-workspace');
    if (!timelineContainer) return;

    // Hover playhead on timeline workspace: only when focused and not in modal
    timelineContainer.addEventListener('mousemove', (e) => {
      if (this.activeDrag) return;
      if (!this.isCalendarActiveAndFocused()) {
        this.canvas.setPlayhead(null);
        this.canvas.setSnapGuide(null);
        return;
      }
      const canvasRect = this.canvas.canvas.getBoundingClientRect();
      const relX = e.clientX - canvasRect.left;
      if (relX >= this.canvas.dayHeaderWidth) {
        this.canvas.setPlayhead(relX);
      } else {
        this.canvas.setPlayhead(null);
      }
    });

    timelineContainer.addEventListener('mouseleave', () => {
      if (!this.activeDrag) {
        this.canvas.setPlayhead(null);
        this.canvas.setSnapGuide(null);
      }
    });

    timelineContainer.addEventListener('mousedown', (e) => this.handleMouseDown(e));

    // Window listeners for active drag operations
    window.addEventListener('mousemove', (e) => this.handleMouseMove(e));
    window.addEventListener('mouseup', (e) => this.handleMouseUp(e));
  }

  handleMouseDown(e) {
    if (e.button !== 0) return;
    if (this.isModalOrOverlayActive()) return;

    const handleEl = e.target.closest('.resize-handle');
    const taskCard = e.target.closest('.timeline-task-card');

    if (handleEl && taskCard) {
      e.preventDefault();
      e.stopPropagation();
      const taskId = taskCard.dataset.taskId;
      const segmentIndex = parseInt(taskCard.dataset.segmentIndex || '0', 10);
      const handleType = handleEl.dataset.handle;
      const task = this.state.tasks.find(t => t.id === taskId);
      if (!task) return;

      const startTime = task.start_times[segmentIndex];
      const duration = task.durations[segmentIndex] || 60;

      this.activeDrag = {
        type: handleType === 'left' ? 'resize-left' : 'resize-right',
        taskId,
        segmentIndex,
        taskRef: task,
        domElement: taskCard,
        initialClientX: e.clientX,
        initialStartTime: startTime,
        initialDuration: duration,
        currentStartTime: startTime,
        currentDuration: duration
      };
      return;
    }

    if (taskCard && !e.target.closest('.task-checkbox')) {
      e.preventDefault();
      e.stopPropagation();
      const taskId = taskCard.dataset.taskId;
      const segmentIndex = parseInt(taskCard.dataset.segmentIndex || '0', 10);
      const task = this.state.tasks.find(t => t.id === taskId);
      if (!task) return;

      const startTime = task.start_times[segmentIndex];
      const duration = task.durations[segmentIndex] || 60;
      const rect = taskCard.getBoundingClientRect();

      const d = new Date(startTime * 1000);
      const dayIndex = this.state.days.findIndex(day => 
        day.date.getFullYear() === d.getFullYear() &&
        day.date.getMonth() === d.getMonth() &&
        day.date.getDate() === d.getDate()
      );

      this.activeDrag = {
        type: 'move',
        taskId,
        segmentIndex,
        taskRef: task,
        domElement: taskCard,
        initialClientX: e.clientX,
        initialClientY: e.clientY,
        offsetX: e.clientX - rect.left,
        offsetY: e.clientY - rect.top,
        initialStartTime: startTime,
        initialDuration: duration,
        currentStartTime: startTime,
        currentDuration: duration,
        currentDayIndex: dayIndex !== -1 ? dayIndex : 0
      };
      taskCard.classList.add('is-dragging');
    }
  }

  // Sidebar drag initiation
  startSidebarTaskDrag(task, clientX, clientY) {
    if (this.isModalOrOverlayActive()) return;

    const duration = task.default_timing || task.total_duration || 120;

    // Create global floating ghost attached to body following cursor anywhere
    const ghost = document.createElement('div');
    ghost.className = 'global-drag-ghost';
    ghost.style.backgroundColor = task.color || '#3ba4f6';
    ghost.style.left = `${clientX}px`;
    ghost.style.top = `${clientY}px`;
    ghost.style.width = '180px';
    ghost.style.height = '48px';
    ghost.innerHTML = `
      <div class="task-badge-circle">
        <span class="material-symbols-outlined task-icon-symbol">${task.icon || 'task_alt'}</span>
      </div>
      <div class="task-content-inner">
        <div class="task-title-text" style="font-size:13px;">${task.title}</div>
        <div class="task-meta-text">${duration} min</div>
      </div>
    `;
    document.body.appendChild(ghost);
    this.globalGhostEl = ghost;

    this.activeDrag = {
      type: 'sidebar-drop',
      taskId: task.id,
      taskRef: task,
      initialDuration: duration,
      currentDuration: duration,
      initialClientX: clientX,
      initialClientY: clientY,
      currentStartTime: null,
      currentDayIndex: 0,
      isOverCalendar: false,
      hoveredSidebarTask: null
    };
  }

  handleMouseMove(e) {
    // If no drag is active, do not execute work on global mousemove
    if (!this.activeDrag) {
      return;
    }

    if (this.isModalOrOverlayActive()) {
      return;
    }

    const timelineWorkspace = document.getElementById('timeline-workspace');
    const canvasRect = this.canvas.canvas.getBoundingClientRect();
    const workspaceRect = timelineWorkspace ? timelineWorkspace.getBoundingClientRect() : canvasRect;

    const isInsideCalendar = (
      e.clientX >= workspaceRect.left &&
      e.clientX <= workspaceRect.right &&
      e.clientY >= workspaceRect.top &&
      e.clientY <= workspaceRect.bottom
    );

    const drag = this.activeDrag;

    // 2. Global Ghost following mouse anywhere
    if (this.globalGhostEl) {
      this.globalGhostEl.style.left = `${e.clientX}px`;
      this.globalGhostEl.style.top = `${e.clientY}px`;
    }

    const bucketHours = this.state.bucketHours || 2;
    const bucketMinutes = bucketHours * 60;
    const tickPercent = this.state.tickPercent || 25;
    const tickMinutes = bucketMinutes * (tickPercent / 100);
    const minutesPerPixel = 1440 / this.canvas.totalTimelineWidth;

    // ==========================================
    // A. SIDEBAR DRAG OPERATION
    // ==========================================
    if (drag.type === 'sidebar-drop') {
      drag.isOverCalendar = isInsideCalendar;

      if (isInsideCalendar) {
        // Hide global ghost and show snapping on canvas
        if (this.globalGhostEl) this.globalGhostEl.style.opacity = '0.4';

        const relX = e.clientX - canvasRect.left;
        const relY = e.clientY - canvasRect.top;

        let targetDayIndex = Math.floor((relY - this.canvas.headerHeight) / this.canvas.rowHeight);
        targetDayIndex = Math.max(0, Math.min(this.state.days.length - 1, targetDayIndex));
        const targetDay = this.state.days[targetDayIndex];

        let minutesFromStart = this.canvas.xToMinutes(relX);

        if (this.isShiftPressed) {
          minutesFromStart = Math.round(minutesFromStart / bucketMinutes) * bucketMinutes;
        } else if (this.state.snapToRuler) {
          minutesFromStart = Math.round(minutesFromStart / tickMinutes) * tickMinutes;
        }

        const clampedMinutes = Math.max(0, Math.min(1440 - drag.currentDuration, minutesFromStart));
        const targetStartTimestamp = targetDay.startTimestamp + (clampedMinutes * 60);

        drag.currentStartTime = targetStartTimestamp;
        drag.currentDayIndex = targetDayIndex;

        const x1 = this.canvas.timeToX(clampedMinutes);
        this.canvas.setSnapGuide(this.isShiftPressed ? x1 : null);
        this.canvas.setPlayhead(x1);
      } else {
        // Over Sidebar list: show full ghost
        if (this.globalGhostEl) this.globalGhostEl.style.opacity = '0.9';
        this.canvas.setPlayhead(null);
        this.canvas.setSnapGuide(null);

        // Detect hovered task or category column for reordering
        const hoveredCard = document.elementFromPoint(e.clientX, e.clientY)?.closest('.sidebar-task-card');
        const hoveredCol = document.elementFromPoint(e.clientX, e.clientY)?.closest('.category-column-body');
        
        drag.hoveredSidebarTask = hoveredCard ? hoveredCard.dataset.taskId : null;
        drag.hoveredCategory = hoveredCol ? hoveredCol.dataset.category : null;
      }
    }

    // ==========================================
    // B. TIMELINE MOVE OPERATION
    // ==========================================
    else if (drag.type === 'move') {
      const relX = e.clientX - canvasRect.left;
      const relY = e.clientY - canvasRect.top;

      let targetDayIndex = Math.floor((relY - this.canvas.headerHeight) / this.canvas.rowHeight);
      targetDayIndex = Math.max(0, Math.min(this.state.days.length - 1, targetDayIndex));
      const targetDay = this.state.days[targetDayIndex];

      const taskLeftX = relX - (drag.offsetX || 0);
      let minutesFromStart = this.canvas.xToMinutes(taskLeftX);

      if (this.isShiftPressed) {
        minutesFromStart = Math.round(minutesFromStart / bucketMinutes) * bucketMinutes;
      } else if (this.state.snapToRuler) {
        minutesFromStart = Math.round(minutesFromStart / tickMinutes) * tickMinutes;
      }

      const clampedMinutes = Math.max(0, Math.min(1440 - drag.currentDuration, minutesFromStart));
      const targetStartTimestamp = targetDay.startTimestamp + (clampedMinutes * 60);

      drag.currentStartTime = targetStartTimestamp;
      drag.currentDayIndex = targetDayIndex;

      const x1 = this.canvas.timeToX(clampedMinutes);
      const x2 = this.canvas.timeToX(clampedMinutes + drag.currentDuration);
      const top = this.canvas.headerHeight + (targetDayIndex * this.canvas.rowHeight) + 6;

      if (drag.domElement) {
        drag.domElement.style.left = `${x1}px`;
        drag.domElement.style.top = `${top}px`;
        drag.domElement.style.width = `${Math.max(16, x2 - x1)}px`;

        const metaEl = drag.domElement.querySelector('.task-meta-text');
        if (metaEl) {
          metaEl.textContent = `${this.canvas.formatTimeLabel(clampedMinutes)} - ${this.canvas.formatTimeLabel(clampedMinutes + drag.currentDuration)} (${drag.currentDuration}m)`;
        }
      }

      this.canvas.setSnapGuide(this.isShiftPressed ? x1 : null);
      this.canvas.setPlayhead(x1);
    }

    // ==========================================
    // C. TIMELINE RESIZE RIGHT (Duration)
    // ==========================================
    else if (drag.type === 'resize-right') {
      const deltaPx = e.clientX - drag.initialClientX;
      let deltaMins = Math.round(deltaPx * minutesPerPixel);
      let newDur = Math.max(PhysicsEngine.MIN_TASK_DURATION_MINUTES, drag.initialDuration + deltaMins);

      if (this.isShiftPressed) {
        newDur = Math.max(bucketMinutes, Math.round(newDur / bucketMinutes) * bucketMinutes);
      } else if (this.state.snapToRuler) {
        newDur = Math.max(tickMinutes, Math.round(newDur / tickMinutes) * tickMinutes);
      }

      drag.currentDuration = newDur;

      if (drag.domElement) {
        const targetDay = this.state.days[drag.currentDayIndex || 0];
        const startMins = (drag.initialStartTime - targetDay.startTimestamp) / 60;
        const x1 = this.canvas.timeToX(startMins);
        const x2 = this.canvas.timeToX(startMins + newDur);
        drag.domElement.style.width = `${Math.max(16, x2 - x1)}px`;

        const metaEl = drag.domElement.querySelector('.task-meta-text');
        if (metaEl) {
          metaEl.textContent = `${this.canvas.formatTimeLabel(startMins)} - ${this.canvas.formatTimeLabel(startMins + newDur)} (${newDur}m)`;
        }
        this.canvas.setPlayhead(x2);
      }
    }

    // ==========================================
    // D. TIMELINE RESIZE LEFT (Start Time & Duration)
    // ==========================================
    else if (drag.type === 'resize-left') {
      const deltaPx = e.clientX - drag.initialClientX;
      let deltaMins = Math.round(deltaPx * minutesPerPixel);
      let newStartTime = drag.initialStartTime + (deltaMins * 60);
      let newDur = drag.initialDuration - deltaMins;

      if (this.isShiftPressed) {
        newStartTime = PhysicsEngine.snapTimestamp(newStartTime, bucketMinutes);
        newDur = Math.max(bucketMinutes, (drag.initialStartTime + drag.initialDuration * 60 - newStartTime) / 60);
      } else if (this.state.snapToRuler) {
        newStartTime = PhysicsEngine.snapTimestamp(newStartTime, tickMinutes);
        newDur = Math.max(tickMinutes, (drag.initialStartTime + drag.initialDuration * 60 - newStartTime) / 60);
      }

      if (newDur >= PhysicsEngine.MIN_TASK_DURATION_MINUTES) {
        drag.currentStartTime = newStartTime;
        drag.currentDuration = newDur;

        if (drag.domElement) {
          const targetDay = this.state.days[drag.currentDayIndex || 0];
          const startMins = (newStartTime - targetDay.startTimestamp) / 60;
          const x1 = this.canvas.timeToX(startMins);
          const x2 = this.canvas.timeToX(startMins + newDur);
          drag.domElement.style.left = `${x1}px`;
          drag.domElement.style.width = `${Math.max(16, x2 - x1)}px`;

          const metaEl = drag.domElement.querySelector('.task-meta-text');
          if (metaEl) {
            metaEl.textContent = `${this.canvas.formatTimeLabel(startMins)} - ${this.canvas.formatTimeLabel(startMins + newDur)} (${newDur}m)`;
          }
          this.canvas.setPlayhead(x1);
        }
      }
    }
  }

  async handleMouseUp(e) {
    if (!this.activeDrag) return;

    const drag = this.activeDrag;
    this.activeDrag = null;

    if (drag.domElement) {
      drag.domElement.classList.remove('is-dragging');
    }
    if (this.globalGhostEl) {
      this.globalGhostEl.remove();
      this.globalGhostEl = null;
    }

    this.canvas.setPlayhead(null);
    this.canvas.setSnapGuide(null);

    // ==========================================
    // 1. SIDEBAR DROP HANDLING
    // ==========================================
    if (drag.type === 'sidebar-drop') {
      if (drag.isOverCalendar && drag.currentStartTime !== null) {
        // Place onto calendar
        const targetDay = this.state.days[drag.currentDayIndex || 0];
        const dayStart = targetDay.startTimestamp;
        const dayEnd = targetDay.startTimestamp + 86400;
        const idealStartTime = drag.currentStartTime;
        const totalDur = drag.currentDuration || drag.initialDuration;

        if (this.isCtrlPressed) {
          const updatesMap = PhysicsEngine.calculateRipple(
            this.state.tasks, dayStart, dayEnd, drag.taskId, 0, idealStartTime, totalDur
          );
          if (!updatesMap.has(drag.taskId)) {
            updatesMap.set(drag.taskId, {
              id: drag.taskId,
              start_times: [idealStartTime],
              durations: [totalDur],
              total_duration: totalDur
            });
          }
          await this.onCommitChanges(Array.from(updatesMap.values()));
        } else {
          const splitResult = PhysicsEngine.calculateSessionSplit(
            this.state.tasks, dayStart, dayEnd, drag.taskId, idealStartTime, totalDur
          );
          await this.onCommitChanges([{
            id: drag.taskId,
            start_times: splitResult.start_times,
            durations: splitResult.durations,
            total_duration: splitResult.total_duration
          }]);
        }
      } else {
        // Dropped inside Sidebar list -> Reorder tasks
        if (this.onReorderTasks) {
          this.onReorderTasks(drag.taskId, drag.hoveredSidebarTask, drag.hoveredCategory);
        }
      }
      return;
    }

    // ==========================================
    // 2. TIMELINE MOVE HANDLING
    // ==========================================
    const targetDay = this.state.days[drag.currentDayIndex || 0];
    if (!targetDay) {
      this.dom.render();
      return;
    }

    const dayStart = targetDay.startTimestamp;
    const dayEnd = targetDay.startTimestamp + 86400;

    if (drag.type === 'move') {
      if (drag.currentStartTime === null) {
        this.dom.render();
        return;
      }

      const idealStartTime = drag.currentStartTime;
      const totalDur = drag.currentDuration || drag.initialDuration;

      if (this.isCtrlPressed) {
        const updatesMap = PhysicsEngine.calculateRipple(
          this.state.tasks, dayStart, dayEnd, drag.taskId, drag.segmentIndex || 0, idealStartTime, totalDur
        );
        if (!updatesMap.has(drag.taskId)) {
          updatesMap.set(drag.taskId, {
            id: drag.taskId,
            start_times: [idealStartTime],
            durations: [totalDur],
            total_duration: totalDur
          });
        }
        await this.onCommitChanges(Array.from(updatesMap.values()));
      } else {
        const splitResult = PhysicsEngine.calculateSessionSplit(
          this.state.tasks, dayStart, dayEnd, drag.taskId, idealStartTime, totalDur
        );
        await this.onCommitChanges([{
          id: drag.taskId,
          start_times: splitResult.start_times,
          durations: splitResult.durations,
          total_duration: splitResult.total_duration
        }]);
      }
    } else if (drag.type === 'resize-right' || drag.type === 'resize-left') {
      const startTime = drag.currentStartTime || drag.initialStartTime;
      const duration = drag.currentDuration || drag.initialDuration;

      if (this.isCtrlPressed) {
        const updatesMap = PhysicsEngine.calculateRipple(
          this.state.tasks, dayStart, dayEnd, drag.taskId, drag.segmentIndex, startTime, duration
        );
        await this.onCommitChanges(Array.from(updatesMap.values()));
      } else {
        const task = drag.taskRef;
        const newStartTimes = [...task.start_times];
        const newDurations = [...task.durations];
        newStartTimes[drag.segmentIndex] = startTime;
        newDurations[drag.segmentIndex] = duration;

        const totalDur = newDurations.reduce((sum, d) => sum + d, 0);
        await this.onCommitChanges([{
          id: drag.taskId,
          start_times: newStartTimes,
          durations: newDurations,
          total_duration: totalDur
        }]);
      }
    }
  }
}
