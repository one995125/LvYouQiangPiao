/**
 * 关键路径埋点常量与统一上报入口。
 *
 * 安全原则：
 * - 每个事件只保留明确白名单字段，页面无法任意上报对象。
 * - 禁止字段即使被误传也会被丢弃；字符串统一截断。
 * - 优先 wx.reportEvent，缺失或同步抛错时降级 wx.reportAnalytics；两者都不可用则直接返回。
 * - 上报函数永不向外抛错，也不展示任何用户提示。
 */

export const ANALYTICS_EVENTS = {
  HOME_LOAD: 'home_load',
  SCENIC_OPEN: 'scenic_open',
  TICKET_CLICK: 'ticket_click',
  FAVORITE_TOGGLE: 'favorite_toggle',
  TRIP_SAVE: 'trip_save',
  DATA_EXPORT: 'data_export',
  CALENDAR_COPY: 'calendar_copy',
  GUIDE_SEARCH: 'guide_search',
  SHARE_CLICK: 'share_click',
  GUIDE_OPEN: 'guide_open',
  CLIENT_ERROR: 'client_error',
} as const

export type AnalyticsEventName = typeof ANALYTICS_EVENTS[keyof typeof ANALYTICS_EVENTS]
export type AnalyticsValue = string | number | boolean | undefined | null
export type AnalyticsPayload = Record<string, AnalyticsValue>

const COMMON_FIELDS = ['page', 'action', 'scene', 'result'] as const
const EVENT_FIELDS: Record<AnalyticsEventName, readonly string[]> = {
  home_load: [...COMMON_FIELDS, 'item_count', 'duration_bucket'],
  scenic_open: [...COMMON_FIELDS, 'duration_bucket'],
  ticket_click: COMMON_FIELDS,
  favorite_toggle: COMMON_FIELDS,
  trip_save: [...COMMON_FIELDS, 'item_count'],
  data_export: [...COMMON_FIELDS, 'item_count'],
  calendar_copy: [...COMMON_FIELDS, 'item_count'],
  guide_search: [...COMMON_FIELDS, 'item_count', 'query_length', 'hit', 'tag_selected', 'duration_bucket'],
  share_click: COMMON_FIELDS,
  guide_open: [...COMMON_FIELDS, 'duration_bucket'],
  client_error: COMMON_FIELDS,
}

interface AnalyticsWx {
  reportEvent?: (eventName: string, data: Record<string, string | number>) => unknown
  reportAnalytics?: (eventName: string, data: Record<string, string | number>) => unknown
}

/** 把耗时压缩为区间，避免记录精确时间或形成高基数字段。 */
export function durationBucket(durationMs: number): string {
  const value = Number(durationMs)
  if (!Number.isFinite(value) || value < 0) return 'unknown'
  if (value < 300) return 'lt_300ms'
  if (value < 1000) return '300_999ms'
  if (value < 3000) return '1_3s'
  return 'gte_3s'
}

const cleanPayload = (eventName: AnalyticsEventName, payload: AnalyticsPayload): Record<string, string | number> => {
  const allowed = new Set(EVENT_FIELDS[eventName])
  const result: Record<string, string | number> = {}
  Object.keys(payload || {}).forEach((key) => {
    if (!allowed.has(key)) return
    const value = payload[key]
    if (typeof value === 'boolean') result[key] = value ? 1 : 0
    else if (typeof value === 'number' && Number.isFinite(value)) result[key] = Math.max(-999999, Math.min(999999, Math.round(value)))
    else if (typeof value === 'string') result[key] = value.trim().slice(0, 40)
  })
  return result
}

const swallowPromise = (result: unknown) => {
  const maybePromise = result as { catch?: (handler: () => void) => unknown } | null
  if (maybePromise && typeof maybePromise.catch === 'function') maybePromise.catch(() => undefined)
}

/**
 * 静默上报自定义分析事件。
 * payload 只会保留 EVENT_FIELDS 中的非隐私字段；openid、昵称、头像、备注、清单和搜索原文均无白名单入口。
 */
export function reportEvent(eventName: AnalyticsEventName, payload: AnalyticsPayload = {}) {
  try {
    if (typeof wx === 'undefined') return
    const analyticsWx = wx as unknown as AnalyticsWx
    const data = cleanPayload(eventName, payload)
    if (typeof analyticsWx.reportEvent === 'function') {
      try {
        swallowPromise(analyticsWx.reportEvent(eventName, data))
        return
      } catch (_) {
        // 新接口同步异常时继续尝试旧版自定义分析接口。
      }
    }
    if (typeof analyticsWx.reportAnalytics === 'function') {
      try {
        swallowPromise(analyticsWx.reportAnalytics(eventName, data))
      } catch (_) {
        // 埋点失败不影响任何业务路径。
      }
    }
  } catch (_) {
    // 包括基础库 API 不完整、参数校验失败等情况，均静默忽略。
  }
}
