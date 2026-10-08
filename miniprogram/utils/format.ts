/** 纯函数格式化工具（无副作用） */

/** 游客量：万人次 → 「1,500 万」/「2.5 千万」 */
export function formatVisitors(wan: number): string {
  if (wan >= 1000) return `${(wan / 1000).toFixed(wan % 1000 === 0 ? 0 : 1)} 千万`
  return `${wan} 万`
}

export function formatCount(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}w`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return `${n}`
}

export function formatPrice(price: number): string {
  return price === 0 ? '免费' : `¥${price}`
}

const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`)

export function toDateString(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  const m = 60 * 1000
  const h = 60 * m
  const d = 24 * h
  if (diff < h) return `${Math.max(1, Math.floor(diff / m))} 分钟前`
  if (diff < d) return `${Math.floor(diff / h)} 小时前`
  if (diff < 7 * d) return `${Math.floor(diff / d)} 天前`
  const date = new Date(ts)
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`
}

/** 距离某日期还有几天；负数表示已过去 */
export function daysUntil(date: string): number {
  if (!date) return NaN
  const [y, mo, da] = date.split('-').map(Number)
  const target = new Date(y, mo - 1, da).getTime()
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  return Math.round((target - today) / (24 * 3600 * 1000))
}

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

export function splitDate(date: string): { month: string; day: string; week: string } {
  if (!date) return { month: '', day: '', week: '' }
  const [y, mo, da] = date.split('-').map(Number)
  const d = new Date(y, mo - 1, da)
  return { month: `${mo} 月`, day: pad(da), week: WEEK[d.getDay()] }
}

export function countdownLabel(date: string): string {
  const n = daysUntil(date)
  if (isNaN(n)) return '日期待定'
  if (n === 0) return '就是今天'
  if (n === 1) return '明天出发'
  if (n > 0) return `${n} 天后`
  return `已过 ${-n} 天`
}
