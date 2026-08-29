// Klndr Real-Time Drag & Drop, Resizing, and Physics Controller
//
// Every drag resolves through one function, resolveDragOutcome(), which is used
// both to preview the drag live and to commit it on release. That is deliberate:
// the ghost blocks the user sees during a drag are produced by exactly the same
// physics call that will run when they let go, so the preview cannot lie.

class DragController {
  static SEAM_MIN_MINUTES = PhysicsEngine.MIN_TASK_DURATION_MINUTES;

  constructor(canvasRenderer, domRenderer, state, onCommitChanges, onReorderTasks) {
    this.canvas = canvasRenderer;
    this.dom = domRenderer;
    this.state = state;
    this.onCommitChanges = onCommitChanges;
    this.onReorderTasks = onReorderTasks;

    this.activeDrag = null;
    this.isShiftPressed = false;
    this.isCtrlPressed = false;
    this.isAltPressed = false;

    this.globalGhostEl = null;
    this.hintChipEl = null;
    this._projectionRaf = null;

    this.dom.isDragActive = () => Boolean(this.activeDrag);
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

  // Mid-drag the mouse event is the authority on modifier state: a keydown that
  // lands while the pointer is captured can otherwise be missed entirely.
  syncModifiersFromEvent(e) {
    const shift = Boolean(e.shiftKey);
    const ctrl = Boolean(e.ctrlKey || e.metaKey);
    const alt = Boolean(e.altKey);
    const changed = shift !== this.isShiftPressed || ctrl !== this.isCtrlPressed || alt !== this.isAltPressed;

    this.isShiftPressed = shift;
    this.isCtrlPressed = ctrl;
    this.isAltPressed = alt;
    if (shift !== this.canvas.isShiftMode) this.canvas.setShiftMode(shift);
    return changed;
  }

  // Keep a block's legibility tier in step with its live width while dragging, so
  // it does not sit in a tier it has outgrown until the next full render.
  applyBlockWidth(element, rawWidth) {
    const width = Math.max(10, rawWidth);
    element.style.width = `${width}px`;
    const next = TimelineDOM.sizeClassForWidth(width);
    ['is-lg', 'is-md', 'is-sm', 'is-xs', 'is-min'].forEach(cls => {
      element.classList.toggle(cls, cls === next);
    });
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

  dayIndexForTimestamp(timestamp) {
    const idx = this.state.days.findIndex(
      day => timestamp >= day.startTimestamp && timestamp < day.startTimestamp + 86400
    );
    return idx === -1 ? 0 : idx;
  }

  snapMinutes() {
    const bucketMinutes = (this.state.bucketHours || 2) * 60;
    if (this.isShiftPressed) return bucketMinutes;
    if (this.state.snapToRuler) return bucketMinutes * ((this.state.tickPercent || 25) / 100);
    return 0;
  }

  initListeners() {
    const timelineContainer = document.getElementById('timeline-workspace');
    if (!timelineContainer) return;

    timelineContainer.addEventListener('mousemove', (e) => {
      if (this.activeDrag) return;
      if (!this.isCalendarActiveAndFocused()) {
        this.canvas.setPlayhead(null);
        this.canvas.setSnapGuide(null);
        return;
      }
      const canvasRect = this.canvas.canvas.getBoundingClientRect();
      const relX = e.clientX - canvasRect.left;
      if (relX >= 0 && relX <= this.canvas.totalTimelineWidth) {
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

    window.addEventListener('mousemove', (e) => this.handleMouseMove(e));
    window.addEventListener('mouseup', (e) => this.handleMouseUp(e));

    // A modifier changes what the drop will DO, so the preview has to change the
    // instant the key goes down — not on the next mouse move. Ctrl switches
    // split/ripple and Shift switches the snap grid, both of which alter the
    // outcome for a pointer that has not moved at all.
    window.addEventListener('keydown', (e) => this.handleDragModifierKey(e));
    window.addEventListener('keyup', (e) => this.handleDragModifierKey(e));
  }

  // Alt is deliberately absent: nothing binds to it any more, and reacting to it
  // would only trigger a pointless recompute (on Windows it also pulls focus to
  // the menu bar mid-drag).
  static MODIFIER_KEYS = ['Control', 'Meta', 'Shift'];

  handleDragModifierKey(e) {
    if (!this.activeDrag) return;
    if (!DragController.MODIFIER_KEYS.includes(e.key)) return;
    if (!this.syncModifiersFromEvent(e)) return;

    // Re-run the drag from the last known pointer position under the new
    // modifier state, so snapping and the projection both catch up together.
    if (this._lastPointer) {
      this.handleMouseMove({
        clientX: this._lastPointer.x,
        clientY: this._lastPointer.y,
        shiftKey: this.isShiftPressed,
        ctrlKey: this.isCtrlPressed,
        metaKey: false,
        altKey: this.isAltPressed
      });
    } else {
      this.scheduleProjection();
    }
  }

  // ==========================================
  // DRAG START
  // ==========================================

  handleMouseDown(e) {
    if (e.button !== 0) return;
    if (this.isModalOrOverlayActive()) return;

    this.syncModifiersFromEvent(e);

    const seamEl = e.target.closest('.timeline-seam-handle');
    if (seamEl) {
      this.startSeamDrag(e, seamEl);
      return;
    }

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
        currentDuration: duration,
        // Without this the resize maths falls back to day 0, which throws the
        // block off the right-hand edge of the grid for any task not on the
        // first day of the week.
        currentDayIndex: this.dayIndexForTimestamp(startTime)
      };
      taskCard.classList.add('is-resizing');
      this.dom.hideTooltip();
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
        currentDayIndex: this.dayIndexForTimestamp(startTime)
      };
      taskCard.classList.add('is-dragging');
      this.dom.hideTooltip();
    }
  }

  startSeamDrag(e, seamEl) {
    e.preventDefault();
    e.stopPropagation();

    const leftTask = this.state.tasks.find(t => t.id === seamEl.dataset.leftTaskId);
    const rightTask = this.state.tasks.find(t => t.id === seamEl.dataset.rightTaskId);
    if (!leftTask || !rightTask) return;

    const leftSeg = parseInt(seamEl.dataset.leftSegmentIndex || '0', 10);
    const rightSeg = parseInt(seamEl.dataset.rightSegmentIndex || '0', 10);

    const leftStart = leftTask.start_times[leftSeg];
    const leftDur = leftTask.durations[leftSeg] || 60;
    const rightStart = rightTask.start_times[rightSeg];
    const rightDur = rightTask.durations[rightSeg] || 60;

    this.activeDrag = {
      type: 'seam',
      taskId: leftTask.id,
      segmentIndex: leftSeg,
      domElement: seamEl,
      initialClientX: e.clientX,
      currentDayIndex: parseInt(seamEl.dataset.dayIndex || '0', 10),
      left: { task: leftTask, segIdx: leftSeg, start: leftStart, duration: leftDur },
      right: { task: rightTask, segIdx: rightSeg, start: rightStart, duration: rightDur },
      initialBoundary: rightStart,
      currentBoundary: rightStart
    };

    seamEl.classList.add('is-active');
    document.body.classList.add('is-seam-dragging');
    this.dom.hideTooltip();
  }

  startSidebarTaskDrag(task, clientX, clientY) {
    if (this.isModalOrOverlayActive()) return;

    const duration = task.default_timing || task.total_duration || 120;

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
      segmentIndex: 0,
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

  // ==========================================
  // OUTCOME RESOLUTION (preview and commit share this)
  // ==========================================

  /**
   * Work out the full set of task updates this drag would commit right now,
   * including every knock-on change the physics engine produces.
   * Returns [] when the drag has nothing to place yet.
   */
  resolveDragOutcome(drag) {
    return this.pruneUnchanged(this.computeDragOutcome(drag));
  }

  // The ripple engine reports every segment it considered, changed or not. Drop
  // the no-ops so the hint counts only real movement and the commit does not
  // write rows that did not move.
  pruneUnchanged(updates) {
    return updates.filter(update => {
      const task = this.state.tasks.find(t => t.id === update.id);
      if (!task) return true;
      if (task.start_times.length !== update.start_times.length) return true;
      if (task.durations.length !== update.durations.length) return true;

      const sameStarts = update.start_times.every((v, i) => Math.abs(v - task.start_times[i]) < 30);
      const sameDurations = update.durations.every((v, i) => Math.abs(v - (task.durations[i] || 0)) < 0.5);
      return !(sameStarts && sameDurations);
    });
  }

  computeDragOutcome(drag) {
    if (!drag) return [];
    if (drag.type === 'seam') return this.resolveSeamOutcome(drag);

    const day = this.state.days[drag.currentDayIndex ?? 0];
    if (!day) return [];

    const startTime = drag.currentStartTime;
    if (startTime === null || startTime === undefined) return [];

    const duration = drag.currentDuration || drag.initialDuration;
    const dayStart = day.startTimestamp;
    const dayEnd = dayStart + 86400;

    if (this.isCtrlPressed) {
      const updatesMap = PhysicsEngine.calculateRipple(
        this.state.tasks, dayStart, dayEnd, drag.taskId, drag.segmentIndex || 0, startTime, duration
      );
      if (!updatesMap.has(drag.taskId)) {
        updatesMap.set(drag.taskId, {
          id: drag.taskId,
          start_times: [startTime],
          durations: [duration],
          total_duration: duration
        });
      }
      return Array.from(updatesMap.values());
    }

    // A resize edits one segment in place; it must not disturb the task's other
    // segments the way a re-placement would.
    if (drag.type === 'resize-left' || drag.type === 'resize-right') {
      const task = drag.taskRef;
      const start_times = [...task.start_times];
      const durations = [...task.durations];
      start_times[drag.segmentIndex] = startTime;
      durations[drag.segmentIndex] = duration;
      return [{
        id: drag.taskId,
        start_times,
        durations,
        total_duration: durations.reduce((sum, d) => sum + d, 0)
      }];
    }

    const split = PhysicsEngine.calculateSessionSplit(
      this.state.tasks, dayStart, dayEnd, drag.taskId, startTime, duration
    );
    return [{
      id: drag.taskId,
      start_times: split.start_times,
      durations: split.durations,
      total_duration: split.total_duration
    }];
  }

  // The seam always moves both blocks: the pair's outer bounds are fixed and
  // only the boundary between them travels. Resizing one block alone is done
  // with that block's own edge handle, which sits just outside the seam zone.
  resolveSeamOutcome(drag) {
    const { left, right } = drag;
    const boundary = drag.currentBoundary;
    const rightEnd = right.start + right.duration * 60;

    const leftDuration = Math.round((boundary - left.start) / 60);
    const rightStart = boundary;
    const rightDuration = Math.round((rightEnd - boundary) / 60);

    // Both sides may belong to the same task, so merge into one update per task.
    const byTask = new Map();
    const apply = (task, segIdx, start, duration) => {
      if (!byTask.has(task.id)) {
        byTask.set(task.id, {
          id: task.id,
          start_times: [...task.start_times],
          durations: [...task.durations],
          total_duration: task.total_duration
        });
      }
      const update = byTask.get(task.id);
      update.start_times[segIdx] = start;
      update.durations[segIdx] = duration;
      update.total_duration = update.durations.reduce((sum, d) => sum + d, 0);
    };

    apply(left.task, left.segIdx, left.start, leftDuration);
    apply(right.task, right.segIdx, rightStart, rightDuration);

    return Array.from(byTask.values());
  }

  // ==========================================
  // LIVE PREVIEW
  // ==========================================

  scheduleProjection() {
    if (this._projectionRaf) return;
    this._projectionRaf = requestAnimationFrame(() => {
      this._projectionRaf = null;
      if (!this.activeDrag) {
        this.dom.clearProjection();
        this.hideHint();
        return;
      }
      const updates = this.resolveDragOutcome(this.activeDrag);
      this.dom.renderProjection(updates, { activeTaskId: this.activeDrag.taskId });
      this.updateHint(this.activeDrag, updates);
    });
  }

  hintTextFor(drag, updates) {
    if (drag.type === 'seam') {
      return 'Moving the shared boundary — both blocks, same total time';
    }

    const others = updates.filter(u => u.id !== drag.taskId).length;
    if (this.isCtrlPressed) {
      return others === 0
        ? 'Ripple — nothing else affected'
        : `Ripple — ${others} other task${others > 1 ? 's' : ''} will shift`;
    }

    const self = updates.find(u => u.id === drag.taskId);
    if (self && self.start_times.length > 1) {
      return `Splits into ${self.start_times.length} sessions around the blocks in the way`;
    }
    if (drag.type === 'move' || drag.type === 'sidebar-drop') {
      return 'Hold Ctrl to push the blocks in the way instead of splitting';
    }
    return null;
  }

  updateHint(drag, updates) {
    const text = this.hintTextFor(drag, updates);
    if (!text) {
      this.hideHint();
      return;
    }

    if (!this.hintChipEl) {
      this.hintChipEl = document.createElement('div');
      this.hintChipEl.className = 'drag-hint-chip';
      document.body.appendChild(this.hintChipEl);
    }

    this.hintChipEl.textContent = text;
    this.hintChipEl.classList.toggle('is-warning', this.isCtrlPressed && updates.length > 1);
    this.hintChipEl.style.display = 'block';

    const x = this._lastPointer ? this._lastPointer.x : 0;
    const y = this._lastPointer ? this._lastPointer.y : 0;
    const width = this.hintChipEl.offsetWidth;
    this.hintChipEl.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, x - width / 2))}px`;
    this.hintChipEl.style.top = `${Math.max(8, y - 46)}px`;
  }

  hideHint() {
    if (this.hintChipEl) this.hintChipEl.style.display = 'none';
  }

  // ==========================================
  // DRAG MOVE
  // ==========================================

  handleMouseMove(e) {
    if (!this.activeDrag) return;
    if (this.isModalOrOverlayActive()) return;

    this._lastPointer = { x: e.clientX, y: e.clientY };
    this.syncModifiersFromEvent(e);

    const drag = this.activeDrag;
    const canvasRect = this.canvas.canvas.getBoundingClientRect();
    const minutesPerPixel = 1440 / this.canvas.totalTimelineWidth;

    if (this.globalGhostEl) {
      this.globalGhostEl.style.left = `${e.clientX}px`;
      this.globalGhostEl.style.top = `${e.clientY}px`;
    }

    switch (drag.type) {
      case 'sidebar-drop':
        this.moveSidebarDrop(e, drag, canvasRect);
        break;
      case 'move':
        this.moveBlock(e, drag, canvasRect);
        break;
      case 'resize-right':
        this.resizeRight(e, drag, minutesPerPixel);
        break;
      case 'resize-left':
        this.resizeLeft(e, drag, minutesPerPixel);
        break;
      case 'seam':
        this.moveSeam(e, drag, minutesPerPixel);
        break;
      default:
        break;
    }

    this.scheduleProjection();
  }

  snapMinutesValue(minutes) {
    const snap = this.snapMinutes();
    return snap > 0 ? Math.round(minutes / snap) * snap : minutes;
  }

  moveSidebarDrop(e, drag, canvasRect) {
    const timelineWorkspace = document.getElementById('timeline-workspace');
    const workspaceRect = timelineWorkspace ? timelineWorkspace.getBoundingClientRect() : canvasRect;

    const isInsideCalendar = (
      e.clientX >= workspaceRect.left && e.clientX <= workspaceRect.right &&
      e.clientY >= workspaceRect.top && e.clientY <= workspaceRect.bottom
    );
    drag.isOverCalendar = isInsideCalendar;

    if (!isInsideCalendar) {
      if (this.globalGhostEl) this.globalGhostEl.style.opacity = '0.9';
      this.canvas.setPlayhead(null);
      this.canvas.setSnapGuide(null);
      drag.currentStartTime = null;

      const hovered = document.elementFromPoint(e.clientX, e.clientY);
      drag.hoveredSidebarTask = hovered?.closest('.sidebar-task-card')?.dataset.taskId || null;
      drag.hoveredCategory = hovered?.closest('.category-column-body')?.dataset.category || null;
      return;
    }

    if (this.globalGhostEl) this.globalGhostEl.style.opacity = '0.4';

    const relX = e.clientX - canvasRect.left;
    const relY = e.clientY - canvasRect.top;
    const targetDayIndex = this.canvas.yToDayIndex(relY);
    const targetDay = this.state.days[targetDayIndex];

    const minutes = this.snapMinutesValue(this.canvas.xToMinutes(relX));
    const clamped = Math.max(0, Math.min(1440 - drag.currentDuration, minutes));

    drag.currentStartTime = targetDay.startTimestamp + clamped * 60;
    drag.currentDayIndex = targetDayIndex;

    const x1 = this.canvas.timeToX(clamped);
    this.canvas.setSnapGuide(this.isShiftPressed ? x1 : null);
    this.canvas.setPlayhead(x1);
  }

  moveBlock(e, drag, canvasRect) {
    const relX = e.clientX - canvasRect.left;
    const relY = e.clientY - canvasRect.top;

    const targetDayIndex = this.canvas.yToDayIndex(relY);
    const targetDay = this.state.days[targetDayIndex];

    const taskLeftX = relX - (drag.offsetX || 0);
    const minutes = this.snapMinutesValue(this.canvas.xToMinutes(taskLeftX));
    const clamped = Math.max(0, Math.min(1440 - drag.currentDuration, minutes));

    drag.currentStartTime = targetDay.startTimestamp + clamped * 60;
    drag.currentDayIndex = targetDayIndex;

    const x1 = this.canvas.timeToX(clamped);
    const x2 = this.canvas.timeToX(clamped + drag.currentDuration);

    if (drag.domElement) {
      drag.domElement.style.left = `${x1}px`;
      drag.domElement.style.top = `${this.canvas.dayIndexToY(targetDayIndex) + 5}px`;
      this.applyBlockWidth(drag.domElement, x2 - x1);
      this.setMetaText(drag.domElement, clamped, drag.currentDuration);
    }

    this.canvas.setSnapGuide(this.isShiftPressed ? x1 : null);
    this.canvas.setPlayhead(x1);
  }

  resizeRight(e, drag, minutesPerPixel) {
    const deltaMins = Math.round((e.clientX - drag.initialClientX) * minutesPerPixel);
    const snap = this.snapMinutes();
    let newDur = Math.max(PhysicsEngine.MIN_TASK_DURATION_MINUTES, drag.initialDuration + deltaMins);
    if (snap > 0) newDur = Math.max(snap, Math.round(newDur / snap) * snap);

    const day = this.state.days[drag.currentDayIndex];
    const startMins = (drag.initialStartTime - day.startTimestamp) / 60;
    newDur = Math.min(newDur, 1440 - startMins);

    drag.currentDuration = newDur;
    drag.currentStartTime = drag.initialStartTime;

    const x1 = this.canvas.timeToX(startMins);
    const x2 = this.canvas.timeToX(startMins + newDur);

    if (drag.domElement) {
      this.applyBlockWidth(drag.domElement, x2 - x1);
      this.setMetaText(drag.domElement, startMins, newDur);
    }
    this.canvas.setPlayhead(x2);
  }

  resizeLeft(e, drag, minutesPerPixel) {
    const deltaMins = Math.round((e.clientX - drag.initialClientX) * minutesPerPixel);
    const day = this.state.days[drag.currentDayIndex];
    const endTime = drag.initialStartTime + drag.initialDuration * 60;

    let newStartTime = drag.initialStartTime + deltaMins * 60;
    const snap = this.snapMinutes();
    if (snap > 0) newStartTime = PhysicsEngine.snapTimestamp(newStartTime, snap);

    // Keep the block inside the day and never below the minimum duration.
    newStartTime = Math.max(day.startTimestamp, newStartTime);
    newStartTime = Math.min(newStartTime, endTime - PhysicsEngine.MIN_TASK_DURATION_MINUTES * 60);

    const newDur = Math.round((endTime - newStartTime) / 60);
    drag.currentStartTime = newStartTime;
    drag.currentDuration = newDur;

    const startMins = (newStartTime - day.startTimestamp) / 60;
    const x1 = this.canvas.timeToX(startMins);
    const x2 = this.canvas.timeToX(startMins + newDur);

    if (drag.domElement) {
      drag.domElement.style.left = `${x1}px`;
      this.applyBlockWidth(drag.domElement, x2 - x1);
      this.setMetaText(drag.domElement, startMins, newDur);
    }
    this.canvas.setPlayhead(x1);
  }

  moveSeam(e, drag, minutesPerPixel) {
    const deltaMins = Math.round((e.clientX - drag.initialClientX) * minutesPerPixel);
    let boundary = drag.initialBoundary + deltaMins * 60;

    const snap = this.snapMinutes();
    if (snap > 0) boundary = PhysicsEngine.snapTimestamp(boundary, snap);

    // The boundary may travel anywhere between the two blocks' outer edges, as
    // long as neither side drops below the minimum duration.
    const minBoundary = drag.left.start + DragController.SEAM_MIN_MINUTES * 60;
    const rightEnd = drag.right.start + drag.right.duration * 60;
    const maxBoundary = rightEnd - DragController.SEAM_MIN_MINUTES * 60;

    drag.currentBoundary = Math.max(minBoundary, Math.min(maxBoundary, boundary));

    this.applySeamToDom(drag);

    const day = this.state.days[drag.currentDayIndex];
    if (day) this.canvas.setPlayhead(this.canvas.timeToX((drag.currentBoundary - day.startTimestamp) / 60));
  }

  // Both blocks move under the cursor as the seam is dragged, so a joint resize
  // reads as one gesture rather than two separate edits.
  applySeamToDom(drag) {
    const day = this.state.days[drag.currentDayIndex];
    if (!day) return;

    const boundaryMin = (drag.currentBoundary - day.startTimestamp) / 60;
    const boundaryX = this.canvas.timeToX(boundaryMin);

    const leftStartMin = (drag.left.start - day.startTimestamp) / 60;
    const leftCard = this.cardFor(drag.left.task.id, drag.left.segIdx);
    if (leftCard) {
      const x1 = this.canvas.timeToX(leftStartMin);
      this.applyBlockWidth(leftCard, boundaryX - x1);
      this.setMetaText(leftCard, leftStartMin, Math.round(boundaryMin - leftStartMin));
      leftCard.classList.add('is-resizing');
    }

    const rightCard = this.cardFor(drag.right.task.id, drag.right.segIdx);
    if (rightCard) {
      const rightEndMin = (drag.right.start - day.startTimestamp) / 60 + drag.right.duration;
      const rx1 = this.canvas.timeToX(boundaryMin);
      rightCard.style.left = `${rx1}px`;
      this.applyBlockWidth(rightCard, this.canvas.timeToX(rightEndMin) - rx1);
      this.setMetaText(rightCard, boundaryMin, Math.round(rightEndMin - boundaryMin));
      rightCard.classList.add('is-resizing');
    }

    if (drag.domElement) drag.domElement.style.left = `${boundaryX}px`;
  }

  cardFor(taskId, segmentIndex) {
    return this.dom.blockLayer.querySelector(
      `.timeline-task-card[data-task-id="${taskId}"][data-segment-index="${segmentIndex}"]`
    );
  }

  setMetaText(cardEl, startMinutes, durationMinutes) {
    const metaEl = cardEl.querySelector('.task-meta-text');
    if (!metaEl) return;
    const start = this.canvas.formatTimeLabel(startMinutes);
    const end = this.canvas.formatTimeLabel(startMinutes + durationMinutes);
    metaEl.textContent = `${start} - ${end} (${durationMinutes}m)`;
  }

  // ==========================================
  // DRAG END
  // ==========================================

  async handleMouseUp() {
    if (!this.activeDrag) return;

    const drag = this.activeDrag;
    this.activeDrag = null;

    if (this._projectionRaf) {
      cancelAnimationFrame(this._projectionRaf);
      this._projectionRaf = null;
    }

    this.dom.clearProjection();
    this.hideHint();
    this.canvas.setPlayhead(null);
    this.canvas.setSnapGuide(null);
    document.body.classList.remove('is-seam-dragging');

    if (drag.domElement) {
      drag.domElement.classList.remove('is-dragging', 'is-resizing', 'is-active');
    }
    this.dom.blockLayer.querySelectorAll('.is-resizing').forEach(el => {
      el.classList.remove('is-resizing');
    });

    if (this.globalGhostEl) {
      this.globalGhostEl.remove();
      this.globalGhostEl = null;
    }

    // Dropped back into the sidebar: this is a reorder, not a schedule change.
    if (drag.type === 'sidebar-drop' && !drag.isOverCalendar) {
      if (this.onReorderTasks) {
        this.onReorderTasks(drag.taskId, drag.hoveredSidebarTask, drag.hoveredCategory);
      }
      return;
    }

    const updates = this.resolveDragOutcome(drag);
    if (!updates.length) {
      this.dom.render();
      return;
    }

    await this.onCommitChanges(updates);
  }
}
