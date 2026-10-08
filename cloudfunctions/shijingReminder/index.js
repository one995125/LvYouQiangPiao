/**
 * 云函数 shijingReminder：登记/取消行程提醒，并由每日定时触发器发送一次性订阅消息。
 *
 * 安全与兼容约束：
 * - register/cancel 的 openid 只取 getWXContext，客户端无法替其他用户写提醒。
 * - 定时发送只接受无用户 openid 的 Timer 事件，客户端伪造 action=send 会被拒绝。
 * - 服务端独立计算“出行前一天”和“建议预约日”，不信任客户端提交的计算结论。
 * - 发送前反查 shijing_user_data；旧客户端删除/完成/改期并同步后也不会误发。
 * - 每个 openid + tripId + type 使用确定性日志 ID，发送前先占位，保证并发定时任务不重复发送。
 */
const crypto = require('crypto')
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const reminders = db.collection('shijing_reminders')
const reminderLogs = db.collection('shijing_reminder_logs')
const userData = db.collection('shijing_user_data')

const REMINDER_TYPES = ['tripReminder', 'releaseReminder']
const PERIODS = ['all', 'morning', 'afternoon', 'evening']
const PERIOD_LABELS = { all: '全天', morning: '上午', afternoon: '下午', evening: '晚上' }
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
const TRIGGER_NAME = 'shijing-reminder-daily-0900'
const PAGE_PATH = 'pages/trips/index'
const ok = (data) => ({ ok: true, data })
const fail = (code, message, debug) => ({ ok: false, code, message, debug })

const getCallerIdentity = () => {
  const context = cloud.getWXContext()
  return {
    openid: context.FROM_OPENID || context.OPENID || '',
    // 环境共享时必须保存来源 AppID；定时器稍后已拿不到 FROM_APPID。
    sourceAppid: context.FROM_APPID || context.APPID || '',
  }
}

const hashId = (...parts) => crypto.createHash('sha256').update(parts.join('|')).digest('hex')

const isDocumentMissing = (error) => {
  const code = String((error && (error.errCode || error.code)) || '')
  const message = String((error && (error.errMsg || error.message)) || '')
  return code === 'DATABASE_DOCUMENT_NOT_EXIST' || /document.*(not exist|does not exist|not found)/i.test(message)
}

async function getOptional(ref) {
  try {
    return (await ref.get()).data
  } catch (error) {
    if (isDocumentMissing(error)) return null
    throw error
  }
}

/** 使用 UTC 日历做纯日期运算，避免云函数运行时 UTC 时区造成跨日偏差。 */
function parseDateKey(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''))
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const timestamp = Date.UTC(year, month - 1, day)
  const date = new Date(timestamp)
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
  return timestamp
}

function shiftDateKey(value, days) {
  const timestamp = parseDateKey(value)
  if (timestamp === null) return ''
  return new Date(timestamp + days * 86400000).toISOString().slice(0, 10)
}

function todayInShanghai(now = Date.now()) {
  return new Date(now + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10)
}

function computeSchedule(visitDate, advanceDays) {
  if (parseDateKey(visitDate) === null) return null
  const normalizedAdvanceDays = Number.isInteger(advanceDays) && advanceDays >= 0 && advanceDays <= 365
    ? advanceDays
    : null
  return {
    tripReminderDate: shiftDateKey(visitDate, -1),
    releaseReminderDate: normalizedAdvanceDays === null ? '' : shiftDateKey(visitDate, -normalizedAdvanceDays),
    advanceDays: normalizedAdvanceDays,
  }
}

function cleanRegistration(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const tripId = String(input.tripId || '').trim().slice(0, 64)
  const scenicId = String(input.scenicId || '').trim().slice(0, 64)
  const scenicName = String(input.scenicName || '').trim().slice(0, 40)
  const visitDate = String(input.visitDate || '').trim()
  const period = PERIODS.includes(input.period) ? input.period : 'all'
  const rawAdvanceDays = input.advanceDays
  const advanceDays = rawAdvanceDays === undefined || rawAdvanceDays === null
    ? null
    : Number(rawAdvanceDays)
  const schedule = computeSchedule(visitDate, advanceDays)
  if (!tripId || !scenicId || !scenicName || !schedule) return null
  const acceptedTypes = Array.from(new Set(
    (Array.isArray(input.acceptedTypes) ? input.acceptedTypes : []).filter((type) => REMINDER_TYPES.includes(type)),
  ))
  return { tripId, scenicId, scenicName, visitDate, period, acceptedTypes, ...schedule }
}

async function ensureCollections() {
  await db.createCollection('shijing_reminders').catch(() => null)
  await db.createCollection('shijing_reminder_logs').catch(() => null)
}

async function register(identity, input) {
  const cleaned = cleanRegistration(input)
  if (!cleaned) return fail('INVALID_REMINDER', '行程提醒参数无效')
  await ensureCollections()
  const { openid, sourceAppid } = identity
  const id = hashId(openid, cleaned.tripId)
  const ref = reminders.doc(id)
  const existing = await getOptional(ref)
  const enabledTypes = Array.from(new Set([
    ...(existing && Array.isArray(existing.enabledTypes) ? existing.enabledTypes : []),
    ...cleaned.acceptedTypes,
  ].filter((type) => REMINDER_TYPES.includes(type))))
  const now = Date.now()
  await ref.set({ data: {
    _openid: openid,
    // 用于环境共享下的定时云调用；只取微信上下文，不接受客户端传值。
    sourceAppid,
    tripId: cleaned.tripId,
    scenicId: cleaned.scenicId,
    scenicName: cleaned.scenicName,
    visitDate: cleaned.visitDate,
    period: cleaned.period,
    advanceDays: cleaned.advanceDays,
    tripReminderDate: cleaned.tripReminderDate,
    releaseReminderDate: cleaned.releaseReminderDate,
    enabledTypes,
    active: true,
    createdAt: existing ? Number(existing.createdAt) || now : now,
    updatedAt: now,
    cancelledAt: 0,
  } })
  return ok({ id, enabledTypes, tripReminderDate: cleaned.tripReminderDate, releaseReminderDate: cleaned.releaseReminderDate })
}

async function cancel(openid, rawTripId) {
  const tripId = String(rawTripId || '').trim().slice(0, 64)
  if (!tripId) return fail('INVALID_TRIP_ID', '行程 ID 无效')
  await ensureCollections()
  const ref = reminders.doc(hashId(openid, tripId))
  const existing = await getOptional(ref)
  if (!existing) return ok({ cancelled: false })
  const now = Date.now()
  await ref.update({ data: { active: false, cancelledAt: now, updatedAt: now } })
  return ok({ cancelled: true })
}

function isTimerEvent(event) {
  return !!event && (
    event.Type === 'Timer' ||
    event.type === 'timer' ||
    event.TriggerName === TRIGGER_NAME ||
    event.triggerName === TRIGGER_NAME
  )
}

function templateIdOf(type) {
  return type === 'tripReminder'
    ? String(process.env.TRIP_REMINDER_TEMPLATE_ID || '').trim()
    : String(process.env.RELEASE_REMINDER_TEMPLATE_ID || '').trim()
}

/**
 * 环境共享时以登记来源小程序的身份发起云调用；普通环境或旧数据则回退到当前环境身份。
 * 来源 AppID 只来自 getWXContext，客户端无法伪造。
 */
function openapiFor(reminder) {
  if (reminder.sourceAppid && typeof cloud.openapi === 'function') {
    return cloud.openapi({ appid: reminder.sourceAppid })
  }
  return cloud.openapi
}

function miniprogramState() {
  const value = String(process.env.REMINDER_MINIPROGRAM_STATE || '').trim()
  return ['developer', 'trial', 'formal'].includes(value) ? value : 'formal'
}

/** 模板字段可用环境变量覆盖，避免后台模板关键词编号不同时必须改代码。 */
function templateField(envName, fallback) {
  const value = String(process.env[envName] || '').trim()
  return /^(thing|date|time|phrase|character_string|number)\d+$/.test(value) ? value : fallback
}

function messageData(reminder, type) {
  if (type === 'tripReminder') {
    return {
      [templateField('TRIP_REMINDER_SCENIC_KEY', 'thing1')]: { value: reminder.scenicName.slice(0, 20) },
      [templateField('TRIP_REMINDER_DATE_KEY', 'date2')]: { value: reminder.visitDate },
      [templateField('TRIP_REMINDER_PERIOD_KEY', 'thing3')]: { value: PERIOD_LABELS[reminder.period] || '全天' },
      [templateField('TRIP_REMINDER_NOTE_KEY', 'thing4')]: { value: '请提前确认开放及预约信息' },
    }
  }
  return {
    [templateField('RELEASE_REMINDER_SCENIC_KEY', 'thing1')]: { value: reminder.scenicName.slice(0, 20) },
    [templateField('RELEASE_REMINDER_DATE_KEY', 'date2')]: { value: reminder.releaseReminderDate },
    [templateField('RELEASE_REMINDER_VISIT_DATE_KEY', 'date3')]: { value: reminder.visitDate },
    [templateField('RELEASE_REMINDER_NOTE_KEY', 'thing4')]: { value: '建议查看景区官方预约渠道' },
  }
}

async function readAllDue(type, dateKey) {
  const dateField = type === 'tripReminder' ? 'tripReminderDate' : 'releaseReminderDate'
  const list = []
  const limit = 100
  for (let offset = 0; offset < 2000; offset += limit) {
    const result = await reminders.where({ active: true, [dateField]: dateKey }).skip(offset).limit(limit).get()
    list.push(...result.data)
    if (result.data.length < limit) break
  }
  return list.filter((item) => Array.isArray(item.enabledTypes) && item.enabledTypes.includes(type))
}

/** 发送前以云端行程快照为准，旧客户端不调用 reminder.cancel 也能避免误发。 */
async function tripStillEligible(reminder) {
  try {
    const doc = (await userData.doc(reminder._openid).get()).data
    const trips = Array.isArray(doc.trips) ? doc.trips : []
    return trips.some((trip) => (
      trip.id === reminder.tripId &&
      trip.status !== 'done' &&
      trip.date === reminder.visitDate
    ))
  } catch (error) {
    if (!isDocumentMissing(error)) console.error('[shijingReminder] 行程复核失败', error)
    return false
  }
}

async function deactivateStale(reminder) {
  await reminders.doc(reminder._id).update({ data: {
    active: false,
    inactiveReason: 'trip_changed_or_removed',
    updatedAt: Date.now(),
  } }).catch((error) => console.error('[shijingReminder] 停用过期提醒失败', error))
}

/** 发送前原子占位；已有任何状态的同一 trip/type 日志都会阻止再次发送。 */
async function claimSend(reminder, type, dateKey) {
  const logId = hashId(reminder._openid, reminder.tripId, type)
  const outcome = await db.runTransaction(async (transaction) => {
    const ref = transaction.collection('shijing_reminder_logs').doc(logId)
    const existing = await getOptional(ref)
    if (existing) return { claimed: false, logId, status: existing.status }
    const now = Date.now()
    await ref.set({ data: {
      _openid: reminder._openid,
      reminderId: reminder._id,
      tripId: reminder.tripId,
      type,
      scheduledDate: dateKey,
      status: 'sending',
      createdAt: now,
      updatedAt: now,
    } })
    return { claimed: true, logId }
  })
  return outcome && outcome.result ? outcome.result : outcome
}

async function finishLog(logId, status, detail) {
  await reminderLogs.doc(logId).update({ data: {
    status,
    detail,
    sentAt: status === 'sent' ? Date.now() : 0,
    updatedAt: Date.now(),
  } }).catch((error) => console.error('[shijingReminder] 写入发送结果失败', error))
}

async function sendOne(reminder, type, dateKey, templateId) {
  if (!(await tripStillEligible(reminder))) {
    await deactivateStale(reminder)
    return 'stale'
  }
  const claim = await claimSend(reminder, type, dateKey)
  if (!claim.claimed) return 'duplicate'
  try {
    const result = await openapiFor(reminder).subscribeMessage.send({
      touser: reminder._openid,
      templateId,
      page: PAGE_PATH,
      data: messageData(reminder, type),
      miniprogramState: miniprogramState(),
      lang: 'zh_CN',
    })
    await finishLog(claim.logId, 'sent', {
      errCode: Number(result.errCode || result.errcode) || 0,
      errMsg: String(result.errMsg || result.errmsg || '').slice(0, 200),
      msgId: String(result.msgid || result.msgId || '').slice(0, 80),
    })
    return 'sent'
  } catch (error) {
    await finishLog(claim.logId, 'failed', {
      errCode: Number(error && (error.errCode || error.errcode)) || -1,
      errMsg: String((error && (error.errMsg || error.message)) || '发送失败').slice(0, 200),
    })
    console.error(`[shijingReminder] ${type} 发送失败`, error)
    return 'failed'
  }
}

async function sendDueReminders(dateKey = todayInShanghai()) {
  await ensureCollections()
  const summary = { date: dateKey, sent: 0, failed: 0, duplicate: 0, stale: 0, configSkipped: 0 }
  for (const type of REMINDER_TYPES) {
    const templateId = templateIdOf(type)
    if (!templateId) {
      summary.configSkipped += 1
      continue
    }
    const due = await readAllDue(type, dateKey)
    for (const reminder of due) {
      const state = await sendOne(reminder, type, dateKey, templateId)
      summary[state] += 1
    }
  }
  return summary
}

exports.main = async (event = {}) => {
  const identity = getCallerIdentity()
  try {
    if (!identity.openid && isTimerEvent(event)) return ok(await sendDueReminders())
    if (!identity.openid) return fail('NO_OPENID', '未获取到用户身份')
    if (event.action === 'register') return await register(identity, event.reminder)
    if (event.action === 'cancel') return await cancel(identity.openid, event.tripId)
    if (event.action === 'send') return fail('FORBIDDEN', '客户端不能触发批量发送')
    return fail('BAD_ACTION', '不支持的操作', `action=${event.action}`)
  } catch (error) {
    console.error('[shijingReminder] 请求失败', error)
    return fail(
      'SERVER_ERROR',
      '提醒服务暂不可用，行程保存不受影响',
      `请确认集合、索引、模板环境变量与定时触发器已配置：${error.message}`,
    )
  }
}

/** 仅供本地回归脚本调用，不经过云函数入口，不暴露给小程序客户端。 */
exports._test = { computeSchedule, todayInShanghai, sendDueReminders }
