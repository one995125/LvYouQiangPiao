/**
 * 收藏、行程与系统日历文本导出。
 * 本模块只接收数据并返回纯文本，不读写 storage、不调用微信 API，便于独立回归测试。
 */
import { FavoriteItem, TripItem, TripPeriod, TripStatus } from '../types/index'

const PERIOD_LABELS: Record<TripPeriod, string> = {
  all: '全天',
  morning: '上午',
  afternoon: '下午',
  evening: '晚上',
}

const STATUS_LABELS: Record<TripStatus, string> = {
  pending: '待抢票',
  booked: '已购票',
  done: '已出行',
}

/** 页面与回归脚本共用的能力边界文案，避免后续误导为可直接写入系统日历。 */
export const CALENDAR_LIMITATION_TEXT = '小程序无法直接写入系统日历，请到系统日历新建日程后粘贴以下内容。'

/** 清除换行和多余空白，防止用户备注破坏每条记录的纯文本结构。 */
const clean = (value?: string): string => String(value || '').replace(/\s+/g, ' ').trim()

const formatLocalDate = (timestamp: number): string => {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return ''
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return ''
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const formatPlace = (province?: string, city?: string): string => {
  const values = [clean(province), clean(city)].filter(Boolean)
  return Array.from(new Set(values)).join(' · ')
}

/**
 * 生成全部收藏的备份文本，按收藏时间倒序排列。
 * 空数组返回空字符串，由页面给出“暂无收藏可导出”的明确提示。
 */
export function buildFavoritesExportText(items: FavoriteItem[]): string {
  if (!Array.isArray(items) || !items.length) return ''
  const ordered = items.slice().sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
  const lines = ['拾景 · 我的收藏备份', `共 ${ordered.length} 条`]
  ordered.forEach((item, index) => {
    lines.push('', `${index + 1}. [${item.type === 'guide' ? '攻略' : '景区'}] ${clean(item.title) || '未命名'}`)
    const subtitle = clean(item.subtitle)
    if (subtitle) lines.push(`   简介：${subtitle}`)
    const savedAt = formatLocalDate(Number(item.createdAt))
    if (savedAt) lines.push(`   收藏日期：${savedAt}`)
  })
  return lines.join('\n')
}

const orderedTrips = (items: TripItem[]): TripItem[] =>
  items.slice().sort((a, b) => {
    const dateCompare = (a.date || '9999-99-99').localeCompare(b.date || '9999-99-99')
    return dateCompare || Number(b.updatedAt || 0) - Number(a.updatedAt || 0)
  })

const appendTripDetails = (lines: string[], trip: TripItem) => {
  lines.push(`   日期：${trip.date || '待定'}`)
  lines.push(`   时段：${PERIOD_LABELS[trip.period || 'all']}`)
  lines.push(`   状态：${STATUS_LABELS[trip.status]}`)
  const place = formatPlace(trip.province, trip.city)
  if (place) lines.push(`   地点：${place}`)
  const note = clean(trip.note)
  if (note) lines.push(`   备注：${note}`)
  const checklist = (Array.isArray(trip.checklist) ? trip.checklist : []).map(clean).filter(Boolean)
  if (checklist.length) lines.push(`   出行准备：${checklist.join('、')}`)
}

/** 生成全部行程备份；日期待定的行程仍会保留，避免备份缺项。 */
export function buildTripsExportText(items: TripItem[]): string {
  if (!Array.isArray(items) || !items.length) return ''
  const ordered = orderedTrips(items)
  const lines = ['拾景 · 我的行程备份', `共 ${ordered.length} 条`]
  ordered.forEach((trip, index) => {
    lines.push('', `${index + 1}. ${clean(trip.scenicName) || '未命名景区'}`)
    appendTripDetails(lines, trip)
  })
  return lines.join('\n')
}

/**
 * 生成可粘贴到系统日历的新建日程文本。
 * 只包含填写了合法日期的行程；没有可用日期时返回空字符串。
 */
export function buildCalendarExportText(items: TripItem[]): string {
  const dated = orderedTrips(Array.isArray(items) ? items : []).filter((trip) => /^\d{4}-\d{2}-\d{2}$/.test(trip.date))
  if (!dated.length) return ''
  const lines = ['拾景 · 系统日历日程文本', CALENDAR_LIMITATION_TEXT, `共 ${dated.length} 条`]
  dated.forEach((trip, index) => {
    lines.push('', `${index + 1}. 标题：游览${clean(trip.scenicName) || '景区'}`)
    lines.push(`   日期：${trip.date}`)
    lines.push(`   时段：${PERIOD_LABELS[trip.period || 'all']}`)
    const place = formatPlace(trip.province, trip.city)
    if (place) lines.push(`   地点：${place}`)
    lines.push(`   状态：${STATUS_LABELS[trip.status]}`)
    const note = clean(trip.note)
    if (note) lines.push(`   备注：${note}`)
  })
  return lines.join('\n')
}
