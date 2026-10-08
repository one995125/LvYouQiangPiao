/**
 * 客户端错误监控。
 * 只发送双重脱敏后的错误摘要；云环境未就绪、限频或调用失败时全部静默返回。
 */
import { ANALYTICS_EVENTS, reportEvent } from '../constants/analytics'
import { CLOUD_FUNCTIONS } from '../constants/config'
import { callFunction, isCloudReady } from './cloud'

export type ClientErrorSource = 'app_error' | 'unhandled_rejection' | 'page_error'

const MAX_MESSAGE_LENGTH = 800
const CLIENT_WINDOW_MS = 60 * 1000
const CLIENT_MAX_PER_WINDOW = 3
const recentReports: number[] = []

const privateKeyPattern = /(openid|open_id|nickname|nick_name|avatarurl|avatar_url|note|checklist|keyword|search_text|token|authorization)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^,;\s}]+)/gi

/** 客户端首层脱敏；云函数会再次执行同等级清洗。 */
export function sanitizeErrorMessage(input: unknown): string {
  let raw = ''
  if (input instanceof Error) raw = [input.name, input.message, input.stack].filter(Boolean).join('\n')
  else if (input && typeof input === 'object') {
    const value = input as { name?: unknown; message?: unknown; errMsg?: unknown; stack?: unknown }
    raw = [value.name, value.message, value.errMsg, value.stack]
      .filter((item) => typeof item === 'string')
      .join('\n')
  } else raw = String(input || '')

  return raw
    .replace(privateKeyPattern, '$1=[redacted]')
    .replace(/\b(?:o|wx)[A-Za-z0-9_-]{18,}\b/g, '[redacted-id]')
    .replace(/\b1[3-9]\d{9}\b/g, '[redacted-phone]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
    .replace(/([A-Za-z]:\\Users\\)[^\\\s]+/gi, '$1[redacted-user]')
    .replace(/(https?:\/\/[^\s?#]+)\?[^\s]*/gi, '$1?[redacted-query]')
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]')
    .trim()
    .slice(0, MAX_MESSAGE_LENGTH)
}

const normalizeName = (value: unknown, fallback: string): string => {
  const clean = String(value || '').toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 40)
  return clean || fallback
}

const allowClientReport = (): boolean => {
  const now = Date.now()
  while (recentReports.length && recentReports[0] <= now - CLIENT_WINDOW_MS) recentReports.shift()
  if (recentReports.length >= CLIENT_MAX_PER_WINDOW) return false
  recentReports.push(now)
  return true
}

/**
 * 上报错误摘要。调用方可直接 void reportClientError(...)，函数内部保证 Promise 已捕获。
 */
export async function reportClientError(source: ClientErrorSource, error: unknown, page = 'app'): Promise<void> {
  try {
    if (!allowClientReport()) return
    const message = sanitizeErrorMessage(error)
    if (!message) return
    const safePage = normalizeName(page, 'unknown')
    const errorType = normalizeName(error instanceof Error ? error.name : 'unknown_error', 'unknown_error')

    // 自定义分析只记录粗粒度次数，不携带错误正文。
    reportEvent(ANALYTICS_EVENTS.CLIENT_ERROR, {
      page: safePage,
      action: 'capture',
      scene: source,
      result: errorType,
    })

    // 不主动初始化云环境，避免错误监控反向改变登录/启动策略。
    if (!isCloudReady()) return
    await callFunction(
      CLOUD_FUNCTIONS.log,
      { action: 'write', log: { source, page: safePage, errorType, message } },
      { silent: true },
    ).catch(() => undefined)
  } catch (_) {
    // 监控代码本身永不影响用户操作，也不制造新的未处理 Promise。
  }
}
