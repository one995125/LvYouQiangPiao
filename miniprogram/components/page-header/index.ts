/**
 * 自定义导航头
 * - overlay：浮于内容之上（沉浸式封面页），不占位
 * - solid：滚动后显示纸色毛玻璃背景，由页面根据 onPageScroll 传入
 * - theme：light 用于深色封面上的白色图标
 */
import { getNavMetrics } from '../../utils/page'

Component({
  options: { styleIsolation: 'apply-shared', multipleSlots: true },
  properties: {
    title: { type: String, value: '' },
    back: { type: Boolean, value: false },
    overlay: { type: Boolean, value: false },
    solid: { type: Boolean, value: true },
    theme: { type: String, value: 'dark' },
  },
  data: {
    statusBar: 20,
    navHeight: 44,
    menuRight: 100,
  },
  lifetimes: {
    attached() {
      const m = getNavMetrics()
      this.setData({ statusBar: m.statusBar, navHeight: m.navHeight, menuRight: m.menuRight })
    },
  },
  methods: {
    onBack() {
      if (getCurrentPages().length > 1) wx.navigateBack()
      else wx.switchTab({ url: '/pages/home/index' })
    },
  },
})
