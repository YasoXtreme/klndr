// Announcement Studio - the editor's form: words, button, delivery, audience
// and schedule. The header section is editor-media.js.

(() => {
  const S = KlndrStudio;
  const { Rules, state, h, icon, checkbox, select, segment, section, counterFor, field } = S;
  const E = () => S.editor;

  // ==========================================
  // THE BODY EDITOR
  // ==========================================

  // execCommand keeps the browser's own undo stack working; setRangeText is the
  // fallback wherever it has gone.
  function insert(textarea, text) {
    textarea.focus();
    let done = false;
    try {
      done = document.execCommand('insertText', false, text);
    } catch {
      done = false;
    }
    if (!done) {
      textarea.setRangeText(text, textarea.selectionStart, textarea.selectionEnd, 'end');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  function wrapWith(t, before, after, placeholder) {
    const start = t.selectionStart;
    const selected = t.value.slice(start, t.selectionEnd) || placeholder;
    insert(t, before + selected + after);
    t.setSelectionRange(start + before.length, start + before.length + selected.length);
  }

  function lineRange(t) {
    const value = t.value;
    const start = value.lastIndexOf('\n', t.selectionStart - 1) + 1;
    let end = value.indexOf('\n', t.selectionEnd);
    if (end < 0) end = value.length;
    return { start, end, lines: value.slice(start, end).split('\n') };
  }

  function replaceLines(t, range, next) {
    t.setSelectionRange(range.start, range.end);
    insert(t, next);
    t.setSelectionRange(range.start, range.start + next.length);
  }

  function prefixLines(t, prefix) {
    const range = lineRange(t);
    const all = range.lines.every((line) => line.startsWith(prefix));
    replaceLines(t, range, range.lines.map((line) => (all ? line.slice(prefix.length) : prefix + line)).join('\n'));
  }

  function numberLines(t) {
    const range = lineRange(t);
    replaceLines(t, range, range.lines.map((line, i) => `${i + 1}. ${line.replace(/^\d+[.)]\s+/, '')}`).join('\n'));
  }

  function block(t, snippet, placeholder) {
    const start = t.selectionStart;
    const selected = t.value.slice(start, t.selectionEnd) || placeholder;
    const lead = start > 0 && t.value[start - 1] !== '\n' ? '\n\n' : '';
    insert(t, lead + snippet + selected);
  }

  function link(t) {
    const start = t.selectionStart;
    const label = t.value.slice(start, t.selectionEnd) || 'link text';
    insert(t, `[${label}](https://)`);
    const urlStart = start + label.length + 3;
    t.setSelectionRange(urlStart, urlStart + 'https://'.length);
  }

  const TOOLS = [
    { glyph: 'title', label: 'Heading', run: (t) => prefixLines(t, '## ') },
    { glyph: 'format_bold', label: 'Bold', key: 'b', run: (t) => wrapWith(t, '**', '**', 'bold') },
    { glyph: 'format_italic', label: 'Italic', key: 'i', run: (t) => wrapWith(t, '_', '_', 'italic') },
    { glyph: 'strikethrough_s', label: 'Strikethrough', run: (t) => wrapWith(t, '~~', '~~', 'struck') },
    { glyph: 'link', label: 'Link', key: 'k', run: link },
    null,
    { glyph: 'format_list_bulleted', label: 'Bulleted list', run: (t) => prefixLines(t, '- ') },
    { glyph: 'format_list_numbered', label: 'Numbered list', run: numberLines },
    { glyph: 'checklist', label: 'Checklist', run: (t) => prefixLines(t, '- [ ] ') },
    null,
    { glyph: 'format_quote', label: 'Quote', run: (t) => prefixLines(t, '> ') },
    { glyph: 'lightbulb', label: 'Tip', run: (t) => block(t, '> [!TIP]\n> ', 'A handy tip') },
    { glyph: 'code', label: 'Code', run: (t) => wrapWith(t, '`', '`', 'code') },
    { glyph: 'keyboard', label: 'Keyboard key', run: (t) => wrapWith(t, '[[', ']]', 'Ctrl+Z') },
    { glyph: 'horizontal_rule', label: 'Divider', run: (t) => block(t, '---\n', '') }
  ];

  const HELP = [
    ['## Heading', 'A heading'],
    ['**bold**  _italic_  ~~struck~~', 'Emphasis'],
    ['[text](https://example.com)', 'A link'],
    ['- item   1. item', 'A list, bulleted or numbered'],
    ['- [x] done', 'A checklist'],
    ['> [!TIP]\n> text', 'A callout (also NOTE, WARNING)'],
    ['`code`   [[Ctrl+Z]]', 'Code, and a keyboard key'],
    ['![alt](https://…)', 'A picture - or just paste one'],
    ['---', 'A divider']
  ];

  function helpTable() {
    const details = h('details', 'st-md-help');
    details.appendChild(h('summary', null, 'Formatting help'));
    const table = h('table');
    const body = h('tbody');
    for (const [syntax, meaning] of HELP) {
      const row = h('tr');
      const code = h('td');
      code.appendChild(h('code', null, syntax));
      row.append(code, h('td', null, meaning));
      body.appendChild(row);
    }
    table.appendChild(body);
    details.appendChild(table);
    return details;
  }

  function swapToken(textarea, token, replacement) {
    const at = textarea.value.indexOf(token);
    if (at >= 0) textarea.setRangeText(replacement, at, at + token.length, 'preserve');
  }

  async function uploadIntoBody(ed, textarea, file) {
    if (!state.storage || !state.storage.configured) {
      S.toast('Uploads are off until storage is set up.', 'error');
      return;
    }
    const token = `![Uploading ${file.name.replace(/[[\]()]/g, '')}…](#${Date.now().toString(36)})`;
    insert(textarea, token);
    const sync = () => {
      ed.draft.body = textarea.value;
      E().changed(ed);
    };
    try {
      const media = await S.uploads.uploadFile(file, () => {});
      const alt = file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim();
      swapToken(textarea, token, `![${alt}](${media.url})`);
      sync();
    } catch (err) {
      swapToken(textarea, token, '');
      sync();
      S.toast(err.message, 'error');
    }
  }

  function bodyEditor(ed) {
    const textarea = h('textarea', 'st-textarea is-body');
    textarea.id = 'stBody';
    textarea.maxLength = 20000;
    textarea.value = ed.draft.body;
    textarea.placeholder = 'Tell people what changed, and why they will like it.';
    textarea.addEventListener('input', () => {
      ed.draft.body = textarea.value;
      E().changed(ed);
    });

    const picker = h('input');
    picker.type = 'file';
    picker.accept = 'image/*';
    picker.hidden = true;
    picker.addEventListener('change', () => {
      const file = picker.files && picker.files[0];
      picker.value = '';
      if (file) uploadIntoBody(ed, textarea, file);
    });

    const mac = /Mac|iPhone|iPad/.test(navigator.userAgent);
    const toolbar = h('div', 'st-toolbar');
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute('aria-label', 'Formatting');
    const tools = [...TOOLS, null, { glyph: 'image', label: 'Picture', run: () => picker.click() }];
    for (const tool of tools) {
      if (!tool) {
        toolbar.appendChild(h('span', 'st-tool-sep'));
        continue;
      }
      const node = h('button', 'st-tool');
      node.type = 'button';
      node.title = tool.key ? `${tool.label} (${mac ? '⌘' : 'Ctrl+'}${tool.key.toUpperCase()})` : tool.label;
      node.setAttribute('aria-label', tool.label);
      node.appendChild(icon(tool.glyph));
      // Keeps the selection in the textarea when the button is pressed.
      node.addEventListener('mousedown', (event) => event.preventDefault());
      node.addEventListener('click', () => tool.run(textarea));
      toolbar.appendChild(node);
    }

    textarea.addEventListener('keydown', (event) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      const tool = TOOLS.find((t) => t && t.key === event.key.toLowerCase());
      if (tool) {
        event.preventDefault();
        tool.run(textarea);
      }
    });

    const takeImage = (files, event) => {
      const file = [...(files || [])].find((f) => /^image\//.test(f.type));
      if (!file) return;
      event.preventDefault();
      uploadIntoBody(ed, textarea, file);
    };
    textarea.addEventListener('paste', (event) => takeImage(event.clipboardData && event.clipboardData.files, event));
    textarea.addEventListener('drop', (event) => takeImage(event.dataTransfer && event.dataTransfer.files, event));

    const wrap = h('div', 'st-field');
    const row = h('div', 'st-label-row');
    const label = h('label', 'st-label', 'Body');
    label.htmlFor = 'stBody';
    row.append(label, counterFor(textarea, 20000));
    wrap.append(row, toolbar, textarea, picker, helpTable());
    return wrap;
  }

  // ==========================================
  // SECTIONS
  // ==========================================

  function radioChoices(label, options, current, onPick) {
    const group = h('div', 'st-choices');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', label);
    for (const option of options) {
      const choice = h('button', 'st-choice');
      choice.type = 'button';
      choice.setAttribute('role', 'radio');
      choice.append(icon(option.icon), h('span', 'st-choice-label', option.label));
      if (option.hint) choice.appendChild(h('span', 'st-choice-hint', option.hint));
      const on = option.id === current;
      choice.classList.toggle('is-selected', on);
      choice.setAttribute('aria-checked', String(on));
      choice.addEventListener('click', () => {
        S.selectIn(group, choice);
        onPick(option.id);
      });
      group.appendChild(choice);
    }
    return group;
  }

  function words(ed) {
    const { box, body } = section('words', 'Words', 'The summary is what the inbox, banners and corner cards show.');

    const kinds = h('div', 'st-kinds');
    kinds.setAttribute('role', 'radiogroup');
    kinds.setAttribute('aria-label', 'Kind of news');
    for (const kind of Rules.KINDS) {
      const chip = h('button', 'st-choice st-kind');
      chip.type = 'button';
      chip.dataset.kind = kind.id;
      chip.setAttribute('role', 'radio');
      chip.append(icon(kind.icon), h('span', 'st-choice-label', kind.label));
      chip.classList.toggle('is-selected', ed.draft.kind === kind.id);
      chip.setAttribute('aria-checked', String(ed.draft.kind === kind.id));
      chip.addEventListener('click', () => {
        ed.draft.kind = kind.id;
        S.selectIn(kinds, chip);
        E().changed(ed);
      });
      kinds.appendChild(chip);
    }
    body.appendChild(field({ label: 'Kind', control: kinds }));

    const title = h('input', 'st-input is-title');
    title.type = 'text';
    title.maxLength = 90;
    title.value = ed.draft.title;
    title.placeholder = "What's new?";
    title.addEventListener('input', () => {
      ed.draft.title = title.value;
      E().changed(ed);
    });
    ed.dom.title = title;
    body.appendChild(field({ label: 'Title', id: 'stTitle', control: title, counter: counterFor(title, 90) }));

    const summary = h('textarea', 'st-textarea');
    summary.rows = 2;
    summary.maxLength = 160;
    summary.value = ed.draft.summary;
    summary.placeholder = 'One line people see before they open it';
    summary.addEventListener('input', () => {
      ed.draft.summary = summary.value.replace(/\s*\n\s*/g, ' ');
      E().changed(ed);
    });
    body.appendChild(field({
      label: 'Summary',
      id: 'stSummary',
      control: summary,
      counter: counterFor(summary, 160),
      hint: 'Optional. Without one, the start of the body stands in.'
    }));

    body.appendChild(bodyEditor(ed));
    return box;
  }

  function buttonSection(ed) {
    const { box, body } = section('button', 'Button and reactions', 'An optional call to action, and whether people can react.');
    const details = h('div', 'st-fields');

    const toggle = checkbox('Add a button', Boolean(ed.draft.cta), (on) => {
      ed.draft.cta = on ? S.clone(ed.lastCta) || { label: 'Take a look', app_action: 'open_categories' } : null;
      render();
      E().changed(ed);
    });

    function render() {
      details.replaceChildren();
      const cta = ed.draft.cta;
      if (!cta) return;
      const remember = () => {
        ed.lastCta = S.clone(cta);
        E().changed(ed);
      };

      const label = h('input', 'st-input');
      label.type = 'text';
      label.maxLength = 32;
      label.value = cta.label || '';
      label.placeholder = 'Try it';
      label.addEventListener('input', () => {
        cta.label = label.value;
        remember();
      });

      const isLink = cta.url != null && !cta.app_action;
      const opens = segment(
        [{ id: 'app', label: 'A klndr screen', icon: 'widgets' }, { id: 'url', label: 'A link', icon: 'link' }],
        isLink ? 'url' : 'app',
        (choice) => {
          if (choice === 'url') {
            delete cta.app_action;
            cta.url = cta.url || 'https://';
          } else {
            delete cta.url;
            cta.app_action = cta.app_action || 'open_categories';
          }
          render();
          remember();
        },
        'The button opens'
      );

      const row = h('div', 'st-row');
      row.append(
        field({ label: 'Label', id: 'stCtaLabel', control: label, counter: counterFor(label, 32) }),
        field({ label: 'It opens', control: opens })
      );
      details.appendChild(row);

      if (isLink) {
        const url = h('input', 'st-input');
        url.type = 'url';
        url.value = cta.url;
        url.placeholder = 'https://';
        url.addEventListener('input', () => {
          cta.url = url.value.trim();
          remember();
        });
        details.appendChild(field({ label: 'Link', id: 'stCtaUrl', control: url, hint: 'Opens in a new tab. https://, http:// or mailto: only.' }));
      } else {
        const screens = select(Rules.APP_ACTIONS.map((a) => [a.id, a.label]), cta.app_action, (value) => {
          cta.app_action = value;
          remember();
        });
        details.appendChild(field({ label: 'Screen', id: 'stCtaAction', control: screens }));
      }
    }
    render();

    const reactions = checkbox(
      'Let people react',
      ed.draft.reactions_enabled,
      (on) => {
        ed.draft.reactions_enabled = on;
        E().changed(ed);
      },
      `${Rules.REACTIONS.map((r) => r.emoji).join(' ')} - one each, and they can change their mind.`
    );

    body.append(toggle, details, reactions);
    return box;
  }

  function delivery(ed) {
    const { box, body } = section('delivery', 'Delivery', 'How it reaches the people who are already here.');
    const choices = radioChoices('Delivery', Rules.DELIVERIES, ed.draft.delivery, (id) => {
      ed.draft.delivery = id;
      ed.previewMode = id;
      if (ed.dom.previewModes) ed.dom.previewModes.sync(id);
      E().changed(ed);
    });

    const pinned = checkbox('Pin it to the top of the inbox', ed.draft.pinned, (on) => {
      ed.draft.pinned = on;
      E().changed(ed);
    });

    const evergreen = checkbox(
      'Also show it to people who join later',
      ed.draft.evergreen,
      (on) => {
        ed.draft.evergreen = on;
        renderReach(ed);
        E().changed(ed);
      },
      'Otherwise anyone who signs up after it goes out finds it in their inbox as history, without being interrupted by it. Right for a welcome post.'
    );

    body.append(choices, pinned, evergreen);
    return box;
  }

  function renderReach(ed) {
    const node = ed.dom.reach;
    if (!node) return;
    const sent = ed.doc.status === 'published';
    const people = Rules.audienceOf({
      ...ed.draft,
      status: ed.doc.status,
      publish_at: sent ? ed.doc.publish_at : ed.draft.publish_at,
      redelivered_at: ed.doc.redelivered_at
    }, state.users).length;
    const note = sent && !ed.draft.evergreen ? ' - the people who were here when it went out' : '';
    node.replaceChildren(icon('group'), document.createTextNode(`Reaches ${S.plural(people, 'person', 'people')}${note}`));
  }

  function audience(ed) {
    const { box, body } = section('audience', 'Audience', 'Who it is for.');
    const picker = h('div');
    const reach = h('p', 'st-reach');
    ed.dom.reach = reach;

    const options = [
      { id: 'everyone', icon: 'groups', hint: 'Every account' },
      { id: 'admins', icon: 'shield_person', hint: 'Handy for a trial run' },
      { id: 'users', icon: 'person_search', hint: 'Choose people by name' }
    ].map((option) => ({ ...option, label: Rules.AUDIENCES.find((a) => a.id === option.id).label }));

    const choices = radioChoices('Audience', options, ed.draft.audience.type, (id) => {
      ed.draft.audience.type = id;
      renderPicker();
      renderReach(ed);
      E().changed(ed);
    });

    function renderPicker() {
      picker.replaceChildren();
      if (ed.draft.audience.type !== 'users') return;

      const search = h('input', 'st-input st-people-search');
      search.type = 'search';
      search.placeholder = 'Find someone';
      search.setAttribute('aria-label', 'Find people');
      const list = h('div', 'st-people');

      const renderRows = () => {
        const query = search.value.trim().toLowerCase();
        const chosen = new Set(ed.draft.audience.user_ids);
        const people = state.users
          .filter((u) => !query || u.username.includes(query))
          .sort((a, b) => Number(chosen.has(b.id)) - Number(chosen.has(a.id)) || a.username.localeCompare(b.username));

        list.replaceChildren(...people.map((person) => {
          const on = chosen.has(person.id);
          const row = h('button', `st-person${on ? ' is-selected' : ''}`);
          row.type = 'button';
          row.setAttribute('aria-pressed', String(on));
          row.append(
            icon(on ? 'check_box' : 'check_box_outline_blank'),
            h('span', 'st-person-name', person.username),
            h('span', `role-badge is-${person.role === 'admin' ? 'admin' : 'user'}`, person.role === 'admin' ? 'Admin' : 'Member'),
            h('span', 'st-person-when', `joined ${KlndrAnnouncementReader.formatDate(person.created_at)}`)
          );
          row.addEventListener('click', () => {
            const ids = new Set(ed.draft.audience.user_ids);
            if (ids.has(person.id)) ids.delete(person.id);
            else ids.add(person.id);
            ed.draft.audience.user_ids = [...ids];
            renderRows();
            renderReach(ed);
            E().changed(ed);
          });
          return row;
        }));
        if (!people.length) list.appendChild(h('p', 'st-hint', 'Nobody by that name.'));
      };

      search.addEventListener('input', renderRows);
      renderRows();
      picker.append(search, list);
    }

    renderPicker();
    renderReach(ed);
    body.append(choices, picker, reach);
    return box;
  }

  function dateInput(value, onChange) {
    const input = h('input', 'st-input');
    input.type = 'datetime-local';
    input.value = S.toLocalInput(value);
    input.addEventListener('change', () => {
      const next = S.fromLocalInput(input.value);
      if (next) onChange(next);
    });
    return input;
  }

  function schedule(ed) {
    const { box, body } = section('schedule', 'Schedule', `Times are in ${S.TIMEZONE}.`);
    const status = ed.doc.studio_status;

    if (ed.doc.published_at && status !== 'scheduled' && status !== 'draft') {
      const again = ed.doc.redelivered_at ? `, and was sent again ${S.fmtDateTime(ed.doc.redelivered_at)}` : '';
      body.appendChild(h('p', 'st-hint', `Went out ${S.fmtDateTime(ed.doc.publish_at)}${again}.`));
    } else {
      const holder = h('div', 'st-fields');
      const render = () => {
        holder.replaceChildren();
        const later = ed.draft.publish_at != null;
        const when = segment(
          [{ id: 'now', label: 'When I publish', icon: 'bolt' }, { id: 'later', label: 'At a set time', icon: 'event' }],
          later ? 'later' : 'now',
          (choice) => {
            ed.draft.publish_at = choice === 'later' ? ed.draft.publish_at || S.nextHour() : null;
            render();
            renderReach(ed);
            E().changed(ed);
            E().renderBar(ed);
          },
          'It goes out'
        );
        holder.appendChild(field({ label: 'It goes out', control: when }));
        if (later) {
          const input = dateInput(ed.draft.publish_at, (value) => {
            ed.draft.publish_at = value;
            E().changed(ed);
            E().renderBar(ed);
          });
          input.min = S.toLocalInput(S.nowSeconds());
          holder.appendChild(field({ label: 'Date and time', id: 'stPublishAt', control: input }));
        }
      };
      render();
      body.appendChild(holder);
    }

    const expiry = h('div', 'st-fields');
    const renderExpiry = () => {
      expiry.replaceChildren();
      const on = ed.draft.expires_at != null;
      expiry.appendChild(checkbox('Take it down automatically', on, (checked) => {
        const from = Math.max(S.nowSeconds(), ed.draft.publish_at || 0, ed.doc.publish_at || 0);
        ed.draft.expires_at = checked ? ed.draft.expires_at || Math.ceil((from + 7 * 86400) / 3600) * 3600 : null;
        renderExpiry();
        E().changed(ed);
      }, 'At that moment it leaves every inbox, banner and all.'));
      if (on) {
        const input = dateInput(ed.draft.expires_at, (value) => {
          ed.draft.expires_at = value;
          E().changed(ed);
        });
        expiry.appendChild(field({ label: 'Take down at', id: 'stExpiresAt', control: input }));
      }
    };
    renderExpiry();
    body.appendChild(expiry);
    return box;
  }

  S.sections = Object.assign(S.sections || {}, {
    words,
    button: buttonSection,
    delivery,
    audience,
    schedule,
    renderReach
  });
})();
