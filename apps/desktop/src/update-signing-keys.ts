/**
 * Linux native auto-update trust anchors.
 *
 * Stage 0 (this build): there is no published signed Linux feed and
 * electron-updater's RPM path installs with `--nogpgcheck`. Auto-update is
 * therefore disabled on Linux rather than silently trusting an unsigned
 * `beta-linux.yml` + RPM. Set `signedLinuxFeed` only after the release
 * pipeline publishes a signed manifest and the public key below is pinned.
 *
 * The private key never belongs in this repository or the app bundle.
 */
export const OPENALICE_APP_ID = 'com.traderalice.openalice'

export interface SignedLinuxFeed {
  /** HTTPS directory containing `<channel>-linux-update.json` and `.sig`. */
  readonly feedUrl: string
  /** Ed25519 SPKI PEM pinned at build time. */
  readonly publicKeyPem: string
  /** Key id embedded in the detached signature envelope. */
  readonly keyId: string
}

export const LINUX_SIGNED_UPDATE_FEED: SignedLinuxFeed | null = null
