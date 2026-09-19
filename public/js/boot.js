/**
 * The boot overlay: the klndr logo, standing in for a page while it loads, and
 * carrying you from one page to the next.
 *
 * server/pages.js inlines this as the first thing in <body> on the app and on
 * admin, with boot.css in the <head>, so the logo is part of the page's first
 * painted frame rather than something that arrives later. <body data-boot>
 * says which page it is on: "app" or "admin".
 *
 * What a page can tell it:
 *
 *   ready({ after, cap })     the page is on screen. The logo flies into the
 *                             page's own brand ([data-boot-brand]) and the
 *                             overlay goes. `after` is a promise worth waiting
 *                             a little longer for, but never more than `cap` ms.
 *   fail(err)                 it never will be. The failure card, with a retry.
 *   leave(url, { variant })   go to another page, and let the logo carry you
 *                             there. It lifts off this page's brand while the
 *                             ground comes up, turns into the destination's -
 *                             the shield and the tag, for admin - and the next
 *                             page's overlay carries on from the very frame
 *                             this one stopped on. Navigation starts at once:
 *                             the animation never adds a moment to the trip.
 *   guard(fn)                 while fn() returns true, leave() goes plainly,
 *                             so a page with unsaved work keeps its own prompt.
 *
 * A link with data-boot-leave="app" or "admin" leaves on its own when clicked.
 *
 * Every deadline lives here:
 *
 *   a normal load      the plate lands and the wordmark sweeps out (0.42s)
 *   after signing in   the kit's full entrance, tagline and all (0.92s)
 *   admin              then the plate turns over to a shield and the admin
 *                      tag pops out (0.74s)
 *   arriving           the rest of the trip the last page started
 *   still waiting      the plate presses into its slab now and then
 *   over 2.5s          a line under it, because a cold start reads as broken
 *   over 12s           the failure card (10s while leaving, with "Stay here")
 *
 * A page that is ready sooner never waits for more than that: the logo sets
 * off for home the moment it has landed.
 *
 * The pure parts come first and are exported to node:test; everything that
 * touches the DOM only runs in a browser.
 */
(function () {
  'use strict';

  // Written by the login page and by leave(), read once by the next page's
  // overlay, then cleared.
  const HANDOFF_KEY = 'klndr:boot';
  // What the login page wrote before this file existed.
  const LEGACY_HERO_KEY = 'klndr_boot_hero';
  // A handoff older than this was not for this load.
  const HANDOFF_MAX_AGE = 10000;

  // Every duration the overlay has, in ms. boot.css takes the entrance's from
  // custom properties set out of this table, so the clock below and the
  // animations cannot disagree about when the logo has landed.
  const TIMING = {
    fontCap: 600,
    normal: { plate: 300, wordDelay: 100, word: 320 },
    // The kit's own entrance (brand/klndr-logo-animation.html).
    hero: { plate: 360, wordDelay: 240, word: 420, taglineDelay: 620, tagline: 300 },
    // The admin beat starts just before the wordmark lands.
    admin: { flipLead: 60, flip: 380, tagAfter: 120, tag: 200 },
    // Leaving: the logo lifts off the brand while the ground comes up; the
    // admin tag, when it is being left behind, shrinks away where it stood.
    rise: 260,
    riseGround: 180,
    retract: 140,
    leaveGiveUp: 10000,
    idleAfter: 400,
    idleEvery: 1400,
    slow: 2500,
    giveUp: 12000,
    iconCap: 1500,
    flight: 420,
    groundDelay: 60,
    ground: 260,
    slab: 200,
    taglineOut: 140,
    swap: 80,
    noTarget: 180,
    reduced: 150
  };

  const EASE_FLY = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
  const EASE_POP = 'cubic-bezier(0.34, 1.56, 0.64, 1)';

  /**
   * The trip between pages, measured from the click: when each part starts,
   * and when it has all landed (`end`). Toward admin the plate turns over and
   * the tag pops out once the logo has risen; away from it, the tag shrinks
   * away as the logo rises.
   */
  function leaveTimeline(variant, fromAdmin) {
    const t = {
      rise: TIMING.rise,
      ground: TIMING.riseGround,
      flipDelay: 0,
      flip: 0,
      tagDelay: 0,
      tag: 0,
      retract: 0
    };
    if (variant === 'admin' && !fromAdmin) {
      t.flipDelay = t.rise;
      t.flip = TIMING.admin.flip;
      t.tagDelay = t.rise + TIMING.admin.tagAfter;
      t.tag = TIMING.admin.tag;
    }
    if (variant === 'app' && fromAdmin) t.retract = TIMING.retract;
    t.end = Math.max(t.rise, t.flipDelay + t.flip, t.tagDelay + t.tag, t.retract);
    return t;
  }

  /**
   * When each part of the entrance starts and ends, and when the whole of it
   * has landed (`settle`), for a kind of load on a kind of page. A page that
   * was left for this one (`carry`) has only the rest of that trip to play.
   */
  function schedule(kind, variant, reduced, carry) {
    const plan = {
      plate: 0,
      wordDelay: 0,
      word: 0,
      taglineDelay: 0,
      tagline: 0,
      flipDelay: 0,
      flip: 0,
      tagDelay: 0,
      tag: 0
    };
    if (kind === 'leave') {
      const left = Math.max(0, leaveTimeline(variant, carry.fromAdmin).end - carry.offset);
      plan.settle = reduced ? TIMING.reduced : left;
      plan.idleDelay = left + TIMING.idleAfter;
      return plan;
    }
    const base = kind === 'hero' ? TIMING.hero : TIMING.normal;
    Object.assign(plan, {
      plate: base.plate,
      wordDelay: base.wordDelay,
      word: base.word,
      taglineDelay: base.taglineDelay || 0,
      tagline: base.tagline || 0
    });
    let landed = Math.max(plan.plate, plan.wordDelay + plan.word);
    if (kind === 'hero') landed = Math.max(landed, plan.taglineDelay + plan.tagline);
    if (variant === 'admin' && kind !== 'hero') {
      plan.flipDelay = landed - TIMING.admin.flipLead;
      plan.flip = TIMING.admin.flip;
      plan.tagDelay = plan.flipDelay + TIMING.admin.tagAfter;
      plan.tag = TIMING.admin.tag;
      landed = Math.max(plan.flipDelay + plan.flip, plan.tagDelay + plan.tag);
    }
    plan.settle = reduced ? TIMING.reduced : landed;
    plan.idleDelay = landed + TIMING.idleAfter;
    return plan;
  }

  /**
   * How far into the trip the page being left had got when it stopped
   * drawing. It draws until this page's response starts to arrive; after that
   * the browser holds its last frame on screen until this page paints. So this
   * page carries on from that frame rather than from "now", and the trip reads
   * as one motion however long the server took.
   */
  function resumeOffset(at, timeOrigin, responseStart) {
    const commit = responseStart > 0 ? timeOrigin + responseStart : timeOrigin;
    return Math.min(HANDOFF_MAX_AGE, Math.max(0, commit - at));
  }

  /** Whether a page at `pathname` is the one a handoff was addressed `to`. */
  function isDestination(pathname, to) {
    if (typeof to !== 'string' || !to) return false;
    if (to === '/') return pathname === '/';
    const base = to.replace(/\/+$/, '');
    return pathname === base || pathname.indexOf(base + '/') === 0;
  }

  function rect(value) {
    if (!value || typeof value !== 'object') return null;
    const keys = ['left', 'top', 'width', 'height'];
    if (!keys.every((key) => typeof value[key] === 'number' && isFinite(value[key]))) return null;
    if (value.width <= 0 || value.height <= 0) return null;
    return { left: value.left, top: value.top, width: value.width, height: value.height };
  }

  /**
   * What the previous page left for this one, or null. `raw` is the stored
   * JSON; `legacyHero` is the old login page's flag.
   */
  function parseHandoff(raw, legacyHero, where) {
    let data = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch (err) {
      data = null;
    }
    if (data && data.v === 1 && typeof data.at === 'number') {
      const age = where.now - data.at;
      if (age >= -1000 && age <= HANDOFF_MAX_AGE && isDestination(where.pathname, data.to)) {
        if (data.kind === 'hero') return { kind: 'hero' };
        if (data.kind === 'leave') {
          const r = data.rects || {};
          const plate = rect(r.plate);
          const word = rect(r.word);
          return {
            kind: 'leave',
            at: data.at,
            fromAdmin: Boolean(data.fromAdmin),
            rects: plate && word ? { plate, word, tag: rect(r.tag) } : null
          };
        }
      }
    }
    return legacyHero && where.pathname === '/' ? { kind: 'hero' } : null;
  }

  /**
   * How to move a part so that the element measured inside it lands on its
   * target: rects in page coordinates, the result as a translate-then-scale
   * about the measured element's own top-left corner.
   */
  function flipTransform(part, measured, target, byWidth) {
    const s = byWidth ? target.width / measured.width : target.height / measured.height;
    return {
      originX: measured.left - part.left,
      originY: measured.top - part.top,
      x: target.left - measured.left,
      y: target.top - measured.top,
      s
    };
  }

  const pure = {
    TIMING,
    HANDOFF_KEY,
    schedule,
    leaveTimeline,
    resumeOffset,
    isDestination,
    parseHandoff,
    flipTransform
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = pure;
    return;
  }

  // start() runs at the very end of this file, once every constant below it
  // exists.

  // ==========================================
  // THE OVERLAY
  // ==========================================

  function start() {
    const html = document.documentElement;
    const body = document.body;
    const variant = body.getAttribute('data-boot') === 'admin' ? 'admin' : 'app';
    const reduced = Boolean(
      window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
    const handoff = readHandoff();
    const kind = handoff ? handoff.kind : 'normal';
    const navigation = performance.getEntriesByType ? performance.getEntriesByType('navigation')[0] : null;
    const carry =
      kind === 'leave'
        ? {
            fromAdmin: handoff.fromAdmin,
            rects: handoff.rects,
            offset: resumeOffset(handoff.at, performance.timeOrigin || 0, navigation ? navigation.responseStart : 0)
          }
        : null;
    const plan = schedule(kind, variant, reduced, carry);

    // The overlay goes in before the page is hidden behind it, so nothing that
    // fails on the way can leave a page hidden with no logo in front of it.
    const root = build(variant, kind, plan);
    body.insertBefore(root, body.firstChild);
    html.classList.add('kb-busy');
    const $ = (selector) => root.querySelector(selector);

    const timers = [];
    const guards = new Set();
    let litAt = 0;
    let failed = false;
    let done = null;
    let booted = false;
    let leaving = null;

    // Carried in from the page before: the ground is already part way up.
    if (carry) groundUp(root, carry.offset);

    const whenLit = new Promise((resolve) => {
      const light = () => {
        if (litAt) return;
        litAt = performance.now();
        // Measured now, with ElmsSans in, so the wordmark's box is the real one.
        if (carry) liftOff(root, variant, carry.rects, carry.fromAdmin, carry.offset);
        root.classList.add('kb-lit');
        resolve();
      };
      // The lockup is ElmsSans Black. Shown before the face is in, it would be
      // an Arial k for a frame; waiting is free, because the ground is up - and
      // arriving from another page, the browser is still showing that page's
      // last frame, which is this one's first.
      const fonts = document.fonts;
      if (!fonts || !fonts.load || fonts.check('900 1em ElmsSans')) {
        light();
      } else {
        race(fonts.load('900 1em ElmsSans').catch(() => {}), TIMING.fontCap).then(light);
      }
    });

    timers.push(
      setTimeout(() => {
        if (!done && !failed) root.classList.add('kb-slow');
      }, TIMING.slow)
    );
    timers.push(
      setTimeout(() => fail(new Error('The server is taking longer than it should.')), TIMING.giveUp)
    );

    $('.btn-boot-retry').addEventListener('click', () => window.location.reload());
    document.addEventListener('click', onLeaveLink);
    window.addEventListener('pageshow', onPageShow);

    /** Resolves once the entrance has landed, however long ago it was lit. */
    function landed() {
      return whenLit.then(() => wait(Math.max(0, litAt + plan.settle - performance.now())));
    }

    function ready(options) {
      if (done) return done;
      timers.forEach(clearTimeout);
      const opts = options || {};
      const cap = opts.cap == null ? 1500 : opts.cap;
      const after = opts.after ? race(Promise.resolve(opts.after).catch(() => {}), cap) : null;
      done = Promise.all([landed(), after, iconsReady()])
        .then(() => frames(2))
        .then(exit);
      return done;
    }

    function fail(err) {
      if (done || failed) return;
      failed = true;
      timers.forEach(clearTimeout);
      $('.kb-reason').textContent = (err && err.message) || 'Something went wrong on the way in.';
      root.classList.remove('kb-lit', 'kb-slow');
      root.classList.add('kb-failed');
    }

    // ---- Home: the logo into the page's brand ----

    function exit() {
      root.classList.add('kb-leaving');
      root.style.pointerEvents = 'none';
      const brand = failed || reduced ? null : findBrand();
      const finish = () => {
        if (brand) brand.classList.remove('kb-brand-hidden');
        if (root.parentNode) root.parentNode.removeChild(root);
        booted = true;
      };
      if (brand) brand.classList.add('kb-brand-hidden');
      html.classList.remove('kb-busy');

      if (!root.animate) {
        finish();
        return Promise.resolve();
      }
      if (reduced || failed) {
        return root.animate([{ opacity: 1 }, { opacity: 0 }], { duration: TIMING.reduced, fill: 'forwards' })
          .finished.then(finish);
      }
      const flight = brand && flightPlan(brand);
      if (!flight) {
        $('.kb-stage').animate(
          [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.9)' }],
          { duration: TIMING.noTarget, easing: 'ease-in', fill: 'forwards' }
        );
        return fadeGround().finished.then(finish);
      }
      return (kind === 'hero' ? fadeTagline() : Promise.resolve()).then(() => fly(flight, brand, finish));
    }

    function fadeGround() {
      $('.kb-note').animate([{ opacity: getComputedStyle($('.kb-note')).opacity }, { opacity: 0 }], {
        duration: 120,
        fill: 'forwards'
      });
      return $('.kb-ground').animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: TIMING.ground,
        delay: TIMING.groundDelay,
        easing: 'ease-out',
        fill: 'forwards'
      });
    }

    function fadeTagline() {
      return $('.kb-tagline')
        .animate([{ opacity: 1 }, { opacity: 0 }], { duration: TIMING.taglineOut, fill: 'forwards' })
        .finished;
    }

    /** Each part of the logo and the part of the page's brand it lands on. */
    function flightPlan(brand) {
      const parts = [
        { el: $('.kb-plate'), measure: $('.kb-plate'), target: brand.querySelector('.klndr-plate'), byWidth: true },
        { el: $('.kb-word'), measure: $('.kb-word-in'), target: brand.querySelector('.klndr-wordmark') }
      ];
      if (variant === 'admin') {
        parts.push({ el: $('.kb-tag'), measure: $('.kb-tag-in'), target: brand.querySelector('.adm-tag') });
      }
      if (parts.some((part) => !part.target)) return null;
      return parts.map((part) =>
        Object.assign(part, {
          move: flipTransform(
            part.el.getBoundingClientRect(),
            part.measure.getBoundingClientRect(),
            part.target.getBoundingClientRect(),
            part.byWidth
          )
        })
      );
    }

    function fly(parts, brand, finish) {
      const timing = { duration: TIMING.flight, easing: EASE_FLY, fill: 'forwards' };
      const moves = parts.map(({ el, move }) => {
        el.style.transformOrigin = `${move.originX}px ${move.originY}px`;
        return el.animate(
          [{ transform: 'none' }, { transform: `translate(${move.x}px, ${move.y}px) scale(${move.s})` }],
          timing
        );
      });
      // The page's brand has no slab below 32px, per the kit, so it goes.
      $('.kb-slab').animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: TIMING.slab,
        easing: 'ease-out',
        fill: 'forwards'
      });
      // Admin's shield turns back into the k on the way into the sidebar.
      if (variant === 'admin') {
        $('.kb-flip').animate([{ transform: 'rotateY(180deg)' }, { transform: 'rotateY(360deg)' }], timing);
      }
      fadeGround();
      return moves[0].finished.then(() => {
        // Land, then hand over: the real brand appears under the logo, which
        // fades off it, so any sub-pixel difference is never a jump.
        brand.classList.remove('kb-brand-hidden');
        return $('.kb-stage')
          .animate([{ opacity: 1 }, { opacity: 0 }], { duration: TIMING.swap, fill: 'forwards' })
          .finished.then(finish);
      });
    }

    // ---- Away: from this page to the next ----

    function guard(fn) {
      guards.add(fn);
      return () => guards.delete(fn);
    }

    function vetoed() {
      for (const fn of guards) {
        try {
          if (fn()) return true;
        } catch (err) {
          // A guard that throws has no opinion.
        }
      }
      return false;
    }

    function onLeaveLink(event) {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target && event.target.closest ? event.target.closest('a[data-boot-leave]') : null;
      if (!link || (link.target && link.target !== '_self') || link.hasAttribute('download')) return;
      const url = new URL(link.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      event.preventDefault();
      leave(url.href, { variant: link.getAttribute('data-boot-leave') });
    }

    /**
     * Go to `url`. Always navigates, and at once: the animation plays while the
     * next page is on its way, never before it. Plainly, with no animation, when
     * this page's own overlay is still up, when a guard objects, or when the
     * browser cannot animate.
     */
    function leave(url, options) {
      const target = new URL(url, window.location.href);
      const go = () => window.location.assign(target.href);
      if (leaving) return;
      if (!booted || vetoed() || !root.animate) {
        go();
        return;
      }

      const toVariant = options && options.variant === 'admin' ? 'admin' : 'app';
      const fromAdmin = variant === 'admin';
      const brand = findBrand();
      const rects = brand ? measureBrand(brand) : null;
      try {
        sessionStorage.setItem(
          HANDOFF_KEY,
          JSON.stringify({
            v: 1,
            kind: 'leave',
            from: window.location.pathname,
            to: target.pathname,
            variant: toVariant,
            fromAdmin,
            rects,
            at: Date.now()
          })
        );
      } catch (err) {
        // Storage blocked: this page still animates; the next one boots fresh.
      }

      const overlay = build(toVariant, 'leave', schedule('leave', toVariant, reduced, { fromAdmin, offset: 0 }));
      const siblings = Array.prototype.map.call(body.children, (el) => [el, el.inert]);
      body.appendChild(overlay);
      siblings.forEach(([el]) => {
        el.inert = true;
      });
      body.setAttribute('aria-busy', 'true');
      if (brand) brand.classList.add('kb-brand-hidden');
      groundUp(overlay, 0);
      liftOff(overlay, toVariant, rects, fromAdmin, 0);
      overlay.classList.add('kb-lit');

      leaving = { overlay, siblings, brand, timers: [] };
      leaving.timers.push(setTimeout(() => overlay.classList.add('kb-slow'), TIMING.slow));
      leaving.timers.push(setTimeout(stuck, TIMING.leaveGiveUp));
      overlay.querySelector('.btn-boot-retry').addEventListener('click', go);
      overlay.querySelector('.kb-stay').addEventListener('click', stay);
      go();
    }

    /** The next page has still not come. Say so, and offer a way back. */
    function stuck() {
      if (!leaving) return;
      const overlay = leaving.overlay;
      overlay.querySelector('.kb-reason').textContent = 'The server is taking longer than it should.';
      overlay.querySelector('.kb-stay').hidden = false;
      overlay.classList.remove('kb-lit', 'kb-slow');
      overlay.classList.add('kb-failed');
    }

    function stay() {
      // The navigation is still in flight; this is what calls it off.
      window.stop();
      forget();
      unleave();
    }

    function unleave() {
      if (!leaving) return;
      leaving.timers.forEach(clearTimeout);
      leaving.overlay.remove();
      leaving.siblings.forEach(([el, wasInert]) => {
        el.inert = wasInert;
      });
      body.removeAttribute('aria-busy');
      if (leaving.brand) leaving.brand.classList.remove('kb-brand-hidden');
      leaving = null;
    }

    // Back to a page kept in the back/forward cache: it went into the cache
    // mid-trip, with the ground up. Put it back as it was.
    function onPageShow(event) {
      if (!event.persisted) return;
      forget();
      unleave();
    }

    function forget() {
      try {
        sessionStorage.removeItem(HANDOFF_KEY);
      } catch (err) {
        // Nothing stored, then.
      }
    }

    // ---- Shared by both trips ----

    /** The ground coming up over the page being left, from `offset` ms in. */
    function groundUp(overlay, offset) {
      animateFrom(
        overlay.querySelector('.kb-ground'),
        [{ opacity: 0 }, { opacity: 1 }],
        { duration: reduced ? TIMING.reduced : TIMING.riseGround, easing: 'ease-out' },
        offset
      );
    }

    /**
     * The logo lifting off the brand of the page being left - measured before
     * it went, as `rects` - and turning into the destination's, from `offset`
     * ms in. Played from 0 on the page being left, and on the next page from
     * the frame the last one stopped on; the overlay is built in the
     * destination's shape on both, so both lay it out the same.
     */
    function liftOff(overlay, toVariant, rects, fromAdmin, offset) {
      if (reduced || !overlay.animate) return;
      const q = (selector) => overlay.querySelector(selector);
      const t = leaveTimeline(toVariant, fromAdmin);
      if (rects) {
        const parts = [
          { el: q('.kb-plate'), measure: q('.kb-plate'), from: rects.plate, byWidth: true },
          { el: q('.kb-word'), measure: q('.kb-word-in'), from: rects.word }
        ];
        parts.forEach((part) => {
          const move = flipTransform(
            part.el.getBoundingClientRect(),
            part.measure.getBoundingClientRect(),
            part.from,
            part.byWidth
          );
          part.el.style.transformOrigin = `${move.originX}px ${move.originY}px`;
          animateFrom(
            part.el,
            [{ transform: `translate(${move.x}px, ${move.y}px) scale(${move.s})` }, { transform: 'none' }],
            { duration: t.rise, easing: EASE_FLY },
            offset
          );
        });
        // The brand has no slab below 32px; the logo at full size does.
        animateFrom(q('.kb-slab'), [{ opacity: 0 }, { opacity: 1 }], { duration: t.rise, easing: 'ease-in' }, offset);
      } else {
        animateFrom(
          q('.kb-lockup'),
          [{ opacity: 0, transform: 'scale(0.9)' }, { opacity: 1, transform: 'none' }],
          { duration: t.rise, easing: EASE_FLY },
          offset
        );
      }
      if (t.flip) {
        animateFrom(
          q('.kb-flip'),
          [{ transform: 'rotateY(0deg)' }, { transform: 'rotateY(180deg)' }],
          { duration: t.flip, delay: t.flipDelay, easing: EASE_POP },
          offset
        );
        animateFrom(
          q('.kb-tag-in'),
          [{ opacity: 0, transform: 'translateX(-30%) scale(0.6)' }, { opacity: 1, transform: 'none' }],
          { duration: t.tag, delay: t.tagDelay, easing: EASE_POP },
          offset
        );
      }
      if (t.retract && rects && rects.tag) {
        // Admin's tag is left behind: it shrinks back into the wordmark where
        // it stood, rather than travelling to a page that has no place for it.
        const ghost = document.createElement('span');
        ghost.className = 'kb-tag-in kb-ghost';
        ghost.textContent = 'admin';
        overlay.appendChild(ghost);
        const natural = ghost.getBoundingClientRect();
        const s = rects.tag.height / natural.height;
        const placed = `translate(${rects.tag.left}px, ${rects.tag.top}px) scale(${s})`;
        animateFrom(
          ghost,
          [
            { opacity: 1, transform: placed },
            { opacity: 0, transform: `${placed} translateY(${natural.height * 0.2}px) scale(0.6)` }
          ],
          { duration: t.retract, easing: 'ease-in' },
          offset
        );
      }
    }

    /** An animation that holds its first frame until it starts, begun `offset` ms in. */
    function animateFrom(el, keyframes, timing, offset) {
      if (!el || !el.animate) return null;
      const anim = el.animate(keyframes, Object.assign({ fill: 'both' }, timing));
      anim.currentTime = offset;
      return anim;
    }

    function measureBrand(brand) {
      const box = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, width: r.width, height: r.height };
      };
      const plate = box(brand.querySelector('.klndr-plate'));
      const word = box(brand.querySelector('.klndr-wordmark'));
      if (!plate || !word) return null;
      return { plate, word, tag: box(brand.querySelector('.adm-tag')) };
    }

    /** The first [data-boot-brand] actually on screen, if any. */
    function findBrand() {
      const candidates = document.querySelectorAll('[data-boot-brand]');
      for (let i = 0; i < candidates.length; i++) {
        const el = candidates[i];
        const r = el.getBoundingClientRect();
        const onScreen =
          r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 &&
          r.left < window.innerWidth && r.top < window.innerHeight;
        if (onScreen && getComputedStyle(el).visibility !== 'hidden') return el;
      }
      return null;
    }

    /**
     * The icon font. Revealing the page before it has landed would show every
     * icon as its ligature name - "chevron_left" - for a moment. The stylesheet
     * that declares it has to have applied first, or document.fonts has no face
     * to wait for and answers at once.
     */
    function iconsReady() {
      const link = document.querySelector('link[href*="Material+Symbols"]');
      if (!link || !document.fonts || !document.fonts.load) return Promise.resolve();
      const until = performance.now() + TIMING.iconCap;
      return new Promise((resolve) => {
        const check = () => {
          if (link.rel === 'stylesheet' && link.sheet) {
            race(
              document.fonts.load('24px "Material Symbols Outlined"').catch(() => {}),
              Math.max(0, until - performance.now())
            ).then(resolve);
          } else if (performance.now() >= until) {
            resolve();
          } else {
            setTimeout(check, 30);
          }
        };
        check();
      });
    }

    return { ready, fail, leave, guard };
  }

  function readHandoff() {
    let raw = null;
    let legacyHero = false;
    try {
      raw = sessionStorage.getItem(HANDOFF_KEY);
      legacyHero = sessionStorage.getItem(LEGACY_HERO_KEY) === '1';
      sessionStorage.removeItem(HANDOFF_KEY);
      sessionStorage.removeItem(LEGACY_HERO_KEY);
    } catch (err) {
      // Storage blocked: an ordinary load, then.
    }
    return parseHandoff(raw, legacyHero, { now: Date.now(), pathname: window.location.pathname });
  }

  const SHIELD =
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<path fill="currentColor" d="M12 2 20 5v6c0 5.2-3.4 9.4-8 11-4.6-1.6-8-5.8-8-11V5z"/>' +
    '<path class="kb-shield-mark" d="M8.4 12.2l2.6 2.6 4.8-5"/>' +
    '</svg>';

  function build(variant, kind, plan) {
    const admin = variant === 'admin';
    const root = document.createElement('div');
    root.id = 'klndrBoot';
    root.setAttribute('data-variant', variant);
    if (kind === 'hero' || kind === 'leave') root.setAttribute('data-kind', kind);

    const ms = {
      '--kb-plate-dur': plan.plate,
      '--kb-word-delay': plan.wordDelay,
      '--kb-word-dur': plan.word,
      '--kb-tagline-delay': plan.taglineDelay,
      '--kb-tagline-dur': plan.tagline,
      '--kb-flip-delay': plan.flipDelay,
      '--kb-flip-dur': plan.flip,
      '--kb-tag-delay': plan.tagDelay,
      '--kb-tag-dur': plan.tag,
      '--kb-idle-delay': plan.idleDelay,
      '--kb-idle-every': TIMING.idleEvery
    };
    Object.keys(ms).forEach((name) => root.style.setProperty(name, `${ms[name]}ms`));

    root.innerHTML =
      '<div class="kb-ground"></div>' +
      '<div class="kb-stage">' +
      '<span class="kb-lockup" role="img" aria-label="' + (admin ? 'klndr admin' : 'klndr') + '">' +
      '<span class="kb-plate"><span class="kb-plate-in">' +
      '<span class="kb-slab"></span>' +
      '<span class="kb-press"><span class="kb-flip">' +
      '<span class="kb-face kb-face-k"><span>k</span></span>' +
      (admin ? '<span class="kb-face kb-face-shield">' + SHIELD + '</span>' : '') +
      '</span></span>' +
      '</span></span>' +
      '<span class="kb-text">' +
      '<span class="kb-word"><span class="kb-mask"><span class="kb-counter">' +
      '<span class="kb-word-in">klndr</span>' +
      '</span></span></span>' +
      '<span class="kb-tagline">Think of it. Schedule it.</span>' +
      '</span>' +
      (admin ? '<span class="kb-tag"><span class="kb-tag-in">admin</span></span>' : '') +
      '</span>' +
      '<p class="kb-note">' + (admin ? 'Opening admin&hellip;' : 'Waking the server&hellip;') + '</p>' +
      '</div>' +
      '<div class="kb-failure" role="alert">' +
      '<h1>' + (admin ? 'Couldn’t open admin' : 'Couldn’t load your board') + '</h1>' +
      '<p class="kb-reason"></p>' +
      '<div class="kb-actions">' +
      '<button type="button" class="btn-boot-retry">Try again</button>' +
      '<button type="button" class="kb-stay" hidden>Stay here</button>' +
      '</div>' +
      '</div>';
    return root;
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function race(promise, ms) {
    return Promise.race([promise, wait(ms)]);
  }

  function frames(n) {
    return new Promise((resolve) => {
      const step = () => (n-- > 0 ? requestAnimationFrame(step) : resolve());
      step();
    });
  }

  // Last, so every constant above exists. A loading screen that fails must
  // never cost the page: without KlndrBoot the pages simply show themselves.
  try {
    window.KlndrBoot = start();
  } catch (err) {
    document.documentElement.classList.remove('kb-busy');
    const broken = document.getElementById('klndrBoot');
    if (broken) broken.remove();
    console.error('The klndr boot overlay failed to start:', err);
  }
})();
