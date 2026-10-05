import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import { api } from './lib/api'

function App() {
  const [info, setInfo] = useState('loading…')
  useEffect(() => { void api.app.info().then(i => setInfo(`${i.name} ${i.version} on ${i.platform} (electron ${i.electron})`)) }, [])
  return <div style={{ padding: 40, fontFamily: 'sans-serif' }}><h1>Pipeline OK</h1><p id="info">{info}</p></div>
}
createRoot(document.getElementById('root')!).render(<App />)
