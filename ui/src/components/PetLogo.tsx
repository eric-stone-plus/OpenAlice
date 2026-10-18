import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import aliceLogo from '../assets/alice-logo.png'
import './PetLogo.css'

/** Alice's own words in Carroll's original novel; the welcome-screen mascot. */
const LINES = [
  'Curiouser and curiouser!',
  'What a curious feeling!',
  'Do cats eat bats?',
  'I’m growing.',
  'There’s plenty of room!',
  'Yes, please do!',
  'Nonsense!',
  'I won’t!',
] as const

/**
 * The desktop pet used to be a separate native window. It is now part of the
 * welcome screen: a floating Alice mark that speaks a line when clicked, so it
 * can never cover the app or drift off-screen.
 */
export function PetLogo() {
  const { t } = useTranslation()
  const [quote, setQuote] = useState<string | null>(null)
  const hideTimer = useRef<number | undefined>(undefined)
  const nextLine = useRef(0)
  const label = t('pet.speakQuote')

  useEffect(() => () => window.clearTimeout(hideTimer.current), [])

  const speak = () => {
    setQuote(LINES[nextLine.current % LINES.length]!)
    nextLine.current += 1
    window.clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => setQuote(null), 4500)
  }

  return (
    <div className="oa-pet-logo relative mb-4 flex flex-col items-center">
      <div
        role="status"
        aria-live="polite"
        className={quote !== null
          ? 'oa-pet-logo__bubble absolute bottom-[calc(100%+0.5rem)] left-1/2 z-10 w-max max-w-[15rem] -translate-x-1/2 rounded-xl border border-border/70 bg-popover px-3 py-1.5 text-[12px] leading-5 text-popover-foreground shadow-lg'
          : 'sr-only'}
      >
        {quote !== null && (
          <>
            <span lang="en">{quote}</span>
            <span
              aria-hidden
              className="absolute left-1/2 top-full size-2 -translate-x-1/2 -translate-y-1/2 rotate-45 border-b border-r border-border/70 bg-popover"
            />
          </>
        )}
      </div>
      <button
        type="button"
        aria-label={label}
        title={label}
        onClick={speak}
        className="oa-pet-logo__button relative flex size-[180px] items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring @min-[42rem]/harness:size-[220px]"
      >
        <img
          src={aliceLogo}
          alt=""
          draggable={false}
          className="oa-pet-logo__art size-full select-none object-contain"
        />
      </button>
    </div>
  )
}
