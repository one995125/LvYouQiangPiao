/**
 * 景区资料维护表单：加载云端版本后编辑公告、来源、官方渠道与结构化预约规则。
 * 未填写的规则保持未知，不由页面推测；保存只走 shijingAdmin 云函数。
 */
import { getAdminScenic, saveAdminScenic, ScenicAdminDraft } from '../../../services/admin'
import { officialEntriesOf } from '../../../services/ticket'
import { OfficialEntry, OfficialEntryPurpose, ReservationRule, ScenicLocation, ScenicNotice, ScenicNoticeType, ScenicSource, TicketChannel } from '../../../types/index'

const PURPOSES: { value: OfficialEntryPurpose; label: string }[] = [
  { value: 'ticket', label: '门票' }, { value: 'reservation', label: '预约' },
  { value: 'cableway', label: '索道' }, { value: 'performance', label: '演出' },
  { value: 'transport', label: '交通' }, { value: 'guide', label: '讲解' }, { value: 'other', label: '其他' },
]
const CHANNEL_TYPES: { value: TicketChannel['type']; label: string }[] = [
  { value: 'miniprogram', label: '小程序' }, { value: 'web', label: '官网' },
  { value: 'phone', label: '电话' }, { value: 'free', label: '免费开放' }, { value: 'none', label: '暂未收录' },
]
const NOTICE_TYPES: { value: ScenicNoticeType; label: string }[] = [
  { value: 'closure', label: '闭园' }, { value: 'weather', label: '天气' },
  { value: 'limit', label: '限流' }, { value: 'maintenance', label: '维护' }, { value: 'info', label: '一般信息' },
]
const BOOLEAN_CHOICES = ['尚未核验', '是', '否']
const flagIndex = (value?: boolean) => value === true ? 1 : value === false ? 2 : 0
const flagValue = (index: number): boolean | undefined => index === 1 ? true : index === 2 ? false : undefined
const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

interface EntryForm extends OfficialEntry { purposeIndex: number; typeIndex: number }
interface NoticeForm extends ScenicNotice { typeIndex: number }

const choiceIndex = <T extends string>(list: { value: T }[], value: T) => Math.max(0, list.findIndex((item) => item.value === value))

Page({
  data: {
    id: '', name: '', revision: 0, loading: true, saving: false, error: '', savedAt: '',
    booking: '',
    entries: [] as EntryForm[],
    sources: [] as ScenicSource[],
    notices: [] as NoticeForm[],
    rule: {} as ReservationRule,
    ruleFlags: { required: 0, realName: 0, timeSlotRequired: 0 },
    advanceDaysText: '', documentsText: '',
    latitudeText: '', longitudeText: '', address: '',
    purposes: PURPOSES.map((item) => item.label),
    channelTypes: CHANNEL_TYPES.map((item) => item.label),
    noticeTypes: NOTICE_TYPES.map((item) => item.label),
    booleanChoices: BOOLEAN_CHOICES,
  },

  onLoad(query: Record<string, string | undefined>) {
    this.setData({ id: decodeURIComponent(query.id || '') })
    this.load()
  },

  async load() {
    if (!this.data.id) return this.setData({ loading: false, error: '缺少景区 ID' })
    this.setData({ loading: true, error: '' })
    try {
      const { scenic, revision } = await getAdminScenic(this.data.id)
      const rule = scenic.reservation || {}
      this.setData({
        name: scenic.name, revision, booking: scenic.booking || '',
        entries: officialEntriesOf(scenic).map((entry) => ({
          ...entry,
          purposeIndex: choiceIndex(PURPOSES, entry.purpose),
          typeIndex: choiceIndex(CHANNEL_TYPES, entry.type),
        })),
        sources: scenic.sources || [],
        notices: (scenic.notices || []).map((notice) => ({ ...notice, typeIndex: choiceIndex(NOTICE_TYPES, notice.type) })),
        rule,
        ruleFlags: {
          required: flagIndex(rule.required), realName: flagIndex(rule.realName),
          timeSlotRequired: flagIndex(rule.timeSlotRequired),
        },
        advanceDaysText: typeof rule.advanceDays === 'number' ? String(rule.advanceDays) : '',
        documentsText: (rule.documents || []).join('、'),
        latitudeText: typeof scenic.location?.lat === 'number' ? String(scenic.location.lat) : '',
        longitudeText: typeof scenic.location?.lng === 'number' ? String(scenic.location.lng) : '',
        address: scenic.address || '',
        savedAt: '',
      })
    } catch (error) {
      this.setData({ error: (error as Error).message || '读取景区资料失败' })
    } finally {
      this.setData({ loading: false })
    }
  },

  /** 输入仅更新当前字段，数组规模受云端限制；不在每次输入时发网络请求。 */
  onField(e: WechatMiniprogram.Input) {
    const { section, index, key } = e.currentTarget.dataset as { section: string; index?: number; key: string }
    const allowed: Record<string, string[]> = {
      entries: ['name', 'shortLink', 'appId', 'path', 'url', 'phone', 'sourceName', 'sourceUrl', 'checkedAt', 'validUntil', 'note'],
      sources: ['name', 'url', 'checkedAt', 'validUntil', 'note'],
      notices: ['title', 'content', 'startAt', 'endAt', 'sourceName', 'sourceUrl', 'checkedAt'],
      rule: ['releaseTime', 'refundRule', 'audienceRule', 'note'],
      top: ['booking', 'advanceDaysText', 'documentsText', 'latitudeText', 'longitudeText', 'address'],
    }
    if (!allowed[section]?.includes(key)) return
    const path = section === 'top' ? key : section === 'rule' ? `rule.${key}` : `${section}[${Number(index)}].${key}`
    this.setData({ [path]: e.detail.value })
  },

  onChoice(e: WechatMiniprogram.PickerChange) {
    const { section, index, key } = e.currentTarget.dataset as { section: string; index: number; key: string }
    const selected = Number(e.detail.value)
    if (section === 'entries' && key === 'purpose' && PURPOSES[selected]) {
      this.setData({ [`entries[${index}].purpose`]: PURPOSES[selected].value, [`entries[${index}].purposeIndex`]: selected })
    } else if (section === 'entries' && key === 'type' && CHANNEL_TYPES[selected]) {
      this.setData({ [`entries[${index}].type`]: CHANNEL_TYPES[selected].value, [`entries[${index}].typeIndex`]: selected })
    } else if (section === 'notices' && key === 'type' && NOTICE_TYPES[selected]) {
      this.setData({ [`notices[${index}].type`]: NOTICE_TYPES[selected].value, [`notices[${index}].typeIndex`]: selected })
    } else if (section === 'rule' && ['required', 'realName', 'timeSlotRequired'].includes(key) && selected >= 0 && selected <= 2) {
      this.setData({ [`ruleFlags.${key}`]: selected })
    }
  },

  onVerified(e: WechatMiniprogram.SwitchChange) {
    const index = Number(e.currentTarget.dataset.index)
    this.setData({ [`entries[${index}].verified`]: e.detail.value })
  },

  onAdd(e: WechatMiniprogram.TouchEvent) {
    const section = String(e.currentTarget.dataset.section)
    if (section === 'entries') {
      const entry: EntryForm = { id: newId('entry'), purpose: 'ticket', purposeIndex: 0, type: 'none', typeIndex: 4, name: '', verified: false }
      this.setData({ entries: [...this.data.entries, entry] })
    } else if (section === 'sources') {
      this.setData({ sources: [...this.data.sources, { id: newId('source'), name: '' }] })
    } else if (section === 'notices') {
      const notice: NoticeForm = { id: newId('notice'), type: 'info', typeIndex: 4, title: '', content: '', sourceName: '', checkedAt: '' }
      this.setData({ notices: [...this.data.notices, notice] })
    }
  },

  onRemove(e: WechatMiniprogram.TouchEvent) {
    const section = String(e.currentTarget.dataset.section)
    const index = Number(e.currentTarget.dataset.index)
    if (!['entries', 'sources', 'notices'].includes(section) || !Number.isInteger(index)) return
    const current = this.data[section as 'entries' | 'sources' | 'notices'] as unknown[]
    if (section === 'entries' && current.length <= 1) {
      wx.showToast({ title: '至少保留一条渠道', icon: 'none' })
      return
    }
    this.setData({ [section]: current.filter((_, i) => i !== index) })
  },

  async onSave() {
    if (this.data.saving || this.data.loading) return
    const advanceDaysText = this.data.advanceDaysText.trim()
    const advanceDays = advanceDaysText ? Number(advanceDaysText) : undefined
    if (advanceDays !== undefined && (!Number.isInteger(advanceDays) || advanceDays < 0 || advanceDays > 365)) {
      wx.showToast({ title: '提前天数应为 0~365', icon: 'none' })
      return
    }
    const latitudeText = this.data.latitudeText.trim()
    const longitudeText = this.data.longitudeText.trim()
    if (!!latitudeText !== !!longitudeText) {
      wx.showToast({ title: '经纬度须同时填写或清空', icon: 'none' })
      return
    }
    let location: ScenicLocation | null = null
    if (latitudeText && longitudeText) {
      const lat = Number(latitudeText)
      const lng = Number(longitudeText)
      if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
        wx.showToast({ title: '纬度应为 -90~90', icon: 'none' })
        return
      }
      if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
        wx.showToast({ title: '经度应为 -180~180', icon: 'none' })
        return
      }
      location = { lat, lng }
    }
    const rule: ReservationRule = { ...this.data.rule, documents: this.data.documentsText.split(/[、,，\n]/).map((item) => item.trim()).filter(Boolean) }
    delete rule.required
    delete rule.realName
    delete rule.timeSlotRequired
    for (const key of ['required', 'realName', 'timeSlotRequired'] as const) {
      const value = flagValue(this.data.ruleFlags[key])
      if (value !== undefined) rule[key] = value
    }
    if (advanceDays !== undefined) rule.advanceDays = advanceDays
    else delete rule.advanceDays
    const draft: ScenicAdminDraft = {
      booking: this.data.booking.trim(),
      location,
      address: this.data.address.trim(),
      reservation: rule,
      officialEntries: this.data.entries.map(({ purposeIndex, typeIndex, ...entry }) => entry),
      sources: this.data.sources,
      notices: this.data.notices.map(({ typeIndex, ...notice }) => notice),
    } as ScenicAdminDraft
    this.setData({ saving: true, error: '' })
    try {
      const result = await saveAdminScenic(this.data.id, this.data.revision, draft)
      this.setData({ revision: result.revision, savedAt: result.updatedAt })
      wx.showToast({ title: '已保存云端', icon: 'success' })
    } catch (error) {
      const err = error as { code?: string; message?: string }
      const message = err.code === 'SYNC_CONFLICT' ? '云端资料已有新版本。请先保留本页修改，重新打开后手动合并。' : err.message || '保存失败'
      this.setData({ error: message })
      wx.showModal({ title: '保存失败', content: message, showCancel: false })
    } finally {
      this.setData({ saving: false })
    }
  },

  onPreview() {
    wx.navigateTo({ url: `/pages/scenic/index?id=${encodeURIComponent(this.data.id)}` })
  },
})
