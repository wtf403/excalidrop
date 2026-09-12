import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import '@excalidraw/excalidraw/index.css'

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element not found');
}

// Disallow canvas camera zoom when the gesture starts on UI chrome.
//
// Excalidraw zooms on ctrl/meta+wheel anywhere inside its container,
// including toolbars, menus, dialogs and our own overlays (.pill, .toast,
// .login-panel). That makes scrolling a menu or pinching over a button
// unexpectedly move the canvas camera. Capture the wheel before Excalidraw
// sees it: zoom gestures whose target is NOT the drawing canvas itself are
// swallowed, while gestures on the canvas pass through untouched. Plain
// (non-zoom) wheel scrolls are never blocked so menus stay scrollable.
// Browser page zoom (ctrl+wheel scaling the document) is prevented globally.
const isCanvasTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.closest('.excalidraw__canvas canvas, .excalidraw__canvas') !== null
  )
}

window.addEventListener(
  'wheel',
  (e: WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return
    // Always block browser page zoom.
    e.preventDefault()
    // Block canvas camera zoom unless the gesture started on the canvas.
    if (!isCanvasTarget(e.target)) e.stopPropagation()
  },
  { passive: false, capture: true },
)

// Safari trackpad pinch fires gesturestart/gesturechange (page zoom).
window.addEventListener('gesturestart', (e: Event) => e.preventDefault(), {
  passive: false,
} as AddEventListenerOptions)
window.addEventListener('gesturechange', (e: Event) => e.preventDefault(), {
  passive: false,
} as AddEventListenerOptions)

// Double-tap pinch-zoom leftovers: never let ctrl/meta keydown zoom shortcuts
// reach the browser (Excalidraw binds its own zoom keys on the canvas).
window.addEventListener(
  'keydown',
  (e: KeyboardEvent) => {
    if (
      (e.ctrlKey || e.metaKey) &&
      (e.key === '+' || e.key === '-' || e.key === '=' || e.key === '0')
    ) {
      e.preventDefault()
    }
  },
  { capture: true },
)

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)