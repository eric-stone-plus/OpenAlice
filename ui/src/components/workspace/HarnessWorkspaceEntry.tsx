import { ArrowRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '../ui/button'

/** Navigation hint shown when a harness has workspaces but none is selected. */
export function HarnessWorkspaceEntry({ onOpen }: { onOpen: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="px-2 pb-1 pt-1">
      <p className="text-[12px] leading-[18px] text-muted-foreground">
        {t('harnessNavigation.selectHint')}
      </p>
      <Button variant="ghost" onClick={onOpen}
        className="mt-1 h-auto min-h-10 max-w-full justify-start gap-2 px-0 text-left text-[13px] font-medium whitespace-normal hover:bg-transparent hover:text-primary md:min-h-8">
        <span>{t('harnessNavigation.selectAction')}</span>
        <ArrowRight className="size-3.5" aria-hidden />
      </Button>
    </div>
  )
}
