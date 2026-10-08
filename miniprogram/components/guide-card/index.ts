/** 攻略卡片 */
import { GUIDE_CATEGORY_LABEL } from '../../constants/enums'
import { getProvince } from '../../constants/provinces'
import { Guide } from '../../types/index'
import { relativeTime } from '../../utils/format'

Component({
  options: { styleIsolation: 'apply-shared' },
  properties: {
    guide: { type: Object, value: {} },
  },
  data: {
    catLabel: '',
    place: '',
    time: '',
  },
  observers: {
    guide(g: Guide) {
      if (!g || !g._id) return
      this.setData({
        catLabel: GUIDE_CATEGORY_LABEL[g.category] || '攻略',
        place: g.scenicName || (g.province ? getProvince(g.province).name : '全国通用'),
        time: relativeTime(g.createdAt),
      })
    },
  },
  methods: {
    onOpen() {
      wx.navigateTo({ url: `/packageExtra/pages/guide-detail/index?id=${(this.data.guide as Guide)._id}` })
    },
  },
})
