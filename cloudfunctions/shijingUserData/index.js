/**
 * 云函数 shijingUserData：收藏、足迹与行程的云端存取。
 *
 * 同步协议 v2：
 * - 每个用户一条文档（_id = openid），所有身份均由 getWXContext 获取。
 * - get 只把“文档不存在”视为空数据，数据库异常会明确失败，客户端不会据此上传空快照。
 * - save 使用 baseRevision + 事务实现乐观锁；冲突时返回最新服务端快照。
 * - favoriteTombstones / tripTombstones 保存删除凭证，防止旧设备复活已删除条目。
 * - 浏览历史与旅行地图都是 v2 的向后兼容扩展；旧客户端未提交对应字段时保留云端现值。
 * - 响应附带可选 serverTime 供新客户端校时；旧客户端会自然忽略该字段。
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const col = db.collection('shijing_user_data')

const SYNC_SCHEMA = 2
const MAX_ITEMS = 500
const MAX_FOOTPRINTS = 200
const MAX_PROVINCES = 34
const PROVINCE_CODES = new Set([
  'beijing', 'tianjin', 'hebei', 'shanxi', 'neimenggu', 'liaoning', 'jilin', 'heilongjiang',
  'shanghai', 'jiangsu', 'zhejiang', 'anhui', 'fujian', 'jiangxi', 'shandong', 'henan',
  'hubei', 'hunan', 'guangdong', 'guangxi', 'hainan', 'chongqing', 'sichuan', 'guizhou',
  'yunnan', 'xizang', 'shaanxi', 'gansu', 'qinghai', 'ningxia', 'xinjiang', 'taiwan',
  'xianggang', 'aomen',
])
// 与客户端一致：墓碑最多可比条目时间早 15 分钟，仍优先采信删除。
const DELETE_WINS_WINDOW_MS = 15 * 60 * 1000
const ok = (data) => ({ ok: true, data })
const fail = (code, message, debug, data) => ({ ok: false, code, message, debug, data })

/** 环境共享调用时必须使用消费方用户的 FROM_OPENID，避免不同小程序用户串号。 */
const getCallerOpenid = () => {
  const wxContext = cloud.getWXContext()
  return wxContext.FROM_OPENID || wxContext.OPENID || ''
}

const pickTicket = (ticket) => {
  const value = ticket && typeof ticket === 'object' ? ticket : {}
  const types = ['miniprogram', 'web', 'phone', 'free', 'none']
  return {
    type: types.includes(value.type) ? value.type : 'none',
    name: String(value.name || '').slice(0, 60),
    shortLink: String(value.shortLink || '').slice(0, 512),
    appId: String(value.appId || '').slice(0, 64),
    path: String(value.path || '').slice(0, 256),
    url: String(value.url || '').slice(0, 512),
    phone: String(value.phone || '').slice(0, 32),
    verified: value.verified === true,
  }
}

const pickFavorite = (favorite) => ({
  id: String(favorite.id || '').slice(0, 80),
  type: favorite.type === 'guide' ? 'guide' : 'scenic',
  targetId: String(favorite.targetId || '').slice(0, 64),
  title: String(favorite.title || '').slice(0, 60),
  subtitle: String(favorite.subtitle || '').slice(0, 40),
  tone: String(favorite.tone || 'jade').slice(0, 12),
  createdAt: Number(favorite.createdAt) || Date.now(),
})

/** 足迹仅保存列表展示所需的轻量景区快照，不保存完整景区资料。 */
const pickFootprint = (footprint) => {
  const scenicId = String(footprint.scenicId || footprint.id || '').slice(0, 64)
  return {
    id: scenicId,
    scenicId,
    scenicName: String(footprint.scenicName || '').slice(0, 60),
    province: String(footprint.province || '').slice(0, 20),
    city: String(footprint.city || '').slice(0, 30),
    tone: String(footprint.tone || 'jade').slice(0, 12),
    cover: String(footprint.cover || '').slice(0, 1024),
    visitedAt: Number(footprint.visitedAt) || Date.now(),
    // 仅用于页面显示相对时间，不参与冲突排序；旧客户端缺失时保持 undefined。
    ...(Number(footprint.localVisitedAt) > 0 ? { localVisitedAt: Number(footprint.localVisitedAt) } : {}),
  }
}

const pickTrip = (trip) => ({
  id: String(trip.id || '').slice(0, 40),
  scenicId: String(trip.scenicId || '').slice(0, 64),
  scenicName: String(trip.scenicName || '').slice(0, 40),
  province: String(trip.province || '').slice(0, 20),
  city: String(trip.city || '').slice(0, 20),
  tone: String(trip.tone || 'jade').slice(0, 12),
  date: /^\d{4}-\d{2}-\d{2}$/.test(trip.date) ? trip.date : '',
  period: ['all', 'morning', 'afternoon', 'evening'].includes(trip.period) ? trip.period : 'all',
  status: ['pending', 'booked', 'done'].includes(trip.status) ? trip.status : 'pending',
  note: String(trip.note || '').slice(0, 60),
  checklist: (Array.isArray(trip.checklist) ? trip.checklist : [])
    .slice(0, 12)
    .map((item) => String(item || '').trim().slice(0, 20))
    .filter(Boolean),
  ticket: pickTicket(trip.ticket),
  booking: String(trip.booking || '').slice(0, 200),
  createdAt: Number(trip.createdAt) || Date.now(),
  updatedAt: Number(trip.updatedAt) || Date.now(),
})

const pickTombstone = (item) => ({
  id: String(item.id || '').slice(0, 80),
  deletedAt: Number(item.deletedAt) || Date.now(),
})

const pickScenicMark = (item) => ({
  id: String((item && item.id) || '').slice(0, 64),
  updatedAt: Number(item && item.updatedAt) || Date.now(),
})

const pickProvinceMark = (item) => {
  const code = String((item && item.code) || '')
  const state = item && ['visited', 'wish', 'none'].includes(item.state) ? item.state : 'none'
  return { code: PROVINCE_CODES.has(code) ? code : '', state, updatedAt: Number(item && item.updatedAt) || 0 }
}

const cleanProvinceMarks = (items) => {
  const map = new Map()
  items.map(pickProvinceMark).forEach((item) => {
    if (!item.code) return
    const previous = map.get(item.code)
    if (!previous || item.updatedAt > previous.updatedAt || (item.updatedAt === previous.updatedAt && item.state === 'visited')) {
      map.set(item.code, item)
    }
  })
  return Array.from(map.values()).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_PROVINCES)
}

const snapshotProvinceMarks = (snapshot) => {
  if (Array.isArray(snapshot.provinceMarks) && snapshot.provinceMarks.length) return cleanProvinceMarks(snapshot.provinceMarks)
  const visited = new Set((Array.isArray(snapshot.visitedProvinces) ? snapshot.visitedProvinces : []).filter((code) => PROVINCE_CODES.has(code)))
  const wish = (Array.isArray(snapshot.wishProvinces) ? snapshot.wishProvinces : []).filter((code) => PROVINCE_CODES.has(code) && !visited.has(code))
  return cleanProvinceMarks([
    ...Array.from(visited).map((code) => ({ code, state: 'visited', updatedAt: 0 })),
    ...wish.map((code) => ({ code, state: 'wish', updatedAt: 0 })),
  ])
}

const resolveScenicMarkOverlap = (visited, wish) => {
  const visitedMap = new Map(visited.map((item) => [item.id, item]))
  const wishMap = new Map(wish.map((item) => [item.id, item]))
  visitedMap.forEach((item, id) => {
    const other = wishMap.get(id)
    if (!other) return
    if (other.updatedAt > item.updatedAt) visitedMap.delete(id)
    else wishMap.delete(id)
  })
  return { visited: Array.from(visitedMap.values()), wish: Array.from(wishMap.values()) }
}

const uniqueById = (list) => {
  const map = new Map()
  list.forEach((item) => {
    if (!item.id) return
    const previous = map.get(item.id)
    const stamp = Number(item.updatedAt || item.visitedAt || item.deletedAt || item.createdAt) || 0
    const previousStamp = previous ? Number(previous.updatedAt || previous.visitedAt || previous.deletedAt || previous.createdAt) || 0 : -1
    if (!previous || stamp > previousStamp) map.set(item.id, item)
  })
  return Array.from(map.values())
}

const cleanGroup = (items, tombstones) => {
  // 先按时间排序再裁剪，不能依赖客户端数组顺序，否则第 501 条可能是最新数据。
  const tombstoneList = uniqueById(tombstones)
    .sort((a, b) => Number(b.deletedAt) - Number(a.deletedAt))
    .slice(0, MAX_ITEMS)
  const itemMap = new Map(uniqueById(items).map((item) => [item.id, item]))
  const tombstoneMap = new Map(tombstoneList.map((item) => [item.id, item]))
  tombstoneMap.forEach((tombstone, id) => {
    const item = itemMap.get(id)
    if (!item) return
    const itemStamp = Number(item.updatedAt || item.createdAt) || 0
    if (tombstone.deletedAt + DELETE_WINS_WINDOW_MS >= itemStamp) itemMap.delete(id)
    else tombstoneMap.delete(id)
  })
  return {
    items: Array.from(itemMap.values())
      .sort((a, b) => Number(b.updatedAt || b.createdAt) - Number(a.updatedAt || a.createdAt))
      .slice(0, MAX_ITEMS),
    tombstones: Array.from(tombstoneMap.values()).sort((a, b) => b.deletedAt - a.deletedAt),
  }
}

const cleanFootprints = (items, clearedAt) =>
  uniqueById(items.map(pickFootprint))
    .filter((item) => item.id && item.scenicId && item.visitedAt > clearedAt)
    .sort((a, b) => b.visitedAt - a.visitedAt)
    .slice(0, MAX_FOOTPRINTS)

const emptySnapshot = () => ({
  schema: SYNC_SCHEMA,
  revision: 0,
  favorites: [],
  footprints: [],
  footprintClearedAt: 0,
  trips: [],
  favoriteTombstones: [],
    tripTombstones: [],
    visitedProvinces: [],
    wishProvinces: [],
    provinceMarks: [],
    visitedScenics: [],
    wishScenics: [],
    visitedScenicTombstones: [],
    wishScenicTombstones: [],
  updatedAt: 0,
})

const toSnapshot = (doc) => {
  if (!doc) return emptySnapshot()
  return {
    schema: Number(doc.schema) || 1,
    revision: Number(doc.revision) || 0,
    favorites: Array.isArray(doc.favorites) ? doc.favorites : [],
    footprints: Array.isArray(doc.footprints) ? doc.footprints : [],
    footprintClearedAt: Number(doc.footprintClearedAt) || 0,
    trips: Array.isArray(doc.trips) ? doc.trips : [],
    favoriteTombstones: Array.isArray(doc.favoriteTombstones) ? doc.favoriteTombstones : [],
    tripTombstones: Array.isArray(doc.tripTombstones) ? doc.tripTombstones : [],
    visitedProvinces: Array.isArray(doc.visitedProvinces) ? doc.visitedProvinces : [],
    wishProvinces: Array.isArray(doc.wishProvinces) ? doc.wishProvinces : [],
    provinceMarks: Array.isArray(doc.provinceMarks) ? doc.provinceMarks : [],
    visitedScenics: Array.isArray(doc.visitedScenics) ? doc.visitedScenics : [],
    wishScenics: Array.isArray(doc.wishScenics) ? doc.wishScenics : [],
    visitedScenicTombstones: Array.isArray(doc.visitedScenicTombstones) ? doc.visitedScenicTombstones : [],
    wishScenicTombstones: Array.isArray(doc.wishScenicTombstones) ? doc.wishScenicTombstones : [],
    updatedAt: Number(doc.updatedAt) || 0,
  }
}

const isDocumentMissing = (error) => {
  const code = String((error && (error.errCode || error.code)) || '')
  const message = String((error && (error.errMsg || error.message)) || '')
  return code === 'DATABASE_DOCUMENT_NOT_EXIST' || /document.*(not exist|does not exist|not found)/i.test(message)
}

async function getSnapshot(openid) {
  // where 查询在没有文档时返回空数组；真实数据库异常会向外抛出，不能伪装成空数据。
  const result = await col.where({ _id: openid }).limit(1).get()
  return toSnapshot(result.data[0])
}

async function saveV2(openid, event) {
  if (!Number.isInteger(event.baseRevision) || event.baseRevision < 0) {
    return fail('INVALID_REVISION', '同步版本无效，请更新小程序后重试')
  }

  const favorites = (Array.isArray(event.favorites) ? event.favorites : []).map(pickFavorite)
  const hasFootprints = Array.isArray(event.footprints)
  const incomingFootprints = hasFootprints ? event.footprints : []
  const incomingFootprintClearedAt = Number(event.footprintClearedAt) || 0
  const trips = (Array.isArray(event.trips) ? event.trips : []).map(pickTrip)
  const favoriteTombstones = (Array.isArray(event.favoriteTombstones) ? event.favoriteTombstones : [])
    .map(pickTombstone)
  const tripTombstones = (Array.isArray(event.tripTombstones) ? event.tripTombstones : [])
    .map(pickTombstone)
  // 所有新增字段均以“是否传入数组”为参与合并开关，旧客户端缺失字段时绝不清空云端。
  const hasProvinceMarks = Array.isArray(event.provinceMarks) || Array.isArray(event.visitedProvinces) || Array.isArray(event.wishProvinces)
  const incomingProvinceMarks = Array.isArray(event.provinceMarks)
    ? event.provinceMarks
    : [
      ...(Array.isArray(event.visitedProvinces) ? event.visitedProvinces : []).map((code) => ({ code, state: 'visited', updatedAt: 0 })),
      ...(Array.isArray(event.wishProvinces) ? event.wishProvinces : []).map((code) => ({ code, state: 'wish', updatedAt: 0 })),
    ]
  const hasVisitedScenics = Array.isArray(event.visitedScenics)
  const hasWishScenics = Array.isArray(event.wishScenics)
  const visitedScenics = (hasVisitedScenics ? event.visitedScenics : []).map(pickScenicMark)
  const wishScenics = (hasWishScenics ? event.wishScenics : []).map(pickScenicMark)
  const visitedScenicTombstones = (Array.isArray(event.visitedScenicTombstones) ? event.visitedScenicTombstones : []).map(pickTombstone)
  const wishScenicTombstones = (Array.isArray(event.wishScenicTombstones) ? event.wishScenicTombstones : []).map(pickTombstone)

  const outcome = await db.runTransaction(async (transaction) => {
    const docRef = transaction.collection('shijing_user_data').doc(openid)
    let currentDoc = null
    try {
      const result = await docRef.get()
      currentDoc = result.data
    } catch (error) {
      if (!isDocumentMissing(error)) throw error
    }

    const current = toSnapshot(currentDoc)
    if (event.baseRevision !== current.revision) {
      return fail(
        'SYNC_CONFLICT',
        '数据已在其他设备更新，正在合并最新版本',
        `baseRevision=${event.baseRevision}, currentRevision=${current.revision}`,
        { snapshot: { ...current, serverTime: Date.now() } },
      )
    }

    const now = Date.now()
    const revision = current.revision + 1
    // 服务端将当前快照与本次提交再次合并，作为旧客户端和异常数组顺序的兜底。
    // 正常删除必须携带墓碑；因此合并不会把已删除条目复活。
    const favoriteGroup = cleanGroup(
      [...current.favorites, ...favorites],
      [...current.favoriteTombstones, ...favoriteTombstones],
    )
    const tripGroup = cleanGroup(
      [...current.trips, ...trips],
      [...current.tripTombstones, ...tripTombstones],
    )
    // 旧版 v2 客户端没有足迹字段；它保存收藏或行程时必须保留当前云端足迹。
    const footprintClearedAt = hasFootprints
      ? Math.max(current.footprintClearedAt, incomingFootprintClearedAt)
      : current.footprintClearedAt
    const footprints = hasFootprints
      ? cleanFootprints([...current.footprints, ...incomingFootprints], footprintClearedAt)
      : current.footprints
    const provinceMarks = hasProvinceMarks
      ? cleanProvinceMarks([...snapshotProvinceMarks(current), ...incomingProvinceMarks])
      : snapshotProvinceMarks(current)
    const visitedScenicGroup = hasVisitedScenics
      ? cleanGroup(
        [...current.visitedScenics.map(pickScenicMark), ...visitedScenics],
        [...current.visitedScenicTombstones.map(pickTombstone), ...visitedScenicTombstones],
      )
      : { items: current.visitedScenics, tombstones: current.visitedScenicTombstones }
    const wishScenicGroup = hasWishScenics
      ? cleanGroup(
        [...current.wishScenics.map(pickScenicMark), ...wishScenics],
        [...current.wishScenicTombstones.map(pickTombstone), ...wishScenicTombstones],
      )
      : { items: current.wishScenics, tombstones: current.wishScenicTombstones }
    const scenicMarks = resolveScenicMarkOverlap(visitedScenicGroup.items, wishScenicGroup.items)
    const data = {
      _openid: openid,
      schema: SYNC_SCHEMA,
      revision,
      favorites: favoriteGroup.items,
      footprints,
      footprintClearedAt,
      trips: tripGroup.items,
      favoriteTombstones: favoriteGroup.tombstones,
      tripTombstones: tripGroup.tombstones,
      visitedProvinces: provinceMarks.filter((item) => item.state === 'visited').map((item) => item.code),
      wishProvinces: provinceMarks.filter((item) => item.state === 'wish').map((item) => item.code),
      provinceMarks,
      visitedScenics: scenicMarks.visited,
      wishScenics: scenicMarks.wish,
      visitedScenicTombstones: visitedScenicGroup.tombstones,
      wishScenicTombstones: wishScenicGroup.tombstones,
      updatedAt: now,
    }
    await docRef.set({ data })
    return ok({ revision, updatedAt: now, serverTime: Date.now() })
  })
  // 兼容不同 wx-server-sdk 版本：部分版本直接返回回调值，部分版本外层带 result。
  return outcome && outcome.result && typeof outcome.result.ok === 'boolean' ? outcome.result : outcome
}

async function saveLegacy(openid, event) {
  const current = await getSnapshot(openid)
  if (current.schema >= SYNC_SCHEMA || current.revision > 0) {
    return fail('CLIENT_UPGRADE_REQUIRED', '当前版本过旧，请更新小程序后再同步', '云端文档已启用 revision 同步协议')
  }
  const favorites = cleanGroup((Array.isArray(event.favorites) ? event.favorites : []).map(pickFavorite), []).items
  const trips = cleanGroup((Array.isArray(event.trips) ? event.trips : []).map(pickTrip), []).items
  await col.doc(openid).set({ data: { _openid: openid, schema: 1, favorites, trips, updatedAt: Date.now() } })
  return ok({ legacy: true, favorites: favorites.length, trips: trips.length, serverTime: Date.now() })
}

exports.main = async (event) => {
  const OPENID = getCallerOpenid()
  if (!OPENID) return fail('NO_OPENID', '未获取到用户身份')

  try {
    if (event.action === 'get') {
      const snapshot = await getSnapshot(OPENID)
      return ok({ ...snapshot, serverTime: Date.now() })
    }
    if (event.action === 'save') {
      return Number(event.schema) === SYNC_SCHEMA ? await saveV2(OPENID, event) : await saveLegacy(OPENID, event)
    }
    return fail('BAD_ACTION', '不支持的操作', `action=${event.action}`)
  } catch (error) {
    return fail('DB_ERROR', '同步失败，请稍后再试', `请确认已创建 shijing_user_data 集合：${error.message}`)
  }
}
