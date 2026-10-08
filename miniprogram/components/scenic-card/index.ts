/**
 * 景区卡片
 * variant: feature（榜首大卡）| row（榜单行）| compact（收藏 / 搜索结果）
 * 自行处理：进入详情、收藏切换、官方购票跳转；收藏变化后向外抛出 favchange 事件。
 */
import { favoriteFromScenic, isFavorite, subscribe, toggleFavorite } from '../../stores/user-data'
import { ANALYTICS_EVENTS, reportEvent } from '../../constants/analytics'
import { canJump, openTicket, primaryOfficialEntry } from '../../services/ticket'
import { Scenic, ScenicListItem, SortKey } from '../../types/index'
import { formatPrice, formatVisitors, toDateString } from '../../utils/format'
import { formatDistance } from '../../utils/location'
import { toast, vibrate } from '../../utils/page'
import { getCompareIds, subscribeComparison, toggleCompare } from '../../stores/comparison'
import { activeNoticeViews } from '../../utils/notice'

interface Stat {
  k: string
  v: string
  on: boolean
}

interface ScenicCardInstance extends WechatMiniprogram.Component.TrivialInstance {
  unsubscribeUserData?: () => void
  unsubscribeComparison?: () => void
}

function buildStats(s: ScenicListItem, sort: SortKey): Stat[] {
  if (sort === 'nearest') {
    return [
      { k: '距离', v: typeof s.distanceKm === 'number' ? formatDistance(s.distanceKm) : '—', on: typeof s.distanceKm === 'number' },
      { k: '年接待', v: formatVisitors(s.visitors), on: false },
      { k: '评分', v: s.rating.toFixed(1), on: false },
    ]
  }
  return [
    { k: '热度', v: `${s.heat}`, on: sort === 'heat' },
    { k: '年接待', v: formatVisitors(s.visitors), on: sort === 'visitors' },
    { k: '评分', v: s.rating.toFixed(1), on: sort === 'rating' },
  ]
}

Component({
  options: { styleIsolation: 'apply-shared' },
  properties: {
    scenic: { type: Object, value: {} },
    rank: { type: Number, value: 0 },
    sort: { type: String, value: 'heat' },
    variant: { type: String, value: 'row' },
  },
  data: {
    fav: false,
    comparing: false,
    alertText: '',
    rankText: '',
    priceText: '',
    ticketText: '查渠道',
    ticketDay: '',
    stats: [] as Stat[],
  },
  observers: {
    'scenic, sort, rank'(s: ScenicListItem, sort: SortKey, rank: number) {
      if (!s || !s._id) return
      this.setData({
        fav: isFavorite('scenic', s._id),
        comparing: getCompareIds().includes(s._id),
        alertText: activeNoticeViews(s.notices).find((notice) => notice.urgent)?.typeLabel || '',
        rankText: rank > 0 ? (rank < 10 ? `0${rank}` : `${rank}`) : '',
        priceText: formatPrice(s.price),
        stats: buildStats(s, sort),
        ticketText: canJump(primaryOfficialEntry(s)) ? '官方购票' : '查渠道',
        ticketDay: toDateString(new Date()),
      })
    },
  },
  lifetimes: {
    attached() {
      const self = this as unknown as ScenicCardInstance
      self.unsubscribeUserData = subscribe(() => this.refreshFavorite())
      self.unsubscribeComparison = subscribeComparison(() => this.refreshComparison())
    },
    detached() {
      const self = this as unknown as ScenicCardInstance
      if (self.unsubscribeUserData) self.unsubscribeUserData()
      if (self.unsubscribeComparison) self.unsubscribeComparison()
      self.unsubscribeUserData = undefined
      self.unsubscribeComparison = undefined
    },
  },
  pageLifetimes: {
    show() {
      this.refreshFavorite()
      this.refreshComparison()
      this.refreshTicketText()
    },
  },
  methods: {
    refreshFavorite() {
      const scenic = this.data.scenic as Scenic
      if (!scenic || !scenic._id) return
      const fav = isFavorite('scenic', scenic._id)
      if (fav !== this.data.fav) this.setData({ fav })
    },
    refreshComparison() {
      const scenic = this.data.scenic as Scenic
      if (!scenic || !scenic._id) return
      const comparing = getCompareIds().includes(scenic._id)
      if (comparing !== this.data.comparing) this.setData({ comparing })
    },
    refreshTicketText() {
      const scenic = this.data.scenic as Scenic
      const today = toDateString(new Date())
      if (!scenic?._id || this.data.ticketDay === today) return
      this.setData({ ticketText: canJump(primaryOfficialEntry(scenic)) ? '官方购票' : '查渠道', ticketDay: today })
    },
    onOpen() {
      const s = this.data.scenic as Scenic
      wx.navigateTo({ url: `/pages/scenic/index?id=${s._id}` })
    },
    onFav() {
      const s = this.data.scenic as Scenic
      const fav = toggleFavorite(favoriteFromScenic(s))
      if (fav === null) {
        toast('收藏已达 500 条上限，请先整理')
        return
      }
      vibrate()
      this.setData({ fav })
      reportEvent(ANALYTICS_EVENTS.FAVORITE_TOGGLE, {
        page: 'scenic_card', action: fav ? 'add' : 'remove', scene: this.data.variant, result: 'success',
      })
      toast(fav ? '已收藏，可在「收藏」中找到' : '已取消收藏')
      this.triggerEvent('favchange', { id: s._id, fav })
    },
    onTicket() {
      const entry = primaryOfficialEntry(this.data.scenic as Scenic)
      reportEvent(ANALYTICS_EVENTS.TICKET_CLICK, {
        page: 'scenic_card', action: 'click', scene: this.data.variant, result: canJump(entry) ? 'direct' : 'fallback',
      })
      openTicket(entry)
    },
    onCompare() {
      const scenic = this.data.scenic as Scenic
      const result = toggleCompare(scenic._id)
      if (result.full) {
        toast('最多同时对比 3 个景区')
        return
      }
      this.setData({ comparing: result.active })
      toast(result.active ? '已加入对比' : '已移出对比')
    },
  },
})
