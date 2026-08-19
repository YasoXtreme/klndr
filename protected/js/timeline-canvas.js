// Klndr Canvas Timeline Renderer
// Handles 0-24h grid, Dynamic Ruler (Default) vs Shift-Bucket view (Secondary),
// 6-bucket & 4-day initial viewports with smooth scrolling, and split-session bridges.

class TimelineCanvas {
  constructor(canvasElement, scrollContainer, state) {
    this.canvas = canvasElement;
    this.scrollContainer = scrollContainer;
    this.ctx = canvasElement.getContext('2d');
    this.state = state;
    
    this.headerHeight = 56;
    this.dayHeaderWidth = 60; // Left column width for SAT, SUN, MON...
    this.dpr = window.devicePixelRatio || 1;

    // Viewport configuration: exactly 6 buckets visible horizontally, exactly 4 days visible vertically
    this.visibleBuckets = 6;
    this.visibleDays = 4;

    this.isShiftMode = false; // When Shift is pressed, switches to Buckets Mode
    this.hoverPlayheadX = null;
    this.snapGuideX = null;

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  setShiftMode(enabled) {
    if (this.isShiftMode !== enabled) {
      this.isShiftMode = enabled;
      this.render();
    }
  }

  setPlayhead(x) {
    this.hoverPlayheadX = x;
    this.render();
  }

  setSnapGuide(x) {
    this.snapGuideX = x;
    this.render();
  }

  resize() {
    const containerRect = this.scrollContainer.getBoundingClientRect();
    const availableWidth = containerRect.width || 800;
    const availableHeight = containerRect.height || 600;

    const bucketHours = this.state.bucketHours || 2;
    const totalBuckets = 24 / bucketHours; // e.g. 24 / 2 = 12 buckets

    // Calculate cell dimensions so that 6 buckets and 4 days fit in view
    const timelineAvailableWidth = Math.max(300, availableWidth - this.dayHeaderWidth);
    const bucketWidth = timelineAvailableWidth / this.visibleBuckets;
    this.totalTimelineWidth = bucketWidth * totalBuckets;
    this.width = this.dayHeaderWidth + this.totalTimelineWidth;

    const timelineAvailableHeight = Math.max(300, availableHeight - this.headerHeight);
    this.rowHeight = Math.max(80, timelineAvailableHeight / this.visibleDays);
    this.height = this.headerHeight + (this.state.days.length * this.rowHeight);

    this.canvas.width = this.width * this.dpr;
    this.canvas.height = this.height * this.dpr;
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;

    // Ensure DOM overlay matches exact dimensions
    const domOverlay = document.getElementById('timelineDomOverlay');
    if (domOverlay) {
      domOverlay.style.width = `${this.width}px`;
      domOverlay.style.height = `${this.height}px`;
    }

    this.ctx.scale(this.dpr, this.dpr);
    this.render();
  }

  // Convert time in minutes from day start (00:00 to 24:00 = 1440 min) to X pixel
  timeToX(minutesFromStart) {
    const ratio = Math.max(0, Math.min(1, minutesFromStart / 1440));
    return this.dayHeaderWidth + ratio * this.totalTimelineWidth;
  }

  // Convert X pixel to minutes from day start (0 to 1440)
  xToMinutes(x) {
    const relX = Math.max(0, Math.min(this.totalTimelineWidth, x - this.dayHeaderWidth));
    return (relX / this.totalTimelineWidth) * 1440;
  }

  formatHourLabel(hour) {
    const h = hour % 24;
    const ampm = h >= 12 && h < 24 ? 'PM' : 'AM';
    const displayH = h % 12 === 0 ? 12 : h % 12;
    return `${displayH}:00 ${ampm}`;
  }

  formatTimeLabel(totalMinutes) {
    const hour = Math.floor(totalMinutes / 60) % 24;
    const mins = Math.floor(totalMinutes % 60);
    const ampm = hour >= 12 && hour < 24 ? 'PM' : 'AM';
    const displayH = hour % 12 === 0 ? 12 : hour % 12;
    const padM = mins < 10 ? '0' + mins : mins;
    return `${displayH}:${padM} ${ampm}`;
  }

  render() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;

    ctx.clearRect(0, 0, w, h);

    // 1. Grid Background and Day Row Dividers
    this.drawGrid(ctx, w, h);

    // 2. Dynamic Header:
    // DEFAULT is Tick Ruler (White)
    // SECONDARY on Shift is Structural Buckets (Mint Accent #f2ffec)
    if (this.isShiftMode) {
      this.drawBucketHeader(ctx, w);
    } else {
      this.drawTickRuler(ctx, w);
    }

    // 3. Split-Session Connecting Bridges
    this.drawSplitBridges(ctx);

    // 4. Interaction Guides (Snap guide & Playhead)
    this.drawGuides(ctx, h);
  }

  drawGrid(ctx, w, h) {
    const bucketHours = this.state.bucketHours || 2;
    const numDays = this.state.days.length;

    ctx.save();
    
    // Day header column background
    ctx.fillStyle = '#f9fafb';
    ctx.fillRect(0, this.headerHeight, this.dayHeaderWidth, h - this.headerHeight);

    // Day row horizontal lines
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1.8;

    for (let i = 0; i <= numDays; i++) {
      const y = this.headerHeight + i * this.rowHeight;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    // Vertical line separating Day Labels from Timeline
    ctx.beginPath();
    ctx.moveTo(this.dayHeaderWidth, 0);
    ctx.lineTo(this.dayHeaderWidth, h);
    ctx.stroke();

    // Day labels (SAT, SUN, MON...)
    this.state.days.forEach((day, index) => {
      const y = this.headerHeight + index * this.rowHeight;
      const centerY = y + this.rowHeight / 2;

      ctx.save();
      ctx.translate(this.dayHeaderWidth / 2, centerY);
      ctx.rotate(-Math.PI / 2);
      ctx.fillStyle = '#000000';
      ctx.font = '800 13px ElmsSans, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.letterSpacing = '1px';
      ctx.fillText(day.name.toUpperCase(), 0, 0);
      ctx.restore();
    });

    // Vertical 1-hour grid lines (light grey)
    ctx.strokeStyle = '#e5e7eb';
    ctx.lineWidth = 1;

    for (let hour = 1; hour < 24; hour++) {
      const mins = hour * 60;
      const x = this.timeToX(mins);

      ctx.beginPath();
      ctx.moveTo(x, this.headerHeight);
      ctx.lineTo(x, h);
      ctx.stroke();
    }

    // Major bucket vertical lines
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1.8;

    for (let hour = 0; hour <= 24; hour += bucketHours) {
      const mins = hour * 60;
      const x = this.timeToX(mins);

      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }

    ctx.restore();
  }

  /**
   * DEFAULT MODE: Precision Tick Ruler (White Background)
   */
  drawTickRuler(ctx, w) {
    const bucketHours = this.state.bucketHours || 2;
    const tickPercent = this.state.tickPercent || 25; // 10%, 12.5%, 25%, 50%
    const tickMinutes = (bucketHours * 60) * (tickPercent / 100);

    ctx.save();

    // White header background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(this.dayHeaderWidth, 0, w - this.dayHeaderWidth, this.headerHeight);

    // Borders
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(w, 0);
    ctx.moveTo(0, this.headerHeight);
    ctx.lineTo(w, this.headerHeight);
    ctx.stroke();

    const tickYBottom = this.headerHeight;

    // Draw fine tick intervals across 1440 minutes (24h)
    const step = Math.min(15, tickMinutes);
    for (let m = 0; m <= 1440; m += step) {
      const x = this.timeToX(m);
      const isHour = m % 60 === 0;
      const hourVal = Math.floor(m / 60);

      ctx.strokeStyle = '#000000';
      ctx.beginPath();

      if (isHour) {
        // Major hour tick (height 20px)
        ctx.lineWidth = 2;
        ctx.moveTo(x, tickYBottom - 20);
        ctx.lineTo(x, tickYBottom);
        ctx.stroke();

        // Major hour text label
        if (hourVal % bucketHours === 0 || hourVal === 24) {
          ctx.fillStyle = '#000000';
          ctx.font = '700 12px ElmsSans, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(this.formatHourLabel(hourVal), x, 24);
        }
      } else if (m % 30 === 0) {
        // Medium 30m tick (height 12px)
        ctx.lineWidth = 1.4;
        ctx.moveTo(x, tickYBottom - 12);
        ctx.lineTo(x, tickYBottom);
        ctx.stroke();
      } else {
        // Minor tick (height 7px)
        ctx.lineWidth = 1;
        ctx.strokeStyle = '#4b5563';
        ctx.moveTo(x, tickYBottom - 7);
        ctx.lineTo(x, tickYBottom);
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  /**
   * SECONDARY MODE (Shift held): 2-Hour Structural Buckets (Mint Accent #f2ffec)
   */
  drawBucketHeader(ctx, w) {
    const bucketHours = this.state.bucketHours || 2;

    ctx.save();

    // Mint light green accent background on Shift
    ctx.fillStyle = '#f2ffec';
    ctx.fillRect(this.dayHeaderWidth, 0, w - this.dayHeaderWidth, this.headerHeight);

    // Borders
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(w, 0);
    ctx.moveTo(0, this.headerHeight);
    ctx.lineTo(w, this.headerHeight);
    ctx.stroke();

    for (let hour = 0; hour < 24; hour += bucketHours) {
      const nextHour = hour + bucketHours;
      const x1 = this.timeToX(hour * 60);
      const x2 = this.timeToX(nextHour * 60);
      const cellWidth = x2 - x1;
      const centerX = x1 + cellWidth / 2;

      // Vertical column boundary
      ctx.beginPath();
      ctx.moveTo(x1, 0);
      ctx.lineTo(x1, this.headerHeight);
      ctx.stroke();

      const label1 = this.formatHourLabel(hour);
      const label2 = `→ ${this.formatHourLabel(nextHour)}`;

      ctx.fillStyle = '#000000';
      ctx.font = '700 12px ElmsSans, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      ctx.fillText(label1, centerX, this.headerHeight / 2 - 9);
      ctx.fillText(label2, centerX, this.headerHeight / 2 + 9);
    }

    ctx.restore();
  }

  /**
   * Draw visual connecting arcs for split sessions
   */
  drawSplitBridges(ctx) {
    if (!this.state.tasks) return;

    ctx.save();
    this.state.tasks.forEach(task => {
      if (!task.start_times || task.start_times.length < 2) return;

      for (let i = 0; i < task.start_times.length - 1; i++) {
        const st1 = task.start_times[i];
        const dur1 = task.durations[i] || 60;
        const et1 = st1 + dur1 * 60;
        const st2 = task.start_times[i + 1];

        const d1 = new Date(st1 * 1000);
        const dayIndex1 = this.state.days.findIndex(day => 
          day.date.getFullYear() === d1.getFullYear() &&
          day.date.getMonth() === d1.getMonth() &&
          day.date.getDate() === d1.getDate()
        );

        if (dayIndex1 === -1) continue;

        const dayStart1 = this.state.days[dayIndex1].startTimestamp;
        const m1 = (et1 - dayStart1) / 60;
        const m2 = (st2 - dayStart1) / 60;

        const x1 = this.timeToX(m1);
        const x2 = this.timeToX(m2);
        const y = this.headerHeight + dayIndex1 * this.rowHeight + this.rowHeight / 2;

        ctx.strokeStyle = task.color || '#9ae659';
        ctx.lineWidth = 3;
        ctx.setLineDash([4, 4]);

        ctx.beginPath();
        ctx.moveTo(x1, y);
        const controlY = y + 24;
        ctx.quadraticCurveTo((x1 + x2) / 2, controlY, x2, y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    });
    ctx.restore();
  }

  drawGuides(ctx, h) {
    ctx.save();

    // Snap Guide Line
    if (this.snapGuideX !== null && this.snapGuideX >= this.dayHeaderWidth) {
      ctx.strokeStyle = '#16a34a';
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(this.snapGuideX, 0);
      ctx.lineTo(this.snapGuideX, h);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Playhead line
    if (this.hoverPlayheadX !== null && this.hoverPlayheadX >= this.dayHeaderWidth) {
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(this.hoverPlayheadX, this.headerHeight);
      ctx.lineTo(this.hoverPlayheadX, h);
      ctx.stroke();

      const minutes = this.xToMinutes(this.hoverPlayheadX);
      const timeStr = this.formatTimeLabel(minutes);

      ctx.fillStyle = '#000000';
      ctx.beginPath();
      ctx.roundRect(this.hoverPlayheadX - 34, this.headerHeight - 24, 68, 20, 4);
      ctx.fill();

      ctx.fillStyle = '#ffffff';
      ctx.font = '700 11px ElmsSans, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(timeStr, this.hoverPlayheadX, this.headerHeight - 10);
    }

    ctx.restore();
  }
}
