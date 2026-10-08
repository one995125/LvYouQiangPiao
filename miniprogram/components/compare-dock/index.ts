/** 景区对比浮动入口，选中 1-3 个景区时显示。 */
import { clearComparison, getCompareIds, subscribeComparison } from '../../stores/comparison'

interface CompareDockInstance extends WechatMiniprogram.Component.TrivialInstance {
  unsubscribeComparison?: () => void
}

Component({
  options: { styleIsolation: 'apply-shared' },
  properties: {
    tabbed: { type: Boolean, value: false },
  },
  data: { count: 0 },
  lifetimes: {
    attached() {
      const self = this as unknown as CompareDockInstance
      self.unsubscribeComparison = subscribeComparison(() => this.refresh())
      this.refresh()
    },
    detached() {
      const self = this as unknown as CompareDockInstance
      if (self.unsubscribeComparison) self.unsubscribeComparison()
      self.unsubscribeComparison = undefined
    },
  },
  pageLifetimes: {
    show() {
      this.refresh()
    },
  },
  methods: {
    refresh() {
      this.setData({ count: getCompareIds().length })
    },
    onGo() {
      if (this.data.count < 2) {
        wx.showToast({ title: '再选 1 个景区即可对比', icon: 'none' })
        return
      }
      wx.navigateTo({ url: '/packageExtra/pages/compare/index' })
    },
    onClear() {
      clearComparison()
    },
  },
})
