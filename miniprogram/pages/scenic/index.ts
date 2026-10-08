/**
 * 景区详情：数据指标、放票规则、攻略要点、避雷，底部固定「收藏 / 行程 / 官方购票」
 */
import { getProvince } from '../../constants/provinces'
import { ANALYTICS_EVENTS, durationBucket, reportEvent } from '../../constants/analytics'
import { listGuides } from '../../services/guide'
import { getScenic } from '../../services/scenic'
import {
  canJump,
  copyableEntryText,
  isChannelExpired,
  isCurrentVerified,
  officialEntriesOf,
  officialEntryPurposeLabel,
  openTicket,
  ticketActionLabel,
} from '../../services/ticket'
import {
  favoriteFromScenic,
  findTripByScenic,
  getScenicMarkState,
  isFavorite,
  recordFootprint,
  subscribe,
  toggleFavorite,
  toggleScenicMark,
} from '../../stores/user-data'
import { Guide, OfficialEntry, Scenic, ScenicSource, TripItem } from '../../types/index'
import { formatPrice, formatVisitors, toDateString } from '../../utils/format'
import { isValidScenicLocation } from '../../utils/location'
import { toast, vibrate } from '../../utils/page'
import { activeNoticeViews, ScenicNoticeView } from '../../utils/notice'
import { createScenicSharePoster, isAlbumPermissionDenied, saveSharePoster } from '../../utils/share-poster'
import { isPastValidUntil } from '../../utils/validity'

interface SyncPageInstance extends WechatMiniprogram.Page.TrivialInstance {
  unsubscribeUserData?: () => void
  sharePosterPromise?: Promise<string>
}

interface InfoRow {
  key: string
  value: string
}

interface OfficialEntryView extends OfficialEntry {
  purposeLabel: string
  actionLabel: string
  jumpable: boolean
  currentVerified: boolean
  expired: boolean
}

interface ScenicSourceView extends ScenicSource {
  meta: string
  expired: boolean
}

/** 只展示运营人员明确录入的结构化规则，不从文案中猜测。 */
function buildBookingRows(scenic: Scenic): InfoRow[] {
  const rule = scenic.reservation
  const rows: InfoRow[] = []
  if (rule) {
    if (typeof rule.required === 'boolean') rows.push({ key: '预约要求', value: rule.required ? '需要提前预约' : '无需提前预约' })
    if (typeof rule.advanceDays === 'number') rows.push({ key: '提前时间', value: `建议提前 ${rule.advanceDays} 天` })
    if (rule.releaseTime) rows.push({ key: '开放时间', value: rule.releaseTime })
    if (typeof rule.realName === 'boolean') rows.push({ key: '实名要求', value: rule.realName ? '需实名预约' : '不要求实名' })
    if (rule.documents?.length) rows.push({ key: '入园证件', value: rule.documents.join('、') })
    if (typeof rule.timeSlotRequired === 'boolean') rows.push({ key: '入园时段', value: rule.timeSlotRequired ? '需按预约时段入园' : '无需选择入园时段' })
    if (rule.refundRule) rows.push({ key: '退改说明', value: rule.refundRule })
    if (rule.audienceRule) rows.push({ key: '特殊人群', value: rule.audienceRule })
    if (rule.note) rows.push({ key: '补充说明', value: rule.note })
  }
  if (!rows.length) rows.push({ key: '预约说明', value: scenic.booking || '以景区官方公告为准' })
  return rows
}

function buildSourceViews(sources: ScenicSource[] | undefined): ScenicSourceView[] {
  return (sources || []).map((source) => {
    const expired = isPastValidUntil(source.validUntil)
    return {
      ...source,
      expired,
      meta: [source.checkedAt ? `核验 ${source.checkedAt}` : '', source.validUntil ? `${expired ? '有效期已过' : '有效至'} ${source.validUntil}` : ''].filter(Boolean).join(' · '),
    }
  })
}

Page({
  data: {
    id: '',
    scenic: null as Scenic | null,
    loading: true,
    notFound: false,
    provinceName: '',
    stats: [] as { k: string; v: string; unit: string }[],
    officialEntries: [] as OfficialEntryView[],
    bookingRows: [] as InfoRow[],
    sourceList: [] as ScenicSourceView[],
    sourceSummary: '',
    notices: [] as ScenicNoticeView[],
    ticketLabel: '',
    jumpable: false,
    fav: false,
    visited: false,
    wish: false,
    trip: null as TripItem | null,
    guides: [] as Guide[],
    solid: false,
    sheetVisible: false,
    verificationDay: '',
    hasLocation: false,
    locationAddress: '',
    shareImageUrl: '',
    posterGenerating: false,
  },

  onLoad(query: Record<string, string | undefined>) {
    const self = this as unknown as SyncPageInstance
    self.unsubscribeUserData = subscribe(() => {
      if (this.data.scenic) this.refreshMarks()
    })
    this.setData({ id: query.id || '' })
    this.load()
  },

  onUnload() {
    const self = this as unknown as SyncPageInstance
    if (self.unsubscribeUserData) self.unsubscribeUserData()
    self.unsubscribeUserData = undefined
  },

  onShow() {
    if (this.data.scenic) this.refreshMarks()
    // 跨过午夜后按新的自然日重算有效期；避免留在页面上的旧“已核验”标签。
    if (this.data.scenic && this.data.verificationDay !== toDateString(new Date())) void this.load()
  },

  onPageScroll(e: WechatMiniprogram.Page.IPageScrollOption) {
    const solid = e.scrollTop > 220
    if (solid !== this.data.solid) this.setData({ solid })
  },

  onShareAppMessage() {
    reportEvent(ANALYTICS_EVENTS.SHARE_CLICK, { page: 'scenic', action: 'friend', scene: 'scenic' })
    const s = this.data.scenic
    const result: { title: string; path: string; imageUrl?: string } = {
      title: s ? `${s.name} · 官方购票入口与避雷攻略` : '拾景',
      path: `/pages/scenic/index?id=${encodeURIComponent(this.data.id)}`,
    }
    if (this.data.shareImageUrl) result.imageUrl = this.data.shareImageUrl
    return result
  },

  /** 朋友圈只能通过 query 恢复当前页面，不能自定义 path。 */
  onShareTimeline() {
    reportEvent(ANALYTICS_EVENTS.SHARE_CLICK, { page: 'scenic', action: 'timeline', scene: 'scenic' })
    const scenic = this.data.scenic
    const result: { title: string; query: string; imageUrl?: string } = {
      title: scenic ? `${scenic.name} · 景区资料与官方渠道` : '拾景 · 景区资料',
      query: `id=${encodeURIComponent(this.data.id)}`,
    }
    if (this.data.shareImageUrl) result.imageUrl = this.data.shareImageUrl
    return result
  },

  async load() {
    const startedAt = Date.now()
    const scenic = await getScenic(this.data.id)
    if (!scenic) {
      this.setData({ loading: false, notFound: true })
      reportEvent(ANALYTICS_EVENTS.SCENIC_OPEN, {
        page: 'scenic', action: 'open', scene: 'detail', result: 'not_found',
        duration_bucket: durationBucket(Date.now() - startedAt),
      })
      return
    }
    const visitors = formatVisitors(scenic.visitors).split(' ')
    const officialEntries = officialEntriesOf(scenic).map<OfficialEntryView>((entry) => ({
      ...entry,
      purposeLabel: officialEntryPurposeLabel(entry.purpose),
      actionLabel: ticketActionLabel(entry),
      jumpable: canJump(entry),
      currentVerified: isCurrentVerified(entry),
      expired: isChannelExpired(entry),
    }))
    const sourceList = buildSourceViews(scenic.sources)
    const provinceName = getProvince(scenic.province).name
    const verifiedCount = officialEntries.filter((entry) => entry.currentVerified).length
    const expiredCount = officialEntries.filter((entry) => entry.expired).length
    // 仅在景区资料成功读取后记录；此时页面数据尚未 setData，可避免足迹事件触发重复标记刷新。
    recordFootprint(scenic)
    this.setData({
      scenic,
      loading: false,
      provinceName,
      stats: [
        { k: '年接待', v: visitors[0], unit: visitors[1] || '' },
        { k: '口碑', v: scenic.rating.toFixed(1), unit: '/5' },
        { k: '旺季门票', v: formatPrice(scenic.price), unit: '' },
        { k: '热度', v: `${scenic.heat}`, unit: '' },
      ],
      officialEntries,
      bookingRows: buildBookingRows(scenic),
      sourceList,
      sourceSummary: sourceList.length
        ? `${sourceList.length} 个资料来源 · ${verifiedCount}/${officialEntries.length} 个渠道当前已核验${expiredCount ? ` · ${expiredCount} 个核验已过期` : ''}`
        : `资料来源待补充 · ${verifiedCount}/${officialEntries.length} 个渠道当前已核验${expiredCount ? ` · ${expiredCount} 个核验已过期` : ''}`,
      notices: activeNoticeViews(scenic.notices),
      ticketLabel: officialEntries.length > 1 ? `查看 ${officialEntries.length} 个渠道` : ticketActionLabel(officialEntries[0]),
      jumpable: officialEntries.some((entry) => entry.jumpable),
      verificationDay: toDateString(new Date()),
      hasLocation: isValidScenicLocation(scenic.location),
      locationAddress: scenic.address?.trim() || `${provinceName} · ${scenic.city}`,
    })
    this.refreshMarks()
    reportEvent(ANALYTICS_EVENTS.SCENIC_OPEN, {
      page: 'scenic', action: 'open', scene: officialEntries.length ? 'has_channel' : 'no_channel', result: 'success',
      duration_bucket: durationBucket(Date.now() - startedAt),
    })
    const res = await listGuides({ category: 'all', scenicId: scenic._id })
    this.setData({ guides: res.list.slice(0, 3) })
  },

  refreshMarks() {
    const s = this.data.scenic as Scenic
    const scenicMark = getScenicMarkState(s._id)
    this.setData({
      fav: isFavorite('scenic', s._id),
      trip: findTripByScenic(s._id) || null,
      visited: scenicMark === 'visited',
      wish: scenicMark === 'wish',
    })
  },

  onFav() {
    const s = this.data.scenic as Scenic
    const fav = toggleFavorite(favoriteFromScenic(s))
    if (fav === null) {
      toast('收藏已达 500 条上限，请先整理')
      return
    }
    vibrate()
    this.setData({ fav })
    reportEvent(ANALYTICS_EVENTS.FAVORITE_TOGGLE, {
      page: 'scenic', action: fav ? 'add' : 'remove', scene: 'scenic', result: 'success',
    })
    toast(fav ? '已收藏' : '已取消收藏')
  },

  onScenicMark(e: WechatMiniprogram.TouchEvent) {
    const scenic = this.data.scenic as Scenic
    const requested = String(e.currentTarget.dataset.state || '') as 'visited' | 'wish'
    if (!scenic || !['visited', 'wish'].includes(requested)) return
    const next = toggleScenicMark(scenic, requested)
    vibrate()
    this.refreshMarks()
    const province = getProvince(scenic.province).name
    if (!next) toast(requested === 'visited' ? '已取消去过' : '已移出想去')
    else toast(`${next === 'visited' ? '已标记去过' : '已加入想去'}，${province}已点亮`)
  },

  onTrip() {
    this.setData({ sheetVisible: true })
  },
  onSheetClose() {
    this.setData({ sheetVisible: false })
  },
  onTripSaved() {
    this.refreshMarks()
  },

  /** 单飞生成分享图；失败由点击处理函数提示，好友分享本身继续使用默认卡片。 */
  async ensureSharePoster(force = false): Promise<string> {
    if (!force && this.data.shareImageUrl) return this.data.shareImageUrl
    const scenic = this.data.scenic as Scenic | null
    if (!scenic) throw new Error('景区资料尚未加载完成')
    const self = this as unknown as SyncPageInstance
    if (self.sharePosterPromise) return self.sharePosterPromise

    this.setData({ posterGenerating: true })
    const place = [this.data.provinceName, scenic.city].filter(Boolean).join(' · ')
    const task = createScenicSharePoster(this, scenic, place)
    self.sharePosterPromise = task
    try {
      const filePath = await task
      this.setData({ shareImageUrl: filePath })
      return filePath
    } finally {
      if (self.sharePosterPromise === task) self.sharePosterPromise = undefined
      this.setData({ posterGenerating: false })
    }
  },

  async onGenerateSharePoster() {
    try {
      await this.ensureSharePoster(true)
      toast('分享图已生成')
    } catch (error) {
      console.info('[scenic] 分享图生成失败，继续使用默认分享卡片', error)
      toast('暂时无法生成分享图，仍可直接转发')
    }
  },

  /** 保存接口只在用户点击时调用；拒绝相册权限时不抛出页面错误或反复申请。 */
  async onSaveSharePoster() {
    try {
      const filePath = await this.ensureSharePoster()
      await saveSharePoster(filePath)
      toast('分享图已保存到相册')
    } catch (error) {
      console.info('[scenic] 分享图未保存', error)
      toast(isAlbumPermissionDenied(error) ? '未保存，可在设置中开启相册权限' : '暂时无法保存，请稍后再试')
    }
  },

  /** openLocation 仅打开已核验的目的地坐标，本身不读取用户位置，也不申请 scope.userLocation。 */
  onNavigate() {
    const scenic = this.data.scenic as Scenic
    if (!isValidScenicLocation(scenic.location)) return
    wx.openLocation({
      latitude: scenic.location.lat,
      longitude: scenic.location.lng,
      name: scenic.name,
      address: scenic.address || '',
      scale: 16,
      fail: (error) => {
        console.info('[scenic] 打开地图失败', error)
        toast('暂时无法打开地图，请稍后再试')
      },
    })
  },

  onTicket() {
    const entries = this.data.officialEntries as OfficialEntryView[]
    if (entries.length > 1) {
      reportEvent(ANALYTICS_EVENTS.TICKET_CLICK, {
        page: 'scenic', action: 'click', scene: 'detail_primary', result: 'channel_list',
      })
      wx.pageScrollTo({ selector: '#official-channels', duration: 300 })
      return
    }
    if (entries[0]) {
      reportEvent(ANALYTICS_EVENTS.TICKET_CLICK, {
        page: 'scenic', action: 'click', scene: 'detail_primary', result: entries[0].jumpable ? 'direct' : 'fallback',
      })
      openTicket(entries[0])
    }
  },

  onOpenEntry(e: WechatMiniprogram.TouchEvent) {
    const entry = this.data.officialEntries[Number(e.currentTarget.dataset.index)] as OfficialEntryView | undefined
    if (entry) {
      reportEvent(ANALYTICS_EVENTS.TICKET_CLICK, {
        page: 'scenic', action: 'click', scene: 'channel_item', result: entry.jumpable ? 'direct' : 'fallback',
      })
      openTicket(entry)
    }
  },

  onCopyEntry(e: WechatMiniprogram.TouchEvent) {
    const entry = this.data.officialEntries[Number(e.currentTarget.dataset.index)] as OfficialEntryView | undefined
    if (entry) {
      reportEvent(ANALYTICS_EVENTS.TICKET_CLICK, { page: 'scenic', action: 'copy', scene: 'channel_item', result: 'manual' })
      wx.setClipboardData({ data: copyableEntryText(entry) })
    }
  },

  onCopyNoticeSource(e: WechatMiniprogram.TouchEvent) {
    const notice = this.data.notices[Number(e.currentTarget.dataset.index)] as ScenicNoticeView | undefined
    if (notice?.sourceUrl) wx.setClipboardData({ data: notice.sourceUrl })
  },

  toGuides() {
    wx.navigateTo({ url: '/pages/guides/index' })
  },

  toCorrection() {
    const scenic = this.data.scenic as Scenic
    wx.navigateTo({ url: `/packageExtra/pages/correction/index?scenicId=${encodeURIComponent(scenic._id)}&scenicName=${encodeURIComponent(scenic.name)}` })
  },
})
