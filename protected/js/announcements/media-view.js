// Klndr Announcement Media
//
// Mounts an announcement's header - whatever kind it is - into a box of the
// right shape, and cleans up after it.
//
// The box is sized before a byte arrives, from the aspect the post asks for
// rather than from the file, so nothing underneath it jumps when the media
// loads. Anything that moves pauses once it is scrolled away, and waits for a
// tap when someone has asked for reduced motion. SVG is only ever an <img>:
// inlined, an uploaded SVG could run script in the page.

const KlndrAnnouncementMedia = (() => {
  const LOTTIE_SRC = '/protected/vendor/lottie_light.min.js';

  const TYPE_ICONS = {
    image: 'image',
    animated_image: 'gif_box',
    svg: 'draw',
    video: 'movie',
    lottie: 'animation',
    scene: 'animated_images'
  };

  let lottieLoading = null;

  // The Lottie player is 170 kB and most posts will never need it, so it is
  // fetched the first time one does.
  function loadLottie() {
    if (window.lottie) return Promise.resolve(window.lottie);
    if (!lottieLoading) {
      lottieLoading = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = LOTTIE_SRC;
        script.async = true;
        script.onload = () => (window.lottie ? resolve(window.lottie) : reject(new Error('Lottie did not load')));
        script.onerror = () => {
          lottieLoading = null;
          reject(new Error('Lottie did not load'));
        };
        document.head.appendChild(script);
      });
    }
    return lottieLoading;
  }

  function prefersReducedMotion() {
    return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function el(tag, className, attrs = {}) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    for (const [name, value] of Object.entries(attrs)) {
      if (value === false || value == null) continue;
      node.setAttribute(name, value === true ? '' : value);
    }
    return node;
  }

  function ratioOf(media) {
    return KlndrAnnouncementRules.ASPECTS[media && media.aspect] || 2;
  }

  function objectPosition(media) {
    const focal = (media && media.focal) || { x: 0.5, y: 0.5 };
    return `${Math.round(focal.x * 100)}% ${Math.round(focal.y * 100)}%`;
  }

  function playButton(label, onPlay) {
    const button = el('button', 'ann-media-play', { type: 'button', 'aria-label': label });
    button.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">play_arrow</span>';
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      button.remove();
      onPlay();
    });
    return button;
  }

  function whenVisible(node, onChange) {
    if (typeof IntersectionObserver === 'undefined') {
      onChange(true);
      return () => {};
    }
    const observer = new IntersectionObserver(
      (entries) => onChange(entries.some((entry) => entry.isIntersecting)),
      { threshold: 0.15 }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }

  /**
   * Mount `media` into `container`.
   *
   * options.thumbnail  a small still: no video element, no Lottie player, no loop
   * options.autoplay   defaults to true; reduced motion overrides it
   * options.controls   a scrubber on motion scenes (the Studio)
   *
   * Returns { element, player, destroy }. `player` is the motion player when the
   * header is a scene, so the Studio can push new props into it.
   */
  function mount(container, media, options = {}) {
    const { thumbnail = false, autoplay = true, controls = false } = options;
    const frame = el('div', `ann-media${thumbnail ? ' is-thumb' : ''}`);
    frame.style.setProperty('--ann-aspect', String(ratioOf(media)));
    if (media && media.background) frame.style.setProperty('--ann-media-bg', media.background);
    frame.dataset.type = media ? media.type : 'none';
    frame.dataset.fit = (media && media.fit) || 'cover';
    container.appendChild(frame);

    const cleanups = [];
    let player = null;

    const result = {
      element: frame,
      get player() {
        return player;
      },
      destroy() {
        cleanups.splice(0).forEach((fn) => {
          try {
            fn();
          } catch (err) {
            console.warn('Could not clean up announcement media', err);
          }
        });
        frame.remove();
      }
    };

    if (!media) {
      frame.classList.add('is-empty');
      return result;
    }

    const decorative = Boolean(media.decorative);
    const label = decorative ? '' : media.alt || '';
    const motionAllowed = autoplay && !prefersReducedMotion();

    function fail() {
      frame.replaceChildren();
      frame.classList.add('is-broken');
      const icon = el('span', 'material-symbols-outlined ann-media-fallback', { 'aria-hidden': 'true' });
      icon.textContent = TYPE_ICONS[media.type] || 'image';
      frame.appendChild(icon);
    }

    function image(src) {
      const img = el('img', 'ann-media-el', {
        src,
        alt: label,
        decoding: 'async',
        loading: thumbnail ? 'lazy' : 'eager',
        draggable: 'false',
        'aria-hidden': decorative ? 'true' : null
      });
      img.style.objectPosition = objectPosition(media);
      img.addEventListener('error', fail, { once: true });
      return img;
    }

    switch (media.type) {
      case 'image':
      case 'svg': {
        if (!media.url) return fail(), result;
        frame.appendChild(image(media.url));
        break;
      }

      case 'animated_image': {
        if (!media.url) return fail(), result;
        if ((thumbnail || !motionAllowed) && media.poster_url) {
          const still = image(media.poster_url);
          frame.appendChild(still);
          if (!thumbnail) {
            frame.appendChild(playButton('Play animation', () => still.replaceWith(image(media.url))));
          }
        } else {
          frame.appendChild(image(media.url));
        }
        break;
      }

      case 'video': {
        if (!media.url) return fail(), result;
        if (thumbnail) {
          if (media.poster_url) frame.appendChild(image(media.poster_url));
          else fail();
          break;
        }

        const video = el('video', 'ann-media-el', {
          playsinline: true,
          muted: true,
          loop: true,
          preload: 'metadata',
          poster: media.poster_url || null,
          'aria-label': label || null,
          'aria-hidden': decorative ? 'true' : null
        });
        // The attribute alone does not satisfy every browser's autoplay rule.
        video.muted = true;
        video.style.objectPosition = objectPosition(media);
        video.src = media.url;
        video.addEventListener('error', fail, { once: true });
        frame.appendChild(video);

        let wanted = motionAllowed;
        let visible = true;
        const sync = () => {
          if (wanted && visible) video.play().catch(() => {});
          else video.pause();
        };
        cleanups.push(whenVisible(frame, (isVisible) => {
          visible = isVisible;
          sync();
        }));
        if (!motionAllowed) {
          frame.appendChild(playButton('Play video', () => {
            wanted = true;
            sync();
          }));
        }

        if (media.has_audio) {
          const sound = el('button', 'ann-media-sound', {
            type: 'button',
            'aria-label': 'Turn sound on',
            'aria-pressed': 'false'
          });
          sound.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">volume_off</span>';
          sound.addEventListener('click', (event) => {
            event.stopPropagation();
            video.muted = !video.muted;
            sound.setAttribute('aria-pressed', String(!video.muted));
            sound.setAttribute('aria-label', video.muted ? 'Turn sound on' : 'Turn sound off');
            sound.firstElementChild.textContent = video.muted ? 'volume_off' : 'volume_up';
            if (!video.muted) {
              wanted = true;
              sync();
            }
          });
          frame.appendChild(sound);
        }

        cleanups.push(() => {
          video.pause();
          video.removeAttribute('src');
          video.load();
        });
        break;
      }

      case 'lottie': {
        if (!media.url) return fail(), result;
        if (thumbnail && media.poster_url) {
          frame.appendChild(image(media.poster_url));
          break;
        }

        const stage = el('div', 'ann-media-el ann-media-lottie', {
          role: label ? 'img' : null,
          'aria-label': label || null,
          'aria-hidden': decorative ? 'true' : null
        });
        frame.appendChild(stage);

        let animation = null;
        let gone = false;
        let visible = true;
        let wanted = motionAllowed && !thumbnail;
        const sync = () => {
          if (!animation) return;
          if (wanted && visible) animation.play();
          else animation.pause();
        };

        Promise.all([
          loadLottie(),
          fetch(media.url).then((res) => {
            if (!res.ok) throw new Error(`Lottie file answered ${res.status}`);
            return res.json();
          })
        ])
          .then(([lottie, data]) => {
            if (gone) return;
            animation = lottie.loadAnimation({
              container: stage,
              renderer: 'svg',
              loop: true,
              autoplay: false,
              animationData: data,
              rendererSettings: {
                preserveAspectRatio: media.fit === 'contain' ? 'xMidYMid meet' : 'xMidYMid slice'
              }
            });
            animation.addEventListener('DOMLoaded', () => {
              if (!wanted) animation.goToAndStop(Math.floor((animation.totalFrames || 1) * 0.4), true);
              sync();
            });
          })
          .catch(() => {
            if (!gone) fail();
          });

        cleanups.push(whenVisible(frame, (isVisible) => {
          visible = isVisible;
          sync();
        }));
        if (!thumbnail && !motionAllowed) {
          frame.appendChild(playButton('Play animation', () => {
            wanted = true;
            sync();
          }));
        }
        cleanups.push(() => {
          gone = true;
          if (animation) animation.destroy();
        });
        break;
      }

      case 'scene': {
        const scene = media.scene && KlndrScenes.get(media.scene.id);
        if (!scene) return fail(), result;

        if (thumbnail) {
          const canvas = el('canvas', 'ann-media-el ann-motion-canvas', {
            role: 'img',
            'aria-label': KlndrScenes.describe(media.scene.id, media.scene.props)
          });
          frame.appendChild(canvas);
          const still = () => KlndrMotion.renderStill(canvas, {
            sceneId: media.scene.id,
            props: media.scene.props,
            ratio: ratioOf(media)
          });
          KlndrMotion.whenFontReady().then(still);
          window.addEventListener('klndr:themechange', still);
          cleanups.push(() => window.removeEventListener('klndr:themechange', still));
          break;
        }

        player = KlndrMotion.mount(frame, {
          sceneId: media.scene.id,
          props: media.scene.props,
          ratio: ratioOf(media),
          autoplay,
          controls,
          label
        });
        cleanups.push(() => player.destroy());
        break;
      }

      default:
        fail();
    }

    return result;
  }

  return { mount, loadLottie, ratioOf, TYPE_ICONS };
})();
