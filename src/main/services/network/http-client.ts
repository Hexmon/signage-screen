/**
 * HTTP Client - Axios-based client with mTLS support
 * Handles all HTTP communication with the backend
 */

import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios'
import * as https from 'https'
import { getLogger } from '../../../common/logger'
import { getConfigManager } from '../../../common/config'
import { getCertificateManager } from '../cert-manager'
import { NetworkError } from '../../../common/types'
import { retryWithBackoff } from '../../../common/utils'

const logger = getLogger('http-client')

declare module 'axios' {
  export interface AxiosRequestConfig {
    mtls?: boolean
    retry?: boolean
  }
}

export class HttpClient {
  private client: AxiosInstance
  private mtlsEnabled: boolean

  constructor() {
    const config = getConfigManager().getConfig()
    this.mtlsEnabled = config.mtls.enabled

    this.client = axios.create({
      baseURL: config.apiBase,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'HexmonSignage/1.0.0',
      },
    })

    // Setup interceptors
    this.setupInterceptors()

    logger.info({ baseURL: config.apiBase, mtlsEnabled: this.mtlsEnabled }, 'HTTP client initialized')
  }

  /**
   * Setup request/response interceptors
   */
  private setupInterceptors(): void {
    // Request interceptor
    this.client.interceptors.request.use(
      async (config) => {
        // Add mTLS certificates if enabled
        const shouldUseMtls = this.mtlsEnabled && config.mtls !== false && this.isHttpsRequest(config)
        if (shouldUseMtls) {
          const httpsAgent = await this.createMTLSAgent()
          config.httpsAgent = httpsAgent
        }

        // Attach device identity header for device endpoints when available
        if (this.isDeviceEndpoint(config.url || '')) {
          try {
            const certManager = getCertificateManager()
            const metadata = certManager.getCertificateMetadata()
            const info = metadata?.fingerprint ? null : await certManager.getCertificateInfo()
            const fingerprint = metadata?.fingerprint || info?.fingerprint
            if (fingerprint) {
              config.headers = config.headers || {}
              if (!(config.headers as any)['X-Device-Serial']) {
                ;(config.headers as any)['X-Device-Serial'] = fingerprint
              }
            }
          } catch (error) {
            logger.warn({ error }, 'Failed to attach device identity header')
          }
        }

        logger.debug({ method: config.method, url: config.url }, 'HTTP request')
        return config
      },
      (error) => {
        logger.error({ error }, 'Request interceptor error')
        return Promise.reject(error)
      }
    )

    // Response interceptor
    this.client.interceptors.response.use(
      (response) => {
        logger.debug({ status: response.status, url: response.config.url }, 'HTTP response')
        return response
      },
      (error) => {
        if (error.response) {
          logger.error(
            {
              status: error.response.status,
              url: error.config?.url,
              data: error.response.data,
            },
            'HTTP error response'
          )
        } else if (error.request) {
          logger.error({ url: error.config?.url }, 'No response received')
        } else {
          logger.error({ error: error.message }, 'Request setup error')
        }
        return Promise.reject(error)
      }
    )
  }

  private isHttpsRequest(config: AxiosRequestConfig): boolean {
    const url = config.url || ''
    if (url.startsWith('https://')) {
      return true
    }
    if (url.startsWith('http://')) {
      return false
    }

    const base = config.baseURL || this.client.defaults.baseURL || ''
    if (base.startsWith('https://')) {
      return true
    }
    if (base.startsWith('http://')) {
      return false
    }

    return false
  }

  private isDeviceEndpoint(url: string): boolean {
    if (!url) return false
    if (url.startsWith('/api/v1/device')) return true
    if (url.startsWith('http://') || url.startsWith('https://')) {
      try {
        const parsed = new URL(url)
        return parsed.pathname.startsWith('/api/v1/device')
      } catch {
        return false
      }
    }
    return false
  }

  private isRetryableError(error: any): boolean {
    const status = error?.response?.status
    if (!status) {
      return true
    }
    if (status === 408 || status === 429) {
      return true
    }
    if (status >= 500) {
      return true
    }
    return false
  }

  /**
   * Create HTTPS agent with mTLS certificates
   */
  private async createMTLSAgent(): Promise<https.Agent> {
    try {
      const certManager = getCertificateManager()
      const certs = await certManager.loadCertificates()

      return new https.Agent({
        cert: certs.cert,
        key: certs.key,
        ca: certs.ca,
        rejectUnauthorized: true,
      })
    } catch (error) {
      logger.error({ error }, 'Failed to create mTLS agent')
      throw new NetworkError('Failed to load mTLS certificates', { error })
    }
  }

  /**
   * GET request with retry
   */
  async get<T = any>(url: string, config?: AxiosRequestConfig): Promise<T> {
    return retryWithBackoff(
      async () => {
        const response = await this.client.get<T>(url, config)
        return response.data
      },
      {
        maxAttempts: 3,
        baseDelayMs: 1000,
        maxDelayMs: 10000,
        onRetry: (attempt, error) => {
          logger.warn({ url, attempt, error: error.message }, 'Retrying GET request')
        },
        shouldRetry: (_attempt, error) => this.isRetryableError(error),
      }
    )
  }

  /**
   * POST request with retry
   */
  async post<T = any>(url: string, data?: any, config?: AxiosRequestConfig): Promise<T> {
    if (config?.retry === false) {
      const response = await this.client.post<T>(url, data, config)
      return response.data
    }
    return retryWithBackoff(
      async () => {
        const response = await this.client.post<T>(url, data, config)
        return response.data
      },
      {
        maxAttempts: 3,
        baseDelayMs: 1000,
        maxDelayMs: 10000,
        onRetry: (attempt, error) => {
          logger.warn({ url, attempt, error: error.message }, 'Retrying POST request')
        },
        shouldRetry: (_attempt, error) => this.isRetryableError(error),
      }
    )
  }

  /**
   * PUT request with retry
   */
  async put<T = any>(url: string, data?: any, config?: AxiosRequestConfig): Promise<T> {
    return retryWithBackoff(
      async () => {
        const response = await this.client.put<T>(url, data, config)
        return response.data
      },
      {
        maxAttempts: 3,
        baseDelayMs: 1000,
        maxDelayMs: 10000,
        onRetry: (attempt, error) => {
          logger.warn({ url, attempt, error: error.message }, 'Retrying PUT request')
        },
        shouldRetry: (_attempt, error) => this.isRetryableError(error),
      }
    )
  }

  /**
   * DELETE request with retry
   */
  async delete<T = any>(url: string, config?: AxiosRequestConfig): Promise<T> {
    return retryWithBackoff(
      async () => {
        const response = await this.client.delete<T>(url, config)
        return response.data
      },
      {
        maxAttempts: 3,
        baseDelayMs: 1000,
        maxDelayMs: 10000,
        onRetry: (attempt, error) => {
          logger.warn({ url, attempt, error: error.message }, 'Retrying DELETE request')
        },
        shouldRetry: (_attempt, error) => this.isRetryableError(error),
      }
    )
  }

  /**
   * HEAD request (no retry for HEAD)
   */
  async head(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse> {
    return this.client.head(url, config)
  }

  /**
   * Check connectivity
   */
  async checkConnectivity(): Promise<boolean> {
    const result = await this.checkConnectivityDetailed()
    return result.ok
  }

  async checkConnectivityDetailed(): Promise<{
    ok: boolean
    baseURL: string
    endpoint: string
    status?: number
    error?: string
  }> {
    const baseURL = this.client.defaults.baseURL || ''
    const endpoints = ['/api/v1/health', '/health', '/api/v1/device-pairing?page=1&limit=1']
    let lastError: string | undefined

    for (const endpoint of endpoints) {
      try {
        const response = await this.client.get(endpoint, {
          timeout: 5000,
          validateStatus: () => true,
          mtls: false,
        })

        if (response.status >= 200 && response.status < 300) {
          return { ok: true, baseURL, endpoint, status: response.status }
        }

        if (endpoint.includes('health') && response.status === 404) {
          lastError = `Health endpoint not found (${response.status})`
          continue
        }

        if (response.status < 500) {
          return { ok: true, baseURL, endpoint, status: response.status }
        }

        lastError = `Health check returned ${response.status}`
      } catch (error: any) {
        const code = error?.code ? ` (${error.code})` : ''
        lastError = `${error?.message || 'Unknown network error'}${code}`
      }
    }

    logger.warn({ baseURL, error: lastError }, 'Connectivity check failed')
    return {
      ok: false,
      baseURL,
      endpoint: endpoints[endpoints.length - 1] || '',
      error: lastError || 'Unknown network error',
    }
  }

  /**
   * Enable mTLS
   */
  enableMTLS(): void {
    this.mtlsEnabled = true
    logger.info('mTLS enabled')
  }

  /**
   * Disable mTLS
   */
  disableMTLS(): void {
    this.mtlsEnabled = false
    logger.info('mTLS disabled')
  }

  /**
   * Update base URL
   */
  setBaseURL(baseURL: string): void {
    this.client.defaults.baseURL = baseURL
    logger.info({ baseURL }, 'Base URL updated')
  }

  /**
   * Get axios instance for advanced usage
   */
  getAxiosInstance(): AxiosInstance {
    return this.client
  }
}

// Singleton instance
let httpClient: HttpClient | null = null

export function getHttpClient(): HttpClient {
  if (!httpClient) {
    httpClient = new HttpClient()
  }
  return httpClient
}
