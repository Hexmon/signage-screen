type EmbeddedWebviewElement = HTMLElement & {
  src: string
  stop?: () => void
  setAudioMuted?: (muted: boolean) => void
  loadURL?: (url: string) => void
  addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void
  removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void
  executeJavaScript?: (code: string, userGesture?: boolean) => Promise<unknown>
}

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
        };
      }

      const maxWidth = Math.max(root.clientWidth, root.scrollWidth, body.clientWidth, body.scrollWidth);
      const maxHeight = Math.max(root.clientHeight, root.scrollHeight, body.clientHeight, body.scrollHeight);
      const textLength = (body.innerText || '').trim().length;
      const mediaCount = body.querySelectorAll('img, video, canvas, svg, iframe, embed, object').length;
      const hasVisibleContent = textLength > 0 || mediaCount > 0 || body.children.length > 0;

      return {
        ready: maxWidth > 0 && maxHeight > 0 && hasVisibleContent,
        reason: maxWidth <= 0 || maxHeight <= 0 ? 'zero-size' : hasVisibleContent ? 'ok' : 'empty-dom',
        hasBody: true,
        hasVisibleContent,
        width: maxWidth,
        height: maxHeight,
      };
    } catch (error) {
      return {
        ready: false,
        reason: error instanceof Error ? error.message : String(error),
        hasBody: Boolean(document.body),
        hasVisibleContent: false,
        width: 0,
        height: 0,
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
  webview.src = options.liveUrl
  webview.setAttribute('allowpopups', 'false')
  container.appendChild(webview)

  let disposed = false
  let revealedLive = false
  let healthProbeTimer: number | undefined

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
        revealLive()
        return
      }

      showFallback(`probe-${probe?.reason || 'unhealthy'}`)
    } catch {
      showFallback('probe-execution-failed')
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

  webview.addEventListener('dom-ready', handleDomReady)
  webview.addEventListener('did-stop-loading', handleStopLoading)
  webview.addEventListener('did-fail-load', handleFailLoad)
  webview.addEventListener('render-process-gone', handleGone as EventListener)
  webview.addEventListener('unresponsive', handleUnresponsive as EventListener)
  webview.addEventListener('did-navigate', handleNavigate as EventListener)
  webview.addEventListener('did-navigate-in-page', handleNavigate as EventListener)

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

    try {
      webview.stop?.()
    } catch {
      // ignore teardown failures
    }
  }

  return container
}
