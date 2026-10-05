# Table skin preview evidence

The preview is a deliberately data-driven, surface-only harness. It renders the
production `RoundTable` with nine seats and exposes the selector as a native
`data-table-skin` attribute; use the dropdown or append `?skin=sapphire` to the
preview URL.

| skin | felt | rail / hairline | watermark / room |
| --- | --- | --- | --- |
| `gg-green` | original deep forest, unchanged | charcoal leather / original gold | pale green 4AM / warm near-black |
| `sapphire` | midnight blue, slightly brighter center | brushed pewter / cool champagne | icy 4AM / blue-black |
| `burgundy` | oxblood velvet | espresso leather / antique brass | warm ivory 4AM / wine-black |
| `classic-casino` | bottle-green baize | walnut with procedural grain / brass | parchment 4AM / walnut-black |

Screenshots are captured at 1440×900 and 390×844 for every skin:

- `gg-green-desktop.png`, `gg-green-mobile.png`
- `sapphire-desktop.png`, `sapphire-mobile.png`
- `burgundy-desktop.png`, `burgundy-mobile.png`
- `classic-casino-desktop.png`, `classic-casino-mobile.png`

Run the harness from this directory with `vite --config vite.config.mjs`.
The production root is intentionally not assigned a skin yet, so an absent
attribute continues to resolve to the existing `:root` tokens exactly.
