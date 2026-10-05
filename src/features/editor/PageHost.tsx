import { lazy, Suspense } from 'react'
import { Spinner } from '../../components/ui'
import type { Tab } from '../../stores/editor'
import { Home, MarkdownPreview } from '../home/Home'

const SettingsPage = lazy(() => import('../settings/SettingsPage').then(m => ({ default: m.SettingsPage })))
const ModelsPage = lazy(() => import('../models/ModelsPage').then(m => ({ default: m.ModelsPage })))
const AgentsPage = lazy(() => import('../agents/AgentsPage').then(m => ({ default: m.AgentsPage })))
const ImagesPage = lazy(() => import('../images/ImagesPage').then(m => ({ default: m.ImagesPage })))
const BenchPage = lazy(() => import('../models/BenchPage').then(m => ({ default: m.BenchPage })))
const ChangesPage = lazy(() => import('../ai/ChangesPage').then(m => ({ default: m.ChangesPage })))
const ExtensionPage = lazy(() => import('../extensions/ExtensionPage').then(m => ({ default: m.ExtensionPage })))
const PullPage = lazy(() => import('../github/PullPage').then(m => ({ default: m.PullPage })))
const CommitPage = lazy(() => import('../scm/CommitPage').then(m => ({ default: m.CommitPage })))

export function PageHost({ tab }: { tab: Tab }) {
  const fallback = <div className="center grow"><Spinner size={18} /></div>
  return <Suspense fallback={fallback}>{(() => {
    switch (tab.page) {
      case 'home': return tab.data?.markdown ? <MarkdownPreview path={tab.data.markdown as string} /> : <Home />
      case 'settings': return <SettingsPage section={tab.data?.section as string | undefined} />
      case 'models': return <ModelsPage />
      case 'agents': return <AgentsPage agentId={tab.data?.agent as string | undefined} />
      case 'images': return <ImagesPage assetId={tab.data?.asset as string | undefined} />
      case 'bench': return <BenchPage />
      case 'changes': return <ChangesPage sessionId={tab.data?.sessionId as string} />
      case 'extension': return <ExtensionPage id={tab.data?.id as string} />
      case 'github-pr': return <PullPage number={tab.data?.number as number} />
      case 'commit': return <CommitPage hash={tab.data?.hash as string} />
      default: return null
    }
  })()}</Suspense>
}
