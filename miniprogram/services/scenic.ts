/**
 * 景区数据服务
 * 云端优先（shijing_scenics 集合，公开只读），失败或为空时回落到内置示例数据，保证任何环境下都有内容可看。
 */
import { COLLECTIONS, PAGE_SIZE } from '../constants/config'
import { SCENICS } from '../data/scenics'
import { Scenic, ScenicListItem, ScenicLocation, SortKey } from '../types/index'
import { db, ensureCloudReady } from './cloud'
import { getProvince } from '../constants/provinces'
import { isValidScenicLocation, sortScenicsByDistance } from '../utils/location'

export interface ScenicQuery {
  province: string
  sort: SortKey
  only5A?: boolean
  page?: number
  /** 仅 nearest 排序使用，不会发送到云端或写入 storage。 */
  origin?: ScenicLocation
}

export interface ScenicPage {
  list: ScenicListItem[]
  hasMore: boolean
  /** 当前范围完全没有已核验坐标，返回列表已整体回退为热度排序。 */
  nearestFallback?: boolean
  /** 部分景区缺少坐标时，它们会按热度排在有坐标景区之后。 */
  missingLocationCount?: number
}

const sortLocal = (list: Scenic[], sort: Exclude<SortKey, 'nearest'>): Scenic[] =>
  list.slice().sort((a, b) => (sort === 'price' ? a.price - b.price : b[sort] - a[sort]))

const isTop = (s: Scenic): boolean => s.level === '5A' || s.level === '世界遗产'

function queryLocal(q: ScenicQuery): ScenicPage {
  const page = q.page || 0
  let list = SCENICS.filter((s) => s.province === q.province)
  if (q.only5A) list = list.filter(isTop)
  if (q.sort === 'nearest') {
    const result = q.origin && isValidScenicLocation(q.origin)
      ? sortScenicsByDistance(list, q.origin)
      : { list: sortLocal(list, 'heat'), locatedCount: 0, missingLocationCount: list.length }
    const sorted = result.locatedCount ? result.list : sortLocal(list, 'heat')
    return {
      list: sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
      hasMore: (page + 1) * PAGE_SIZE < sorted.length,
      nearestFallback: result.locatedCount === 0,
      missingLocationCount: result.missingLocationCount,
    }
  }
  list = sortLocal(list, q.sort)
  const slice = list.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
  return { list: slice, hasMore: (page + 1) * PAGE_SIZE < list.length }
}

/** 最近排序必须先取到当前省份的完整候选集，不能对每个分页分别排序。 */
async function listNearestScenics(q: ScenicQuery, where: Record<string, unknown>): Promise<ScenicPage> {
  if (!q.origin || !isValidScenicLocation(q.origin)) return queryLocal(q)
  const list: Scenic[] = []
  for (let page = 0; ; page += 1) {
    const res = await db()
      .collection(COLLECTIONS.scenics)
      .where(where)
      .orderBy('heat', 'desc')
      .skip(page * PAGE_SIZE)
      .limit(PAGE_SIZE)
      .get()
    const batch = res.data as unknown as Scenic[]
    list.push(...batch)
    if (batch.length < PAGE_SIZE) break
  }
  if (!list.length) return queryLocal(q)
  const result = sortScenicsByDistance(list, q.origin)
  const sorted = result.locatedCount ? result.list : sortLocal(list, 'heat')
  const page = q.page || 0
  return {
    list: sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
    hasMore: (page + 1) * PAGE_SIZE < sorted.length,
    nearestFallback: result.locatedCount === 0,
    missingLocationCount: result.missingLocationCount,
  }
}

export async function listScenics(q: ScenicQuery): Promise<ScenicPage> {
  if (!(await ensureCloudReady())) return queryLocal(q)
  try {
    const _ = db().command
    const page = q.page || 0
    const where: Record<string, unknown> = { province: q.province }
    if (q.only5A) where.level = _.in(['5A', '世界遗产'])
    if (q.sort === 'nearest') return await listNearestScenics(q, where)
    const res = await db()
      .collection(COLLECTIONS.scenics)
      .where(where)
      .orderBy(q.sort, q.sort === 'price' ? 'asc' : 'desc')
      .skip(page * PAGE_SIZE)
      .limit(PAGE_SIZE)
      .get()
    const list = res.data as unknown as Scenic[]
    if (page === 0 && list.length === 0) return queryLocal(q)
    return { list, hasMore: list.length === PAGE_SIZE }
  } catch (err) {
    console.warn('[scenic] 云端查询失败，使用本地数据', err)
    return queryLocal(q)
  }
}

export async function getScenic(id: string): Promise<Scenic | null> {
  const local = SCENICS.find((s) => s._id === id) || null
  if (!(await ensureCloudReady())) return local
  try {
    const res = await db().collection(COLLECTIONS.scenics).doc(id).get()
    return (res.data as unknown as Scenic) || local
  } catch (err) {
    return local
  }
}

export async function searchScenics(keyword: string): Promise<Scenic[]> {
  const kw = keyword.trim()
  if (!kw) return []

  const normalize = (value: string) => value.toLowerCase().replace(/[\s\-_]/g, '')
  const synonymMap: Record<string, string[]> = {
    '古建': ['古迹'],
    '历史': ['古迹', '博物馆'],
    '爬山': ['山岳'],
    '登山': ['山岳'],
    '寺庙': ['宗教'],
    '乐园': ['主题乐园'],
    '博物': ['博物馆'],
  }
  const terms = [kw, ...(synonymMap[kw] || [])].map(normalize)
  const score = (scenic: Scenic): number => {
    const name = normalize(scenic.name)
    const city = normalize(scenic.city)
    const corpus = normalize(
      [
        scenic.name,
        scenic.city,
        getProvince(scenic.province).name,
        scenic.alias,
        scenic.category,
        scenic.level,
        scenic.price === 0 ? '免费' : '',
        ...(scenic.tags || []),
        ...(scenic.searchKeywords || []),
        scenic.ticket.name,
      ].join(' '),
    )
    let value = 0
    terms.forEach((term) => {
      if (name === term) value = Math.max(value, 100)
      else if (name.startsWith(term)) value = Math.max(value, 85)
      else if (name.includes(term)) value = Math.max(value, 75)
      else if (city === term) value = Math.max(value, 65)
      else if (corpus.includes(term)) value = Math.max(value, 45)
    })
    return value
  }
  const matchLocal = () =>
    SCENICS.map((scenic) => ({ scenic, score: score(scenic) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || b.scenic.heat - a.scenic.heat)
      .slice(0, 30)
      .map((item) => item.scenic)
  if (!(await ensureCloudReady())) return matchLocal()
  try {
    const d = db()
    const reg = d.RegExp({ regexp: kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), options: 'i' })
    const _ = d.command
    const res = await d
      .collection(COLLECTIONS.scenics)
      .where(_.or([{ name: reg }, { city: reg }, { category: reg }, { level: reg }]))
      .orderBy('heat', 'desc')
      .limit(30)
      .get()
    const cloudList = res.data as unknown as Scenic[]
    const merged = new Map<string, Scenic>()
    // 同一景区必须以云端最新维护资料为准，不能再被本地示例覆盖。
    ;[...matchLocal(), ...cloudList].forEach((scenic) => merged.set(scenic._id, scenic))
    return Array.from(merged.values()).slice(0, 30)
  } catch (err) {
    return matchLocal()
  }
}

/** 各省收录数量（省份选择器使用；云端模式下以本地示例数为参考） */
export function provinceCounts(): Record<string, number> {
  return SCENICS.reduce<Record<string, number>>((acc, s) => {
    acc[s.province] = (acc[s.province] || 0) + 1
    return acc
  }, {})
}

export function hotScenics(limit = 6): Scenic[] {
  return sortLocal(SCENICS, 'heat').slice(0, limit)
}

/**
 * 旅行地图省份面板使用的轻量列表。
 * 最多展示 30 条，云端不可用时回落内置资料；点击省份前不会发起请求。
 */
export async function listProvinceScenics(province: string): Promise<Scenic[]> {
  const local = () => sortLocal(SCENICS.filter((item) => item.province === province), 'heat').slice(0, 30)
  if (!(await ensureCloudReady())) return local()
  try {
    const result = await db()
      .collection(COLLECTIONS.scenics)
      .where({ province })
      .orderBy('heat', 'desc')
      .limit(30)
      .get()
    const list = result.data as unknown as Scenic[]
    return list.length ? list : local()
  } catch (error) {
    return local()
  }
}
