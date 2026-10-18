import { ChevronDown, FlaskConical } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

export interface SessionModeOption {
  readonly value: string
  readonly label: string
  readonly description?: string
}

export const SESSION_MODE_OPTIONS: readonly SessionModeOption[] = [
  { value: 'auto', label: 'Auto', description: 'Fast, direct execution' },
  { value: 'goal', label: 'Goal', description: 'Delivery closure with the swarm playbook' },
]

const MODE_DOT: Readonly<Record<string, string>> = {
  auto: 'bg-primary',
  goal: 'bg-destructive',
}

/**
 * Experimental Auto/Goal switch. Auto and Goal are opencode primary agents;
 * both pin deepseek-flash at max effort, so the composer never exposes model
 * or effort separately.
 */
export function SessionModeSelect({ value, options = SESSION_MODE_OPTIONS, disabled, onChange }: {
  readonly value: string
  readonly options?: readonly SessionModeOption[]
  readonly disabled?: boolean
  readonly onChange?: (value: string) => void
}) {
  const { t } = useTranslation()
  const active = options.find((option) => option.value === value)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="sm" disabled={disabled} className="h-7 gap-1.5 px-2 text-[12px]" />}
        aria-label={t('sessionMode.label', { defaultValue: 'Session mode' })}
      >
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${MODE_DOT[active?.value ?? ''] ?? 'bg-muted-foreground'}`} aria-hidden />
        <span>{active?.label ?? value}</span>
        <FlaskConical size={11} className="text-muted-foreground/70" aria-hidden />
        <ChevronDown size={13} aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-64">
        <DropdownMenuRadioGroup value={value} onValueChange={(next) => onChange?.(next)}>
          {/* GroupLabel must live inside a Menu.Group/RadioGroup; a sibling
              label throws Base UI error #31 when the menu opens. */}
          <DropdownMenuLabel className="flex items-center justify-between gap-2">
            <span>{t('sessionMode.label', { defaultValue: 'Session mode' })}</span>
            <span className="rounded-full border border-border/70 px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground">
              {t('sessionMode.experimental', { defaultValue: 'Experimental' })}
            </span>
          </DropdownMenuLabel>
          {options.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value} closeOnClick className="min-h-9 px-2.5 pr-8">
              <span className="flex min-w-0 flex-col">
                <span className="flex items-center gap-1.5 text-[12px]">
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${MODE_DOT[option.value] ?? 'bg-muted-foreground'}`} aria-hidden />
                  {option.label}
                </span>
                {option.description && <span className="truncate text-[10px] text-muted-foreground">{option.description}</span>}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
