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
    // Set by the app; Alt-click has nothing to do until it is.
    this.onSplitSegment = null;
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
    if (!taskCard) return;

    const taskId = taskCard.dataset.taskId;
    const segmentId = taskCard.dataset.segmentId;
    const task = this.state.tasks.find(t => t.id === taskId);
    if (!task) return;

    // Segments carry their own completion, so they are addressed by id. An index
    // would hand the wrong block to a drag whenever a re-sort landed in between.
    const segment = TaskModel.segmentById(task, segmentId);
    if (!segment) return;

    const startTime = segment.start_time;
    const duration = segment.duration;

    // Alt-click cuts the block under the pointer, no menu. Windows only for now.
    if (!handleEl && e.altKey && DragController.supportsAltSplit()) {
      e.preventDefault();
      e.stopPropagation();
      this.dom.hideTooltip();
      this.onSplitSegment(task, segmentId, this.timestampAtClientX(e.clientX, startTime));
      return;
    }

    if (handleEl) {
      e.preventDefault();
      e.stopPropagation();

      const resizeDayIndex = this.dayIndexForTimestamp(startTime);

      this.activeDrag = {
        type: handleEl.dataset.handle === 'left' ? 'resize-left' : 'resize-right',
        taskId,
        segmentId,
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
        currentDayIndex: resizeDayIndex,
        // A resize runs the same physics as a move, so it needs the same
        // sandwich check: an edge dragged into a sibling pair trades time inside
        // the pair rather than shoving the day around.
        divider: this.findDividerAt(task, segment, resizeDayIndex)
      };
      taskCard.classList.add('is-resizing');
      this.dom.hideTooltip();
      return;
    }

    if (e.target.closest('.segment-pill')) return;

    e.preventDefault();
    e.stopPropagation();
    const rect = taskCard.getBoundingClientRect();
    const dayIndex = this.dayIndexForTimestamp(startTime);

    this.activeDrag = {
      type: 'move',
      taskId,
      segmentId,
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
      currentDayIndex: dayIndex,
      // Captured once, at drag start: recomputing the pair every frame would
      // change what the gesture means halfway through it.
      divider: this.findDividerAt(task, segment, dayIndex)
    };
    taskCard.classList.add('is-dragging');
    this.dom.hideTooltip();
  }

  static supportsAltSplit() {
    return /Win/i.test(navigator.platform || navigator.userAgent || '');
  }

  timestampAtClientX(clientX, referenceTimestamp) {
    const dayIndex = this.dayIndexForTimestamp(referenceTimestamp);
    const day = this.state.days[dayIndex];
    if (!day) return referenceTimestamp;
    const rect = this.canvas.canvas.getBoundingClientRect();
    return day.startTimestamp + this.canvas.xToMinutes(clientX - rect.left) * 60;
  }

  findDividerAt(task, segment, dayIndex) {
    const day = this.state.days[dayIndex];
    if (!day) return null;

    const obstacles = PhysicsEngine.daySegments(
      this.state.tasks, day.startTimestamp, day.startTimestamp + 86400, segment.id
    );
    const found = PhysicsEngine.findDivider(
      obstacles, segment.start_time, segment.start_time + segment.duration * 60
    );
    if (!found) return null;

    return {
      taskId: found.left.taskId,
      leftId: found.left.segmentId,
      rightId: found.right.segmentId
    };
  }

  startSeamDrag(e, seamEl) {
    e.preventDefault();
    e.stopPropagation();

    const leftTask = this.state.tasks.find(t => t.id === seamEl.dataset.leftTaskId);
    const rightTask = this.state.tasks.find(t => t.id === seamEl.dataset.rightTaskId);
    if (!leftTask || !rightTask) return;

    const leftSegment = TaskModel.segmentById(leftTask, seamEl.dataset.leftSegmentId);
    const rightSegment = TaskModel.segmentById(rightTask, seamEl.dataset.rightSegmentId);
    if (!leftSegment || !rightSegment) return;

    this.activeDrag = {
      type: 'seam',
      taskId: leftTask.id,
      segmentId: leftSegment.id,
      domElement: seamEl,
      initialClientX: e.clientX,
      currentDayIndex: parseInt(seamEl.dataset.dayIndex || '0', 10),
      left: { task: leftTask, segmentId: leftSegment.id, start: leftSegment.start_time, duration: leftSegment.duration },
      right: { task: rightTask, segmentId: rightSegment.id, start: rightSegment.start_time, duration: rightSegment.duration },
      initialBoundary: rightSegment.start_time,
      currentBoundary: rightSegment.start_time
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
      segmentId: null,
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
  // The engines report every segment they considered, changed or not. Drop the
  // no-ops so the hint counts only real movement and the commit does not write
  // rows that did not move.
  pruneUnchanged(updates) {
    return updates.filter(update => {
      const task = this.state.tasks.find(t => t.id === update.id);
      if (!task) return true;

      const before = task.segments || [];
      const after = update.segments || [];
      if (before.length !== after.length) return true;

      return !after.every((seg, i) => (
        Math.abs(seg.start_time - before[i].start_time) < 30 &&
        Math.abs(seg.duration - before[i].duration) < 0.5 &&
        Boolean(seg.completed) === Boolean(before[i].completed)
      ));
    });
  }

  /**
   * A scratch copy of the segments of every task a drag touches. Mutations land
   * here, never on live tasks, so the preview can be recomputed every frame and
   * the commit path can still snapshot the pre-edit state for rollback.
   */
  createWorkspace() {
    const byTask = new Map();
    const self = this;

    return {
      segments(taskId) {
        if (!byTask.has(taskId)) {
          const task = self.state.tasks.find(t => t.id === taskId);
          byTask.set(taskId, task ? TaskModel.cloneSegments(task) : []);
        }
        return byTask.get(taskId);
      },
      set(taskId, segmentId, startTime, duration) {
        const segment = this.segments(taskId).find(seg => seg.id === segmentId);
        if (!segment) return;
        segment.start_time = startTime;
        if (duration != null) segment.duration = duration;
      },
      remove(taskId, segmentId) {
        byTask.set(taskId, this.segments(taskId).filter(seg => seg.id !== segmentId));
      },
      payloads() {
        return [...byTask.entries()].map(([taskId, segments]) => {
          const task = self.state.tasks.find(t => t.id === taskId);
          return TaskModel.payloadFrom(task, segments);
        }).filter(Boolean);
      }
    };
  }

  computeDragOutcome(drag) {
    if (!drag) return [];
    if (drag.type === 'seam') return this.resolveSeamOutcome(drag);

    const day = this.state.days[drag.currentDayIndex ?? 0];
    if (!day) return [];

    const startTime = drag.currentStartTime;
    if (startTime === null || startTime === undefined) return [];

    const task = this.state.tasks.find(t => t.id === drag.taskId);
    if (!task) return [];

    const duration = drag.currentDuration || drag.initialDuration;
    const dayStart = day.startTimestamp;
    const dayEnd = dayStart + 86400;
    const endTime = startTime + duration * 60;
    const workspace = this.createWorkspace();

    // Resizing is moving: an edge dragged into another block has to negotiate
    // with it, not sit on top of it. The only difference is which way the block
    // grows -- a left edge grows into the past, so obstacles are pushed earlier
    // and overflow flows backwards. Everything below is otherwise shared.
    const backwards = drag.type === 'resize-left';

    const obstacles = PhysicsEngine.daySegments(this.state.tasks, dayStart, dayEnd, drag.segmentId);

    // DIVIDER: this block sits between two touching blocks of one task, so it
    // acts as the boundary between them — time moves from one side to the other
    // and the pair's outer edges stay put.
    if (!this.isCtrlPressed && drag.divider) {
      const resolved = this.resolveDivider(drag, startTime, duration, dayStart, dayEnd);
      if (resolved) {
        resolved.changed.forEach(entry => {
          workspace.set(entry.taskId, entry.segmentId, entry.startTime, entry.duration);
        });
        resolved.removed.forEach(entry => workspace.remove(entry.taskId, entry.segmentId));
        this.placeDraggedSegment(workspace, task, drag, resolved.movedStart, duration);
        drag.lastOutcome = {
          kind: 'divider',
          removed: resolved.removed.length,
          blockedByCompleted: resolved.blockedByCompleted,
          taskTitle: resolved.taskTitle
        };
        return workspace.payloads();
      }
    }

    if (this.isCtrlPressed) {
      const moved = backwards
        ? PhysicsEngine.rippleBackward(obstacles, endTime, duration)
        : PhysicsEngine.ripple(obstacles, startTime, duration);
      moved.forEach(entry => {
        workspace.set(entry.taskId, entry.segmentId, entry.startTime, entry.duration);
      });
      this.placeDraggedSegment(workspace, task, drag, startTime, duration);
      drag.lastOutcome = { kind: 'ripple', moved: moved.length };
      return workspace.payloads();
    }

    // DEFAULT: flow around whatever is in the way, splitting only THIS block.
    // The task's other blocks are untouched — they are obstacles, not cargo.
    const pieces = backwards
      ? PhysicsEngine.placeAroundBackward(obstacles, endTime, duration, dayStart)
      : PhysicsEngine.placeAround(obstacles, startTime, duration, dayEnd);
    this.placeDraggedSegment(workspace, task, drag, startTime, duration, pieces);
    drag.lastOutcome = { kind: 'split', pieces: pieces.length };
    return workspace.payloads();
  }

  /**
   * Put the dragged block down. The first piece keeps the original segment id so
   * its completion travels with it; extra pieces are new blocks of the same task.
   */
  placeDraggedSegment(workspace, task, drag, startTime, duration, pieces = null) {
    const segments = workspace.segments(task.id);
    const index = segments.findIndex(seg => seg.id === drag.segmentId);
    const completed = index !== -1 ? segments[index].completed : false;

    if (!pieces || pieces.length <= 1) {
      const only = pieces && pieces.length ? pieces[0] : { startTime, duration };
      if (index === -1) {
        segments.push({
          id: drag.segmentId || TaskModel.newSegmentId(),
          start_time: only.startTime,
          duration: only.duration,
          completed: false
        });
      } else {
        segments[index].start_time = only.startTime;
        segments[index].duration = only.duration;
      }
      return;
    }

    if (index !== -1) segments.splice(index, 1);
    pieces.forEach((piece, i) => {
      segments.push({
        id: i === 0 && drag.segmentId ? drag.segmentId : TaskModel.newSegmentId(),
        start_time: piece.startTime,
        duration: piece.duration,
        completed
      });
    });
  }

  resolveDivider(drag, startTime, duration, dayStart, dayEnd) {
    const owner = this.state.tasks.find(t => t.id === drag.divider.taskId);
    if (!owner) return null;

    const entries = PhysicsEngine.daySegments([owner], dayStart, dayEnd);
    const left = entries.find(e => e.segmentId === drag.divider.leftId);
    const right = entries.find(e => e.segmentId === drag.divider.rightId);
    if (!left || !right) return null;

    const result = PhysicsEngine.applyDivider({ left, right }, startTime, startTime + duration * 60);
    result.taskTitle = owner.title || 'that task';
    return result;
  }

  resolveSeamOutcome(drag) {
    const { left, right } = drag;
    const boundary = drag.currentBoundary;
    const rightEnd = right.start + right.duration * 60;

    const workspace = this.createWorkspace();
    workspace.set(left.task.id, left.segmentId, left.start, Math.round((boundary - left.start) / 60));
    workspace.set(right.task.id, right.segmentId, boundary, Math.round((rightEnd - boundary) / 60));
    return workspace.payloads();
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

  hintTextFor(drag) {
    if (drag.type === 'seam') {
      return 'Moving the shared boundary — both blocks, same total time';
    }

    const outcome = drag.lastOutcome || {};

    if (outcome.kind === 'divider') {
      if (outcome.removed > 0) {
        return `Trading time inside ${outcome.taskTitle} — ${outcome.removed} block${outcome.removed > 1 ? 's' : ''} will be removed`;
      }
      if (outcome.blockedByCompleted) {
        return `Trading time inside ${outcome.taskTitle} — stopped at a completed block`;
      }
      return `Trading time between the blocks of ${outcome.taskTitle}`;
    }

    if (outcome.kind === 'ripple') {
      // Counted in blocks, not tasks. A resize that pushes the task's own later
      // blocks along displaces nothing "other" -- and reporting that as "nothing
      // affected" while three of its blocks slide across the day is a lie.
      const moved = outcome.moved || 0;
      return moved === 0
        ? 'Ripple — nothing else affected'
        : `Ripple — ${moved} block${moved > 1 ? 's' : ''} will shift`;
    }

    if (outcome.kind === 'split' && outcome.pieces > 1) {
      return `Breaks into ${outcome.pieces} blocks around what's in the way`;
    }

    if (drag.type === 'move' || drag.type === 'sidebar-drop') {
      return 'Hold Ctrl to push the blocks in the way instead of splitting';
    }
    return null;
  }

  updateHint(drag, updates) {
    const text = this.hintTextFor(drag);
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
    const removing = Boolean(drag.lastOutcome && drag.lastOutcome.removed);
    this.hintChipEl.classList.toggle(
      'is-warning',
      removing || (this.isCtrlPressed && updates.length > 1)
    );
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
    const leftCard = this.cardFor(drag.left.segmentId);
    if (leftCard) {
      const x1 = this.canvas.timeToX(leftStartMin);
      this.applyBlockWidth(leftCard, boundaryX - x1);
      this.setMetaText(leftCard, leftStartMin, Math.round(boundaryMin - leftStartMin));
      leftCard.classList.add('is-resizing');
    }

    const rightCard = this.cardFor(drag.right.segmentId);
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

  cardFor(segmentId) {
    return this.dom.blockLayer.querySelector(
      `.timeline-task-card[data-segment-id="${segmentId}"]`
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
