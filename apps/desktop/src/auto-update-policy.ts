import { existsSync } from 'node:fs'
import { join } from 'node:path'

export type AutoUpdateCapability =
  | {
      readonly enabled: true
      readonly configPath: string
    }
  | {
      readonly enabled: false
      readonly reason: 'not-packaged'
      readonly configPath: null
    }
  | {
      readonly enabled: false
      readonly reason: 'missing-config'
      readonly configPath: string
    }
  | {
      readonly enabled: false
      readonly reason: 'unsigned-linux-feed'
      readonly configPath: string
    }

export function resolveAutoUpdateCapability(opts: {
  readonly isPackaged: boolean
  readonly resourcesPath: string
  readonly platform?: NodeJS.Platform
  readonly signedLinuxFeed?: boolean
}): AutoUpdateCapability {
  if (!opts.isPackaged) {
    return { enabled: false, reason: 'not-packaged', configPath: null }
  }

  const configPath = join(opts.resourcesPath, 'app-update.yml')
  if (!existsSync(configPath)) {
    return { enabled: false, reason: 'missing-config', configPath }
  }
  // electron-updater's Linux RPM path invokes rpm with --nogpgcheck. Until a
  // signed manifest + pinned public key are shipped, an unsigned feed must
  // not be able to become a root update channel. Default to the running
  // platform so a caller that omits the field cannot opt out of the gate.
  if ((opts.platform ?? process.platform) === 'linux' && opts.signedLinuxFeed !== true) {
    return { enabled: false, reason: 'unsigned-linux-feed', configPath }
  }
  return { enabled: true, configPath }
}
