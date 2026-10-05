export interface FileEntry { name: string; path: string; isDir: boolean; isSymlink?: boolean; size: number; mtime: number }

export type ReadFileResult =
  | { kind: 'text'; path: string; content: string; encoding: 'utf8' | 'utf8bom' | 'utf16le'; eol: 'lf' | 'crlf'; size: number; mtime: number }
  | { kind: 'binary'; path: string; size: number; mtime: number; mime: string }
  | { kind: 'tooLarge'; path: string; size: number; mtime: number }

export interface SearchOptions {
  query: string
  isRegex: boolean
  caseSensitive: boolean
  wholeWord: boolean
  include: string
  exclude: string
  maxResults?: number
  useExcludeSettings?: boolean
}
export interface SearchMatch { line: number; col: number; length: number; before: string; text: string; after: string }
export interface SearchFileResult { path: string; rel: string; matches: SearchMatch[] }
export interface SearchResult { files: SearchFileResult[]; totalMatches: number; truncated: boolean; searchedFiles: number; durationMs: number }
