import { useThemeStore } from './store'
import {
  paletteAppearance,
  resolveEffectiveSlot,
  type ThemePaletteId,
  type ThemePreferenceSlot,
} from './palettes'

/**
 * Resolve which preference slot is active. Auto always selects Night; a
 * palette's own light/dark appearance does not influence slot selection.
 */
export function useEffectivePreferenceSlot(): ThemePreferenceSlot {
  const theme = useThemeStore((s) => s.theme)
  return resolveEffectiveSlot(theme)
}

/** The concrete semantic card selected for the currently active slot. */
export function useEffectivePalette(): ThemePaletteId {
  const slot = useEffectivePreferenceSlot()
  const dayPalette = useThemeStore((s) => s.dayPalette)
  const nightPalette = useThemeStore((s) => s.nightPalette)
  return slot === 'night' ? nightPalette : dayPalette
}

/**
 * Resolve the active card's intrinsic appearance. Use this for JS surfaces
 * such as xterm and chart redraws; assigning Midnight to Day must still report
 * a dark color scheme to the shell.
 */
export function useEffectiveTheme(): 'light' | 'dark' {
  return paletteAppearance(useEffectivePalette())
}
