// Klndr Timeline DOM Overlay Renderer
// Renders native interactive DOM cards, badges, checkboxes, handles, and tooltips over the canvas.

class TimelineDOM {
  constructor(containerElement, canvasRenderer, state, onTaskInteraction) {
    this.container = containerElement;
    this.canvas = canvasRenderer;
    this.state = state;
    this.onTaskInteraction = onTaskInteraction;
  }

  static getCategoryIconElement(iconName) {
    const icon = iconName || 'task_alt';
    return `<span class="material-symbols-outlined task-icon-symbol">${icon}</span>`;
  }

  render() {
    this.container.innerHTML = '';
    const tasks = this.state.tasks || [];
    const days = this.state.days || [];

    tasks.forEach(task => {
      if (!task.start_times || task.start_times.length === 0) return;

      task.start_times.forEach((st, segIdx) => {
        const dur = task.durations[segIdx] || 60;
        const et = st + dur * 60;

        // Find matching day
        const segDate = new Date(st * 1000);
        const dayIdx = days.findIndex(d => 
          d.date.getFullYear() === segDate.getFullYear() &&
          d.date.getMonth() === segDate.getMonth() &&
          d.date.getDate() === segDate.getDate()
        );

        if (dayIdx === -1) return;

        const dayObj = days[dayIdx];
        const dayStartTimestamp = dayObj.startTimestamp;
        
        // Coordinates across 0-24h (0 to 1440 minutes)
        const minutesFromDayStart = (st - dayStartTimestamp) / 60;
        const endMinutesFromDayStart = minutesFromDayStart + dur;

        const x1 = this.canvas.timeToX(minutesFromDayStart);
        const x2 = this.canvas.timeToX(endMinutesFromDayStart);
        const width = Math.max(16, x2 - x1);
        const top = this.canvas.headerHeight + (dayIdx * this.canvas.rowHeight) + 6;
        const height = this.canvas.rowHeight - 12;

        const isSplit = task.start_times.length > 1;
        const isFirstSegment = segIdx === 0;
        const isLastSegment = segIdx === task.start_times.length - 1;

        // Create Task Card DOM element
        const card = document.createElement('div');
        card.className = `timeline-task-card ${task.completed ? 'is-completed' : ''} ${isSplit ? 'is-split' : ''}`;
        card.dataset.taskId = task.id;
        card.dataset.segmentIndex = segIdx;
        card.style.left = `${x1}px`;
        card.style.top = `${top}px`;
        card.style.width = `${width}px`;
        card.style.height = `${height}px`;
        card.style.backgroundColor = task.color || '#9ae659';

        // 1. Circular Category Badge Overlapping Top-Left
        const badge = document.createElement('div');
        badge.className = 'task-badge-circle';
        badge.innerHTML = TimelineDOM.getCategoryIconElement(task.icon);
        card.appendChild(badge);

        // 2. Status Checkbox in Top Right
        const checkbox = document.createElement('button');
        checkbox.type = 'button';
        checkbox.className = `task-checkbox ${task.completed ? 'checked' : ''}`;
        checkbox.title = task.completed ? 'Mark uncompleted' : 'Mark completed';
        checkbox.innerHTML = task.completed ? `
          <span class="material-symbols-outlined" style="font-size: 16px; color: #000; font-weight: 800;">check</span>
        ` : '';
        checkbox.addEventListener('click', (e) => {
          e.stopPropagation();
          this.onTaskInteraction('toggleComplete', { taskId: task.id, completed: !task.completed });
        });
        card.appendChild(checkbox);

        // 3. Task Content
        const content = document.createElement('div');
        content.className = 'task-content-inner';

        const titleEl = document.createElement('div');
        titleEl.className = 'task-title-text';
        titleEl.textContent = task.title || 'Untitled Task';
        content.appendChild(titleEl);

        const metaEl = document.createElement('div');
        metaEl.className = 'task-meta-text';
        const startLabel = this.canvas.formatTimeLabel(minutesFromDayStart);
        const endLabel = this.canvas.formatTimeLabel(endMinutesFromDayStart);
        metaEl.textContent = `${startLabel} - ${endLabel} (${dur}m)`;
        content.appendChild(metaEl);

        card.appendChild(content);

        // 4. Resize Handles (Left & Right)
        const leftHandle = document.createElement('div');
        leftHandle.className = 'resize-handle resize-handle-left';
        leftHandle.title = 'Drag to adjust start time';
        leftHandle.dataset.handle = 'left';

        const rightHandle = document.createElement('div');
        rightHandle.className = 'resize-handle resize-handle-right';
        rightHandle.title = 'Drag to adjust duration';
        rightHandle.dataset.handle = 'right';

        card.appendChild(leftHandle);
        card.appendChild(rightHandle);

        // 5. Split Connection Dots
        if (isSplit) {
          if (!isLastSegment) {
            const splitDotRight = document.createElement('div');
            splitDotRight.className = 'split-connection-dot split-dot-right';
            card.appendChild(splitDotRight);
          }
          if (!isFirstSegment) {
            const splitDotLeft = document.createElement('div');
            splitDotLeft.className = 'split-connection-dot split-dot-left';
            card.appendChild(splitDotLeft);
          }
        }

        // Lock icon indicator
        if (task.is_locked !== false && !isSplit && task.category !== 'Break') {
          const lockPill = document.createElement('div');
          lockPill.className = 'task-lock-indicator';
          lockPill.title = 'Locked Duration: pushes neighboring tasks when expanding';
          lockPill.innerHTML = `<span class="material-symbols-outlined" style="font-size: 13px; color: #000;">lock</span>`;
          card.appendChild(lockPill);
        }

        // Context Menu & Double Click
        card.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          this.onTaskInteraction('openEditModal', { task });
        });

        card.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.onTaskInteraction('openContextMenu', { task, clientX: e.clientX, clientY: e.clientY });
        });

        this.container.appendChild(card);
      });
    });
  }
}
