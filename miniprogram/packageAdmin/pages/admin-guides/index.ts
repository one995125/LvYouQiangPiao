/** 管理员攻略列表：按草稿/已发布分别分页；普通用户无此入口，云函数仍独立校验身份。 */
import { listAdminGuides } from '../../../services/guide-admin'
import { Guide } from '../../../types/index'

Page({
  data: {
    status: 'pending' as 'pending' | 'approved',
    list: [] as Guide[], page: 0, hasMore: false,
    authorized: false, loading: false, error: '',
  },

  onShow() { this.load(true) },
  onReachBottom() { if (this.data.hasMore && !this.data.loading) this.load(false) },

  async load(reset: boolean) {
    if (this.data.loading) return
    const page = reset ? 0 : this.data.page
    this.setData({ loading: true, error: '' })
    try {
      const result = await listAdminGuides(this.data.status, page)
      this.setData({
        authorized: true,
        list: reset ? result.list : [...this.data.list, ...result.list],
        page: page + 1, hasMore: result.hasMore,
      })
    } catch (error) {
      this.setData({ authorized: false, error: (error as Error).message || '读取攻略失败' })
    } finally {
      this.setData({ loading: false })
    }
  },

  onTab(e: WechatMiniprogram.TouchEvent) {
    if (this.data.loading) return
    const status = e.currentTarget.dataset.status as 'pending' | 'approved'
    if (!['pending', 'approved'].includes(status) || status === this.data.status) return
    this.setData({ status, list: [], page: 0, hasMore: false })
    this.load(true)
  },

  onNew() { if (this.data.authorized) wx.navigateTo({ url: '/packageAdmin/pages/admin-guide-editor/index' }) },

  onRetry() { this.load(true) },
  onMore() { this.load(false) },

  onEdit(e: WechatMiniprogram.TouchEvent) {
    if (!this.data.authorized) return
    const id = String(e.currentTarget.dataset.id || '')
    if (id) wx.navigateTo({ url: `/packageAdmin/pages/admin-guide-editor/index?id=${encodeURIComponent(id)}` })
  },
})
