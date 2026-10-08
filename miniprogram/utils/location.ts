/**
 * 景区位置工具。
 * 只做坐标合法性与球面直线距离计算，不调用地图服务，也不会持久化用户位置。
 */
import { Scenic, ScenicListItem, ScenicLocation } from '../types/index'

const EARTH_RADIUS_KM = 6371.0088
const toRadians = (degree: number): number => degree * Math.PI / 180

/** 经纬度边界采用闭区间；0 是合法值，不能用 truthy 判断。 */
export function isValidScenicLocation(value: unknown): value is ScenicLocation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const point = value as Partial<ScenicLocation>
  return typeof point.lat === 'number' && Number.isFinite(point.lat) && point.lat >= -90 && point.lat <= 90
    && typeof point.lng === 'number' && Number.isFinite(point.lng) && point.lng >= -180 && point.lng <= 180
}

/** Haversine 球面距离，仅用于榜单排序，不代表道路导航距离。 */
export function straightLineDistanceKm(from: ScenicLocation, to: ScenicLocation): number {
  const latDelta = toRadians(to.lat - from.lat)
  const lngDelta = toRadians(to.lng - from.lng)
  const fromLat = toRadians(from.lat)
  const toLat = toRadians(to.lat)
  const a = Math.sin(latDelta / 2) ** 2
    + Math.cos(fromLat) * Math.cos(toLat) * Math.sin(lngDelta / 2) ** 2
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)))
}

export interface DistanceSortResult {
  list: ScenicListItem[]
  locatedCount: number
  missingLocationCount: number
}

/** 有坐标的景区按直线距离升序；无坐标景区按热度降序放在后面，列表不会丢项。 */
export function sortScenicsByDistance(list: Scenic[], origin: ScenicLocation): DistanceSortResult {
  const located: ScenicListItem[] = []
  const missing: ScenicListItem[] = []
  list.forEach((scenic) => {
    if (isValidScenicLocation(scenic.location)) {
      located.push({ ...scenic, distanceKm: straightLineDistanceKm(origin, scenic.location) })
    } else {
      missing.push({ ...scenic })
    }
  })
  located.sort((a, b) => (a.distanceKm || 0) - (b.distanceKm || 0) || b.heat - a.heat)
  missing.sort((a, b) => b.heat - a.heat)
  return { list: [...located, ...missing], locatedCount: located.length, missingLocationCount: missing.length }
}

export function formatDistance(distanceKm: number): string {
  if (!Number.isFinite(distanceKm) || distanceKm < 0) return '—'
  if (distanceKm < 1) return `${Math.max(1, Math.round(distanceKm * 1000))}m`
  return `${distanceKm < 10 ? distanceKm.toFixed(1) : Math.round(distanceKm)}km`
}
