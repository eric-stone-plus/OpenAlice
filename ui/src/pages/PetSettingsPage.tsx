import { useTranslation } from 'react-i18next'
import { PageHeader } from '../components/PageHeader'
import { SettingsScrollArea } from '../components/form'
import { ActivityPreferencesSection } from './ActivityPreferencesSection'

/** Alice now lives on the welcome screen; this page owns her activity signals. */
export function PetSettingsPage() {
  const { t } = useTranslation()
  return <div className="flex h-full min-h-0 flex-col">
    <PageHeader title={t('pet.title')} />
    <SettingsScrollArea className="px-6">
      <div className="max-w-2xl">
        <ActivityPreferencesSection />
      </div>
    </SettingsScrollArea>
  </div>
}
