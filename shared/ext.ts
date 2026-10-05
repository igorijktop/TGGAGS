import type { McpServerConfig } from './settings'
import type { ThemeDef } from './themes'

export interface McpToolSummary { name: string; fullName: string; description: string }
export interface McpServerState {
  name: string
  config: McpServerConfig
  scope: 'global' | 'project'
  status: 'connecting' | 'connected' | 'error' | 'disabled' | 'stopped'
  error?: string
  tools: McpToolSummary[]
  resources: { uri: string; name: string; description?: string }[]
  serverInfo?: { name?: string; version?: string }
  logs: string[]
}
export interface McpCatalogEntry { id: string; name: string; description: string; config: McpServerConfig; category: string; needs?: string; homepage?: string }

export interface ExtensionManifest {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  homepage?: string
  main?: string
  permissions?: string[]
  contributes?: {
    tools?: { name: string; description: string; parameters?: Record<string, unknown>; command: string; timeoutMs?: number }[]
    commands?: { name: string; description: string; template: string; agent?: string }[]
    themes?: (Partial<ThemeDef> & { id: string; name: string; kind: 'light' | 'dark'; base?: string })[]
    mcpServers?: Record<string, McpServerConfig>
    keybindings?: { command: string; key: string }[]
  }
}
export interface ExtensionInfo {
  id: string
  manifest: ExtensionManifest
  scope: 'global' | 'project' | 'bundled'
  dir: string
  enabled: boolean
  active: boolean
  error?: string
  tools: string[]
  commands: string[]
  themes: string[]
}
export interface RegistryEntry { id: string; name: string; description: string; version: string; author?: string; downloadUrl: string; homepage?: string }
export interface BundledExtension { id: string; name: string; description: string; version: string; installed: boolean }

export interface McpApi {
  list(): Promise<McpServerState[]>
  restart(name: string): Promise<void>
  setEnabled(name: string, enabled: boolean): Promise<void>
  save(name: string, config: McpServerConfig, scope: 'global' | 'project'): Promise<void>
  remove(name: string): Promise<void>
  catalog(): Promise<McpCatalogEntry[]>
  readResource(server: string, uri: string): Promise<string>
}

export interface ExtensionsApi {
  list(): Promise<ExtensionInfo[]>
  setEnabled(id: string, enabled: boolean): Promise<void>
  installFromFolder(path: string, scope?: 'global' | 'project'): Promise<ExtensionInfo>
  installFromZip(path: string): Promise<ExtensionInfo>
  installFromUrl(url: string): Promise<ExtensionInfo>
  installBundled(id: string): Promise<ExtensionInfo>
  bundled(): Promise<BundledExtension[]>
  uninstall(id: string): Promise<void>
  reload(): Promise<void>
  registry(): Promise<RegistryEntry[]>
  themes(): Promise<ThemeDef[]>
  customTools(): Promise<{ name: string; description: string; source: string; error?: string }[]>
  scaffold(name: string, scope: 'global' | 'project'): Promise<string>
}
