/**
 * 用户数据仓库：收藏、足迹、行程、资料与云同步。
 *
 * 同步协议 v2：
 * - 本地写入立即生效，并记录 dirtyAt；首次成功拉取云端基线前禁止上传。
 * - 上传携带 baseRevision，云函数在事务中做乐观锁校验。
 * - 删除操作保留墓碑，旧设备再次上线时不会把已删除条目复活。
 * - 冲突时合并双方条目与墓碑，只自动重试一次；网络失败按 2s / 10s / 60s 退避重试。
 * - App 回到前台或网络恢复时主动续接同步，但拉取基线失败后仍禁止上传。
 * - 条目写入使用服务端时间校正；偏移尚不可用时安全降级为本机时间。
 * - 已确认真实 openid 换号时先隔离本地账号数据，再拉取新账号基线。
 */
import {
  CLOUD_FUNCTIONS,
  MAX_SYNC_FAVORITES,
  MAX_SYNC_FOOTPRINTS,
  MAX_SYNC_PROVINCES,
  MAX_SYNC_SCENIC_MARKS,
  MAX_SYNC_TOMBSTONES,
  MAX_SYNC_TRIPS,
  STORAGE_KEYS,
} from '../constants/config'
import { callFunction, CloudError, ensureCloudReady, isCloudReady } from '../services/cloud'
import { primaryOfficialEntry } from '../services/ticket'
import {
  FavoriteItem,
  FootprintItem,
  ProvinceMarkRecord,
  ProvinceMarkState,
  Scenic,
  ScenicMarkItem,
  ScenicMarkState,
  TripItem,
  TripPeriod,
  TripStatus,
  UserProfile,
} from '../types/index'
import { PROVINCES } from '../constants/provinces'

const SYNC_SCHEMA = 2

export interface DeletionTombstone {
  id: string
  deletedAt: number
}

interface SyncMeta {
  userOpenid: string
  revision: number
  baselineReady: boolean
  dirtyAt: number
  lastSyncedAt: number
  /** 最近一次成功完成云端拉取或上传的本机时间，仅用于前台拉取节流。 */
  lastCloudSuccessAt: number
  lastError: string
  /** 容量裁剪提示只通过同步状态展示，不弹窗打扰用户。 */
  lastWarning: string
  /** 服务端时间减去本机时间；写同步冲突时间戳时使用，展示时间仍使用本机真实浏览时间。 */
  clockOffsetMs: number
  /** 只有收到云函数明确返回的 serverTime 后才为 true；旧云函数与离线状态会安全降级。 */
  clockOffsetReady: boolean
  /** 最近一次校时请求往返耗时的一半，用于诊断，不参与协议判定。 */
  clockUncertaintyMs: number
}

interface UserDataSnapshot {
  schema: number
  revision: number
  favorites: FavoriteItem[]
  footprints: FootprintItem[]
  footprintClearedAt: number
  trips: TripItem[]
  favoriteTombstones: DeletionTombstone[]
  tripTombstones: DeletionTombstone[]
  /** 旅行地图字段全部可选，旧客户端不传时由云端保留现有值。 */
  visitedProvinces?: string[]
  wishProvinces?: string[]
  provinceMarks?: ProvinceMarkRecord[]
  visitedScenics?: ScenicMarkItem[]
  wishScenics?: ScenicMarkItem[]
  visitedScenicTombstones?: DeletionTombstone[]
  wishScenicTombstones?: DeletionTombstone[]
  updatedAt: number
  /** 云函数响应时刻；可选以兼容尚未部署新字段的旧云函数。 */
  serverTime?: number
}

export interface SyncViewState {
  status: 'local' | 'waiting' | 'syncing' | 'synced' | 'error'
  text: string
  revision: number
  lastSyncedAt: number
}

type Listener = () => void
const listeners = new Set<Listener>()

export function subscribe(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

const emit = () =>
  listeners.forEach((fn) => {
    try {
      fn()
    } catch (e) {
      console.warn('[user-data] 页面刷新监听执行失败', e)
    }
  })

const read = <T>(key: string, fallback: T): T => {
  try {
    const value = wx.getStorageSync(key)
    return (value === '' || value === undefined || value === null ? fallback : value) as T
  } catch (e) {
    return fallback
  }
}

const write = (key: string, value: unknown) => wx.setStorageSync(key, value)

const EMPTY_META: SyncMeta = {
  userOpenid: '',
  revision: 0,
  baselineReady: false,
  dirtyAt: 0,
  lastSyncedAt: 0,
  lastCloudSuccessAt: 0,
  lastError: '',
  lastWarning: '',
  clockOffsetMs: 0,
  clockOffsetReady: false,
  clockUncertaintyMs: 0,
}

const getSyncMeta = (): SyncMeta => ({ ...EMPTY_META, ...read<Partial<SyncMeta>>(STORAGE_KEYS.syncMeta, {}) })
const setSyncMeta = (meta: SyncMeta) => write(STORAGE_KEYS.syncMeta, meta)

let syncPhase: SyncViewState['status'] = 'waiting'
let syncTimer: number | null = null
let retryTimer: number | null = null
let retryAttempt = 0
let pushPromise: Promise<boolean> | null = null
let pullPromise: Promise<boolean> | null = null
let pushPromiseOwner = ''
let pullPromiseOwner = ''
/** 在途请求无法取消，用代际号阻止旧账号响应写回新账号本地状态。 */
let identityGeneration = 0

const PUSH_RETRY_DELAYS = [2000, 10000, 60000]
const FOREGROUND_PULL_INTERVAL = 60 * 1000
/** 删除时间即使比编辑时间早不超过 15 分钟，也优先保留删除，覆盖常见设备时钟漂移。 */
export const DELETE_WINS_WINDOW_MS = 15 * 60 * 1000

/* ───────── 资料 ───────── */

export const getProfile = (): UserProfile | null => read<UserProfile | null>(STORAGE_KEYS.profile, null)

export function setProfile(profile: UserProfile | null) {
  if (profile) write(STORAGE_KEYS.profile, profile)
  else wx.removeStorageSync(STORAGE_KEYS.profile)
  if (!profile) {
    syncPhase = 'local'
    cancelRetryTimer(true)
  }
  emit()
}

export type CloudIdentityTransition = 'invalid' | 'same' | 'first-cloud' | 'switched'

/** local_ 为本机匿名身份，不可作为“已确认换号”的依据。 */
export function isValidCloudOpenid(openid: unknown): openid is string {
  return typeof openid === 'string' && openid.trim().length > 0 && !openid.trim().startsWith('local_')
}

/**
 * 在真实 openid 写入 profile 前处理身份边界。
 * - A -> B：立即纯本地清空 A 的同步数据，绑定 B 但保持 baselineReady=false。
 * - 匿名 -> 首个真实 openid：保留离线数据，重置云端 revision，成功拉取基线后再合并上传。
 *
 * 本函数不调用云端、不 markDirty、不安排上传；重复调用只会得到同样的空快照或保留快照。
 */
export function prepareForCloudIdentity(
  nextOpenidValue: unknown,
  previousProfile: UserProfile | null = getProfile(),
): CloudIdentityTransition {
  if (!isValidCloudOpenid(nextOpenidValue)) return 'invalid'
  const nextOpenid = nextOpenidValue.trim()
  const meta = getSyncMeta()
  const knownOwners = new Set<string>()
  if (isValidCloudOpenid(meta.userOpenid)) knownOwners.add(meta.userOpenid.trim())
  if (previousProfile?.cloud && isValidCloudOpenid(previousProfile.openid)) {
    knownOwners.add(previousProfile.openid.trim())
  }

  const switched = Array.from(knownOwners).some((openid) => openid !== nextOpenid)
  if (switched) {
    identityGeneration += 1
    cancelPendingSyncTimers()
    ;[
      STORAGE_KEYS.favorites,
      STORAGE_KEYS.footprints,
      STORAGE_KEYS.footprintClearedAt,
      STORAGE_KEYS.trips,
      STORAGE_KEYS.syncedAt,
      STORAGE_KEYS.favoriteTombstones,
      STORAGE_KEYS.tripTombstones,
      STORAGE_KEYS.visitedProvinces,
      STORAGE_KEYS.wishProvinces,
      STORAGE_KEYS.provinceMarks,
      STORAGE_KEYS.visitedScenics,
      STORAGE_KEYS.wishScenics,
      STORAGE_KEYS.visitedScenicTombstones,
      STORAGE_KEYS.wishScenicTombstones,
    ].forEach((key) => wx.removeStorageSync(key))
    // 先绑定新 owner 但绝不开放上传；新账号必须完成一次成功 pull 才能写云端。
    setSyncMeta({ ...EMPTY_META, userOpenid: nextOpenid })
    syncPhase = 'waiting'
    emit()
    return 'switched'
  }

  if (knownOwners.has(nextOpenid)) return 'same'

  // 首次真实登录保留匿名期间的数据，只清除不存在的云端基线状态。
  identityGeneration += 1
  cancelPendingSyncTimers()
  setSyncMeta({
    ...EMPTY_META,
    dirtyAt: meta.dirtyAt,
    lastWarning: meta.lastWarning,
    clockOffsetMs: meta.clockOffsetMs,
    clockOffsetReady: meta.clockOffsetReady,
    clockUncertaintyMs: meta.clockUncertaintyMs,
  })
  syncPhase = 'waiting'
  emit()
  return 'first-cloud'
}

export const isLoggedIn = (): boolean => !!getProfile()

export function getSyncState(): SyncViewState {
  const profile = getProfile()
  const meta = getSyncMeta()
  if (!isCloudReady() || !profile?.cloud) {
    return { status: 'local', text: '本地模式 · 数据保存在本机', revision: meta.revision, lastSyncedAt: meta.lastSyncedAt }
  }
  if (syncPhase === 'syncing') {
    return { status: 'syncing', text: '正在同步收藏、浏览历史与行程…', revision: meta.revision, lastSyncedAt: meta.lastSyncedAt }
  }
  if (meta.lastError) {
    return { status: 'error', text: '云同步失败，本机数据已安全保留', revision: meta.revision, lastSyncedAt: meta.lastSyncedAt }
  }
  if (meta.dirtyAt) {
    return { status: 'waiting', text: '本机有变更，等待同步', revision: meta.revision, lastSyncedAt: meta.lastSyncedAt }
  }
  if (meta.lastWarning) {
    return { status: 'synced', text: meta.lastWarning, revision: meta.revision, lastSyncedAt: meta.lastSyncedAt }
  }
  if (meta.baselineReady) {
    return { status: 'synced', text: '收藏、浏览历史与行程已云端同步', revision: meta.revision, lastSyncedAt: meta.lastSyncedAt }
  }
  return { status: 'waiting', text: '等待首次云端同步', revision: meta.revision, lastSyncedAt: meta.lastSyncedAt }
}

/* ───────── 收藏 ───────── */

export const getFavorites = (): FavoriteItem[] => read<FavoriteItem[]>(STORAGE_KEYS.favorites, [])
const getFavoriteTombstones = (): DeletionTombstone[] => read<DeletionTombstone[]>(STORAGE_KEYS.favoriteTombstones, [])

export const isFavorite = (type: FavoriteItem['type'], targetId: string): boolean =>
  getFavorites().some((favorite) => favorite.id === `${type}:${targetId}`)

/** 切换收藏；返回 null 表示达到当前云端同步容量，且不会改变本机数据。 */
export function toggleFavorite(item: Omit<FavoriteItem, 'id' | 'createdAt'>): boolean | null {
  const id = `${item.type}:${item.targetId}`
  const list = getFavorites()
  const index = list.findIndex((favorite) => favorite.id === id)
  if (index < 0 && list.length >= MAX_SYNC_FAVORITES) return null
  const now = correctedNow()
  let active: boolean
  if (index >= 0) {
    list.splice(index, 1)
    writeTombstone(STORAGE_KEYS.favoriteTombstones, id, now)
    active = false
  } else {
    list.unshift({ ...item, id, createdAt: now })
    removeTombstone(STORAGE_KEYS.favoriteTombstones, id)
    active = true
  }
  write(STORAGE_KEYS.favorites, list)
  markDirty()
  emit()
  return active
}

export function favoriteFromScenic(scenic: Scenic): Omit<FavoriteItem, 'id' | 'createdAt'> {
  return { type: 'scenic', targetId: scenic._id, title: scenic.name, subtitle: scenic.city, tone: scenic.tone }
}

/* ───────── 足迹 ───────── */

export const getFootprints = (): FootprintItem[] => read<FootprintItem[]>(STORAGE_KEYS.footprints, [])
const getFootprintClearedAt = (): number => Number(read<number>(STORAGE_KEYS.footprintClearedAt, 0)) || 0

/**
 * 记录景区浏览足迹：同一景区只保留一条，重复浏览会更新快照、时间并置顶。
 * 最多保留最近 200 条，避免本地和云端文档持续膨胀。
 */
export function recordFootprint(scenic: Scenic): FootprintItem {
  const clearedAt = getFootprintClearedAt()
  const localVisitedAt = Date.now()
  const visitedAt = Math.max(correctedNow(), clearedAt + 1)
  const footprint: FootprintItem = {
    id: scenic._id,
    scenicId: scenic._id,
    scenicName: scenic.name,
    province: scenic.province,
    city: scenic.city,
    tone: scenic.tone,
    cover: scenic.cover || '',
    visitedAt,
    localVisitedAt,
  }
  const next = [footprint, ...getFootprints().filter((item) => item.scenicId !== scenic._id)]
    .sort((a, b) => b.visitedAt - a.visitedAt)
    .slice(0, MAX_SYNC_FOOTPRINTS)
  write(STORAGE_KEYS.footprints, next)
  markDirty()
  emit()
  return footprint
}

/** 清空全部足迹，并记录水位，防止其他设备的旧足迹在冲突合并时复活。 */
export function clearFootprints() {
  const latestVisitedAt = getFootprints().reduce((max, item) => Math.max(max, Number(item.visitedAt) || 0), 0)
  write(STORAGE_KEYS.footprints, [])
  write(STORAGE_KEYS.footprintClearedAt, Math.max(correctedNow(), latestVisitedAt))
  markDirty()
  emit()
}

/* ───────── 旅行地图 ───────── */

const PROVINCE_CODE_SET = new Set(PROVINCES.map((item) => item.code))

function normalizeProvinceCodes(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return Array.from(new Set(value.filter((code): code is string => typeof code === 'string' && PROVINCE_CODE_SET.has(code))))
    .slice(0, MAX_SYNC_PROVINCES)
}

function normalizeProvinceMarks(value: unknown): ProvinceMarkRecord[] {
  if (!Array.isArray(value)) return []
  const map = new Map<string, ProvinceMarkRecord>()
  value.forEach((item) => {
    if (!item || typeof item !== 'object') return
    const mark = item as ProvinceMarkRecord
    if (!PROVINCE_CODE_SET.has(mark.code) || !['visited', 'wish', 'none'].includes(mark.state)) return
    const normalized = { code: mark.code, state: mark.state, updatedAt: Number(mark.updatedAt) || 0 }
    const previous = map.get(mark.code)
    if (!previous || normalized.updatedAt >= previous.updatedAt) map.set(mark.code, normalized)
  })
  return Array.from(map.values()).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_SYNC_PROVINCES)
}

function readProvinceMarks(): ProvinceMarkRecord[] {
  const records = normalizeProvinceMarks(read<ProvinceMarkRecord[]>(STORAGE_KEYS.provinceMarks, []))
  if (records.length) return records
  // 兼容首次升级：旧本机若只有两个数组，按去过优先消除可能的重复。
  const visited = normalizeProvinceCodes(read<string[]>(STORAGE_KEYS.visitedProvinces, []))
  const visitedSet = new Set(visited)
  const wish = normalizeProvinceCodes(read<string[]>(STORAGE_KEYS.wishProvinces, [])).filter((code) => !visitedSet.has(code))
  return [
    ...visited.map((code) => ({ code, state: 'visited' as const, updatedAt: 0 })),
    ...wish.map((code) => ({ code, state: 'wish' as const, updatedAt: 0 })),
  ]
}

function writeProvinceMarks(records: ProvinceMarkRecord[]) {
  const normalized = normalizeProvinceMarks(records)
  write(STORAGE_KEYS.provinceMarks, normalized)
  write(STORAGE_KEYS.visitedProvinces, normalized.filter((item) => item.state === 'visited').map((item) => item.code))
  write(STORAGE_KEYS.wishProvinces, normalized.filter((item) => item.state === 'wish').map((item) => item.code))
}

export const getVisitedProvinces = (): string[] => readProvinceMarks().filter((item) => item.state === 'visited').map((item) => item.code)
export const getWishProvinces = (): string[] => readProvinceMarks().filter((item) => item.state === 'wish').map((item) => item.code)
export const getProvinceMarkState = (code: string): ProvinceMarkState =>
  readProvinceMarks().find((item) => item.code === code)?.state || 'none'

function applyProvinceMark(code: string, state: ProvinceMarkState, updatedAt: number) {
  if (!PROVINCE_CODE_SET.has(code)) return
  const next = readProvinceMarks().filter((item) => item.code !== code)
  next.unshift({ code, state, updatedAt })
  writeProvinceMarks(next)
}

/** 手动点亮或取消省份；去过与想去始终互斥，后设置的状态覆盖旧状态。 */
export function setProvinceMark(code: string, state: ScenicMarkState | null): ProvinceMarkState {
  if (!PROVINCE_CODE_SET.has(code)) return 'none'
  const nextState: ProvinceMarkState = state || 'none'
  applyProvinceMark(code, nextState, correctedNow())
  markDirty()
  emit()
  return nextState
}

function normalizeScenicMarks(value: unknown): ScenicMarkItem[] {
  if (!Array.isArray(value)) return []
  const map = new Map<string, ScenicMarkItem>()
  value.forEach((item) => {
    if (!item || typeof item !== 'object') return
    const mark = item as ScenicMarkItem
    if (!mark.id || typeof mark.id !== 'string') return
    const normalized = { id: mark.id, updatedAt: Number(mark.updatedAt) || 0 }
    const previous = map.get(mark.id)
    if (!previous || normalized.updatedAt > previous.updatedAt) map.set(mark.id, normalized)
  })
  return Array.from(map.values()).sort((a, b) => b.updatedAt - a.updatedAt)
}

const readScenicMarks = (key: string): ScenicMarkItem[] => normalizeScenicMarks(read(key, []))
export const getVisitedScenics = (): ScenicMarkItem[] => readScenicMarks(STORAGE_KEYS.visitedScenics).slice(0, MAX_SYNC_SCENIC_MARKS)
export const getWishScenics = (): ScenicMarkItem[] => readScenicMarks(STORAGE_KEYS.wishScenics).slice(0, MAX_SYNC_SCENIC_MARKS)
const getVisitedScenicTombstones = () => read<DeletionTombstone[]>(STORAGE_KEYS.visitedScenicTombstones, [])
const getWishScenicTombstones = () => read<DeletionTombstone[]>(STORAGE_KEYS.wishScenicTombstones, [])

export const getScenicMarkState = (scenicId: string): ScenicMarkState | null => {
  if (getVisitedScenics().some((item) => item.id === scenicId)) return 'visited'
  if (getWishScenics().some((item) => item.id === scenicId)) return 'wish'
  return null
}

/**
 * 切换景区“去过/想去”。两类标记互斥；新增标记会自动以同状态点亮景区所属省份。
 * 返回最终状态，null 表示再次点击后取消。
 */
export function toggleScenicMark(scenic: Scenic, requested: ScenicMarkState): ScenicMarkState | null {
  const now = correctedNow()
  let visited = readScenicMarks(STORAGE_KEYS.visitedScenics)
  let wish = readScenicMarks(STORAGE_KEYS.wishScenics)
  const current = visited.some((item) => item.id === scenic._id)
    ? 'visited'
    : wish.some((item) => item.id === scenic._id) ? 'wish' : null
  const next = current === requested ? null : requested

  visited = visited.filter((item) => item.id !== scenic._id)
  wish = wish.filter((item) => item.id !== scenic._id)
  if (next === 'visited') visited.unshift({ id: scenic._id, updatedAt: now })
  if (next === 'wish') wish.unshift({ id: scenic._id, updatedAt: now })

  const droppedVisited = visited.slice(MAX_SYNC_SCENIC_MARKS)
  const droppedWish = wish.slice(MAX_SYNC_SCENIC_MARKS)
  visited = visited.slice(0, MAX_SYNC_SCENIC_MARKS)
  wish = wish.slice(0, MAX_SYNC_SCENIC_MARKS)
  write(STORAGE_KEYS.visitedScenics, visited)
  write(STORAGE_KEYS.wishScenics, wish)

  if (next === 'visited') {
    removeTombstone(STORAGE_KEYS.visitedScenicTombstones, scenic._id)
    writeTombstone(STORAGE_KEYS.wishScenicTombstones, scenic._id, now)
  } else if (next === 'wish') {
    removeTombstone(STORAGE_KEYS.wishScenicTombstones, scenic._id)
    writeTombstone(STORAGE_KEYS.visitedScenicTombstones, scenic._id, now)
  } else {
    writeTombstone(
      current === 'visited' ? STORAGE_KEYS.visitedScenicTombstones : STORAGE_KEYS.wishScenicTombstones,
      scenic._id,
      now,
    )
  }
  droppedVisited.forEach((item) => writeTombstone(STORAGE_KEYS.visitedScenicTombstones, item.id, now))
  droppedWish.forEach((item) => writeTombstone(STORAGE_KEYS.wishScenicTombstones, item.id, now))
  if (next) applyProvinceMark(scenic.province, next, now)

  const warning = droppedVisited.length
    ? `去过景区超过 ${MAX_SYNC_SCENIC_MARKS} 条，已保留最近更新的 ${MAX_SYNC_SCENIC_MARKS} 条`
    : droppedWish.length ? `想去景区超过 ${MAX_SYNC_SCENIC_MARKS} 条，已保留最近更新的 ${MAX_SYNC_SCENIC_MARKS} 条` : ''
  markDirty(warning)
  emit()
  return next
}

/* ───────── 行程 ───────── */

export const getTrips = (): TripItem[] => read<TripItem[]>(STORAGE_KEYS.trips, [])
const getTripTombstones = (): DeletionTombstone[] => read<DeletionTombstone[]>(STORAGE_KEYS.tripTombstones, [])

export const findTripByScenic = (scenicId: string): TripItem | undefined =>
  getTrips().find((trip) => trip.scenicId === scenicId && trip.status !== 'done')

export function saveTrip(input: {
  scenic: Scenic
  date: string
  period: TripPeriod
  note: string
  checklist: string[]
  status: TripStatus
  id?: string
}): TripItem {
  const list = getTrips()
  const localNow = Date.now()
  const now = correctedNow(localNow)
  const scenic = input.scenic
  const existing = input.id ? list.find((trip) => trip.id === input.id) : undefined
  const trip: TripItem = {
    id: existing ? existing.id : `t${localNow.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    scenicId: scenic._id,
    scenicName: scenic.name,
    province: scenic.province,
    city: scenic.city,
    tone: scenic.tone,
    date: input.date,
    period: input.period,
    status: input.status,
    note: input.note,
    checklist: input.checklist.slice(0, 12),
    // 行程使用景区当前首选官方入口作为离线快照，旧行程结构保持兼容。
    ticket: primaryOfficialEntry(scenic),
    booking: scenic.booking,
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
  }
  const next = existing ? list.map((item) => (item.id === trip.id ? trip : item)) : [trip, ...list]
  // 行程超过云端容量时立即保留最近更新的 500 条，并为被裁剪项写入删除墓碑。
  // 这样本机与云端快照始终一致，不会出现“上传成功但第 501 条被服务端静默丢弃”。
  const ordered = next.slice().sort((a, b) => itemUpdatedAt(b) - itemUpdatedAt(a))
  const kept = ordered.slice(0, MAX_SYNC_TRIPS)
  const dropped = ordered.slice(MAX_SYNC_TRIPS)
  write(STORAGE_KEYS.trips, kept)
  removeTombstone(STORAGE_KEYS.tripTombstones, trip.id)
  dropped.forEach((item) => writeTombstone(STORAGE_KEYS.tripTombstones, item.id, now))
  markDirty(dropped.length ? `行程超过 ${MAX_SYNC_TRIPS} 条，已保留最近更新的 ${MAX_SYNC_TRIPS} 条并同步` : '')
  emit()
  return trip
}

export function updateTripStatus(id: string, status: TripStatus) {
  const list = getTrips()
  if (!list.some((trip) => trip.id === id)) return
  write(
    STORAGE_KEYS.trips,
    list.map((trip) => (trip.id === id ? { ...trip, status, updatedAt: correctedNow() } : trip)),
  )
  markDirty()
  emit()
}

export function removeTrip(id: string) {
  const list = getTrips()
  if (!list.some((trip) => trip.id === id)) return
  write(
    STORAGE_KEYS.trips,
    list.filter((trip) => trip.id !== id),
  )
  writeTombstone(STORAGE_KEYS.tripTombstones, id, correctedNow())
  markDirty()
  emit()
}

export const pendingTripCount = (): number => getTrips().filter((trip) => trip.status === 'pending').length

/* ───────── 云同步 ───────── */

const itemUpdatedAt = (item: { createdAt: number; updatedAt?: number }): number =>
  Number(item.updatedAt || item.createdAt) || 0

/** 获取用于同步冲突判定的当前时间；没有校时结果时直接使用 Date.now()。 */
function correctedNow(localNow = Date.now()): number {
  const meta = getSyncMeta()
  if (!meta.clockOffsetReady || !Number.isFinite(meta.clockOffsetMs)) return localNow
  return Math.max(1, Math.round(localNow + meta.clockOffsetMs))
}

/**
 * 采用请求发出与收到响应的本机时间中点估算偏移，避免把完整网络耗时算进时钟差。
 * serverTime 是可选字段；旧云函数未返回时保持现有偏移或继续本机时间降级。
 */
function updateServerClock(serverTime: unknown, requestStartedAt: number, responseReceivedAt: number): boolean {
  const value = Number(serverTime)
  if (!Number.isFinite(value) || value <= 0) return false
  const midpoint = requestStartedAt + Math.max(0, responseReceivedAt - requestStartedAt) / 2
  const meta = getSyncMeta()
  setSyncMeta({
    ...meta,
    clockOffsetMs: Math.round(value - midpoint),
    clockOffsetReady: true,
    clockUncertaintyMs: Math.ceil(Math.max(0, responseReceivedAt - requestStartedAt) / 2),
  })
  return true
}

function isActiveIdentity(openid: string, generation: number): boolean {
  const current = getProfile()
  return identityGeneration === generation && !!current?.cloud && current.openid === openid
}

function normalizeTombstones(list: DeletionTombstone[]): DeletionTombstone[] {
  const map = new Map<string, DeletionTombstone>()
  list.forEach((item) => {
    if (!item?.id) return
    const previous = map.get(item.id)
    if (!previous || Number(item.deletedAt) > Number(previous.deletedAt)) map.set(item.id, item)
  })
  return Array.from(map.values())
    .sort((a, b) => b.deletedAt - a.deletedAt)
    .slice(0, MAX_SYNC_TOMBSTONES)
}

function writeTombstone(key: string, id: string, deletedAt: number) {
  write(key, normalizeTombstones([{ id, deletedAt }, ...read<DeletionTombstone[]>(key, [])]))
}

function removeTombstone(key: string, id: string) {
  write(
    key,
    read<DeletionTombstone[]>(key, []).filter((item) => item.id !== id),
  )
}

function markDirty(warning = '') {
  const meta = getSyncMeta()
  setSyncMeta({ ...meta, dirtyAt: Date.now(), lastError: '', lastWarning: warning })
  syncPhase = 'waiting'
  scheduleSync()
}

function scheduleSync() {
  const profile = getProfile()
  const meta = getSyncMeta()
  if (!isCloudReady() || !profile?.cloud || !isValidCloudOpenid(profile.openid) || !meta.baselineReady || meta.userOpenid !== profile.openid) return
  if (syncTimer) clearTimeout(syncTimer)
  syncTimer = setTimeout(() => {
    syncTimer = null
    void pushToCloud()
  }, 1200) as unknown as number
}

function cancelRetryTimer(resetAttempt: boolean) {
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = null
  if (resetAttempt) retryAttempt = 0
}

function cancelPendingSyncTimers() {
  cancelRetryTimer(true)
  if (syncTimer) clearTimeout(syncTimer)
  syncTimer = null
}

/** 上传失败后按 2s / 10s / 60s 退避；60s 为后续重试上限。 */
function schedulePushRetry() {
  const profile = getProfile()
  const meta = getSyncMeta()
  // 基线未就绪时绝不安排上传；只能由前台恢复或网络恢复重新拉取基线。
  if (
    !isCloudReady() ||
    !profile?.cloud ||
    !isValidCloudOpenid(profile.openid) ||
    !meta.baselineReady ||
    meta.userOpenid !== profile.openid ||
    !meta.dirtyAt
  ) return
  if (retryTimer) return
  const delay = PUSH_RETRY_DELAYS[Math.min(retryAttempt, PUSH_RETRY_DELAYS.length - 1)]
  retryAttempt = Math.min(retryAttempt + 1, PUSH_RETRY_DELAYS.length - 1)
  retryTimer = setTimeout(() => {
    retryTimer = null
    void pushToCloud()
  }, delay) as unknown as number
}

function currentSnapshot(): UserDataSnapshot {
  const meta = getSyncMeta()
  return {
    schema: SYNC_SCHEMA,
    revision: meta.revision,
    favorites: getFavorites(),
    footprints: getFootprints(),
    footprintClearedAt: getFootprintClearedAt(),
    trips: getTrips(),
    favoriteTombstones: getFavoriteTombstones(),
    tripTombstones: getTripTombstones(),
    visitedProvinces: getVisitedProvinces(),
    wishProvinces: getWishProvinces(),
    provinceMarks: readProvinceMarks(),
    visitedScenics: readScenicMarks(STORAGE_KEYS.visitedScenics),
    wishScenics: readScenicMarks(STORAGE_KEYS.wishScenics),
    visitedScenicTombstones: getVisitedScenicTombstones(),
    wishScenicTombstones: getWishScenicTombstones(),
    updatedAt: meta.lastSyncedAt,
  }
}

function normalizeSnapshot(value: Partial<UserDataSnapshot> | null | undefined): UserDataSnapshot {
  const snapshot = value || {}
  return {
    schema: Number(snapshot.schema) || 1,
    revision: Number(snapshot.revision) || 0,
    favorites: Array.isArray(snapshot.favorites) ? snapshot.favorites : [],
    footprints: Array.isArray(snapshot.footprints) ? snapshot.footprints : [],
    footprintClearedAt: Number(snapshot.footprintClearedAt) || 0,
    trips: Array.isArray(snapshot.trips) ? snapshot.trips : [],
    favoriteTombstones: Array.isArray(snapshot.favoriteTombstones) ? snapshot.favoriteTombstones : [],
    tripTombstones: Array.isArray(snapshot.tripTombstones) ? snapshot.tripTombstones : [],
    visitedProvinces: normalizeProvinceCodes(snapshot.visitedProvinces),
    wishProvinces: normalizeProvinceCodes(snapshot.wishProvinces),
    provinceMarks: normalizeProvinceMarks(snapshot.provinceMarks),
    visitedScenics: normalizeScenicMarks(snapshot.visitedScenics),
    wishScenics: normalizeScenicMarks(snapshot.wishScenics),
    visitedScenicTombstones: Array.isArray(snapshot.visitedScenicTombstones) ? snapshot.visitedScenicTombstones : [],
    wishScenicTombstones: Array.isArray(snapshot.wishScenicTombstones) ? snapshot.wishScenicTombstones : [],
    updatedAt: Number(snapshot.updatedAt) || 0,
  }
}

/** 足迹按最近浏览时间合并，并应用双方较新的“全部清空”水位。 */
function mergeFootprints(local: UserDataSnapshot, remote: UserDataSnapshot): { items: FootprintItem[]; clearedAt: number } {
  const clearedAt = Math.max(local.footprintClearedAt, remote.footprintClearedAt)
  const itemMap = new Map<string, FootprintItem>()
  ;[...local.footprints, ...remote.footprints].forEach((item) => {
    if (!item?.scenicId || !item.id) return
    const visitedAt = Number(item.visitedAt) || 0
    if (visitedAt <= clearedAt) return
    const previous = itemMap.get(item.scenicId)
    if (!previous || visitedAt > (Number(previous.visitedAt) || 0)) itemMap.set(item.scenicId, item)
  })
  return {
    items: Array.from(itemMap.values())
      .sort((a, b) => b.visitedAt - a.visitedAt)
      .slice(0, MAX_SYNC_FOOTPRINTS),
    clearedAt,
  }
}

/** 同时合并条目和删除墓碑；时间较新的状态胜出。 */
function mergeGroup<T extends { id: string; createdAt?: number; updatedAt?: number }>(
  localItems: T[],
  remoteItems: T[],
  localTombstones: DeletionTombstone[],
  remoteTombstones: DeletionTombstone[],
): { items: T[]; tombstones: DeletionTombstone[] } {
  const itemMap = new Map<string, T>()
  const tombstoneMap = new Map<string, DeletionTombstone>()
  const stamp = (item: T) => Number(item.updatedAt || item.createdAt) || 0

  ;[...localItems, ...remoteItems].forEach((item) => {
    if (!item || !item.id) return
    const previous = itemMap.get(item.id)
    if (!previous || stamp(item) > stamp(previous)) itemMap.set(item.id, item)
  })
  ;[...localTombstones, ...remoteTombstones].forEach((item) => {
    if (!item || !item.id) return
    const previous = tombstoneMap.get(item.id)
    if (!previous || item.deletedAt > previous.deletedAt) tombstoneMap.set(item.id, item)
  })

  tombstoneMap.forEach((tombstone, id) => {
    const item = itemMap.get(id)
    if (!item) return
    if (tombstone.deletedAt + DELETE_WINS_WINDOW_MS >= stamp(item)) itemMap.delete(id)
    else tombstoneMap.delete(id)
  })

  return {
    items: Array.from(itemMap.values()).sort((a, b) => stamp(b) - stamp(a)),
    tombstones: Array.from(tombstoneMap.values()).sort((a, b) => b.deletedAt - a.deletedAt),
  }
}

function snapshotProvinceMarks(snapshot: UserDataSnapshot): ProvinceMarkRecord[] {
  const direct = normalizeProvinceMarks(snapshot.provinceMarks)
  if (direct.length) return direct
  const visited = normalizeProvinceCodes(snapshot.visitedProvinces)
  const visitedSet = new Set(visited)
  const wish = normalizeProvinceCodes(snapshot.wishProvinces).filter((code) => !visitedSet.has(code))
  return [
    ...visited.map((code) => ({ code, state: 'visited' as const, updatedAt: 0 })),
    ...wish.map((code) => ({ code, state: 'wish' as const, updatedAt: 0 })),
  ]
}

/** 省份按校正后的更新时间合并；同时间冲突用去过优先，确保两数组永不重叠。 */
function mergeProvinceMarks(local: UserDataSnapshot, remote: UserDataSnapshot): ProvinceMarkRecord[] {
  const map = new Map<string, ProvinceMarkRecord>()
  ;[...snapshotProvinceMarks(local), ...snapshotProvinceMarks(remote)].forEach((item) => {
    const previous = map.get(item.code)
    if (!previous || item.updatedAt > previous.updatedAt || (item.updatedAt === previous.updatedAt && item.state === 'visited')) {
      map.set(item.code, item)
    }
  })
  return normalizeProvinceMarks(Array.from(map.values()))
}

function resolveScenicMarkOverlap(visited: ScenicMarkItem[], wish: ScenicMarkItem[]) {
  const visitedMap = new Map(visited.map((item) => [item.id, item]))
  const wishMap = new Map(wish.map((item) => [item.id, item]))
  visitedMap.forEach((item, id) => {
    const other = wishMap.get(id)
    if (!other) return
    if (other.updatedAt > item.updatedAt) visitedMap.delete(id)
    else wishMap.delete(id)
  })
  return {
    visited: Array.from(visitedMap.values()).sort((a, b) => b.updatedAt - a.updatedAt),
    wish: Array.from(wishMap.values()).sort((a, b) => b.updatedAt - a.updatedAt),
  }
}

export function mergeUserDataSnapshots(localValue: Partial<UserDataSnapshot>, remoteValue: Partial<UserDataSnapshot>): UserDataSnapshot {
  const local = normalizeSnapshot(localValue)
  const remote = normalizeSnapshot(remoteValue)
  const favorites = mergeGroup(
    local.favorites,
    remote.favorites,
    local.favoriteTombstones,
    remote.favoriteTombstones,
  )
  const trips = mergeGroup(local.trips, remote.trips, local.tripTombstones, remote.tripTombstones)
  const footprints = mergeFootprints(local, remote)
  const visitedScenics = mergeGroup(
    local.visitedScenics || [], remote.visitedScenics || [],
    local.visitedScenicTombstones || [], remote.visitedScenicTombstones || [],
  )
  const wishScenics = mergeGroup(
    local.wishScenics || [], remote.wishScenics || [],
    local.wishScenicTombstones || [], remote.wishScenicTombstones || [],
  )
  const scenicMarks = resolveScenicMarkOverlap(visitedScenics.items, wishScenics.items)
  const provinceMarks = mergeProvinceMarks(local, remote)
  return {
    schema: SYNC_SCHEMA,
    revision: remote.revision,
    favorites: favorites.items,
    footprints: footprints.items,
    footprintClearedAt: footprints.clearedAt,
    trips: trips.items,
    favoriteTombstones: favorites.tombstones,
    tripTombstones: trips.tombstones,
    visitedProvinces: provinceMarks.filter((item) => item.state === 'visited').map((item) => item.code),
    wishProvinces: provinceMarks.filter((item) => item.state === 'wish').map((item) => item.code),
    provinceMarks,
    visitedScenics: scenicMarks.visited,
    wishScenics: scenicMarks.wish,
    visitedScenicTombstones: visitedScenics.tombstones,
    wishScenicTombstones: wishScenics.tombstones,
    updatedAt: Math.max(local.updatedAt, remote.updatedAt),
  }
}

function snapshotFingerprint(snapshot: UserDataSnapshot): string {
  const byId = <T extends { id: string }>(list: T[]) => list.slice().sort((a, b) => a.id.localeCompare(b.id))
  return JSON.stringify({
    favorites: byId(snapshot.favorites),
    footprints: byId(snapshot.footprints),
    footprintClearedAt: snapshot.footprintClearedAt,
    trips: byId(snapshot.trips),
    favoriteTombstones: byId(snapshot.favoriteTombstones),
    tripTombstones: byId(snapshot.tripTombstones),
    visitedProvinces: (snapshot.visitedProvinces || []).slice().sort(),
    wishProvinces: (snapshot.wishProvinces || []).slice().sort(),
    provinceMarks: (snapshot.provinceMarks || []).slice().sort((a, b) => a.code.localeCompare(b.code)),
    visitedScenics: byId(snapshot.visitedScenics || []),
    wishScenics: byId(snapshot.wishScenics || []),
    visitedScenicTombstones: byId(snapshot.visitedScenicTombstones || []),
    wishScenicTombstones: byId(snapshot.wishScenicTombstones || []),
  })
}

function persistSnapshot(snapshot: UserDataSnapshot) {
  write(STORAGE_KEYS.favorites, snapshot.favorites)
  write(STORAGE_KEYS.footprints, snapshot.footprints)
  write(STORAGE_KEYS.footprintClearedAt, snapshot.footprintClearedAt)
  write(STORAGE_KEYS.trips, snapshot.trips)
  write(STORAGE_KEYS.favoriteTombstones, snapshot.favoriteTombstones)
  write(STORAGE_KEYS.tripTombstones, snapshot.tripTombstones)
  writeProvinceMarks(snapshot.provinceMarks || [])
  write(STORAGE_KEYS.visitedScenics, snapshot.visitedScenics || [])
  write(STORAGE_KEYS.wishScenics, snapshot.wishScenics || [])
  write(STORAGE_KEYS.visitedScenicTombstones, snapshot.visitedScenicTombstones || [])
  write(STORAGE_KEYS.wishScenicTombstones, snapshot.wishScenicTombstones || [])
}

interface PreparedSnapshot {
  snapshot: UserDataSnapshot
  warning: string
}

/**
 * 上传前逐类整理容量：只裁剪超限类别，其余类别继续正常上传。
 * 收藏/行程被裁剪时同时生成删除墓碑，防止旧设备把已裁剪条目重新带回。
 */
function prepareSnapshotForPush(): PreparedSnapshot {
  const original = currentSnapshot()
  const now = correctedNow()
  const warnings: string[] = []

  const orderedFavorites = original.favorites.slice().sort((a, b) => b.createdAt - a.createdAt)
  const favorites = orderedFavorites.slice(0, MAX_SYNC_FAVORITES)
  const droppedFavorites = orderedFavorites.slice(MAX_SYNC_FAVORITES)
  if (droppedFavorites.length) warnings.push(`收藏超过 ${MAX_SYNC_FAVORITES} 条，已保留最新 ${MAX_SYNC_FAVORITES} 条`)

  const orderedFootprints = original.footprints.slice().sort((a, b) => b.visitedAt - a.visitedAt)
  const footprints = orderedFootprints.slice(0, MAX_SYNC_FOOTPRINTS)
  if (orderedFootprints.length > MAX_SYNC_FOOTPRINTS) {
    warnings.push(`浏览历史超过 ${MAX_SYNC_FOOTPRINTS} 条，已保留最近 ${MAX_SYNC_FOOTPRINTS} 条`)
  }

  const orderedTrips = original.trips.slice().sort((a, b) => itemUpdatedAt(b) - itemUpdatedAt(a))
  const trips = orderedTrips.slice(0, MAX_SYNC_TRIPS)
  const droppedTrips = orderedTrips.slice(MAX_SYNC_TRIPS)
  if (droppedTrips.length) warnings.push(`行程超过 ${MAX_SYNC_TRIPS} 条，已保留最近更新的 ${MAX_SYNC_TRIPS} 条`)

  const provinceMarks = normalizeProvinceMarks(original.provinceMarks)
  const visitedProvinces = provinceMarks.filter((item) => item.state === 'visited').map((item) => item.code).slice(0, MAX_SYNC_PROVINCES)
  const wishProvinces = provinceMarks.filter((item) => item.state === 'wish').map((item) => item.code).slice(0, MAX_SYNC_PROVINCES)

  const orderedVisitedScenics = normalizeScenicMarks(original.visitedScenics)
  const visitedScenics = orderedVisitedScenics.slice(0, MAX_SYNC_SCENIC_MARKS)
  const droppedVisitedScenics = orderedVisitedScenics.slice(MAX_SYNC_SCENIC_MARKS)
  if (droppedVisitedScenics.length) warnings.push(`去过景区超过 ${MAX_SYNC_SCENIC_MARKS} 条，已保留最近更新的 ${MAX_SYNC_SCENIC_MARKS} 条`)

  const orderedWishScenics = normalizeScenicMarks(original.wishScenics)
  const wishScenics = orderedWishScenics.slice(0, MAX_SYNC_SCENIC_MARKS)
  const droppedWishScenics = orderedWishScenics.slice(MAX_SYNC_SCENIC_MARKS)
  if (droppedWishScenics.length) warnings.push(`想去景区超过 ${MAX_SYNC_SCENIC_MARKS} 条，已保留最近更新的 ${MAX_SYNC_SCENIC_MARKS} 条`)

  const rawFavoriteTombstones = [
    ...original.favoriteTombstones,
    ...droppedFavorites.map((item) => ({ id: item.id, deletedAt: now })),
  ]
  const rawTripTombstones = [
    ...original.tripTombstones,
    ...droppedTrips.map((item) => ({ id: item.id, deletedAt: now })),
  ]
  const favoriteTombstones = normalizeTombstones(rawFavoriteTombstones)
  const tripTombstones = normalizeTombstones(rawTripTombstones)
  const rawVisitedScenicTombstones = [
    ...(original.visitedScenicTombstones || []),
    ...droppedVisitedScenics.map((item) => ({ id: item.id, deletedAt: now })),
  ]
  const rawWishScenicTombstones = [
    ...(original.wishScenicTombstones || []),
    ...droppedWishScenics.map((item) => ({ id: item.id, deletedAt: now })),
  ]
  const visitedScenicTombstones = normalizeTombstones(rawVisitedScenicTombstones)
  const wishScenicTombstones = normalizeTombstones(rawWishScenicTombstones)
  if (rawFavoriteTombstones.length > MAX_SYNC_TOMBSTONES) {
    warnings.push(`收藏删除记录超过 ${MAX_SYNC_TOMBSTONES} 条，已优先保留最近记录`)
  }
  if (rawTripTombstones.length > MAX_SYNC_TOMBSTONES) {
    warnings.push(`行程删除记录超过 ${MAX_SYNC_TOMBSTONES} 条，已优先保留最近记录`)
  }

  const snapshot: UserDataSnapshot = {
    ...original,
    favorites,
    footprints,
    trips,
    favoriteTombstones,
    tripTombstones,
    visitedProvinces,
    wishProvinces,
    provinceMarks,
    visitedScenics,
    wishScenics,
    visitedScenicTombstones,
    wishScenicTombstones,
  }
  if (snapshotFingerprint(snapshot) !== snapshotFingerprint(original)) persistSnapshot(snapshot)
  return { snapshot, warning: warnings.join('；') }
}

interface SaveResult {
  revision: number
  updatedAt: number
  serverTime?: number
}

async function performPush(allowConflictRetry: boolean): Promise<boolean> {
  const profile = getProfile()
  const meta = getSyncMeta()
  if (
    !isCloudReady() ||
    !profile?.cloud ||
    !isValidCloudOpenid(profile.openid) ||
    !meta.baselineReady ||
    meta.userOpenid !== profile.openid ||
    !meta.dirtyAt
  ) {
    return true
  }

  const startedDirtyAt = meta.dirtyAt
  const requestGeneration = identityGeneration
  const prepared = prepareSnapshotForPush()
  const snapshot = prepared.snapshot
  syncPhase = 'syncing'
  emit()

  const requestStartedAt = Date.now()
  try {
    const saved = await callFunction<SaveResult>(CLOUD_FUNCTIONS.userData, {
      action: 'save',
      schema: SYNC_SCHEMA,
      baseRevision: meta.revision,
      favorites: snapshot.favorites,
      footprints: snapshot.footprints,
      footprintClearedAt: snapshot.footprintClearedAt,
      trips: snapshot.trips,
      favoriteTombstones: snapshot.favoriteTombstones,
      tripTombstones: snapshot.tripTombstones,
      visitedProvinces: snapshot.visitedProvinces,
      wishProvinces: snapshot.wishProvinces,
      provinceMarks: snapshot.provinceMarks,
      visitedScenics: snapshot.visitedScenics,
      wishScenics: snapshot.wishScenics,
      visitedScenicTombstones: snapshot.visitedScenicTombstones,
      wishScenicTombstones: snapshot.wishScenicTombstones,
    })
    const responseReceivedAt = Date.now()
    if (!isActiveIdentity(profile.openid, requestGeneration)) return false
    updateServerClock(saved.serverTime, requestStartedAt, responseReceivedAt)
    const latest = getSyncMeta()
    const hasNewerChange = latest.dirtyAt > startedDirtyAt
    setSyncMeta({
      ...latest,
      userOpenid: profile.openid,
      revision: saved.revision,
      baselineReady: true,
      dirtyAt: hasNewerChange ? latest.dirtyAt : 0,
      lastSyncedAt: saved.updatedAt || Date.now(),
      lastCloudSuccessAt: Date.now(),
      lastError: '',
      lastWarning: prepared.warning || latest.lastWarning,
    })
    write(STORAGE_KEYS.syncedAt, saved.updatedAt || Date.now())
    cancelRetryTimer(true)
    syncPhase = hasNewerChange ? 'waiting' : 'synced'
    emit()
    if (hasNewerChange) scheduleSync()
    return true
  } catch (error) {
    const responseReceivedAt = Date.now()
    if (!isActiveIdentity(profile.openid, requestGeneration)) return false
    if (allowConflictRetry && error instanceof CloudError && error.code === 'SYNC_CONFLICT') {
      const detail = error.data as { snapshot?: Partial<UserDataSnapshot> } | undefined
      if (detail?.snapshot) {
        updateServerClock(detail.snapshot.serverTime, requestStartedAt, responseReceivedAt)
        const remote = normalizeSnapshot(detail.snapshot)
        const merged = mergeUserDataSnapshots(currentSnapshot(), remote)
        persistSnapshot(merged)
        const latest = getSyncMeta()
        setSyncMeta({
          ...latest,
          userOpenid: profile.openid,
          revision: remote.revision,
          baselineReady: true,
          dirtyAt: latest.dirtyAt || Date.now(),
          lastError: '',
        })
        emit()
        return performPush(false)
      }
    }

    const latest = getSyncMeta()
    const message = error instanceof Error ? error.message : '未知同步错误'
    setSyncMeta({ ...latest, dirtyAt: latest.dirtyAt || startedDirtyAt, lastError: message })
    syncPhase = 'error'
    console.warn('[user-data] 上传失败，本机数据与删除墓碑均已保留', error)
    emit()
    schedulePushRetry()
    return false
  }
}

export async function pushToCloud(): Promise<boolean> {
  const owner = getProfile()?.openid || ''
  if (pushPromise) {
    if (pushPromiseOwner === owner) return pushPromise
    // 换号时等待旧请求收尾，保持全局单飞；旧响应会被 identityGeneration 丢弃。
    await pushPromise
  }
  const pending = performPush(true)
  pushPromise = pending
  pushPromiseOwner = owner
  try {
    return await pending
  } finally {
    if (pushPromise === pending) {
      pushPromise = null
      pushPromiseOwner = ''
    }
  }
}

/**
 * 登录后拉取云端基线。
 * 只有 get 成功才会开放上传；任何读取异常都会保留本机数据并停止本轮写入。
 */
async function performPull(): Promise<boolean> {
  const profile = getProfile()
  if (!isCloudReady() || !profile?.cloud) return true

  // 防御性检查：即使调用方绕过 auth.login，确认换号后也会先隔离旧账号本地数据。
  if (prepareForCloudIdentity(profile.openid, profile) === 'invalid') return false
  const requestGeneration = identityGeneration

  syncPhase = 'syncing'
  emit()
  const requestStartedAt = Date.now()
  try {
    const response = await callFunction<UserDataSnapshot>(CLOUD_FUNCTIONS.userData, { action: 'get', schema: SYNC_SCHEMA })
    const responseReceivedAt = Date.now()
    if (!isActiveIdentity(profile.openid, requestGeneration)) return false
    updateServerClock(response.serverTime, requestStartedAt, responseReceivedAt)
    const remote = normalizeSnapshot(response)
    const previousMeta = getSyncMeta()
    const sameOwner = !previousMeta.userOpenid || previousMeta.userOpenid === profile.openid
    const local = currentSnapshot()
    const merged = sameOwner ? mergeUserDataSnapshots(local, remote) : remote
    const needsPush = sameOwner && snapshotFingerprint(merged) !== snapshotFingerprint(remote)

    persistSnapshot(merged)
    setSyncMeta({
      userOpenid: profile.openid,
      revision: remote.revision,
      baselineReady: true,
      dirtyAt: needsPush ? previousMeta.dirtyAt || Date.now() : 0,
      lastSyncedAt: remote.updatedAt || previousMeta.lastSyncedAt,
      lastCloudSuccessAt: Date.now(),
      lastError: '',
      lastWarning: previousMeta.lastWarning,
      clockOffsetMs: previousMeta.clockOffsetMs,
      clockOffsetReady: previousMeta.clockOffsetReady,
      clockUncertaintyMs: previousMeta.clockUncertaintyMs,
    })
    cancelRetryTimer(true)
    syncPhase = needsPush ? 'waiting' : 'synced'
    emit()

    if (needsPush) return pushToCloud()
    if (remote.updatedAt) write(STORAGE_KEYS.syncedAt, remote.updatedAt)
    return true
  } catch (error) {
    if (!isActiveIdentity(profile.openid, requestGeneration)) return false
    const meta = getSyncMeta()
    const message = error instanceof Error ? error.message : '未知同步错误'
    setSyncMeta({ ...meta, baselineReady: false, lastError: message })
    syncPhase = 'error'
    console.warn('[user-data] 云端基线拉取失败，已阻止本轮上传', error)
    cancelRetryTimer(false)
    emit()
    return false
  }
}

/** 拉取同样采用单飞，避免登录、App.onShow 与网络恢复同时发起重复请求。 */
export async function pullFromCloud(): Promise<boolean> {
  const owner = getProfile()?.openid || ''
  if (pullPromise) {
    if (pullPromiseOwner === owner) return pullPromise
    // 账号发生变化时先等待旧 pull 返回；旧响应不会写本地，随后立即为新账号重新拉基线。
    await pullPromise
  }
  const pending = performPull()
  pullPromise = pending
  pullPromiseOwner = owner
  try {
    return await pending
  } finally {
    if (pullPromise === pending) {
      pullPromise = null
      pullPromiseOwner = ''
    }
  }
}

/**
 * App 回到前台时续接同步：超过 1 分钟才拉取远端；间隔内若有脏数据则只尝试上传。
 * 仅处理已有 cloud profile，不创建 profile、不触发登录，也不改变现有静默登录策略。
 */
export async function syncUserDataOnAppShow(): Promise<boolean> {
  const profile = getProfile()
  if (!profile?.cloud) return true
  if (!(await ensureCloudReady())) return false
  const meta = getSyncMeta()
  const baselineMissing = !meta.baselineReady || meta.userOpenid !== profile.openid
  const pullExpired = Date.now() - meta.lastCloudSuccessAt >= FOREGROUND_PULL_INTERVAL
  if (baselineMissing || pullExpired) return pullFromCloud()
  if (meta.dirtyAt) {
    cancelRetryTimer(false)
    return pushToCloud()
  }
  return true
}

/** 网络恢复时立即续接一次；基线无效时先拉取，绝不直接上传。 */
export async function syncUserDataOnNetworkRestore(): Promise<boolean> {
  const profile = getProfile()
  if (!profile?.cloud) return true
  if (!(await ensureCloudReady())) return false
  const meta = getSyncMeta()
  if (!meta.baselineReady || meta.userOpenid !== profile.openid) return pullFromCloud()
  cancelRetryTimer(false)
  if (meta.dirtyAt) return pushToCloud()
  return pullFromCloud()
}

export function clearLocalUserData() {
  identityGeneration += 1
  cancelPendingSyncTimers()
  ;[
    STORAGE_KEYS.favorites,
    STORAGE_KEYS.footprints,
    STORAGE_KEYS.footprintClearedAt,
    STORAGE_KEYS.trips,
    STORAGE_KEYS.profile,
    STORAGE_KEYS.localGuides,
    STORAGE_KEYS.likedGuides,
    STORAGE_KEYS.searchHistory,
    STORAGE_KEYS.syncedAt,
    STORAGE_KEYS.favoriteTombstones,
    STORAGE_KEYS.tripTombstones,
    STORAGE_KEYS.visitedProvinces,
    STORAGE_KEYS.wishProvinces,
    STORAGE_KEYS.provinceMarks,
    STORAGE_KEYS.visitedScenics,
    STORAGE_KEYS.wishScenics,
    STORAGE_KEYS.visitedScenicTombstones,
    STORAGE_KEYS.wishScenicTombstones,
    STORAGE_KEYS.syncMeta,
    STORAGE_KEYS.compareIds,
  ].forEach((key) => wx.removeStorageSync(key))
  syncPhase = 'local'
  emit()
}
