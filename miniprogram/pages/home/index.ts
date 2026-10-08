/**
 * 发现页：切换省份 → 查看景区榜单（可按热度 / 游客量 / 评分 / 价格排序）→ 一键直达官方购票
 */
import { DEFAULT_PROVINCE, STORAGE_KEYS } from '../../constants/config'
import { PROVINCE_COLORS } from '../../constants/travel-map'
import { ANALYTICS_EVENTS, durationBucket, reportEvent } from '../../constants/analytics'
import { SORT_OPTIONS } from '../../constants/enums'
import { getProvince } from '../../constants/provinces'
import { listScenics } from '../../services/scenic'
import { reportClientError } from '../../services/error-monitor'
import {
  getFavorites,
  getFootprints,
  getTrips,
  getVisitedProvinces,
  getVisitedScenics,
  getWishProvinces,
  subscribe,
} from '../../stores/user-data'
import { FootprintItem, Scenic, ScenicLocation, SortKey, TripItem } from '../../types/index'
import { countdownLabel, relativeTime } from '../../utils/format'
import { recommendLoadedScenics, selectRecentFootprints } from '../../utils/home-personalization'
import { isValidScenicLocation } from '../../utils/location'
import { syncTabBar, toast } from '../../utils/page'

interface HomePageInstance extends WechatMiniprogram.Page.TrivialInstance {
  unsubscribeUserData?: () => void
  locationOrigin?: ScenicLocation
  locationNoticeKey?: string
}

interface HomeFootprintView extends FootprintItem {
  provinceName: string
  timeLabel: string
}

declare function require(path: string): unknown
const provinceCentroids = require('../../data/province-centroids.js') as Record<string, [number, number]>
const DOT_K = 3.25

function travelMapDots() {
  const visited = new Set(getVisitedProvinces())
  const wish = new Set(getWishProvinces())
  return Object.entries(provinceCentroids).map(([code, [lon, lat]]) => {
    const state = visited.has(code) ? 'visited' : wish.has(code) ? 'wish' : 'none'
    const colors = PROVINCE_COLORS[code]
    return {
      code,
      left: `${(((lon - 73) * Math.cos((35.5 * Math.PI) / 180) * DOT_K) / 200) * 100}%`,
      top: `${(((53.8 - lat) * DOT_K) / 142) * 100}%`,
      fill: state === 'visited' ? colors.dark : colors.light,
      stroke: state === 'visited' ? '#1E201F' : state === 'wish' ? '#A9844F' : 'transparent',
      state,
    }
  })
}

/** 只在用户主动点击“离我最近”时调用，不在启动或页面展示时自动定位。 */
function getCurrentLocation(): Promise<ScenicLocation> {
  return new Promise((resolve, reject) => {
    if (typeof wx.getLocation !== 'function') {
      reject(new Error('当前基础库不支持获取位置'))
      return
    }
    wx.getLocation({
      type: 'gcj02',
      success: (result) => {
        const point = { lat: result.latitude, lng: result.longitude }
        if (isValidScenicLocation(point)) resolve(point)
        else reject(new Error('位置坐标无效'))
      },
      fail: reject,
    })
  })
}

Page({
  data: {
    province: DEFAULT_PROVINCE,
    provinceName: '',
    slogan: '',
    sortOptions: SORT_OPTIONS,
    sort: 'heat' as SortKey,
    sortHint: SORT_OPTIONS[0].hint,
    only5A: false,
    feature: null as Scenic | null,
    rest: [] as Scenic[],
    total: 0,
    page: 0,
    hasMore: false,
    loading: true,
    loadingMore: false,
    error: false,
    pickerVisible: false,
    solid: false,
    reminder: null as null | { count: number; name: string; when: string },
    favoriteCount: 0,
    locating: false,
    /** 直接来自本地足迹快照，不为首页回流模块补查景区详情。 */
    recentFootprints: [] as HomeFootprintView[],
    /** 只从当前 feature/rest 中挑选，不发起新的景区列表或详情请求。 */
    recommendations: [] as Scenic[],
    travelMapDots: travelMapDots(),
    travelMapLitCount: 0,
    travelMapVisitedScenicCount: 0,
    travelMapProgress: 0,
  },

  onLoad(query: Record<string, string | undefined>) {
    const self = this as unknown as HomePageInstance
    self.unsubscribeUserData = subscribe(() => {
      this.refreshReminder()
      syncTabBar(this, 0)
    })
    const saved = wx.getStorageSync(STORAGE_KEYS.province) as string
    const sharedProvince = query.province ? getProvince(query.province).code : ''
    this.applyProvince(sharedProvince || saved || DEFAULT_PROVINCE)
  },

  onUnload() {
    const self = this as unknown as HomePageInstance
    if (self.unsubscribeUserData) self.unsubscribeUserData()
    self.unsubscribeUserData = undefined
  },

  onShow() {
    syncTabBar(this, 0)
    this.refreshReminder()
  },

  onPullDownRefresh() {
    this.load(true).then(() => wx.stopPullDownRefresh())
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loadingMore) this.load(false)
  },

  onPageScroll(e: WechatMiniprogram.Page.IPageScrollOption) {
    const solid = e.scrollTop > 40
    if (solid !== this.data.solid) this.setData({ solid })
  },

  onShareAppMessage() {
    reportEvent(ANALYTICS_EVENTS.SHARE_CLICK, { page: 'home', action: 'friend', scene: 'home' })
    return {
      title: `${this.data.provinceName}景区官方购票入口，一处收拢`,
      path: `/pages/home/index?province=${encodeURIComponent(this.data.province)}`,
    }
  },

  onShareTimeline() {
    reportEvent(ANALYTICS_EVENTS.SHARE_CLICK, { page: 'home', action: 'timeline', scene: 'home' })
    return {
      title: `${this.data.provinceName}景区官方渠道与游玩资料 · 拾景`,
      query: `province=${encodeURIComponent(this.data.province)}`,
    }
  },

  applyProvince(code: string) {
    const p = getProvince(code)
    wx.setStorageSync(STORAGE_KEYS.province, p.code)
    this.setData({ province: p.code, provinceName: p.name, slogan: p.slogan })
    this.load(true)
  },

  async load(reset: boolean) {
    const startedAt = Date.now()
    const page = reset ? 0 : this.data.page + 1
    const self = this as unknown as HomePageInstance
    this.setData(reset ? { loading: true, error: false, recommendations: [] } : { loadingMore: true })
    try {
      const requestedSort = this.data.sort
      const res = await listScenics({
        province: this.data.province,
        sort: requestedSort,
        only5A: this.data.only5A,
        page,
        ...(requestedSort === 'nearest' && self.locationOrigin ? { origin: self.locationOrigin } : {}),
      })
      const all = reset ? res.list : [...(this.data.feature ? [this.data.feature] : []), ...this.data.rest, ...res.list]
      const fallbackToHeat = requestedSort === 'nearest' && res.nearestFallback === true
      const nextSort = fallbackToHeat ? 'heat' : requestedSort
      const nextOption = SORT_OPTIONS.find((item) => item.key === nextSort)
      this.setData({
        feature: all[0] || null,
        rest: all.slice(1),
        total: all.length,
        page,
        hasMore: res.hasMore,
        loading: false,
        loadingMore: false,
        sort: nextSort,
        sortHint: nextOption ? nextOption.hint : '',
      })
      // 榜单数据进入页面内存后再重算推荐；这里不新增任何 service 调用。
      this.refreshReminder()
      reportEvent(ANALYTICS_EVENTS.HOME_LOAD, {
        page: 'home',
        action: 'load',
        scene: reset ? 'refresh' : 'load_more',
        result: 'success',
        item_count: all.length,
        duration_bucket: durationBucket(Date.now() - startedAt),
      })
      if (reset && requestedSort === 'nearest') {
        const noticeKey = `${this.data.province}:${fallbackToHeat ? 'fallback' : res.missingLocationCount || 0}`
        if (self.locationNoticeKey !== noticeKey) {
          self.locationNoticeKey = noticeKey
          if (fallbackToHeat) toast('暂无已核验坐标，已按热度展示')
          else if (res.missingLocationCount) toast('部分景区暂无坐标，已按热度排在后面')
        }
      }
    } catch (e) {
      this.setData({ loading: false, loadingMore: false, error: true })
      reportEvent(ANALYTICS_EVENTS.HOME_LOAD, {
        page: 'home', action: 'load', scene: reset ? 'refresh' : 'load_more', result: 'failed',
        item_count: 0, duration_bucket: durationBucket(Date.now() - startedAt),
      })
      void reportClientError('page_error', e, 'home')
    }
  },

  refreshReminder() {
    const favorites = getFavorites()
    const favoriteCount = favorites.filter((item) => item.type === 'scenic').length
    const footprints = getFootprints()
    const recentFootprints = selectRecentFootprints(footprints).map((item): HomeFootprintView => ({
      ...item,
      provinceName: getProvince(item.province).name,
      // 展示仍使用本机真实浏览时间，避免服务端校时偏移改变“刚刚”等文案。
      timeLabel: relativeTime(Number(item.localVisitedAt || item.visitedAt) || Date.now()),
    }))
    const loadedScenics = [this.data.feature, ...this.data.rest].filter((item): item is Scenic => Boolean(item))
    const recommendations = recommendLoadedScenics(loadedScenics, favorites, footprints)
    const pending = getTrips().filter((t) => t.status === 'pending')
    const travelMapLitCount = new Set([...getVisitedProvinces(), ...getWishProvinces()]).size
    const travelMapState = {
      travelMapDots: travelMapDots(),
      travelMapLitCount,
      travelMapVisitedScenicCount: getVisitedScenics().length,
      travelMapProgress: Math.round((travelMapLitCount / 34) * 100),
    }
    if (!pending.length) {
      this.setData({ reminder: null, favoriteCount, recentFootprints, recommendations, ...travelMapState })
      return
    }
    const next = pending
      .slice()
      .sort((a: TripItem, b: TripItem) => (a.date || '9999').localeCompare(b.date || '9999'))[0]
    this.setData({
      reminder: { count: pending.length, name: next.scenicName, when: countdownLabel(next.date) },
      favoriteCount,
      recentFootprints,
      recommendations,
      ...travelMapState,
    })
  },

  async onSort(e: WechatMiniprogram.TouchEvent) {
    const sort = e.currentTarget.dataset.key as SortKey
    if (sort === this.data.sort || this.data.locating) return
    const opt = SORT_OPTIONS.find((o) => o.key === sort)
    if (sort === 'nearest') {
      const self = this as unknown as HomePageInstance
      this.setData({ locating: true })
      try {
        self.locationOrigin = self.locationOrigin || await getCurrentLocation()
        this.setData({ sort, sortHint: opt ? opt.hint : '', locating: false })
        await this.load(true)
      } catch (error) {
        console.info('[home] 获取位置失败，回退热度排序', error)
        const heat = SORT_OPTIONS.find((item) => item.key === 'heat')
        this.setData({ sort: 'heat', sortHint: heat ? heat.hint : '', locating: false })
        toast('未能获取位置，已按热度展示')
        await this.load(true)
      }
      return
    }
    this.setData({ sort, sortHint: opt ? opt.hint : '' })
    await this.load(true)
  },

  onToggle5A() {
    this.setData({ only5A: !this.data.only5A })
    this.load(true)
  },

  openPicker() {
    this.setData({ pickerVisible: true })
  },
  closePicker() {
    this.setData({ pickerVisible: false })
  },
  onPickProvince(e: WechatMiniprogram.CustomEvent<{ code: string }>) {
    this.setData({ pickerVisible: false })
    if (e.detail.code !== this.data.province) {
      wx.pageScrollTo({ scrollTop: 0, duration: 0 })
      this.applyProvince(e.detail.code)
    }
  },

  toSearch() {
    wx.navigateTo({ url: '/packageExtra/pages/search/index' })
  },
  toTrips() {
    wx.switchTab({ url: '/pages/trips/index' })
  },
  toFavorites() {
    wx.switchTab({ url: '/pages/favorites/index' })
  },
  toGuides() {
    wx.navigateTo({ url: '/pages/guides/index' })
  },
  toFootprints() {
    wx.navigateTo({ url: '/packageExtra/pages/footprints/index' })
  },
  toTravelMap() {
    wx.navigateTo({ url: '/packageExtra/pages/travel-map/index' })
  },
  onOpenFootprint(e: WechatMiniprogram.TouchEvent) {
    const scenicId = String(e.currentTarget.dataset.id || '')
    if (scenicId) wx.navigateTo({ url: `/pages/scenic/index?id=${encodeURIComponent(scenicId)}` })
  },
  onRetry() {
    this.load(true)
  },
})
