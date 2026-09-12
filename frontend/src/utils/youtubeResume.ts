/**
 * YouTube resume for Excalidraw embeds.
 *
 * Local-only, per-browser: playback positions live in localStorage keyed by
 * video id, and each YouTube iframe's `start=` param is patched in the DOM
 * before playback begins. The shared scene is never modified, so positions
 * can't leak into GitHub commits or fight collaborators.
 *
 * Depends on Excalidraw building embeds as
 * `https://www.youtube.com/embed/<id>?enablejsapi=1...`, which lets us use
 * the YouTube IFrame postMessage API (`listening` / `infoDelivery`) the same
 * way Excalidraw itself does for its center-click play/pause.
 */

const KEY_PREFIX = 'excalidrop_yt_'
const MIN_SAVE_SECS = 10 // ignore intros / accidental opens
const END_MARGIN_SECS = 30 // this close to the end counts as finished
const RESUME_DIFF_SECS = 10 // don't reload the iframe for a ~same offset
const FLUSH_MS = 5000 // throttle localStorage writes while playing
const PING_MS = 10000 // re-subscribe iframes to infoDelivery
const MAX_AGE_MS = 180 * 24 * 3600 * 1000 // forget positions after 6 months

const YT_ORIGINS = new Set(['https://www.youtube.com', 'https://www.youtube-nocookie.com'])

// YouTube IFrame API player states.
const PLAYER_ENDED = 0
const PLAYER_PLAYING = 1
const PLAYER_PAUSED = 2
const PLAYER_BUFFERING = 3

interface SavedProgress {
  t: number
  d: number | null
  at: number
}

const isYoutubeEmbed = (src: string): boolean =>
  /https:\/\/(?:www\.)?youtube(?:-nocookie)?\.com\/embed\//.test(src)

/** `.../embed/<videoId>` or `.../embed/videoseries?list=<listId>`. */
const parseEmbedSrc = (src: string): { key: string } | null => {
  let url: URL
  try {
    url = new URL(src)
  } catch {
    return null
  }
  const host = url.hostname.replace(/^www\./, '')
  if (host !== 'youtube.com' && host !== 'youtube-nocookie.com') return null
  const seg = url.pathname.match(/^\/embed\/([a-zA-Z0-9_-]+)/)?.[1]
  if (!seg) return null
  if (seg === 'videoseries') {
    const list = url.searchParams.get('list')
    if (!list) return null
    return { key: `${KEY_PREFIX}list_${list}` }
  }
  return { key: `${KEY_PREFIX}${seg}` }
}

const readSaved = (key: string): SavedProgress | null => {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<SavedProgress>
    if (typeof parsed.t !== 'number' || !(parsed.t > 0)) return null
    if (typeof parsed.at === 'number' && Date.now() - parsed.at > MAX_AGE_MS) {
      try { localStorage.removeItem(key) } catch { /* ignore */ }
      return null
    }
    const d = typeof parsed.d === 'number' && parsed.d > 0 ? parsed.d : null
    if (d !== null && parsed.t > d - END_MARGIN_SECS) return null // watched to the end
    return { t: parsed.t, d, at: typeof parsed.at === 'number' ? parsed.at : 0 }
  } catch {
    return null
  }
}

/** New iframe src with the saved `start=` injected, or null when no patch needed. */
const resumeSrc = (src: string): string | null => {
  const ref = parseEmbedSrc(src)
  if (!ref) return null
  const saved = readSaved(ref.key)
  if (!saved || saved.t < MIN_SAVE_SECS) return null
  let url: URL
  try {
    url = new URL(src)
  } catch {
    return null
  }
  const current = url.searchParams.has('start') ? Number(url.searchParams.get('start')) : NaN
  if (Number.isFinite(current) && Math.abs(current - saved.t) < RESUME_DIFF_SECS) return null
  url.searchParams.set('start', String(Math.floor(saved.t)))
  return url.toString()
}

const youtubeIframes = (): HTMLIFrameElement[] => {
  const out: HTMLIFrameElement[] = []
  try {
    document
      .querySelectorAll<HTMLIFrameElement>('iframe.excalidraw__embeddable')
      .forEach((frame) => {
        if (typeof frame.src === 'string' && isYoutubeEmbed(frame.src)) out.push(frame)
      })
  } catch { /* DOM not ready — caller retries on the next tick */ }
  return out
}

export function installYoutubeResume(): () => void {
  // Latest known position per storage key (memory first, localStorage throttled).
  const latest = new Map<string, { t: number; d: number | null }>()
  const dirty = new Set<string>()
  const lastPersistAt = new Map<string, number>()
  const playerState = new Map<string, number>()
  // An iframe already carrying the right `start=` (or deliberately skipped
  // because playback had begun) is never re-patched — rewriting src mid-watch
  // would restart the video.
  const settled = new WeakSet<HTMLIFrameElement>()

  const persist = (key: string): void => {
    const entry = latest.get(key)
    if (!entry) {
      dirty.delete(key)
      return
    }
    lastPersistAt.set(key, Date.now())
    dirty.delete(key)
    try {
      const payload: SavedProgress = { t: entry.t, d: entry.d, at: Date.now() }
      localStorage.setItem(key, JSON.stringify(payload))
    } catch { /* quota / private mode — resume just won't stick */ }
  }

  const flushDirty = (force: boolean): void => {
    const now = Date.now()
    dirty.forEach((key) => {
      if (force || now - (lastPersistAt.get(key) ?? 0) >= FLUSH_MS) persist(key)
    })
  }

  const noteProgress = (key: string, time: number, duration: number | null, immediate: boolean): void => {
    if (!(time > 0)) return
    if (duration !== null && duration > 0 && time > duration - END_MARGIN_SECS) {
      // Watched (nearly) to the end — forget it so next open starts over.
      latest.delete(key)
      dirty.delete(key)
      try { localStorage.removeItem(key) } catch { /* ignore */ }
      return
    }
    if (time < MIN_SAVE_SECS) return
    latest.set(key, { t: time, d: duration })
    dirty.add(key)
    if (immediate) persist(key)
  }

  const pingListening = (frame: HTMLIFrameElement): void => {
    try {
      frame.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: 'excalidrop-resume' }), '*')
    } catch { /* iframe tearing down — next sweep retries */ }
  }

  const maybePatch = (frame: HTMLIFrameElement): void => {
    if (settled.has(frame)) return
    const ref = parseEmbedSrc(frame.src)
    const state = ref ? playerState.get(ref.key) : undefined
    if (state === PLAYER_PLAYING || state === PLAYER_PAUSED || state === PLAYER_BUFFERING) {
      settled.add(frame) // playback already began — hands off
      return
    }
    settled.add(frame)
    let next: string | null = null
    try {
      next = resumeSrc(frame.src)
    } catch { next = null }
    if (next) {
      try { frame.src = next } catch { /* ignore */ }
    }
  }

  const sweep = (): void => {
    for (const frame of youtubeIframes()) {
      maybePatch(frame)
      pingListening(frame)
    }
  }

  const keyForSource = (source: MessageEventSource | null): string | null => {
    if (!source) return null
    for (const frame of youtubeIframes()) {
      let win: WindowProxy | null = null
      try { win = frame.contentWindow } catch { continue }
      if (win && win === source) return parseEmbedSrc(frame.src)?.key ?? null
    }
    return null
  }

  const onMessage = (event: MessageEvent): void => {
    if (!YT_ORIGINS.has(event.origin)) return
    let data: unknown = null
    try {
      data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data
    } catch {
      return
    }
    const msg = data as { event?: unknown; info?: unknown } | null
    if (!msg || msg.event !== 'infoDelivery' || typeof msg.info !== 'object' || msg.info === null) return
    const info = msg.info as { currentTime?: unknown; duration?: unknown; playerState?: unknown }
    if (typeof info.currentTime !== 'number') return
    const key = keyForSource(event.source)
    if (!key) return
    const duration = typeof info.duration === 'number' ? info.duration : null
    const state = typeof info.playerState === 'number' ? info.playerState : null
    if (state !== null) playerState.set(key, state)
    if (state === PLAYER_ENDED) {
      latest.delete(key)
      dirty.delete(key)
      try { localStorage.removeItem(key) } catch { /* ignore */ }
      return
    }
    noteProgress(key, info.currentTime, duration, state === PLAYER_PAUSED)
  }

  const onAddedNode = (node: Node): void => {
    if (node instanceof HTMLIFrameElement) {
      if (node.classList.contains('excalidraw__embeddable') && isYoutubeEmbed(node.src)) {
        maybePatch(node)
        window.setTimeout(() => pingListening(node), 800)
      }
      return
    }
    if (node instanceof HTMLElement) {
      let inner: NodeListOf<HTMLIFrameElement> | null = null
      try { inner = node.querySelectorAll<HTMLIFrameElement>('iframe.excalidraw__embeddable') } catch { return }
      inner.forEach((frame) => {
        if (isYoutubeEmbed(frame.src)) {
          maybePatch(frame)
          window.setTimeout(() => pingListening(frame), 800)
        }
      })
    }
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach(onAddedNode)
    }
  })
  try {
    observer.observe(document.body, { childList: true, subtree: true })
  } catch { /* non-fatal — sweeps below still cover late embeds */ }

  sweep()
  window.addEventListener('message', onMessage)
  const flushTimer = window.setInterval(() => flushDirty(false), FLUSH_MS)
  const pingTimer = window.setInterval(() => {
    for (const frame of youtubeIframes()) pingListening(frame)
  }, PING_MS)
  const onVisibility = (): void => {
    if (document.hidden) flushDirty(true)
  }
  const onPageHide = (): void => flushDirty(true)
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('pagehide', onPageHide)

  return () => {
    window.removeEventListener('message', onMessage)
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('pagehide', onPageHide)
    window.clearInterval(flushTimer)
    window.clearInterval(pingTimer)
    observer.disconnect()
    flushDirty(true)
  }
}
