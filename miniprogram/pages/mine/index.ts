/** 我的：登录态、数据概览、功能入口 */
import { APP_NAME } from '../../constants/config'
import { login, logout } from '../../services/auth'
import { isCloudReady } from '../../services/cloud'
import { clearLocalUserData, getFavorites, getFootprints, getProfile, getSyncState, getTrips, subscribe } from '../../stores/user-data'
import { UserProfile } from '../../types/index'
import { syncTabBar, toast } from '../../utils/page'

interface SyncPageInstance extends WechatMiniprogram.Page.TrivialInstance {
  unsubscribeUserData?: () => void
}

Page({
  data: {
    appName: APP_NAME,
    profile: null as UserProfile | null,
    cloud: false,
    stats: { favs: 0, footprints: 0, trips: 0 },
    logging: false,
    syncText: '本地模式 · 数据保存在本机',
  },

  onLoad() {
    const self = this as unknown as SyncPageInstance
    self.unsubscribeUserData = subscribe(() => {
      void this.refresh()
      syncTabBar(this, 3)
    })
  },

  onUnload() {
    const self = this as unknown as SyncPageInstance
    if (self.unsubscribeUserData) self.unsubscribeUserData()
    self.unsubscribeUserData = undefined
  },

  onShow() {
    syncTabBar(this, 3)
    this.refresh()
  },

  onShareAppMessage() {
    return { title: '景区官方购票入口，一处收拢 · 拾景', path: '/pages/home/index' }
  },

  refresh() {
    const profile = getProfile()
    const sync = getSyncState()
    this.setData({
      profile,
      cloud: isCloudReady(),
      stats: {
        favs: getFavorites().filter((item) => item.type === 'scenic').length,
        footprints: getFootprints().length,
        trips: getTrips().length,
      },
      syncText: sync.text,
    })
  },

  async onLogin() {
    if (this.data.logging) return
    this.setData({ logging: true })
    try {
      await login()
      this.refresh()
      toast('登录成功')
    } catch (e) {
      const err = e as { message?: string }
      toast(err.message || '登录失败，请稍后再试')
    } finally {
      this.setData({ logging: false })
    }
  },

  toProfile() {
    if (!this.data.profile) {
      this.onLogin()
      return
    }
    wx.navigateTo({ url: '/packageExtra/pages/profile/index' })
  },
  toTrips() {
    wx.switchTab({ url: '/pages/trips/index' })
  },
  toFavorites() {
    wx.switchTab({ url: '/pages/favorites/index' })
  },
  toFootprints() {
    wx.navigateTo({ url: '/packageExtra/pages/footprints/index' })
  },
  toTicketTips() {
    wx.navigateTo({ url: '/packageExtra/pages/guide-detail/index?id=g-ticket-101' })
  },
  toAbout() {
    wx.navigateTo({ url: '/packageExtra/pages/about/index' })
  },

  onLogout() {
    wx.showModal({
      title: '退出登录',
      content: '退出后本机的收藏、浏览历史与行程仍会保留。',
      confirmColor: '#2F5A51',
      success: (r) => {
        if (!r.confirm) return
        logout()
        this.refresh()
      },
    })
  },

  onClear() {
    wx.showModal({
      title: '清除本机数据',
      content: this.data.cloud ? '将清除本机缓存，云端数据不受影响，重新登录即可恢复。' : '当前为本地模式，清除后收藏、浏览历史与行程将无法恢复。',
      confirmText: '清除',
      confirmColor: '#B0513B',
      success: (r) => {
        if (!r.confirm) return
        clearLocalUserData()
        this.refresh()
        toast('已清除')
      },
    })
  },
})
