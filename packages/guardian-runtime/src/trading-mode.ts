import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { hasSealedMarker, unsealAt } from '@traderalice/sealing-key'

export type GuardianTradingMode = 'lite' | 'readonly' | 'pro'

export interface GuardianTradingModePlan {
  mode: GuardianTradingMode
  source: 'env' | 'config' | 'auto'
  envLocked: boolean
  hasUTAConfig: boolean
}

export function isLiteModeEnv(env: NodeJS.ProcessEnv): boolean {
  return truthyEnv(env['OPENALICE_LITE_MODE']) || truthyEnv(env['OPENALICE_UTA_DISABLED'])
}

export function parseGuardianTradingModeEnv(env: NodeJS.ProcessEnv): GuardianTradingMode | null {
  const raw = env['OPENALICE_TRADING_MODE']?.trim().toLowerCase()
  if (raw === 'lite' || raw === 'readonly' || raw === 'pro') return raw
  return isLiteModeEnv(env) ? 'lite' : null
}

export async function resolveGuardianTradingMode(
  env: NodeJS.ProcessEnv,
  userDataHome: string,
): Promise<GuardianTradingModePlan> {
  const envMode = parseGuardianTradingModeEnv(env)
  const configuredMode = await readPersistedTradingMode(userDataHome)
  const hasUTAConfig = await hasPersistedUTAs(userDataHome, env)
  if (envMode) return { mode: envMode, source: 'env', envLocked: true, hasUTAConfig }
  if (configuredMode) return { mode: configuredMode, source: 'config', envLocked: false, hasUTAConfig }
  return { mode: hasUTAConfig ? 'pro' : 'lite', source: 'auto', envLocked: false, hasUTAConfig }
}

async function readPersistedTradingMode(userDataHome: string): Promise<GuardianTradingMode | null> {
  try {
    const raw = JSON.parse(await readFile(resolve(
      userDataHome,
      'data',
      'config',
      'trading.json',
    ), 'utf8')) as { mode?: unknown }
    return raw.mode === 'lite' || raw.mode === 'readonly' || raw.mode === 'pro' ? raw.mode : null
  } catch (error: unknown) {
    if (!isNodeError(error, 'ENOENT')) {
      console.warn(`[guardian] could not read trading.json: ${errorMessage(error)}`)
    }
    return null
  }
}

async function hasPersistedUTAs(userDataHome: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    const raw = JSON.parse(await readFile(resolve(
      userDataHome,
      'data',
      'config',
      'accounts.json',
    ), 'utf8'))
    const accounts = hasSealedMarker(raw)
      ? await unsealAt(userDataHome, raw, env)
      : raw
    return Array.isArray(accounts) && accounts.length > 0
  } catch (error: unknown) {
    if (!isNodeError(error, 'ENOENT')) {
      console.warn(`[guardian] could not read accounts.json; treating UTA config as absent: ${errorMessage(error)}`)
    }
    return false
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function truthyEnv(raw: string | undefined): boolean {
  if (raw === undefined || raw === '') return false
  const normalized = raw.toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
}
