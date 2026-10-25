# Bundled fonts

Both are licensed under the SIL Open Font License 1.1, whose full text is in
`OFL.txt`. The OFL requires the licence to travel with the font, which is why
these files ship inside the repository and inside the container image rather
than being pulled at build time.

| File | Family | Copyright |
| --- | --- | --- |
| `Inter-Regular.ttf`, `Inter-Bold.ttf` | Inter | Copyright 2020 The Inter Project Authors (https://github.com/rsms/inter) |
| `NotoEmoji-Regular.ttf` | Noto Emoji | Copyright 2013 Google Inc. (https://github.com/googlefonts/noto-emoji) |

## Why the monochrome emoji font

`NotoColorEmoji.ttf` does not work here. resvg 0.34 — the version
`@resvg/resvg-js` 2.6.2 pins — cannot rasterise CBDT bitmap colour fonts, and
silently draws a "no glyph" box for every emoji instead of failing. Noto Emoji
is the monochrome outline build, so resvg renders it like any other glyph, in
the surrounding text colour.

Noto Emoji also contains **no Latin glyphs**. That matters: a font with emoji
*and* Latin coverage (Symbola, for instance) gets picked up for the words too,
and the tile silently switches to a serif face mid-line.

## Static, never variable

resvg 0.34 predates variable-font support. A variable file would render at a
single weight with no error at all, quietly collapsing the 190px hero against
the 36px rows into one flat weight. `Inter-Regular` and `Inter-Bold` are static
instances on purpose, and `test/tiles.test.ts` asserts both weights appear.
