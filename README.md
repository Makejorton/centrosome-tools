# Centrosome Tools (web)

Static page for the Centrosome: firmware **UPDATE** and a **PATCHES** editor. No build step, no dependencies.
Open `index.html` in Chrome or Edge, or serve the folder (`python3 -m http.server -d web`).

## What works today
- Patch editor: all 16 patches, ~90 `PatchState` fields, edits kept in the browser, import/export as JSON.
- DEMO DEVICE: simulated unit so the whole update flow can be tried with no hardware.
- Package picker with a local SHA-256.

## What does NOT work yet
- A real unit. The USB code (`SerialTransport` in `app.js`) speaks a **provisional** newline-delimited JSON
  protocol (spec in the comment at the top of `app.js`): signed manifest on `update.begin`, CRC32 + resumable
  `update.chunk`, `patch.put` carrying `patchStateVersion`, and a `hello` that lists the fields the unit supports
  (the page greys out the rest). The device-side daemon (plan Phase U2) is not built, so nothing answers. Signature checking and the A/B install happen on the unit, never on this page.
- Field ranges outside the firmware clamps (tune, fine, EQ gain, comp threshold, Q) are display ranges; check
  them against `BelaMain.cpp` before enabling SEND on real units.

## Hosting
Web Serial is blocked inside a Google Sites embed (checked 8 Oct 2026), so host this folder standalone and link to
it from the Sites page at makejorton.com/centrosome. Published from this repo root with GitHub Pages.
(Public repo: Pages on a private repo needs a paid plan.)

Style: tokens from `UI_UX_STYLE_GUIDE_UNIFIED.md`; layout/tone inspired by a flat black all-caps configurator.
Status never relies on red vs green.
