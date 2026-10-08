/**
 * 拾景景区资料维护。所有读写均在云函数中核验调用者 OpenID；前端的隐藏入口不构成权限控制。
 * 云函数环境变量 ADMIN_OPENIDS 为逗号分隔的管理员 OpenID，未配置时默认拒绝全部请求。
 * save 仅 patch 本中心负责的字段，contentRevision 在事务中比较，避免覆盖其他管理员的新修改。
 */
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const COLLECTION = 'shijing_scenics'
const ok = (data) => ({ ok: true, data })
const fail = (code, message, data) => ({ ok: false, code, message, data })
const text = (value, max = 300) => typeof value === 'string' ? value.trim().slice(0, max) : ''
const date = (value) => {
  if (!value) return true
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}
const url = (value) => !value || /^https?:\/\/[^\s]+$/i.test(value)
const enumValue = (value, options) => options.includes(value)
const isMissing = (error) => /DATABASE_DOCUMENT_NOT_EXIST|document does not exist|not exist/i.test(String(error.code || '') + ' ' + String(error.message || ''))

function callerOpenid() {
  const context = cloud.getWXContext()
  return context.FROM_OPENID || context.OPENID || ''
}

function authorized() {
  const list = String(process.env.ADMIN_OPENIDS || '').split(',').map((item) => item.trim()).filter(Boolean)
  if (!list.length) return fail('NO_ADMIN', '尚未配置资料管理员')
  if (!list.includes(callerOpenid())) return fail('FORBIDDEN', '仅资料管理员可访问')
  return null
}

function cleanEntries(raw) {
  if (!Array.isArray(raw) || !raw.length || raw.length > 12) throw new Error('官方渠道需填写 1 至 12 条')
  const ids = new Set()
  return raw.map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error(`第 ${index + 1} 条渠道格式错误`)
    const entry = {
      id: text(item.id, 60),
      purpose: item.purpose,
      type: item.type,
      name: text(item.name, 80),
      shortLink: text(item.shortLink, 500),
      appId: text(item.appId, 40),
      path: text(item.path, 300),
      url: text(item.url, 500),
      phone: text(item.phone, 40),
      verified: item.verified === true,
      sourceName: text(item.sourceName, 100),
      sourceUrl: text(item.sourceUrl, 500),
      checkedAt: text(item.checkedAt, 20),
      validUntil: text(item.validUntil, 20),
      note: text(item.note, 500),
    }
    if (!entry.id || ids.has(entry.id)) throw new Error('渠道 ID 缺失或重复')
    ids.add(entry.id)
    if (!entry.name) throw new Error(`第 ${index + 1} 条渠道缺少名称`)
    if (!enumValue(entry.purpose, ['ticket', 'reservation', 'cableway', 'performance', 'transport', 'guide', 'other'])) throw new Error('渠道用途无效')
    if (!enumValue(entry.type, ['miniprogram', 'web', 'phone', 'free', 'none'])) throw new Error('渠道类型无效')
    if (entry.shortLink && !entry.shortLink.startsWith('#小程序://')) throw new Error('小程序短链格式错误')
    if (entry.appId && !/^wx[0-9a-f]{16}$/i.test(entry.appId)) throw new Error('AppID 格式错误')
    if (!url(entry.url) || !url(entry.sourceUrl)) throw new Error('渠道网址必须是 HTTPS')
    if (!date(entry.checkedAt) || !date(entry.validUntil)) throw new Error('渠道日期格式应为 YYYY-MM-DD')
    if (entry.verified) {
      if (entry.type === 'none') throw new Error('暂未收录渠道不能标记为已核验')
      if (!entry.sourceName || !entry.checkedAt) throw new Error('已核验渠道必须填写来源名称和核验日期')
      if (entry.type === 'miniprogram' && !entry.shortLink && !(entry.appId && entry.path)) throw new Error('已核验小程序渠道必须填写短链或 AppID + 页面路径')
      if (entry.type === 'web' && !entry.url) throw new Error('已核验官网渠道必须填写 HTTPS 地址')
      if (entry.type === 'phone' && !entry.phone) throw new Error('已核验电话渠道必须填写号码')
    }
    return entry
  })
}

function cleanSources(raw) {
  if (!Array.isArray(raw) || raw.length > 30) throw new Error('资料来源最多 30 条')
  const ids = new Set()
  return raw.map((item) => {
    const source = {
      id: text(item.id, 60), name: text(item.name, 100), url: text(item.url, 500),
      checkedAt: text(item.checkedAt, 20), validUntil: text(item.validUntil, 20), note: text(item.note, 500),
    }
    if (!source.id || ids.has(source.id) || !source.name) throw new Error('资料来源 ID 或名称缺失、重复')
    ids.add(source.id)
    if (!url(source.url) || !date(source.checkedAt) || !date(source.validUntil)) throw new Error('资料来源网址或日期格式错误')
    return source
  })
}

function cleanNotices(raw) {
  if (!Array.isArray(raw) || raw.length > 20) throw new Error('公告最多 20 条')
  const ids = new Set()
  return raw.map((item) => {
    const notice = {
      id: text(item.id, 60), type: item.type, title: text(item.title, 100),
      content: text(item.content, 1000), startAt: text(item.startAt, 20), endAt: text(item.endAt, 20),
      sourceName: text(item.sourceName, 100), sourceUrl: text(item.sourceUrl, 500), checkedAt: text(item.checkedAt, 20),
    }
    if (!notice.id || ids.has(notice.id)) throw new Error('公告 ID 缺失或重复')
    ids.add(notice.id)
    if (!enumValue(notice.type, ['closure', 'weather', 'limit', 'maintenance', 'info'])) throw new Error('公告类型无效')
    if (!notice.title || !notice.content || !notice.sourceName || !notice.checkedAt) throw new Error('公告需填写标题、内容、来源及核验日期')
    if (!date(notice.startAt) || !date(notice.endAt) || !date(notice.checkedAt) || !url(notice.sourceUrl)) throw new Error('公告网址或日期格式错误')
    if (notice.startAt && notice.endAt && notice.startAt > notice.endAt) throw new Error('公告结束日期不能早于开始日期')
    return notice
  })
}

function cleanReservation(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('预约规则格式错误')
  const rule = {}
  for (const key of ['required', 'realName', 'timeSlotRequired']) {
    if (typeof raw[key] === 'boolean') rule[key] = raw[key]
    else if (raw[key] !== undefined && raw[key] !== null) throw new Error('预约布尔字段格式错误')
  }
  if (raw.advanceDays !== undefined && raw.advanceDays !== null && raw.advanceDays !== '') {
    if (!Number.isInteger(raw.advanceDays) || raw.advanceDays < 0 || raw.advanceDays > 365) throw new Error('提前天数应为 0 至 365 的整数')
    rule.advanceDays = raw.advanceDays
  }
  const releaseTime = text(raw.releaseTime, 5)
  if (releaseTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(releaseTime)) throw new Error('放票时间格式应为 HH:mm')
  if (releaseTime) rule.releaseTime = releaseTime
  if (!Array.isArray(raw.documents) || raw.documents.length > 10) throw new Error('证件清单格式错误')
  rule.documents = raw.documents.map((value) => text(value, 40)).filter(Boolean)
  for (const key of ['refundRule', 'audienceRule', 'note']) rule[key] = text(raw[key], 500)
  return rule
}

/** location 只接受数值型完整坐标；null 表示新版管理端明确清空。 */
function cleanLocation(raw) {
  if (raw === null) return null
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('景区坐标格式错误')
  const { lat, lng } = raw
  if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90) throw new Error('纬度应为 -90 至 90')
  if (typeof lng !== 'number' || !Number.isFinite(lng) || lng < -180 || lng > 180) throw new Error('经度应为 -180 至 180')
  return { lat, lng }
}

async function list(event) {
  const page = Number(event.page) || 0
  if (!Number.isInteger(page) || page < 0 || page > 100) return fail('BAD_PAGE', '页码无效')
  const result = await db.collection(COLLECTION).field({ _id: true, name: true, province: true, city: true, updatedAt: true, contentRevision: true }).orderBy('name', 'asc').skip(page * 50).limit(50).get()
  return ok({ list: result.data, hasMore: result.data.length === 50 })
}

async function get(event) {
  const id = text(event.id, 100)
  if (!id) return fail('BAD_ID', '缺少景区 ID')
  try {
    const result = await db.collection(COLLECTION).doc(id).get()
    return ok({ scenic: result.data, revision: Number(result.data.contentRevision) || 0 })
  } catch (error) {
    if (isMissing(error)) return fail('NOT_FOUND', '云端暂无这条景区资料，请先初始化')
    throw error
  }
}

async function save(event) {
  const id = text(event.id, 100)
  if (!id || !Number.isInteger(event.baseRevision) || event.baseRevision < 0) return fail('BAD_REQUEST', '景区 ID 或版本无效')
  let entries, sources, notices, reservation, location
  const hasLocationPatch = Object.prototype.hasOwnProperty.call(event, 'location')
  const hasAddressPatch = Object.prototype.hasOwnProperty.call(event, 'address')
  try {
    entries = cleanEntries(event.officialEntries)
    sources = cleanSources(event.sources)
    notices = cleanNotices(event.notices)
    reservation = cleanReservation(event.reservation)
    if (hasLocationPatch) location = cleanLocation(event.location)
  } catch (error) {
    return fail('VALIDATION_ERROR', error.message)
  }
  const booking = text(event.booking, 1000)
  const primary = entries.find((item) => item.verified && (item.shortLink || item.appId || item.url || item.phone)) || entries[0]
  const { id: unusedId, ...ticket } = primary
  const result = await db.runTransaction(async (transaction) => {
    const ref = transaction.collection(COLLECTION).doc(id)
    let current
    try {
      current = (await ref.get()).data
    } catch (error) {
      if (isMissing(error)) return fail('NOT_FOUND', '云端暂无这条景区资料，请先初始化')
      throw error
    }
    const revision = Number(current.contentRevision) || 0
    if (revision !== event.baseRevision) return fail('SYNC_CONFLICT', '资料已被其他管理员更新，请重新打开后合并修改', { revision })
    const updatedAt = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
    const patch = { officialEntries: entries, sources, notices, reservation, booking, ticket, updatedAt, contentRevision: revision + 1 }
    // 旧客户端没有这两个字段时保持云端原值；新版传 null/空字符串时明确清空。
    if (hasLocationPatch) patch.location = location === null ? db.command.remove() : location
    if (hasAddressPatch) {
      const address = text(event.address, 200)
      patch.address = address || db.command.remove()
    }
    await ref.update({ data: patch })
    return ok({ revision: revision + 1, updatedAt })
  })
  return result && result.result && typeof result.result.ok === 'boolean' ? result.result : result
}

/** 仅供本地回归脚本验证边界，不绕过云函数入口权限。 */
exports._test = { cleanLocation }

exports.main = async (event = {}) => {
  const denial = authorized()
  if (denial) return denial
  try {
    switch (event.action) {
      case 'check': return ok({ authorized: true })
      case 'list': return await list(event)
      case 'get': return await get(event)
      case 'save': return await save(event)
      default: return fail('BAD_ACTION', '不支持的操作')
    }
  } catch (error) {
    console.error('[shijingAdmin] 请求失败', error)
    return fail('DB_ERROR', '云端读取或保存失败，请查看云函数日志')
  }
}
