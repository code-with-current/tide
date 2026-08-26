import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { installTauriBridge } from './lib/api/tauri-bridge'
import './index.css'
import App from './App.tsx'

// Bootstrap: install the bridge before the first render/query so the app
// shell never races the mock store. The static App import above has already
// evaluated the module graph (rpc.ts bound `rpc` as null) — that's safe
// because activation re-binds the live `rpc`/`hasRpc` exports, so every
// client.ts call site re-reads them at call time.
await installTauriBridge()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
