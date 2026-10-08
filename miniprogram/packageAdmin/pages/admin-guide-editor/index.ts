/**
 * 管理员攻略编辑器。新稿先保存为草稿；发布/下架是独立操作且必须先保存当前修改。
 * 前端做基础提示，最终校验、身份验证和版本比较全部由云函数执行。
 */
import { GUIDE_CATEGORIES } from '../../../constants/enums'
import { MAX_GUIDE_TAG_LENGTH, MAX_GUIDE_TAGS } from '../../../constants/config'
import { PROVINCES } from '../../../constants/provinces'
import { checkAdmin } from '../../../services/admin'
import { getAdminGuide, GuideAdminDraft, saveAdminGuide, setAdminGuideStatus } from '../../../services/guide-admin'
import { GuideBlock, GuideCategory, Tone } from '../../../types/index'

const CATEGORIES = GUIDE_CATEGORIES.filter((item) => item.key !== 'all') as { key: GuideCategory; label: string }[]
const TONES: { key: Tone; label: string }[] = [
  { key: 'jade', label: '黛青' }, { key: 'ochre', label: '赭石' }, { key: 'mist', label: '雾灰' },
  { key: 'lake', label: '湖蓝' }, { key: 'dusk', label: '暮紫' }, { key: 'ink', label: '墨色' },
  { key: 'rose', label: '朱红' }, { key: 'sand', label: '沙金' },
]
const BLOCK_TYPES: { key: GuideBlock['type']; label: string }[] = [
  { key: 'h', label: '小标题' }, { key: 'p', label: '正文' },
  { key: 'tip', label: '提示' }, { key: 'warn', label: '注意' },
]
const PROVINCE_CHOICES = [{ code: '', name: '全国通用' }, ...PROVINCES]
const freshDraft = (): GuideAdminDraft => ({
  title: '', summary: '', category: 'guide', province: '', scenicId: '', scenicName: '',
  tone: 'jade', tags: [], blocks: [{ type: 'p', text: '' }],
})
const indexOf = <T extends string>(list: { key: T }[], key: T) => Math.max(0, list.findIndex((item) => item.key === key))
const confirm = (title: string, content: string) => new Promise<boolean>((resolve) => wx.showModal({
  title, content, confirmColor: '#2F5A51', success: (result) => resolve(result.confirm), fail: () => resolve(false),
}))

/** 支持中英文逗号、顿号、分号和换行；按忽略大小写的结果去重。 */
function parseTags(value: string): { tags: string[]; error: string } {
  const parts = String(value || '').split(/[,，、;；\n]+/).map((item) => item.trim()).filter(Boolean)
  const tags: string[] = []
  const seen = new Set<string>()
  for (const tag of parts) {
    if (tag.length > MAX_GUIDE_TAG_LENGTH) return { tags: [], error: `每个标签最多 ${MAX_GUIDE_TAG_LENGTH} 个字` }
    const key = tag.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      tags.push(tag)
    }
  }
  if (tags.length > MAX_GUIDE_TAGS) return { tags: [], error: `每篇攻略最多 ${MAX_GUIDE_TAGS} 个标签` }
  return { tags, error: '' }
}

Page({
  data: {
    id: '', revision: 0, status: 'pending' as 'pending' | 'approved',
    draft: freshDraft(), authorized: false, loading: true, saving: false, dirty: false, error: '',
    categories: CATEGORIES.map((item) => item.label), categoryIndex: 0,
    tones: TONES.map((item) => item.label), toneIndex: 0,
    provinces: PROVINCE_CHOICES.map((item) => item.name), provinceIndex: 0,
    blockTypes: BLOCK_TYPES.map((item) => item.label),
    blockTypeIndexes: [1] as number[],
    /** 保留管理员输入形态，保存时再统一分隔、去空和去重。 */
    tagsText: '',
  },

  async onLoad(query: Record<string, string | undefined>) {
    const id = query.id ? decodeURIComponent(query.id) : ''
    this.setData({ id })
    try {
      await checkAdmin()
      if (id) {
        const { guide, revision } = await getAdminGuide(id)
        const draft: GuideAdminDraft = {
          title: guide.title, summary: guide.summary, category: guide.category,
          province: guide.province || '', scenicId: guide.scenicId || '', scenicName: guide.scenicName || '',
          tone: guide.tone, tags: guide.tags || [], blocks: guide.blocks || [],
        }
        this.setData({
          draft, revision, status: guide.status === 'approved' ? 'approved' : 'pending',
          categoryIndex: indexOf(CATEGORIES, guide.category), toneIndex: indexOf(TONES, guide.tone),
          provinceIndex: Math.max(0, PROVINCE_CHOICES.findIndex((item) => item.code === draft.province)),
          blockTypeIndexes: draft.blocks.map((block) => indexOf(BLOCK_TYPES, block.type)),
          tagsText: draft.tags.join('、'),
        })
      }
      this.setData({ authorized: true })
    } catch (error) {
      this.setData({ error: (error as Error).message || '无法读取攻略' })
    } finally {
      this.setData({ loading: false })
    }
  },

  /** 输入只写当前表单字段，避免每次按键触发云端请求。 */
  onField(e: WechatMiniprogram.Input) {
    const key = String(e.currentTarget.dataset.key || '')
    if (!['title', 'summary', 'scenicId', 'scenicName'].includes(key)) return
    this.setData({ [`draft.${key}`]: e.detail.value, dirty: true })
  },

  onTagsInput(e: WechatMiniprogram.Input) {
    this.setData({ tagsText: e.detail.value, dirty: true })
  },

  onChoice(e: WechatMiniprogram.PickerChange) {
    const kind = String(e.currentTarget.dataset.kind || '')
    const index = Number(e.detail.value)
    if (kind === 'category' && CATEGORIES[index]) this.setData({ 'draft.category': CATEGORIES[index].key, categoryIndex: index, dirty: true })
    if (kind === 'tone' && TONES[index]) this.setData({ 'draft.tone': TONES[index].key, toneIndex: index, dirty: true })
    if (kind === 'province' && PROVINCE_CHOICES[index]) this.setData({ 'draft.province': PROVINCE_CHOICES[index].code, provinceIndex: index, dirty: true })
  },

  onBlockText(e: WechatMiniprogram.Input) {
    const index = Number(e.currentTarget.dataset.index)
    if (!Number.isInteger(index) || index < 0 || index >= this.data.draft.blocks.length) return
    this.setData({ [`draft.blocks[${index}].text`]: e.detail.value, dirty: true })
  },

  onBlockType(e: WechatMiniprogram.PickerChange) {
    const block = Number(e.currentTarget.dataset.index)
    const kind = Number(e.detail.value)
    if (!this.data.draft.blocks[block] || !BLOCK_TYPES[kind]) return
    this.setData({ [`draft.blocks[${block}].type`]: BLOCK_TYPES[kind].key, [`blockTypeIndexes[${block}]`]: kind, dirty: true })
  },

  onAddBlock() {
    if (this.data.draft.blocks.length >= 30) {
      wx.showToast({ title: '最多 30 段', icon: 'none' })
      return
    }
    this.setData({ 'draft.blocks': [...this.data.draft.blocks, { type: 'p', text: '' }], blockTypeIndexes: [...this.data.blockTypeIndexes, 1], dirty: true })
  },

  onRemoveBlock(e: WechatMiniprogram.TouchEvent) {
    const index = Number(e.currentTarget.dataset.index)
    if (!Number.isInteger(index) || index < 0 || index >= this.data.draft.blocks.length) return
    this.setData({
      'draft.blocks': this.data.draft.blocks.filter((_, i) => i !== index),
      blockTypeIndexes: this.data.blockTypeIndexes.filter((_, i) => i !== index), dirty: true,
    })
  },

  async onSave() {
    if (!this.data.authorized || this.data.loading || this.data.saving) return
    const parsedTags = parseTags(this.data.tagsText)
    if (parsedTags.error) {
      this.setData({ error: parsedTags.error })
      wx.showToast({ title: parsedTags.error, icon: 'none' })
      return
    }
    this.setData({ saving: true, error: '' })
    try {
      const draft = { ...this.data.draft, tags: parsedTags.tags }
      const result = await saveAdminGuide(this.data.id, this.data.revision, draft)
      this.setData({ id: result.id, revision: result.revision, status: result.status, draft, tagsText: parsedTags.tags.join('、'), dirty: false })
      wx.showToast({ title: result.status === 'approved' ? '修改已公开' : '草稿已保存', icon: 'success' })
    } catch (error) {
      const err = error as { code?: string; message?: string }
      this.setData({ error: err.code === 'SYNC_CONFLICT' ? '云端攻略已有新版本。请保留本页修改，重新打开后手动合并。' : err.message || '保存失败' })
    } finally {
      this.setData({ saving: false })
    }
  },

  async onStatus() {
    if (!this.data.authorized || !this.data.id || this.data.saving) return
    if (this.data.dirty) {
      wx.showToast({ title: '请先保存当前修改', icon: 'none' })
      return
    }
    const publishing = this.data.status !== 'approved'
    if (!(await confirm(publishing ? '确认发布攻略？' : '确认下架攻略？', publishing
      ? '发布后所有游客都可查看和收藏这篇内容，请先核对事实、来源及措辞。'
      : '下架后游客无法再打开该攻略及旧分享链接，原收藏记录仍保留。'))) return
    this.setData({ saving: true, error: '' })
    try {
      const result = await setAdminGuideStatus(this.data.id, this.data.revision, publishing ? 'approved' : 'pending')
      this.setData({ revision: result.revision, status: result.status })
      wx.showToast({ title: publishing ? '已发布' : '已下架', icon: 'success' })
    } catch (error) {
      const err = error as { code?: string; message?: string }
      this.setData({ error: err.code === 'SYNC_CONFLICT' ? '云端已有新版本，请重新打开后核对。' : err.message || '操作失败' })
    } finally {
      this.setData({ saving: false })
    }
  },

  onPreview() {
    if (this.data.status === 'approved' && this.data.id && !this.data.dirty) {
    wx.navigateTo({ url: `/packageExtra/pages/guide-detail/index?id=${encodeURIComponent(this.data.id)}` })
    }
  },
})
