/** 景区资料纠错服务：统一走云函数，客户端不直接写数据库。 */
import { CLOUD_FUNCTIONS } from '../constants/config'
import { callFunction } from './cloud'

export type CorrectionType = 'channel' | 'price' | 'opening' | 'reservation' | 'closed' | 'other'

export interface CorrectionInput {
  scenicId: string
  scenicName: string
  type: CorrectionType
  description: string
}

export interface CorrectionResult {
  id: string
  status: 'pending'
}

export function submitCorrection(input: CorrectionInput): Promise<CorrectionResult> {
  return callFunction<CorrectionResult>(CLOUD_FUNCTIONS.correction, { action: 'create', correction: input })
}
