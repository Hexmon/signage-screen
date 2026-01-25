/**
 * Default Media Player - Render CMS fallback content in renderer
 */

import type { DefaultMediaResponse, DefaultMediaItem } from '../common/types'

export interface DefaultMediaPlayerOptions {
  debugOverlay?: boolean
  onRefreshRequested?: (reason: string) => void
}

export class DefaultMediaPlayer {
  private container: HTMLElement
  private content: HTMLElement
  private debugOverlay: HTMLElement
  private statusOverlay: HTMLElement
  private current: DefaultMediaResponse = { media_id: null, media: null }
  private currentElement?: HTMLElement
  private visible = false
  private retryTimer?: number
  private retryAttempt = 0
  private debugEnabled = false
  private onRefreshRequested?: (reason: string) => void
  private lastMediaKey?: string

  constructor(container: HTMLElement, options: DefaultMediaPlayerOptions = {}) {
    this.container = container
    this.onRefreshRequested = options.onRefreshRequested
    this.debugEnabled = options.debugOverlay === true

    this.content = document.createElement('div')
    this.content.style.position = 'absolute'
    this.content.style.top = '0'
    this.content.style.left = '0'
    this.content.style.width = '100%'
    this.content.style.height = '100%'
    this.content.style.display = 'flex'
    this.content.style.alignItems = 'center'
    this.content.style.justifyContent = 'center'

    this.statusOverlay = document.createElement('div')
    this.statusOverlay.style.position = 'absolute'
    this.statusOverlay.style.bottom = '24px'
    this.statusOverlay.style.right = '24px'
    this.statusOverlay.style.padding = '10px 16px'
    this.statusOverlay.style.borderRadius = '999px'
    this.statusOverlay.style.background = 'rgba(255, 255, 255, 0.12)'
    this.statusOverlay.style.fontSize = '12px'
    this.statusOverlay.style.fontWeight = '600'
    this.statusOverlay.style.letterSpacing = '0.08em'
    this.statusOverlay.style.textTransform = 'uppercase'
    this.statusOverlay.style.display = 'none'

    this.debugOverlay = document.createElement('div')
    this.debugOverlay.style.position = 'absolute'
    this.debugOverlay.style.bottom = '24px'
    this.debugOverlay.style.left = '24px'
    this.debugOverlay.style.padding = '10px 14px'
    this.debugOverlay.style.borderRadius = '10px'
    this.debugOverlay.style.background = 'rgba(0, 0, 0, 0.6)'
    this.debugOverlay.style.fontSize = '12px'
    this.debugOverlay.style.fontWeight = '600'
    this.debugOverlay.style.letterSpacing = '0.04em'
    this.debugOverlay.style.display = this.debugEnabled ? 'block' : 'none'

    this.container.appendChild(this.content)
    this.container.appendChild(this.statusOverlay)
    this.container.appendChild(this.debugOverlay)
  }

  setDebugOverlayEnabled(enabled: boolean): void {
    this.debugEnabled = enabled
    this.debugOverlay.style.display = enabled ? 'block' : 'none'
  }

  setMedia(payload: DefaultMediaResponse | null | undefined): void {
    this.current = payload && typeof payload === 'object' ? payload : { media_id: null, media: null }
    const nextKey = this.current.media ? `${this.current.media.id}:${this.current.media.media_url}` : 'none'
    if (nextKey !== this.lastMediaKey) {
      this.lastMediaKey = nextKey
      this.resetRetry()
    }

    if (this.visible) {
      this.render()
    }
  }

  show(): void {
    if (this.visible) {
      return
    }
    this.visible = true
    this.container.style.display = 'flex'
    this.render()
  }

  hide(): void {
    if (!this.visible) {
      return
    }
    this.visible = false
    this.container.style.display = 'none'
    this.clearContent()
    this.hideStatus()
    this.clearRetryTimer()
  }

  private render(): void {
    this.clearContent()

    const media = this.current.media
    if (!media) {
      this.renderIdle()
      this.updateDebugOverlay(null)
      return
    }

    let element: HTMLElement
    switch (media.type) {
      case 'IMAGE':
        element = this.renderImage(media)
        break
      case 'VIDEO':
        element = this.renderVideo(media)
        break
      case 'DOCUMENT':
        element = this.renderDocument(media)
        break
      default:
        element = this.renderUnsupported(media)
        break
    }

    this.content.appendChild(element)
    this.currentElement = element
    this.updateDebugOverlay(media)
  }

  private renderImage(media: DefaultMediaItem): HTMLElement {
    const img = document.createElement('img')
    img.src = media.media_url
    img.style.width = '100%'
    img.style.height = '100%'
    img.style.objectFit = 'contain'
    img.style.background = '#000'

    img.onload = () => {
      this.markHealthy()
    }

    img.onerror = () => {
      this.handlePlaybackError('image-error')
    }

    return img
  }

  private renderVideo(media: DefaultMediaItem): HTMLElement {
    const video = document.createElement('video')
    video.src = media.media_url
    video.autoplay = true
    video.loop = true
    video.muted = true
    video.playsInline = true
    video.preload = 'auto'
    video.style.width = '100%'
    video.style.height = '100%'
    video.style.objectFit = 'contain'

    video.onloadeddata = () => {
      video.play().catch(() => {
        // Autoplay might be blocked; allow loop to retry
      })
      this.markHealthy()
    }

    video.onerror = () => {
      this.handlePlaybackError('video-error')
    }

    return video
  }

  private renderDocument(media: DefaultMediaItem): HTMLElement {
    if (this.isPdf(media)) {
      const iframe = document.createElement('iframe')
      iframe.src = media.media_url
      iframe.style.width = '100%'
      iframe.style.height = '100%'
      iframe.style.border = '0'
      iframe.style.background = '#000'

      iframe.onload = () => {
        this.markHealthy()
      }

      iframe.onerror = () => {
        this.handlePlaybackError('pdf-error')
      }

      return iframe
    }

    return this.renderUnsupported(media)
  }

  private renderUnsupported(media: DefaultMediaItem): HTMLElement {
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
    title.textContent = 'Document playback not implemented yet'
    title.style.fontSize = '24px'
    title.style.fontWeight = '600'
    title.style.marginBottom = '12px'

    const subtitle = document.createElement('div')
    subtitle.textContent = this.getDocumentLabel(media)
    subtitle.style.fontSize = '16px'
    subtitle.style.opacity = '0.8'

    container.appendChild(title)
    container.appendChild(subtitle)

    this.markHealthy()

    return container
  }

  private renderIdle(): void {
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

    const logo = document.createElement('div')
    logo.textContent = 'HexmonSignage'
    logo.style.fontSize = '32px'
    logo.style.fontWeight = '700'
    logo.style.marginBottom = '12px'

    const message = document.createElement('div')
    message.textContent = 'Waiting for content'
    message.style.fontSize = '18px'
    message.style.opacity = '0.8'

    container.appendChild(logo)
    container.appendChild(message)

    this.content.appendChild(container)
    this.markHealthy()
  }

  private isPdf(media: DefaultMediaItem): boolean {
    const contentType = media.source_content_type?.toLowerCase() || ''
    if (contentType.includes('pdf')) {
      return true
    }

    return /\.pdf(\?|#|$)/i.test(media.media_url)
  }

  private getDocumentLabel(media: DefaultMediaItem): string {
    const name = media.name || 'Untitled document'
    const type = media.source_content_type || media.type
    return `${name} (${type})`
  }

  private updateDebugOverlay(media: DefaultMediaItem | null): void {
    if (!this.debugEnabled) {
      return
    }

    if (!media) {
      this.debugOverlay.textContent = 'DEFAULT MEDIA: none'
      return
    }

    this.debugOverlay.textContent = `DEFAULT MEDIA: ${media.name} (${media.type})`
  }

  private clearContent(): void {
    while (this.content.firstChild) {
      this.content.removeChild(this.content.firstChild)
    }
    this.currentElement = undefined
  }

  private handlePlaybackError(reason: string): void {
    this.showStatus('Reconnecting...')
    this.scheduleRefresh(reason)
  }

  private scheduleRefresh(reason: string): void {
    if (this.retryTimer) {
      return
    }

    const delay = Math.min(30000, 1000 * Math.pow(2, this.retryAttempt))
    this.retryAttempt = Math.min(this.retryAttempt + 1, 6)

    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = undefined
      if (this.onRefreshRequested) {
        this.onRefreshRequested(reason)
      }
    }, delay)
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) {
      window.clearTimeout(this.retryTimer)
      this.retryTimer = undefined
    }
  }

  private resetRetry(): void {
    this.retryAttempt = 0
    this.clearRetryTimer()
  }

  private showStatus(message: string): void {
    this.statusOverlay.textContent = message
    this.statusOverlay.style.display = 'block'
  }

  private hideStatus(): void {
    this.statusOverlay.style.display = 'none'
  }

  private markHealthy(): void {
    this.resetRetry()
    this.hideStatus()
  }
}
