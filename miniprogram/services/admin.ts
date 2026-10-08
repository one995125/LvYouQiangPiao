/**
 * 景区资料维护服务。管理员身份只由 shijingAdmin 使用云函数调用上下文中的 OpenID 判断，
 * 此处不传任何用户标识；页面隐藏入口仅改善界面，不承担权限控制。
 */
import { CLOUD_FUNCTIONS } from '../constants/config'
import { OfficialEntry, ReservationRule, Scenic, ScenicLocation, ScenicNotice, ScenicSource } from '../types/index'
import { callFunction } from './cloud'

export interface ScenicAdminSummary {
  _id: string
  name: string
  province: string
  city: string
  updatedAt: string
  contentRevision?: number
}

export interface ScenicAdminDraft {
  booking: string
  /** null 表示管理员明确清空；undefined 仅用于兼容不提交位置字段的旧调用方。 */
  location?: ScenicLocation | null
  address?: string
  officialEntries: OfficialEntry[]
  sources: ScenicSource[]
  notices: ScenicNotice[]
  reservation: ReservationRule
}

export const checkAdmin = () => callFunction<{ authorized: boolean }>(CLOUD_FUNCTIONS.admin, { action: 'check' })

/** 云端景区分批读取，每页最多 50 条，避免一次加载全部文档。 */
export const listAdminScenics = (page: number) =>
  callFunction<{ list: ScenicAdminSummary[]; hasMore: boolean }>(CLOUD_FUNCTIONS.admin, { action: 'list', page })

export const getAdminScenic = (id: string) =>
  callFunction<{ scenic: Scenic; revision: number }>(CLOUD_FUNCTIONS.admin, { action: 'get', id })

/** baseRevision 来自本次 get/save 返回值；版本过期时云函数返回 SYNC_CONFLICT，不覆盖云端。 */
export const saveAdminScenic = (id: string, baseRevision: number, draft: ScenicAdminDraft) =>
  callFunction<{ revision: number; updatedAt: string }>(CLOUD_FUNCTIONS.admin, { action: 'save', id, baseRevision, ...draft })
