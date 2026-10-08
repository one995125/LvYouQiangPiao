/** 管理员景区列表。这里只展示云端真实文档，避免误将本地示例当作已发布资料。 */
import { checkAdmin, listAdminScenics, ScenicAdminSummary } from '../../../services/admin'

Page({
  data: {
    authorized: false,
    loading: true,
    error: '',
    keyword: '',
    list: [] as ScenicAdminSummary[],
    visible: [] as ScenicAdminSummary[],
    page: 0,
    hasMore: false,
  },

  async onLoad() {
    try {
      await checkAdmin()
      this.setData({ authorized: true })
      await this.load(true)
    } catch (error) {
      this.setData({ loading: false, error: (error as Error).message || '无法验证管理员身份' })
    }
  },

  onShow() {
    if (this.data.authorized && !this.data.loading) this.load(true)
  },

  onReachBottom() {
    if (this.data.authorized && this.data.hasMore && !this.data.loading) this.load(false)
  },

  onMore() {
    if (this.data.authorized && this.data.hasMore && !this.data.loading) this.load(false)
  },

  async load(reset: boolean) {
    if (this.data.loading && !reset) return
    const page = reset ? 0 : this.data.page
    this.setData({ loading: true, error: '' })
    try {
      const result = await listAdminScenics(page)
      const list = reset ? result.list : [...this.data.list, ...result.list]
      const keyword = this.data.keyword.trim().toLowerCase()
      this.setData({ list, visible: keyword ? list.filter((item) => `${item.name} ${item.city}`.toLowerCase().includes(keyword)) : list, page: page + 1, hasMore: result.hasMore })
    } catch (error) {
      this.setData({ error: (error as Error).message || '读取失败' })
    } finally {
      this.setData({ loading: false })
    }
  },

  onSearch(e: WechatMiniprogram.Input) {
    const keyword = e.detail.value.trim().toLowerCase()
    this.setData({ keyword: e.detail.value, visible: keyword ? this.data.list.filter((item) => `${item.name} ${item.city}`.toLowerCase().includes(keyword)) : this.data.list })
  },

  onEdit(e: WechatMiniprogram.TouchEvent) {
    const id = String(e.currentTarget.dataset.id || '')
    if (id) wx.navigateTo({ url: `/packageAdmin/pages/admin-editor/index?id=${encodeURIComponent(id)}` })
  },
})
