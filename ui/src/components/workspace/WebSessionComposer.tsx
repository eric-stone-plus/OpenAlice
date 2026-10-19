import type { ChatComposerProps } from '../conversation/ChatComposer'
import { ChatComposer } from '../conversation/ChatComposer'
import type { WebSessionConfigOption } from './api'
import { SessionModeSelect } from './SessionModeSelect'

/**
 * Composer for a live GUI conversation. Model and effort are intentionally
 * absent: Trade is the only primary-agent mode OpenAlice exposes, pinned to
 * deepseek-flash at max effort. Auto and Goal stay in the global opencode
 * config as the terminal's generic modes.
 */
export function WebSessionComposer(props: {
  composer: ChatComposerProps
  configOptions?: readonly WebSessionConfigOption[]
  busy?: boolean
  onConfigure?: (configId: string, value: string) => Promise<void> | void
}) {
  const mode = props.configOptions?.find((option) => option.id === 'mode')
  const options = mode
    ? mode.options
        .filter((option) => option.value === 'trade')
        .map((option) => ({
          value: option.value,
          label: option.name,
          ...(option.description ? { description: option.description } : {}),
        }))
    : []
  // Pre-Trade sessions may still run the generic Auto/Goal agents; they keep
  // that mode and show no switch. A fresh OpenAlice workspace Session is Trade,
  // and that is the only mode this control offers.
  if (!mode || mode.currentValue !== 'trade' || options.length === 0) {
    return <ChatComposer {...props.composer} />
  }
  return (
    <ChatComposer
      {...props.composer}
      controls={(
        <SessionModeSelect
          value={mode.currentValue}
          options={options}
          disabled={props.busy}
          onChange={(value) => {
            void Promise.resolve(props.onConfigure?.('mode', value)).catch((error) => {
              console.error('web_session.configure_failed', error)
            })
          }}
        />
      )}
    />
  )
}
