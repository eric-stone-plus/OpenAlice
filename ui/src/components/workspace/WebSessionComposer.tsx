import type { ChatComposerProps } from '../conversation/ChatComposer'
import { ChatComposer } from '../conversation/ChatComposer'
import type { WebSessionConfigOption } from './api'
import { SessionModeSelect } from './SessionModeSelect'

/**
 * Composer for a live GUI conversation. Model and effort are intentionally
 * absent: both Auto and Goal are opencode primary agents pinned to
 * deepseek-flash at max effort. Only runtimes that advertise a mode select get
 * the experimental Auto/Goal switch.
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
        .filter((option) => option.value === 'auto' || option.value === 'goal')
        .map((option) => ({
          value: option.value,
          label: option.name,
          ...(option.description ? { description: option.description } : {}),
        }))
    : []
  if (options.length === 0) return <ChatComposer {...props.composer} />
  return (
    <ChatComposer
      {...props.composer}
      controls={(
        <SessionModeSelect
          value={mode?.currentValue ?? 'auto'}
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
