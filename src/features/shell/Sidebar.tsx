import type { ReactElement } from 'react'
import { useUi, type SidebarView } from '../../stores/ui'
import { Explorer } from '../explorer/Explorer'
import { SearchView } from '../search/SearchView'
import { ScmView } from '../scm/ScmView'
import { RunView } from '../debug/RunView'
import { ExtensionsView } from '../extensions/ExtensionsView'
import { SessionsView } from '../ai/SessionsView'
import { AgentsView } from '../agents/AgentsView'
import { ModelsView } from '../models/ModelsView'
import { ImagesView } from '../images/ImagesView'
import { GithubView } from '../github/GithubView'

const VIEWS: Record<SidebarView, () => ReactElement> = {
  explorer: () => <Explorer />, search: () => <SearchView />, scm: () => <ScmView />, run: () => <RunView />, extensions: () => <ExtensionsView />,
  ai: () => <SessionsView />, agents: () => <AgentsView />, models: () => <ModelsView />, images: () => <ImagesView />, github: () => <GithubView />
}

export function Sidebar() {
  const view = useUi(s => s.sidebarView)
  const V = VIEWS[view]
  return <div className="col grow" style={{ minHeight: 0 }} key={view}><V /></div>
}
