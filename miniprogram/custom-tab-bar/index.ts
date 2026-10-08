/**
 * 自定义悬浮 TabBar
 * 每个 tab 页都会实例化一份，选中态由页面 onShow 中 syncTabBar() 设置；
 * 「行程」角标显示待抢票数量，提醒用户复用词条。
 */
import { pendingTripCount, subscribe } from '../stores/user-data'

interface TabBarInstance extends WechatMiniprogram.Component.TrivialInstance {
  unsubscribeUserData?: () => void
}

Component({
  data: {
    selected: 0,
    badge: 0,
    list: [
      { path: '/pages/home/index', text: '发现', icon: 'compass', active: 'compass-filled' },
      { path: '/pages/favorites/index', text: '收藏', icon: 'star', active: 'star-filled' },
      { path: '/pages/trips/index', text: '行程', icon: 'calendar', active: 'calendar-filled' },
      { path: '/pages/mine/index', text: '我的', icon: 'user', active: 'user-filled' },
    ],
  },
  lifetimes: {
    attached() {
      const self = this as unknown as TabBarInstance
      self.unsubscribeUserData = subscribe(() => this.refreshBadge())
    },
    detached() {
      const self = this as unknown as TabBarInstance
      if (self.unsubscribeUserData) self.unsubscribeUserData()
      self.unsubscribeUserData = undefined
    },
  },
  pageLifetimes: {
    show() {
      this.refreshBadge()
    },
  },
  methods: {
    refreshBadge() {
      this.setData({ badge: pendingTripCount() })
    },
    onTap(e: WechatMiniprogram.TouchEvent) {
      const index = Number(e.currentTarget.dataset.index)
      if (index === this.data.selected) return
      wx.switchTab({ url: this.data.list[index].path })
    },
  },
})
