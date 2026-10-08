/**
 * 预约日期计算器：用户选择计划游玩日，根据景区已核录的提前天数生成建议预约日。
 * 组件不自行猜测规则；缺少 advanceDays 时显示“规则待补充”。
 */
import { Scenic } from '../../types/index'
import { toDateString } from '../../utils/format'
import { calculateReservationPlan, ReservationPlan } from '../../utils/reservation'

Component({
  options: { styleIsolation: 'apply-shared' },
  properties: {
    scenic: { type: Object, value: {} },
    initialDate: { type: String, value: '' },
  },
  data: {
    date: '',
    today: '',
    supported: false,
    plan: null as ReservationPlan | null,
  },
  observers: {
    'scenic, initialDate'(scenic: Scenic, initialDate: string) {
      if (!scenic || !scenic._id) return
      const supported = typeof scenic.reservation?.advanceDays === 'number'
      const date = initialDate || this.data.date
      this.setData({ supported, date, plan: date ? calculateReservationPlan(date, scenic.reservation) : null })
    },
  },
  lifetimes: {
    attached() {
      this.setData({ today: toDateString(new Date()) })
    },
  },
  methods: {
    onDate(e: WechatMiniprogram.PickerChange) {
      const date = e.detail.value as string
      const scenic = this.data.scenic as Scenic
      this.setData({ date, plan: calculateReservationPlan(date, scenic.reservation) })
      this.triggerEvent('datechange', { date })
    },
    onClear() {
      this.setData({ date: '', plan: null })
      this.triggerEvent('datechange', { date: '' })
    },
  },
})
