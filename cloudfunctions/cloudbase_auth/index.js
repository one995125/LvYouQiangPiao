const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

/**
 * 共享环境的统一入口鉴权。
 * 控制台授权是第一层防护；这里使用来源 AppID 白名单再次隔离各消费方小程序。
 * 修改时必须保留已上线项目，避免更新一个项目时中断其他小程序的云调用。
 */
const ALLOWED_SOURCE_APPIDS = new Set([
  'wx321ca81987b40070', // 酒局饭局聚会
  'wxcdddf92365df9b77', // 线下桌游发牌器
  'wx2e5899c27aa6dd48', // 拾景旅游景区攻略指南
])

exports.main = async () => {
  const wxContext = cloud.getWXContext()
  const sourceAppid = wxContext.FROM_APPID || wxContext.APPID || ''

  if (!ALLOWED_SOURCE_APPIDS.has(sourceAppid)) {
    return {
      errCode: 403,
      errMsg: '当前小程序未获准访问该共享云环境',
    }
  }

  return {
    errCode: 0,
    errMsg: '',
    auth: JSON.stringify({ project: 'shared_apps', sourceAppid }),
  }
}
