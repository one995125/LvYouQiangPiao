/** 编辑整理攻略详情：正文块、关联景区、个人收藏与静态内容分享。 */
import { GUIDE_CATEGORY_LABEL } from '../../../constants/enums'
import { ANALYTICS_EVENTS, durationBucket, reportEvent } from '../../../constants/analytics'
import { getProvince } from '../../../constants/provinces'
import { getGuide } from '../../../services/guide'
import { getScenic } from '../../../services/scenic'
import { isFavorite, subscribe, toggleFavorite } from '../../../stores/user-data'
import { Guide, Scenic } from '../../../types/index'
import { relativeTime } from '../../../utils/format'
import { toast, vibrate } from '../../../utils/page'

interface SyncPageInstance extends WechatMiniprogram.Page.TrivialInstance {
  unsubscribeUserData?: () => void
}

Page({
  data: {
    id: '',
    guide: null as Guide | null,
    scenic: null as Scenic | null,
    loading: true,
    notFound: false,
    catLabel: '',
    place: '',
    time: '',
    fav: false,
    solid: false,
  },

  onLoad(query: Record<string, string | undefined>) {
    const self = this as unknown as SyncPageInstance
    self.unsubscribeUserData = subscribe(() => {
      const guide = this.data.guide
      if (guide) this.setData({ fav: isFavorite('guide', guide._id) })
    })
    this.setData({ id: query.id || '' })
    this.load()
  },

  onUnload() {
    const self = this as unknown as SyncPageInstance
    if (self.unsubscribeUserData) self.unsubscribeUserData()
    self.unsubscribeUserData = undefined
  },

  onPageScroll(e: WechatMiniprogram.Page.IPageScrollOption) {
    const solid = e.scrollTop > 120
    if (solid !== this.data.solid) this.setData({ solid })
  },

  onShareAppMessage() {
    reportEvent(ANALYTICS_EVENTS.SHARE_CLICK, { page: 'guide_detail', action: 'friend', scene: 'guide' })
    const g = this.data.guide
    return { title: g ? g.title : '拾景攻略', path: `/packageExtra/pages/guide-detail/index?id=${encodeURIComponent(this.data.id)}` }
  },

  onShareTimeline() {
    reportEvent(ANALYTICS_EVENTS.SHARE_CLICK, { page: 'guide_detail', action: 'timeline', scene: 'guide' })
    const guide = this.data.guide
    return {
      title: guide ? `${guide.title} · 拾景攻略` : '拾景攻略',
      query: `id=${encodeURIComponent(this.data.id)}`,
    }
  },

  async load() {
    const startedAt = Date.now()
    const guide = await getGuide(this.data.id)
    if (!guide) {
      this.setData({ loading: false, notFound: true })
      reportEvent(ANALYTICS_EVENTS.GUIDE_OPEN, {
        page: 'guide_detail', action: 'open', scene: 'guide', result: 'not_found',
        duration_bucket: durationBucket(Date.now() - startedAt),
      })
      return
    }
    this.setData({
      guide,
      loading: false,
      catLabel: GUIDE_CATEGORY_LABEL[guide.category],
      place: guide.province ? getProvince(guide.province).name : '全国通用',
      time: relativeTime(guide.createdAt),
      fav: isFavorite('guide', guide._id),
    })
    reportEvent(ANALYTICS_EVENTS.GUIDE_OPEN, {
      page: 'guide_detail', action: 'open', scene: guide.category, result: 'success',
      duration_bucket: durationBucket(Date.now() - startedAt),
    })
    if (guide.scenicId) {
      const scenic = await getScenic(guide.scenicId)
      this.setData({ scenic })
    }
  },

  onFav() {
    const g = this.data.guide as Guide
    const fav = toggleFavorite({
      type: 'guide',
      targetId: g._id,
      title: g.title,
      subtitle: this.data.catLabel,
      tone: g.tone,
    })
    if (fav === null) {
      toast('收藏已达 500 条上限，请先整理')
      return
    }
    vibrate()
    this.setData({ fav })
    reportEvent(ANALYTICS_EVENTS.FAVORITE_TOGGLE, {
      page: 'guide_detail', action: fav ? 'add' : 'remove', scene: 'guide', result: 'success',
    })
    toast(fav ? '已收藏攻略' : '已取消收藏')
  },
})
