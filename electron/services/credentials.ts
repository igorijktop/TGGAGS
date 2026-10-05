import { safeStorage } from 'electron'
import { dataPath } from './paths'
import { readJsonSync, writeJsonSync } from './storage'

type Vault = Record<string, string>

/**
 * Secret storage. Values are encrypted with the OS keychain (DPAPI on Windows,
 * Keychain on macOS, libsecret on Linux) through Electron's safeStorage. When the
 * OS cannot provide encryption they are obfuscated and the UI is told via `secure()`.
 */
class CredentialService {
  private file = () => dataPath('credentials.json')
  private vault: Vault | null = null

  private load(): Vault {
    if (!this.vault) this.vault = readJsonSync<Vault>(this.file(), {})
    return this.vault
  }

  secure(): boolean {
    try { return safeStorage.isEncryptionAvailable() } catch { return false }
  }

  set(key: string, value: string): void {
    const v = this.load()
    if (!value) { delete v[key] } else if (this.secure()) {
      v[key] = 'enc:' + safeStorage.encryptString(value).toString('base64')
    } else {
      v[key] = 'b64:' + Buffer.from(value, 'utf8').toString('base64')
    }
    writeJsonSync(this.file(), v)
  }

  get(key: string): string | undefined {
    const raw = this.load()[key]
    if (!raw) return undefined
    try {
      if (raw.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(raw.slice(4), 'base64'))
      if (raw.startsWith('b64:')) return Buffer.from(raw.slice(4), 'base64').toString('utf8')
    } catch { return undefined }
    return undefined
  }

  has(key: string): boolean { return !!this.load()[key] }
  delete(key: string): void { const v = this.load(); delete v[key]; writeJsonSync(this.file(), v) }
  keys(): string[] { return Object.keys(this.load()) }
}

export const credentials = new CredentialService()
