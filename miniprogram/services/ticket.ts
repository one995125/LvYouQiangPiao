/**
 * 官方购票渠道跳转
 * 平台只做入口聚合，不参与售票、不收取费用。
 * - 仅当前已核验入口可直达；过期/待核验入口只复制名称，引导用户重新确认
 * - 小程序短链：wx.navigateToMiniProgram({ shortLink })，基础库 2.18.1+，必须由用户点击触发
 * - appId + path：常规跳转（需用户确认）
 * - 官网：小程序无法直接打开第三方网页，复制链接引导用户在浏览器打开
 * - 未收录：复制官方渠道名称，引导用户在微信内搜索
 */
import { OfficialEntry, OfficialEntryPurpose, Scenic, TicketChannel } from '../types/index'
import { isPastValidUntil } from '../utils/validity'

const PURPOSE_LABELS: Record<OfficialEntryPurpose, string> = {
  ticket: '门票',
  reservation: '预约',
  cableway: '索道',
  performance: '演出',
  transport: '交通',
  guide: '讲解',
  other: '其他服务',
}

/**
 * 将旧的单 ticket 数据升级为可渲染的多渠道列表。
 * 注意：只做字段兼容，不会猜测或自动标记“已核验”。
 */
export function officialEntriesOf(scenic: Scenic): OfficialEntry[] {
  if (Array.isArray(scenic.officialEntries) && scenic.officialEntries.length) return scenic.officialEntries
  return [{ ...scenic.ticket, id: 'legacy-ticket', purpose: scenic.ticket.purpose || 'ticket' }]
}

/** 多渠道列表优先选当前已核验且可直达的入口，旧单渠道字段仅作兼容。 */
export function primaryOfficialEntry(scenic: Scenic): OfficialEntry {
  const entries = officialEntriesOf(scenic)
  return entries.find(canJump) || entries.find((entry) => isCurrentVerified(entry) && entry.type !== 'none') || entries.find((entry) => !isPastValidUntil(entry.validUntil) && entry.type !== 'none') || entries[0]
}

export const officialEntryPurposeLabel = (purpose: OfficialEntryPurpose): string => PURPOSE_LABELS[purpose]

function copy(text: string, title: string, content: string) {
  wx.setClipboardData({
    data: text,
    success: () => {
      wx.showModal({ title, content, showCancel: false, confirmText: '知道了', confirmColor: '#2F5A51' })
    },
  })
}

function fallbackSearch(t: TicketChannel, reason: 'unverified' | 'expired' | 'missing') {
  const message = reason === 'expired'
    ? '原核验有效期已过，入口可能变化。请先从景区官方公告重新确认。'
    : reason === 'unverified'
      ? '此入口尚未完成官方身份与跳转核验，请先从景区官方公告确认。'
      : '当前无法直接打开，请先从景区官方公告确认渠道。'
  copy(t.name, '已复制渠道名称', `${message}可搜索「${t.name}」，核对主体后再操作。`)
}

/** 只有显式标记已核验且未超过有效期，才作为当前已核验渠道展示。 */
export const isCurrentVerified = (t: TicketChannel, now = new Date()): boolean =>
  t.verified === true && !isPastValidUntil(t.validUntil, now)

/** 过期仅依据资料中明确录入的 validUntil；未填有效期不推断为过期。 */
export const isChannelExpired = (t: TicketChannel, now = new Date()): boolean =>
  t.verified === true && isPastValidUntil(t.validUntil, now)

export function canJump(t: TicketChannel): boolean {
  return t.type === 'miniprogram' && isCurrentVerified(t) && !!(t.shortLink || (t.appId && t.path))
}

export function ticketActionLabel(t: TicketChannel): string {
  if (t.type === 'none') return '渠道收录中'
  if (isChannelExpired(t)) return '核验已过期'
  if (!isCurrentVerified(t)) return '查看渠道信息'
  switch (t.type) {
    case 'miniprogram':
      return canJump(t) ? '打开官方小程序' : '查找官方渠道'
    case 'web':
      return '复制官网地址'
    case 'phone':
      return '电话预约'
    case 'free':
      return '免费 · 查看须知'
    default:
      return '查看渠道信息'
  }
}

/** 复制按钮与跳转策略保持一致，不把待核验/过期的链接作为可靠入口分发。 */
export function copyableEntryText(t: TicketChannel): string {
  if (!isCurrentVerified(t)) return t.name
  return t.type === 'miniprogram' ? t.shortLink || t.name : t.type === 'web' ? t.url || t.name : t.name
}

export function openTicket(t: TicketChannel): void {
  if (t.type === 'none') {
    wx.showToast({ title: '渠道正在收录中', icon: 'none' })
    return
  }
  if (isChannelExpired(t)) return fallbackSearch(t, 'expired')
  if (!isCurrentVerified(t)) return fallbackSearch(t, 'unverified')
  switch (t.type) {
    case 'miniprogram': {
      if (!canJump(t)) return fallbackSearch(t, 'missing')
      const opts: Record<string, unknown> = t.shortLink ? { shortLink: t.shortLink } : { appId: t.appId, path: t.path || '' }
      wx.navigateToMiniProgram({
        ...(opts as { appId: string }),
        envVersion: 'release',
        fail: (err) => {
          if (/cancel/.test(err.errMsg)) return
          console.warn('[ticket] 跳转失败', err)
          fallbackSearch(t, 'missing')
        },
      })
      return
    }
    case 'web':
      if (t.url) copy(t.url, '已复制官网地址', '请粘贴到手机浏览器中打开，完成官方购票。')
      else fallbackSearch(t, 'missing')
      return
    case 'phone':
      if (t.phone) wx.makePhoneCall({ phoneNumber: t.phone })
      else fallbackSearch(t, 'missing')
      return
    case 'free':
      wx.showModal({
        title: '免费开放',
        content: `${t.name}。具体预约要求请以景区官方公告为准。`,
        showCancel: false,
        confirmColor: '#2F5A51',
      })
      return
    default:
      wx.showToast({ title: '渠道正在收录中', icon: 'none' })
  }
}
