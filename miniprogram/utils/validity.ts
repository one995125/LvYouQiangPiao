/**
 * 显式有效期判断。只依据运营资料中的 YYYY-MM-DD，不自行设定“90 天过期”等产品规则。
 * 日期按用户本地自然日比较：有效至当天仍可使用，次日才视为过期。
 */
import { toDateString } from './format'

export function isPastValidUntil(validUntil?: string, now = new Date()): boolean {
  if (!validUntil || !/^\d{4}-\d{2}-\d{2}$/.test(validUntil)) return false
  return validUntil < toDateString(now)
}
