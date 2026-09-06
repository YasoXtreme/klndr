# klndr logo assets

Direction: **The Plate**. One typeface (ElmsSans), black borders, hard shadows, lowercase always.

## SVG (vector, scalable)
| File | Use |
| --- | --- |
| klndr-mark-plate.svg | default plate mark, any size >= 32px |
| klndr-mark-inverse.svg | dark / black surfaces |
| klndr-mark-sticker.svg | merch only (accent fill, black glyph) |
| klndr-app-icon-1024.svg | app icon master, full bleed, no shadow |
| klndr-favicon-32.svg | 32px plate (2px border) |
| klndr-favicon-16.svg | 16px micro tile (solid black, white k) |
| klndr-wordmark.svg | wordmark alone |
| klndr-lockup-horizontal.svg | primary lockup — top bars, headers, email |
| klndr-lockup-stacked.svg | square / narrow spaces only |
| klndr-badge.svg | enclosed wordmark — uncontrolled surfaces only |

SVGs draw the "k" as live text in ElmsSans and reference `ElmsSans.ttf` (kept in this folder) — keep them together, or convert text to outlines before handing them to print. Exported flat: no drop shadow. Add the hard shadow in layout (3px at 56px, 6px at 78px+, none below 32px).

## PNG (raster, transparent)
`png/` holds each mark rendered at 2x with a transparent background.

## Animated state
`klndr-logo-animation.html` — self-contained (needs `ElmsSans.ttf` beside it). Bounce-in: plate lands, wordmark wipes out from behind it, tagline fades up. Respects `prefers-reduced-motion`. Copy the `.klndr-anim` block straight into a page.

---

## Notes for this repo

`ElmsSans.ttf` is here so the kit travels intact; the app serves its own copy from
`public/assets/ElmsSans.ttf`. They are the same file — change both or neither.

**The SVGs draw the `k` as live text, and ElmsSans is a variable font whose default
instance is Thin.** Anything that redraws the glyph at render time — an `<img src>`
pointing at one of these, an SVG favicon, a print RIP without the font — gets a thin
`k`, not the Black one, so the exports here carry an explicit `font-family` and
`font-weight="900"` and an `@font-face` pointing at the TTF beside them. Use them as
inline SVG or as a document, never through `<img>`, and outline the text before
handing them to print.

In the product the lockup is not an SVG at all: `.klndr-lockup` in
`public/css/common.css` draws the plate and wordmark from markup, so it inherits the
`@font-face` the page already loads and can be animated a part at a time.

## The plate takes the colour its surface is not

The plate mark exports here are mint-filled, which is right on white. On klndr's
own mint gradient it is not: mint on mint collapses the badge into a bare outline.
So in the product `--klndr-plate-fill` is **white**, matching what the kit's own
`klndr-logo-animation.html` does — a `--paper` plate on a `--mint` body. Flip that
variable back to `var(--accent-mint)` for a lockup that sits on white.

The app icon is the exception and keeps its mint field: it is full bleed on
someone else's wallpaper, so the mint is the icon's own ground rather than a
badge dissolving into a background.

## Building the shipped icons

`png/klndr-favicon-tile.png` is a 512px render of the micro tile, which the kit
only had at 16px. It is drawn from `klndr-favicon-16.svg`'s geometry — rx 4/16,
baseline 12.5/16, font-size 12/16 — in real ElmsSans Black. **Every favicon size
comes off it.** The mint plate is the right mark at display sizes, but a browser
tab is 16-32px of very pale mint behind a hairline border, which reads as an
empty outline; the tile holds its weight all the way down.

The icons the app serves are built from `png/`, where the weight is already
rasterised in:

```bash
node scripts/build-brand-assets.js
```

That writes `favicon-16.png`, `favicon-32.png`, `favicon-48.png`,
`favicon.ico` (16/32/48) and `apple-touch-icon.png` into `public/assets/`. Re-run
it after changing anything in `png/`.
