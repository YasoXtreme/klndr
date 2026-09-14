// Klndr Announcement Reader
//
// Builds one announcement the way a person reads it: the header, what kind of
// news it is and when, the words, the button and the reactions. The app's
// reader, its stories and the Studio's preview all call this - which is what
// makes the preview honest.
//
// It builds DOM and wires callbacks, and that is all. Where the result is put,
// and what a click means, are the caller's business.

const KlndrAnnouncementReader = (() => {
  const Rules = KlndrAnnouncementRules;

  const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const relativeFormat = typeof Intl.RelativeTimeFormat === 'function'
    ? new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
    : null;

  function h(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function icon(name) {
    const glyph = h('span', 'material-symbols-outlined', name);
    glyph.setAttribute('aria-hidden', 'true');
    return glyph;
  }

  function formatDate(seconds) {
    return seconds ? dateFormat.format(new Date(seconds * 1000)) : '';
  }

  /** "3 days ago", becoming a plain date once it is more than a month old. */
  function formatAgo(seconds, now = Date.now() / 1000) {
    if (!seconds) return '';
    const diff = seconds - now;
    const abs = Math.abs(diff);
    if (!relativeFormat || abs > 30 * 86400) return formatDate(seconds);
    if (abs < 60) return 'just now';
    if (abs < 3600) return relativeFormat.format(Math.round(diff / 60), 'minute');
    if (abs < 86400) return relativeFormat.format(Math.round(diff / 3600), 'hour');
    return relativeFormat.format(Math.round(diff / 86400), 'day');
  }

  function kindChip(kindId) {
    const kind = Rules.kind(kindId);
    const chip = h('span', 'ann-kind');
    chip.dataset.kind = kind.id;
    chip.append(icon(kind.icon), document.createTextNode(kind.label));
    return chip;
  }

  function reactionBar(announcement, onReact) {
    const bar = h('div', 'ann-reactions');
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'Reactions');
    const parts = new Map();

    for (const reaction of Rules.REACTIONS) {
      const button = h('button', 'ann-reaction');
      button.type = 'button';
      button.dataset.reaction = reaction.id;
      const emoji = h('span', 'ann-reaction-emoji', reaction.emoji);
      emoji.setAttribute('aria-hidden', 'true');
      const count = h('span', 'ann-reaction-count');
      button.append(emoji, count);
      button.addEventListener('click', () => {
        if (onReact) onReact(reaction.id);
      });
      parts.set(reaction.id, { button, count, label: reaction.label });
      bar.appendChild(button);
    }

    function update(mine, counts) {
      for (const [id, part] of parts) {
        const n = (counts && counts[id]) || 0;
        const isMine = mine === id;
        part.button.classList.toggle('is-mine', isMine);
        part.button.setAttribute('aria-pressed', String(isMine));
        part.button.setAttribute('aria-label', n ? `${part.label}, ${n}` : part.label);
        part.count.textContent = n ? String(n) : '';
      }
    }

    update(announcement.reaction, announcement.reactions);
    return { element: bar, update };
  }

  function ctaButton(a, onCta) {
    const { label, url, app_action: action } = a.cta || {};
    const href = url ? KlndrMarkdown.safeHref(url) : null;
    if (!label || (!href && !action)) return null;

    const button = href ? h('a', 'ann-btn ann-btn-primary') : h('button', 'ann-btn ann-btn-primary');
    if (href) {
      button.href = href;
      button.target = '_blank';
      button.rel = 'noopener noreferrer';
    } else {
      button.type = 'button';
    }
    button.append(document.createTextNode(label), icon(href ? 'arrow_outward' : 'arrow_forward'));
    button.addEventListener('click', (event) => {
      if (onCta) onCta(a, event);
    });
    return button;
  }

  /**
   * options:
   *   mode      'reader' | 'story' | 'preview' - a class, for the stylesheet
   *   autoplay  whether the header may play (reduced motion still wins)
   *   onReact   (reactionId) => void
   *   onCta     (announcement, event) => void, before a link opens
   *   now       seconds, for "Updated 2 hours ago"
   *
   * Returns { element, titleId, setReactions, destroy }.
   */
  function render(announcement, options = {}) {
    const a = announcement;
    const article = h('article', `ann-reader is-${options.mode || 'reader'}`);
    article.dataset.kind = a.kind;
    const cleanups = [];

    let media = null;
    if (a.media) {
      const hero = h('div', 'ann-reader-hero');
      article.appendChild(hero);
      media = KlndrAnnouncementMedia.mount(hero, a.media, {
        autoplay: options.autoplay !== false,
        ...(options.mediaOptions || {})
      });
      cleanups.push(() => media.destroy());
    }

    const body = h('div', 'ann-reader-body');
    const meta = h('div', 'ann-reader-meta');
    meta.appendChild(kindChip(a.kind));
    if (a.pinned) {
      const pinned = h('span', 'ann-flag');
      pinned.append(icon('keep'), document.createTextNode('Pinned'));
      meta.appendChild(pinned);
    }
    if (a.publish_at) {
      const time = h('time', 'ann-reader-date', formatDate(a.publish_at));
      time.dateTime = new Date(a.publish_at * 1000).toISOString();
      meta.appendChild(time);
    }
    if (a.updated_at) {
      meta.appendChild(h('span', 'ann-flag is-updated', `Updated ${formatAgo(a.updated_at, options.now)}`));
    }
    body.appendChild(meta);

    const title = h('h2', 'ann-reader-title', a.title || 'Untitled');
    title.id = `annTitle-${a.id}-${Math.random().toString(36).slice(2, 7)}`;
    body.appendChild(title);

    if (a.summary) body.appendChild(h('p', 'ann-reader-summary', a.summary));

    if (a.body) {
      const content = h('div', `ann-md${a.body_format === 'legacy' ? ' is-legacy' : ''}`);
      content.innerHTML = KlndrMarkdown.render(a.body, { format: a.body_format });
      body.appendChild(content);
    }

    const cta = ctaButton(a, options.onCta);
    if (cta) {
      const actions = h('div', 'ann-reader-actions');
      actions.appendChild(cta);
      body.appendChild(actions);
    }

    let reactions = null;
    if (a.reactions_enabled) {
      reactions = reactionBar(a, options.onReact);
      body.appendChild(reactions.element);
    }

    article.appendChild(body);

    return {
      element: article,
      titleId: title.id,
      // The mounted header, so a caller can reach its motion player.
      media,
      setReactions(mine, counts) {
        if (reactions) reactions.update(mine, counts);
      },
      destroy() {
        cleanups.splice(0).forEach((fn) => fn());
        article.remove();
      }
    };
  }

  return { render, kindChip, formatDate, formatAgo };
})();
