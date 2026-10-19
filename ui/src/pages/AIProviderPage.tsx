/**
 * AI Provider — native-only status surface.
 *
 * OpenAlice desktop runs opencode with the shared opencode config/auth store
 * (DeepSeek). The app does not own a provider vault for this runtime: no API
 * key is stored, injected, or exposed here. This page is intentionally a
 * read-only summary so the settings category still answers "which AI provider
 * is in use?" without offering a second provider route.
 */

import { useTranslation } from 'react-i18next'
import { Bot, KeyRound, ShieldCheck } from 'lucide-react'

import { PageHeader } from '../components/PageHeader'
import { SettingsScrollArea } from '../components/form'
import { AgentRuntimeIcon } from '../lib/agentRuntimeIcon'

export function AIProviderPage() {
  const { t } = useTranslation()

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <PageHeader title={t('aiProvider.title')} />
      <SettingsScrollArea className="px-4 py-5 md:px-8">
        <div className="mx-auto flex max-w-[860px] flex-col gap-5">
          <p className="text-[12.5px] leading-5 text-muted-foreground">
            {t('aiProvider.nativeDescription')}
          </p>

          <section className="rounded-xl border border-border bg-background px-4 py-4 sm:px-5">
            <div className="flex min-w-0 items-start gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/30">
                <AgentRuntimeIcon agentId="opencode" className="size-6" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <h2 className="text-[15px] font-semibold text-foreground">
                    {t('aiProvider.nativeTitle')}
                  </h2>
                  <span className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-muted/40 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                    <ShieldCheck className="size-3" aria-hidden="true" />
                    {t('aiProvider.nativeManaged')}
                  </span>
                </div>
                <p className="mt-1 text-[12px] leading-5 text-muted-foreground">
                  {t('aiProvider.nativeHelp')}
                </p>

                <dl className="mt-4 grid gap-3 border-t border-border/60 pt-4 sm:grid-cols-2">
                  <div className="min-w-0">
                    <dt className="text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground/80">
                      {t('aiProvider.nativeModelLabel')}
                    </dt>
                    <dd className="mt-0.5 font-mono text-[12.5px] text-foreground">
                      deepseek/deepseek-flash
                    </dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground/80">
                      {t('aiProvider.nativeEffortLabel')}
                    </dt>
                    <dd className="mt-0.5 text-[12.5px] text-foreground">max</dd>
                  </div>
                  <div className="min-w-0 sm:col-span-2">
                    <dt className="text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground/80">
                      {t('aiProvider.nativeAuthLabel')}
                    </dt>
                    <dd className="mt-0.5 flex items-center gap-1.5 text-[12.5px] text-foreground">
                      <KeyRound className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                      {t('aiProvider.nativeAuthValue')}
                    </dd>
                  </div>
                </dl>
              </div>
            </div>
          </section>

          <div className="flex items-start gap-2 rounded-lg border border-border/70 bg-muted/20 px-3.5 py-3 text-[12px] leading-5 text-muted-foreground">
            <Bot className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <p className="min-w-0 flex-1">{t('aiProvider.nativeFooter')}</p>
          </div>
        </div>
      </SettingsScrollArea>
    </div>
  )
}
