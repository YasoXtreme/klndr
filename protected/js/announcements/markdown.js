// Klndr Markdown
//
// The formatting an announcement body can use, rendered to HTML that is safe to
// hand to innerHTML.
//
// Safe by construction rather than by cleaning up afterwards: text is escaped
// before it reaches the output, and every tag in the output is one this file
// wrote. Links and images are the only way a URL reaches an attribute, and each
// has its own allow-list of schemes.
//
// Two formats. `md` is a small, forgiving subset of Markdown. `legacy` is the
// three rules the old announcement box understood - *bold*, _italic_ and
// "* item" lists - reproduced exactly, so posts written back then still read the
// way they were written.
//
// Browser global and CommonJS module, like palette.js, so the tests can reach it.

const KlndrMarkdown = (() => {
  // Placeholders for finished HTML while the rest of a line is still being
  // formatted. Private-use characters, stripped from the input first, so no
  // text can forge one.
  const OPEN = '\uE000';
  const CLOSE = '\uE001';
  const PLACEHOLDER = /\uE000(\d+)\uE001/g;

  const CALLOUTS = {
    NOTE: ['note', 'Note'],
    TIP: ['tip', 'Tip'],
    IMPORTANT: ['important', 'Important'],
    WARNING: ['warning', 'Heads-up'],
    CAUTION: ['warning', 'Heads-up']
  };

  const LIST_ITEM = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
  const FENCE = /^\s*(```|~~~)/;
  const HEADING = /^(#{1,3})\s+(.+?)\s*#*\s*$/;
  const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
  const QUOTE = /^\s*>/;
  const FIGURE = /^!\[([^\]\n]*)\]\(([^)\s]+)\)$/;

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function hasControlCharacters(text) {
    for (const ch of text) {
      const code = ch.charCodeAt(0);
      if (code < 32 || code === 127) return true;
    }
    return false;
  }

  function safeHref(raw) {
    const url = String(raw || '').trim();
    if (!url || hasControlCharacters(url)) return null;
    if (/^mailto:[^\s@]+@[^\s@]+$/i.test(url)) return url;
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
    } catch {
      return null;
    }
  }

  // Images are https, or the app's own signed media route for a private bucket.
  // Plain http would be mixed content, and anything else could be a script.
  function safeImageSrc(raw) {
    const url = String(raw || '').trim();
    if (/^\/media\/[A-Za-z0-9._\-/]+$/.test(url) && !url.includes('..')) return url;
    if (!url || hasControlCharacters(url)) return null;
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:' ? parsed.href : null;
    } catch {
      return null;
    }
  }

  function imageTag(alt, src) {
    return `<img class="ann-md-img" src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="lazy" decoding="async">`;
  }

  /**
   * One line of text, formatted.
   *
   * Code, keycaps, images and links are lifted out as finished HTML first, so
   * emphasis can never reach inside them. What is left is escaped, emphasised,
   * and the lifted pieces are put back.
   */
  function inline(raw, { links = true } = {}) {
    const stash = [];
    const keep = (html) => `${OPEN}${stash.push(html) - 1}${CLOSE}`;

    let text = String(raw)
      .replace(/[\uE000\uE001]/g, '')
      .replace(/`([^`\n]+)`/g, (_, code) => keep(`<code class="ann-md-inline-code">${escapeHtml(code)}</code>`))
      .replace(/\[\[([^\]\n]{1,24})\]\]/g, (_, key) => keep(`<kbd class="ann-md-kbd">${escapeHtml(key.trim())}</kbd>`))
      .replace(/!\[([^\]\n]*)\]\(([^)\s]+)\)/g, (match, alt, url) => {
        const src = safeImageSrc(url);
        return src ? keep(imageTag(alt, src)) : match;
      });

    if (links) {
      text = text
        .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (match, label, url) => {
          const href = safeHref(url);
          if (!href) return label;
          return keep(
            `<a class="ann-md-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${inline(label, { links: false })}</a>`
          );
        })
        .replace(/(^|[\s(])(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g, (match, lead, url) => {
          const href = safeHref(url);
          if (!href) return match;
          return lead + keep(
            `<a class="ann-md-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`
          );
        });
    }

    let html = escapeHtml(text)
      .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
      .replace(/__(?=\S)([\s\S]*?\S)__/g, '<strong>$1</strong>')
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>')
      .replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?![\w*])/g, '$1<em>$2</em>')
      .replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?!\w)/g, '$1<em>$2</em>');

    // A link's label was formatted with its own stash, so restoring is one pass
    // at this level - but do it until nothing is left, rather than trust that.
    while (PLACEHOLDER.test(html)) {
      html = html.replace(PLACEHOLDER, (_, i) => stash[Number(i)]);
    }
    return html;
  }

  function inlineLines(text) {
    return String(text).split('\n').map((line) => inline(line.trim())).join('<br>');
  }

  function startsBlock(line) {
    return FENCE.test(line) || HEADING.test(line) || RULE.test(line) ||
      QUOTE.test(line) || LIST_ITEM.test(line) || FIGURE.test(line.trim());
  }

  function renderList(lines, start) {
    const first = lines[start].match(LIST_ITEM);
    const ordered = /\d/.test(first[2]);
    const items = [];
    let i = start;

    while (i < lines.length) {
      const match = lines[i].match(LIST_ITEM);
      if (match && /\d/.test(match[2]) === ordered) {
        items.push(match[3]);
        i += 1;
      } else if (items.length && !match && /^\s{2,}\S/.test(lines[i])) {
        // An indented line straight under an item carries on that item.
        items[items.length - 1] += `\n${lines[i].trim()}`;
        i += 1;
      } else {
        break;
      }
    }

    const checks = items.map((item) => item.match(/^\[( |x|X)\]\s+([\s\S]*)$/));
    const isChecklist = !ordered && checks.every(Boolean);
    const body = items.map((item, index) => {
      const check = checks[index];
      if (check) {
        const done = check[1] !== ' ';
        return `<li class="ann-md-check${done ? ' is-done' : ''}"><span class="ann-md-box" role="img" aria-label="${done ? 'Done' : 'Not done'}"></span><span>${inlineLines(check[2])}</span></li>`;
      }
      return `<li>${inlineLines(item)}</li>`;
    }).join('');

    const tag = ordered ? 'ol' : 'ul';
    const number = parseInt(first[2], 10);
    const startAttr = ordered && number !== 1 ? ` start="${number}"` : '';
    const className = `ann-md-list${isChecklist ? ' is-checklist' : ''}`;
    return { html: `<${tag} class="${className}"${startAttr}>${body}</${tag}>`, next: i };
  }

  function renderBlocks(lines) {
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      if (!line.trim()) {
        i += 1;
        continue;
      }

      const fence = line.match(FENCE);
      if (fence) {
        const code = [];
        i += 1;
        while (i < lines.length && !lines[i].trim().startsWith(fence[1])) {
          code.push(lines[i]);
          i += 1;
        }
        i += 1;
        out.push(`<pre class="ann-md-code"><code>${escapeHtml(code.join('\n'))}</code></pre>`);
        continue;
      }

      const heading = line.match(HEADING);
      if (heading) {
        // The post's own title is the h2, so the body's headings start below it.
        const level = heading[1].length + 2;
        out.push(`<h${level} class="ann-md-heading">${inline(heading[2])}</h${level}>`);
        i += 1;
        continue;
      }

      if (RULE.test(line)) {
        out.push('<hr class="ann-md-rule">');
        i += 1;
        continue;
      }

      if (QUOTE.test(line)) {
        const quoted = [];
        while (i < lines.length && QUOTE.test(lines[i])) {
          quoted.push(lines[i].replace(/^\s*>\s?/, ''));
          i += 1;
        }
        const marker = quoted[0].match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i);
        if (marker) {
          const [kind, title] = CALLOUTS[marker[1].toUpperCase()];
          const rest = marker[2].trim() ? [marker[2], ...quoted.slice(1)] : quoted.slice(1);
          out.push(
            `<aside class="ann-md-callout" data-callout="${kind}"><p class="ann-md-callout-title">${title}</p>${renderBlocks(rest)}</aside>`
          );
        } else {
          out.push(`<blockquote class="ann-md-quote">${renderBlocks(quoted)}</blockquote>`);
        }
        continue;
      }

      if (LIST_ITEM.test(line)) {
        const list = renderList(lines, i);
        out.push(list.html);
        i = list.next;
        continue;
      }

      const figure = line.trim().match(FIGURE);
      if (figure) {
        const src = safeImageSrc(figure[2]);
        if (src) {
          out.push(`<figure class="ann-md-figure">${imageTag(figure[1], src)}</figure>`);
          i += 1;
          continue;
        }
      }

      const paragraph = [line];
      i += 1;
      while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) {
        paragraph.push(lines[i]);
        i += 1;
      }
      out.push(`<p class="ann-md-p">${paragraph.map((l) => inline(l.trim())).join('<br>')}</p>`);
    }

    return out.join('');
  }

  // ---- legacy ----------------------------------------------------------------

  // The old app.js renderer, kept byte for byte - including its escaping, which
  // did not touch apostrophes. test/announcements.test.js compares the two.
  function renderLegacy(rawText) {
    if (!rawText) return '';

    const escaped = String(rawText)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
    const lines = escaped.split(/\r?\n/);
    const result = [];
    let inList = false;

    const formatInline = (str) => str
      .replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>')
      .replace(/_([^_\n]+)_/g, '<em>$1</em>');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const listMatch = line.match(/^(\s*)\*\s+(.+)$/);

      if (listMatch) {
        if (!inList) {
          inList = true;
          result.push('<ul class="announcement-ul">');
        }
        result.push(`<li>${formatInline(listMatch[2])}</li>`);
      } else {
        if (inList) {
          inList = false;
          result.push('</ul>');
        }
        if (line.trim() === '') {
          result.push('<div class="announcement-spacer"></div>');
        } else {
          result.push(`<p class="announcement-p">${formatInline(line)}</p>`);
        }
      }
    }

    if (inList) {
      result.push('</ul>');
    }

    return result.join('');
  }

  /**
   * A legacy body rewritten as `md`, for when the Studio opens an old post.
   * "* item" becomes "- item" and *bold* becomes **bold**; _italic_ already
   * means the same thing in both.
   */
  function convertLegacy(text) {
    return String(text || '')
      .split(/\r?\n/)
      .map((line) => {
        const item = line.match(/^(\s*)\*\s+(.+)$/);
        const bolded = (item ? item[2] : line).replace(/\*([^*\n]+)\*/g, '**$1**');
        return item ? `${item[1]}- ${bolded}` : bolded;
      })
      .join('\n');
  }

  // ---- public ------------------------------------------------------------------

  function render(text, { format = 'md' } = {}) {
    if (format === 'legacy') return renderLegacy(text);
    return renderBlocks(String(text || '').replace(/\r\n?/g, '\n').split('\n'));
  }

  /** The body with its formatting taken out, for an excerpt. */
  function toPlainText(text, { format = 'md', max = 160 } = {}) {
    let plain = String(text || '');
    if (format === 'legacy') {
      plain = plain
        .replace(/^\s*\*\s+/gm, '')
        .replace(/\*([^*\n]+)\*/g, '$1')
        .replace(/_([^_\n]+)_/g, '$1');
    } else {
      plain = plain
        .replace(/(```|~~~)[\s\S]*?(\1|$)/g, ' ')
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[\[([^\]]+)\]\]/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/^\s*>\s?\[![A-Za-z]+\]\s*/gm, '')
        .replace(/^\s*(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
        .replace(/^\s*\[( |x|X)\]\s+/gm, '')
        .replace(/(\*\*|__|~~|`)/g, '')
        .replace(/(^|\W)[*_](\S[^*_]*)[*_](?=\W|$)/g, '$1$2');
    }
    plain = plain.replace(/\s+/g, ' ').trim();
    return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
  }

  return { render, renderLegacy, convertLegacy, toPlainText, escapeHtml, safeHref, safeImageSrc };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = KlndrMarkdown;
