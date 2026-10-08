/**
 * 头像与昵称
 * 使用「头像昵称填写能力」：button open-type=chooseAvatar、input type=nickname（基础库 2.21.2+）
 * 昵称会经过微信侧内容安全检测；头像为临时文件，云端模式下上传至云存储。
 */
import { ensureLogin, updateProfile } from '../../../services/auth'
import { getProfile } from '../../../stores/user-data'
import { toast } from '../../../utils/page'

Page({
  data: {
    avatarUrl: '',
    nickName: '',
    saving: false,
  },

  async onLoad() {
    try {
      await ensureLogin()
    } catch (e) {
      toast('登录服务暂不可用，请稍后再试')
    }
    const p = getProfile()
    this.setData({ avatarUrl: (p && p.avatarUrl) || '', nickName: (p && p.nickName) || '' })
  },

  onChooseAvatar(e: WechatMiniprogram.CustomEvent<{ avatarUrl: string }>) {
    this.setData({ avatarUrl: e.detail.avatarUrl })
  },

  onNickInput(e: WechatMiniprogram.Input) {
    this.setData({ nickName: e.detail.value })
  },

  /** 选择微信昵称时通过 blur 回填 */
  onNickBlur(e: WechatMiniprogram.InputBlur) {
    this.setData({ nickName: e.detail.value })
  },

  async onSave() {
    const nickName = this.data.nickName.trim()
    if (!nickName) {
      toast('请填写昵称')
      return
    }
    this.setData({ saving: true })
    try {
      await updateProfile({ nickName, avatarUrl: this.data.avatarUrl })
      wx.showToast({ title: '已保存', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 700)
    } catch (e) {
      const err = e as { message?: string }
      toast(err.message || '保存失败')
    } finally {
      this.setData({ saving: false })
    }
  },
})
