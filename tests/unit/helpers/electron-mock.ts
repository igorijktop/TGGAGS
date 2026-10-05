// Minimal stand-in for the `electron` module so main-process code can run under vitest.
export const app = {
  getPath: () => process.env.TGG_USER_DATA ?? '/tmp/tgg-test', isReady: () => false, getName: () => 'tggags-test', getVersion: () => '0.0.0', isPackaged: false,
  getAppPath: () => process.cwd(), quit() {}, exit() {}, relaunch() {}, setPath() {}, setName() {}
}
export const BrowserWindow = { getAllWindows: () => [] as unknown[], getFocusedWindow: () => null }
export const safeStorage = { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() }
export const shell = { trashItem: async () => undefined, showItemInFolder() {}, openExternal: async () => undefined, openPath: async () => '' }
export const net = { fetch: (...a: Parameters<typeof fetch>) => fetch(...a) }
export const dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: true }) }
export const ipcMain = { handle() {} }
export const screen = { getPrimaryDisplay: () => ({ workArea: { width: 1920, height: 1080 } }) }
export const protocol = { registerSchemesAsPrivileged() {}, handle() {} }
export const Menu = { setApplicationMenu() {} }
export default {}
