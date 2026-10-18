export interface Rect { x: number; y: number; width: number; height: number }

/**
 * Transparent space inside the companion window that is not part of the
 * visible character. The window reserves gutters for speech bubbles, so
 * clamping the whole window to the work area leaves the character stranded
 * roughly one window-third away from every edge. Clamp the visible box
 * instead and let the transparent gutters extend off-screen.
 */
export interface CompanionInsets { left: number; right: number; top: number; bottom: number }

const NO_INSETS: CompanionInsets = { left: 0, right: 0, top: 0, bottom: 0 }

/** Electron screen coordinates are DIPs on both macOS and Windows. */
export function settleCompanion(
  bounds: Rect,
  area: Rect,
  snap = true,
  insets: CompanionInsets = NO_INSETS,
): Rect & { flipped: boolean } {
  const visibleWidth = Math.max(0, bounds.width - insets.left - insets.right)
  const visibleHeight = Math.max(0, bounds.height - insets.top - insets.bottom)
  const minX = area.x - insets.left
  const maxX = area.x + Math.max(0, area.width - visibleWidth) - insets.left
  const minY = area.y - insets.top
  const maxY = area.y + Math.max(0, area.height - visibleHeight) - insets.top
  let x = Math.min(maxX, Math.max(minX, bounds.x))
  let y = Math.min(maxY, Math.max(minY, bounds.y))
  if (snap) {
    // Upstream v3 defaults: left/right 10%, bottom 15%, top disabled.
    const centerX = x + insets.left + visibleWidth / 2
    // Width includes bubble gutters; character size is derived from stage height.
    const centerY = y + bounds.height - bounds.height / 1.65 * .45
    if (centerX < area.x + area.width * .1) x = minX
    else if (centerX > area.x + area.width * .9) x = maxX
    if (centerY > area.y + area.height * .85) y = maxY
  }
  const visibleCenterX = x + insets.left + visibleWidth / 2
  return { ...bounds, x: Math.round(x), y: Math.round(y), flipped: visibleCenterX < area.x + area.width / 2 }
}

/** CSS `ease` (0.25, 0.1, 0.25, 1), for the upstream 160ms snap. */
export function snapEase(progress: number): number {
  const p = Math.max(0, Math.min(1, progress))
  let low = 0, high = 1
  for (let i = 0; i < 18; i++) {
    const t = (low + high) / 2, u = 1 - t
    const x = 3 * u * u * t * .25 + 3 * u * t * t * .25 + t * t * t
    if (x < p) low = t
    else high = t
  }
  const t = (low + high) / 2, u = 1 - t
  return 3 * u * u * t * .1 + 3 * u * t * t + t * t * t
}
