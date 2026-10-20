# Desktop app icon

`icon-source.png` is the unmodified community artwork supplied to the project
maintainer on 2026-09-23. `icon.png` is the plated close-up used by macOS,
Windows, and the Linux launcher: a dark rounded-square plate with Alice's face
and hair ribbon. The plate is part of the icon, so the launcher does not show
a transparent bust ending in a flat chest cut.

`icons/` is the Linux hicolor set generated from `icon.png`; the RPM and deb
desktop entries use the absolute `/opt/OpenAlice/resources/launcher-icon.png`
(installed from `icons/512x512.png`) so an icon-theme texture cache cannot keep
serving an older icon. `icon-pet.png` and `tray-pet.png` are the transparent
pet artwork for the in-app companion and tray; they are not the launcher icon.
`ui/src/assets/alice-logo.png` is the in-app welcome logo. Keep the plate and
the hair-ribbon margin when replacing the artwork.
