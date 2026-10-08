/**
 * 行程天气服务。
 *
 * 设计约束：
 * - endpoint 或 key 为空时立即返回 null，绝不调用 wx.request。
 * - 天气只是行程的异步附加信息；任何网络、解析、缓存异常都静默降级为 null。
 * - 景区地址/坐标仅保存在独立的本地派生缓存，不写入行程同步协议 v2。
 */
import { STORAGE_KEYS, WEATHER_API_CONFIG } from '../constants/config'
import { Scenic, ScenicLocation } from '../types/index'

export interface WeatherInfo {
  /** 天气现象，例如“晴”“小雨”。 */
  text: string
  /** 已格式化温度，例如“12~20℃”或“18℃”。 */
  temperatureText: string
  /** 卡片直接展示的简短文案。 */
  summary: string
  /** 天气所对应的日期，格式 YYYY-MM-DD。 */
  date: string
}

export interface WeatherDestination {
  address?: string
  location?: ScenicLocation
}

interface StoredDestination extends WeatherDestination {
  updatedAt: number
}

interface WeatherCacheEntry {
  /** null 也会缓存到当天结束，避免失败接口在页面反复刷新时被连续重试。 */
  value: WeatherInfo | null
  savedAt: number
}

interface WeatherCacheState {
  entries: Record<string, WeatherCacheEntry>
  destinations: Record<string, StoredDestination>
}

type JsonRecord = Record<string, unknown>

const MAX_CACHE_ENTRIES = 160
const MAX_DESTINATIONS = 300
const inFlight = new Map<string, Promise<WeatherInfo | null>>()

const emptyCache = (): WeatherCacheState => ({ entries: {}, destinations: {} })

const isRecord = (value: unknown): value is JsonRecord =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const toRecord = (value: unknown): JsonRecord => (isRecord(value) ? value : {})

const toText = (value: unknown): string => {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

const localDate = (date = new Date()): string => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const normalizedDate = (value?: string): string =>
  value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : localDate()

const normalizeLocation = (value?: ScenicLocation): ScenicLocation | undefined => {
  if (!value) return undefined
  const lat = Number(value.lat)
  const lng = Number(value.lng)
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return undefined
  }
  return { lat, lng }
}

/** 地址优先；没有地址时才使用已核验坐标。两者都没有则返回 null。 */
export function normalizeWeatherDestination(input?: WeatherDestination | null): WeatherDestination | null {
  if (!input) return null
  const address = typeof input.address === 'string' ? input.address.trim() : ''
  if (address) return { address }
  const location = normalizeLocation(input.location)
  return location ? { location } : null
}

/** 默认关闭判断单独导出，便于页面与回归脚本确认“空配置零请求”。 */
export function isWeatherConfigured(): boolean {
  return !!WEATHER_API_CONFIG.endpoint.trim() && !!WEATHER_API_CONFIG.key.trim()
}

const readCache = (): WeatherCacheState => {
  try {
    const value = wx.getStorageSync(STORAGE_KEYS.weatherCache) as Partial<WeatherCacheState> | undefined
    if (!value || typeof value !== 'object') return emptyCache()
    return {
      entries: value.entries && typeof value.entries === 'object' ? value.entries : {},
      destinations: value.destinations && typeof value.destinations === 'object' ? value.destinations : {},
    }
  } catch (_) {
    return emptyCache()
  }
}

const newestRecord = <T extends object>(
  source: Record<string, T>,
  limit: number,
  getTime: (value: T) => number,
): Record<string, T> =>
  Object.fromEntries(
    Object.entries(source)
      .sort((a, b) => getTime(b[1]) - getTime(a[1]))
      .slice(0, limit),
  )

const writeCache = (state: WeatherCacheState) => {
  try {
    wx.setStorageSync(STORAGE_KEYS.weatherCache, {
      entries: newestRecord(state.entries, MAX_CACHE_ENTRIES, (entry) => Number(entry.savedAt) || 0),
      destinations: newestRecord(state.destinations, MAX_DESTINATIONS, (item) => Number(item.updatedAt) || 0),
    })
  } catch (_) {
    // 派生缓存写入失败不影响行程保存、列表渲染或后续再次请求。
  }
}

/**
 * 记录景区已核验地点，供行程列表在不额外请求景区详情的前提下复用。
 * 没有地址和坐标时不写入；缓存失败完全静默。
 */
export function rememberWeatherDestination(scenic?: Pick<Scenic, '_id' | 'address' | 'location'> | null) {
  if (!scenic || !scenic._id) return
  const destination = normalizeWeatherDestination(scenic)
  if (!destination) return
  const state = readCache()
  state.destinations[scenic._id] = { ...destination, updatedAt: Date.now() }
  writeCache(state)
}

const getStoredDestination = (scenicId: string): WeatherDestination | null => {
  if (!scenicId) return null
  const stored = readCache().destinations[scenicId]
  return normalizeWeatherDestination(stored)
}

const destinationKey = (destination: WeatherDestination): string => {
  if (destination.address) return `address:${destination.address.toLocaleLowerCase()}`
  const location = destination.location as ScenicLocation
  return `location:${location.lng.toFixed(6)},${location.lat.toFixed(6)}`
}

const arrayRecords = (value: unknown): JsonRecord[] =>
  Array.isArray(value) ? value.filter(isRecord) : []

/** 从常见天气接口结构中寻找逐日天气数组。 */
const dailyCandidates = (payload: JsonRecord): JsonRecord[] => {
  const data = toRecord(payload.data)
  const forecast = toRecord(payload.forecast)
  const dataForecast = toRecord(data.forecast)
  const forecasts = arrayRecords(payload.forecasts)
  const dataForecasts = arrayRecords(data.forecasts)
  return [
    ...arrayRecords(payload.daily),
    ...arrayRecords(data.daily),
    ...arrayRecords(forecast.forecastday),
    ...arrayRecords(dataForecast.forecastday),
    ...arrayRecords(toRecord(forecasts[0]).casts),
    ...arrayRecords(toRecord(dataForecasts[0]).casts),
  ]
}

const recordDate = (record: JsonRecord): string =>
  toText(record.date || record.fxDate || record.datetime || record.forecastDate)

const readConditionText = (record: JsonRecord): string => {
  const condition = toRecord(record.condition)
  const day = toRecord(record.day)
  return toText(record.text || record.weather || record.textDay || record.dayweather || condition.text || day.condition)
}

const stripTemperatureUnit = (value: string): string =>
  value.replace(/\s*(?:°\s*C|℃|摄氏度)\s*$/i, '').trim()

const formatTemperature = (record: JsonRecord): string => {
  const day = toRecord(record.day)
  const current = stripTemperatureUnit(
    toText(record.temperature || record.temp || record.temp_c || record.currentTemperature),
  )
  if (current) return `${current}℃`
  const high = stripTemperatureUnit(
    toText(record.high || record.tempMax || record.maxtemp_c || record.daytemp || day.maxtemp_c),
  )
  const low = stripTemperatureUnit(
    toText(record.low || record.tempMin || record.mintemp_c || record.nighttemp || day.mintemp_c),
  )
  if (low && high) return `${low}~${high}℃`
  if (high) return `最高 ${high}℃`
  if (low) return `最低 ${low}℃`
  return ''
}

/**
 * 解析常见的通用/QWeather/WeatherAPI/高德天气响应。
 * 无法识别时返回 null，由调用方静默隐藏天气区域。
 */
export function parseWeatherResponse(payload: unknown, targetDate: string): WeatherInfo | null {
  const root = toRecord(payload)
  const data = toRecord(root.data)
  const weather = toRecord(root.weather)
  const dataWeather = toRecord(data.weather)
  const now = toRecord(root.now)
  const dataNow = toRecord(data.now)
  const daily = dailyCandidates(root)
  const dated = daily.find((item) => recordDate(item) === targetDate) || daily[0]
  const candidates = [dated, dataWeather, weather, dataNow, now, data, root].filter(
    (item): item is JsonRecord => !!item && Object.keys(item).length > 0,
  )
  const selected = candidates.find((item) => !!readConditionText(item) || !!formatTemperature(item))
  if (!selected) return null
  const text = readConditionText(selected)
  const temperatureText = formatTemperature(selected)
  const summary = [text, temperatureText].filter(Boolean).join(' · ')
  if (!summary) return null
  return {
    text,
    temperatureText,
    summary,
    date: recordDate(selected) || targetDate,
  }
}

const requestWeather = (destination: WeatherDestination, targetDate: string): Promise<WeatherInfo | null> =>
  new Promise((resolve) => {
    let settled = false
    let task: WechatMiniprogram.RequestTask | undefined
    const finish = (value: WeatherInfo | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timeoutMs = Math.max(1000, Number(WEATHER_API_CONFIG.timeoutMs) || 5000)
    const timer = setTimeout(() => {
      if (task) task.abort()
      finish(null)
    }, timeoutMs)
    try {
      task = wx.request({
        url: WEATHER_API_CONFIG.endpoint,
        method: 'GET',
        timeout: timeoutMs,
        data: {
          key: WEATHER_API_CONFIG.key,
          location: destination.address
            ? destination.address
            : `${destination.location?.lng},${destination.location?.lat}`,
          date: targetDate,
        },
        success: (response) => {
          const statusCode = Number(response.statusCode)
          if (statusCode < 200 || statusCode >= 300) {
            finish(null)
            return
          }
          finish(parseWeatherResponse(response.data, targetDate))
        },
        fail: () => finish(null),
      })
    } catch (_) {
      finish(null)
    }
  })

/**
 * 获取一个目的地在指定出行日的天气。
 * 缓存按“本地自然日 + 出行日 + 目的地”隔离，保证同一目的地同一天只请求一次，次日可刷新预报。
 */
export async function getWeather(
  input?: WeatherDestination | null,
  targetDateValue?: string,
): Promise<WeatherInfo | null> {
  // 配置检查必须位于所有网络逻辑之前，确保默认状态下为零请求。
  if (!isWeatherConfigured()) return null
  const destination = normalizeWeatherDestination(input)
  if (!destination) return null
  const targetDate = normalizedDate(targetDateValue)
  const cacheKey = `${localDate()}|${targetDate}|${destinationKey(destination)}`
  const cached = readCache().entries[cacheKey]
  if (cached && Object.prototype.hasOwnProperty.call(cached, 'value')) return cached.value || null
  const existing = inFlight.get(cacheKey)
  if (existing) return existing

  const pending = requestWeather(destination, targetDate)
    .then((value) => {
      const state = readCache()
      state.entries[cacheKey] = { value, savedAt: Date.now() }
      writeCache(state)
      return value
    })
    .catch(() => null)
    .finally(() => inFlight.delete(cacheKey))
  inFlight.set(cacheKey, pending)
  return pending
}

/** 景区详情/行程编辑弹层调用：先记地点，再异步取天气。 */
export function getWeatherForScenic(scenic?: Scenic | null, targetDate?: string): Promise<WeatherInfo | null> {
  if (!scenic) return Promise.resolve(null)
  rememberWeatherDestination(scenic)
  return getWeather(scenic, targetDate)
}

/** 行程列表调用：只读本地地点快照，不额外请求景区列表或详情云函数。 */
export function getWeatherForTrip(scenicId: string, targetDate?: string): Promise<WeatherInfo | null> {
  if (!isWeatherConfigured()) return Promise.resolve(null)
  return getWeather(getStoredDestination(scenicId), targetDate)
}
