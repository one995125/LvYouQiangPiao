/**
 * 云函数 shijingCorrection：接收景区资料纠错。
 * - 客户端不直接写集合，所有文档强制绑定当前 OpenID。
 * - 每人每日最多 5 条，防止滥用。
 * - 说明文本经 msgSecCheck；risky 直接拒绝，review 仍保持待人工复核。
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const corrections = db.collection('shijing_corrections')

const TYPES = ['channel', 'price', 'opening', 'reservation', 'closed', 'other']
const ok = (data) => ({ ok: true, data })
const fail = (code, message, debug) => ({ ok: false, code, message, debug })

const getCallerOpenid = () => {
  const context = cloud.getWXContext()
  return context.FROM_OPENID || context.OPENID || ''
}

const dayKeyOf = (timestamp) => {
  const date = new Date(timestamp + 8 * 60 * 60 * 1000)
  return date.toISOString().slice(0, 10)
}

async function secCheck(openid, scenicName, description) {
  try {
    const result = await cloud.openapi.security.msgSecCheck({
      openid,
      scene: 3,
      version: 2,
      title: `${scenicName || '景区'}资料纠错`,
      content: description,
    })
    return (result.result && result.result.suggest) || 'pass'
  } catch (error) {
    console.error('msgSecCheck 调用失败', error)
    return 'review'
  }
}

async function create(openid, input) {
  if (!input || typeof input !== 'object') return fail('INVALID', '纠错内容不能为空')
  const scenicId = String(input.scenicId || '').trim().slice(0, 64)
  const scenicName = String(input.scenicName || '').trim().slice(0, 40)
  const type = TYPES.includes(input.type) ? input.type : 'other'
  const description = String(input.description || '').trim().slice(0, 500)
  if (!scenicId || !scenicName) return fail('INVALID_SCENIC', '缺少景区信息')
  if (description.length < 5) return fail('TOO_SHORT', '请至少填写 5 个字')

  const now = Date.now()
  const dayKey = dayKeyOf(now)
  // 首次调用时自动创建集合；已存在时 createCollection 失败可安全忽略。
  await db.createCollection('shijing_corrections').catch(() => null)
  const count = await corrections.where({ _openid: openid, dayKey }).count()
  if (count.total >= 5) return fail('RATE_LIMITED', '今天提交的纠错较多，请明天再试')

  const suggest = await secCheck(openid, scenicName, description)
  if (suggest === 'risky') return fail('SEC_RISKY', '说明中可能包含不当内容，请修改后再提交')

  const doc = {
    _openid: openid,
    scenicId,
    scenicName,
    type,
    description,
    status: 'pending',
    securitySuggest: suggest,
    dayKey,
    createdAt: now,
    updatedAt: now,
  }
  const result = await corrections.add({ data: doc })
  return ok({ id: result._id, status: 'pending' })
}

exports.main = async (event) => {
  const openid = getCallerOpenid()
  if (!openid) return fail('NO_OPENID', '未获取到用户身份')
  try {
    if (event.action === 'create') return await create(openid, event.correction)
    return fail('BAD_ACTION', '不支持的操作', `action=${event.action}`)
  } catch (error) {
    return fail(
      'SERVER_ERROR',
      '服务开小差了，请稍后再试',
      `请确认已创建 shijing_corrections 集合：${error.message}`,
    )
  }
}
