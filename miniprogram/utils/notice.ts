/** 景区公告时间筛选与展示映射。 */
import { ScenicNotice, ScenicNoticeType } from '../types/index'

const TYPE_LABELS: Record<ScenicNoticeType, string> = {
  closure: '暂停开放',
  weather: '天气影响',
  limit: '预约限流',
  maintenance: '设施检修',
  info: '游览提示',
}

export interface ScenicNoticeView extends ScenicNotice {
  typeLabel: string
  dateLabel: string
  urgent: boolean
}

const todayString = (now: Date) => {
  const pad = (value: number) => (value < 10 ? `0${value}` : `${value}`)
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

export function activeNoticeViews(notices: ScenicNotice[] | undefined, now = new Date()): ScenicNoticeView[] {
  const today = todayString(now)
  return (notices || [])
    .filter((notice) => (!notice.startAt || notice.startAt <= today) && (!notice.endAt || notice.endAt >= today))
    .map((notice) => ({
      ...notice,
      typeLabel: TYPE_LABELS[notice.type],
      dateLabel: notice.endAt ? `有效至 ${notice.endAt}` : notice.startAt ? `${notice.startAt} 起` : '当前有效',
      urgent: notice.type !== 'info',
    }))
}
