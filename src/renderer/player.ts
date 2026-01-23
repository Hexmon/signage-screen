/**
 * Player - Main playback UI controller
 * Handles media rendering and transitions in the renderer process
 */

import { FitMode, PlayerStatus, TimelineItem } from '../common/types'
import './types'

class Player {
  private canvas: HTMLCanvasElement | null = null
  private currentElement?: HTMLElement
  private mediaContainer: HTMLElement | null = null
  private statusOverlay: HTMLElement | null = null
  private statusConnection: HTMLElement | null = null
  private statusDeviceId: HTMLElement | null = null
  private statusScheduleId: HTMLElement | null = null
  private statusMediaId: HTMLElement | null = null
  private statusSnapshot: HTMLElement | null = null
  private modeBanner: HTMLElement | null = null

  constructor() {
    this.initializeElements()
    this.setupIPC()
    this.log('info', 'Player initialized')
  }

  /**
   * Initialize DOM elements
   */
  private initializeElements(): void {
    this.canvas = document.getElementById('media-canvas') as HTMLCanvasElement
    this.mediaContainer = document.getElementById('playback-container')
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
        this.updateStatusOverlay(data as PlayerStatus)
      })
    }

    if (window.hexmon && window.hexmon.getPlayerStatus) {
      window.hexmon.getPlayerStatus().then((status: any) => {
        this.updateStatusOverlay(status as PlayerStatus)
      }).catch(() => {
        // ignore initial status failures
      })
    }
  }

  /**
   * Play media item
   */
  private async playMedia(item: TimelineItem): Promise<void> {
    this.log('info', 'Playing media', { itemId: item.id, type: item.type })

    try {
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
  private async renderPDF(_item: TimelineItem): Promise<HTMLElement> {
    const container = document.createElement('div')
    container.style.position = 'absolute'
    container.style.top = '0'
    container.style.left = '0'
    container.style.width = '100%'
    container.style.height = '100%'
    container.style.backgroundColor = '#fff'
    container.style.overflow = 'hidden'

    // TODO: Integrate pdf.js for actual PDF rendering
    // For now, show placeholder
    const placeholder = document.createElement('div')
    placeholder.style.display = 'flex'
    placeholder.style.alignItems = 'center'
    placeholder.style.justifyContent = 'center'
    placeholder.style.width = '100%'
    placeholder.style.height = '100%'
    placeholder.style.fontSize = '24px'
    placeholder.textContent = 'PDF Rendering (pdf.js integration needed)'

    container.appendChild(placeholder)

    return container
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

    // Hide current element
    if (this.currentElement) {
      this.currentElement.style.opacity = '0'
      setTimeout(() => {
        if (this.currentElement && this.mediaContainer) {
          this.mediaContainer.removeChild(this.currentElement)
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
}

// Initialize player when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    new Player()
  })
} else {
  new Player()
}
