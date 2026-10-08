/**
 * 管理员攻略维护接口。页面入口隐藏仅是界面处理，所有操作由 shijingGuide 再次校验调用者 OpenID。
 * 新稿先保存为草稿；正文保存与发布/下架均携带服务端版本，避免覆盖他人的更新。
 */
import { CLOUD_FUNCTIONS } from '../constants/config'
import { Guide, GuideBlock, GuideCategory, Tone } from '../types/index'
import { callFunction } from './cloud'

export interface GuideAdminDraft {
  title: string
  summary: string
  category: GuideCategory
  province: string
  scenicId: string
  scenicName: string
  tone: Tone
  tags: string[]
  blocks: GuideBlock[]
}

export const listAdminGuides = (status: 'pending' | 'approved', page: number) =>
  callFunction<{ list: Guide[]; hasMore: boolean }>(CLOUD_FUNCTIONS.guide, { action: 'adminList', status, page })

export const getAdminGuide = (id: string) =>
  callFunction<{ guide: Guide; revision: number }>(CLOUD_FUNCTIONS.guide, { action: 'adminGet', id })

export const saveAdminGuide = (id: string, baseRevision: number, draft: GuideAdminDraft) =>
  callFunction<{ id: string; revision: number; status: 'pending' | 'approved' }>(CLOUD_FUNCTIONS.guide, {
    action: 'adminSave', id, baseRevision, draft,
  })

export const setAdminGuideStatus = (id: string, baseRevision: number, status: 'pending' | 'approved') =>
  callFunction<{ id: string; revision: number; status: 'pending' | 'approved' }>(CLOUD_FUNCTIONS.guide, {
    action: 'adminSetStatus', id, baseRevision, status,
  })
