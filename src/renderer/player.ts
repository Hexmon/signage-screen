/**
 * Player - Main playback UI controller
 * Handles media rendering and transitions in the renderer process
 */

import { DefaultMediaResponse, FitMode, LayoutScene, LayoutSceneSlot, PlayerStatus, TimelineItem } from '../common/types'
import './types'
import { DefaultMediaPlayer } from './default-media-player'
import { checkMediaCompatibility, CompatResult } from '../common/media-compat'

class Player {
  private canvas: HTMLCanvasElement | null = null
  private currentElement?: HTMLElement
  private mediaContainer: HTMLElement | null = null
  private defaultMediaContainer: HTMLElement | null = null
  private defaultMediaPlayer?: DefaultMediaPlayer
  private activeSource: 'schedule' | 'default' | 'none' = 'schedule'
  private statusOverlay: HTMLElement | null = null
  private statusConnection: HTMLElement | null = null
  private statusDeviceId: HTMLElement | null = null
  private statusScheduleId: HTMLElement | null = null
  private statusMediaId: HTMLElement | null = null
  private statusSnapshot: HTMLElement | null = null
  private modeBanner: HTMLElement | null = null
  private currentCleanup?: () => void

  constructor() {
    this.initializeElements()
    this.setupDefaultMedia()
    this.setupIPC()
    this.log('info', 'Player initialized')
  }

  /**
   * Initialize DOM elements
   */
  private initializeElements(): void {
    this.canvas = document.getElementById('media-canvas') as HTMLCanvasElement
    this.mediaContainer = document.getElementById('playback-container')
    this.defaultMediaContainer = document.getElementById('default-media-container')
    this.statusOverlay = document.getElementById('status-overlay')
    this.statusConnection = document.getElementById('status-connection')
    this.statusDeviceId = document.getElementById('status-device-id')
    this.statusScheduleId = document.getElementById('status-schedule-id')
    this.statusMediaId = document.getElementById('status-media-id')
    this.statusSnapshot = document.getElementById('status-snapshot-time')
    this.modeBanner = document.getElementById('mode-banner')

    if (this.canvas) {
      this.resizeCanvas()

      // Handle window resize
      window.addEventListener('resize', () => this.resizeCanvas())
    }
  }

  private setupDefaultMedia(): void {
    if (!this.defaultMediaContainer) {
      return
    }

    this.defaultMediaPlayer = new DefaultMediaPlayer(this.defaultMediaContainer, {
      onRefreshRequested: (reason) => {
        this.refreshDefaultMedia(reason).catch((error) => {
          this.log('warn', 'Default media refresh failed', { reason, error: error.message })
        })
      },
      debugOverlay: false,
    })

    this.loadDefaultMediaConfig().catch((error) => {
      this.log('warn', 'Failed to load default media config', { error: error.message })
    })

    this.refreshDefaultMedia('initial').catch((error) => {
      this.log('warn', 'Initial default media fetch failed', { error: error.message })
    })

    if (window.hexmon && window.hexmon.onDefaultMediaChanged) {
      window.hexmon.onDefaultMediaChanged((data: any) => {
        this.defaultMediaPlayer?.setMedia(data as DefaultMediaResponse)
      })
    }
  }

  /**
   * Resize canvas to window size
   */
  private resizeCanvas(): void {
    if (!this.canvas) return

    this.canvas.width = window.innerWidth
    this.canvas.height = window.innerHeight
  }

  /**
   * Setup IPC listeners
   */
  private setupIPC(): void {
    // Listen for media playback events
    if (window.hexmon && window.hexmon.onMediaChange) {
      window.hexmon.onMediaChange((data: any) => {
        this.log('debug', 'Received play-media event', data)
        this.setActiveSource('schedule')
        this.playMedia(data.item).catch((error) => {
          this.log('error', 'Failed to play media', { error: error.message })
          this.showFallback(error.message)
        })
      })
    }

    // Listen for transition events
    if (window.hexmon && window.hexmon.onPlaybackUpdate) {
      window.hexmon.onPlaybackUpdate((data: any) => {
        if (data.type === 'transition-start') {
          this.log('debug', 'Received transition-start event', data)
          this.startTransition(data.current, data.next, data.durationMs)
        } else if (data.type === 'show-fallback') {
          this.log('warn', 'Received show-fallback event', data)
          this.showFallback(data.message)
        }
      })
    }

    if (window.hexmon && window.hexmon.onPlayerStatus) {
      window.hexmon.onPlayerStatus((data: any) => {
        const status = data as PlayerStatus
        this.updateStatusOverlay(status)
        this.updateContentSource(status)
      })
    }

    if (window.hexmon && window.hexmon.getPlayerStatus) {
      window.hexmon.getPlayerStatus().then((status: any) => {
        const typedStatus = status as PlayerStatus
        this.updateStatusOverlay(typedStatus)
        this.updateContentSource(typedStatus)
      }).catch(() => {
        // ignore initial status failures
      })
    }
  }

  private async refreshDefaultMedia(reason: string): Promise<void> {
    if (!window.hexmon || !window.hexmon.getDefaultMedia) {
      return
    }

    const data = await window.hexmon.getDefaultMedia({ refresh: true })
    this.defaultMediaPlayer?.setMedia(data as DefaultMediaResponse)
    this.log('debug', 'Default media refreshed', { reason })
  }

  private async loadDefaultMediaConfig(): Promise<void> {
    if (!window.hexmon || !window.hexmon.getConfig) {
      return
    }

    const config = await window.hexmon.getConfig()
    const logLevel = (config as any)?.log?.level
    const debugEnabled = logLevel === 'debug' || logLevel === 'trace'

    this.defaultMediaPlayer?.setDebugOverlayEnabled(debugEnabled)
  }

  private updateContentSource(status: PlayerStatus): void {
    if (
      status.state === 'PAIRING_PENDING' ||
      status.state === 'PAIRING_CONFIRMED' ||
      status.state === 'PAIRING_COMPLETING'
    ) {
      this.setActiveSource('none')
      return
    }

    const shouldShowDefault = status.mode === 'offline' || status.mode === 'empty'
    this.setActiveSource(shouldShowDefault ? 'default' : 'schedule')
  }

  private setActiveSource(source: 'schedule' | 'default' | 'none'): void {
    if (this.activeSource === source) {
      return
    }

    this.activeSource = source

    if (source === 'default') {
      this.defaultMediaPlayer?.show()
    } else {
      this.defaultMediaPlayer?.hide()
    }
  }

  /**
   * Play media item
   */
  private async playMedia(item: TimelineItem): Promise<void> {
    this.log('info', 'Playing media', { itemId: item.id, type: item.type })

    try {
      if (item.type === 'scene') {
        const scene = this.getSceneDefinition(item)
        if (!scene) {
          throw new Error('Scene definition missing from scheduled layout item')
        }

        const element = this.renderScene(item, scene)
        this.showElement(element)
        this.currentElement = element
        return
      }

      const sourceContentType =
        typeof item.meta?.['source_content_type'] === 'string' ? (item.meta?.['source_content_type'] as string) : undefined
      const mediaName = typeof item.meta?.['name'] === 'string' ? (item.meta?.['name'] as string) : undefined
      const mediaUrl = item.localUrl || item.remoteUrl || item.url || item.localPath

      const compat = checkMediaCompatibility({
        type: item.type,
        source_content_type: sourceContentType,
        name: mediaName,
        media_url: mediaUrl,
      })

      if (compat.status === 'PLAYABLE_NOW') {
        this.log('debug', 'Media compatibility check', { itemId: item.id, compat })
      } else if (compat.status === 'ACCEPTED_BUT_NOT_SUPPORTED_YET') {
        this.log('warn', 'Media not supported yet', { itemId: item.id, compat })
        this.showCompatibilityPlaceholder(compat, item)
        return
      } else {
        this.log('error', 'Media rejected by compatibility check', { itemId: item.id, compat })
        this.showFallback(`Unsupported media: ${compat.reason}`)
        return
      }

      let element: HTMLElement

      switch (item.type) {
        case 'image':
          element = await this.renderImage(item)
          break
        case 'video':
          element = await this.renderVideo(item)
          break
        case 'pdf':
          element = await this.renderPDF(item)
          break
        case 'url':
          element = await this.renderURL(item)
          break
        default:
          throw new Error(`Unsupported media type: ${item.type}`)
      }

      // Apply fit mode
      this.applyFitMode(element, item.fit)

      // Show element
      this.showElement(element)

      this.currentElement = element
    } catch (error) {
      this.log('error', 'Failed to play media', { error: (error as Error).message })
      throw error
    }
  }

  /**
   * Render image
   */
  private async renderImage(item: TimelineItem): Promise<HTMLElement> {
    return new Promise((resolve, reject) => {
      const img = document.createElement('img')
      img.style.position = 'absolute'
      img.style.top = '0'
      img.style.left = '0'
      img.style.width = '100%'
      img.style.height = '100%'

      img.onload = () => {
        this.log('debug', 'Image loaded', { itemId: item.id })
        resolve(img)
      }

      img.onerror = () => {
        reject(new Error(`Failed to load image: ${item.mediaId || item.objectKey || item.url}`))
      }

      // Set source (from cache or URL)
      img.src = this.getMediaSource(item)
    })
  }

  /**
   * Render video
   */
  private async renderVideo(item: TimelineItem): Promise<HTMLElement> {
    return new Promise((resolve, reject) => {
      const video = document.createElement('video')
      video.style.position = 'absolute'
      video.style.top = '0'
      video.style.left = '0'
      video.style.width = '100%'
      video.style.height = '100%'
      video.muted = item.muted
      video.loop = false

      video.onloadeddata = () => {
        this.log('debug', 'Video loaded', { itemId: item.id })
        video.play().catch((error) => {
          this.log('error', 'Failed to play video', { error: error.message })
        })
        resolve(video)
      }

      video.onerror = () => {
        reject(new Error(`Failed to load video: ${item.mediaId || item.objectKey || item.url}`))
      }

      video.src = this.getMediaSource(item)
    })
  }

  /**
   * Render PDF
   */
  private async renderPDF(item: TimelineItem): Promise<HTMLElement> {
    const iframe = document.createElement('iframe')
    iframe.style.position = 'absolute'
    iframe.style.top = '0'
    iframe.style.left = '0'
    iframe.style.width = '100%'
    iframe.style.height = '100%'
    iframe.style.border = '0'
    iframe.style.backgroundColor = '#000'

    iframe.src = this.getMediaSource(item)

    return iframe
  }

  /**
   * Render URL
   */
  private async renderURL(item: TimelineItem): Promise<HTMLElement> {
    const webview = document.createElement('webview')
    webview.style.position = 'absolute'
    webview.style.top = '0'
    webview.style.left = '0'
    webview.style.width = '100%'
    webview.style.height = '100%'

    if (item.url) {
      webview.src = item.url
    }

    return webview
  }

  private renderScene(sceneItem: TimelineItem, scene: LayoutScene): HTMLElement {
    const container = document.createElement('div')
    container.style.position = 'absolute'
    container.style.top = '0'
    container.style.left = '0'
    container.style.width = '100%'
    container.style.height = '100%'
    container.style.backgroundColor = '#000'
    container.dataset['sceneId'] = sceneItem.id

    const cleanupCallbacks: Array<() => void> = []

    scene.slots.forEach((slot) => {
      const slotContainer = document.createElement('div')
      slotContainer.style.position = 'absolute'
      slotContainer.style.overflow = 'hidden'
      slotContainer.style.backgroundColor = '#000'
      this.applySlotBounds(slotContainer, slot)

      container.appendChild(slotContainer)
      cleanupCallbacks.push(this.mountSceneSlot(slotContainer, slot, scene.startsAt))
    })

    this.currentCleanup = () => {
      cleanupCallbacks.forEach((cleanup) => cleanup())
      cleanupCallbacks.length = 0
    }

    return container
  }

  /**
   * Get media source (from cache or URL)
   */
  private getMediaSource(item: TimelineItem): string {
    if (item.type === 'url') {
      if (item.url) return item.url
      if (item.remoteUrl) return item.remoteUrl
    }

    if (item.localUrl) {
      return item.localUrl
    }

    if (item.localPath) {
      return item.localPath
    }

    throw new Error('Media is not cached')
  }

  /**
   * Apply fit mode to element
   */
  private applyFitMode(element: HTMLElement, fit: FitMode): void {
    switch (fit) {
      case 'contain':
        element.style.objectFit = 'contain'
        break
      case 'cover':
        element.style.objectFit = 'cover'
        break
      case 'stretch':
        element.style.objectFit = 'fill'
        break
    }
  }

  /**
   * Show element with fade in
   */
  private showElement(element: HTMLElement): void {
    if (!this.mediaContainer) return

    this.runCurrentCleanup()

    // Hide current element
    if (this.currentElement) {
      const previous = this.currentElement
      this.currentElement.style.opacity = '0'
      setTimeout(() => {
        if (this.mediaContainer && previous.parentElement === this.mediaContainer) {
          if (previous instanceof HTMLVideoElement) {
            previous.pause()
            previous.removeAttribute('src')
            previous.load()
          }
          this.mediaContainer.removeChild(previous)
        }
      }, 500)
    }

    // Add and show new element
    element.style.opacity = '0'
    this.mediaContainer.appendChild(element)

    requestAnimationFrame(() => {
      element.style.transition = 'opacity 500ms ease-in-out'
      element.style.opacity = '1'
    })
  }

  /**
   * Start transition between items
   */
  private startTransition(current: TimelineItem, next: TimelineItem, durationMs: number): void {
    this.log('debug', 'Starting transition', { currentId: current.id, nextId: next.id, durationMs })

    // Preload next item
    this.playMedia(next).catch((error) => {
      this.log('error', 'Failed to preload next item', { error: error.message })
    })
  }

  /**
   * Show fallback slide
   */
  private showFallback(message: string): void {
    if (!this.mediaContainer) return

    const fallback = document.createElement('div')
    fallback.className = 'fallback-slide'

    const icon = document.createElement('div')
    icon.className = 'fallback-icon'
    icon.textContent = '⚠️'

    const msg = document.createElement('div')
    msg.className = 'fallback-message'
    msg.textContent = message || 'An error occurred during playback'

    fallback.appendChild(icon)
    fallback.appendChild(msg)

    this.showElement(fallback)
  }

  private showCompatibilityPlaceholder(result: CompatResult, item: TimelineItem): void {
    if (!this.mediaContainer) return

    const container = document.createElement('div')
    container.style.display = 'flex'
    container.style.flexDirection = 'column'
    container.style.alignItems = 'center'
    container.style.justifyContent = 'center'
    container.style.width = '100%'
    container.style.height = '100%'
    container.style.background = '#000'
    container.style.color = '#fff'
    container.style.textAlign = 'center'

    const title = document.createElement('div')
    title.textContent = 'Media playback not supported yet'
    title.style.fontSize = '24px'
    title.style.fontWeight = '600'
    title.style.marginBottom = '10px'

    const details = document.createElement('div')
    details.style.fontSize = '14px'
    details.style.opacity = '0.8'

    const parts = [
      `Kind: ${result.kind}`,
      `Ext: ${result.normalizedExt || '-'}`,
      `Mime: ${result.normalizedMime || '-'}`,
      `Media: ${item.mediaId || item.id}`,
    ]

    details.textContent = parts.join(' | ')

    container.appendChild(title)
    container.appendChild(details)

    this.showElement(container)
    this.currentElement = container
  }

  private updateStatusOverlay(status: PlayerStatus): void {
    if (this.statusOverlay) {
      this.statusOverlay.classList.remove('hidden')
    }

    if (this.statusConnection) {
      this.statusConnection.textContent = status.online ? 'ONLINE' : 'OFFLINE'
      this.statusConnection.className = status.online ? 'status-pill online' : 'status-pill offline'
    }

    if (this.statusDeviceId) {
      this.statusDeviceId.textContent = status.deviceId || '-'
    }

    if (this.statusScheduleId) {
      this.statusScheduleId.textContent = status.scheduleId || '-'
    }

    if (this.statusMediaId) {
      this.statusMediaId.textContent = status.currentMediaId || '-'
    }

    if (this.statusSnapshot) {
      this.statusSnapshot.textContent = status.lastSnapshotAt ? new Date(status.lastSnapshotAt).toLocaleString() : '-'
    }

    if (this.modeBanner) {
      this.modeBanner.classList.remove('hidden', 'emergency', 'default', 'offline')

      if (status.mode === 'emergency') {
        this.modeBanner.textContent = 'EMERGENCY'
        this.modeBanner.classList.add('emergency')
      } else if (status.mode === 'default') {
        this.modeBanner.textContent = 'DEFAULT MEDIA'
        this.modeBanner.classList.add('default')
      } else if (status.mode === 'offline' || status.mode === 'empty') {
        this.modeBanner.textContent = 'OFFLINE MODE'
        this.modeBanner.classList.add('offline')
      } else {
        this.modeBanner.textContent = ''
        this.modeBanner.classList.add('hidden')
      }
    }
  }

  /**
   * Log message to main process
   */
  private log(level: string, message: string, data?: any): void {
    if (window.hexmon && window.hexmon.log) {
      window.hexmon.log(level, message, data)
    } else {
      console.log(`[${level}] ${message}`, data)
    }
  }

  private getSceneDefinition(item: TimelineItem): LayoutScene | null {
    const scene = item.meta?.['scene']
    if (!scene || typeof scene !== 'object') {
      return null
    }

    return scene as LayoutScene
  }

  private applySlotBounds(element: HTMLElement, slot: LayoutSceneSlot): void {
    const width = this.normalizeDimension(slot.bounds.w)
    const height = this.normalizeDimension(slot.bounds.h)
    const left = this.normalizeDimension(slot.bounds.x)
    const top = this.normalizeDimension(slot.bounds.y)

    element.style.left = left
    element.style.top = top
    element.style.width = width
    element.style.height = height

    if (typeof slot.bounds.zIndex === 'number') {
      element.style.zIndex = String(slot.bounds.zIndex)
    }
  }

  private normalizeDimension(value: number | string | undefined): string {
    if (typeof value === 'number') {
      return value > 1 ? `${value}px` : `${value * 100}%`
    }

    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (trimmed.endsWith('%') || trimmed.endsWith('px')) {
        return trimmed
      }

      const numeric = Number(trimmed)
      if (Number.isFinite(numeric)) {
        return numeric > 1 ? `${numeric}px` : `${numeric * 100}%`
      }
    }

    return '0%'
  }

  private mountSceneSlot(container: HTMLElement, slot: LayoutSceneSlot, sceneStartsAt?: string): () => void {
    const timers = new Set<number>()
    let disposed = false
    let activeElement: HTMLElement | undefined

    const totalDurationMs = slot.items.reduce((sum, item) => sum + Math.max(1, item.displayMs), 0)
    const elapsedSinceSceneStart = sceneStartsAt ? Math.max(0, Date.now() - Date.parse(sceneStartsAt)) : 0
    const cycleOffset = totalDurationMs > 0 ? elapsedSinceSceneStart % totalDurationMs : 0

    const resolveInitialPosition = (): { index: number; remainingMs: number } => {
      if (slot.items.length === 0) {
        return { index: 0, remainingMs: 1000 }
      }

      if (totalDurationMs <= 0) {
        return { index: 0, remainingMs: slot.items[0]?.displayMs || 1000 }
      }

      let consumed = 0
      for (let index = 0; index < slot.items.length; index += 1) {
        const item = slot.items[index]
        if (!item) continue
        const duration = Math.max(1, item.displayMs)
        if (cycleOffset < consumed + duration) {
          return {
            index,
            remainingMs: Math.max(250, consumed + duration - cycleOffset),
          }
        }
        consumed += duration
      }

      return { index: 0, remainingMs: Math.max(250, slot.items[0]?.displayMs || 1000) }
    }

    const renderIntoSlot = async (item: TimelineItem): Promise<HTMLElement> => {
      switch (item.type) {
        case 'image':
          return await this.renderImage(item)
        case 'video':
          return await this.renderVideo(item)
        case 'pdf':
          return await this.renderPDF(item)
        case 'url':
          return await this.renderURL(item)
        default:
          throw new Error(`Unsupported scene media type: ${item.type}`)
      }
    }

    const showSlotItem = async (index: number, delayOverrideMs?: number): Promise<void> => {
      if (disposed || slot.items.length === 0) {
        return
      }

      const normalizedIndex = index % slot.items.length
      const item = slot.items[normalizedIndex]
      if (!item) {
        return
      }

      try {
        const nextElement = await renderIntoSlot(item)
        this.applyFitMode(nextElement, item.fit)
        nextElement.style.opacity = '0'
        nextElement.style.transition = 'opacity 300ms ease-in-out'
        container.appendChild(nextElement)

        requestAnimationFrame(() => {
          nextElement.style.opacity = '1'
        })

        if (activeElement && activeElement.parentElement === container) {
          const previous = activeElement
          previous.style.opacity = '0'
          window.setTimeout(() => {
            if (previous.parentElement === container) {
              if (previous instanceof HTMLVideoElement) {
                previous.pause()
                previous.removeAttribute('src')
                previous.load()
              }
              container.removeChild(previous)
            }
          }, 300)
        }

        activeElement = nextElement
        const delayMs = delayOverrideMs ?? Math.max(250, item.displayMs)
        const timer = window.setTimeout(() => {
          timers.delete(timer)
          void showSlotItem(normalizedIndex + 1)
        }, delayMs)
        timers.add(timer)
      } catch (error) {
        this.log('error', 'Failed to render scene slot media', {
          slotId: slot.id,
          itemId: item.id,
          error: (error as Error).message,
        })
      }
    }

    const initialPosition = resolveInitialPosition()
    void showSlotItem(initialPosition.index, initialPosition.remainingMs)

    return () => {
      disposed = true
      timers.forEach((timer) => window.clearTimeout(timer))
      timers.clear()

      if (activeElement instanceof HTMLVideoElement) {
        activeElement.pause()
        activeElement.removeAttribute('src')
        activeElement.load()
      }

      while (container.firstChild) {
        container.removeChild(container.firstChild)
      }
    }
  }

  private runCurrentCleanup(): void {
    if (!this.currentCleanup) {
      return
    }

    const cleanup = this.currentCleanup
    this.currentCleanup = undefined
    cleanup()
  }
}

// Initialize player when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    new Player()
  })
} else {
  new Player()
}
