// Klndr Vendor
//
// The two third-party libraries, fetched the first time something needs them
// rather than with the page: the Lottie player (170 kB) for an animated
// announcement header, and fflate for a zip dropped into the Studio. Most
// sessions never need either.
//
// They share one loader so that the move to a bundler changes one place: each
// name here becomes a dynamic import().

'use strict';

/* exported KlndrVendor */
const KlndrVendor = (() => {
  // Each one is a UMD build that, loaded as a plain script, sets the global of
  // the same name.
  const SOURCES = new Map([
    ['lottie', '/protected/vendor/lottie_light.min.js'],
    ['fflate', '/protected/vendor/fflate.min.js']
  ]);

  const loading = new Map();

  // Resolves with the library. Two callers asking at once share one request,
  // and a failed load is forgotten, so the next attempt fetches again instead
  // of repeating the failure.
  function load(name) {
    if (!SOURCES.has(name)) return Promise.reject(new Error(`No vendor library called ${name}`));
    if (window[name]) return Promise.resolve(window[name]);
    if (!loading.has(name)) {
      loading.set(name, new Promise((resolve, reject) => {
        const fail = () => {
          loading.delete(name);
          reject(new Error(`${name} did not load`));
        };
        const script = document.createElement('script');
        script.src = SOURCES.get(name);
        script.async = true;
        script.onload = () => (window[name] ? resolve(window[name]) : fail());
        script.onerror = fail;
        document.head.appendChild(script);
      }));
    }
    return loading.get(name);
  }

  return { load };
})();
