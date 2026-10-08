/**
 * 云函数 shijingInitData：仅补充云端缺失的示例景区 / 攻略，不覆盖管理员维护后的资料。
 * 安全：仅允许环境变量 ADMIN_OPENIDS（逗号分隔）中的 openid 调用。
 * 获取自己的 openid：登录后在「我的 → 关于与免责声明」页查看。
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const COLLECTIONS = {
  scenics: 'shijing_scenics',
  guides: 'shijing_guides',
}
const ok = (data) => ({ ok: true, data })
const fail = (code, message, debug) => ({ ok: false, code, message, debug })

/** 环境共享调用时使用消费方用户的 FROM_OPENID，直连资源方时兼容 OPENID。 */
const getCallerOpenid = () => {
  const wxContext = cloud.getWXContext()
  return wxContext.FROM_OPENID || wxContext.OPENID || ''
}

exports.main = async (event) => {
  const OPENID = getCallerOpenid()
  const admins = String(process.env.ADMIN_OPENIDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  if (!admins.length) {
    return fail(
      'NO_ADMIN',
      '尚未配置管理员',
      `请在云开发控制台 → 云函数 shijingInitData → 配置环境变量 ADMIN_OPENIDS=${OPENID}`,
    )
  }
  if (!admins.includes(OPENID)) return fail('FORBIDDEN', '仅管理员可执行此操作', `当前 openid：${OPENID}`)

  const { collection, docs } = event || {}
  if (!Object.prototype.hasOwnProperty.call(COLLECTIONS, collection)) {
    return fail('BAD_COLLECTION', '不支持的集合')
  }
  if (!Array.isArray(docs) || !docs.length) return fail('EMPTY', '没有需要写入的数据')

  try {
    const targetCollection = COLLECTIONS[collection]
    await db.createCollection(targetCollection).catch(() => null)
    let written = 0
    let skipped = 0
    for (const doc of docs.slice(0, 50)) {
      const { _id, ...rest } = doc
      if (!_id) continue
      // 读取与创建放在同一事务内；读取失败不是“文档不存在”，绝不能盲目覆盖。
      const outcome = await db.runTransaction(async (transaction) => {
        const ref = transaction.collection(targetCollection).doc(String(_id))
        try {
          await ref.get()
          return 'skipped'
        } catch (error) {
          if (!/DATABASE_DOCUMENT_NOT_EXIST|document does not exist|not exist/i.test(String(error.code || '') + ' ' + String(error.message || ''))) throw error
        }
        await ref.set({ data: { ...rest, _openid: rest._openid || 'system' } })
        return 'written'
      })
      if (outcome === 'skipped' || outcome?.result === 'skipped') skipped += 1
      else written += 1
    }
    return ok({ collection: targetCollection, written, skipped })
  } catch (e) {
    return fail('DB_ERROR', '写入失败', e.message)
  }
}
