/**
 * 我的收藏：以已同步的轻量快照构建可搜索的私人景区库。
 * 页面不逐条请求景区详情；只有用户点开条目时才读取最新资料，避免收藏多时产生大量并发请求。
 */
import { getFavorites, getSyncState, subscribe, toggleFavorite } from '../../stores/user-data'
import { ANALYTICS_EVENTS, reportEvent } from '../../constants/analytics'
import { FavoriteItem } from '../../types/index'
import { buildFavoritesExportText } from '../../utils/export-text'
import { toDateString } from '../../utils/format'
import { syncTabBar, toast } from '../../utils/page'

type FavoriteKind = 'scenic' | 'guide'
interface FavoriteView extends FavoriteItem {
  savedDate: string
  kindLabel: string
}
interface FavoritesPageInstance extends WechatMiniprogram.Page.TrivialInstance {
  unsubscribeUserData?: () => void
}

const PAGE_SIZE = 24

Page({
  data: {
    keyword: '',
    kind: 'scenic' as FavoriteKind,
    recentFirst: true,
    visibleLimit: PAGE_SIZE,
    counts: { total: 0, scenic: 0, guide: 0 },
    matchedCount: 0,
    visibleItems: [] as FavoriteView[],
    hasMore: false,
    syncText: '',
    emptyTitle: '还没有收藏景区',
    emptyDesc: '在景区卡片或详情页点星标，就能把想去的地方收进来',
    exportVisible: false,
    exportText: '',
    exportItemCount: 0,
  },

  onLoad() {
    const self = this as unknown as FavoritesPageInstance
    self.unsubscribeUserData = subscribe(() => this.renderFavorites())
  },

  onUnload() {
    const self = this as unknown as FavoritesPageInstance
    if (self.unsubscribeUserData) self.unsubscribeUserData()
    self.unsubscribeUserData = undefined
  },

  onShow() {
    syncTabBar(this, 1)
    this.renderFavorites()
  },

  onPullDownRefresh() {
    this.renderFavorites()
    wx.stopPullDownRefresh()
  },

  onReachBottom() {
    if (this.data.hasMore) this.renderFavorites({ visibleLimit: this.data.visibleLimit + PAGE_SIZE })
  },

  /** 搜索、筛选和翻页只处理本机快照；一次 setData 更新当前可见的最多 N 条。 */
  renderFavorites(options: { keyword?: string; kind?: FavoriteKind; recentFirst?: boolean; visibleLimit?: number } = {}) {
    const keyword = options.keyword === undefined ? this.data.keyword : options.keyword
    const kind = options.kind || this.data.kind
    const recentFirst = options.recentFirst === undefined ? this.data.recentFirst : options.recentFirst
    const visibleLimit = options.visibleLimit || this.data.visibleLimit
    const favorites = getFavorites()
    const counts = {
      total: favorites.length,
      scenic: favorites.filter((item) => item.type === 'scenic').length,
      guide: favorites.filter((item) => item.type === 'guide').length,
    }
    const query = keyword.trim().toLowerCase()
    const matched = favorites
      .filter((item) => item.type === kind)
      .filter((item) => !query || `${item.title} ${item.subtitle}`.toLowerCase().includes(query))
      .sort((a, b) => (recentFirst ? 1 : -1) * ((Number(b.createdAt) || 0) - (Number(a.createdAt) || 0)))
    const visibleItems = matched.slice(0, visibleLimit).map((item): FavoriteView => ({
      ...item,
      savedDate: item.createdAt ? toDateString(new Date(item.createdAt)) : '',
      kindLabel: item.type === 'scenic' ? '景区' : '攻略',
    }))
    this.setData({
      keyword,
      kind,
      recentFirst,
      visibleLimit,
      counts,
      matchedCount: matched.length,
      visibleItems,
      hasMore: matched.length > visibleItems.length,
      syncText: getSyncState().text,
      emptyTitle: query ? '没有找到匹配的收藏' : kind === 'scenic' ? '还没有收藏景区' : '还没有收藏攻略',
      emptyDesc: query ? '换个景区名或城市再试试' : kind === 'scenic'
        ? '在景区卡片或详情页点星标，就能把想去的地方收进来'
        : '在攻略详情页点收藏，出行前可随时回来查看',
    })
  },

  onInput(e: WechatMiniprogram.Input) {
    this.renderFavorites({ keyword: e.detail.value, visibleLimit: PAGE_SIZE })
  },

  onClearSearch() {
    this.renderFavorites({ keyword: '', visibleLimit: PAGE_SIZE })
  },

  onKind(e: WechatMiniprogram.TouchEvent) {
    const kind = e.currentTarget.dataset.kind as FavoriteKind
    if (kind === this.data.kind) return
    this.renderFavorites({ kind, visibleLimit: PAGE_SIZE })
  },

  onSort() {
    this.renderFavorites({ recentFirst: !this.data.recentFirst, visibleLimit: PAGE_SIZE })
  },

  onOpen(e: WechatMiniprogram.TouchEvent) {
    const item = getFavorites().find((favorite) => favorite.id === e.currentTarget.dataset.id)
    if (!item) return
    // 攻略详情已进入扩展分包，不能再与主包景区详情共用动态路径拼接。
    const url = item.type === 'scenic'
      ? `/pages/scenic/index?id=${encodeURIComponent(item.targetId)}`
      : `/packageExtra/pages/guide-detail/index?id=${encodeURIComponent(item.targetId)}`
    wx.navigateTo({ url })
  },

  onRemove(e: WechatMiniprogram.TouchEvent) {
    const item = getFavorites().find((favorite) => favorite.id === e.currentTarget.dataset.id)
    if (!item) return
    wx.showModal({
      title: '取消收藏？',
      content: `「${item.title}」将从你的收藏中移除，景区资料和行程不会删除。`,
      confirmText: '取消收藏',
      confirmColor: '#B0513B',
      success: (result) => {
        if (!result.confirm) return
        // 再次读取，避免弹窗期间其他页面或同步操作已改变收藏状态。
        const current = getFavorites().find((favorite) => favorite.id === item.id)
        if (!current) return
        toggleFavorite(current)
        reportEvent(ANALYTICS_EVENTS.FAVORITE_TOGGLE, {
          page: 'favorites', action: 'remove', scene: current.type, result: 'success',
        })
        toast('已取消收藏')
      },
    })
  },

  /** 导出全部收藏，不受当前搜索、类型筛选或分页状态影响。 */
  onOpenExport() {
    const favorites = getFavorites()
    const text = buildFavoritesExportText(favorites)
    if (!text) {
      toast('暂无收藏可导出')
      return
    }
    this.setData({ exportVisible: true, exportText: text, exportItemCount: favorites.length })
  },

  onCloseExport() {
    this.setData({ exportVisible: false })
  },

  onDiscover() {
    if (this.data.kind === 'scenic') wx.switchTab({ url: '/pages/home/index' })
    else wx.navigateTo({ url: '/pages/guides/index' })
  },
})
