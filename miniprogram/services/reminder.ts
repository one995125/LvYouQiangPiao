/**
 * 行程订阅消息服务。
 * - 授权只能由用户点击行为直接触发，因此入口固定在 trip-sheet 的保存按钮。
 * - 模板未配置、用户拒绝、云开发不可用或登记失败时均静默降级，不影响本地行程和同步协议。
 * - 客户端只提交行程资料与本次授权结果；openid、提醒日期和发送幂等均由云函数处理。
 */
import { CLOUD_FUNCTIONS, SUBSCRIBE_TEMPLATE_IDS } from '../constants/config'
import { Scenic, TripItem } from '../types/index'
import { callFunction } from './cloud'

export type TripReminderType = keyof typeof SUBSCRIBE_TEMPLATE_IDS

interface ReminderRegistration {
  tripId: string
  scenicId: string
  scenicName: string
  visitDate: string
  period: TripItem['period']
  advanceDays?: number
  acceptedTypes: TripReminderType[]
}

const configuredTemplateEntries = (trip: TripItem, scenic: Scenic): Array<[TripReminderType, string]> => {
  if (!trip.date || trip.status === 'done') return []
  const entries: Array<[TripReminderType, string]> = []
  const tripTemplateId = SUBSCRIBE_TEMPLATE_IDS.tripReminder.trim()
  if (tripTemplateId) entries.push(['tripReminder', tripTemplateId])
  const advanceDays = scenic.reservation?.advanceDays
  const releaseTemplateId = SUBSCRIBE_TEMPLATE_IDS.releaseReminder.trim()
  if (releaseTemplateId && typeof advanceDays === 'number' && advanceDays >= 0) {
    entries.push(['releaseReminder', releaseTemplateId])
  }
  return entries
}

/** 云端登记失败属于可选增强失败，只写日志，绝不向用户弹错误。 */
async function registerReminder(input: ReminderRegistration): Promise<void> {
  try {
    await callFunction(CLOUD_FUNCTIONS.reminder, { action: 'register', reminder: input })
  } catch (error) {
    console.info('[reminder] 云端登记未完成，行程本地保存不受影响', error)
  }
}

/**
 * 保存行程后立即调用。函数在第一个 await 之前触发 requestSubscribeMessage，确保仍处于用户手势链路。
 */
export async function requestAndRegisterTripReminder(trip: TripItem, scenic: Scenic): Promise<void> {
  if (!trip.date || trip.status === 'done') {
    await cancelTripReminder(trip.id)
    return
  }

  const entries = configuredTemplateEntries(trip, scenic)
  // 模板 ID 尚未配置时完全静默跳过，避免传空数组触发 10001 错误。
  if (!entries.length) return

  const templateIds = Array.from(new Set(entries.map(([, templateId]) => templateId)))
  const acceptedTypes: TripReminderType[] = []
  try {
    if (!wx.requestSubscribeMessage) return
    const result = await wx.requestSubscribeMessage({ tmplIds: templateIds })
    entries.forEach(([type, templateId]) => {
      const state = String((result as unknown as Record<string, unknown>)[templateId] || '')
      if (state === 'accept' || state === 'acceptWithAudio') acceptedTypes.push(type)
      else console.info(`[reminder] 用户未接受 ${type}：${state || 'unknown'}`)
    })
  } catch (error) {
    console.info('[reminder] 订阅授权未完成，行程保存不受影响', error)
  }

  const advanceDays = scenic.reservation?.advanceDays
  await registerReminder({
    tripId: trip.id,
    scenicId: trip.scenicId,
    scenicName: trip.scenicName,
    visitDate: trip.date,
    period: trip.period || 'all',
    ...(typeof advanceDays === 'number' && advanceDays >= 0 ? { advanceDays: Math.floor(advanceDays) } : {}),
    acceptedTypes,
  })
}

/** 删除行程、清除日期或标记已出行时取消登记；失败静默，后端发送前还会反查行程快照兜底。 */
export async function cancelTripReminder(tripId: string): Promise<void> {
  if (!tripId) return
  try {
    await callFunction(CLOUD_FUNCTIONS.reminder, { action: 'cancel', tripId })
  } catch (error) {
    console.info('[reminder] 云端取消未完成，将由发送前行程校验兜底', error)
  }
}
