/**
 * 浏览足迹：直接读取用户数据仓库中的轻量景区快照。
 * 页面不逐条请求景区详情，只有用户点击条目时才进入详情页读取最新资料。
 */
import { getProvince } from '../../../constants/provinces'
import { clearFootprints, getFootprints, getSyncState, subscribe } from '../../../stores/user-data'
import { FootprintItem } from '../../../types/index'
import { relativeTime } from '../../../utils/format'
import { toast } from '../../../utils/page'

interface FootprintView extends FootprintItem {
  provinceName: string
  timeLabel: string
}

interface FootprintsPageInstance extends WechatMiniprogram.Page.TrivialInstance {
  unsubscribeUserData?: () => void
}

const PAGE_SIZE = 30

Page({
  data: {
    count: 0,
    visibleLimit: PAGE_SIZE,
    items: [] as FootprintView[],
    hasMore: false,
    syncText: '',
  },

  onLoad() {
    const self = this as unknown as FootprintsPageInstance
    self.unsubscribeUserData = subscribe(() => this.renderFootprints())
  },

  onUnload() {
    const self = this as unknown as FootprintsPageInstance
    if (self.unsubscribeUserData) self.unsubscribeUserData()
    self.unsubscribeUserData = undefined
  },

  onShow() {
    this.renderFootprints()
  },

  onPullDownRefresh() {
    this.renderFootprints()
    wx.stopPullDownRefresh()
  },

  onReachBottom() {
    if (this.data.hasMore) this.renderFootprints(this.data.visibleLimit + PAGE_SIZE)
  },

  /** 每次刷新都重算相对时间；列表最多 200 条，并按浏览时间倒序展示。 */
  renderFootprints(visibleLimit?: number) {
    const limit = visibleLimit || this.data.visibleLimit
    const footprints = getFootprints()
      .slice()
      .sort((a, b) => (Number(b.visitedAt) || 0) - (Number(a.visitedAt) || 0))
    const items = footprints.slice(0, limit).map((item): FootprintView => ({
      ...item,
      provinceName: getProvince(item.province).name,
      // 展示采用用户浏览时的本机真实时间，避免服务端校时偏移影响“刚刚/几分钟前”。
      timeLabel: relativeTime(Number(item.localVisitedAt || item.visitedAt) || Date.now()),
    }))
    this.setData({
      count: footprints.length,
      visibleLimit: limit,
      items,
      hasMore: footprints.length > items.length,
      syncText: getSyncState().text,
    })
  },

  onOpen(e: WechatMiniprogram.TouchEvent) {
    const scenicId = String(e.currentTarget.dataset.id || '')
    if (scenicId) wx.navigateTo({ url: `/pages/scenic/index?id=${encodeURIComponent(scenicId)}` })
  },

  onClear() {
    if (!this.data.count) return
    wx.showModal({
      title: '清空全部浏览历史？',
      content: '浏览记录会从本机和云端同步数据中清除，收藏与行程不会受到影响。',
      confirmText: '全部清空',
      confirmColor: '#B0513B',
      success: (result) => {
        if (!result.confirm) return
        clearFootprints()
        toast('浏览历史已清空')
      },
    })
  },

  toDiscover() {
    wx.switchTab({ url: '/pages/home/index' })
  },
})
