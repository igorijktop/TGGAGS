// Registers tools and hooks that live in other modules with the agent runtime.
import { registerBuiltinFactory } from './tools/registry'
import { lspTool } from './tools/builtin/lsp'
import { imageTool, githubTool } from './tools/builtin/extras'
import { runtime } from './runtime'
import { lsp } from '../dev/lsp'
import { mcp } from '../ext/mcp'
import { extensions } from '../ext/extensions'

let booted = false
export function bootAi(): void {
  if (booted) return
  booted = true
  registerBuiltinFactory(() => [lspTool, imageTool, githubTool])
  runtime.registerPostEdit(paths => lsp.diagnosticsAfterEdit(paths))
  mcp.init()
  extensions.init()
}
