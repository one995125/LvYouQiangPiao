/**
 * 景区资料纠错：只收集问题类型和说明，不要求手机号或其他联系方式。
 * 提交后由 shijingCorrection 云函数做 OpenID 隔离、限频和内容安全检查。
 */
import { CorrectionType, submitCorrection } from '../../../services/correction'

const TYPES: { key: CorrectionType; label: string }[] = [
  { key: 'channel', label: '官方渠道失效' },
  { key: 'price', label: '票价信息变化' },
  { key: 'opening', label: '开放时间变化' },
  { key: 'reservation', label: '预约规则变化' },
  { key: 'closed', label: '暂停开放/闭园' },
  { key: 'other', label: '其他问题' },
]

Page({
  data: {
    scenicId: '',
    scenicName: '',
    types: TYPES,
    type: 'channel' as CorrectionType,
    description: '',
    canSubmit: false,
    submitting: false,
    submitted: false,
  },

  onLoad(query: Record<string, string | undefined>) {
    this.setData({ scenicId: query.scenicId || '', scenicName: decodeURIComponent(query.scenicName || '') })
  },

  onType(e: WechatMiniprogram.TouchEvent) {
    this.setData({ type: e.currentTarget.dataset.key as CorrectionType })
  },

  onDescription(e: WechatMiniprogram.Input) {
    const description = e.detail.value
    this.setData({ description, canSubmit: description.trim().length >= 5 })
  },

  async onSubmit() {
    if (this.data.submitting) return
    const description = this.data.description.trim()
    if (description.length < 5) {
      wx.showToast({ title: '请至少填写 5 个字', icon: 'none' })
      return
    }
    this.setData({ submitting: true })
    try {
      await submitCorrection({
        scenicId: this.data.scenicId,
        scenicName: this.data.scenicName,
        type: this.data.type,
        description,
      })
      this.setData({ submitted: true })
    } catch (error) {
      const err = error as { message?: string }
      wx.showModal({ title: '提交失败', content: err.message || '请稍后再试', showCancel: false })
    } finally {
      this.setData({ submitting: false })
    }
  },

  onBack() {
    wx.navigateBack()
  },
})
