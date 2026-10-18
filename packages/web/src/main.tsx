import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './app.css'
import { App } from './App'
import { ViewsGallery } from './views'

// `#gallery` renders every fixture through its view: a dev page for eyeballing views and taking screenshots.
const gallery = typeof location !== 'undefined' && location.hash === '#gallery'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {gallery ? <ViewsGallery /> : <App />}
  </StrictMode>,
)
