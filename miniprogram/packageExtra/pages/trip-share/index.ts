/** 同行人只读查看页：只消费云端白名单快照，不提供任何编辑或写回入口。 */
import { TRIP_STATUS } from '../../../constants/enums'
import { ANALYTICS_EVENTS, reportEvent } from '../../../constants/analytics'
import { getTripShare } from '../../../services/trip-share'
import { CloudError } from '../../../services/cloud'
import { reportClientError } from '../../../services/error-monitor'
import { TripPeriod, TripShareItem, TripShareSnapshot } from '../../../types/index'

interface TripShareView extends TripShareItem {
  periodLabel: string
  statusLabel: string
  checklistText: string
}

const PERIOD_LABEL: Record<TripPeriod, string> = {
  all: '全天',
  morning: '上午',
  afternoon: '下午',
  evening: '晚上',
}

const toView = (item: TripShareItem): TripShareView => ({
  ...item,
  periodLabel: PERIOD_LABEL[item.period] || PERIOD_LABEL.all,
  statusLabel: TRIP_STATUS[item.status]?.label || TRIP_STATUS.pending.label,
  checklistText: Array.isArray(item.checklist) ? item.checklist.join(' · ') : '',
})

const formatGeneratedAt = (timestamp: number): string => {
  if (!timestamp) return ''
  const date = new Date(timestamp)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

Page({
  data: {
    shareId: '',
    loading: true,
    unavailable: false,
    trips: [] as TripShareView[],
    createdLabel: '',
  },

  onLoad(query: Record<string, string | undefined>) {
    const shareId = String(query.id || '').trim()
    // 只有快照确认有效后才开放再次转发，避免失效链接继续传播。
    wx.hideShareMenu()
    this.setData({ shareId })
    void this.loadShare()
  },

  onShareAppMessage() {
    reportEvent(ANALYTICS_EVENTS.SHARE_CLICK, { page: 'trip_share', action: 'friend', scene: 'trip_snapshot' })
    return {
      title: '一起看看这份拾景行程',
      path: `/packageExtra/pages/trip-share/index?id=${encodeURIComponent(this.data.shareId)}`,
    }
  },

  onShareTimeline() {
    reportEvent(ANALYTICS_EVENTS.SHARE_CLICK, { page: 'trip_share', action: 'timeline', scene: 'trip_snapshot' })
    return {
      title: '一起看看这份拾景行程',
      query: `id=${encodeURIComponent(this.data.shareId)}`,
    }
  },

  async loadShare() {
    if (!/^[a-f0-9]{48}$/.test(this.data.shareId)) {
      this.setData({ loading: false, unavailable: true })
      return
    }
    this.setData({ loading: true, unavailable: false })
    try {
      const snapshot: TripShareSnapshot = await getTripShare(this.data.shareId)
      const trips = snapshot.trips
        .slice()
        .sort((a, b) => (a.date || '9999-99-99').localeCompare(b.date || '9999-99-99'))
        .map(toView)
      this.setData({
        loading: false,
        unavailable: false,
        trips,
        createdLabel: formatGeneratedAt(snapshot.createdAt),
      })
      wx.showShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] })
    } catch (error) {
      if (!(error instanceof CloudError) || error.code !== 'SHARE_UNAVAILABLE') {
        console.warn('[trip-share] 只读快照加载失败', error)
        void reportClientError('page_error', error, 'trip_share')
      }
      this.setData({ loading: false, unavailable: true, trips: [], createdLabel: '' })
    }
  },
})
