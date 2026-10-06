# Web appearance preferences

The Settings → Table & play section exposes three independent appearance axes.
Card previews are real `PlayingCard` instances (the same production card
component), while the table skin swatch is a simplified felt ellipse built from
the same CSS custom properties the live table uses. Every pick is applied
locally immediately, then persisted through `PUT /api/profile`.

| axis | available values | default |
| --- | --- | --- |
| Card back | `indigo`, `crimson`, `emerald`, `slate`, `wine-lattice`, `black-gold`, `classic-red-blue`, `geometry`, `deep-blue-silver` | `crimson` |
| Card face | `gg-four-color`, `gg-solid`, `classic-large`, `jumbo-accessible`, `minimal` | `gg-four-color` |
| Table skin | `gg-green`, `sapphire`, `burgundy`, `classic-casino` | `gg-green` |

The former `fourColor` boolean is retained only as a compatibility mirror:
legacy `true` means `gg-four-color` and legacy `false` means `classic-large`
(the retired UI's two-colour deck, preserved by a one-time migration). After
that migration `cardFace` is the authority; the boolean is never used to derive
the rendered face again, and a save from an old client cannot rewrite an
explicit `cardFace`.
