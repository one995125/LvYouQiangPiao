/**
 * 预约日期计算工具。
 * 只在景区已明确录入 advanceDays 时计算，避免根据自然语言攻略猜测放票日期。
 */
import { ReservationRule } from '../types/index'
import { daysUntil, toDateString } from './format'

export interface ReservationPlan {
  visitDate: string
  bookingDate: string
  advanceDays: number
  releaseTime: string
  state: 'future' | 'today' | 'past'
  stateText: string
}

function parseLocalDate(value: string): Date | null {
  const parts = value.split('-').map(Number)
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return null
  const date = new Date(parts[0], parts[1] - 1, parts[2])
  if (date.getFullYear() !== parts[0] || date.getMonth() !== parts[1] - 1 || date.getDate() !== parts[2]) return null
  return date
}

export function calculateReservationPlan(visitDate: string, rule?: ReservationRule): ReservationPlan | null {
  if (!rule || typeof rule.advanceDays !== 'number' || rule.advanceDays < 0) return null
  const visit = parseLocalDate(visitDate)
  if (!visit) return null

  const booking = new Date(visit.getFullYear(), visit.getMonth(), visit.getDate())
  booking.setDate(booking.getDate() - Math.floor(rule.advanceDays))
  const bookingDate = toDateString(booking)
  const remaining = daysUntil(bookingDate)
  const state = remaining > 0 ? 'future' : remaining === 0 ? 'today' : 'past'
  const stateText = remaining > 0 ? `距建议预约日还有 ${remaining} 天` : remaining === 0 ? '建议今天预约' : `建议预约日已过 ${-remaining} 天`

  return {
    visitDate,
    bookingDate,
    advanceDays: Math.floor(rule.advanceDays),
    releaseTime: rule.releaseTime || '',
    state,
    stateText,
  }
}
