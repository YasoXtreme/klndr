// Announcement Studio - getting files into storage.
//
// The browser does the looking: what kind of file this really is, how big it
// is on screen, a still frame to show before it plays. Then it asks the server
// to sign an upload, PUTs the bytes straight to R2 with progress, and asks the
// server to confirm what arrived. See server/media.js for the other half.

(() => {
  const S = KlndrStudio;
  const { h, icon, iconButton, fmtBytes } = S;

  const FFLATE_SRC = '/protected/vendor/fflate.min.js';
  const POSTER_WIDTH = 1280;

  const ACCEPT = [
    'image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/gif', 'image/svg+xml',
    'video/mp4', 'video/webm', 'application/json', '.json', '.lottie'
  ].join(',');

  const RASTER_TYPES = {
    png: 'image/png',
    apng: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    avif: 'image/avif',
    gif: 'image/gif'
  };

  function loadScript(src, globalName) {
    if (window[globalName]) return Promise.resolve(window[globalName]);
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.onload = () => (window[globalName] ? resolve(window[globalName]) : reject(new Error(`${globalName} did not load`)));
      script.onerror = () => reject(new Error(`${globalName} did not load`));
      document.head.appendChild(script);
    });
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("That image didn't open in this browser."));
      img.src = src;
    });
  }

  async function withObjectUrl(blob, work) {
    const url = URL.createObjectURL(blob);
    try {
      return await work(url);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function indexOfAscii(bytes, text) {
    const codes = Array.from(text, (ch) => ch.charCodeAt(0));
    outer: for (let i = 0; i <= bytes.length - codes.length; i++) {
      for (let j = 0; j < codes.length; j++) {
        if (bytes[i + j] !== codes[j]) continue outer;
      }
      return i;
    }
    return -1;
  }

  // APNG announces itself with an acTL chunk before the image data; an
  // animated WebP sets the animation bit in its VP8X header.
  async function isAnimated(blob) {
    const bytes = new Uint8Array(await blob.slice(0, 512 * 1024).arrayBuffer());
    if (blob.type === 'image/png') {
      const actl = indexOfAscii(bytes, 'acTL');
      const idat = indexOfAscii(bytes, 'IDAT');
      return actl >= 0 && (idat < 0 || actl < idat);
    }
    if (blob.type === 'image/webp') {
      return indexOfAscii(bytes.subarray(12, 16), 'VP8X') === 0 && (bytes[20] & 0x02) === 0x02;
    }
    return false;
  }

  /** Draw a still into a WebP no wider than POSTER_WIDTH. Null if the browser can't. */
  function stillAsWebp(draw, width, height) {
    return new Promise((resolve) => {
      try {
        const scale = Math.min(1, POSTER_WIDTH / Math.max(1, width));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        draw(canvas.getContext('2d'), canvas.width, canvas.height);
        canvas.toBlob((blob) => resolve(blob && blob.type === 'image/webp' ? blob : null), 'image/webp', 0.86);
      } catch {
        resolve(null);
      }
    });
  }

  function inspectVideo(file, name, contentType) {
    const blob = file.type === contentType ? file : new Blob([file], { type: contentType });
    return withObjectUrl(blob, (url) => new Promise((resolve, reject) => {
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';
      const timer = setTimeout(
        () => reject(new Error("That video didn't open in this browser. Export it as MP4 (H.264) or WebM.")),
        15000
      );
      video.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error("This browser can't play that video. Export it as MP4 (H.264) or WebM."));
      }, { once: true });
      video.addEventListener('loadedmetadata', () => {
        const duration = Number.isFinite(video.duration) ? video.duration : 0;
        video.currentTime = Math.max(0.01, Math.min(0.5, duration / 2));
      }, { once: true });
      video.addEventListener('seeked', async () => {
        clearTimeout(timer);
        const width = video.videoWidth;
        const height = video.videoHeight;
        if (!width || !height) {
          reject(new Error('That file has no picture klndr can show.'));
          return;
        }
        const poster = await stillAsWebp((ctx, w, hgt) => ctx.drawImage(video, 0, 0, w, hgt), width, height);
        resolve({
          kind: 'video',
          blob,
          name,
          contentType,
          width,
          height,
          duration_ms: Math.round((Number.isFinite(video.duration) ? video.duration : 0) * 1000),
          poster
        });
      }, { once: true });
      video.src = url;
    }));
  }

  // A frame from 40% of the way in, so the poster shows the animation rather
  // than its usually-empty first frame. Best effort: some files taint the
  // canvas, and then there is simply no poster.
  async function lottiePoster(data) {
    const lottie = await KlndrAnnouncementMedia.loadLottie();
    const host = document.createElement('div');
    host.style.cssText = `position:fixed;left:-10000px;top:0;width:${data.w}px;height:${data.h}px;`;
    document.body.appendChild(host);
    try {
      const animation = lottie.loadAnimation({
        container: host,
        renderer: 'svg',
        loop: false,
        autoplay: false,
        animationData: JSON.parse(JSON.stringify(data))
      });
      await new Promise((resolve, reject) => {
        animation.addEventListener('DOMLoaded', resolve);
        setTimeout(() => reject(new Error('Lottie took too long')), 5000);
      });
      animation.goToAndStop(Math.floor((animation.totalFrames || 1) * 0.4), true);
      const svg = host.querySelector('svg');
      svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      svg.setAttribute('width', String(data.w));
      svg.setAttribute('height', String(data.h));
      const markup = new XMLSerializer().serializeToString(svg);
      animation.destroy();
      const img = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`);
      return await stillAsWebp((ctx, w, hgt) => ctx.drawImage(img, 0, 0, w, hgt), data.w, data.h);
    } finally {
      host.remove();
    }
  }

  async function inspectLottie(text, name) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("That JSON file isn't a Lottie animation - it doesn't parse.");
    }
    if (!data || typeof data !== 'object' || !Array.isArray(data.layers) ||
      !Number.isFinite(data.w) || !Number.isFinite(data.h) || !Number.isFinite(data.fr)) {
      throw new Error("That JSON file isn't a Lottie animation.");
    }
    return {
      kind: 'lottie',
      blob: new Blob([text], { type: 'application/json' }),
      name,
      contentType: 'application/json',
      width: Math.round(data.w),
      height: Math.round(data.h),
      duration_ms: data.fr > 0 ? Math.round(((data.op - data.ip) / data.fr) * 1000) : null,
      poster: await lottiePoster(data).catch(() => null)
    };
  }

  function bytesToBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  }

  /**
   * A .lottie archive, unzipped to the Lottie JSON inside it, with its images
   * inlined so the one file plays on its own. The server only ever sees JSON.
   */
  async function dotLottieToJson(file) {
    const fflate = await loadScript(FFLATE_SRC, 'fflate');
    let entries;
    try {
      entries = fflate.unzipSync(new Uint8Array(await file.arrayBuffer()));
    } catch {
      throw new Error("That .lottie file couldn't be opened.");
    }
    const decode = (bytes) => new TextDecoder().decode(bytes);
    const names = Object.keys(entries);

    let path = null;
    if (entries['manifest.json']) {
      try {
        const manifest = JSON.parse(decode(entries['manifest.json']));
        const first = manifest.animations && manifest.animations[0];
        if (first && first.id) path = [`animations/${first.id}.json`, `a/${first.id}.json`].find((p) => entries[p]);
      } catch {
        // Fall through to the first animation in the archive.
      }
    }
    path = path || names.find((n) => /^(animations|a)\/[^/]+\.json$/.test(n));
    if (!path) throw new Error('That .lottie file has no animation inside it.');

    const data = JSON.parse(decode(entries[path]));
    const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml' };
    for (const asset of data.assets || []) {
      if (!asset.p || asset.e === 1 || /^data:/.test(asset.p)) continue;
      const image = names.find((n) => n === `images/${asset.p}` || n === `i/${asset.p}` || n.endsWith(`/${asset.p}`));
      if (!image) continue;
      const ext = asset.p.split('.').pop().toLowerCase();
      asset.p = `data:${MIME[ext] || 'application/octet-stream'};base64,${bytesToBase64(entries[image])}`;
      asset.u = '';
      asset.e = 1;
    }
    return JSON.stringify(data);
  }

  /** What a file is, as the server's media kinds see it, plus what the Studio can learn about it. */
  async function inspectFile(file) {
    const name = file.name || 'upload';
    const ext = (name.includes('.') ? name.split('.').pop() : '').toLowerCase();
    const type = (file.type || '').toLowerCase();

    if (ext === 'lottie') return inspectLottie(await dotLottieToJson(file), name.replace(/\.lottie$/i, '.json'));
    if (type === 'application/json' || ext === 'json') return inspectLottie(await file.text(), name);

    if (type === 'image/svg+xml' || ext === 'svg') {
      const text = await file.text();
      if (!/<svg[\s>]/i.test(text)) throw new Error("That file doesn't look like an SVG.");
      const blob = new Blob([text], { type: 'image/svg+xml' });
      const size = await withObjectUrl(blob, loadImage)
        .then((img) => ({ width: img.naturalWidth, height: img.naturalHeight }))
        .catch(() => ({}));
      return { kind: 'svg', blob, name, contentType: 'image/svg+xml', ...size };
    }

    if (type === 'video/quicktime' || ext === 'mov') {
      throw new Error('QuickTime (.mov) files only play in some browsers. Export it as MP4 (H.264) or WebM and upload that.');
    }
    if (type === 'video/mp4' || type === 'video/webm' || ['mp4', 'm4v', 'webm'].includes(ext)) {
      return inspectVideo(file, name, type === 'video/webm' || ext === 'webm' ? 'video/webm' : 'video/mp4');
    }

    const contentType = RASTER_TYPES[ext] && !type.startsWith('image/') ? RASTER_TYPES[ext] : type;
    if (!Object.values(RASTER_TYPES).includes(contentType)) {
      throw new Error(`klndr can't use ${ext ? `.${ext}` : 'that kind of'} file as a header. Try PNG, JPEG, WebP, AVIF, GIF, SVG, MP4, WebM or Lottie.`);
    }
    const blob = file.type === contentType ? file : new Blob([file], { type: contentType });
    const animated = contentType === 'image/gif' || (await isAnimated(blob));
    return withObjectUrl(blob, async (url) => {
      const img = await loadImage(url);
      const width = img.naturalWidth;
      const height = img.naturalHeight;
      const poster = animated
        ? await stillAsWebp((ctx, w, hgt) => ctx.drawImage(img, 0, 0, w, hgt), width, height)
        : null;
      return { kind: animated ? 'animated_image' : 'image', blob, name, contentType, width, height, poster };
    });
  }

  // XHR rather than fetch, for upload progress.
  function put(target, blob, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(target.method || 'PUT', target.url);
      for (const [name, value] of Object.entries(target.headers || {})) xhr.setRequestHeader(name, value);
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress(event.loaded);
      };
      xhr.onload = () => (xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`Storage refused the upload (${xhr.status}).`)));
      xhr.onerror = () => reject(new Error(
        "The upload didn't reach storage. If this keeps happening, check the bucket's CORS policy with npm run r2:check."
      ));
      xhr.send(blob);
    });
  }

  /** Inspect, sign, upload and confirm one file. Resolves to the library entry. */
  async function uploadFile(file, onProgress) {
    const storage = S.state.storage;
    if (!storage || !storage.configured) throw new Error('Uploads are off until storage is set up.');

    onProgress(0, 'Checking');
    const info = await inspectFile(file);
    const limit = storage.limits[info.kind];
    if (limit && info.blob.size > limit.max_bytes) {
      throw new Error(`${limit.label} files can be up to ${fmtBytes(limit.max_bytes)}, and this one is ${fmtBytes(info.blob.size)}.`);
    }
    const poster = info.poster && info.poster.size <= storage.poster.max_bytes ? info.poster : null;

    const signed = await API.createMediaUpload({
      kind: info.kind,
      content_type: info.contentType,
      bytes: info.blob.size,
      filename: info.name,
      width: info.width,
      height: info.height,
      duration_ms: info.duration_ms,
      poster: poster ? { bytes: poster.size } : null
    });

    const total = info.blob.size + (poster ? poster.size : 0);
    await put(signed.upload, info.blob, (loaded) => onProgress(loaded / total, 'Uploading'));
    if (poster && signed.poster_upload) {
      // The poster is a nicety: the server confirms the upload without it.
      await put(signed.poster_upload, poster, (loaded) => onProgress((info.blob.size + loaded) / total, 'Uploading'))
        .catch(() => null);
    }

    onProgress(1, 'Finishing');
    const media = await API.completeMediaUpload(signed.media.id);
    S.state.library = null;
    return media;
  }

  /** A progress row for one upload, newest on top. */
  function uploadRow(container, name) {
    const row = h('div', 'st-upload');
    const top = h('div', 'st-upload-name');
    const status = h('span', null, 'Checking');
    top.append(h('span', null, name), status);
    const bar = h('div', 'st-progress');
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    bar.setAttribute('aria-label', `Uploading ${name}`);
    const fill = h('div', 'st-progress-fill');
    bar.appendChild(fill);
    row.append(top, bar);
    container.prepend(row);

    return {
      progress(fraction, label) {
        const pct = Math.round(fraction * 100);
        fill.style.width = `${pct}%`;
        bar.setAttribute('aria-valuenow', String(pct));
        status.textContent = label === 'Uploading' ? `${pct}%` : `${label}…`;
      },
      done() {
        status.textContent = 'Done';
        setTimeout(() => row.remove(), 900);
      },
      fail(message) {
        row.classList.add('is-error');
        bar.remove();
        status.replaceWith(iconButton('close', 'Dismiss', () => row.remove()));
        row.appendChild(h('span', null, message));
      }
    };
  }

  /** The drop target. Clicking, dropping and Enter all end in onFile(file). */
  function dropzone({ onFile, title, detail }) {
    const enabled = Boolean(S.state.storage && S.state.storage.configured);
    const zone = h('div', `st-drop${enabled ? '' : ' is-disabled'}`);
    zone.setAttribute('role', 'button');
    zone.tabIndex = enabled ? 0 : -1;
    zone.setAttribute('aria-disabled', String(!enabled));
    zone.append(
      icon(enabled ? 'cloud_upload' : 'cloud_off'),
      h('strong', null, enabled ? title || 'Drop a file here, or click to choose' : 'Uploads are off until storage is set up'),
      h('small', null, enabled
        ? detail || 'An image, GIF, SVG, MP4 or WebM video, or a Lottie animation (.json or .lottie). You can paste one too.'
        : 'Add the R2 settings to the server environment - the README walks through it.')
    );

    const input = h('input');
    input.type = 'file';
    input.hidden = true;
    input.accept = ACCEPT;
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      input.value = '';
      if (file) onFile(file);
    });
    zone.appendChild(input);

    if (enabled) {
      zone.addEventListener('click', () => input.click());
      zone.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          input.click();
        }
      });
      zone.addEventListener('dragover', (event) => {
        event.preventDefault();
        zone.classList.add('is-over');
      });
      zone.addEventListener('dragleave', () => zone.classList.remove('is-over'));
      zone.addEventListener('drop', (event) => {
        event.preventDefault();
        zone.classList.remove('is-over');
        const file = event.dataTransfer && event.dataTransfer.files[0];
        if (file) onFile(file);
      });
    }
    return zone;
  }

  S.uploads = { inspectFile, uploadFile, uploadRow, dropzone };
})();
