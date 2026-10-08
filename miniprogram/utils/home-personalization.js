/**
 * 首页个性化纯函数。
 * 只接收本地快照和首页已经加载的景区，不读取 storage、不调用 service 或云函数，
 * 便于回归测试确认“继续看/推荐”不会产生额外网络请求。
 */

const HOME_RECENT_LIMIT = 4
const HOME_RECOMMENDATION_LIMIT = 2

/**
 * 足迹按最近浏览时间倒序，同一景区只保留最新一条。
 * @param {Array<object>} footprints 本地足迹快照
 * @param {number} limit 最大展示数量
 * @returns {Array<object>}
 */
function selectRecentFootprints(footprints, limit = HOME_RECENT_LIMIT) {
  const safeLimit = Math.max(0, Math.floor(Number(limit) || 0))
  const seen = new Set()
  const result = []
  const sorted = (Array.isArray(footprints) ? footprints : [])
    .slice()
    .sort((a, b) => (Number(b && b.visitedAt) || 0) - (Number(a && a.visitedAt) || 0))
  for (const item of sorted) {
    const scenicId = String(item && (item.scenicId || item.id) || '')
    if (!scenicId || seen.has(scenicId)) continue
    seen.add(scenicId)
    result.push(item)
    if (result.length >= safeLimit) break
  }
  return result
}

/** Map 计数器：只处理明确的非空字符串，不从展示文案猜测省份或分类。 */
function countValue(counter, value, weight = 1) {
  if (typeof value !== 'string' || !value) return
  counter.set(value, (counter.get(value) || 0) + weight)
}

/**
 * 从首页已经加载的景区中生成轻量推荐。
 * - 足迹快照直接贡献省份偏好；
 * - 收藏/足迹只有在当前已加载景区中能找到对应项时，才贡献分类偏好；
 * - 已收藏或已浏览景区不重复推荐；没有可靠偏好时返回空数组。
 * @param {Array<object>} loadedScenics 首页现有 feature + rest
 * @param {Array<object>} favorites 本地收藏快照
 * @param {Array<object>} footprints 本地足迹快照
 * @param {number} limit 最大展示数量
 * @returns {Array<object>}
 */
function recommendLoadedScenics(loadedScenics, favorites, footprints, limit = HOME_RECOMMENDATION_LIMIT) {
  const safeLimit = Math.max(0, Math.floor(Number(limit) || 0))
  if (!safeLimit) return []

  const uniqueLoaded = []
  const loadedById = new Map()
  for (const scenic of Array.isArray(loadedScenics) ? loadedScenics : []) {
    const id = String(scenic && scenic._id || '')
    if (!id || loadedById.has(id)) continue
    loadedById.set(id, scenic)
    uniqueLoaded.push(scenic)
  }

  const scenicFavorites = (Array.isArray(favorites) ? favorites : [])
    .filter((item) => item && item.type === 'scenic' && item.targetId)
  const safeFootprints = Array.isArray(footprints) ? footprints : []
  if (!scenicFavorites.length && !safeFootprints.length) return []

  const engagedIds = new Set()
  const provincePreference = new Map()
  const categoryPreference = new Map()

  for (const footprint of safeFootprints) {
    const id = String(footprint && (footprint.scenicId || footprint.id) || '')
    if (id) engagedIds.add(id)
    countValue(provincePreference, footprint && footprint.province)
    const known = loadedById.get(id)
    if (known) countValue(categoryPreference, known.category)
  }
  for (const favorite of scenicFavorites) {
    const id = String(favorite.targetId)
    engagedIds.add(id)
    const known = loadedById.get(id)
    if (!known) continue
    countValue(provincePreference, known.province)
    countValue(categoryPreference, known.category)
  }

  return uniqueLoaded
    .filter((scenic) => !engagedIds.has(scenic._id))
    .map((scenic) => ({
      scenic,
      score: (provincePreference.get(scenic.province) || 0) * 20
        + (categoryPreference.get(scenic.category) || 0) * 40,
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || (Number(b.scenic.heat) || 0) - (Number(a.scenic.heat) || 0))
    .slice(0, safeLimit)
    .map((item) => item.scenic)
}

module.exports = {
  HOME_RECENT_LIMIT,
  HOME_RECOMMENDATION_LIMIT,
  selectRecentFootprints,
  recommendLoadedScenics,
}
