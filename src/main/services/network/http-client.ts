import axios, { AxiosHeaders, AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios'
import type { AxiosError } from 'axios'
import * as https from 'https'
import { getLogger } from '../../../common/logger'
import { getConfigManager } from '../../../common/config'
import { getCertificateManager } from '../cert-manager'
import {
  AppConfig,
  BackendErrorCode,
  BackendErrorPayload,
  DeviceApiError,
  NetworkError,
} from '../../../common/types'
import { retryWithBackoff } from '../../../common/utils'
import { getDeviceStateStore } from '../device-state-store'

const logger = getLogger('http-client')

export interface RetryPolicy {
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
}

declare module 'axios' {
  export interface AxiosRequestConfig {
    mtls?: boolean
    retry?: boolean
    retryPolicy?: RetryPolicy
  }
}

const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 2000,
  maxDelayMs: 30000,
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

    this.setupInterceptors()
    logger.info({ baseURL: config.apiBase, mtlsEnabled: this.mtlsEnabled }, 'HTTP client initialized')
  }

  private setupInterceptors(): void {
    this.client.interceptors.request.use(
      async (config) => {
        const shouldUseMtls = this.mtlsEnabled && config.mtls !== false && this.isHttpsRequest(config)
        if (shouldUseMtls) {
          config.httpsAgent = await this.createMTLSAgent()
        }

        if (this.isDeviceEndpoint(config.url || '')) {
          const state = getDeviceStateStore().getState()
          const metadata = getCertificateManager().getCertificateMetadata()
          const headerValue = state.fingerprint || metadata?.serialNumber || metadata?.fingerprint
          if (!headerValue) {
            logger.warn({ url: config.url }, 'No device auth header value available for device request')
          } else {
            const headers = AxiosHeaders.from(config.headers ?? {})
            headers.set('x-device-serial', headerValue)
            config.headers = headers
          }
        }

        return config
      },
      (error) => Promise.reject(error)
    )

    this.client.interceptors.response.use(
      (response) => response,
      (error) => Promise.reject(this.normalizeError(error))
    )
  }

  async get<T = unknown>(url: string, config?: AxiosRequestConfig): Promise<T> {
    return await this.executeWithRetry(
      async () => {
        const response = await this.client.get<T>(url, config)
        return response.data
      },
      url,
      'GET',
      config
    )
  }

  async post<T = unknown>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T> {
    return await this.executeWithRetry(
      async () => {
        const response = await this.client.post<T>(url, data, config)
        return response.data
      },
      url,
      'POST',
      config
    )
  }

  async put<T = unknown>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T> {
    return await this.executeWithRetry(
      async () => {
        const response = await this.client.put<T>(url, data, config)
        return response.data
      },
      url,
      'PUT',
      config
    )
  }

  async delete<T = unknown>(url: string, config?: AxiosRequestConfig): Promise<T> {
    return await this.executeWithRetry(
      async () => {
        const response = await this.client.delete<T>(url, config)
        return response.data
      },
      url,
      'DELETE',
      config
    )
  }

  async head(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse> {
    return await this.client.head(url, config)
  }

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
          retry: false,
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
      } catch (error) {
        const normalized = this.normalizeError(error)
        lastError = normalized.message
      }
    }

    return {
      ok: false,
      baseURL,
      endpoint: endpoints[endpoints.length - 1] || '',
      error: lastError || 'Unknown network error',
    }
  }

  enableMTLS(): void {
    this.mtlsEnabled = true
  }

  disableMTLS(): void {
    this.mtlsEnabled = false
  }

  setBaseURL(baseURL: string): void {
    this.client.defaults.baseURL = baseURL
  }

  applyConfig(config: AppConfig): void {
    this.mtlsEnabled = config.mtls.enabled
    this.setBaseURL(config.apiBase)
  }

  getAxiosInstance(): AxiosInstance {
    return this.client
  }

  private async executeWithRetry<T>(
    fn: () => Promise<T>,
    url: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    config?: AxiosRequestConfig
  ): Promise<T> {
    if (config?.retry === false) {
      return await fn()
    }

    const policy = config?.retryPolicy || DEFAULT_RETRY_POLICY
    return await retryWithBackoff(fn, {
      maxAttempts: policy.maxAttempts,
      baseDelayMs: policy.baseDelayMs,
      maxDelayMs: policy.maxDelayMs,
      shouldRetry: (_attempt, error) => this.isRetryableError(error),
      onRetry: (attempt, error) => {
        logger.warn({ url, method, attempt, error: error.message }, 'Retrying request')
      },
    })
  }

  private isHttpsRequest(config: AxiosRequestConfig): boolean {
    const url = config.url || ''
    if (url.startsWith('https://')) return true
    if (url.startsWith('http://')) return false

    const base = config.baseURL || this.client.defaults.baseURL || ''
    if (base.startsWith('https://')) return true
    if (base.startsWith('http://')) return false

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
      throw new NetworkError('Failed to load mTLS certificates', { error: String(error) })
    }
  }

  private isRetryableError(error: unknown): boolean {
    if (error instanceof DeviceApiError) {
      return error.transient
    }
    return false
  }

  private normalizeError(error: unknown): Error {
    if (error instanceof DeviceApiError) {
      return error
    }

    const axiosError = error as AxiosError<BackendErrorPayload>
    const response = axiosError.response
    const payload = response?.data?.error

    if (response) {
      const status = response.status
      const code = (payload?.code || this.codeFromStatus(status)) as BackendErrorCode
      const message = payload?.message || axiosError.message || `HTTP ${status}`
      return new DeviceApiError({
        status,
        code,
        message,
        traceId: payload?.traceId,
        detailsPayload: payload?.details,
        transient: status === 408 || status === 429 || status >= 500,
      })
    }

    const code = axiosError.code || ''
    const message = axiosError.message || 'Network request failed'
    return new DeviceApiError({
      code: 'NETWORK_ERROR',
      message,
      transient: /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|ERR_NETWORK/i.test(`${code} ${message}`),
      detailsPayload: { code },
    })
  }

  private codeFromStatus(status: number): BackendErrorCode {
    if (status === 400) return 'BAD_REQUEST'
    if (status === 401) return 'UNAUTHORIZED'
    if (status === 403) return 'FORBIDDEN'
    if (status === 404) return 'NOT_FOUND'
    if (status === 409) return 'CONFLICT'
    if (status === 422) return 'VALIDATION_ERROR'
    return 'INTERNAL_ERROR'
  }
}

let httpClient: HttpClient | null = null

export function getHttpClient(): HttpClient {
  if (!httpClient) {
    httpClient = new HttpClient()
  }
  return httpClient
}
