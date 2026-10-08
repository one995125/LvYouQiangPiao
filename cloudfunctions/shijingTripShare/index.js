/**
 * 云函数 shijingTripShare：生成、读取和撤销行程只读快照。
 *
 * 安全边界：
 * - create / revoke 的身份只取微信上下文，绝不信任客户端传入的 openid。
 * - get 只返回白名单字段，不返回分享者 openid、同步版本、购票渠道等私密或无关信息。
 * - shareId 使用 192 位加密随机数，不提供列表与枚举接口；失效、撤销和不存在统一返回同一错误。
 * - 查看统计只累计次数与最近查看时间，不记录查看者身份。
 */
const crypto = require('crypto')
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command
const shares = db.collection('shijing_trip_shares')
const userData = db.collection('shijing_user_data')

const SHARE_TTL_MS = 30 * 24 * 60 * 60 * 1000
const SHARE_ID_PATTERN = /^[a-f0-9]{48}$/
const PERIODS = ['all', 'morning', 'afternoon', 'evening']
const STATUSES = ['pending', 'booked', 'done']
const ok = (data) => ({ ok: true, data })
const fail = (code, message, debug) => ({ ok: false, code, message, debug })

/** 环境共享调用优先使用消费方身份，兼容资源方小程序直连。 */
const getCallerOpenid = () => {
  const context = cloud.getWXContext()
  return context.FROM_OPENID || context.OPENID || ''
}

const isDocumentMissing = (error) => {
  const code = String((error && (error.errCode || error.code)) || '')
  const message = String((error && (error.errMsg || error.message)) || '')
  return code === 'DATABASE_DOCUMENT_NOT_EXIST' || /document.*(not exist|does not exist|not found)/i.test(message)
}

/** 192 位随机标识不含时间、openid 或自增序号，无法从相邻分享推测。 */
const createShareId = () => crypto.randomBytes(24).toString('hex')

const cleanText = (value, max) => String(value || '').trim().slice(0, max)

/**
 * 严格缩减行程字段。备注与清单分别受显式布尔开关控制，缺省值始终为 false。
 * 这里不带 scenicId、城市、ticket、booking、createdAt 或 updatedAt。
 */
function toShareTrip(raw, options) {
  const trip = raw && typeof raw === 'object' ? raw : {}
  const item = {
    scenicName: cleanText(trip.scenicName, 40),
    date: /^\d{4}-\d{2}-\d{2}$/.test(trip.date) ? trip.date : '',
    period: PERIODS.includes(trip.period) ? trip.period : 'all',
    status: STATUSES.includes(trip.status) ? trip.status : 'pending',
  }
  if (options.includeNotes) {
    const note = cleanText(trip.note, 60)
    if (note) item.note = note
  }
  if (options.includeChecklist) {
    const checklist = (Array.isArray(trip.checklist) ? trip.checklist : [])
      .slice(0, 12)
      .map((entry) => cleanText(entry, 20))
      .filter(Boolean)
    if (checklist.length) item.checklist = checklist
  }
  return item
}

const sortTrips = (trips) => trips.slice().sort((a, b) => {
  const dateA = a.date || '9999-99-99'
  const dateB = b.date || '9999-99-99'
  return dateA.localeCompare(dateB) || PERIODS.indexOf(a.period) - PERIODS.indexOf(b.period) || a.scenicName.localeCompare(b.scenicName)
})

/** 公共响应只从白名单重建对象，保证存储层新增字段也不会意外泄露。 */
function toPublicSnapshot(doc, viewCount) {
  return {
    shareId: String(doc._id || ''),
    trips: sortTrips(Array.isArray(doc.trips) ? doc.trips : []),
    createdAt: Number(doc.createdAt) || 0,
    expiresAt: Number(doc.expiresAt) || 0,
    viewCount: Number.isFinite(viewCount) ? viewCount : Number(doc.viewCount) || 0,
  }
}

async function readUserTrips(openid) {
  // where 查询将“文档不存在”自然表示为空数组，真实数据库错误仍向外抛出。
  const result = await userData.where({ _id: openid }).limit(1).get()
  const doc = result.data[0]
  return doc && Array.isArray(doc.trips) ? doc.trips : []
}

async function create(openid, event) {
  const options = {
    // 必须严格等于 true；旧客户端或缺失字段不会包含私密内容。
    includeNotes: event.includeNotes === true,
    includeChecklist: event.includeChecklist === true,
  }
  const trips = sortTrips((await readUserTrips(openid))
    .map((trip) => toShareTrip(trip, options))
    .filter((trip) => trip.scenicName))
  if (!trips.length) return fail('NO_TRIPS', '云端还没有可分享的行程，请稍后重试同步')

  await db.createCollection('shijing_trip_shares').catch(() => null)
  const now = Date.now()
  // 随机空间足够大；仍检查最多三次，防止理论上的文档 ID 碰撞。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const shareId = createShareId()
    try {
      await shares.doc(shareId).get()
    } catch (error) {
      if (!isDocumentMissing(error)) throw error
      const doc = {
        _openid: openid,
        status: 'active',
        trips,
        createdAt: now,
        expiresAt: now + SHARE_TTL_MS,
        viewCount: 0,
        lastViewedAt: 0,
      }
      await shares.doc(shareId).set({ data: doc })
      return ok(toPublicSnapshot({ _id: shareId, ...doc }, 0))
    }
  }
  return fail('ID_GENERATION_FAILED', '生成分享链接失败，请重试')
}

async function get(rawShareId) {
  const shareId = String(rawShareId || '').trim()
  if (!SHARE_ID_PATTERN.test(shareId)) return fail('SHARE_UNAVAILABLE', '这份行程已失效或已撤销')

  let doc
  try {
    doc = (await shares.doc(shareId).get()).data
  } catch (error) {
    if (isDocumentMissing(error)) return fail('SHARE_UNAVAILABLE', '这份行程已失效或已撤销')
    throw error
  }
  const now = Date.now()
  if (!doc || doc.status !== 'active' || !Number(doc.expiresAt) || Number(doc.expiresAt) <= now) {
    return fail('SHARE_UNAVAILABLE', '这份行程已失效或已撤销')
  }

  const nextViewCount = (Number(doc.viewCount) || 0) + 1
  // 统计异常不能阻断同行人查看；只记录次数和时间，不保存查看者身份。
  try {
    await shares.doc(shareId).update({ data: { viewCount: _.inc(1), lastViewedAt: now } })
  } catch (error) {
    console.warn('[shijingTripShare] 查看次数更新失败', error)
  }
  return ok(toPublicSnapshot(doc, nextViewCount))
}

async function revoke(openid, rawShareId) {
  const shareId = String(rawShareId || '').trim()
  if (!SHARE_ID_PATTERN.test(shareId)) return fail('BAD_SHARE_ID', '分享标识无效')

  let doc
  try {
    doc = (await shares.doc(shareId).get()).data
  } catch (error) {
    if (isDocumentMissing(error)) return fail('SHARE_NOT_FOUND', '分享不存在')
    throw error
  }
  if (!doc || doc._openid !== openid) return fail('FORBIDDEN', '只能撤销自己生成的分享')
  if (doc.status === 'revoked') return ok({ revoked: true })
  await shares.doc(shareId).update({ data: { status: 'revoked', revokedAt: Date.now() } })
  return ok({ revoked: true })
}

exports.main = async (event = {}) => {
  try {
    // get 是公开只读能力，不要求客户端先建立本地 profile，也不使用查看者身份。
    if (event.action === 'get') return await get(event.shareId)

    const openid = getCallerOpenid()
    if (!openid) return fail('NO_OPENID', '未获取到用户身份')
    if (event.action === 'create') return await create(openid, event)
    if (event.action === 'revoke') return await revoke(openid, event.shareId)
    return fail('BAD_ACTION', '不支持的操作', `action=${event.action}`)
  } catch (error) {
    console.error('[shijingTripShare] 请求失败', error)
    return fail('SERVER_ERROR', '行程分享服务开小差了，请稍后再试', `请确认已创建 shijing_trip_shares 集合：${error.message}`)
  }
}

exports._test = {
  SHARE_ID_PATTERN,
  createShareId,
  toShareTrip,
  toPublicSnapshot,
}
