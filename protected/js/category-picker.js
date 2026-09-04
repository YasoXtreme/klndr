// Klndr Category Picker
//
// One renderer for both places a category gets chosen: the inline create bar in
// the tasks panel and the floating block editor. They used to hold a copy each,
// which is how they came to disagree - and how both ended up populated once at
// startup, BEFORE the tasks and categories had loaded, so neither ever showed
// anything but the eleven names that used to be hardcoded.
//
// The fix is not just sharing the code, it is WHEN it runs: render() is called
// every time a popup opens, never at init, so the list is whatever the person
// owns right now.

const CategoryPicker = {
  // "No category" is drawn as though it were a category, so the pinned-selected
  // row, the checkmark and the accent all work without a special case. It has
  // no id, which is also what marks it as un-editable.
  NONE: { id: null, name: null, color: null, icon: null },

  // The key the uncategorised filter pill and the uncategorised board column
  // are addressed by. It cannot be an empty string: both the pill handler and
  // the drag drop-target read their value as `dataset.category || <fallback>`,
  // so "" would silently become the default filter in one place and "no column
  // was under the pointer" in the other.
  UNCATEGORIZED: '__UNCATEGORIZED__',

  /**
   * @param {HTMLElement} popupEl      the .picker-popup-categories container
   * @param {Object}      options
   * @param {Array}       options.categories   the person's categories
   * @param {?string}     options.selectedName the task's current category name
   * @param {Function}    options.onPick       (category) => void, NONE to clear
   * @param {Function}    options.onEdit       (category) => void
   * @param {Function}    options.onCreate     () => void
   */
  render(popupEl, { categories, selectedName, onPick, onEdit, onCreate }) {
    if (!popupEl) return;
    popupEl.innerHTML = '';

    const rows = [this.NONE, ...(categories || [])];

    // A task can carry a name no category covers - one renamed in another tab,
    // or imported into a week this client never loaded. Showing it as the
    // selected row is the only honest option: dropping it would make the picker
    // claim the task is uncategorised when it is not.
    const known = rows.some(cat => cat.name === selectedName);
    if (selectedName && !known) {
      rows.push({ id: null, name: selectedName, color: null, icon: null });
    }

    // Selected first. Everything else keeps the person's own order.
    const selected = rows.find(cat => cat.name === (selectedName || null));
    const ordered = selected ? [selected, ...rows.filter(cat => cat !== selected)] : rows;

    ordered.forEach(category => {
      popupEl.appendChild(
        this.buildRow(category, category === selected, onPick, onEdit)
      );
    });

    const create = document.createElement('button');
    create.type = 'button';
    create.className = 'picker-item-newcat';
    create.innerHTML =
      '<span class="material-symbols-outlined">add</span><span>New category</span>';
    create.addEventListener('click', (e) => {
      e.stopPropagation();
      if (onCreate) onCreate();
    });
    popupEl.appendChild(create);
  },

  buildRow(category, isSelected, onPick, onEdit) {
    // A div, not a button: the pencil is a button of its own and nesting one
    // inside another is invalid and unclickable in some browsers.
    const row = document.createElement('div');
    row.className = `picker-item-category ${isSelected ? 'is-selected' : ''}`.trim();
    row.setAttribute('role', 'button');
    row.tabIndex = 0;

    const swatch = document.createElement('span');
    swatch.className = `picker-cat-swatch ${category.color ? '' : 'is-blank'}`.trim();
    if (category.color) swatch.style.backgroundColor = category.color;
    if (category.icon) {
      swatch.innerHTML = `<span class="material-symbols-outlined">${category.icon}</span>`;
    }
    row.appendChild(swatch);

    const name = document.createElement('span');
    name.className = 'picker-cat-name';
    name.textContent = category.name || 'No category';
    row.appendChild(name);

    // The check and the pencil share the right-hand slot: hovering swaps one
    // for the other, so the selected row never has to show both at once.
    if (isSelected) {
      const check = document.createElement('span');
      check.className = 'picker-cat-check material-symbols-outlined';
      check.textContent = 'check';
      row.appendChild(check);
    }

    // Only a real category can be edited. "No category" and an orphaned name
    // have no record behind them to open.
    if (category.id) {
      const pencil = document.createElement('button');
      pencil.type = 'button';
      pencil.className = 'picker-cat-edit';
      pencil.title = `Edit ${category.name}`;
      pencil.innerHTML = '<span class="material-symbols-outlined">edit</span>';
      pencil.addEventListener('click', (e) => {
        e.stopPropagation();
        if (onEdit) onEdit(category);
      });
      row.appendChild(pencil);
    }

    row.addEventListener('click', (e) => {
      e.stopPropagation();
      if (onPick) onPick(category);
    });

    return row;
  }
};
