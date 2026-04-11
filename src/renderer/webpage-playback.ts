type EmbeddedWebviewElement = HTMLElement & {
  src: string
  stop?: () => void
  setAudioMuted?: (muted: boolean) => void
  loadURL?: (url: string) => void
  addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void
  removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void
  executeJavaScript?: (code: string, userGesture?: boolean) => Promise<unknown>
}

const WEBPAGE_PARTITION = 'persist:hexmon-webpage-playback'

export type ManagedWebpageElement = HTMLElement & {
  __hexmonCleanup?: () => void
}

type WebpageLogLevel = 'debug' | 'warn'

export type WebpagePlaybackOptions = {
  liveUrl: string
  fallbackUrl?: string
  fallbackFit?: 'contain' | 'cover' | 'fill'
  onHealthy?: () => void
  onFallback?: (reason: string) => void
  onLog?: (level: WebpageLogLevel, message: string, data?: Record<string, unknown>) => void
}

type WebpageProbeResult = {
  ready: boolean
  reason: string
  hasBody: boolean
  hasVisibleContent: boolean
  width: number
  height: number
  textLength: number
  mediaCount: number
  visibleElementCount: number
}

export function shouldRevealLiveWebpage(
  probe: Pick<WebpageProbeResult, 'width' | 'height' | 'textLength' | 'mediaCount' | 'visibleElementCount'>,
): boolean {
  return (
    probe.width > 0 &&
    probe.height > 0 &&
    (probe.textLength > 24 || probe.mediaCount > 0 || probe.visibleElementCount > 1)
  )
}

const WEBPAGE_READY_PROBE = `
  (() => {
    try {
      const root = document.documentElement;
      const body = document.body;
      if (!root || !body) {
        return {
          ready: false,
          reason: 'missing-body',
          hasBody: Boolean(body),
          hasVisibleContent: false,
          width: 0,
          height: 0,
          textLength: 0,
          mediaCount: 0,
          visibleElementCount: 0,
        };
      }

      const maxWidth = Math.max(root.clientWidth, root.scrollWidth, body.clientWidth, body.scrollWidth);
      const maxHeight = Math.max(root.clientHeight, root.scrollHeight, body.clientHeight, body.scrollHeight);
      const textLength = (body.innerText || '').trim().length;
      const mediaCount = body.querySelectorAll('img, video, canvas, svg, iframe, embed, object').length;
      const visibleElements = Array.from(body.querySelectorAll('*')).filter((node) => {
        if (!(node instanceof HTMLElement) && !(node instanceof SVGElement)) {
          return false;
        }

        const tagName = node.tagName.toLowerCase();
        if (['script', 'style', 'link', 'meta', 'noscript'].includes(tagName)) {
          return false;
        }

        const rect = node.getBoundingClientRect();
        if (rect.width <= 4 || rect.height <= 4) {
          return false;
        }

        const style = window.getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
          return false;
        }

        const directTextLength = (node.textContent || '').trim().length;
        const hasGraphicSurface = ['img', 'video', 'canvas', 'svg', 'iframe', 'embed', 'object'].includes(tagName);
        const hasChildren = node.children.length > 0;
        return directTextLength > 0 || hasGraphicSurface || hasChildren;
      });

      const visibleElementCount = visibleElements.length;
      const rootMount = body.querySelector('#root, #app');
      const rootHydrated = Boolean(rootMount && rootMount.children.length > 0);
      const hasVisibleContent =
        textLength > 24 ||
        mediaCount > 0 ||
        visibleElementCount > 1 ||
        rootHydrated;

      const ready =
        maxWidth > 0 &&
        maxHeight > 0 &&
        (textLength > 24 || mediaCount > 0 || visibleElementCount > 1);

      return {
        ready,
        reason: maxWidth <= 0 || maxHeight <= 0 ? 'zero-size' : hasVisibleContent ? 'ok' : 'empty-dom',
        hasBody: true,
        hasVisibleContent,
        width: maxWidth,
        height: maxHeight,
        textLength,
        mediaCount,
        visibleElementCount,
      };
    } catch (error) {
      return {
        ready: false,
        reason: error instanceof Error ? error.message : String(error),
        hasBody: Boolean(document.body),
        hasVisibleContent: false,
        width: 0,
        height: 0,
        textLength: 0,
        mediaCount: 0,
        visibleElementCount: 0,
      };
    }
  })()
`;

const WEBPAGE_LOCKDOWN_SCRIPT = `
  (() => {
    const muteNode = (node) => {
      try {
        node.muted = true;
        node.defaultMuted = true;
        node.volume = 0;
        node.autoplay = false;
      } catch {}
    };

    const apply = () => {
      document.querySelectorAll('video, audio').forEach((node) => muteNode(node));
    };

    apply();
    const observer = new MutationObserver(() => apply());
    if (document.documentElement) {
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }

    window.open = () => null;
    return true;
  })()
`;

function log(
  options: WebpagePlaybackOptions,
  level: WebpageLogLevel,
  message: string,
  data?: Record<string, unknown>
) {
  options.onLog?.(level, message, data);
}

function isSameOriginNavigation(sourceUrl: string, nextUrl: string) {
  try {
    const expected = new URL(sourceUrl);
    const actual = new URL(nextUrl);
    const safeProtocol = actual.protocol === 'http:' || actual.protocol === 'https:';
    return safeProtocol && expected.origin === actual.origin;
  } catch {
    return false;
  }
}

export function createWebpagePlaybackElement(options: WebpagePlaybackOptions): ManagedWebpageElement {
  const container = document.createElement('div') as ManagedWebpageElement
  container.style.position = 'absolute'
  container.style.top = '0'
  container.style.left = '0'
  container.style.width = '100%'
  container.style.height = '100%'
  container.style.background = '#000'
  container.style.overflow = 'hidden'

  const fallbackLayer = document.createElement('div')
  fallbackLayer.style.position = 'absolute'
  fallbackLayer.style.top = '0'
  fallbackLayer.style.left = '0'
  fallbackLayer.style.width = '100%'
  fallbackLayer.style.height = '100%'
  fallbackLayer.style.background = '#000'
  fallbackLayer.style.zIndex = '0'
  fallbackLayer.style.display = 'flex'
  fallbackLayer.style.alignItems = 'center'
  fallbackLayer.style.justifyContent = 'center'
  container.appendChild(fallbackLayer)

  if (options.fallbackUrl) {
    const fallbackImage = document.createElement('img')
    fallbackImage.src = options.fallbackUrl
    fallbackImage.style.width = '100%'
    fallbackImage.style.height = '100%'
    fallbackImage.style.objectFit = options.fallbackFit ?? 'contain'
    fallbackImage.style.background = '#000'
    fallbackLayer.appendChild(fallbackImage)
  } else {
    const fallbackLabel = document.createElement('div')
    fallbackLabel.textContent = 'Live webpage unavailable'
    fallbackLabel.style.color = '#fff'
    fallbackLabel.style.fontSize = '18px'
    fallbackLabel.style.fontWeight = '600'
    fallbackLabel.style.opacity = '0.8'
    fallbackLayer.appendChild(fallbackLabel)
  }

  const webview = document.createElement('webview') as EmbeddedWebviewElement
  webview.style.position = 'absolute'
  webview.style.top = '0'
  webview.style.left = '0'
  webview.style.width = '100%'
  webview.style.height = '100%'
  webview.style.zIndex = '1'
  webview.style.opacity = '0'
  webview.style.transition = 'opacity 180ms ease-in-out'
  webview.setAttribute('partition', WEBPAGE_PARTITION)
  webview.setAttribute('webpreferences', 'contextIsolation=yes, sandbox=yes')
  webview.src = options.liveUrl
  webview.setAttribute('allowpopups', 'false')
  container.appendChild(webview)

  let disposed = false
  let revealedLive = false
  let healthProbeTimer: number | undefined
  let healthProbeDeadlineAt = 0

  const clearHealthProbeTimer = () => {
    if (healthProbeTimer) {
      window.clearTimeout(healthProbeTimer)
      healthProbeTimer = undefined
    }
  }

  const showFallback = (reason: string) => {
    if (disposed) {
      return
    }

    clearHealthProbeTimer()
    revealedLive = false
    webview.style.opacity = '0'
    fallbackLayer.style.display = 'flex'
    log(options, 'warn', 'Webpage fallback active', { reason, url: options.liveUrl })
    options.onFallback?.(reason)
  }

  const revealLive = () => {
    if (disposed) {
      return
    }

    clearHealthProbeTimer()
    revealedLive = true
    fallbackLayer.style.display = 'none'
    webview.style.opacity = '1'
    log(options, 'debug', 'Webpage live view healthy', { url: options.liveUrl })
    options.onHealthy?.()
  }

  const muteAndLock = () => {
    try {
      webview.setAudioMuted?.(true)
    } catch {
      // ignore webview audio mute failures
    }

    void webview.executeJavaScript?.(WEBPAGE_LOCKDOWN_SCRIPT, false).catch(() => {
      // ignore page script injection failures
    })
  }

  const probeReadiness = async () => {
    try {
      const probe = (await webview.executeJavaScript?.(WEBPAGE_READY_PROBE, false)) as
        | WebpageProbeResult
        | undefined

      if (probe?.ready) {
        log(options, 'debug', 'Webpage readiness probe passed', {
          url: options.liveUrl,
          width: probe.width,
          height: probe.height,
          textLength: probe.textLength,
          mediaCount: probe.mediaCount,
          visibleElementCount: probe.visibleElementCount,
        })
        revealLive()
        return
      }

      log(options, 'debug', 'Webpage readiness probe pending', {
        url: options.liveUrl,
        reason: probe?.reason || 'unhealthy',
        width: probe?.width ?? 0,
        height: probe?.height ?? 0,
        textLength: probe?.textLength ?? 0,
        mediaCount: probe?.mediaCount ?? 0,
        visibleElementCount: probe?.visibleElementCount ?? 0,
      })
      if (Date.now() >= healthProbeDeadlineAt) {
        showFallback(`probe-${probe?.reason || 'unhealthy'}`)
        return
      }

      clearHealthProbeTimer()
      healthProbeTimer = window.setTimeout(() => {
        void probeReadiness()
      }, 350)
    } catch {
      if (Date.now() >= healthProbeDeadlineAt) {
        showFallback('probe-execution-failed')
        return
      }

      clearHealthProbeTimer()
      healthProbeTimer = window.setTimeout(() => {
        void probeReadiness()
      }, 500)
    }
  }

  const handleDomReady = () => {
    log(options, 'debug', 'Webpage dom-ready', { url: options.liveUrl })
    muteAndLock()
  }

  const handleStopLoading = () => {
    log(options, 'debug', 'Webpage did-stop-loading', { url: options.liveUrl })
    void probeReadiness()
  }

  const handleFailLoad = () => {
    showFallback('did-fail-load')
  }

  const handleGone = () => {
    showFallback('render-process-gone')
  }

  const handleUnresponsive = () => {
    showFallback('unresponsive')
  }

  const handleNavigate = (event: Event) => {
    const nextUrl = String((event as unknown as { url?: string }).url || '')
    if (!nextUrl) {
      return
    }

    if (isSameOriginNavigation(options.liveUrl, nextUrl)) {
      return
    }

    log(options, 'warn', 'Webpage navigation drift blocked', {
      expected: options.liveUrl,
      actual: nextUrl,
    })

    try {
      webview.loadURL?.(options.liveUrl)
    } catch {
      showFallback('navigation-drift')
    }
  }

  const handleConsoleMessage = (event: Event) => {
    const consoleEvent = event as unknown as { level?: number; message?: string; line?: number; sourceId?: string }
    log(options, 'debug', 'Webpage console message', {
      url: options.liveUrl,
      level: consoleEvent.level ?? null,
      message: consoleEvent.message ?? '',
      line: consoleEvent.line ?? null,
      sourceId: consoleEvent.sourceId ?? '',
    })
  }

  webview.addEventListener('dom-ready', handleDomReady)
  webview.addEventListener('did-stop-loading', handleStopLoading)
  webview.addEventListener('did-fail-load', handleFailLoad)
  webview.addEventListener('render-process-gone', handleGone as EventListener)
  webview.addEventListener('unresponsive', handleUnresponsive as EventListener)
  webview.addEventListener('did-navigate', handleNavigate as EventListener)
  webview.addEventListener('did-navigate-in-page', handleNavigate as EventListener)
  webview.addEventListener('console-message', handleConsoleMessage as EventListener)

  healthProbeDeadlineAt = Date.now() + 12_000
  healthProbeTimer = window.setTimeout(() => {
    if (!revealedLive) {
      showFallback('health-timeout')
    }
  }, 12_000)

  container.__hexmonCleanup = () => {
    if (disposed) {
      return
    }

    disposed = true
    clearHealthProbeTimer()
    webview.removeEventListener('dom-ready', handleDomReady)
    webview.removeEventListener('did-stop-loading', handleStopLoading)
    webview.removeEventListener('did-fail-load', handleFailLoad)
    webview.removeEventListener('render-process-gone', handleGone as EventListener)
    webview.removeEventListener('unresponsive', handleUnresponsive as EventListener)
    webview.removeEventListener('did-navigate', handleNavigate as EventListener)
    webview.removeEventListener('did-navigate-in-page', handleNavigate as EventListener)
    webview.removeEventListener('console-message', handleConsoleMessage as EventListener)

    try {
      webview.stop?.()
    } catch {
      // ignore teardown failures
    }
  }

  return container
}
