# Card face/back presets

The court layer is an original, self-hosted SVG sprite-style component in
`PlayingCard.tsx`, with no external requests or embedded metadata. It follows
the visual role of public-domain/CC0 English-pattern references such as
saulspatz/SVGCards and Dmitry Fomin English-pattern, but contains no copied
source artwork. The mirrored top/bottom halves keep J/Q/K readable in both
`pod` and `board` sizes.

Presets can be previewed by setting `data-card-face` and `data-card-back` on a
card root. Face presets: `gg-four-color`, `gg-solid`, `classic-large`,
`jumbo-accessible`, `minimal`. `gg-solid` is the plain GG-style face: a
two-way rank+suit index pair and one large center suit logo, with no court art.
All face presets share a restrained edge, lift shadow, inset lower edge, and
top highlight so pod and board cards have the same physical presence. Back presets: `wine-lattice`, `black-gold`,
`classic-red-blue`, `geometry`, `deep-blue-silver`.

The harness now lives in `tools/visual/table-faces/`; run it from the repo root
with `vite --config tools/visual/table-faces/vite.config.mjs` (the config pins
`root` to its own directory, so the working directory does not matter; relative
imports still resolve to the repo root).

Compatibility note: the default card face is intentionally visually different
from HEAD: it now includes court art, a restrained outline, a pale gradient,
and layered shadow/highlight depth. This is the requested design change, not
an accidental default regression.
