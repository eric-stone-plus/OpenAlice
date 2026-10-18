import type { ChatComposerProps } from '../conversation/ChatComposer'
import { ChatComposer } from '../conversation/ChatComposer'
import type { WebSessionConfigOption } from './api'
import { SESSION_MODE_OPTIONS, SessionModeSelect } from './SessionModeSelect'

/**
 * Composer for a live GUI conversation. Model and effort are intentionally
 * absent: both Auto and Goal are opencode primary agents pinned to
 * deepseek-flash at max effort. The only runtime choice is the session mode,
 * which is an experimental OpenAlice surface for now.
 */
export function WebSessionComposer(props: {
  composer: ChatComposerProps
  configOptions?: readonly WebSessionConfigOption[]
  busy?: boolean
  onConfigure?: (configId: string, value: string) => Promise<void> | void
}) {
  const mode = props.configOptions?.find((option) => option.id === 'mode')
  const advertised = mode
    ? mode.options
        .filter((option) => option.value === 'auto' || option.value === 'goal')
        .map((option) => ({
          value: option.value,
          label: option.name,
          ...(option.description ? { description: option.description } : {}),
        }))
    : []
  const options = advertised.length > 0 ? advertised : SESSION_MODE_OPTIONS
  return (
    <ChatComposer
      {...props.composer}
      controls={(
        <SessionModeSelect
          value={mode?.currentValue ?? 'auto'}
          options={options}
          disabled={props.busy}
          onChange={(value) => { void props.onConfigure?.('mode', value) }}
        />
      )}
    />
  )
}
