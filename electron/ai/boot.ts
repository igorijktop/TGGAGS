// Registers tools and hooks that live in other modules with the agent runtime.
import { registerBuiltinFactory } from './tools/registry'
import { lspTool } from './tools/builtin/lsp'
import { runtime } from './runtime'
import { lsp } from '../dev/lsp'

let booted = false
export function bootAi(): void {
  if (booted) return
  booted = true
  registerBuiltinFactory(() => [lspTool])
  runtime.registerPostEdit(paths => lsp.diagnosticsAfterEdit(paths))
}
