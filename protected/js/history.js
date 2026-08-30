// Klndr Undo/Redo History
//
// The stack stores CHANGES, not snapshots of the whole board. Each entry is one
// user gesture — a drag, a split, a rename, a delete — and carries, per task it
// touched, the fields as they were and as they became. Undo replays the "before"
// side, redo replays the "after" side, and the two are otherwise identical, so
// there is no separate undo path to keep in sync with the forward one.
//
// Change shapes:
//   { kind: 'update', via: 'schedule' | 'patch', id, before, after }
//   { kind: 'create', id, snapshot, index }   undo removes it, redo puts it back
//   { kind: 'delete', id, snapshot, index }   undo puts it back, redo removes it
//   { kind: 'order',  before: [...ids], after: [...ids] }
//
// The stack never touches the network or the DOM. The app owns applying an
// entry; this only decides which one is next and which way it goes.

class HistoryStack {
  constructor(limit = 60) {
    this.limit = limit;
    this.past = [];
    this.future = [];
  }

  /**
   * Record a gesture. Doing anything new invalidates the redo branch — the
   * future the user walked away from is not reachable any more.
   */
  push(entry) {
    if (!entry || !entry.changes || !entry.changes.length) return;
    this.past.push(entry);
    if (this.past.length > this.limit) this.past.shift();
    this.future.length = 0;
  }

  canUndo() { return this.past.length > 0; }
  canRedo() { return this.future.length > 0; }

  // Both moves are made up front so a second keypress cannot re-take the same
  // entry while the first one is still being written. A replay that fails to
  // persist calls rollback() to undo the move.
  undo() {
    const entry = this.past.pop();
    if (entry) this.future.push(entry);
    return entry || null;
  }

  redo() {
    const entry = this.future.pop();
    if (entry) this.past.push(entry);
    return entry || null;
  }

  rollback(direction) {
    if (direction === 'undo') {
      const entry = this.future.pop();
      if (entry) this.past.push(entry);
    } else {
      const entry = this.past.pop();
      if (entry) this.future.push(entry);
    }
  }

  clear() {
    this.past.length = 0;
    this.future.length = 0;
  }

  // What the next press would do, for the button tooltips.
  peekLabels() {
    return {
      undo: this.past.length ? this.past[this.past.length - 1].label : null,
      redo: this.future.length ? this.future[this.future.length - 1].label : null
    };
  }
}
