/**
 * 景区对比选择仓库：仅保存景区 ID，最多 3 个，不属于用户隐私数据。
 * 暂不上传云端，避免扩大现有用户数据同步协议。
 */
import { STORAGE_KEYS } from '../constants/config'

type Listener = () => void
const listeners = new Set<Listener>()

export const getCompareIds = (): string[] => {
  const value = wx.getStorageSync(STORAGE_KEYS.compareIds)
  return Array.isArray(value) ? value.filter((id) => typeof id === 'string').slice(0, 3) : []
}

const emit = () => listeners.forEach((listener) => listener())

export function subscribeComparison(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function toggleCompare(id: string): { active: boolean; full: boolean } {
  const ids = getCompareIds()
  if (ids.includes(id)) {
    wx.setStorageSync(
      STORAGE_KEYS.compareIds,
      ids.filter((item) => item !== id),
    )
    emit()
    return { active: false, full: false }
  }
  if (ids.length >= 3) return { active: false, full: true }
  wx.setStorageSync(STORAGE_KEYS.compareIds, [...ids, id])
  emit()
  return { active: true, full: false }
}

export function clearComparison() {
  wx.removeStorageSync(STORAGE_KEYS.compareIds)
  emit()
}
