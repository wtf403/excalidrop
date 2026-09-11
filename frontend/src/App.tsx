import React, { useState, useEffect, useRef } from 'react'
import {
  Excalidraw,
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
  // Static (gh-pages) mode stores the user token under excalidrop_gh_token
  // (see utils/ghSync); server mode uses excalidrop_token. Accept both.
  const t = localStorage.getItem('excalidrop_gh_token') || localStorage.getItem('excalidrop_token');
  return t ? { Authorization: `Bearer ${t}` } : {};
};
const AUTO_SYNC_DEBOUNCE_MS = 1200;


const cleanElementForExcalidraw = (element: ServerElement): Partial<ExcalidrawElement> => {
  const {
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
  const [isConnected, setIsConnected] = useState<boolean>(false)
  const websocketRef = useRef<WebSocket | null>(null)

  const [syncStatus, setSyncStatus] = useState<SyncStatus>('idle')
  const [lastSyncTime, setLastSyncTime] = useState<Date | null>(null)
  const autoSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
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
    }
  }, [])

  const [serverMode, setServerMode] = useState<boolean>(false)
  const [ghToken, setGhToken] = useState<string | null>(null)
  const [access, setAccess] = useState<'unknown' | 'editor' | 'viewer' | 'denied'>('unknown')
  const [ghLogin, setGhLogin] = useState<string>('')
  const [ghRepo, setGhRepo] = useState<import('./utils/ghSync').RepoRef | null>(null)
  const [ghDirty, setGhDirty] = useState<boolean>(false)
  const ghShaRef = useRef<string | null>(null)
  const ghPushInFlightRef = useRef<boolean>(false)

  useEffect(() => {
    fetch('/api/health', { headers: authHeaders() }).then(r => {
      if (r.ok) { setServerMode(true); connectWebSocket() }
      else { initStaticMode() }
    }).catch(() => initStaticMode())
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
  }

  useEffect(() => {
    if (serverMode || !ghRepo) return
    if (!ghToken) { setAccess('denied'); setGhLogin(''); return }
    setAccess('unknown')
    void (async () => {
      try {
        const gh = await import('./utils/ghSync')
        const { access: a, login } = await gh.checkAccess(ghRepo, ghToken)
        setAccess(a)
        setGhLogin(login)
      } catch {
        setAccess('denied')
        setGhLogin('')
      }
    })()
  }, [serverMode, ghToken, ghRepo])

  useEffect(() => {
    if (serverMode) return
    const id = setInterval(() => { void pushToGitHub(false) }, 10000)
    const flush = () => { void pushToGitHub(true) }
    const guard = (e: BeforeUnloadEvent) => {
      if (ghDirty || ghPushInFlightRef.current) { e.preventDefault() }
    }
    document.addEventListener('visibilitychange', () => { if (document.hidden) flush() })
    window.addEventListener('pagehide', flush)
    window.addEventListener('beforeunload', guard)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', () => { })
      window.removeEventListener('pagehide', flush)
      window.removeEventListener('beforeunload', guard)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverMode, ghToken, ghRepo, ghDirty, excalidrawAPI, access])

  const pushToGitHub = async (isClosing: boolean): Promise<void> => {
    if (serverMode || !excalidrawAPI || !ghToken || !ghRepo) return
    if (access !== 'editor') return
    if ((!ghDirty && !isClosing) || ghPushInFlightRef.current) return
    ghPushInFlightRef.current = true
    if (!isClosing) setSyncStatus('syncing')
    try {
      const gh = await import('./utils/ghSync')
      const elements = excalidrawAPI.getSceneElements().filter(el => !el.isDeleted)
      const files = excalidrawAPI.getFiles()
      if (isClosing) {
        // Best-effort synchronous flush on close, with one 409 retry:
        // an in-flight autosync may have moved the sha under us.
        const doc = {
          message: `excalidrop: force-save on close (${elements.length} elements)`,
          content: btoa(unescape(encodeURIComponent(JSON.stringify({ type: 'excalidraw', version: 2, source: 'excalidrop', elements }, null, 2)))),
          branch: ghRepo.branch,
        };
        for (let attempt = 0; attempt < 2; attempt++) {
          const cur = await fetch(`https://api.github.com/repos/${ghRepo.owner}/${ghRepo.repo}/contents/canvas.excalidraw?ref=${ghRepo.branch}`, {
            cache: 'no-store',
            headers: { Authorization: `Bearer ${ghToken}`, Accept: 'application/vnd.github+json' },
          }).then(r => r.json()).catch(() => null)
          const res = await fetch(`https://api.github.com/repos/${ghRepo.owner}/${ghRepo.repo}/contents/canvas.excalidraw`, {
            method: 'PUT',
            keepalive: true,
            headers: { Authorization: `Bearer ${ghToken}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...doc, ...(cur?.sha ? { sha: cur.sha } : {}) }),
          }).catch(() => null)
          if (res && (res.ok || res.status !== 409)) break;
        }
      } else {
        ghShaRef.current = await gh.pushScene(ghRepo, ghToken, { elements: elements as any, files: files as any })
        lastPushedHashRef.current = hashElements(elements)
        setLastSyncTime(new Date())
        setSyncStatus('success')
        setTimeout(() => setSyncStatus('idle'), 2000)
      }
      setGhDirty(false)
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
    }
  }

  useEffect(() => {
    if (excalidrawAPI) {
      loadExistingElements()

      // Static (gh-pages) mode has no WebSocket server — never connect there,
      // otherwise it retries wss://<host>/ forever and spams the console.
      if (serverMode && !isConnected) {
        connectWebSocket()
      }
    }
  }, [excalidrawAPI, isConnected, serverMode])

  const loadExistingElements = async (): Promise<void> => {
    try {
      const response = await fetch('/api/elements', { headers: authHeaders() }).catch(() => null)
      if (response?.ok) {
        const result: ApiResponse = await response.json()
        if (result.success && result.elements && result.elements.length > 0) {
          const cleanedElements = result.elements.map(cleanElementForExcalidraw)
          const convertedElements = convertElementsPreservingImageProps(cleanedElements)
          if (excalidrawAPI) {
            applySceneUpdateWithoutAutoSync(excalidrawAPI, {
              elements: convertedElements,
              captureUpdate: CaptureUpdateAction.NEVER
            })
          }
        }
        const filesResponse = await fetch('/api/files', { headers: authHeaders() })
        if (filesResponse.ok) {
          const filesResult = await filesResponse.json() as ApiResponse
          if (filesResult.files) {
            excalidrawAPI?.addFiles(Object.values(filesResult.files))
          }
        }
        return
      }
      const gh = await import('./utils/ghSync')
      const scene = await gh.loadStaticScene()
      if (scene.elements.length > 0 && excalidrawAPI) {
        const converted = convertElementsPreservingImageProps(scene.elements.map(cleanElementForExcalidraw))
        applySceneUpdateWithoutAutoSync(excalidrawAPI, { elements: converted, captureUpdate: CaptureUpdateAction.NEVER })
      }
      if (scene.files) excalidrawAPI?.addFiles(Object.values(scene.files))
      // Seed the baseline so pre-load onChange noise never marks us dirty.
      if (excalidrawAPI) {
        lastPushedHashRef.current = hashElements(
          excalidrawAPI.getSceneElements().filter((el) => !el.isDeleted),
        )
        setGhDirty(false)
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

  const syncToBackend = async (options: { silent?: boolean } = {}): Promise<void> => {
    const { silent = false } = options

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

  return (
    <div className="app">
      {/* Floating status pill (no header — canvas is fullscreen).
          No login UI: a token arrives silently (agent hands a #token= link
          or has stored one before); without it the canvas is read-only. */}
      <div className="pill">
        <div className={`status-dot ${(serverMode ? isConnected : access === 'editor') ? 'status-connected' : 'status-disconnected'}`}></div>
        <span>
          {serverMode
            ? (isConnected ? 'Live' : 'Offline')
            : access === 'unknown'
              ? 'Checking access…'
              : access === 'editor'
                ? (syncStatus === 'syncing' ? 'Saving…' : ghDirty ? 'Unsaved changes' : lastSyncTime ? `Saved ${formatSyncTime(lastSyncTime)}${ghLogin ? ` · ${ghLogin}` : ''}` : `Can edit${ghLogin ? ` · ${ghLogin}` : ''}`)
                : 'Read-only'}
        </span>
        {!serverMode && access === 'editor' && (
          <button
            className="save-icon-btn"
            title="Save now"
            aria-label="Save now"
            onClick={() => { void pushToGitHub(false) }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
              <polyline points="17 21 17 13 7 13 7 21" />
              <polyline points="7 3 7 8 15 8" />
            </svg>
          </button>
        )}
      </div>

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
            onChange={() => {
              if (serverMode) { scheduleAutoSync(); return }
              if (suppressAutoSyncCountRef.current) return
              const api = excalidrawAPIRef.current
              if (!api) return
              const h = hashElements(api.getSceneElements().filter((el) => !el.isDeleted))
              if (lastPushedHashRef.current === null || h !== lastPushedHashRef.current) {
                setGhDirty(true)
              } else {
                setGhDirty(false)
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
              <MainMenu.DefaultItems.ClearCanvas />
              <MainMenu.DefaultItems.ChangeCanvasBackground />
              <MainMenu.DefaultItems.ToggleTheme />
              <MainMenu.Separator />
              <MainMenu.DefaultItems.SearchMenu />
              <MainMenu.DefaultItems.CommandPalette />
            </MainMenu>
          </Excalidraw>
        </div>
      </div>
    </div>
  )
}

export default App
