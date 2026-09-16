# klndr motion

A [Remotion](https://www.remotion.dev) workspace for designing announcement
header clips. It is a separate package, like `desktop/`: nothing in the app
imports it, and it is never built or deployed (`vercel.json` only builds
`server.js`).

```bash
cd motion
npm install
npm run studio
```

The first `studio`, `render` or `compositions` run downloads Remotion's Chrome
Headless Shell (about 113 MB) into `node_modules`.

## What is in here

| Studio folder | Compositions | What they are |
| --- | --- | --- |
| **Scenes** | `PopReveal`, `BlockShuffle`, `StickerBurst`, `Checklist`, `Stamp`, `Ticker`, `FlipBoard`, `Keycaps`, `Chat`, `PointClick` | The app's built-in motion scenes, drawn by the same code klndr plays live (`protected/js/motion/scenes.js` and `motion-timeline.js`). |
| **Clips** | `FeatureSpotlight`, `WeekRecap` | Free-form React clips in `src/clips/`. Start a new clip by copying one. |

You rarely need to render a scene for a header. The announcement studio's
**Motion scene** option plays them natively: sharper than a video, a few
kilobytes instead of megabytes, and they follow the reader's light or dark
theme. Render one when you want it as a file, or tweak its props here first.

Every scene composition takes three props besides the scene's own:

| Prop | Default | Effect |
| --- | --- | --- |
| `loop` | `true` | Render one whole loop: in, idle, out, ending on the empty first frame. |
| `hold` | `2` | Seconds of idle before the out, in steps of 0.5, up to 10. |
| `tail` | `3` | With `loop: false`: seconds of idle after the scene has arrived. |

The composition's length follows them.

`npm run compositions` lists every id.

## Making a clip

1. Copy `src/clips/FeatureSpotlight.tsx` to `src/clips/MyClip.tsx` and rename its exports.
2. Register it in the Clips folder of `src/Root.tsx`: id, schema, default props, `durationInFrames`, `fps={30}`, 1200×600.
3. Run `npm run studio`. Code changes hot-reload, and the props panel on the right edits whatever the Zod schema describes, colour pickers included.

`src/klndr/brand.tsx` has the klndr pieces:
- `Slab`: flat fill, hard line, offset slab. klndr's one box.
- `Tag`, `KlndrMark`, `Wordmark`, `CheckIcon` and `Cursor`.
- `themeOf` (light and dark tokens straight from the app), `blockFill` (a category colour the way the calendar paints it) and `springAt` (a spring that waits for its cue).
- The app's line, slab and radius tokens, at clip scale.

Rules of thumb:

- **Six seconds or less, and loop it.** The reader plays header videos muted and looped. Have everything leave by the last frame so it lands on the empty first frame, as both templates do.
- **Draw at 1200×600.** The reader shows a header at roughly half that size, which is why `brand.tsx` doubles the app's tokens. 2:1 is the default aspect; 16:9, 3:1 and 1:1 also work.
- **A video keeps the theme it was rendered in.** Render the theme most people use, or use a Motion scene, which adapts.
- **Aim for 3 MB or less.** The upload limit is 50 MB, but everyone downloads the header.

## Rendering

```bash
npm run render -- FeatureSpotlight
npm run render -- WeekRecap --props=props/dark.json
npm run render:webm -- PopReveal
```

- `render` writes `out/<Id>.mp4` (H.264, CRF 23, 1200×600 at 30 fps).
- `render:webm` writes `out/<Id>.webm` (VP9).
- Props passed with `--props` are merged over the composition's defaults, so `props/dark.json` (`{ "theme": "dark" }`) works for every composition. You can also set props in Studio and use its Render button.

Any other flag goes straight to `remotion render`:

| Flag | Effect |
| --- | --- |
| `--scale=2` | Renders at 2400×1200 |
| `--crf=28` | Smaller file, softer image |
| `--frames=0-89` | Renders only part of the clip |

`out/` is git-ignored. So is `public/klndr/`, which `npm run assets` refills with
ElmsSans before every studio and render run. Your own images and audio go
directly in `public/`, and `staticFile('name.png')` loads them.

## Using a clip in an announcement

1. Open **/announcements**, then a post, then **Header**, then **Upload**.
2. Drop in the MP4 or WebM.
3. The studio captures a poster frame and uploads the file straight to R2. The reader plays it muted and looped, and shows the poster to people who prefer reduced motion.

## Licence

Remotion is not MIT-licensed. It is free for individuals, non-profits, and
companies with up to three employees; larger companies need a company licence
(<https://www.remotion.dev/license>). The klndr app does not depend on
Remotion: its in-app scene player is klndr's own code.
