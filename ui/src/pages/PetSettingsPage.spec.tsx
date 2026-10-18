// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import '../i18n'
import { i18n } from '../i18n'
import { PetSettingsPage } from './PetSettingsPage'

beforeAll(async () => { await i18n.changeLanguage('en') })
afterEach(() => { cleanup(); Reflect.deleteProperty(window, 'openAlice') })

describe('Pet settings page', () => {
  it('explains the desktop boundary in a browser', () => {
    render(<PetSettingsPage />)

    expect(screen.getByText(/desktop app/)).toBeTruthy()
    expect(screen.queryByRole('slider')).toBeNull()
  })
})
