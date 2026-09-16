// Announcement Studio - the header section: motion scenes, uploads, the media
// library, and how the chosen header is framed.

(() => {
  const S = KlndrStudio;
  const { Rules, state, h, iconButton, checkbox, select, segment, section, counterFor, field } = S;
  const E = () => S.editor;

  // Scene fields that hold "the words", carried over when switching scenes.
  const WORD_KEYS = ['headline', 'title'];

  function framingFrom(previous) {
    return {
      alt: '',
      decorative: false,
      fit: (previous && previous.type !== 'scene' && previous.fit) || 'cover',
      aspect: (previous && previous.aspect) || '2:1',
      focal: { x: 0.5, y: 0.5 },
      background: null
    };
  }

  function sceneMedia(ed, scene) {
    return { type: 'scene', ...framingFrom(ed.draft.media), fit: 'cover', scene };
  }

  // A header that becomes a motion scene plays once, with the usual idle ready
  // for the moment someone turns looping on.
  function freshScene(sceneId) {
    return {
      loop: false,
      clips: [{ id: sceneId, props: KlndrScenes.sanitizeProps(sceneId, {}), hold: KlndrMotionTimeline.HOLD_DEFAULT }]
    };
  }

  // The header's motion, and the clip in it being edited. Both are read fresh
  // every time: an edit can swap the whole header object out from under
  // anything that held on to the old one.
  function motionOf(ed) {
    return ed.draft.media.scene;
  }

  function clipIndexOf(ed) {
    const last = motionOf(ed).clips.length - 1;
    ed.clipIndex = Math.min(Math.max(0, ed.clipIndex || 0), last);
    return ed.clipIndex;
  }

  function clipOf(ed) {
    return motionOf(ed).clips[clipIndexOf(ed)];
  }

  function sceneChanged(ed) {
    ed.lastScene = S.clone(motionOf(ed));
    E().changed(ed, { sceneOnly: true });
  }

  const secondsOf = (frames) => `${(frames / KlndrScenes.FPS).toFixed(1)} s`;

  // The shape closest to the file's own, so a new upload starts uncropped.
  function aspectFor(file, previous) {
    const ratio = file.width && file.height ? file.width / file.height : 0;
    if (!ratio) return (previous && previous.aspect) || '2:1';
    return Object.keys(Rules.ASPECTS).reduce((best, key) =>
      Math.abs(Math.log(Rules.ASPECTS[key] / ratio)) < Math.abs(Math.log(Rules.ASPECTS[best] / ratio)) ? key : best
    , '2:1');
  }

  function fileMedia(ed, file) {
    const previous = ed.draft.media;
    return {
      type: file.kind,
      media_id: file.id,
      ...framingFrom(previous),
      aspect: aspectFor(file, previous),
      ...(file.kind === 'video' ? { has_audio: false } : {})
    };
  }

  function carryWords(props, sceneId) {
    const scene = KlndrScenes.get(sceneId);
    const words = WORD_KEYS.map((key) => props && props[key]).find(Boolean);
    const target = scene.schema.find((f) => f.type === 'text' && WORD_KEYS.includes(f.key));
    return words && target ? { [target.key]: String(words).slice(0, target.max) } : {};
  }

  // ==========================================
  // SCENE PROPS
  // ==========================================

  function swatches(f, value, update) {
    const group = h('div', 'st-swatches');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', f.label);
    const buttons = [];

    const sync = (current) => {
      for (const [colour, node] of buttons) {
        node.classList.toggle('is-selected', colour === current);
        node.setAttribute('aria-checked', String(colour === current));
      }
    };
    const pick = (colour) => {
      update(colour);
      sync(colour);
    };

    for (const colour of [...(f.optional ? [''] : []), ...KlndrPalette.colors]) {
      const node = h('button', `st-swatch${colour ? '' : ' is-theme'}`);
      node.type = 'button';
      node.setAttribute('role', 'radio');
      const name = colour || 'Follow the theme';
      node.setAttribute('aria-label', name);
      node.title = name;
      const dot = h('span', 'st-swatch-dot');
      if (colour) dot.style.setProperty('--swatch', colour);
      node.appendChild(dot);
      node.addEventListener('click', () => pick(colour));
      buttons.push([colour, node]);
      group.appendChild(node);
    }

    const custom = h('input', 'st-color-input');
    custom.type = 'color';
    custom.value = /^#[0-9a-f]{6}$/i.test(value) ? value : '#9ae659';
    custom.title = 'Any colour';
    custom.setAttribute('aria-label', `Any ${f.label.toLowerCase()}`);
    custom.addEventListener('input', () => pick(custom.value));
    group.appendChild(custom);

    sync(value);
    return group;
  }

  function listField(f, values, update) {
    const items = values.slice();
    const list = h('div', 'st-list-items');
    const add = S.button('Add', { icon: 'add', small: true, variant: 'ghost' });
    const commit = () => update(items.map((item) => item.trim()).filter(Boolean));

    const render = () => {
      list.replaceChildren(...items.map((item, i) => {
        const row = h('div', 'st-list-item');
        const input = h('input', 'st-input');
        input.type = 'text';
        input.maxLength = f.max;
        input.value = item;
        input.setAttribute('aria-label', `${f.label} ${i + 1}`);
        input.addEventListener('input', () => {
          items[i] = input.value;
          commit();
        });
        const remove = iconButton('close', `Remove ${f.label.toLowerCase()} ${i + 1}`, () => {
          items.splice(i, 1);
          render();
          commit();
        });
        remove.disabled = items.length <= 1;
        row.append(input, remove);
        return row;
      }));
      add.disabled = items.length >= f.maxItems;
    };

    add.addEventListener('click', () => {
      items.push('');
      render();
      const inputs = list.querySelectorAll('input');
      inputs[inputs.length - 1].focus();
    });
    render();

    const wrap = h('div', 'st-field');
    const head = h('div', 'st-label-row');
    head.append(h('span', 'st-label', f.label), h('span', 'st-counter', `up to ${f.maxItems}`));
    wrap.append(head, list, add);
    if (f.key === 'emojis') wrap.appendChild(h('p', 'st-hint', 'One emoji in each works best.'));
    return wrap;
  }

  function sceneField(ed, f) {
    const update = (value) => {
      const clip = clipOf(ed);
      clip.props = KlndrScenes.sanitizeProps(clip.id, { ...clip.props, [f.key]: value });
      sceneChanged(ed);
      if (ed.refreshClips) ed.refreshClips();
    };
    const value = clipOf(ed).props[f.key];

    switch (f.type) {
      case 'text': {
        const input = h('input', 'st-input');
        input.type = 'text';
        input.maxLength = f.max;
        input.value = value;
        input.addEventListener('input', () => update(input.value));
        return field({ label: f.label, id: `stScene-${f.key}`, control: input, counter: counterFor(input, f.max) });
      }
      case 'toggle':
        return checkbox(f.label, value, (on) => update(on));
      case 'color':
        return field({ label: f.label, control: swatches(f, value, update) });
      case 'list':
        return listField(f, value, update);
      default:
        return h('span');
    }
  }

  // ==========================================
  // PANES
  // ==========================================

  // ==========================================
  // MOTION: CLIPS
  // ==========================================

  // One clip, arrived and at rest.
  function clipStill(host, clip) {
    return KlndrAnnouncementMedia.mount(host, {
      type: 'scene',
      aspect: '2:1',
      decorative: true,
      scene: { clips: [clip] }
    }, { thumbnail: true });
  }

  // How long a clip idles, labelled by what comes after it - or, for the last
  // clip of a header that plays once, a note that it simply stays.
  function holdControl(ed) {
    const motion = motionOf(ed);
    const index = clipIndexOf(ed);
    const count = motion.clips.length;
    const last = index === count - 1;

    if (last && !motion.loop) {
      return h('p', 'st-hint', count > 1
        ? 'The last clip stays on screen once it has played in: still moving, never starting over.'
        : 'It animates in once, then stays in its idle state: still moving, never starting over.');
    }

    let label = 'Idle before the next clip';
    let after = 'the next clip comes in';
    if (last) {
      label = count > 1 ? 'Idle before looping back' : 'Idle before it animates out';
      after = count > 1 ? 'the animation starts again from the first clip' : 'it plays again from the start';
    }
    return S.slider({
      label,
      id: 'stSceneHold',
      min: 0,
      max: KlndrMotionTimeline.HOLD_MAX,
      step: KlndrMotionTimeline.HOLD_STEP,
      value: clipOf(ed).hold,
      format: (seconds) => `${seconds.toFixed(1)} s`,
      onInput: (seconds) => {
        clipOf(ed).hold = KlndrMotionTimeline.cleanHold(seconds);
        sceneChanged(ed);
        if (ed.refreshClips) ed.refreshClips();
      },
      hint: `Then it animates out and ${after}.`
    });
  }

  // A header's motion is a run of clips. Each is its own scene with its own
  // words and colours; they play one after another, then loop back to the first
  // or leave the last one idling. The strip picks the clip, and everything under
  // it edits that one.
  function scenePane(ed, pane) {
    if (!ed.draft.media || ed.draft.media.type !== 'scene') {
      const last = ed.lastScene ? KlndrMotionTimeline.normalize(ed.lastScene) : null;
      E().setMedia(ed, sceneMedia(ed, last && last.clips.length ? last : freshScene('pop-reveal')));
    }

    const MAX = KlndrMotionTimeline.MAX_CLIPS;
    const stripStills = [];
    const galleryStills = [];
    const destroyAll = (mounted) => mounted.splice(0).forEach((still) => still.destroy());
    let refreshTimer = 0;
    let dragFrom = null;

    const head = h('div', 'st-clips-head');
    const strip = h('div', 'st-clip-strip');
    strip.setAttribute('role', 'radiogroup');
    strip.setAttribute('aria-label', 'Clips');
    const summary = h('p', 'st-hint st-clips-summary');
    const tools = h('div', 'st-clip-tools');
    const tiles = h('div', 'st-tiles');
    tiles.setAttribute('role', 'radiogroup');
    tiles.setAttribute('aria-label', 'Motion scenes');
    const props = h('div', 'st-fields');
    const hold = h('div', 'st-fields');

    S.onReset(pane, () => {
      clearTimeout(refreshTimer);
      destroyAll(stripStills);
      destroyAll(galleryStills);
      if (ed.refreshClips === refreshClips) ed.refreshClips = null;
    });

    // ---- what is drawn ----

    function renderHead() {
      const mode = segment([
        { id: 'once', label: 'Play once', icon: 'trending_flat' },
        { id: 'loop', label: 'Loop', icon: 'repeat' }
      ], motionOf(ed).loop ? 'loop' : 'once', (value) => {
        motionOf(ed).loop = value === 'loop';
        sceneChanged(ed);
        renderStrip();
        renderHold();
      }, 'Playback');
      const copy = S.button('Copy for Remotion', {
        icon: 'content_copy',
        small: true,
        variant: 'ghost',
        title: 'Copy these clips as props for the Reel composition in motion/',
        onClick: copyForRemotion
      });
      head.replaceChildren(h('span', 'st-label', 'Clips'), mode, copy);
    }

    function chipMeta(plan, index) {
      const clip = plan.clips[index];
      const resting = !plan.loop && index === plan.clips.length - 1;
      return `in ${secondsOf(clip.intro)} · ${resting ? 'then stays' : `idle ${secondsOf(clip.hold)}`}`;
    }

    function renderStrip() {
      destroyAll(stripStills);
      const motion = motionOf(ed);
      const plan = KlndrMotionTimeline.plan(motion);
      const selected = clipIndexOf(ed);

      const chips = motion.clips.map((clip, index) => {
        const scene = KlndrScenes.get(clip.id);
        const chip = h('button', `st-tile st-clip${index === selected ? ' is-selected' : ''}`);
        chip.type = 'button';
        chip.draggable = true;
        chip.setAttribute('role', 'radio');
        chip.setAttribute('aria-checked', String(index === selected));
        chip.setAttribute('aria-label', `Clip ${index + 1} of ${motion.clips.length}: ${scene.name}`);
        if (motion.clips.length > 1) chip.title = 'Drag, or Alt and an arrow key, to reorder';

        const art = h('span', 'st-tile-art');
        stripStills.push(clipStill(art, clip));
        const number = h('span', 'st-clip-number', String(index + 1));
        number.setAttribute('aria-hidden', 'true');
        const text = h('span', 'st-tile-text');
        text.append(h('span', 'st-tile-name', scene.name), h('span', 'st-tile-meta', chipMeta(plan, index)));
        chip.append(art, number, text);

        chip.addEventListener('click', () => pick(index));
        chip.addEventListener('keydown', (event) => {
          const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
          if (!event.altKey || !step) return;
          event.preventDefault();
          move(index, index + step);
        });

        // Reordering by drag. Where a chip lands is decided by which half of
        // the chip under the pointer it is dropped on.
        const landing = (event) => {
          const rect = chip.getBoundingClientRect();
          return event.clientX > rect.left + rect.width / 2 ? index + 1 : index;
        };
        chip.addEventListener('dragstart', (event) => {
          dragFrom = index;
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', `clip ${index + 1}`);
          chip.classList.add('is-dragging');
        });
        chip.addEventListener('dragend', () => {
          dragFrom = null;
          chip.classList.remove('is-dragging');
          clearDrop();
        });
        chip.addEventListener('dragover', (event) => {
          if (dragFrom == null) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          clearDrop();
          chip.classList.add(landing(event) > index ? 'is-drop-after' : 'is-drop-before');
        });
        chip.addEventListener('drop', (event) => {
          if (dragFrom == null) return;
          event.preventDefault();
          const from = dragFrom;
          let to = landing(event);
          if (from < to) to -= 1;
          clearDrop();
          if (from !== to) move(from, to);
        });
        return chip;
      });

      const add = h('button', 'st-tile st-clip-add');
      add.type = 'button';
      add.disabled = motion.clips.length >= MAX;
      add.title = add.disabled ? `A header plays up to ${MAX} clips` : 'Add a copy of this clip after it';
      add.append(S.icon('add'), h('span', null, 'Add clip'));
      add.addEventListener('click', addClip);

      strip.replaceChildren(...chips, add);

      const count = plan.clips.length;
      const clipsSaid = count > 1 ? `${count} clips, ` : '';
      summary.textContent = plan.loop
        ? `${clipsSaid}${secondsOf(plan.cycle)} a loop, then it starts again.`
        : `${clipsSaid}${secondsOf(plan.settle)} to play in, then ${count > 1 ? 'the last clip' : 'it'} stays.`;
    }

    function clearDrop() {
      strip.querySelectorAll('.is-drop-before, .is-drop-after')
        .forEach((node) => node.classList.remove('is-drop-before', 'is-drop-after'));
    }

    function renderTools() {
      const motion = motionOf(ed);
      const count = motion.clips.length;
      tools.hidden = count < 2;
      if (count < 2) {
        tools.replaceChildren();
        return;
      }
      const index = clipIndexOf(ed);
      const earlier = iconButton('arrow_back', 'Move this clip earlier', () => move(index, index - 1));
      earlier.disabled = index === 0;
      const later = iconButton('arrow_forward', 'Move this clip later', () => move(index, index + 1));
      later.disabled = index === count - 1;
      const remove = iconButton('delete', 'Remove this clip', () => removeClip(index));
      const actions = h('div', 'st-clip-tools-actions');
      actions.append(earlier, later, remove);
      tools.replaceChildren(
        h('span', 'st-clip-tools-title', `Editing clip ${index + 1} of ${count}`),
        actions
      );
    }

    function renderClipEditor() {
      destroyAll(galleryStills);
      const clip = clipOf(ed);
      tiles.replaceChildren(...KlndrScenes.list().map((scene) => {
        const selected = clip.id === scene.id;
        const tile = h('button', `st-tile${selected ? ' is-selected' : ''}`);
        tile.type = 'button';
        tile.title = scene.description;
        tile.dataset.scene = scene.id;
        tile.setAttribute('role', 'radio');
        tile.setAttribute('aria-checked', String(selected));

        const art = h('span', 'st-tile-art');
        galleryStills.push(clipStill(art, { id: scene.id, props: selected ? clip.props : {} }));
        const text = h('span', 'st-tile-text');
        text.append(
          h('span', 'st-tile-name', scene.name),
          h('span', 'st-tile-meta', `${secondsOf(scene.intro)} to animate in`)
        );
        tile.append(art, text);
        tile.addEventListener('click', () => swapScene(scene.id));
        return tile;
      }));
      renderProps();
      renderHold();
    }

    function renderProps() {
      const scene = KlndrScenes.get(clipOf(ed).id);
      props.replaceChildren(h('p', 'st-hint', scene.description), ...scene.schema.map((f) => sceneField(ed, f)));
    }

    function renderHold() {
      hold.replaceChildren(holdControl(ed));
    }

    function renderAll() {
      renderStrip();
      renderTools();
      renderClipEditor();
    }

    // Words, colours and idle change what a chip shows - its still, how long it
    // takes to come in - so the strip catches up once typing pauses.
    function refreshClips() {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        if (state.editor === ed && strip.isConnected) renderStrip();
      }, 250);
    }
    ed.refreshClips = refreshClips;

    // ---- what can be done ----

    function pick(index) {
      if (index !== clipIndexOf(ed)) {
        ed.clipIndex = index;
        renderAll();
        const chip = strip.children[index];
        if (chip) chip.focus({ preventScroll: true });
      }
      // The preview goes to the clip, arrived, so it shows what is being edited.
      S.preview.showClip(ed, index, 'arrived');
    }

    function addClip() {
      const motion = motionOf(ed);
      if (motion.clips.length >= MAX) return;
      const index = clipIndexOf(ed);
      motion.clips.splice(index + 1, 0, S.clone(motion.clips[index]));
      ed.clipIndex = index + 1;
      sceneChanged(ed);
      renderAll();
      const chip = strip.children[index + 1];
      if (chip) {
        chip.focus({ preventScroll: true });
        chip.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
      S.preview.showClip(ed, index + 1, 'start');
    }

    function removeClip(index) {
      const motion = motionOf(ed);
      if (motion.clips.length < 2) return;
      motion.clips.splice(index, 1);
      if (ed.clipIndex > index) ed.clipIndex -= 1;
      sceneChanged(ed);
      renderAll();
      S.preview.showClip(ed, clipIndexOf(ed), 'arrived');
    }

    function move(from, to) {
      const motion = motionOf(ed);
      if (to < 0 || to >= motion.clips.length || from === to) return;
      const selected = clipIndexOf(ed);
      const [clip] = motion.clips.splice(from, 1);
      motion.clips.splice(to, 0, clip);
      // The selection stays on the clip it was on.
      if (selected === from) ed.clipIndex = to;
      else if (from < selected && to >= selected) ed.clipIndex = selected - 1;
      else if (from > selected && to <= selected) ed.clipIndex = selected + 1;
      sceneChanged(ed);
      renderStrip();
      renderTools();
      renderHold();
      const chip = strip.children[to];
      if (chip) chip.focus({ preventScroll: true });
      S.preview.showClip(ed, clipIndexOf(ed), 'arrived');
    }

    function swapScene(sceneId) {
      const motion = motionOf(ed);
      const index = clipIndexOf(ed);
      const clip = motion.clips[index];
      if (clip.id === sceneId) return;
      motion.clips[index] = {
        id: sceneId,
        props: KlndrScenes.sanitizeProps(sceneId, carryWords(clip.props, sceneId)),
        hold: clip.hold
      };
      sceneChanged(ed);
      renderAll();
      const tile = tiles.querySelector(`[data-scene="${sceneId}"]`);
      if (tile) tile.focus({ preventScroll: true });
      if (ed.renderFraming) ed.renderFraming();
      // A new scene is best seen coming in.
      S.preview.showClip(ed, index, 'start');
    }

    async function copyForRemotion() {
      const props = {
        theme: window.KlndrTheme ? KlndrTheme.resolved() : 'light',
        tail: 3,
        scene: KlndrMotionTimeline.normalize(motionOf(ed))
      };
      try {
        await navigator.clipboard.writeText(JSON.stringify(props, null, 2));
        S.toast('Copied. Save it as a file in motion/props/, then: npm run render -- Reel --props=props/<file>.json', 'success');
      } catch (err) {
        S.toast('Could not reach the clipboard from this page.', 'error');
      }
    }

    renderHead();
    renderAll();
    pane.append(head, strip, summary, tools, tiles, props, hold);
  }

  function fileRow(ed, pane, file) {
    const row = h('div', 'st-file');
    const thumb = h('div', 'st-file-thumb');
    const mounted = KlndrAnnouncementMedia.mount(thumb, {
      ...ed.draft.media,
      url: file.url,
      poster_url: file.poster_url,
      aspect: '16:9'
    }, { thumbnail: true });
    S.onReset(pane, () => mounted.destroy());

    const facts = [
      S.MEDIA_LABELS[file.kind],
      S.fmtBytes(file.bytes),
      file.width && file.height ? `${file.width}×${file.height}` : null,
      file.duration_ms ? `${(file.duration_ms / 1000).toFixed(1)}s` : null
    ].filter(Boolean);
    const info = h('div');
    info.append(h('div', 'st-file-name', file.original_name || file.id), h('div', 'st-file-meta', facts.join(' · ')));

    const actions = h('div', 'st-file-actions');
    actions.appendChild(S.button('Remove', {
      icon: 'close',
      small: true,
      variant: 'ghost',
      onClick: () => {
        ed.lastUpload = S.clone(ed.draft.media);
        E().setMedia(ed, null);
        ed.renderMediaPane();
      }
    }));

    row.append(thumb, info, actions);
    return row;
  }

  async function uploadHeader(ed, file) {
    const row = S.uploads.uploadRow(ed.dom.uploads || h('div'), file.name);
    try {
      const media = await S.uploads.uploadFile(file, (fraction, label) => row.progress(fraction, label));
      row.done();
      ed.files.set(media.id, media);
      if (state.editor !== ed) return;
      if (ed.mediaTab !== 'upload') {
        S.toast(`${file.name} is in the library now.`, 'success');
        return;
      }
      const next = fileMedia(ed, media);
      ed.lastUpload = S.clone(next);
      E().setMedia(ed, next);
      ed.renderMediaPane();
      if (media.bytes > 8 * 1024 * 1024) {
        S.toast(`That header is ${S.fmtBytes(media.bytes)}. It works, but people on slow connections will wait for it - a smaller export is kinder.`);
      }
    } catch (err) {
      row.fail(err.message);
    }
  }

  function uploadPane(ed, pane) {
    const media = ed.draft.media;
    const file = media && media.media_id ? ed.files.get(media.media_id) : null;

    if (file) {
      pane.appendChild(fileRow(ed, pane, file));
    } else if (media && media.url) {
      pane.appendChild(S.note('info', 'link', `This header is a picture from ${media.url}. Upload a file to replace it.`));
    } else if (ed.lastUpload && ed.files.get(ed.lastUpload.media_id)) {
      const last = ed.files.get(ed.lastUpload.media_id);
      pane.appendChild(S.button(`Put back ${last.original_name || 'the last upload'}`, {
        icon: 'undo',
        small: true,
        variant: 'ghost',
        onClick: () => {
          E().setMedia(ed, S.clone(ed.lastUpload));
          ed.renderMediaPane();
        }
      }));
    }

    const uploads = h('div', 'st-uploads');
    ed.dom.uploads = uploads;
    pane.append(
      S.uploads.dropzone({
        onFile: (picked) => uploadHeader(ed, picked),
        title: file ? 'Drop a different file to replace it' : undefined
      }),
      uploads
    );
  }

  async function libraryPane(ed, pane) {
    if (!state.storage || !state.storage.configured) {
      pane.appendChild(S.storageNote());
      return;
    }
    pane.appendChild(h('p', 'an-loading', 'Opening the library…'));
    try {
      if (!state.library) state.library = await API.listMedia();
    } catch (err) {
      pane.replaceChildren(S.note('danger', 'error', err.message));
      return;
    }
    if (state.editor !== ed || ed.mediaTab !== 'library' || !pane.isConnected) return;
    if (!state.library.length) {
      pane.replaceChildren(h('p', 'st-hint', 'Nothing uploaded yet. Every file you upload, for any post, lands here to use again.'));
      return;
    }

    const tiles = h('div', 'st-tiles');
    for (const file of state.library) {
      const wrap = h('div', 'st-tile-wrap');
      const tile = h('button', 'st-tile');
      tile.type = 'button';
      tile.classList.toggle('is-selected', Boolean(ed.draft.media && ed.draft.media.media_id === file.id));

      const art = h('span', 'st-tile-art');
      const thumb = KlndrAnnouncementMedia.mount(art, {
        type: file.kind,
        url: file.url,
        poster_url: file.poster_url,
        aspect: '16:9',
        decorative: true
      }, { thumbnail: true });
      S.onReset(pane, () => thumb.destroy());

      const used = file.used_by.length ? `used by ${file.used_by.length}` : 'unused';
      const text = h('span', 'st-tile-text');
      text.append(
        h('span', 'st-tile-name', file.original_name || file.id),
        h('span', 'st-tile-meta', `${S.MEDIA_LABELS[file.kind]} · ${S.fmtBytes(file.bytes)} · ${used}`)
      );
      tile.append(art, text);
      tile.addEventListener('click', () => {
        ed.files.set(file.id, file);
        const next = fileMedia(ed, file);
        ed.lastUpload = S.clone(next);
        E().setMedia(ed, next);
        ed.mediaTab = 'upload';
        ed.renderMediaPane();
      });
      wrap.appendChild(tile);

      if (!file.used_by.length) {
        const remove = iconButton('delete', `Delete ${file.original_name || 'this file'}`, async () => {
          const ok = await S.confirmDialog({
            title: 'Delete this file?',
            body: 'No announcement uses it. It is removed from storage for good.',
            confirm: 'Delete',
            danger: true
          });
          if (!ok) return;
          try {
            await API.deleteMedia(file.id);
            state.library = state.library.filter((item) => item.id !== file.id);
            S.resetPane(pane);
            pane.replaceChildren();
            libraryPane(ed, pane);
          } catch (err) {
            S.toast(err.message, 'error');
          }
        });
        remove.classList.add('st-tile-delete');
        wrap.appendChild(remove);
      }
      tiles.appendChild(wrap);
    }
    pane.replaceChildren(tiles);
  }

  // ==========================================
  // FRAMING
  // ==========================================

  function focalPicker(ed, container, media, file) {
    media.focal = media.focal || { x: 0.5, y: 0.5 };
    const box = h('div', 'st-focal');
    box.tabIndex = 0;
    box.setAttribute('role', 'group');

    const mounted = KlndrAnnouncementMedia.mount(box, {
      type: media.type,
      url: file.url,
      poster_url: file.poster_url,
      fit: 'contain',
      aspect: '2:1',
      decorative: true
    }, { thumbnail: true });
    if (file.width && file.height) mounted.element.style.setProperty('--ann-aspect', String(file.width / file.height));
    S.onReset(container, () => mounted.destroy());

    const dot = h('span', 'st-focal-dot');
    box.appendChild(dot);

    const place = () => {
      dot.style.left = `${media.focal.x * 100}%`;
      dot.style.top = `${media.focal.y * 100}%`;
      box.setAttribute(
        'aria-label',
        `Focus point, ${Math.round(media.focal.x * 100)}% across and ${Math.round(media.focal.y * 100)}% down. Arrow keys move it.`
      );
    };
    const set = (x, y) => {
      media.focal = { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
      place();
      E().changed(ed);
    };

    box.addEventListener('click', (event) => {
      const rect = box.getBoundingClientRect();
      set((event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height);
    });
    box.addEventListener('keydown', (event) => {
      const step = event.shiftKey ? 0.1 : 0.02;
      const move = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
      if (!move) return;
      event.preventDefault();
      set(media.focal.x + move[0], media.focal.y + move[1]);
    });

    place();
    return field({
      label: 'What stays in view',
      control: box,
      hint: 'Click the part that must not be cropped away. Arrow keys work too.'
    });
  }

  function renderFraming(ed, container) {
    S.resetPane(container);
    container.replaceChildren();
    const media = ed.draft.media;
    if (!media) return;

    const isScene = media.type === 'scene';
    const file = media.media_id ? ed.files.get(media.media_id) : null;
    const fields = h('div', 'st-fields');

    const row = h('div', 'st-row');
    row.appendChild(field({
      label: 'Shape',
      id: 'stAspect',
      control: select(Object.keys(Rules.ASPECTS).map((key) => [key, S.ASPECT_LABELS[key]]), media.aspect, (value) => {
        media.aspect = value;
        E().changed(ed);
      })
    }));
    if (!isScene) {
      row.appendChild(field({
        label: 'Fit',
        id: 'stFit',
        control: select([['cover', 'Fill the shape (crops)'], ['contain', 'Show all of it']], media.fit, (value) => {
          media.fit = value;
          E().changed(ed);
          renderFraming(ed, container);
        })
      }));
    }
    fields.appendChild(row);

    if (!isScene && media.fit === 'contain') {
      fields.appendChild(field({
        label: 'Behind it',
        control: swatches({ label: 'Background', optional: true }, media.background || '', (value) => {
          media.background = value || null;
          E().changed(ed);
        })
      }));
    }

    if (file && ['image', 'animated_image', 'video'].includes(media.type) && media.fit !== 'contain') {
      fields.appendChild(focalPicker(ed, container, media, file));
    }

    if (media.type === 'video') {
      fields.appendChild(checkbox('This clip has sound', media.has_audio, (on) => {
        media.has_audio = on;
        E().changed(ed);
      }, 'It always starts muted. People get a button to turn the sound on.'));
    }

    const alt = h('input', 'st-input');
    alt.type = 'text';
    alt.maxLength = 200;
    alt.value = media.alt || '';
    alt.placeholder = isScene ? KlndrMotionTimeline.describe(media.scene) : 'Describe what it shows';
    alt.disabled = Boolean(media.decorative);
    alt.addEventListener('input', () => {
      media.alt = alt.value;
      E().changed(ed);
    });
    ed.dom.alt = alt;

    fields.append(
      field({
        label: 'Alt text',
        id: 'stAlt',
        control: alt,
        counter: counterFor(alt, 200),
        hint: isScene
          ? "Leave it empty and the scene's own words are read out."
          : 'What someone who cannot see it should know.'
      }),
      checkbox('It is decorative', media.decorative, (on) => {
        media.decorative = on;
        alt.disabled = on;
        E().changed(ed);
      }, 'Screen readers skip it.')
    );
    container.appendChild(fields);
  }

  // ==========================================
  // THE SECTION
  // ==========================================

  function mediaSection(ed) {
    const { box, body } = section('media', 'Header', 'The picture, clip or animation across the top.');
    const pane = h('div', 'st-fields');
    const framing = h('div');

    const renderPane = () => {
      S.resetPane(pane);
      pane.replaceChildren();
      if (ed.mediaTab === 'scene') scenePane(ed, pane);
      else if (ed.mediaTab === 'upload') uploadPane(ed, pane);
      else if (ed.mediaTab === 'library') libraryPane(ed, pane);
      else {
        if (ed.draft.media) E().setMedia(ed, null);
        pane.appendChild(h('p', 'st-hint', 'No header. The post opens with its kind and title.'));
      }
    };

    const tabs = segment([
      { id: 'scene', label: 'Motion scene', icon: 'animated_images' },
      { id: 'upload', label: 'Upload', icon: 'upload' },
      { id: 'library', label: 'Library', icon: 'photo_library' },
      { id: 'none', label: 'None', icon: 'hide_image' }
    ], ed.mediaTab, (tab) => {
      ed.mediaTab = tab;
      renderPane();
    }, 'Header');

    ed.renderMediaPane = () => {
      tabs.sync(ed.mediaTab);
      renderPane();
    };
    ed.renderFraming = () => renderFraming(ed, framing);

    body.append(tabs, pane, framing);
    renderPane();
    ed.renderFraming();
    ed.cleanups.push(() => {
      S.resetPane(pane);
      S.resetPane(framing);
    });

    // A file pasted anywhere outside a text field becomes the header.
    const onPaste = (event) => {
      if (state.editor !== ed) return;
      const target = event.target;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      const file = event.clipboardData && event.clipboardData.files[0];
      if (!file) return;
      event.preventDefault();
      ed.mediaTab = 'upload';
      ed.renderMediaPane();
      uploadHeader(ed, file);
    };
    document.addEventListener('paste', onPaste);
    ed.cleanups.push(() => document.removeEventListener('paste', onPaste));

    return box;
  }

  S.sections = Object.assign(S.sections || {}, { media: mediaSection });
})();
