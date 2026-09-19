// Announcement Studio - the editor: its state, saving, and the page header's bar.
//
// Every change autosaves a beat after the last keystroke, through the revision
// check, so two admins editing one post find out instead of quietly overwriting
// each other. The form sections are editor-sections.js and editor-media.js; the
// live preview is preview.js.

(() => {
  const S = KlndrStudio;
  const { Rules, state, h, icon, button, iconButton, statusPill, menu, toast, confirmDialog, go } = S;
  const MD = KlndrMarkdown;

  const AUTOSAVE_MS = 1200;

  const ARTICLES = {
    story: 'a story',
    banner: 'a banner',
    card: 'a corner card',
    inbox: 'an inbox-only post'
  };

  const PROBLEM_SECTIONS = {
    title: 'words',
    media: 'media',
    'media.alt': 'media',
    cta: 'button',
    'cta.label': 'button',
    audience: 'audience',
    expires_at: 'schedule'
  };

  // The server hands motion headers over in their current shape already; this
  // only makes sure, so the editor never has to know any other.
  function mediaDraft(media) {
    const draft = S.clone(media);
    if (draft && draft.type === 'scene') draft.scene = KlndrMotionTimeline.normalize(draft.scene);
    return draft;
  }

  function draftOf(doc) {
    return {
      title: doc.title || '',
      summary: doc.summary || '',
      // A post from before the rewrite is converted as it opens, and only saved
      // that way once someone actually changes something.
      body: doc.body_format === 'legacy' ? MD.convertLegacy(doc.body || '') : doc.body || '',
      body_format: 'md',
      kind: doc.kind,
      media: mediaDraft(doc.media),
      cta: S.clone(doc.cta),
      delivery: doc.delivery,
      audience: S.clone(doc.audience) || { type: 'everyone', user_ids: [] },
      evergreen: Boolean(doc.evergreen),
      pinned: Boolean(doc.pinned),
      reactions_enabled: doc.reactions_enabled !== false,
      publish_at: doc.publish_at ?? null,
      expires_at: doc.expires_at ?? null
    };
  }

  function createEditorState(doc, stats) {
    const draft = draftOf(doc);
    const media = draft.media;
    return {
      id: doc.id,
      doc,
      stats,
      draft,
      revision: doc.revision,
      savedJson: JSON.stringify(draft),
      files: new Map(doc.media_file ? [[doc.media_file.id, doc.media_file]] : []),
      queue: Promise.resolve(true),
      saveTimer: 0,
      saving: false,
      error: null,
      conflict: null,
      problems: [],
      savedAt: Date.now(),
      deleted: false,
      previewMode: doc.delivery,
      previewDevice: 'desktop',
      previewReaction: null,
      previewPaused: false,
      preview: null,
      pane: 'write',
      mediaTab: !media ? 'none' : media.type === 'scene' ? 'scene' : 'upload',
      lastScene: media && media.type === 'scene' ? S.clone(media.scene) : null,
      // The motion clip being edited, when the header plays several.
      clipIndex: 0,
      lastCta: S.clone(doc.cta),
      cleanups: [],
      themeRestore: null,
      dom: {}
    };
  }

  const isDirty = (ed) => JSON.stringify(ed.draft) !== ed.savedJson;

  // What goes over the wire. A link still being typed is left out rather than
  // failing the whole save: the server refuses anything that is not a real URL.
  function payload(ed) {
    const body = S.clone(ed.draft);
    if (body.cta && body.cta.url != null && !MD.safeHref(body.cta.url)) delete body.cta.url;
    return body;
  }

  function changed(ed, { sceneOnly = false } = {}) {
    if (ed.problems.length) {
      ed.problems = [];
      renderProblems(ed);
    }
    if (ed.dom.heading) ed.dom.heading.textContent = ed.draft.title || 'Untitled';
    clearTimeout(ed.saveTimer);
    ed.saveTimer = setTimeout(() => save(ed), AUTOSAVE_MS);
    renderSaveState(ed);
    S.preview.schedule(ed, { sceneOnly });
  }

  // One save at a time. A second request racing a slow first would carry a
  // stale revision and lose to its own predecessor.
  function save(ed) {
    clearTimeout(ed.saveTimer);
    ed.queue = ed.queue.then(() => saveNow(ed), () => saveNow(ed));
    return ed.queue;
  }

  async function saveNow(ed) {
    if (ed.conflict || ed.deleted) return false;
    if (!isDirty(ed)) return true;

    const snapshot = JSON.stringify(ed.draft);
    ed.saving = true;
    renderSaveState(ed);
    try {
      const doc = await API.saveStudioAnnouncement(ed.id, { ...payload(ed), revision: ed.revision });
      ed.doc = doc;
      ed.revision = doc.revision;
      ed.savedJson = snapshot;
      ed.savedAt = Date.now();
      ed.error = null;
      if (doc.media_file) ed.files.set(doc.media_file.id, doc.media_file);
      S.updateListEntry(doc);
      return true;
    } catch (err) {
      if (err.status === 409 && err.data && err.data.announcement) {
        ed.conflict = err.data.announcement;
        renderConflict(ed);
      } else {
        ed.error = err.message || 'could not save';
        clearTimeout(ed.saveTimer);
        ed.saveTimer = setTimeout(() => save(ed), 8000);
      }
      return false;
    } finally {
      ed.saving = false;
      renderSaveState(ed);
    }
  }

  function renderSaveState(ed) {
    const node = ed.dom.saveState;
    if (!node) return;
    let name = 'saved';
    let glyph = 'cloud_done';
    let text = `Saved ${KlndrAnnouncementReader.formatAgo(Math.floor(ed.savedAt / 1000))}`;
    if (ed.conflict) {
      [name, glyph, text] = ['error', 'sync_problem', 'Not saved - changed elsewhere'];
    } else if (ed.saving) {
      [name, glyph, text] = ['saving', 'cloud_sync', 'Saving…'];
    } else if (ed.error) {
      [name, glyph, text] = ['error', 'cloud_off', `Not saved - ${ed.error}`];
    } else if (isDirty(ed)) {
      [name, glyph, text] = ['dirty', 'edit', 'Unsaved changes'];
    }
    node.dataset.state = name;
    node.replaceChildren(icon(glyph), document.createTextNode(text));
  }

  // ==========================================
  // THE BAR
  // ==========================================

  function primaryActions(ed) {
    const small = true;
    switch (ed.doc.studio_status) {
      case 'draft': {
        const later = Boolean(ed.draft.publish_at && ed.draft.publish_at > S.nowSeconds() + 60);
        return [button(later ? 'Schedule' : 'Publish', {
          icon: later ? 'schedule_send' : 'send',
          variant: 'primary',
          small,
          onClick: () => publish(ed)
        })];
      }
      case 'scheduled':
        return [button('Publish now', { icon: 'send', variant: 'primary', small, onClick: () => publish(ed, { now: true }) })];
      case 'live':
        return [button('Notify again', { icon: 'notifications_active', small, onClick: () => redeliver(ed) })];
      case 'expired':
        return [button('Publish again', { icon: 'send', variant: 'primary', small, onClick: () => publish(ed, { now: true }) })];
      default:
        return [button('Restore to drafts', {
          icon: 'unarchive',
          variant: 'primary',
          small,
          onClick: () => transition(ed, 'unpublish', 'Back in drafts.')
        })];
    }
  }

  function editorMenu(ed) {
    const status = ed.doc.studio_status;
    return [
      ed.doc.published_at ? { label: 'Stats', icon: 'monitoring', onClick: () => go(`/stats/${ed.id}`) } : null,
      {
        label: 'Duplicate',
        icon: 'content_copy',
        onClick: async () => {
          await save(ed);
          S.actions.duplicate(ed.doc);
        }
      },
      { separator: true },
      status === 'scheduled'
        ? { label: 'Unschedule', icon: 'event_busy', onClick: () => transition(ed, 'unpublish', 'Unscheduled. It is back in drafts.') }
        : null,
      status === 'live'
        ? {
            label: 'Unpublish',
            icon: 'unpublished',
            onClick: () => transition(ed, 'unpublish', 'Unpublished. It is back in drafts.', {
              title: 'Unpublish it?',
              body: 'It leaves every inbox until you publish it again. What people already did with it is kept.',
              confirm: 'Unpublish'
            })
          }
        : null,
      status !== 'archived'
        ? {
            label: 'Archive',
            icon: 'archive',
            onClick: () => transition(ed, 'archive', 'Archived.', {
              title: 'Archive it?',
              body: status === 'live'
                ? 'It leaves every inbox. You can restore it to drafts later.'
                : 'You can restore it to drafts later.',
              confirm: 'Archive'
            })
          }
        : null,
      {
        label: 'Delete',
        icon: 'delete',
        danger: true,
        onClick: () => S.actions.removeAnnouncement(ed.doc, {
          afterwards: () => {
            ed.deleted = true;
            go('/');
          }
        })
      }
    ];
  }

  // The editor's bar is the admin page header: where the post stands on the
  // left, what can happen to it on the right.
  function renderBar(ed) {
    // Only while this editor is the page. A late call from an editor that has
    // been left would draw over whatever page came next.
    if (!ed.dom.editor || !ed.dom.editor.isConnected) return;

    ed.dom.heading = h('h1', null, ed.draft.title || 'Untitled');
    ed.dom.saveState = h('span', 'st-save-state');
    ed.dom.saveState.setAttribute('role', 'status');

    KlndrAdmin.header({
      back: { label: 'All announcements', href: S.href('/') },
      lead: [statusPill(ed.doc.studio_status)],
      title: ed.dom.heading,
      meta: [ed.dom.saveState],
      actions: [
        button('Preview in app', { icon: 'open_in_new', small: true, onClick: () => S.previewInApp(ed.id, () => save(ed)) }),
        menu(iconButton('more_horiz', 'More actions'), editorMenu(ed)),
        ...primaryActions(ed)
      ],
      documentTitle: `${ed.draft.title || 'Untitled'} · Announcements`
    });
    renderSaveState(ed);
  }

  // ==========================================
  // NOTICES
  // ==========================================

  function renderConflict(ed) {
    const box = ed.dom.notices;
    if (!box) return;
    if (!ed.conflict) {
      box.replaceChildren();
      return;
    }
    const text = h('div');
    text.append(
      h('strong', null, 'Someone else changed this announcement. '),
      document.createTextNode(
        `Their version was saved ${KlndrAnnouncementReader.formatAgo(ed.conflict.updated_at)}. Your edits are still here, not saved.`
      )
    );
    const actions = h('div', 'st-note-actions');
    actions.append(
      button('Load their version', {
        small: true,
        onClick: () => {
          const theirs = ed.conflict;
          ed.conflict = null;
          reload(ed, theirs);
        }
      }),
      button('Keep mine', {
        small: true,
        variant: 'primary',
        onClick: () => {
          ed.revision = ed.conflict.revision;
          ed.conflict = null;
          renderConflict(ed);
          save(ed);
        }
      })
    );
    text.appendChild(actions);
    const note = S.note('danger', 'sync_problem', text);
    note.setAttribute('role', 'alert');
    box.replaceChildren(note);
  }

  function renderProblems(ed) {
    const box = ed.dom.problems;
    if (!box) return;
    if (!ed.problems.length) {
      box.replaceChildren();
      return;
    }
    const panel = h('div', 'st-problems');
    panel.setAttribute('role', 'alert');
    panel.appendChild(h('h3', null, 'Before this can go out:'));
    const list = h('ul');
    for (const problem of ed.problems) {
      const item = h('li');
      const jump = h('button', null, problem.message);
      jump.type = 'button';
      jump.addEventListener('click', () => focusProblem(ed, problem.field));
      item.appendChild(jump);
      list.appendChild(item);
    }
    panel.appendChild(list);
    box.replaceChildren(panel);
    panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function focusProblem(ed, fieldName) {
    if (ed.pane !== 'write') setPane(ed, 'write');
    const target = document.getElementById(`st-${PROBLEM_SECTIONS[fieldName] || 'words'}`);
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const control = fieldName === 'title' ? ed.dom.title : fieldName === 'media.alt' ? ed.dom.alt : null;
    if (control) setTimeout(() => control.focus({ preventScroll: true }), 350);
  }

  // ==========================================
  // STATUS CHANGES
  // ==========================================

  function handleError(ed, err) {
    if (err.status === 422 && err.data && err.data.problems) {
      ed.problems = err.data.problems;
      renderProblems(ed);
    } else if (err.status === 409 && err.data && err.data.announcement) {
      ed.conflict = err.data.announcement;
      renderConflict(ed);
      renderSaveState(ed);
    } else {
      toast(err.message || 'Something went wrong.', 'error');
    }
  }

  function applyDoc(ed, doc) {
    const scroll = window.scrollY;
    ed.doc = doc;
    ed.revision = doc.revision;
    ed.draft = draftOf(doc);
    ed.savedJson = JSON.stringify(ed.draft);
    ed.problems = [];
    if (doc.media_file) ed.files.set(doc.media_file.id, doc.media_file);
    S.updateListEntry(doc);
    renderEditor(ed);
    window.scrollTo(0, scroll);
  }

  async function saveFirst(ed) {
    if (await save(ed)) return true;
    toast(ed.conflict
      ? 'Sort out the conflicting edit first.'
      : "Your latest edits haven't saved yet. Try again in a moment.", 'error');
    return false;
  }

  async function publish(ed, { now = false } = {}) {
    if (!(await saveFirst(ed))) return;
    const at = now ? null : ed.draft.publish_at;
    const later = Boolean(at && at > S.nowSeconds() + 60);
    const reach = Rules.audienceOf({ ...ed.draft, status: 'draft' }, state.users).length;
    const ok = await confirmDialog({
      title: later ? 'Schedule this announcement?' : 'Publish this announcement?',
      body: `${later ? `On ${S.fmtDateTime(at)} it goes` : 'It goes'} to ${S.plural(reach, 'person', 'people')}, as ${ARTICLES[ed.draft.delivery]}.${ed.draft.evergreen ? ' People who join later get it too.' : ''}`,
      confirm: later ? 'Schedule' : 'Publish'
    });
    if (!ok) return;
    try {
      const doc = await API.transitionStudioAnnouncement(ed.id, 'publish', {
        revision: ed.revision,
        publish_at: later ? at : null
      });
      applyDoc(ed, doc);
      toast(later ? `Scheduled for ${S.fmtDateTime(doc.publish_at)}.` : 'Published. It is on its way.', 'success');
    } catch (err) {
      handleError(ed, err);
    }
  }

  async function redeliver(ed) {
    await transition(ed, 'redeliver', 'Sent again.', {
      title: 'Send it again?',
      body: `Everyone it is for gets it as news again - including people who joined since it went out - as ${ARTICLES[ed.draft.delivery]}. Reactions are kept.`,
      confirm: 'Send again'
    });
  }

  async function transition(ed, action, message, confirm) {
    if (confirm && !(await confirmDialog(confirm))) return;
    if (!(await saveFirst(ed))) return;
    try {
      applyDoc(ed, await API.transitionStudioAnnouncement(ed.id, action, { revision: ed.revision }));
      toast(message, 'success');
    } catch (err) {
      handleError(ed, err);
    }
  }

  // ==========================================
  // RENDER AND LIFECYCLE
  // ==========================================

  function setMedia(ed, media) {
    ed.draft.media = media;
    if (media && media.type === 'scene') ed.lastScene = S.clone(media.scene);
    changed(ed);
    if (ed.renderFraming) ed.renderFraming();
  }

  function setPane(ed, pane) {
    ed.pane = pane;
    if (ed.dom.editor) ed.dom.editor.dataset.pane = pane;
    if (ed.dom.paneSwitch) ed.dom.paneSwitch.sync(pane);
    if (pane === 'preview') S.preview.render(ed);
  }

  function runCleanups(ed) {
    ed.cleanups.splice(0).forEach((fn) => {
      try {
        fn();
      } catch (err) {
        console.warn('Studio cleanup failed', err);
      }
    });
    if (ed.preview) {
      ed.preview.destroy();
      ed.preview = null;
    }
  }

  function renderEditor(ed) {
    runCleanups(ed);
    ed.dom = {};

    const view = h('section', 'st-view');
    ed.dom.notices = h('div');
    ed.dom.problems = h('div');
    ed.dom.paneSwitch = S.segment(
      [{ id: 'write', label: 'Write', icon: 'edit' }, { id: 'preview', label: 'Preview', icon: 'visibility' }],
      ed.pane,
      (pane) => setPane(ed, pane),
      'Show'
    );
    ed.dom.paneSwitch.classList.add('st-pane-switch');

    const editor = h('div', 'st-editor');
    editor.dataset.pane = ed.pane;
    ed.dom.editor = editor;

    const form = h('div', 'st-form');
    form.append(
      S.sections.media(ed),
      S.sections.words(ed),
      S.sections.button(ed),
      S.sections.delivery(ed),
      S.sections.audience(ed),
      S.sections.schedule(ed)
    );
    editor.append(form, S.preview.panel(ed));
    view.append(ed.dom.notices, ed.dom.problems, ed.dom.paneSwitch, editor);
    S.main().replaceChildren(view);

    renderBar(ed);
    renderConflict(ed);
    renderProblems(ed);
    S.preview.render(ed);

    const tick = setInterval(() => renderSaveState(ed), 20000);
    ed.cleanups.push(() => clearInterval(tick));
  }

  function reload(ed, doc) {
    runCleanups(ed);
    const fresh = createEditorState(doc, ed.stats);
    fresh.themeRestore = ed.themeRestore;
    fresh.previewMode = ed.previewMode;
    fresh.previewDevice = ed.previewDevice;
    fresh.previewPaused = ed.previewPaused;
    fresh.clipIndex = ed.clipIndex;
    state.editor = fresh;
    state.view = { name: 'edit', cleanup: () => closeEditor(fresh) };
    renderEditor(fresh);
  }

  function closeEditor(ed) {
    runCleanups(ed);
    if (ed.themeRestore) ed.themeRestore();
    if (!ed.deleted) save(ed);
    if (state.editor === ed) state.editor = null;
  }

  async function openEditor(id) {
    S.loadingHeader();
    S.main().replaceChildren(h('p', 'an-loading', 'Opening…'));
    let data;
    try {
      data = await API.getStudioAnnouncement(id);
    } catch (err) {
      S.main().replaceChildren(S.errorBox(err));
      return;
    }
    // Someone may have moved on while it loaded.
    if (!data || !S.isAt(`/edit/${id}`)) return;
    const ed = createEditorState(data.announcement, data.stats);
    state.editor = ed;
    state.view = { name: 'edit', cleanup: () => closeEditor(ed) };
    renderEditor(ed);
  }

  function unsaved() {
    const ed = state.editor;
    return Boolean(ed && !ed.deleted && (isDirty(ed) || ed.saving));
  }

  window.addEventListener('beforeunload', (event) => {
    if (!unsaved()) return;
    save(state.editor);
    event.preventDefault();
    event.returnValue = '';
  });

  // With a draft unsaved, leaving is the browser's question to ask, not
  // something to play an animation over: an overlay raised for a trip the
  // person then cancels would have nowhere to go.
  if (window.KlndrBoot && KlndrBoot.guard) KlndrBoot.guard(unsaved);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state.editor) save(state.editor);
  });

  S.editor = { changed, save, isDirty, renderBar, renderSaveState, setMedia, setPane };
  S.routes.edit = openEditor;
})();
