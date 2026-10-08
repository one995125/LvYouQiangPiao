/** 搜索：景区名 / 城市，保留最近搜索，空态展示全国热门 */
import { STORAGE_KEYS } from '../../../constants/config'
import { hotScenics, searchScenics } from '../../../services/scenic'
import { Scenic } from '../../../types/index'

let timer: number | null = null

Page({
  data: {
    keyword: '',
    history: [] as string[],
    hot: [] as Scenic[],
    results: [] as Scenic[],
    searched: false,
    loading: false,
    quickTags: ['免费', '世界遗产', '古建', '博物馆', '山岳', '古镇'],
  },

  onLoad() {
    this.setData({
      history: wx.getStorageSync(STORAGE_KEYS.searchHistory) || [],
      hot: hotScenics(8),
    })
  },

  onInput(e: WechatMiniprogram.Input) {
    const keyword = e.detail.value
    this.setData({ keyword })
    if (timer) clearTimeout(timer)
    if (!keyword.trim()) {
      this.setData({ results: [], searched: false })
      return
    }
    timer = setTimeout(() => this.run(keyword, false), 300) as unknown as number
  },

  onConfirm() {
    this.run(this.data.keyword, true)
  },

  onTag(e: WechatMiniprogram.TouchEvent) {
    const keyword = e.currentTarget.dataset.kw as string
    this.setData({ keyword })
    this.run(keyword, true)
  },

  onClearInput() {
    this.setData({ keyword: '', results: [], searched: false })
  },

  onClearHistory() {
    wx.removeStorageSync(STORAGE_KEYS.searchHistory)
    this.setData({ history: [] })
  },

  async run(keyword: string, remember: boolean) {
    const kw = keyword.trim()
    if (!kw) return
    this.setData({ loading: true })
    const results = await searchScenics(kw)
    this.setData({ results, searched: true, loading: false })
    if (remember) {
      const history = [kw, ...this.data.history.filter((h) => h !== kw)].slice(0, 10)
      wx.setStorageSync(STORAGE_KEYS.searchHistory, history)
      this.setData({ history })
    }
  },
})
