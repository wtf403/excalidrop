import React, { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import {
  Excalidraw,
  Footer,
  MainMenu,
  convertToExcalidrawElements,
  CaptureUpdateAction,
  ExcalidrawImperativeAPI,
  exportToBlob,
  exportToSvg
} from '@excalidraw/excalidraw'
import type { ExcalidrawElement, NonDeleted, NonDeletedExcalidrawElement } from '@excalidraw/excalidraw/types/element/types'
import { convertMermaidToExcalidraw, DEFAULT_MERMAID_CONFIG } from './utils/mermaidConverter'
import type { MermaidConfig } from '@excalidraw/mermaid-to-excalidraw'
import { registerCanvasWebMCP } from './utils/webmcp'
import { getAddLibraryUrls, removeHashParams } from './utils/ghSync'
import { fetchLibraryItems } from './utils/library'


type ExcalidrawAPIRefValue = ExcalidrawImperativeAPI;

interface ServerElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  backgroundColor?: string;
  strokeColor?: string;
  strokeWidth?: number;
  roughness?: number;
  opacity?: number;
  text?: string;
  fontSize?: number;
  fontFamily?: string | number;
  label?: {
    text: string;
  };
  createdAt?: string;
  updatedAt?: string;
  version?: number;
  syncedAt?: string;
  source?: string;
  syncTimestamp?: string;
  boundElements?: any[] | null;
  containerId?: string | null;
  locked?: boolean;

  start?: { id: string };
  end?: { id: string };
  strokeStyle?: string;
  endArrowhead?: string;
  startArrowhead?: string;

  fileId?: string;
  status?: string;
  scale?: [number, number];
  angle?: number;
  link?: string | null;
}

interface WebSocketMessage {
  type: string;
  element?: ServerElement;
  elements?: ServerElement[];
  elementId?: string;
  count?: number;
  timestamp?: string;
  source?: string;
  mermaidDiagram?: string;
  config?: MermaidConfig;
}

interface ApiResponse {
  success: boolean;
  elements?: ServerElement[];
  element?: ServerElement;
  files?: Record<string, unknown>;
  count?: number;
  error?: string;
  message?: string;
}

type SyncStatus = 'idle' | 'syncing' | 'success' | 'error';
const authHeaders = (): Record<string, string> => {
  // Static (excalidrop branch) mode stores the user token under excalidrop_gh_token
  // (see utils/ghSync); server mode uses excalidrop_token. Accept both.
  const t = localStorage.getItem('excalidrop_gh_token') || localStorage.getItem('excalidrop_token');
  return t ? { Authorization: `Bearer ${t}` } : {};
};
const AUTO_SYNC_DEBOUNCE_MS = 1200;


// Crash-safe local journal. Network requests fired from beforeunload /
// pagehide fundamentally cannot save reliably: keepalive bodies are capped
// (~64 KiB — a scene PUT almost always exceeds it) and multi-request chains
// (GET sha → PUT) never complete before teardown. So every edit is journaled
// to localStorage (synchronous, guaranteed), unload handlers only do a sync
// journal write, and the next boot restores + pushes whatever never made it.
interface LocalSnapshot {
  updatedAt: number;
  elements: any[];
  base: any[];
  files?: Record<string, any>;
}

const snapshotKeyFor = (repo: { owner: string; repo: string } | null): string =>
  repo ? `excalidrop_snapshot_${repo.owner}_${repo.repo}` : 'excalidrop_snapshot_local'

const readLocalSnapshot = (key: string): LocalSnapshot | null => {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const snap = JSON.parse(raw) as LocalSnapshot
    if (!snap || typeof snap.updatedAt !== 'number' || !Array.isArray(snap.elements)) return null
    return snap
  } catch {
    return null
  }
}

const writeLocalSnapshot = (key: string, elements: any[], base: any[], files?: Record<string, any>): boolean => {
  try {
    localStorage.setItem(key, JSON.stringify({ updatedAt: Date.now(), elements, base, ...(files ? { files } : {}) }))
    return true
  } catch {
    // Image dataURLs can exceed the ~5MB localStorage quota — fall back to
    // an elements-only journal rather than losing everything.
    try {
      localStorage.setItem(key, JSON.stringify({ updatedAt: Date.now(), elements, base }))
      return true
    } catch {
      return false
    }
  }
}

const clearLocalSnapshot = (key: string): void => {
  try {
    localStorage.removeItem(key)
  } catch { /* non-fatal */ }
}

const cleanElementForExcalidraw = (element: ServerElement): Partial<ExcalidrawElement> => {  const {
    createdAt,
    updatedAt,
    version,
    syncedAt,
    source,
    syncTimestamp,
    ...cleanElement
  } = element;
  return cleanElement;
}

const validateAndFixBindings = (elements: Partial<ExcalidrawElement>[]): Partial<ExcalidrawElement>[] => {
  const elementMap = new Map(elements.map(el => [el.id!, el]));

  return elements.map(element => {
    const fixedElement = { ...element };

    if (fixedElement.boundElements) {
      if (Array.isArray(fixedElement.boundElements)) {
        fixedElement.boundElements = fixedElement.boundElements.filter((binding: any) => {
          if (!binding || typeof binding !== 'object') return false;
          if (!binding.id || !binding.type) return false;

          const referencedElement = elementMap.get(binding.id);
          if (!referencedElement) return false;

          if (!['text', 'arrow'].includes(binding.type)) return false;

          return true;
        });

        if (fixedElement.boundElements.length === 0) {
          fixedElement.boundElements = null;
        }
      } else {
        fixedElement.boundElements = null;
      }
    }

    if (fixedElement.containerId) {
      const containerElement = elementMap.get(fixedElement.containerId);
      if (!containerElement) {
        fixedElement.containerId = null;
      }
    }

    return fixedElement;
  });
}

const isImageElement = (element: Partial<ExcalidrawElement>): boolean => {
  return element.type === 'image'
}

const isShapeContainerType = (type: string | undefined): boolean => {
  return type === 'rectangle' || type === 'ellipse' || type === 'diamond'
}

const recenterBoundShapeTextElements = (
  elements: Partial<ExcalidrawElement>[]
): Partial<ExcalidrawElement>[] => {
  const elementMap = new Map(elements.map((el) => [el.id, el]))

  return elements.map((element) => {
    if (element.type !== 'text' || !element.containerId) {
      return element
    }

    const textElement = element as ExcalidrawElement & { type: 'text'; containerId: string; autoResize?: boolean }
    const container = elementMap.get(textElement.containerId) as (ExcalidrawElement & { x: number; y: number; width: number; height: number }) | undefined
    if (!container || !isShapeContainerType(container.type)) {
      return element
    }

    if (textElement.autoResize === false) {
      return element
    }

    if (
      typeof container.x !== 'number' ||
      typeof container.y !== 'number' ||
      typeof container.width !== 'number' ||
      typeof container.height !== 'number' ||
      typeof textElement.width !== 'number' ||
      typeof textElement.height !== 'number'
    ) {
      return element
    }

    return {
      ...element,
      x: container.x + (container.width - textElement.width) / 2,
      y: container.y + (container.height - textElement.height) / 2,
    }
  })
}

const normalizeImageElement = (element: Partial<ExcalidrawElement>): Partial<ExcalidrawElement> => {
  const img = element as any
  return {
    ...img,
    angle: img.angle || 0,
    strokeColor: img.strokeColor || 'transparent',
    backgroundColor: img.backgroundColor || 'transparent',
    fillStyle: img.fillStyle || 'solid',
    strokeWidth: img.strokeWidth || 1,
    strokeStyle: img.strokeStyle || 'solid',
    roughness: img.roughness ?? 0,
    opacity: img.opacity ?? 100,
    groupIds: img.groupIds || [],
    roundness: null,
    seed: img.seed || Math.floor(Math.random() * 1000000),
    version: img.version || 1,
    versionNonce: img.versionNonce || Math.floor(Math.random() * 1000000),
    isDeleted: img.isDeleted ?? false,
    boundElements: img.boundElements || null,
    link: img.link || null,
    locked: img.locked || false,
    status: img.status || 'saved',
    fileId: img.fileId,
    scale: img.scale || [1, 1],
  }
}

const restoreBindings = (
  convertedElements: readonly any[],
  originalElements: Partial<ExcalidrawElement>[]
): any[] => {
  const originalMap = new Map<string, any>();
  for (const el of originalElements) {
    if (el.id) originalMap.set(el.id, el);
  }

  return convertedElements.map((el: any) => {
    const orig = originalMap.get(el.id);
    if (!orig) return el;

    const patched = { ...el };

    if (orig.startBinding && !el.startBinding) {
      patched.startBinding = orig.startBinding;
    }
    if (orig.endBinding && !el.endBinding) {
      patched.endBinding = orig.endBinding;
    }
    if (orig.boundElements && (!el.boundElements || el.boundElements.length === 0)) {
      patched.boundElements = orig.boundElements;
    }
    if (orig.elbowed !== undefined && el.elbowed === undefined) {
      patched.elbowed = orig.elbowed;
    }

    return patched;
  });
};

const convertElementsPreservingImageProps = (
  elements: Partial<ExcalidrawElement>[]
): Partial<ExcalidrawElement>[] => {
  if (elements.length === 0) return []

  const validatedElements = validateAndFixBindings(elements)
  const imageElements = validatedElements.filter(isImageElement).map(normalizeImageElement)
  const nonImageElements = validatedElements.filter(el => !isImageElement(el))
  const convertedNonImageElements = convertToExcalidrawElements(nonImageElements as any, { regenerateIds: false })
  const restoredNonImageElements = restoreBindings(convertedNonImageElements, nonImageElements)
  return recenterBoundShapeTextElements([...restoredNonImageElements, ...imageElements])
}

function App(): JSX.Element {
  const [excalidrawAPI, setExcalidrawAPI] = useState<ExcalidrawAPIRefValue | null>(null)
  const excalidrawAPIRef = useRef<ExcalidrawAPIRefValue | null>(null)
  useEffect(() => {
    excalidrawAPIRef.current = excalidrawAPI
  }, [excalidrawAPI])
  useEffect(() => {
    if (!excalidrawAPI) return
    const handle = registerCanvasWebMCP(() => excalidrawAPIRef.current)
    return () => handle.cleanup()
  }, [excalidrawAPI])
  // excalidraw.com-style `#addLibrary=<url>` deep links: fetch the
  // .excalidrawlib and merge it into the built-in library (run once).
  const libraryImportRef = useRef(false)
  const [libraryError, setLibraryError] = useState<string | null>(null)
  useEffect(() => {
    if (!excalidrawAPI || libraryImportRef.current) return
    const urls = getAddLibraryUrls()
    if (urls.length === 0) return
    libraryImportRef.current = true
    ;(async () => {
      try {
        for (const url of urls) {
          const items = await fetchLibraryItems(url)
          await (excalidrawAPI as any).updateLibrary({
            libraryItems: items,
            merge: true,
            openLibraryMenu: false,
          })
        }
        setLibraryError(null)
      } catch (e) {
        setLibraryError(
          `Could not load library: ${e instanceof Error ? e.message : String(e)}. Open it manually via Library → Open.`,
        )
      } finally {
        removeHashParams('addLibrary')
      }
    })()
  }, [excalidrawAPI])
  const [isConnected, setIsConnected] = useState<boolean>(false)
  const websocketRef = useRef<WebSocket | null>(null)

  const [syncStatus, setSyncStatus] = useState<SyncStatus>('idle')
  const [lastSyncTime, setLastSyncTime] = useState<Date | null>(null)
  // Last pull failure, shown in the status pill so a stale canvas is
  // diagnosable instead of silently stuck (e.g. expired token → 401).
  const [syncError, setSyncError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [remoteAvailable, setRemoteAvailable] = useState<boolean>(false)
  const baseElementsRef = useRef<any[]>([])
  const showToast = (msg: string): void => {
    setToast(msg)
    setTimeout(() => setToast((t) => (t === msg ? null : t)), 4000)
  }
  const autoSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const journalTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const syncInFlightRef = useRef<boolean>(false)
  const suppressAutoSyncCountRef = useRef<number>(0)
  const userInteractedRef = useRef<boolean>(false)

  const applySceneUpdateWithoutAutoSync = (
    target: ExcalidrawImperativeAPI | null,
    scene: Parameters<ExcalidrawImperativeAPI['updateScene']>[0]
  ): void => {
    if (!target) return
    suppressAutoSyncCountRef.current += 1
    target.updateScene(scene)
    setTimeout(() => {
      suppressAutoSyncCountRef.current = Math.max(0, suppressAutoSyncCountRef.current - 1)
    }, 0)
  }

  // Content hash of the editable scene. Dirty state is derived from it, so
  // spurious Excalidraw onChange events (mount, font load, view changes)
  // can never stick the pill on "Unsaved changes".
  const hashElements = (els: readonly unknown[]): string => {
    try {
      return JSON.stringify((els as any[]).map((e) => [
        e.id, e.version, e.versionNonce, e.x, e.y, e.width, e.height,
        e.text, e.originalText, e.points, e.isDeleted,
      ]))
    } catch {
      return ''
    }
  }
  const lastPushedHashRef = useRef<string | null>(null)

  useEffect(() => {
    return () => {
      if (autoSyncTimerRef.current) {
        clearTimeout(autoSyncTimerRef.current)
      }
      if (journalTimerRef.current) {
        clearTimeout(journalTimerRef.current)
      }
    }
  }, [])

  const [serverMode, setServerMode] = useState<boolean>(false)
  const [ghToken, setGhToken] = useState<string | null>(null)
  const [access, setAccess] = useState<'unknown' | 'editor' | 'viewer' | 'denied'>('unknown')
  const [accessDetail, setAccessDetail] = useState<import('./utils/ghSync').AccessDetail>(null)
  // Device-flow re-login (token expired/revoked and there is no other login
  // UI — without this the canvas degrades to read-only with no recovery).
  const [loginOpen, setLoginOpen] = useState<boolean>(false)
  const [loginError, setLoginError] = useState<string | null>(null)
  const [ghLogin, setGhLogin] = useState<string>('')
  const [ghRepo, setGhRepo] = useState<import('./utils/ghSync').RepoRef | null>(null)
  // Static identity (repo + token) finished resolving. Boot load waits for
  // this — detectRepo runs after a dynamic import, a tick behind healthSettled.
  const [staticReady, setStaticReady] = useState<boolean>(false)
  const [ghDirty, setGhDirty] = useState<boolean>(false)
  const ghShaRef = useRef<string | null>(null)
  const ghPushInFlightRef = useRef<boolean>(false)
  // Raw upstream elements last applied/pushed/loaded. Pull compares against
  // this (not the canvas hash) so Excalidraw re-normalization noise
  // (versionNonce etc.) can never look like a remote change.
  const lastUpstreamRef = useRef<string | null>(null)
  // Monotonic op counter: push increments on start/finish, pull snapshots it
  // before fetching and aborts if it moved — so pull never applies a
  // pre-push snapshot over just-pushed state (stale-fetch race).
  const opSeqRef = useRef<number>(0)
  const ghRepoRef = useRef(ghRepo)
  ghRepoRef.current = ghRepo

  // Synchronous journal write of the current scene. Safe to call from
  // beforeunload/pagehide — no network, no await, cannot be torn down.
  // Returns whether the snapshot landed (false = storage unavailable/full).
  const journalScene = (): boolean => {
    const api = excalidrawAPIRef.current
    if (!api) return false
    try {
      const els = api.getSceneElements().filter((el) => !el.isDeleted)
      let files: Record<string, any> | undefined
      try { files = api.getFiles() as any } catch { files = undefined }
      return writeLocalSnapshot(snapshotKeyFor(ghRepoRef.current), els as any, baseElementsRef.current, files)
    } catch { return false }
  }

  // Debounced journaling for the onChange hot path.
  const scheduleJournal = (): void => {
    if (journalTimerRef.current) clearTimeout(journalTimerRef.current)
    journalTimerRef.current = setTimeout(() => {
      journalTimerRef.current = null
      journalScene()
    }, 800)
  }

  // Boot recovery: fold the journal (unsaved work from a previous session
  // that never reached the network) over the freshly loaded upstream scene,
  // 3-way merged against the base recorded when the journal was written —
  // so upstream that moved on while we were away still composes instead of
  // being clobbered. Returns true when journaled work was recovered.
  const restoreLocalSnapshot = async (upstream: any[]): Promise<boolean> => {
    const api = excalidrawAPIRef.current
    if (!api) return false
    const key = snapshotKeyFor(ghRepoRef.current)
    const snap = readLocalSnapshot(key)
    if (!snap) return false
    const gh = await import('./utils/ghSync')
    const sig = (els: any[]): string =>
      JSON.stringify((els || []).map((e) => gh.elementSig(e)).sort())
    if (sig(snap.elements) === sig(upstream || [])) {
      clearLocalSnapshot(key)
      return false
    }
    // Deliberate clear-canvas closed before the push went out: the journal is
    // empty but the base matches upstream, so honor the clear instead of
    // resurrecting (the merge below would resurrect — delete never wins there).
    if (snap.elements.length === 0 && (snap.base || []).length > 0 &&
        sig(snap.base) === sig(upstream || [])) {
      applySceneUpdateWithoutAutoSync(api, { elements: [], captureUpdate: CaptureUpdateAction.NEVER })
      return true
    }
    const { merged } = gh.threeWayMerge(snap.base || [], snap.elements, upstream || [])
    if (sig(merged) === sig(upstream || [])) {
      // Elements match, but the journal may still hold image binaries never
      // committed to assets/ — restore them silently so the next push syncs.
      try {
        const jf = Object.values((snap as any).files || {})
        if (jf.length > 0) api.addFiles(jf as any)
      } catch { /* non-fatal */ }
      clearLocalSnapshot(key)
      return Object.keys((snap as any).files || {}).length > 0
    }
    const converted = convertElementsPreservingImageProps(merged.map(cleanElementForExcalidraw))
    applySceneUpdateWithoutAutoSync(api, { elements: converted, captureUpdate: CaptureUpdateAction.NEVER })
    // Silently restore journaled image binaries (never toast — recovery is
    // expected after every tab close, not an exceptional event).
    try {
      const jf = Object.values((snap as any).files || {})
      if (jf.length > 0) api.addFiles(jf as any)
    } catch { /* non-fatal */ }
    return true
  }

  useEffect(() => {
    // Only check for server mode if the page is served from a server (not GitHub Pages static)
    const isStaticHost = window.location.hostname.includes('github.io') ||
                         window.location.pathname.startsWith('/excalidrop/')
    if (isStaticHost) {
      initStaticMode()
    } else {
      fetch('/api/health', { headers: authHeaders() }).then(r => {
        if (r.ok) { setServerMode(true); connectWebSocket() }
        else { initStaticMode() }
      }).catch(() => initStaticMode())
    }
    return () => {
      if (websocketRef.current) {
        websocketRef.current.close()
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const initStaticMode = async (): Promise<void> => {
    const gh = await import('./utils/ghSync')
    setGhRepo(gh.detectRepo())
    setGhToken(gh.getToken())
    setStaticReady(true)
  }

  // Seed the last-known file sha ASAP (from the previous save, else the
  // live Contents metadata) so a close-flush can PUT without a prior GET.
  useEffect(() => {
    if (serverMode || !ghRepo) return
    try {
      const cached = localStorage.getItem(`excalidrop_sha_${ghRepo.owner}_${ghRepo.repo}`)
      if (cached) ghShaRef.current = cached
    } catch {}
    if (!ghToken) return
    void fetch(`https://api.github.com/repos/${ghRepo.owner}/${ghRepo.repo}/contents/canvas.excalidraw?ref=${ghRepo.branch}`, {
      cache: 'no-store',
      headers: { Authorization: `Bearer ${ghToken}`, Accept: 'application/vnd.github+json' },
    }).then(async (r) => {
      if (!r.ok) return
      const j = await r.json().catch(() => null)
      if (j?.sha) {
        ghShaRef.current = j.sha as string
        try { localStorage.setItem(`excalidrop_sha_${ghRepo.owner}_${ghRepo.repo}`, j.sha) } catch {}
      }
    }).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverMode, ghRepo, ghToken])
  // Deployed page title shows the repo canvas: "owner/repo".
  // Runtime (not build-time) so one bundle serves every target repo.
  useEffect(() => {
    document.title = ghRepo ? `${ghRepo.owner}/${ghRepo.repo}` : 'Excalidrop Canvas'
  }, [ghRepo])

  // Token already refreshed for this credential (avoids a refresh retry loop
  // when the refresh token itself is dead — then manual re-login is needed).
  const refreshedForRef = useRef<string | null>(null)
  // Guards out-of-order resolution: a slow check started with an older token
  // must never overwrite the verdict of a newer one (this exact race wedged
  // the canvas read-only right after a successful re-login).
  const accessSeqRef = useRef(0)

  useEffect(() => {
    if (serverMode || !ghRepo) return
    if (!ghToken) { setAccess('denied'); setAccessDetail(null); setGhLogin(''); return }
    setAccess('unknown')
    const seq = ++accessSeqRef.current
    const stillCurrent = (): boolean => seq === accessSeqRef.current
    void (async () => {
      try {
        const gh = await import('./utils/ghSync')
        // Proactive renewal: access tokens live ~8h; with a stored refresh
        // token this is invisible, otherwise the canvas drops to read-only.
        const fresh = await gh.tryRefreshToken(gh.CLIENT_ID)
        const token = fresh || ghToken
        if (fresh && fresh !== ghToken) {
          setGhToken(fresh)
          return // effect re-runs with the new token
        }
        const { access: a, login, detail } = await gh.checkAccess(ghRepo, token)
        if (!stillCurrent()) return
        if (detail === 'expired' && refreshedForRef.current !== token) {
          refreshedForRef.current = token
          const renewed = await gh.tryRefreshToken(gh.CLIENT_ID, { force: true })
          if (renewed) {
            setGhToken(renewed)
            return // effect re-runs with the new token
          }
        }
        if (!stillCurrent()) return
        setAccess(a)
        setAccessDetail(detail)
        setGhLogin(login)
      } catch (e) {
        if (!stillCurrent()) return
        // Network failure vs dead token: gh() embeds the HTTP status, so a
        // 401 here still means expired — offer re-login, not a dead end.
        const expired = String((e as Error)?.message || '').includes('401')
        setAccess('denied')
        setAccessDetail(expired ? 'expired' : null)
        setGhLogin('')
      }
    })()
  }, [serverMode, ghToken, ghRepo])

  // Token login. Shared exchanger + app id are the package defaults so any
  // publisher's canvas offers one-click login with zero config; both are
  // overridable at build time for self-hosters (VITE_AUTH_EXCHANGE_URL,
  // VITE_GITHUB_CLIENT_ID). Without an exchange URL we fall back to
  // paste-a-token (github.com sends no CORS headers, so a static page can
  // never run any OAuth/device flow by itself).
  const _exchangeEnv = (import.meta as any).env?.VITE_AUTH_EXCHANGE_URL as string | undefined
  // 'off' restores the paste-a-token panel (no redirect login at all).
  const AUTH_EXCHANGE_URL = _exchangeEnv === 'off' ? undefined
    : (_exchangeEnv || 'https://excalidrop.wtf403.workers.dev')
  const OAUTH_STATE_KEY = 'excalidrop_oauth_state'
  const OAUTH_REDIRECT_KEY = 'excalidrop_oauth_redirect'
  const [tokenInput, setTokenInput] = useState<string>('')
  const [loginBusy, setLoginBusy] = useState<boolean>(false)

  const startLogin = (): void => {
    setLoginError(null)
    if (AUTH_EXCHANGE_URL) {
      void (async () => {
        const gh = await import('./utils/ghSync')
        const redirect_uri = window.location.origin + window.location.pathname
        const bytes = new Uint8Array(16)
        crypto.getRandomValues(bytes)
        const state = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
        try {
          sessionStorage.setItem(OAUTH_STATE_KEY, state)
          sessionStorage.setItem(OAUTH_REDIRECT_KEY, redirect_uri)
        } catch { /* private mode — state check skipped on return */ }
        const q = new URLSearchParams({ client_id: gh.CLIENT_ID, redirect_uri, scope: 'repo', state })
        window.location.href = `https://github.com/login/oauth/authorize?${q}`
      })()
      return
    }
    setTokenInput('')
    setLoginOpen(true)
  }

  // OAuth return: GitHub redirected back with ?code=[&state=]. Exchange via
  // the worker, store the token, scrub the code from the URL. Runs once.
  const oauthHandledRef = useRef(false)
  useEffect(() => {
    if (oauthHandledRef.current || !AUTH_EXCHANGE_URL) return
    const q = new URLSearchParams(window.location.search)
    const code = q.get('code')
    if (!code) {
      const err = q.get('error')
      if (err) {
        oauthHandledRef.current = true
        history.replaceState(null, '', window.location.pathname + window.location.hash)
        showToast(`Login failed: ${q.get('error_description') || err}`)
      }
      return
    }
    oauthHandledRef.current = true
    const state = q.get('state')
    void (async () => {
      try {
        const expected = sessionStorage.getItem(OAUTH_STATE_KEY)
        const redirect_uri =
          sessionStorage.getItem(OAUTH_REDIRECT_KEY) ||
          window.location.origin + window.location.pathname
        if (!expected || expected !== state) throw new Error('state mismatch — please log in again')
        const r = await fetch(`${AUTH_EXCHANGE_URL}/exchange`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, redirect_uri }),
        })
        const j = await r.json().catch(() => null)
        if (!r.ok || !j?.token) throw new Error(j?.error || 'exchange failed')
        const gh = await import('./utils/ghSync')
        gh.setToken(j.token, j.refresh_token ?? null, j.expires_in ?? null)
        refreshedForRef.current = null
        setGhToken(j.token as string)
        showToast('Logged in — canvas unlocked')
      } catch (e) {
        showToast(`Login failed: ${(e as Error).message}`)
      } finally {
        history.replaceState(null, '', window.location.pathname + window.location.hash)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const cancelLogin = (): void => {
    setLoginOpen(false)
    setTokenInput('')
    setLoginError(null)
  }

  const submitLogin = async (): Promise<void> => {
    // Accept a bare token or a full #token= link / ?token= URL paste.
    const m = tokenInput.match(/token=([A-Za-z0-9_]+)/)
    const t = (m?.[1] || tokenInput).trim()
    if (!t) {
      setLoginError('Paste a token first.')
      return
    }
    setLoginBusy(true)
    setLoginError(null)
    try {
      const gh = await import('./utils/ghSync')
      // Validate before storing: a typo'd/revoked token must not replace a
      // working one, and the user gets the real reason immediately.
      await gh.checkAccess(ghRepo!, t).catch((e) => {
        throw new Error(String((e as Error).message).includes('401')
          ? 'That token was rejected (401) — check scopes and expiry.'
          : (e as Error).message)
      })
      gh.setToken(t)
      refreshedForRef.current = null
      setGhToken(t)
      setLoginOpen(false)
      setTokenInput('')
      showToast('Logged in — canvas unlocked')
    } catch (e) {
      setLoginError((e as Error).message || 'Login failed.')
    } finally {
      setLoginBusy(false)
    }
  }

  // Static mode has no WebSocket, so poll GitHub for changes the agent (or
  // another tab) committed and apply them live. Never clobbers local edits:
  // skipped while dirty or while a push is in flight, applied through the
  // no-autosync path so it can't push itself back, and compared against the
  // last-seen upstream content (not the canvas hash) to avoid churn.
  // Cmd/Ctrl+S saves the canvas instead of opening the browser dialog.
  // Capture phase: Excalidraw stops propagation of handled keys, so a bubble
  // listener on window never fires while the canvas has focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && (e.code === 'KeyS' || e.key.toLowerCase() === 's')) {
        e.preventDefault()
        e.stopPropagation()
        if (!serverMode && access === 'editor') void pushToGitHub(false)
        else void syncToBackend()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverMode, access, excalidrawAPI])

  // Manual Pull: fetch upstream, 3-way merge against base, apply without
  // pushing. Never destroys local work — local-only ids are always kept.
  const pullAndMerge = async (): Promise<void> => {
    if (serverMode || !excalidrawAPI || !ghRepo) return
    if (ghPushInFlightRef.current) return
    try {
      const gh = await import('./utils/ghSync')
      const scene = await gh.loadStaticScene(ghRepo, ghToken)
      const remote = scene.elements || []
      const api = excalidrawAPIRef.current
      if (!api) return
      const local = api.getSceneElements().map(cleanElementForExcalidraw)
      const { merged, conflicts, added, updated } = gh.threeWayMerge(baseElementsRef.current, local, remote)
      const converted = convertElementsPreservingImageProps(merged.map(cleanElementForExcalidraw))
      applySceneUpdateWithoutAutoSync(api, { elements: converted, captureUpdate: CaptureUpdateAction.NEVER })
      if (scene.files) api.addFiles(Object.values(scene.files))
      baseElementsRef.current = merged
      lastUpstreamRef.current = JSON.stringify(remote)
      lastPushedHashRef.current = hashElements(api.getSceneElements().filter((el) => !el.isDeleted))
      setRemoteAvailable(false)
      setGhDirty(conflicts.length > 0 || hashElements(api.getSceneElements().filter((el) => !el.isDeleted)) !== lastPushedHashRef.current ? ghDirty : false)
      showToast(conflicts.length > 0
        ? `Pulled ${added + updated} change(s), ${conflicts.length} conflict(s) kept newer — review ids ${conflicts.slice(0, 3).join(', ')}`
        : `Pulled ${added + updated} remote change(s)`)
    } catch (error) {
      console.error('Pull failed:', error)
      setSyncError(`pull failed (${(error as Error).message.slice(0, 60)})`)
    }
  }

  const pullFromGitHub = async (): Promise<void> => {
    if (serverMode || !excalidrawAPI || !ghRepo) return
    if (ghPushInFlightRef.current) return
    const wasDirty = ghDirty
    const seq = opSeqRef.current
    try {
      let doc: { elements?: any[]; files?: Record<string, unknown> } | null = null
      const failures: string[] = []
      // 1. Authenticated Contents API (fresh raw bytes, works on private repos).
      if (ghToken) {
        const res = await fetch(`https://api.github.com/repos/${ghRepo.owner}/${ghRepo.repo}/contents/canvas.excalidraw?ref=${ghRepo.branch}`, {
          cache: 'no-store',
          headers: { Authorization: `Bearer ${ghToken}`, Accept: 'application/vnd.github.raw' },
        }).catch(() => null)
        if (res?.ok) {
          doc = await res.json().catch(() => null)
        } else if (res) {
          // Token expired/revoked/scopes changed: fall through to the public
          // blob instead of stalling the canvas silently.
          failures.push(`api ${res.status}`)
        }
      }
      // 2. Public raw git blob (live on commit; cache-buster beats edge TTL).
      if (!doc) {
        const gh = await import('./utils/ghSync')
        const res = await fetch(`${gh.rawSceneUrl(ghRepo)}?t=${Date.now()}`, { cache: 'no-store' }).catch(() => null)
        if (res?.ok) {
          doc = await res.json().catch(() => null)
        } else if (res) {
          failures.push(`blob ${res.status}`)
        }
      }
      // 3. Pages-hosted copy (lags deploys — last resort only).
      if (!doc) {
        const res = await fetch('./canvas.excalidraw', { cache: 'no-store' }).catch(() => null)
        if (res?.ok) doc = await res.json().catch(() => null)
        else if (res) failures.push(`pages ${res.status}`)
      }
      if (!doc) {
        setSyncError(failures.length > 0 ? `pull failed (${failures.join(', ')})` : 'pull failed (network)')
        return
      }
      setSyncError(null)
      // A push started or finished while we were fetching: our snapshot may
      // predate it — drop it rather than regress just-pushed state.
      if (seq !== opSeqRef.current || ghPushInFlightRef.current) return
      const up = doc.elements || []
      const upRaw = JSON.stringify(up)
      if (upRaw === lastUpstreamRef.current) return
      // Remote moved while we have unsaved work: don't auto-apply (would
      // fight the user's strokes) — surface the Pull button + a short toast.
      if (wasDirty) {
        setRemoteAvailable(true)
        showToast(`Teammate updated canvas (+${Math.max(0, up.length - baseElementsRef.current.length)} elements) — Pull to merge`)
        return
      }
      // Re-check dirtiness after the await: the user may have drawn while fetching.
      const api = excalidrawAPIRef.current
      if (!api) return
      const h = hashElements(api.getSceneElements().filter((el) => !el.isDeleted))
      if (h !== lastPushedHashRef.current) return // local edits landed meanwhile — push owns this tick
      const converted = convertElementsPreservingImageProps(up.map(cleanElementForExcalidraw))
      applySceneUpdateWithoutAutoSync(api, { elements: converted, captureUpdate: CaptureUpdateAction.NEVER })
      if (doc.files) api.addFiles(Object.values(doc.files))
      lastUpstreamRef.current = upRaw
      baseElementsRef.current = up
      lastPushedHashRef.current = hashElements(api.getSceneElements().filter((el) => !el.isDeleted))
      setGhDirty(false)
    } catch (error) {
      console.error('GitHub pull failed:', error)
      setSyncError(`pull failed (${(error as Error).message.slice(0, 60)})`)
    }
  }

  useEffect(() => {
    if (serverMode) return
    const id = setInterval(() => { void pushToGitHub(false); void pullFromGitHub() }, 20000)
    return () => {
      clearInterval(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverMode, ghToken, ghRepo, ghDirty, excalidrawAPI, access])

  // Close-save listeners are attached ONCE (stable ref indirection).
  // Attaching per-render closures stacked duplicate listeners — every state
  // change added another pagehide flush, producing duplicate save commits.
  // visibilitychange(hidden) fires while the page is still ALIVE, so it does
  // a full async save (scene + image assets) that actually completes.
  // pagehide/beforeunload can no longer do network I/O reliably — keepalive
  // bodies are capped (~64 KiB, a single image blows it) and the multi-request
  // asset chain never finishes during teardown — so they only do the
  // synchronous local journal write (guaranteed). Whatever isn't pushed is
  // restored silently + pushed on the next boot.
  const flushRef = useRef<() => void>(() => {})
  const journalRef = useRef<() => boolean>(() => false)
  const serverModeRef = useRef(serverMode)
  serverModeRef.current = serverMode
  flushRef.current = () => {
    if (serverModeRef.current) void syncToBackend({ silent: true })
    else void pushToGitHub(false)
  }
  journalRef.current = () => journalScene()
  useEffect(() => {
    const onVis = () => {
      if (!document.hidden) return
      journalRef.current()
      flushRef.current()
    }
    const onHide = () => {
      journalRef.current()
    }
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      const journaled = journalRef.current()
      // The close path SAVES via the guaranteed journal write above; boot
      // restores + pushes whatever never made it over the network. So no nag
      // dialog when the journal landed — warn only if even the local snapshot
      // failed with unsaved work that would actually be lost.
      if (!journaled && ghDirty) {
        e.preventDefault()
        e.returnValue = '' // Standard way to trigger browser confirmation
      }
    }
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('pagehide', onHide)
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('pagehide', onHide)
      window.removeEventListener('beforeunload', onBeforeUnload)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ghDirty])

  const pushToGitHub = async (isClosing: boolean): Promise<void> => {
    if (serverMode || !excalidrawAPI || !ghToken || !ghRepo) return
    if (access !== 'editor') return
    if (ghPushInFlightRef.current) return
    // No baseline yet (load never completed and nothing ever pushed): we know
    // nothing about upstream — writing now would be a blind overwrite. This
    // is how fresh tabs wiped scenes with "0 elements" on close.
    if (lastPushedHashRef.current === null) return
    const api = excalidrawAPIRef.current
    if (!api) return
    const localElements = api.getSceneElements().filter(el => !el.isDeleted)
    // Nothing unsaved — not even on close. Skipping avoids no-op commits.
    // (A deliberate clear-canvas differs from baseline, so it still saves.)
    if (hashElements(localElements) === lastPushedHashRef.current) {
      setGhDirty(false)
      return
    }
    ghPushInFlightRef.current = true
    opSeqRef.current += 1
    if (!isClosing) setSyncStatus('syncing')
    try {
      const gh = await import('./utils/ghSync')
      const files = api.getFiles()
      // pushScene merges on 409 (local wins per id), so a stale tab can
      // never wipe newer upstream work — not even on its way out. keepalive
      // lets the close-flush survive page teardown. On close we send a
      // single PUT with the last-known sha (no prior GET): a multi-request
      // chain never completes before the page is torn down.
      const res = await gh.pushScene(
        ghRepo, ghToken,
        { elements: localElements as any, files: files as any },
        { keepalive: isClosing, base: baseElementsRef.current, sha: ghShaRef.current },
      ).catch(() => null)
      if (!res) {
        if (!isClosing) setSyncStatus('error')
        return
      }
      ghShaRef.current = res.sha
      try { localStorage.setItem(`excalidrop_sha_${ghRepo.owner}_${ghRepo.repo}`, res.sha) } catch {}
      // A conflict may have merged upstream-only elements in: apply them so
      // the canvas converges instead of dropping them on the next save.
      const have = new Set(localElements.map((e: any) => e.id))
      const extras = res.elements.filter((e: any) => e?.id && !have.has(e.id))
      if (extras.length > 0) {
        const current = api.getSceneElements().map(cleanElementForExcalidraw)
        applySceneUpdateWithoutAutoSync(api, {
          elements: convertElementsPreservingImageProps([...current, ...extras.map(cleanElementForExcalidraw)]),
          captureUpdate: CaptureUpdateAction.NEVER,
        })
      }
      const finalEls = api.getSceneElements().filter(el => !el.isDeleted)
      lastPushedHashRef.current = hashElements(finalEls)
      lastUpstreamRef.current = JSON.stringify(res.elements)
      baseElementsRef.current = res.elements
      setGhDirty(false)
      clearLocalSnapshot(snapshotKeyFor(ghRepoRef.current))
      if (!isClosing && ((res.conflicts?.length || 0) > 0 || (res.added || 0) + (res.updated || 0) > 0)) {
        showToast(res.conflicts?.length
          ? `Saved + merged ${res.added! + res.updated!} remote change(s), ${res.conflicts!.length} conflict(s) kept newer`
          : `Saved + merged ${res.added! + res.updated!} remote change(s)`)
      }
      if (!isClosing) {
        setLastSyncTime(new Date())
        setSyncStatus('success')
        setTimeout(() => setSyncStatus('idle'), 2000)
      }
    } catch (error) {
      console.error('GitHub push failed:', error)
      if (String((error as Error).message).includes('403') && ghRepo && ghToken) {
        try {
          const gh = await import('./utils/ghSync')
          const { access: a } = await gh.checkAccess(ghRepo, ghToken)
          setAccess(a)
        } catch { setAccess('viewer') }
      }
      if (!isClosing) setSyncStatus('error')
    } finally {
      ghPushInFlightRef.current = false
      opSeqRef.current += 1
    }
  }

  useEffect(() => {
    if (excalidrawAPI) {
      // Static (excalidrop branch) mode has no WebSocket server — never connect there,
      // otherwise it retries wss://<host>/ forever and spams the console.
      if (serverMode && !isConnected) {
        connectWebSocket()
      }
    }
  }, [excalidrawAPI, isConnected, serverMode])

  // Apply initially loaded elements. If the user drew while the load was in
  // flight, fold upstream in and keep every local stroke — boot must NEVER
  // overwrite existing work with the downloaded version.
  // Returns true when local unsaved work was kept (caller: stay dirty).
  const applyLoadedElements = (converted: Partial<ExcalidrawElement>[]): boolean => {
    const api = excalidrawAPIRef.current
    if (!api) return false
    const pre = api.getSceneElements().filter(el => !el.isDeleted)
    if (pre.length > 0 && lastPushedHashRef.current !== null && hashElements(pre) !== lastPushedHashRef.current) {
      const have = new Set(pre.map((e: any) => e.id))
      const extras = converted.filter((e: any) => e?.id && !have.has(e.id))
      if (extras.length > 0) {
        applySceneUpdateWithoutAutoSync(api, {
          elements: convertElementsPreservingImageProps([...pre.map(cleanElementForExcalidraw), ...extras]),
          captureUpdate: CaptureUpdateAction.NEVER,
        })
      }
      return true
    }
    applySceneUpdateWithoutAutoSync(api, {
      elements: converted,
      captureUpdate: CaptureUpdateAction.NEVER,
    })
    return false
  }

  // Boot scene load, exactly once — and only when we know WHERE to load from.
  // Firing earlier (ghRepo still null) would seed the canvas from the stale
  // Pages snapshot instead of the live blob, showing an outdated scene until
  // the next poll tick heals it.
  const bootLoadedRef = useRef<boolean>(false)
  useEffect(() => {
    if (!excalidrawAPI || bootLoadedRef.current) return
    if (serverMode) {
      bootLoadedRef.current = true
      void loadExistingElements()
      return
    }
    // Static mode: wait for repo identity (resolves a tick after health).
    // ghRepo null + staticReady means a non-GitHub host — fall back to the
    // local API / Pages copy, same as before.
    if (!staticReady) return
    bootLoadedRef.current = true
    void loadExistingElements()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [excalidrawAPI, serverMode, ghRepo, staticReady])

  const loadExistingElements = async (): Promise<void> => {
    try {
      // Only check for server mode if the page is served from a server (not GitHub Pages static)
      const isStaticHost = window.location.hostname.includes('github.io') ||
                           window.location.pathname.startsWith('/excalidrop/')
      if (!isStaticHost) {
        const response = await fetch('/api/elements', { headers: authHeaders() }).catch(() => null)
        if (response?.ok) {
          const result: ApiResponse = await response.json()
          if (result.success && result.elements && result.elements.length > 0) {
            const cleanedElements = result.elements.map(cleanElementForExcalidraw)
            const convertedElements = convertElementsPreservingImageProps(cleanedElements)
            if (excalidrawAPI) {
              applyLoadedElements(convertedElements)
            }
          }
          const filesResponse = await fetch('/api/files', { headers: authHeaders() })
          if (filesResponse.ok) {
            const filesResult = await filesResponse.json() as ApiResponse
            if (filesResult.files) {
              excalidrawAPI?.addFiles(Object.values(filesResult.files))
            }
          }
          // Recover journaled work that never reached the backend (tab closed
          // before the sync went out), then push it up.
          if (await restoreLocalSnapshot(result.elements || [])) {
            setTimeout(() => { void syncToBackend({ silent: true }) }, 1500)
          }
          return
        }
      }
      const gh = await import('./utils/ghSync')
      const scene = await gh.loadStaticScene(ghRepo, ghToken)
      const converted = convertElementsPreservingImageProps((scene.elements || []).map(cleanElementForExcalidraw))
      const keptLocal = excalidrawAPI ? applyLoadedElements(converted) : false
      if (scene.files) excalidrawAPI?.addFiles(Object.values(scene.files))
      // Seed the baseline so pre-load onChange noise never marks us dirty.
      if (excalidrawAPI) {
        lastPushedHashRef.current = hashElements(
          excalidrawAPI.getSceneElements().filter((el) => !el.isDeleted),
        )
        lastUpstreamRef.current = JSON.stringify(scene.elements || [])
        baseElementsRef.current = scene.elements || []
        // keptLocal: boot-time strokes exist that upstream hasn't seen —
        // stay dirty so they get saved, never silently dropped.
        // Recovered journal: unsaved work from before the tab closed — apply
        // it over the baseline and push it up shortly.
        const recovered = await restoreLocalSnapshot(scene.elements || [])
        setGhDirty(keptLocal || recovered)
        if (recovered) {
          setTimeout(() => { void pushToGitHub(false) }, 1500)
        }
      }
    } catch (error) {
      console.error('Error loading existing elements:', error)
    }
  }

  const connectWebSocket = (): void => {
    if (websocketRef.current && websocketRef.current.readyState === WebSocket.OPEN) {
      return
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${protocol}//${window.location.host}`

    websocketRef.current = new WebSocket(wsUrl)

    websocketRef.current.onopen = () => {
      setIsConnected(true)

      if (excalidrawAPI) {
        setTimeout(loadExistingElements, 100)
      }
    }

    websocketRef.current.onmessage = (event: MessageEvent) => {
      try {
        const data: WebSocketMessage = JSON.parse(event.data)
        handleWebSocketMessage(data)
      } catch (error) {
        console.error('Error parsing WebSocket message:', error, event.data)
      }
    }

    websocketRef.current.onclose = (event: CloseEvent) => {
      setIsConnected(false)

      // Reconnect after 3 seconds if not a clean close
      if (event.code !== 1000) {
        setTimeout(connectWebSocket, 3000)
      }
    }

    websocketRef.current.onerror = (error: Event) => {
      console.error('WebSocket error:', error)
      setIsConnected(false)
    }
  }

  const handleWebSocketMessage = async (data: WebSocketMessage): Promise<void> => {
    const excalidrawAPI = excalidrawAPIRef.current
    if (!excalidrawAPI) {
      return
    }

    try {
      const currentElements = excalidrawAPI.getSceneElements()
      const mergeAndApplySceneElements = (incomingElements: Partial<ExcalidrawElement>[]): void => {
        if (incomingElements.length === 0) return

        const incomingById = new Map<string, Partial<ExcalidrawElement>>()
        incomingElements.forEach((element) => {
          if (element.id) {
            incomingById.set(element.id, element)
          }
        })

        const mergedElements: Partial<ExcalidrawElement>[] = currentElements.map((element) => {
          const incoming = incomingById.get(element.id)
          if (!incoming) return element
          incomingById.delete(element.id)
          return { ...element, ...incoming }
        })

        mergedElements.push(...incomingById.values())

        const convertedElements = convertElementsPreservingImageProps(mergedElements)
        applySceneUpdateWithoutAutoSync(excalidrawAPI, {
          elements: convertedElements,
          captureUpdate: CaptureUpdateAction.NEVER
        })
      }

      switch (data.type) {
        case 'initial_elements':
          if (data.elements && data.elements.length > 0) {
            const cleanedElements = data.elements.map(cleanElementForExcalidraw)
            const convertedElements = convertElementsPreservingImageProps(cleanedElements)
            applySceneUpdateWithoutAutoSync(excalidrawAPI, {
              elements: convertedElements,
              captureUpdate: CaptureUpdateAction.NEVER
            })
          }
          // Load files for image elements
          if ((data as any).files) {
            excalidrawAPI.addFiles(Object.values((data as any).files))
          }
          break

        case 'files_added':
          if (Array.isArray((data as any).files)) {
            excalidrawAPI.addFiles((data as any).files)
          }
          break

        case 'element_created':
          if (data.element) {
            const cleanedNewElement = cleanElementForExcalidraw(data.element)
            // Rebuild against full scene so text/container bindings remain intact.
            mergeAndApplySceneElements([cleanedNewElement])
          }
          break

        case 'element_updated':
          if (data.element) {
            const cleanedUpdatedElement = cleanElementForExcalidraw(data.element)
            // Convert with full scene context so text metrics/container placement can refresh.
            mergeAndApplySceneElements([cleanedUpdatedElement])
          }
          break

        case 'element_deleted':
          if (data.elementId) {
            const filteredElements = currentElements.filter(el => el.id !== data.elementId)
            applySceneUpdateWithoutAutoSync(excalidrawAPI, {
              elements: filteredElements,
              captureUpdate: CaptureUpdateAction.NEVER
            })
          }
          break

        case 'elements_batch_created':
          if (data.elements) {
            const cleanedBatchElements = data.elements.map(cleanElementForExcalidraw)
            mergeAndApplySceneElements(cleanedBatchElements)
          }
          break

        case 'elements_synced':
          console.log(`Sync confirmed by server: ${data.count} elements`)
          // Sync confirmation already handled by HTTP response
          break

        case 'sync_status':
          console.log(`Server sync status: ${data.count} elements`)
          break

        case 'canvas_cleared':
          console.log('Canvas cleared by server')
          applySceneUpdateWithoutAutoSync(excalidrawAPI, {
            elements: [],
            captureUpdate: CaptureUpdateAction.NEVER
          })
          break

        case 'export_image_request':
          if (data.requestId) {
            try {
              const elements = excalidrawAPI.getSceneElements()
              const appState = excalidrawAPI.getAppState()
              const files = excalidrawAPI.getFiles()

              if (data.format === 'svg') {
                const svg = await exportToSvg({
                  elements,
                  appState: {
                    ...appState,
                    exportBackground: data.background !== false
                  },
                  files
                })
                const svgString = new XMLSerializer().serializeToString(svg)
                await fetch('/api/export/image/result', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    requestId: data.requestId,
                    format: 'svg',
                    data: svgString
                  })
                })
              } else {
                const blob = await exportToBlob({
                  elements,
                  appState: {
                    ...appState,
                    exportBackground: data.background !== false
                  },
                  files,
                  mimeType: 'image/png'
                })
                const reader = new FileReader()
                reader.onload = async () => {
                  try {
                    const resultString = reader.result as string
                    const base64 = resultString?.split(',')[1]
                    if (!base64) {
                      throw new Error('Could not extract base64 data from result')
                    }
                    await fetch('/api/export/image/result', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        requestId: data.requestId,
                        format: 'png',
                        data: base64
                      })
                    })
                  } catch (readerError) {
                    console.error('Image export (FileReader) failed:', readerError)
                    await fetch('/api/export/image/result', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        requestId: data.requestId,
                        error: (readerError as Error).message
                      })
                    }).catch(() => { })
                  }
                }
                reader.onerror = async () => {
                  console.error('FileReader error:', reader.error)
                  await fetch('/api/export/image/result', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      requestId: data.requestId,
                      error: reader.error?.message || 'FileReader failed'
                    })
                  }).catch(() => { })
                }
                reader.readAsDataURL(blob)
              }
            } catch (exportError) {
              console.error('Image export failed:', exportError)
              await fetch('/api/export/image/result', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  requestId: data.requestId,
                  error: (exportError as Error).message
                })
              })
            }
          }
          break

        case 'set_viewport':
          console.log('Received viewport control request', data)
          if (data.requestId) {
            try {
              if (data.scrollToContent) {
                const allElements = excalidrawAPI.getSceneElements()
                if (allElements.length > 0) {
                  excalidrawAPI.scrollToContent(allElements, { fitToViewport: true, animate: true })
                }
              } else if (data.scrollToElementId) {
                const allElements = excalidrawAPI.getSceneElements()
                const targetElement = allElements.find(el => el.id === data.scrollToElementId)
                if (targetElement) {
                  excalidrawAPI.scrollToContent([targetElement], { fitToViewport: false, animate: true })
                } else {
                  throw new Error(`Element ${data.scrollToElementId} not found`)
                }
              } else {
                // Direct zoom/scroll control
                const appState: any = {}
                if (data.zoom !== undefined) {
                  appState.zoom = { value: data.zoom }
                }
                if (data.offsetX !== undefined) {
                  appState.scrollX = data.offsetX
                }
                if (data.offsetY !== undefined) {
                  appState.scrollY = data.offsetY
                }
                if (Object.keys(appState).length > 0) {
                  applySceneUpdateWithoutAutoSync(excalidrawAPI, { appState })
                }
              }

              await fetch('/api/viewport/result', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  requestId: data.requestId,
                  success: true,
                  message: 'Viewport updated'
                })
              })
            } catch (viewportError) {
              console.error('Viewport control failed:', viewportError)
              await fetch('/api/viewport/result', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  requestId: data.requestId,
                  error: (viewportError as Error).message
                })
              }).catch(() => { })
            }
          }
          break

        case 'mermaid_convert':
          console.log('Received Mermaid conversion request from MCP')
          if (data.mermaidDiagram) {
            try {
              const result = await convertMermaidToExcalidraw(data.mermaidDiagram, data.config || DEFAULT_MERMAID_CONFIG)

              if (result.error) {
                console.error('Mermaid conversion error:', result.error)
                return
              }

              if (result.elements && result.elements.length > 0) {
                const convertedElements = convertToExcalidrawElements(result.elements, { regenerateIds: false })
                applySceneUpdateWithoutAutoSync(excalidrawAPI, {
                  elements: convertedElements,
                  captureUpdate: CaptureUpdateAction.IMMEDIATELY
                })

                if (result.files) {
                  excalidrawAPI.addFiles(Object.values(result.files))
                }

                console.log('Mermaid diagram converted successfully:', result.elements.length, 'elements')

                // Sync to backend automatically after creating elements
                await syncToBackend()
              }
            } catch (error) {
              console.error('Error converting Mermaid diagram from WebSocket:', error)
            }
          }
          break

        default:
          console.log('Unknown WebSocket message type:', data.type)
      }
    } catch (error) {
      console.error('Error processing WebSocket message:', error, data)
    }
  }

  const convertToBackendFormat = (element: ExcalidrawElement): ServerElement => {
    return {
      ...element
    } as ServerElement
  }

  const formatSyncTime = (time: Date | null): string => {
    if (!time) return ''
    return time.toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
  }

  const syncToBackend = async (options: { silent?: boolean; keepalive?: boolean } = {}): Promise<void> => {
    const { silent = false, keepalive = false } = options

    if (!excalidrawAPI) {
      console.warn('Excalidraw API not available')
      return
    }

    if (syncInFlightRef.current) {
      return
    }

    if (autoSyncTimerRef.current) {
      clearTimeout(autoSyncTimerRef.current)
      autoSyncTimerRef.current = null
    }

    syncInFlightRef.current = true
    if (!silent) {
      setSyncStatus('syncing')
    }

    try {
      const currentElements = excalidrawAPI.getSceneElements()
      console.log(`Syncing ${currentElements.length} elements to backend`)

      const activeElements = currentElements.filter(el => !el.isDeleted)

      const currentFiles = excalidrawAPI.getFiles()
      const filesArray = Object.values(currentFiles)

      const backendElements = activeElements.map(convertToBackendFormat)

      const response = await fetch('/api/elements/sync', {
        method: 'POST',
        keepalive,
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          elements: backendElements,
          timestamp: new Date().toISOString()
        })
      })

      if (response.ok) {
        const result: ApiResponse = await response.json()
        console.log(`Sync successful: ${result.count} elements synced`)

        if (filesArray.length > 0) {
          console.log(`Syncing ${filesArray.length} files to backend`)
          const filesResponse = await fetch('/api/files', {
            method: 'POST',
            keepalive,
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(filesArray)
          })

          if (filesResponse.ok) {
            const filesResult = await filesResponse.json()
            console.log(`Files sync successful: ${filesResult.count} files synced`)
          } else {
            console.error('Files sync failed:', await filesResponse.text())
          }
        }

        setLastSyncTime(new Date())
        clearLocalSnapshot(snapshotKeyFor(ghRepoRef.current))

        if (!silent) {
          setSyncStatus('success')
          setTimeout(() => setSyncStatus('idle'), 2000)
        }
      } else {
        const error: ApiResponse = await response.json()
        console.error('Sync failed:', error.error)
        if (!silent) {
          setSyncStatus('error')
        }
      }
    } catch (error) {
      console.error('Sync error:', error)
      if (!silent) {
        setSyncStatus('error')
      }
    } finally {
      syncInFlightRef.current = false
    }
  }

  const scheduleAutoSync = (): void => {
    if (!isConnected || !excalidrawAPI) {
      return
    }
    if (!userInteractedRef.current) {
      return
    }
    if (suppressAutoSyncCountRef.current > 0) {
      return
    }
    if (autoSyncTimerRef.current) {
      clearTimeout(autoSyncTimerRef.current)
    }

    autoSyncTimerRef.current = setTimeout(() => {
      autoSyncTimerRef.current = null
      if (suppressAutoSyncCountRef.current > 0 || syncInFlightRef.current) {
        return
      }
      void syncToBackend({ silent: true })
    }, AUTO_SYNC_DEBOUNCE_MS)
  }

  const clearCanvas = async (): Promise<void> => {
    if (excalidrawAPI) {
      try {
      const response = await fetch('/api/elements', { headers: authHeaders() })
        const result: ApiResponse = await response.json()

        if (result.success && result.elements) {
          const deletePromises = result.elements.map(element =>
            fetch(`/api/elements/${element.id}`, { method: 'DELETE' })
          )
          await Promise.all(deletePromises)
        }

        applySceneUpdateWithoutAutoSync(excalidrawAPI, {
          elements: [],
          captureUpdate: CaptureUpdateAction.IMMEDIATELY
        })
      } catch (error) {
        console.error('Error clearing canvas:', error)
        applySceneUpdateWithoutAutoSync(excalidrawAPI, {
          elements: [],
          captureUpdate: CaptureUpdateAction.IMMEDIATELY
        })
      }
    }
  }

  // Save/status block, docked in Excalidraw's own <Footer/> (bottom-left
  // bar) per the Excalidraw API — no floating overlay, no z-index fights.
  // <Footer> only renders on desktop; phones get the Save item in MainMenu.
  const saveBlock = (
      <div className="pill" title={libraryError || syncError || undefined}>
        <div className={`status-dot ${(serverMode ? isConnected : access === 'editor') && !syncError ? 'status-connected' : 'status-disconnected'}`}></div>
        <span>
          {serverMode
            ? (isConnected ? 'Live' : 'Offline')
            : access === 'unknown'
              ? 'Checking access…'
              : libraryError || syncError || (access === 'editor'
                ? (syncStatus === 'syncing' ? 'Saving…' : ghDirty ? 'Unsaved changes' : lastSyncTime ? `Saved ${formatSyncTime(lastSyncTime)}${ghLogin ? ` · ${ghLogin}` : ''}` : `Can edit${ghLogin ? ` · ${ghLogin}` : ''}`)
                : accessDetail === 'expired' ? 'Session expired' : 'Read-only')}
        </span>
        {!serverMode && access === 'denied' && (
          <button
            className="save-icon-btn"
            title={accessDetail === 'expired' ? 'Session expired — log in again' : 'Log in with GitHub to edit'}
            aria-label="Log in with GitHub"
            onClick={() => { void startLogin() }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
              <polyline points="10 17 15 12 10 7" />
              <line x1="15" y1="12" x2="3" y2="12" />
            </svg>
          </button>
        )}
        {!serverMode && access === 'editor' && (
          <>
          {remoteAvailable && (
            <button
              className="save-icon-btn pull-available"
              title="Pull teammate changes"
              aria-label="Pull teammate changes"
              onClick={() => { void pullAndMerge() }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="17 1 21 5 17 9" />
                <path d="M3 11V9a4 4 0 0 1 4-4h14" />
                <polyline points="7 23 3 19 7 15" />
                <path d="M21 13v2a4 4 0 0 1-4 4H3" />
              </svg>
            </button>
          )}
          <button
            className="save-icon-btn"
            title="Save now (Cmd/Ctrl+S)"
            aria-label="Save now"
            onClick={() => { void pushToGitHub(false) }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
              <polyline points="17 21 17 13 7 13 7 21" />
              <polyline points="7 3 7 8 15 8" />
            </svg>
          </button>
          </>
        )}
      </div>
  )

  // Mobile save button, portaled into Excalidraw's own side island
  // (.mobile-misc-tools-container: Library / lock / hand stack on the
  // right edge). <Footer> never renders on phones and renderTopRightUI
  // lands beside the crowded shapes toolbar, so this is the only slot
  // that puts Save next to the other mobile canvas actions.
  // Rendered as a sibling of <Excalidraw> (not a child — Excalidraw only
  // accepts its known children components).
  const MobileSavePortal = (): JSX.Element | null => {
    const [target, setTarget] = useState<Element | null>(null)
    useEffect(() => {
      // The island mounts asynchronously inside Excalidraw (after its own
      // breakpoint detection), so a one-shot query on our mount races it.
      // Observe until it appears; resize covers later breakpoint switches.
      const find = () => {
        const el = document.querySelector('.excalidraw .mobile-misc-tools-container')
        if (el) {
          setTarget(el)
          return true
        }
        return false
      }
      if (!find()) {
        const obs = new MutationObserver(() => { if (find()) obs.disconnect() })
        obs.observe(document.body, { childList: true, subtree: true })
        window.addEventListener('resize', find)
        return () => { obs.disconnect(); window.removeEventListener('resize', find) }
      }
      window.addEventListener('resize', find)
      return () => window.removeEventListener('resize', find)
    }, [])
    if (!target || serverMode || access !== 'editor') return null
    const label = syncStatus === 'syncing' ? 'Saving…'
      : ghDirty ? 'Unsaved changes — tap to save'
      : lastSyncTime ? `Saved ${formatSyncTime(lastSyncTime)}` : 'Saved — tap to save'
    return createPortal(
      <button
        className={`mobile-save-btn${ghDirty || syncStatus === 'syncing' ? ' dirty' : ''}`}
        title={label}
        aria-label="Save now"
        onClick={() => { void pushToGitHub(false) }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
          <polyline points="17 21 17 13 7 13 7 21" />
          <polyline points="7 3 7 8 15 8" />
        </svg>
      </button>,
      target,
    )
  }

  return (
    <div className="app">
      {/* Overlays: toast + login. The save/status block lives in
          Excalidraw's <Footer/> (see below), not here. */}
      <footer id="contentinfo">
      {toast && (
        <div className="toast" role="status" onClick={() => setToast(null)}>
          <span>{toast}</span>
        </div>
      )}
      {loginOpen && (
        <div className="login-panel" role="dialog" aria-label="Log in with GitHub">
          <div className="login-title">Log in with GitHub</div>
          <div className="login-hint">
            Create a token with <code>repo</code> scope{' '}
            <a href="https://github.com/settings/tokens/new?scopes=repo&description=excalidrop-canvas" target="_blank" rel="noreferrer">
              here
            </a>{' '}
            (or run <code>gh auth token</code> locally) and paste it below:
          </div>
          <input
            className="login-input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="ghp_… / github_pat_…"
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void submitLogin() }}
          />
          {loginError && <div className="login-error">{loginError}</div>}
          <div className="login-row">
            <button className="login-cancel" onClick={cancelLogin}>Cancel</button>
            <button className="login-save" onClick={() => { void submitLogin() }} disabled={loginBusy}>
              {loginBusy ? 'Checking…' : 'Save token'}
            </button>
          </div>
        </div>
      )}
      </footer>

      {/* Canvas Container */}
      <div className="canvas-container">
        <div
          onPointerDownCapture={() => {
            userInteractedRef.current = true
          }}
          onKeyDownCapture={() => {
            userInteractedRef.current = true
          }}
          style={{ width: '100%', height: '100%' }}
        >
          <Excalidraw
            viewModeEnabled={!serverMode && access !== 'editor'}
            excalidrawAPI={(api: ExcalidrawAPIRefValue) => setExcalidrawAPI(api)}
            validateEmbeddable={true}
            onChange={() => {
              if (serverMode) { scheduleAutoSync(); scheduleJournal(); return }
              if (suppressAutoSyncCountRef.current) return
              const api = excalidrawAPIRef.current
              if (!api) return
              const h = hashElements(api.getSceneElements().filter((el) => !el.isDeleted))
              if (lastPushedHashRef.current === null || h !== lastPushedHashRef.current) {
                setGhDirty(true)
                scheduleJournal()
              } else {
                setGhDirty(false)
                clearLocalSnapshot(snapshotKeyFor(ghRepoRef.current))
              }
            }}
            initialData={{
              elements: [],
              appState: {
                theme: 'light',
                viewBackgroundColor: '#ffffff'
              }
            }}
          >
            {/* Custom hamburger menu: functional items only.
                Rendering <MainMenu> replaces Excalidraw defaults entirely,
                so Help / Socials / ItemLink entries (excalidraw.com, Discord,
                GitHub, docs links) are gone. */}
            <MainMenu>
              <MainMenu.DefaultItems.LoadScene />
              <MainMenu.DefaultItems.SaveToActiveFile />
              <MainMenu.DefaultItems.Export />
              <MainMenu.DefaultItems.SaveAsImage />
              <MainMenu.Separator />
              {!serverMode && access === 'editor' && (
                <MainMenu.Item
                  icon={
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                      <polyline points="17 21 17 13 7 13 7 21" />
                      <polyline points="7 3 7 8 15 8" />
                    </svg>
                  }
                  shortcut="Ctrl+S"
                  onSelect={() => { void pushToGitHub(false) }}
                >
                  Save now
                </MainMenu.Item>
              )}
              <MainMenu.DefaultItems.ClearCanvas />
              <MainMenu.DefaultItems.ChangeCanvasBackground />
              <MainMenu.DefaultItems.ToggleTheme />
              <MainMenu.Separator />
              <MainMenu.DefaultItems.SearchMenu />
              <MainMenu.DefaultItems.CommandPalette />
            </MainMenu>
            {/* Desktop save/status block, docked in Excalidraw's footer bar.
                (<Footer> only renders on desktop — phones use the
                Save item in the hamburger menu above.) */}
            <Footer>
              {saveBlock}
            </Footer>
          </Excalidraw>
          <MobileSavePortal />
        </div>
      </div>
    </div>
  )
}

export default App
