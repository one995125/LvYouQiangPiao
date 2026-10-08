/** 省份选择弹层：按地理大区分组，展示各省收录景区数 */
import { PROVINCES, REGIONS } from '../../constants/provinces'
import { provinceCounts } from '../../services/scenic'

interface Group {
  region: string
  items: { code: string; name: string; count: number }[]
}

Component({
  options: { styleIsolation: 'apply-shared' },
  properties: {
    visible: { type: Boolean, value: false },
    current: { type: String, value: '' },
  },
  data: { groups: [] as Group[] },
  lifetimes: {
    attached() {
      const counts = provinceCounts()
      const groups = REGIONS.map((region) => ({
        region,
        items: PROVINCES.filter((p) => p.region === region).map((p) => ({ code: p.code, name: p.name, count: counts[p.code] || 0 })),
      }))
      this.setData({ groups })
    },
  },
  methods: {
    onSelect(e: WechatMiniprogram.TouchEvent) {
      this.triggerEvent('select', { code: e.currentTarget.dataset.code as string })
    },
    onVisibleChange(e: WechatMiniprogram.CustomEvent<{ visible: boolean }>) {
      if (!e.detail.visible) this.triggerEvent('close')
    },
    onClose() {
      this.triggerEvent('close')
    },
  },
})
