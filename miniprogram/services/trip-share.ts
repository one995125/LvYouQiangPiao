/**
 * 行程只读分享服务。
 * 分享快照与 user-data v2 同步完全独立；客户端只传隐私选项，不传 openid 或行程正文。
 */
import { CLOUD_FUNCTIONS } from '../constants/config'
import { TripShareSnapshot } from '../types/index'
import { callFunction } from './cloud'

export interface CreateTripShareOptions {
  includeNotes: boolean
  includeChecklist: boolean
}

/** 由云端读取当前调用方行程并生成 30 天有效的只读快照。 */
export function createTripShare(options: CreateTripShareOptions): Promise<TripShareSnapshot> {
  return callFunction<TripShareSnapshot>(CLOUD_FUNCTIONS.tripShare, {
    action: 'create',
    includeNotes: options.includeNotes === true,
    includeChecklist: options.includeChecklist === true,
  })
}

/** 公开读取只读快照；调用不会写入用户数据，仅由云端累计匿名查看次数。 */
export function getTripShare(shareId: string): Promise<TripShareSnapshot> {
  return callFunction<TripShareSnapshot>(CLOUD_FUNCTIONS.tripShare, { action: 'get', shareId })
}

/** 只有分享者本人可撤销；撤销只改变快照状态，不影响原始行程。 */
export function revokeTripShare(shareId: string): Promise<{ revoked: boolean }> {
  return callFunction<{ revoked: boolean }>(CLOUD_FUNCTIONS.tripShare, { action: 'revoke', shareId })
}
