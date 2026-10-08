/** 景区对比：最多 3 列，数据来自当前景区资料，不另行猜测。 */
import { getScenic } from '../../../services/scenic'
import { isChannelExpired, isCurrentVerified, officialEntriesOf } from '../../../services/ticket'
import { getCompareIds, toggleCompare } from '../../../stores/comparison'
import { Scenic } from '../../../types/index'
import { formatPrice } from '../../../utils/format'

interface CompareColumn extends Scenic {
  priceText: string
  locationText: string
  levelText: string
  reservationText: string
  channelText: string
}

interface CompareRow {
  label: string
  values: string[]
}

const text = (value: string | undefined, fallback = '待补充') => value || fallback

function toColumn(scenic: Scenic): CompareColumn {
  const entries = officialEntriesOf(scenic)
  const verified = entries.filter((entry) => isCurrentVerified(entry)).length
  const expired = entries.filter((entry) => isChannelExpired(entry)).length
  return {
    ...scenic,
    priceText: scenic.price === 0 ? '免费' : `${formatPrice(scenic.price)} 起`,
    locationText: `${scenic.city}`,
    levelText: scenic.level || '未标级',
    reservationText: scenic.booking || '以官方公告为准',
    channelText: `${entries.length} 个入口 · ${verified} 个当前已核验${expired ? ` · ${expired} 个核验过期` : ''}`,
  }
}

Page({
  data: {
    loading: true,
    columns: [] as CompareColumn[],
    rows: [] as CompareRow[],
    tableWidth: 720,
  },

  onShow() {
    void this.load()
  },

  async load() {
    const ids = getCompareIds()
    const result = await Promise.all(ids.map((id) => getScenic(id)))
    const columns = result.filter((item): item is Scenic => !!item).map(toColumn)
    const rows: CompareRow[] = [
      { label: '城市', values: columns.map((item) => item.locationText) },
      { label: '等级', values: columns.map((item) => item.levelText) },
      { label: '类型', values: columns.map((item) => item.category) },
      { label: '门票参考', values: columns.map((item) => item.priceText) },
      { label: '建议游玩', values: columns.map((item) => item.duration) },
      { label: '开放时间', values: columns.map((item) => text(item.openTime)) },
      { label: '预约说明', values: columns.map((item) => item.reservationText) },
      { label: '官方渠道', values: columns.map((item) => item.channelText) },
      { label: '资料更新', values: columns.map((item) => text(item.updatedAt)) },
    ]
    this.setData({ loading: false, columns, rows, tableWidth: 168 + columns.length * 286 })
  },

  onRemove(e: WechatMiniprogram.TouchEvent) {
    toggleCompare(e.currentTarget.dataset.id as string)
    void this.load()
  },

  onOpen(e: WechatMiniprogram.TouchEvent) {
    wx.navigateTo({ url: `/pages/scenic/index?id=${e.currentTarget.dataset.id}` })
  },

  onTicket(e: WechatMiniprogram.TouchEvent) {
    const scenic = this.data.columns[Number(e.currentTarget.dataset.index)] as CompareColumn | undefined
    // 对比页只负责引导查看全部渠道，不把单个入口误当作景区的唯一购票方式。
    if (scenic) wx.navigateTo({ url: `/pages/scenic/index?id=${encodeURIComponent(scenic._id)}` })
  },
})
