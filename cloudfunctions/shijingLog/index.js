/**
 * 云函数 shijingLog：接收客户端已经脱敏的错误摘要并再次清洗后写入 shijing_logs。
 * - openid 只从微信上下文读取并用于当前实例内限频，绝不写入日志文档。
 * - 单调用方每分钟最多 5 条、单实例每分钟最多 30 条、集合全局每分钟最多 200 条。
 * - 正文最多 800 字；任何疑似身份、联系方式、令牌、用户文本字段都会再次脱敏。
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const COLLECTION = 'shijing_logs'
const logs = db.collection(COLLECTION)

const MAX_MESSAGE_LENGTH = 800
const CALLER_LIMIT = 5
const INSTANCE_LIMIT = 30
const GLOBAL_LIMIT = 200
const WINDOW_MS = 60 * 1000
const SOURCES = ['app_error', 'unhandled_rejection', 'page_error']
const ok = (data) => ({ ok: true, data })
const fail = (code, message, debug) => ({ ok: false, code, message, debug })
const callerWindows = new Map()
const instanceWrites = []

const callerOpenid = () => {
  const context = cloud.getWXContext()
  return context.FROM_OPENID || context.OPENID || ''
}

const cleanName = (value, fallback) => {
  const result = String(value || '').toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 40)
  return result || fallback
}

const sanitizeMessage = (input) => String(input || '')
  .replace(/(openid|open_id|nickname|nick_name|avatarurl|avatar_url|note|checklist|keyword|search_text|token|authorization)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^,;\s}]+)/gi, '$1=[redacted]')
  .replace(/\b(?:o|wx)[A-Za-z0-9_-]{18,}\b/g, '[redacted-id]')
  .replace(/\b1[3-9]\d{9}\b/g, '[redacted-phone]')
  .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
  .replace(/([A-Za-z]:\\Users\\)[^\\\s]+/gi, '$1[redacted-user]')
  .replace(/(https?:\/\/[^\s?#]+)\?[^\s]*/gi, '$1?[redacted-query]')
  .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]')
  .trim()
  .slice(0, MAX_MESSAGE_LENGTH)

const minuteKeyOf = (timestamp) => Math.floor(timestamp / WINDOW_MS)

const prune = (list, now) => {
  while (list.length && list[0] <= now - WINDOW_MS) list.shift()
}

const allowWrite = (openid, now) => {
  prune(instanceWrites, now)
  if (instanceWrites.length >= INSTANCE_LIMIT) return false
  const callerList = callerWindows.get(openid) || []
  prune(callerList, now)
  if (callerList.length >= CALLER_LIMIT) {
    callerWindows.set(openid, callerList)
    return false
  }
  callerList.push(now)
  instanceWrites.push(now)
  callerWindows.set(openid, callerList)
  return true
}

const cleanLog = (input, now = Date.now()) => {
  const value = input && typeof input === 'object' ? input : {}
  const source = SOURCES.includes(value.source) ? value.source : 'app_error'
  const message = sanitizeMessage(value.message)
  if (!message) return null
  return {
    schema: 1,
    source,
    page: cleanName(value.page, 'unknown'),
    errorType: cleanName(value.errorType, 'unknown_error'),
    message,
    minuteKey: minuteKeyOf(now),
    createdAt: now,
  }
}

exports.main = async (event = {}) => {
  if (event.action !== 'write') return fail('BAD_ACTION', '不支持的操作')
  const openid = callerOpenid()
  if (!openid) return ok({ accepted: false, reason: 'no_identity' })
  const now = Date.now()
  const log = cleanLog(event.log, now)
  if (!log) return ok({ accepted: false, reason: 'empty' })
  if (!allowWrite(openid, now)) return ok({ accepted: false, reason: 'rate_limited' })

  try {
    await db.createCollection(COLLECTION).catch(() => null)
    const count = await logs.where({ minuteKey: log.minuteKey }).count()
    if (count.total >= GLOBAL_LIMIT) return ok({ accepted: false, reason: 'global_rate_limited' })
    await logs.add({ data: log })
    return ok({ accepted: true })
  } catch (error) {
    // 不回显客户端正文；debug 只包含再次清洗并截断后的数据库错误摘要。
    return fail('SERVER_ERROR', '日志暂未记录', sanitizeMessage(error && error.message).slice(0, 160))
  }
}

exports._test = { sanitizeMessage, cleanLog, allowWrite, minuteKeyOf }
