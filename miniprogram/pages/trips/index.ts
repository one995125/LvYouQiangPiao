/**
 * 我的行程；收藏已迁至独立主入口，不再在本页逐条查询全部已收藏景区。
 * 行程按状态排序（待抢票 → 已购票 → 已出行），保留放票规则与官方入口，方便反复回来抢票。
 */
import { TRIP_STATUS } from '../../constants/enums'
import { ANALYTICS_EVENTS, reportEvent } from '../../constants/analytics'
import { cancelTripReminder } from '../../services/reminder'
import { getScenic } from '../../services/scenic'
import { createTripShare, revokeTripShare } from '../../services/trip-share'
import { getWeatherForTrip, isWeatherConfigured, WeatherInfo } from '../../services/weather'
import {
  getProfile,
  getSyncState,
  getTrips,
  removeTrip,
  subscribe,
  syncUserDataOnAppShow,
  updateTripStatus,
} from '../../stores/user-data'
import { Scenic, TripItem, TripPeriod, TripStatus } from '../../types/index'
import { buildCalendarExportText, buildTripsExportText } from '../../utils/export-text'
import { countdownLabel, daysUntil, splitDate } from '../../utils/format'
import { syncTabBar, toast } from '../../utils/page'

interface SyncPageInstance extends WechatMiniprogram.Page.TrivialInstance {
  unsubscribeUserData?: () => void
  weatherRequestToken?: number
}

interface TripView extends TripItem {
  month: string
  day: string
  week: string
  countdown: string
  statusLabel: string
  urgent: boolean
  periodLabel: string
  checklistText: string
  /** 异步附加字段；为空时 WXML 完全不渲染天气区域。 */
  weather?: WeatherInfo | null
}

const ORDER: Record<TripStatus, number> = { pending: 0, booked: 1, done: 2 }
const PERIOD_LABEL: Record<TripPeriod, string> = { all: '全天', morning: '上午', afternoon: '下午', evening: '晚上' }
const PERIOD_ORDER: Record<TripPeriod, number> = { morning: 0, afternoon: 1, evening: 2, all: 3 }

function toView(t: TripItem): TripView {
  const d = splitDate(t.date)
  const n = daysUntil(t.date)
  return {
    ...t,
    ...d,
    countdown: countdownLabel(t.date),
    statusLabel: TRIP_STATUS[t.status].label,
    urgent: t.status === 'pending' && !isNaN(n) && n >= 0 && n <= 7,
    periodLabel: PERIOD_LABEL[t.period || 'all'],
    checklistText: Array.isArray(t.checklist) ? t.checklist.join(' · ') : '',
  }
}

Page({
  data: {
    trips: [] as TripView[],
    counts: { pending: 0, booked: 0, done: 0 },
    sheetVisible: false,
    editScenic: null as Scenic | null,
    editTrip: null as TripItem | null,
    shareVisible: false,
    sharePreparing: false,
    shareId: '',
    shareIncludeNotes: false,
    shareIncludeChecklist: false,
    exportVisible: false,
    exportTitle: '',
    exportDescription: '',
    exportText: '',
    exportCalendar: false,
    exportItemCount: 0,
  },

  onLoad() {
    // 分享必须先生成云端快照，页面初始时不允许系统菜单分享一个无效路径。
    wx.hideShareMenu()
    const self = this as unknown as SyncPageInstance
    self.unsubscribeUserData = subscribe(() => {
      void this.refresh()
      syncTabBar(this, 2)
    })
  },

  onUnload() {
    const self = this as unknown as SyncPageInstance
    self.weatherRequestToken = (self.weatherRequestToken || 0) + 1
    if (self.unsubscribeUserData) self.unsubscribeUserData()
    self.unsubscribeUserData = undefined
  },

  onShow() {
    syncTabBar(this, 2)
    this.refresh()
  },

  refresh() {
    const previousWeather = new Map(
      this.data.trips.map((trip) => [trip.id, { date: trip.date, weather: trip.weather }] as const),
    )
    const trips = getTrips()
      .slice()
      .sort(
        (a, b) =>
          ORDER[a.status] - ORDER[b.status] ||
          (a.date || '9999').localeCompare(b.date || '9999') ||
          PERIOD_ORDER[a.period || 'all'] - PERIOD_ORDER[b.period || 'all'],
      )
      .map((trip) => {
        const view = toView(trip)
        const previous = previousWeather.get(view.id)
        return { ...view, weather: previous?.date === view.date ? previous.weather || null : null }
      })
    const counts = { pending: 0, booked: 0, done: 0 }
    trips.forEach((t) => (counts[t.status] += 1))
    this.setData({ trips, counts })
    // 行程卡先完成同步渲染，再并发受控地补充天气；关闭配置时这里不会产生网络请求。
    void this.loadTripWeather(trips)
  },

  async loadTripWeather(trips: TripView[]) {
    if (!isWeatherConfigured() || !trips.length) return
    const self = this as unknown as SyncPageInstance
    const token = (self.weatherRequestToken || 0) + 1
    self.weatherRequestToken = token
    const weatherByTrip = new Map<string, WeatherInfo>()
    let cursor = 0

    /** 最多四个请求并行，避免首次配置服务后大量行程同时挤占网络。 */
    const worker = async () => {
      while (cursor < trips.length) {
        const trip = trips[cursor]
        cursor += 1
        try {
          const weather = await getWeatherForTrip(trip.scenicId, trip.date)
          if (weather) weatherByTrip.set(trip.id, weather)
        } catch (_) {
          // 单条天气失败只隐藏该条附加信息，不影响任何行程字段。
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, trips.length) }, () => worker()))
    if (self.weatherRequestToken !== token || !weatherByTrip.size) return
    this.setData({
      trips: this.data.trips.map((trip) => ({
        ...trip,
        weather: weatherByTrip.get(trip.id) || trip.weather || null,
      })),
    })
  },

  findTrip(e: WechatMiniprogram.TouchEvent): TripItem | undefined {
    const id = e.currentTarget.dataset.id as string
    return getTrips().find((t) => t.id === id)
  },

  onOpenTrip(e: WechatMiniprogram.TouchEvent) {
    const t = this.findTrip(e)
    if (t) wx.navigateTo({ url: `/pages/scenic/index?id=${t.scenicId}` })
  },

  onTicket(e: WechatMiniprogram.TouchEvent) {
    const t = this.findTrip(e)
    // 行程中的 ticket 是保存时的快照，可能已失效；进入详情读取当前渠道，不从旧快照直接跳转。
    if (t) wx.navigateTo({ url: `/pages/scenic/index?id=${encodeURIComponent(t.scenicId)}` })
  },

  onBooked(e: WechatMiniprogram.TouchEvent) {
    const t = this.findTrip(e)
    if (!t) return
    updateTripStatus(t.id, 'booked')
    toast('恭喜抢到票！')
    this.refresh()
  },

  onMore(e: WechatMiniprogram.TouchEvent) {
    const t = this.findTrip(e)
    if (!t) return
    const items = ['编辑行程', t.status === 'done' ? '恢复为待抢票' : '标记为已出行', '删除']
    wx.showActionSheet({
      itemList: items,
      itemColor: '#1E201F',
      success: async (res) => {
        if (res.tapIndex === 0) {
          const scenic = await getScenic(t.scenicId)
          if (scenic) this.setData({ editScenic: scenic, editTrip: t, sheetVisible: true })
        } else if (res.tapIndex === 1) {
          const nextStatus = t.status === 'done' ? 'pending' : 'done'
          updateTripStatus(t.id, nextStatus)
          if (nextStatus === 'done') void cancelTripReminder(t.id)
          this.refresh()
        } else if (res.tapIndex === 2) {
          wx.showModal({
            title: '删除行程',
            content: `确定删除「${t.scenicName}」吗？`,
            confirmColor: '#B0513B',
            success: (r) => {
              if (!r.confirm) return
              removeTrip(t.id)
              void cancelTripReminder(t.id)
              this.refresh()
            },
          })
        }
      },
    })
  },

  onSheetClose() {
    this.setData({ sheetVisible: false })
  },
  onSaved() {
    this.refresh()
  },

  /** 行程备份包含日期待定项，避免用户误以为已经完整备份却发生缺项。 */
  onExportTrips() {
    const trips = getTrips()
    const text = buildTripsExportText(trips)
    if (!text) {
      toast('暂无行程可导出')
      return
    }
    this.setData({
      exportVisible: true,
      exportTitle: '行程备份文本',
      exportDescription: '已整理全部行程。可点击复制全部，也可长按下方文本手动选择。',
      exportText: text,
      exportCalendar: false,
      exportItemCount: trips.length,
    })
  },

  /** 系统日历没有小程序直接写入接口，只为已填写日期的行程生成可粘贴文本。 */
  onExportCalendar() {
    const trips = getTrips()
    const text = buildCalendarExportText(trips)
    if (!text) {
      toast('暂无已填写日期的行程')
      return
    }
    this.setData({
      exportVisible: true,
      exportTitle: '系统日历日程文本',
      exportDescription: '小程序无法直接写入系统日历。请复制后到系统日历新建日程并粘贴，也可长按下方文本手动选择。',
      exportText: text,
      exportCalendar: true,
      exportItemCount: trips.filter((trip) => /^\d{4}-\d{2}-\d{2}$/.test(trip.date)).length,
    })
  },

  onCloseExport() {
    this.setData({ exportVisible: false })
  },

  /**
   * 仅已有 cloud profile 才能生成快照；这里不调用 login()，因此不会新增授权或登录弹窗。
   * 本地匿名数据继续可用，只是暂不能跨设备分享。
   */
  onOpenShare() {
    if (!getTrips().length) {
      toast('先添加行程，再生成分享')
      return
    }
    const profile = getProfile()
    if (!profile?.cloud) {
      toast('云端同步后才能分享行程，不会弹出授权')
      return
    }
    this.setData({ shareVisible: true })
  },

  onCloseShare() {
    if (!this.data.sharePreparing) this.setData({ shareVisible: false })
  },

  noop() {},

  /** 备注和清单必须由用户分别勾选；生成后锁定选项，避免链接内容与界面选择不一致。 */
  onShareOptionsChange(e: WechatMiniprogram.CustomEvent<{ value: string[] }>) {
    if (this.data.shareId || this.data.sharePreparing) return
    const values = Array.isArray(e.detail.value) ? e.detail.value : []
    this.setData({
      shareIncludeNotes: values.includes('notes'),
      shareIncludeChecklist: values.includes('checklist'),
    })
  },

  async onCreateShare() {
    if (this.data.sharePreparing || this.data.shareId) return
    const profile = getProfile()
    if (!profile?.cloud) {
      toast('云端同步后才能分享行程')
      return
    }
    this.setData({ sharePreparing: true })
    try {
      // 先续接既有同步，再由服务端读取本账号行程；不绕过 baselineReady 或 revision 保护。
      const synced = await syncUserDataOnAppShow()
      const syncState = getSyncState()
      if (!synced || syncState.status === 'error' || syncState.status === 'waiting' || syncState.status === 'syncing') {
        toast('行程还未同步完成，请稍后重试')
        return
      }
      const snapshot = await createTripShare({
        includeNotes: this.data.shareIncludeNotes,
        includeChecklist: this.data.shareIncludeChecklist,
      })
      this.setData({ shareId: snapshot.shareId })
      wx.showShareMenu({ menus: ['shareAppMessage'] })
      toast('只读分享已生成')
    } catch (error) {
      const message = error instanceof Error ? error.message : '生成分享失败，请稍后重试'
      console.warn('[trips] 生成行程分享失败', error)
      toast(message)
    } finally {
      this.setData({ sharePreparing: false })
    }
  },

  onShareAppMessage() {
    reportEvent(ANALYTICS_EVENTS.SHARE_CLICK, { page: 'trips', action: 'friend', scene: 'trip_share' })
    const shareId = this.data.shareId
    return {
      title: '一起看看我的拾景行程',
      path: shareId
        ? `/packageExtra/pages/trip-share/index?id=${encodeURIComponent(shareId)}`
        : '/pages/trips/index',
    }
  },

  onRevokeShare() {
    const shareId = this.data.shareId
    if (!shareId) return
    wx.showModal({
      title: '撤销这次分享？',
      content: '撤销后，已经发出的链接会立即失效；原行程不会受到影响。',
      confirmText: '确认撤销',
      confirmColor: '#B0513B',
      success: async (result) => {
        if (!result.confirm) return
        try {
          await revokeTripShare(shareId)
          this.setData({
            shareId: '',
            shareIncludeNotes: false,
            shareIncludeChecklist: false,
            shareVisible: false,
          })
          wx.hideShareMenu()
          toast('分享已撤销')
        } catch (error) {
          const message = error instanceof Error ? error.message : '撤销失败，请稍后重试'
          console.warn('[trips] 撤销行程分享失败', error)
          toast(message)
        }
      },
    })
  },

  toHome() {
    wx.switchTab({ url: '/pages/home/index' })
  },
})
