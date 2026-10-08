/**
 * 云函数 shijingGuide：公开读取仅限编辑整理的攻略。
 * - 用户投稿、点赞已关闭；管理员可通过独立接口维护草稿、发布与下架。
 * - mine/remove 仅用于原作者管理历史投稿，历史文档不会被批量删除。
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command
const guides = db.collection('shijing_guides')
const CATEGORIES = ['guide', 'avoid', 'ticket', 'food', 'route']
const TONES = ['jade', 'ochre', 'mist', 'lake', 'dusk', 'ink', 'rose', 'sand']
const BLOCK_TYPES = ['h', 'p', 'tip', 'warn']
const MAX_GUIDE_TAGS = 10
const MAX_GUIDE_TAG_LENGTH = 16
const GUIDE_SYNONYMS = {
  '抢票': ['放票', '预约'],
  '购票': ['门票', '票务'],
  '避坑': ['避雷', '套路'],
  '路线': ['行程', '线路'],
  '美食': ['吃什么', '小吃'],
}

const ok = (data) => ({ ok: true, data })
const fail = (code, message, debug) => ({ ok: false, code, message, debug })

/** 环境共享调用时使用消费方用户的 FROM_OPENID，直连资源方时兼容 OPENID。 */
const getCallerOpenid = () => {
  const wxContext = cloud.getWXContext()
  return wxContext.FROM_OPENID || wxContext.OPENID || ''
}

/** 将页码限制为安全整数，避免客户端传入负数、浮点数或超大值拖慢查询。 */
function toSafePage(value) {
  const page = Number(value)
  if (!Number.isFinite(page)) return 0
  return Math.min(Math.max(Math.floor(page), 0), 1000)
}

/**
 * 公共响应不返回 _openid，避免把作者的微信身份标识暴露给其他用户。
 * 其余字段仍保持 Guide 数据结构，页面无需额外适配。
 */
function toClientGuide(doc) {
  if (!doc || typeof doc !== 'object') return doc
  const { _openid, ...guide } = doc
  // 历史异常标签不应直接透传给游客端；未含 tags 的旧文档保持原数据形态。
  if (doc.tags !== undefined) guide.tags = cleanTags(doc.tags) || []
  return guide
}

/** 白名单只来自云函数环境变量，未配置时默认拒绝；绝不信任前端传来的身份字段。 */
function adminDenial(openid) {
  const admins = String(process.env.ADMIN_OPENIDS || '').split(',').map((item) => item.trim()).filter(Boolean)
  if (!admins.length) return fail('NO_ADMIN', '尚未配置攻略管理员')
  return admins.includes(openid) ? null : fail('FORBIDDEN', '仅攻略管理员可操作')
}

const safeText = (value, max) => typeof value === 'string' && value.trim().length <= max ? value.trim() : null

/**
 * 标签是可选新增字段：旧客户端不传时返回 undefined，使更新操作保留云端已有标签。
 * 数组中的非字符串、空值和重复项会被过滤；数量或单项长度越界则拒绝保存。
 */
function cleanTags(raw) {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) return null
  const tags = []
  const seen = new Set()
  for (const value of raw) {
    if (typeof value !== 'string') continue
    const tag = value.trim()
    if (!tag) continue
    if (tag.length > MAX_GUIDE_TAG_LENGTH) return null
    const key = tag.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      tags.push(tag)
    }
  }
  if (tags.length > MAX_GUIDE_TAGS) return null
  return tags
}

/** 管理员编辑内容也须在服务端检查，超长或错误格式直接拒绝，避免静默截断正文。 */
function cleanDraft(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const title = safeText(raw.title, 80)
  const summary = safeText(raw.summary, 240)
  const province = safeText(raw.province || '', 20)
  const scenicId = safeText(raw.scenicId || '', 64)
  const scenicName = safeText(raw.scenicName || '', 80)
  const tags = cleanTags(raw.tags)
  if (!title || title.length < 4 || !summary || summary.length < 10 || province === null || scenicId === null || scenicName === null) return null
  if (tags === null) return null
  if (province && !/^[a-z]{2,20}$/.test(province)) return null
  if (scenicId && !/^[a-zA-Z0-9_-]+$/.test(scenicId)) return null
  if (scenicName && !scenicId) return null
  if (!CATEGORIES.includes(raw.category) || !TONES.includes(raw.tone)) return null
  if (!Array.isArray(raw.blocks) || raw.blocks.length < 1 || raw.blocks.length > 30) return null
  let total = 0
  const blocks = []
  for (const block of raw.blocks) {
    if (!block || !BLOCK_TYPES.includes(block.type)) return null
    const text = safeText(block.text, 1000)
    if (!text) return null
    total += text.length
    blocks.push({ type: block.type, text })
  }
  if (total > 12000) return null
  const draft = { title, summary, province, scenicId, scenicName, category: raw.category, tone: raw.tone, blocks }
  // 不把 undefined 写入数据库；旧客户端编辑已有攻略时不会误清管理员后来补充的标签。
  if (tags !== undefined) draft.tags = tags
  return draft
}

/** 管理员列表分状态分页，复用 status + official + createdAt 索引。 */
async function adminList(event) {
  const status = event.status === 'approved' ? 'approved' : 'pending'
  const page = toSafePage(event.page)
  const res = await guides.where({ official: true, status })
    .orderBy('createdAt', 'desc').skip(page * 20).limit(20).get()
  return ok({ list: res.data.map(toClientGuide), hasMore: res.data.length === 20 })
}

async function adminGet(id) {
  if (typeof id !== 'string' || !id || id.length > 128) return fail('BAD_ID', '攻略 ID 无效')
  try {
    const doc = (await guides.doc(id).get()).data
    if (doc.official !== true) return fail('NOT_FOUND', '找不到编辑整理的攻略')
    return ok({ guide: toClientGuide(doc), revision: Number(doc.contentRevision) || 0 })
  } catch (_) {
    return fail('NOT_FOUND', '找不到编辑整理的攻略')
  }
}

/** 新稿只写成草稿；已有稿件的正文修改以版本比较保护，不改变当前发布状态。 */
async function adminSave(event) {
  const draft = cleanDraft(event.draft)
  if (!draft) return fail('VALIDATION_ERROR', '请检查标题、摘要、分类、标签及正文；标签最多 10 个且每个不超过 16 字，正文需有 1 至 30 个非空段落')
  const id = event.id
  if (!id) {
    const createdAt = Date.now()
    const result = await guides.add({ data: {
      ...draft, official: true, status: 'pending', _openid: 'system',
      createdAt, updatedAt: createdAt, contentRevision: 1,
    } })
    return ok({ id: result._id, revision: 1, status: 'pending' })
  }
  if (typeof id !== 'string' || id.length > 128 || !Number.isInteger(event.baseRevision) || event.baseRevision < 0) {
    return fail('BAD_REQUEST', '攻略 ID 或版本无效')
  }
  const outcome = await db.runTransaction(async (transaction) => {
    const ref = transaction.collection('shijing_guides').doc(id)
    let current
    try { current = (await ref.get()).data } catch (_) { return fail('NOT_FOUND', '攻略不存在') }
    if (current.official !== true) return fail('FORBIDDEN', '不能修改历史用户投稿')
    const revision = Number(current.contentRevision) || 0
    if (revision !== event.baseRevision) return fail('SYNC_CONFLICT', '攻略已被其他管理员更新，请重新加载并合并', { revision })
    await ref.update({ data: { ...draft, updatedAt: Date.now(), contentRevision: revision + 1 } })
    return ok({ id, revision: revision + 1, status: current.status })
  })
  return outcome && outcome.result && typeof outcome.result.ok === 'boolean' ? outcome.result : outcome
}

/** 发布和下架只改变状态，不删除文档；旧分享链接在下架后由 get 拒绝。 */
async function adminSetStatus(event) {
  const { id, baseRevision, status } = event
  if (typeof id !== 'string' || !id || id.length > 128 || !Number.isInteger(baseRevision) || baseRevision < 0 || !['pending', 'approved'].includes(status)) {
    return fail('BAD_REQUEST', '攻略 ID、版本或状态无效')
  }
  const outcome = await db.runTransaction(async (transaction) => {
    const ref = transaction.collection('shijing_guides').doc(id)
    let current
    try { current = (await ref.get()).data } catch (_) { return fail('NOT_FOUND', '攻略不存在') }
    if (current.official !== true) return fail('FORBIDDEN', '不能发布历史用户投稿')
    const revision = Number(current.contentRevision) || 0
    if (revision !== baseRevision) return fail('SYNC_CONFLICT', '攻略已被其他管理员更新，请重新加载并合并', { revision })
    if (status === 'approved' && !cleanDraft(current)) return fail('VALIDATION_ERROR', '内容不完整，暂不能发布')
    if (current.status === status) return ok({ id, revision, status })
    await ref.update({ data: { status, updatedAt: Date.now(), contentRevision: revision + 1 } })
    return ok({ id, revision: revision + 1, status })
  })
  return outcome && outcome.result && typeof outcome.result.ok === 'boolean' ? outcome.result : outcome
}

/**
 * 只返回已审核通过且标记为编辑整理的攻略；历史用户投稿不会出现在公开列表。
 * category / province / scenicId 均经过白名单或长度限制，分页大小由服务端固定。
 */
const normalizeSearchText = (value) => String(value || '').toLowerCase().replace(/[\s\-_，、。；：,.!?！？]/g, '')

function keywordScore(doc, keyword) {
  const terms = [keyword, ...(GUIDE_SYNONYMS[keyword] || [])].map(normalizeSearchText).filter(Boolean)
  const title = normalizeSearchText(doc.title)
  const scenicName = normalizeSearchText(doc.scenicName)
  const summary = normalizeSearchText(doc.summary)
  const blocks = normalizeSearchText(Array.isArray(doc.blocks) ? doc.blocks.map((block) => block && block.text).join(' ') : '')
  const tags = (cleanTags(doc.tags) || []).map(normalizeSearchText)
  let score = 0
  for (const term of terms) {
    if (title === term) score = Math.max(score, 120)
    else if (title.startsWith(term)) score = Math.max(score, 105)
    else if (title.includes(term)) score = Math.max(score, 90)
    if (scenicName === term) score = Math.max(score, 85)
    else if (scenicName.includes(term)) score = Math.max(score, 75)
    if (tags.includes(term)) score = Math.max(score, 80)
    if (summary.includes(term)) score = Math.max(score, 60)
    if (blocks.includes(term)) score = Math.max(score, 45)
  }
  return score
}

/** 有关键词或标签时需要先在服务端完成组合过滤，再对结果分页。 */
async function readAllOfficial(where) {
  const rows = []
  const batchSize = 100
  for (let offset = 0; ; offset += batchSize) {
    const res = await guides.where(where).orderBy('createdAt', 'desc').skip(offset).limit(batchSize).get()
    rows.push(...res.data)
    if (res.data.length < batchSize) break
  }
  return rows
}

async function list(input) {
  const query = input && typeof input === 'object' ? input : {}
  const page = toSafePage(query.page)
  const limit = 20
  const where = { status: 'approved', official: true }

  if (query.category && query.category !== 'all' && CATEGORIES.includes(query.category)) {
    where.category = query.category
  }
  const province = String(query.province || '').trim().slice(0, 20)
  const scenicId = String(query.scenicId || '').trim().slice(0, 64)
  const keyword = String(query.keyword || '').trim().slice(0, 40)
  const tag = String(query.tag || '').trim().slice(0, MAX_GUIDE_TAG_LENGTH)
  if (province) where.province = _.in([province, ''])
  if (scenicId) where.scenicId = scenicId

  // 旧客户端不传 keyword/tag 时严格沿用原来的数据库排序与分页查询。
  if (!keyword && !tag) {
    const res = await guides
      .where(where)
      .orderBy('createdAt', 'desc')
      .skip(page * limit)
      .limit(limit)
      .get()
    return ok({ list: res.data.map(toClientGuide), hasMore: res.data.length === limit })
  }

  const normalizedTag = normalizeSearchText(tag)
  let matches = await readAllOfficial(where)
  if (normalizedTag) {
    matches = matches.filter((doc) => (cleanTags(doc.tags) || []).some((item) => normalizeSearchText(item) === normalizedTag))
  }
  if (keyword) {
    matches = matches.map((doc) => ({ doc, score: keywordScore(doc, keyword) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || Number(b.doc.createdAt || 0) - Number(a.doc.createdAt || 0))
      .map((item) => item.doc)
  }
  const start = page * limit
  return ok({ list: matches.slice(start, start + limit).map(toClientGuide), hasMore: start + limit < matches.length })
}

/** 仅聚合官方已发布攻略的合法标签；不读取或暴露作者身份。 */
async function listTags() {
  const docs = await readAllOfficial({ status: 'approved', official: true })
  const counts = new Map()
  for (const doc of docs) {
    for (const tag of cleanTags(doc.tags) || []) counts.set(tag, (counts.get(tag) || 0) + 1)
  }
  const tags = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'))
    .slice(0, 40)
    .map(([tag]) => tag)
  return ok({ tags })
}

/**
 * 详情只允许读取编辑整理的内容；历史投稿 ID 即使来自旧分享链接也不可访问。
 * 不再维护互动浏览计数，避免将静态资料包装成社交内容。
 */
async function get(rawId) {
  const id = String(rawId || '').trim().slice(0, 128)
  if (!id) return fail('INVALID', '缺少攻略 ID')

  let doc
  try {
    const res = await guides.doc(id).get()
    doc = res.data
  } catch (e) {
    return fail('NOT_FOUND', '攻略不存在或已下架')
  }
  if (doc.status !== 'approved' || doc.official !== true) {
    return fail('NOT_FOUND', '攻略不存在或已下架')
  }
  return ok(toClientGuide(doc))
}

exports.main = async (event = {}) => {
  const OPENID = getCallerOpenid()
  if (!OPENID) return fail('NO_OPENID', '未获取到用户身份')

  try {
    if (['adminList', 'adminGet', 'adminSave', 'adminSetStatus'].includes(event.action)) {
      const denial = adminDenial(OPENID)
      if (denial) return denial
      if (event.action === 'adminList') return await adminList(event)
      if (event.action === 'adminGet') return await adminGet(event.id)
      if (event.action === 'adminSave') return await adminSave(event)
      return await adminSetStatus(event)
    }
    switch (event.action) {
      case 'list':
        return await list(event.query)
      case 'tags':
        return await listTags()
      case 'get':
        return await get(event.id)
      case 'publish':
      case 'like':
        return fail('FEATURE_CLOSED', '用户投稿与点赞功能已关闭')
      case 'mine': {
        const res = await guides.where({ _openid: OPENID }).orderBy('createdAt', 'desc').limit(100).get()
        return ok(res.data.map(toClientGuide))
      }
      case 'remove': {
        const res = await guides.where({ _id: String(event.id), _openid: OPENID }).remove()
        if (!res.stats.removed) return fail('FORBIDDEN', '只能删除自己发布的内容')
        return ok(true)
      }
      default:
        return fail('BAD_ACTION', '不支持的操作', `action=${event.action}`)
    }
  } catch (e) {
    console.error('[shijingGuide] 请求失败', e)
    return fail(
      'SERVER_ERROR',
      '云端读取或保存失败，请查看云函数日志',
    )
  }
}
