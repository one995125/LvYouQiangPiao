/** 攻略页：只展示拾景整理的游玩攻略 / 避雷 / 抢票信息，不提供用户投稿入口。 */
import { DEFAULT_PROVINCE, STORAGE_KEYS } from '../../constants/config'
import { ANALYTICS_EVENTS, durationBucket, reportEvent } from '../../constants/analytics'
import { GUIDE_CATEGORIES } from '../../constants/enums'
import { getProvince } from '../../constants/provinces'
import { listGuides, listGuideTags } from '../../services/guide'
import { Guide, GuideCategory } from '../../types/index'

interface GuidesPageInstance extends WechatMiniprogram.Page.TrivialInstance {
  searchTimer?: number
  requestSequence?: number
}

const historyOf = (): string[] => {
  const raw = wx.getStorageSync(STORAGE_KEYS.guideSearchHistory)
  return Array.isArray(raw) ? raw.filter((item) => typeof item === 'string' && item.trim()).slice(0, 8) : []
}

const emptyCopy = (keyword: string, tag: string, scopeLocal: boolean, provinceName: string) => {
  if (keyword || tag) {
    const conditions = [keyword ? `“${keyword}”` : '', tag ? `#${tag}` : ''].filter(Boolean).join(' · ')
    return { title: '没有找到相关攻略', desc: `${conditions} 暂无匹配内容，试试更短的关键词或其他标签` }
  }
  return {
    title: '暂时还没有内容',
    desc: `${scopeLocal ? provinceName : '当前分类'}的资料正在整理中`,
  }
}

Page({
  data: {
    categories: GUIDE_CATEGORIES,
    category: 'all' as GuideCategory | 'all',
    scopeLocal: false,
    province: DEFAULT_PROVINCE,
    provinceName: '',
    list: [] as Guide[],
    page: 0,
    hasMore: false,
    loading: true,
    loadingMore: false,
    loadError: false,
    loadMoreError: false,
    solid: false,
    keyword: '',
    /** 实际传给云端的关键词；输入中的临时文本需经过 300ms 防抖才更新。 */
    appliedKeyword: '',
    tag: '',
    tagOptions: [] as string[],
    history: [] as string[],
    initialized: false,
    emptyTitle: '暂时还没有内容',
    emptyDesc: '当前分类的资料正在整理中',
    /** 从朋友圈深链进入时固定本次页面省份，不影响普通入口读取用户当前省份。 */
    sharedProvince: '',
  },

  onLoad(query: Record<string, string | undefined>) {
    const requestedCategory = String(query.category || 'all') as GuideCategory | 'all'
    const category = GUIDE_CATEGORIES.some((item) => item.key === requestedCategory) ? requestedCategory : 'all'
    const scopeLocal = query.scope === 'local'
    const sharedProvince = scopeLocal && query.province ? getProvince(query.province).code : ''
    const keyword = String(query.keyword || '').trim().slice(0, 40)
    const tag = String(query.tag || '').trim().slice(0, 16)
    this.setData({ category, scopeLocal, sharedProvince, keyword, appliedKeyword: keyword, tag, history: historyOf() })
    void this.loadTags()
  },

  onShow() {
    const code = this.data.sharedProvince || (wx.getStorageSync(STORAGE_KEYS.province) as string) || DEFAULT_PROVINCE
    const changed = code !== this.data.province
    this.setData({ province: code, provinceName: getProvince(code).name })
    if (changed || !this.data.initialized) {
      this.load(true)
    }
  },

  onUnload() {
    const self = this as unknown as GuidesPageInstance
    if (self.searchTimer) clearTimeout(self.searchTimer)
    self.searchTimer = undefined
    self.requestSequence = (self.requestSequence || 0) + 1
  },

  onPullDownRefresh() {
    this.load(true).then(() => wx.stopPullDownRefresh())
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loadingMore && !this.data.loadMoreError) this.load(false)
  },

  onPageScroll(e: WechatMiniprogram.Page.IPageScrollOption) {
    const solid = e.scrollTop > 60
    if (solid !== this.data.solid) this.setData({ solid })
  },

  onShareAppMessage() {
    reportEvent(ANALYTICS_EVENTS.SHARE_CLICK, { page: 'guides', action: 'friend', scene: 'guide_list' })
    const query = this.shareQuery()
    return { title: '景区攻略与避雷清单 · 拾景', path: `/pages/guides/index?${query}` }
  },

  onShareTimeline() {
    reportEvent(ANALYTICS_EVENTS.SHARE_CLICK, { page: 'guides', action: 'timeline', scene: 'guide_list' })
    const category = GUIDE_CATEGORIES.find((item) => item.key === this.data.category)
    const scope = this.data.scopeLocal ? this.data.provinceName : '全国'
    return {
      title: `${scope} · ${category?.label || '景区攻略'} · 拾景`,
      query: this.shareQuery(),
    }
  },

  shareQuery(): string {
    return [
      `category=${encodeURIComponent(this.data.category)}`,
      `scope=${this.data.scopeLocal ? 'local' : 'all'}`,
      `province=${encodeURIComponent(this.data.province)}`,
      `keyword=${encodeURIComponent(this.data.appliedKeyword)}`,
      `tag=${encodeURIComponent(this.data.tag)}`,
    ].join('&')
  },

  /** 标签读取失败时只隐藏筛选条，攻略正文列表仍按原路径加载。 */
  async loadTags() {
    const tags = await listGuideTags()
    const tagOptions = this.data.tag && !tags.includes(this.data.tag) ? [this.data.tag, ...tags] : tags
    this.setData({ tagOptions })
  },

  async load(reset: boolean) {
    const startedAt = Date.now()
    const page = reset ? 0 : this.data.page + 1
    const self = this as unknown as GuidesPageInstance
    const requestSequence = (self.requestSequence || 0) + 1
    self.requestSequence = requestSequence
    this.setData(reset
      ? { loading: true, loadError: false, loadMoreError: false }
      : { loadingMore: true, loadMoreError: false })
    const res = await listGuides({
      category: this.data.category,
      province: this.data.scopeLocal ? this.data.province : undefined,
      keyword: this.data.appliedKeyword,
      tag: this.data.tag,
      page,
    })
    // 用户连续输入或快速切换标签时，旧请求不得覆盖较新的筛选结果。
    if (self.requestSequence !== requestSequence) return
    if (res.unavailable) {
      // 云端故障与“当前分类没有内容”是不同状态，避免把旧资料当作兜底重新显示。
      this.setData(reset
        ? { list: [], hasMore: false, loading: false, loadError: true, initialized: true }
        : { loadingMore: false, loadMoreError: true })
      if (reset && (this.data.appliedKeyword || this.data.tag)) {
        const queryLength = this.data.appliedKeyword.length
        reportEvent(ANALYTICS_EVENTS.GUIDE_SEARCH, {
          page: 'guides', action: 'search',
          scene: queryLength && this.data.tag ? 'keyword_tag' : queryLength ? 'keyword' : 'tag',
          result: 'unavailable', item_count: 0, query_length: queryLength, hit: false,
          tag_selected: Boolean(this.data.tag), duration_bucket: durationBucket(Date.now() - startedAt),
        })
      }
      return
    }
    const copy = emptyCopy(this.data.appliedKeyword, this.data.tag, this.data.scopeLocal, this.data.provinceName)
    this.setData({
      list: reset ? res.list : [...this.data.list, ...res.list],
      page,
      hasMore: res.hasMore,
      loading: false,
      loadingMore: false,
      loadError: false,
      loadMoreError: false,
      initialized: true,
      emptyTitle: copy.title,
      emptyDesc: copy.desc,
    })
    if (reset && (this.data.appliedKeyword || this.data.tag)) {
      const queryLength = this.data.appliedKeyword.length
      reportEvent(ANALYTICS_EVENTS.GUIDE_SEARCH, {
        page: 'guides', action: 'search',
        scene: queryLength && this.data.tag ? 'keyword_tag' : queryLength ? 'keyword' : 'tag',
        result: 'success', item_count: res.list.length, query_length: queryLength, hit: res.list.length > 0,
        tag_selected: Boolean(this.data.tag), duration_bucket: durationBucket(Date.now() - startedAt),
      })
    }
  },

  onRetry() {
    this.load(true)
  },

  onRetryMore() {
    this.load(false)
  },

  onCategory(e: WechatMiniprogram.TouchEvent) {
    const category = e.currentTarget.dataset.key as GuideCategory | 'all'
    if (category === this.data.category) return
    this.setData({ category })
    this.load(true)
  },

  onScope(e: WechatMiniprogram.TouchEvent) {
    const scopeLocal = e.currentTarget.dataset.local === '1'
    if (scopeLocal === this.data.scopeLocal) return
    this.setData({ scopeLocal })
    this.load(true)
  },

  /** 输入停止 300ms 后才查询，避免每个字符都触发云函数。 */
  onSearchInput(e: WechatMiniprogram.Input) {
    const keyword = e.detail.value
    const self = this as unknown as GuidesPageInstance
    this.setData({ keyword })
    if (self.searchTimer) clearTimeout(self.searchTimer)
    self.searchTimer = setTimeout(() => {
      self.searchTimer = undefined
      this.applyKeyword(keyword, false)
    }, 300) as unknown as number
  },

  onSearchConfirm() {
    const self = this as unknown as GuidesPageInstance
    if (self.searchTimer) clearTimeout(self.searchTimer)
    self.searchTimer = undefined
    this.applyKeyword(this.data.keyword, true)
  },

  onHistory(e: WechatMiniprogram.TouchEvent) {
    const keyword = String(e.currentTarget.dataset.keyword || '')
    this.setData({ keyword })
    this.applyKeyword(keyword, true)
  },

  applyKeyword(value: string, remember: boolean) {
    const keyword = String(value || '').trim().slice(0, 40)
    if (remember && keyword) {
      const history = [keyword, ...this.data.history.filter((item) => item !== keyword)].slice(0, 8)
      wx.setStorageSync(STORAGE_KEYS.guideSearchHistory, history)
      this.setData({ history })
    }
    if (keyword === this.data.appliedKeyword) return
    this.setData({ appliedKeyword: keyword })
    this.load(true)
  },

  onClearSearch() {
    const self = this as unknown as GuidesPageInstance
    if (self.searchTimer) clearTimeout(self.searchTimer)
    self.searchTimer = undefined
    const changed = Boolean(this.data.keyword || this.data.appliedKeyword)
    this.setData({ keyword: '', appliedKeyword: '' })
    if (changed) this.load(true)
  },

  onClearHistory() {
    wx.removeStorageSync(STORAGE_KEYS.guideSearchHistory)
    this.setData({ history: [] })
  },

  onTagFilter(e: WechatMiniprogram.TouchEvent) {
    const selected = String(e.currentTarget.dataset.tag || '')
    const tag = selected === this.data.tag ? '' : selected
    if (tag === this.data.tag) return
    this.setData({ tag })
    this.load(true)
  },

})
