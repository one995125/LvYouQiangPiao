/**
 * 云函数 shijingLogin
 * - 默认：返回 openid，并在 shijing_users 集合中创建 / 更新用户记录
 * - action=updateProfile：更新头像昵称
 * 云函数调用天然携带用户身份（getWXContext），无需 code2session。
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const users = db.collection('shijing_users')

const ok = (data) => ({ ok: true, data })
const fail = (code, message, debug) => ({ ok: false, code, message, debug })

/** 环境共享调用时用户身份位于 FROM_OPENID；直连资源方时仍兼容 OPENID。 */
const getCallerOpenid = () => {
  const wxContext = cloud.getWXContext()
  return wxContext.FROM_OPENID || wxContext.OPENID || ''
}

async function getUser(openid) {
  try {
    const res = await users.doc(openid).get()
    return res.data
  } catch (e) {
    return null
  }
}

exports.main = async (event) => {
  const OPENID = getCallerOpenid()
  if (!OPENID) return fail('NO_OPENID', '未获取到用户身份', '请在小程序端通过 wx.cloud.callFunction 调用')

  try {
    const now = Date.now()
    const user = await getUser(OPENID)

    if (event.action === 'updateProfile') {
      const nickName = String(event.nickName || '').trim().slice(0, 20)
      const avatarUrl = String(event.avatarUrl || '').slice(0, 512)
      if (!nickName) return fail('INVALID_NICKNAME', '昵称不能为空')
      const patch = { nickName, avatarUrl, updatedAt: now }
      if (user) await users.doc(OPENID).update({ data: patch })
      else await users.add({ data: { _id: OPENID, _openid: OPENID, createdAt: now, loginAt: now, ...patch } })
      return ok({ openid: OPENID, nickName, avatarUrl })
    }

    if (user) {
      await users.doc(OPENID).update({ data: { loginAt: now } })
      return ok({ openid: OPENID, nickName: user.nickName || '', avatarUrl: user.avatarUrl || '' })
    }
    await users.add({ data: { _id: OPENID, _openid: OPENID, nickName: '', avatarUrl: '', createdAt: now, loginAt: now } })
    return ok({ openid: OPENID, nickName: '', avatarUrl: '' })
  } catch (e) {
    return fail('DB_ERROR', '登录服务暂不可用', `请确认已创建 shijing_users 集合：${e.message}`)
  }
}
