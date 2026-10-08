/**
 * 拾景 · 景区官方购票入口聚合
 * 启动时初始化云开发（若已配置），并在已有登录态时静默刷新 openid 与云端数据。
 */
import { initCloud } from './services/cloud'
import { login } from './services/auth'
import { reportClientError } from './services/error-monitor'
import { getProfile, syncUserDataOnAppShow, syncUserDataOnNetworkRestore } from './stores/user-data'

App<IAppOption>({
  globalData: {},
  async onLaunch() {
    // 只监听网络恢复；不触发新登录，仅续接已有云端 profile 的拉取或上传。
    wx.onNetworkStatusChange((status) => {
      if (status.isConnected) void syncUserDataOnNetworkRestore()
    })
    // 环境共享初始化包含一次云端鉴权，必须等待完成后再登录或同步。
    const cloud = await initCloud()
    const profile = getProfile()
    if (cloud && profile) {
      await login().catch((e) => console.warn('[app] 静默登录失败', e))
    }
    this.checkUpdate()
  },
  onShow() {
    // 仓库内部按最近成功同步时间做 1 分钟节流；失败只记录状态，不阻塞页面进入。
    void syncUserDataOnAppShow()
  },
  /** 全局同步错误：先由 error-monitor 脱敏、限频，再静默尝试写云端日志。 */
  onError(error: string) {
    void reportClientError('app_error', error, 'app')
  },
  /** 未处理 Promise：只提取错误类型、消息与栈，不序列化可能含用户数据的完整 reason 对象。 */
  onUnhandledRejection(result: { reason?: unknown }) {
    void reportClientError('unhandled_rejection', result && result.reason, 'app')
  },
  checkUpdate() {
    if (!wx.canIUse('getUpdateManager')) return
    const um = wx.getUpdateManager()
    um.onUpdateReady(() => {
      wx.showModal({
        title: '发现新版本',
        content: '新版本已就绪，是否立即重启体验？',
        confirmColor: '#2F5A51',
        success: (r) => r.confirm && um.applyUpdate(),
      })
    })
  },
})
