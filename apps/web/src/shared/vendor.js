// Klndr Vendor
//
// The two third-party libraries, fetched the first time something needs them
// rather than with the page: the Lottie player (170 kB) for an animated
// announcement header, and fflate for a zip dropped into the Studio. Most
// sessions never need either, so each is a chunk of its own that the build
// only links to.

export const KlndrVendor = (() => {
  const LOADERS = new Map([
    // The light build on purpose: SVG renderer only, and no expression
    // support, so a Lottie file has no route to eval().
    ['lottie', () => import('lottie-web/build/player/lottie_light.js').then((module) => module.default)],
    ['fflate', () => import('fflate')]
  ]);

  const loading = new Map();

  // Resolves with the library. Two callers asking at once share one request,
  // and a failed load is forgotten, so the next attempt fetches again instead
  // of repeating the failure.
  //
  // A tab opened before a deploy links to the chunks that deploy replaced, and
  // fails here. It is not reloaded for the person: in the Studio that would
  // throw away the post they are writing. The error says what to do instead.
  function load(name) {
    if (!LOADERS.has(name)) return Promise.reject(new Error(`No vendor library called ${name}`));
    if (!loading.has(name)) {
      loading.set(name, LOADERS.get(name)().catch((err) => {
        loading.delete(name);
        throw new Error(`${name} did not load. If klndr was updated since this page opened, reloading it will fix that.`, { cause: err });
      }));
    }
    return loading.get(name);
  }

  return { load };
})();
