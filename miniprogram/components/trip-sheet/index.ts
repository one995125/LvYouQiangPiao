/**
 * 加入 / 编辑行程弹层
 * 用户未必当天抢到票，行程条目保存放票规则与官方入口，便于反复回来抢票。
 */
import { TRIP_STATUS } from '../../constants/enums'
import { ANALYTICS_EVENTS, reportEvent } from '../../constants/analytics'
import { requestAndRegisterTripReminder } from '../../services/reminder'
import { getWeatherForScenic, rememberWeatherDestination, WeatherInfo } from '../../services/weather'
import { saveTrip } from '../../stores/user-data'
import { Scenic, TripItem, TripPeriod, TripStatus } from '../../types/index'
import { toDateString } from '../../utils/format'
import { calculateReservationPlan, ReservationPlan } from '../../utils/reservation'
import { toast, vibrate } from '../../utils/page'

const STATUS_LIST = (Object.keys(TRIP_STATUS) as TripStatus[]).map((key) => ({ key, label: TRIP_STATUS[key].label }))
const PERIOD_LIST: { key: TripPeriod; label: string }[] = [
  { key: 'all', label: '全天' },
  { key: 'morning', label: '上午' },
  { key: 'afternoon', label: '下午' },
  { key: 'evening', label: '晚上' },
]
const CHECKLIST_OPTIONS = ['身份证件', '预约凭证', '充电宝', '饮用水', '防晒用品', '雨具']
/** 每次地点或日期变化都递增令牌，避免较早的异步天气结果覆盖当前内容。 */
const WEATHER_REQUEST_TOKENS = new WeakMap<object, number>()

Component({
  options: { styleIsolation: 'apply-shared' },
  properties: {
    visible: { type: Boolean, value: false },
    scenic: { type: Object, value: {} },
    /** 传入则为编辑模式 */
    trip: { type: Object, value: {} },
  },
  data: {
    date: '',
    period: 'all' as TripPeriod,
    status: 'pending' as TripStatus,
    note: '',
    checklist: [] as string[],
    checklistOptions: CHECKLIST_OPTIONS.map((label) => ({ label, selected: false })),
    reservationPlan: null as ReservationPlan | null,
    weather: null as WeatherInfo | null,
    today: '',
    statusList: STATUS_LIST,
    periodList: PERIOD_LIST,
    editing: false,
  },
  observers: {
    visible(v: boolean) {
      if (!v) {
        WEATHER_REQUEST_TOKENS.set(this, (WEATHER_REQUEST_TOKENS.get(this) || 0) + 1)
        if (this.data.weather) this.setData({ weather: null })
        return
      }
      const t = this.data.trip as TripItem
      const editing = !!(t && t.id)
      this.setData({
        today: toDateString(new Date()),
        editing,
        date: editing ? t.date : '',
        period: editing ? t.period || 'all' : 'all',
        status: editing ? t.status : 'pending',
        note: editing ? t.note : '',
        checklist: editing && Array.isArray(t.checklist) ? t.checklist : [],
        checklistOptions: CHECKLIST_OPTIONS.map((label) => ({ label, selected: !!(editing && t.checklist?.includes(label)) })),
        reservationPlan: editing && t.date ? calculateReservationPlan(t.date, (this.data.scenic as Scenic).reservation) : null,
        weather: null,
      }, () => void this.loadWeather(editing ? t.date : ''))
    },
  },
  methods: {
    /** 天气始终在行程主体完成渲染后加载；失败时保持 weather=null，不展示错误区域。 */
    async loadWeather(date: string) {
      const token = (WEATHER_REQUEST_TOKENS.get(this) || 0) + 1
      WEATHER_REQUEST_TOKENS.set(this, token)
      try {
        const weather = await getWeatherForScenic(this.data.scenic as Scenic, date)
        if (!this.data.visible || WEATHER_REQUEST_TOKENS.get(this) !== token) return
        this.setData({ weather })
      } catch (_) {
        // service 已静默降级；此处再兜底，绝不打断弹层编辑与保存。
      }
    },
    onDate(e: WechatMiniprogram.PickerChange) {
      const date = e.detail.value as string
      const scenic = this.data.scenic as Scenic
      this.setData({ date, reservationPlan: calculateReservationPlan(date, scenic.reservation), weather: null }, () => {
        void this.loadWeather(date)
      })
    },
    onClearDate() {
      this.setData({ date: '', reservationPlan: null, weather: null }, () => void this.loadWeather(''))
    },
    onPeriod(e: WechatMiniprogram.TouchEvent) {
      this.setData({ period: e.currentTarget.dataset.key as TripPeriod })
    },
    onStatus(e: WechatMiniprogram.TouchEvent) {
      this.setData({ status: e.currentTarget.dataset.key as TripStatus })
    },
    onNote(e: WechatMiniprogram.Input) {
      this.setData({ note: e.detail.value })
    },
    onChecklist(e: WechatMiniprogram.TouchEvent) {
      const label = e.currentTarget.dataset.label as string
      const checklist = this.data.checklist.includes(label)
        ? this.data.checklist.filter((item) => item !== label)
        : [...this.data.checklist, label]
      this.setData({
        checklist,
        checklistOptions: CHECKLIST_OPTIONS.map((item) => ({ label: item, selected: checklist.includes(item) })),
      })
    },
    onSave() {
      const scenic = this.data.scenic as Scenic
      if (!scenic || !scenic._id) return
      // 地点快照独立于行程同步数据保存，避免给 v2 协议增加云端会剥离的新字段。
      rememberWeatherDestination(scenic)
      const t = this.data.trip as TripItem
      const trip = saveTrip({
        scenic,
        id: t && t.id ? t.id : undefined,
        date: this.data.date,
        period: this.data.period,
        status: this.data.status,
        note: this.data.note.trim(),
        checklist: this.data.checklist,
      })
      const preparationCount = this.data.checklist.length
      reportEvent(ANALYTICS_EVENTS.TRIP_SAVE, {
        page: 'trip_sheet', action: this.data.editing ? 'update' : 'create', scene: this.data.status,
        result: 'success', item_count: preparationCount,
      })
      // 必须紧跟用户点击保存触发订阅授权；任何授权或云端登记失败都不会阻断以下原有流程。
      void requestAndRegisterTripReminder(trip, scenic)
      vibrate()
      toast(this.data.editing ? '行程已更新' : '已加入我的行程')
      this.triggerEvent('saved', { trip })
      this.triggerEvent('close')
    },
    onVisibleChange(e: WechatMiniprogram.CustomEvent<{ visible: boolean }>) {
      if (!e.detail.visible) this.triggerEvent('close')
    },
  },
})
