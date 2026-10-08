/**
 * 纯文本导出预览弹层。
 * 文本始终支持长按选择；剪贴板失败时保留弹层并提示用户手动选择复制。
 */
import { ANALYTICS_EVENTS, reportEvent } from '../../constants/analytics'

Component({
  options: { styleIsolation: 'apply-shared' },
  properties: {
    visible: { type: Boolean, value: false },
    title: { type: String, value: '导出文本' },
    description: { type: String, value: '可点击复制全部，也可长按下方文本手动选择。' },
    text: { type: String, value: '' },
    calendar: { type: Boolean, value: false },
    /** 仅允许 favorites / trips / system_calendar 三种非隐私枚举。 */
    kind: { type: String, value: 'trips' },
    itemCount: { type: Number, value: 0 },
  },
  methods: {
    noop() {},
    onClose() {
      this.triggerEvent('close')
    },
    onCopy() {
      const data = String(this.data.text || '')
      if (!data) return
      wx.setClipboardData({
        data,
        success: () => {
          const eventName = this.data.calendar ? ANALYTICS_EVENTS.CALENDAR_COPY : ANALYTICS_EVENTS.DATA_EXPORT
          reportEvent(eventName, {
            page: this.data.kind === 'favorites' ? 'favorites' : 'trips',
            action: 'copy', scene: this.data.kind, result: 'success', item_count: this.data.itemCount,
          })
          if (this.data.calendar) {
            wx.showModal({
              title: '日程文本已复制',
              content: '小程序无法直接写入系统日历，请到系统日历新建日程后粘贴。',
              showCancel: false,
              confirmText: '知道了',
              confirmColor: '#2F5A51',
            })
          } else {
            wx.showToast({ title: '备份文本已复制', icon: 'none' })
          }
        },
        fail: () => {
          const eventName = this.data.calendar ? ANALYTICS_EVENTS.CALENDAR_COPY : ANALYTICS_EVENTS.DATA_EXPORT
          reportEvent(eventName, {
            page: this.data.kind === 'favorites' ? 'favorites' : 'trips',
            action: 'copy', scene: this.data.kind, result: 'failed', item_count: this.data.itemCount,
          })
          wx.showModal({
            title: '复制失败',
            content: '请长按下方文本手动选择并复制。',
            showCancel: false,
            confirmText: '知道了',
            confirmColor: '#2F5A51',
          })
        },
      })
    },
  },
})
