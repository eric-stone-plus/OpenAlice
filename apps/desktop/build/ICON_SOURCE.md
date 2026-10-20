# Desktop app icon

`icon-source.png` is the unmodified community artwork supplied to the project
maintainer on 2026-09-23. The Linux desktop icon (`icon-pet.png` and
`icons/`) is the transparent pet figure from
`ui/public/companion/alice.png`; no background plate, so the launcher and dock
show only the character. `icon.png` is the common source for `icon.icns`
(macOS) and `icon.ico` (Windows, with 16-256 px representations). Keep all
three packaging formats in sync when replacing the artwork.

`icons/512x512.png` is the padded master for the hicolor set: the head crop is
scaled to 80% and centered so the bow keeps a transparent margin inside the
launcher and dock tile. Smaller sizes are downscaled from that master; preserve
the padding when replacing the artwork.

The source bust ends in a flat cut at the chest. The bottom of the 512 master
(the last ~12% of the canvas) is alpha-faded so the launcher and dock show a
soft edge instead of a sliced figure; `icon-pet.png` carries the same fade at
1024. Regenerate the smaller sizes from the faded master with premultiplied
alpha so the fade does not pick up dark fringes.
