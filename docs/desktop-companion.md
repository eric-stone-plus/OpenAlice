# Welcome-screen Alice

The desktop pet used to be a separate transparent BrowserWindow. It is now the
mark above the welcome copy on the Chat, AutoQuant and Auto Prediction landing
pages (`ui/src/components/PetLogo.tsx`).

- Artwork: `ui/src/assets/alice-logo.png` (256×256, downscaled from the full
  `ui/public/companion/alice.png`; the full artwork still supplies the tray
  icon).
- Motion: a 4.2s float plus a pointer-reactive 3D tilt. Hover pauses the float;
  `prefers-reduced-motion` disables it.
- Interaction: click or Enter speaks one of Alice's lines from Carroll's novel
  in a small popover; the line clears after 4.5s.
- No native companion window, drag, click-through, visibility toggle, or click
  sound remains. Activity notifications are still configured under
  Settings → Pet (`/settings/pet`).

The companion window, its preload, geometry/sound modules, preview harness and
renderer assets were removed with this change. `installCompanionActivity` now
attaches to the main window only; its optional `pet` argument exists for
isolated previews.
