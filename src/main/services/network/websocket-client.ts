/**
 * WebSocket Client - Real-time communication with auto-reconnect
 * Handles WebSocket connections with mTLS support and automatic reconnection
 */

import WebSocket from 'ws'
import * as https from 'https'
import { EventEmitter } from 'events'
import { getLogger } from '../../../common/logger'
import { getConfigManager } from '../../../common/config'
import { getCertificateManager } from '../cert-manager'
import { AppConfig, WSMessage } from '../../../common/types'
import { ExponentialBackoff } from '../../../common/utils'

const logger = getLogger('websocket-client')

export type WebSocketState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting'

export class WebSocketClient extends EventEmitter {
  private ws: WebSocket | null = null
  private wsUrl: string
  private state: WebSocketState = 'disconnected'
  private reconnectBackoff: ExponentialBackoff
  private reconnectTimer?: NodeJS.Timeout
  private pingTimer?: NodeJS.Timeout
  private pongTimeout?: NodeJS.Timeout
  private mtlsEnabled: boolean
  private messageQueue: WSMessage[] = []
  private maxQueueSize = 100

  constructor() {
    super()
    const config = getConfigManager().getConfig()
    this.wsUrl = config.wsUrl
    this.mtlsEnabled = config.mtls.enabled
    this.reconnectBackoff = new ExponentialBackoff(1000, 60000, 10, 0.2)

    logger.info({ wsUrl: this.wsUrl, mtlsEnabled: this.mtlsEnabled }, 'WebSocket client initialized')
  }

  /**
   * Connect to WebSocket server
   */
  async connect(): Promise<void> {
    if (this.state === 'connected' || this.state === 'connecting') {
      logger.warn('Already connected or connecting')
      return
    }

    this.state = 'connecting'
    logger.info({ wsUrl: this.wsUrl }, 'Connecting to WebSocket')

    try {
      const options: WebSocket.ClientOptions = {
        handshakeTimeout: 10000,
      }

      // Add mTLS certificates if enabled
      if (this.mtlsEnabled) {
        const agent = await this.createMTLSAgent()
        options.agent = agent
      }

      this.ws = new WebSocket(this.wsUrl, options)

      this.ws.on('open', () => this.handleOpen())
      this.ws.on('message', (data) => this.handleMessage(data))
      this.ws.on('close', (code, reason) => this.handleClose(code, reason.toString()))
      this.ws.on('error', (error) => this.handleError(error))
      this.ws.on('pong', () => this.handlePong())
    } catch (error) {
      logger.error({ error }, 'Failed to create WebSocket connection')
      this.handleError(error as Error)
    }
  }

  /**
   * Create HTTPS agent with mTLS certificates
   */
  private async createMTLSAgent(): Promise<https.Agent> {
    const certManager = getCertificateManager()
    const certs = await certManager.loadCertificates()

    return new https.Agent({
      cert: certs.cert,
      key: certs.key,
      ca: certs.ca,
      rejectUnauthorized: true,
    })
  }

  /**
   * Handle WebSocket open event
   */
  private handleOpen(): void {
    logger.info('WebSocket connected')
    this.state = 'connected'
    this.reconnectBackoff.reset()

    // Start ping/pong heartbeat
    this.startHeartbeat()

    // Flush queued messages
    this.flushMessageQueue()

    this.emit('connected')
  }

  /**
   * Handle incoming WebSocket message
   */
  private handleMessage(data: WebSocket.Data): void {
    try {
      const message = JSON.parse(data.toString()) as WSMessage
      logger.debug({ type: message.type }, 'Received WebSocket message')

      // Handle ping/pong
      if (message.type === 'ping') {
        this.send({ type: 'pong', payload: null, timestamp: new Date().toISOString() })
        return
      }

      this.emit('message', message)
      this.emit(message.type, message.payload)
    } catch (error) {
      logger.error({ error, data }, 'Failed to parse WebSocket message')
    }
  }

  /**
   * Handle WebSocket close event
   */
  private handleClose(code: number, reason: string): void {
    logger.warn({ code, reason }, 'WebSocket closed')
    this.state = 'disconnected'
    this.stopHeartbeat()

    this.emit('disconnected', { code, reason })

    // Attempt reconnection
    this.scheduleReconnect()
  }

  /**
   * Handle WebSocket error
   */
  private handleError(error: Error): void {
    logger.error({ error }, 'WebSocket error')
    this.emit('error', error)
  }

  /**
   * Handle pong response
   */
  private handlePong(): void {
    if (this.pongTimeout) {
      clearTimeout(this.pongTimeout)
      this.pongTimeout = undefined
    }
  }

  /**
   * Start ping/pong heartbeat
   */
  private startHeartbeat(): void {
    this.stopHeartbeat()

    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping()

        // Set timeout for pong response
        this.pongTimeout = setTimeout(() => {
          logger.warn('Pong timeout, closing connection')
          this.ws?.terminate()
        }, 10000)
      }
    }, 30000) // Ping every 30 seconds
  }

  /**
   * Stop ping/pong heartbeat
   */
  private stopHeartbeat(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = undefined
    }
    if (this.pongTimeout) {
      clearTimeout(this.pongTimeout)
      this.pongTimeout = undefined
    }
  }

  /**
   * Schedule reconnection with exponential backoff
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return
    }

    const delay = this.reconnectBackoff.getDelay()
    logger.info({ delay, attempt: this.reconnectBackoff.getAttempt() }, 'Scheduling reconnection')

    this.state = 'reconnecting'
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.connect().catch((error) => {
        logger.error({ error }, 'Reconnection failed')
      })
    }, delay)
  }

  /**
   * Send message to server
   */
  send(message: WSMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(message))
        logger.debug({ type: message.type }, 'Sent WebSocket message')
      } catch (error) {
        logger.error({ error, message }, 'Failed to send WebSocket message')
        this.queueMessage(message)
      }
    } else {
      logger.debug({ type: message.type }, 'WebSocket not connected, queueing message')
      this.queueMessage(message)
    }
  }

  /**
   * Queue message for later delivery
   */
  private queueMessage(message: WSMessage): void {
    if (this.messageQueue.length >= this.maxQueueSize) {
      logger.warn('Message queue full, dropping oldest message')
      this.messageQueue.shift()
    }
    this.messageQueue.push(message)
  }

  /**
   * Flush queued messages
   */
  private flushMessageQueue(): void {
    if (this.messageQueue.length === 0) {
      return
    }

    logger.info({ count: this.messageQueue.length }, 'Flushing message queue')

    while (this.messageQueue.length > 0) {
      const message = this.messageQueue.shift()
      if (message) {
        this.send(message)
      }
    }
  }

  /**
   * Disconnect from WebSocket server
   */
  disconnect(): void {
    logger.info('Disconnecting WebSocket')

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }

    this.stopHeartbeat()

    if (this.ws) {
      this.ws.close(1000, 'Client disconnect')
      this.ws = null
    }

    this.state = 'disconnected'
  }

  /**
   * Get current connection state
   */
  getState(): WebSocketState {
    return this.state
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.state === 'connected'
  }

  /**
   * Enable mTLS
   */
  enableMTLS(): void {
    this.mtlsEnabled = true
    logger.info('mTLS enabled, reconnecting...')
    this.disconnect()
    this.connect().catch((error) => {
      logger.error({ error }, 'Failed to reconnect with mTLS')
    })
  }

  applyConfig(config: AppConfig): void {
    const urlChanged = config.wsUrl !== this.wsUrl
    const mtlsChanged = config.mtls.enabled !== this.mtlsEnabled
    this.wsUrl = config.wsUrl
    this.mtlsEnabled = config.mtls.enabled

    if (urlChanged || mtlsChanged) {
      this.disconnect()
      this.connect().catch((error) => {
        logger.error({ error }, 'Failed to reconnect after config update')
      })
    }
  }
}

// Singleton instance
let wsClient: WebSocketClient | null = null

export function getWebSocketClient(): WebSocketClient {
  if (!wsClient) {
    wsClient = new WebSocketClient()
  }
  return wsClient
}

