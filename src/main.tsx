import { createRoot } from 'react-dom/client'
import './styles/base.css'
import './styles/ui.css'
import './styles/shell.css'
import './styles/explorer.css'
import { App } from './App'

createRoot(document.getElementById('root')!).render(<App />)
