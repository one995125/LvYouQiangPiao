/**
 * 攻略服务
 * - 公开读取：仅接受拾景整理且已发布的内容；云端明确返回空列表或下架时不得回退到内置资料。
 * - 仅在主动关闭云开发的本地演示模式使用内置资料；线上读取失败时向页面报告错误。
 */
import { CLOUD_FUNCTIONS, PAGE_SIZE, USE_CLOUD } from '../constants/config'
import { GUIDES } from '../data/guides'
import { Guide, GuideCategory } from '../types/index'
import { callFunction, ensureCloudReady } from './cloud'

export interface GuideQuery {
  category: GuideCategory | 'all'
  province?: string
  scenicId?: string
  /** 标题、摘要、正文要点和关联景区名的关键词。 */
  keyword?: string
  /** 管理员维护的标签，按完整标签匹配。 */
  tag?: string
  page?: number
}

export interface GuideListResult {
  list: Guide[]
  hasMore: boolean
  /** 仅表示云端不可用；云端正常返回空列表时为 false。 */
  unavailable?: boolean
}

const normalize = (value: string): string => String(value || '').toLowerCase().replace(/[\s\-_，、。；：,.!?！？]/g, '')

/** 与云函数保持同一套轻量同义词和权重，本地演示模式的排序不会与线上明显漂移。 */
const GUIDE_SYNONYMS: Record<string, string[]> = {
  '抢票': ['放票', '预约'],
  '购票': ['门票', '票务'],
  '避坑': ['避雷', '套路'],
  '路线': ['行程', '线路'],
  '美食': ['吃什么', '小吃'],
}

function guideKeywordScore(guide: Guide, keyword: string): number {
  const raw = keyword.trim()
  if (!raw) return 0
  const terms = [raw, ...(GUIDE_SYNONYMS[raw] || [])].map(normalize).filter(Boolean)
  const title = normalize(guide.title)
  const scenicName = normalize(guide.scenicName || '')
  const tags = (guide.tags || []).map(normalize)
  const summary = normalize(guide.summary)
  const blocks = normalize((guide.blocks || []).map((block) => block.text).join(' '))
  let score = 0
  terms.forEach((term) => {
    if (title === term) score = Math.max(score, 120)
    else if (title.startsWith(term)) score = Math.max(score, 105)
    else if (title.includes(term)) score = Math.max(score, 90)
    if (scenicName === term) score = Math.max(score, 85)
    else if (scenicName.includes(term)) score = Math.max(score, 75)
    if (tags.includes(term)) score = Math.max(score, 80)
    if (summary.includes(term)) score = Math.max(score, 60)
    if (blocks.includes(term)) score = Math.max(score, 45)
  })
  return score
}

function filterLocal(q: GuideQuery): GuideListResult {
  const page = q.page || 0
  let list = GUIDES.filter((guide) => guide.official === true && guide.status === 'approved')
  if (q.category !== 'all') list = list.filter((g) => g.category === q.category)
  if (q.province) list = list.filter((g) => !g.province || g.province === q.province)
  if (q.scenicId) list = list.filter((g) => g.scenicId === q.scenicId)
  const tag = normalize(q.tag || '')
  if (tag) list = list.filter((guide) => (guide.tags || []).some((item) => normalize(item) === tag))
  const keyword = (q.keyword || '').trim()
  if (keyword) {
    list = list.map((guide) => ({ guide, score: guideKeywordScore(guide, keyword) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || b.guide.createdAt - a.guide.createdAt)
      .map((item) => item.guide)
  } else {
    list.sort((a, b) => b.createdAt - a.createdAt)
  }
  return { list: list.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE), hasMore: (page + 1) * PAGE_SIZE < list.length }
}

export async function listGuides(q: GuideQuery): Promise<GuideListResult> {
  if (!USE_CLOUD) return filterLocal(q)
  if (!(await ensureCloudReady())) return { list: [], hasMore: false, unavailable: true }
  try {
    const result = await callFunction<{ list: Guide[]; hasMore: boolean }>(CLOUD_FUNCTIONS.guide, {
      action: 'list',
      query: {
        category: q.category,
        province: q.province || '',
        scenicId: q.scenicId || '',
        keyword: (q.keyword || '').trim(),
        tag: (q.tag || '').trim(),
        page: q.page || 0,
      },
    })
    // 过渡期可能仍连接旧版云函数：任何历史用户投稿都不得重新进入公开列表。
    const list = (result.list || []).filter((guide) => guide.official === true && guide.status === 'approved')
    // 空列表可能是编辑内容尚未上线或已下架，不能将旧的内置版本重新公开。
    return { list, hasMore: result.hasMore }
  } catch (e) {
    console.warn('[guide] 云端查询失败，停止展示内置资料', e)
    return { list: [], hasMore: false, unavailable: true }
  }
}

/** 标签只从官方已发布攻略聚合；读取失败时隐藏筛选条，不影响攻略列表可用性。 */
export async function listGuideTags(): Promise<string[]> {
  const localTags = () => Array.from(new Set(
    GUIDES.filter((guide) => guide.official === true && guide.status === 'approved')
      .flatMap((guide) => guide.tags || []),
  )).filter(Boolean).sort((a, b) => a.localeCompare(b, 'zh-CN'))
  if (!USE_CLOUD) return localTags()
  if (!(await ensureCloudReady())) return []
  try {
    const result = await callFunction<{ tags: string[] }>(CLOUD_FUNCTIONS.guide, { action: 'tags' })
    return Array.isArray(result.tags) ? result.tags.filter((tag) => typeof tag === 'string' && tag.trim()).slice(0, 40) : []
  } catch (error) {
    console.warn('[guide] 攻略标签读取失败，隐藏标签筛选', error)
    return []
  }
}

export async function getGuide(id: string): Promise<Guide | null> {
  const local = GUIDES.find((g) => g._id === id && g.official === true && g.status === 'approved') || null
  if (!USE_CLOUD) return local
  if (!(await ensureCloudReady())) return null
  try {
    const guide = await callFunction<Guide>(CLOUD_FUNCTIONS.guide, { action: 'get', id })
    // 深链及旧收藏也必须经过相同的公开内容边界，不能只过滤列表。
    return guide.official === true && guide.status === 'approved' ? guide : null
  } catch (e) {
    // 包括 NOT_FOUND 在内的错误都不能回退：否则已下架的内置同 ID 内容会再次可见。
    console.warn('[guide] 云端详情读取失败，停止展示内置资料', e)
    return null
  }
}
