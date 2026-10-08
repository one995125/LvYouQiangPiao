/**
 * 行程订阅提醒回归检查。
 * 使用内存数据库和模拟 subscribeMessage.send，不访问微信、不发送真实消息、不修改云端数据。
 */
const assert = require('assert')
const fs = require('fs')
const Module = require('module')
const path = require('path')

const root = path.resolve(__dirname, '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const configCode = read('miniprogram/constants/config.ts')
const serviceCode = read('miniprogram/services/reminder.ts')
const sheetCode = read('miniprogram/components/trip-sheet/index.ts')
const tripsCode = read('miniprogram/pages/trips/index.ts')
const functionConfig = JSON.parse(read('cloudfunctions/shijingReminder/config.json'))

// 客户端静态保护：模板默认留空、空配置直接返回，且授权紧跟用户保存手势。
assert(/SUBSCRIBE_TEMPLATE_IDS\s*=\s*\{\s*tripReminder:\s*'',\s*releaseReminder:\s*''/s.test(configCode), '模板 ID 默认值必须为空')
assert(serviceCode.includes('if (!entries.length) return'), '模板为空时未静默跳过')
assert(serviceCode.includes('wx.requestSubscribeMessage({ tmplIds: templateIds })'), '保存行程后未请求订阅授权')
assert(serviceCode.includes("console.info('[reminder] 订阅授权未完成"), '拒绝或授权失败未静默记录')
assert(sheetCode.indexOf('saveTrip({') < sheetCode.indexOf('requestAndRegisterTripReminder(trip, scenic)'), '订阅请求必须在行程保存成功后触发')
assert(tripsCode.includes("if (nextStatus === 'done') void cancelTripReminder(t.id)"), '标记已出行未取消提醒')
assert(tripsCode.indexOf('removeTrip(t.id)') < tripsCode.indexOf('void cancelTripReminder(t.id)', tripsCode.indexOf('removeTrip(t.id)')), '删除行程后未取消提醒')
assert(functionConfig.permissions.openapi.includes('subscribeMessage.send'), '云函数缺少订阅消息发送权限')
const trigger = functionConfig.triggers.find((item) => item.name === 'shijing-reminder-daily-0900')
assert(trigger && trigger.type === 'timer' && trigger.config === '0 0 9 * * * *', '缺少每日 9:00 定时触发器')

const collections = new Map()
const collectionDocs = (name) => {
  if (!collections.has(name)) collections.set(name, new Map())
  return collections.get(name)
}

const missingError = () => {
  const error = new Error('document does not exist')
  error.code = 'DATABASE_DOCUMENT_NOT_EXIST'
  return error
}

const makeCollection = (name) => {
  const docs = collectionDocs(name)
  return {
    doc(id) {
      return {
        async get() {
          if (!docs.has(id)) throw missingError()
          return { data: JSON.parse(JSON.stringify(docs.get(id))) }
        },
        async set({ data }) {
          docs.set(id, JSON.parse(JSON.stringify({ _id: id, ...data })))
          return {}
        },
        async update({ data }) {
          if (!docs.has(id)) throw missingError()
          docs.set(id, JSON.parse(JSON.stringify({ ...docs.get(id), ...data })))
          return {}
        },
      }
    },
    where(query) {
      let offset = 0
      let size = 20
      const chain = {
        skip(value) { offset = value; return chain },
        limit(value) { size = value; return chain },
        async get() {
          const list = Array.from(docs.values()).filter((doc) => (
            Object.entries(query).every(([key, value]) => doc[key] === value)
          ))
          return { data: JSON.parse(JSON.stringify(list.slice(offset, offset + size))) }
        },
      }
      return chain
    },
  }
}

const db = {
  collection: makeCollection,
  async createCollection(name) { collectionDocs(name); return {} },
  async runTransaction(callback) {
    return callback({ collection: makeCollection })
  },
}

let currentOpenid = 'openid-test'
let currentAppid = 'wx-source-test'
const sentMessages = []
const openapiTargets = []
const subscribeMessage = {
  async send(input) {
    sentMessages.push(JSON.parse(JSON.stringify(input)))
    return { errCode: 0, errMsg: 'ok', msgid: `msg-${sentMessages.length}` }
  },
}
const openapi = ({ appid } = {}) => {
  openapiTargets.push(appid || '')
  return { subscribeMessage }
}
openapi.subscribeMessage = subscribeMessage
const cloudMock = {
  DYNAMIC_CURRENT_ENV: 'test',
  init() {},
  database() { return db },
  getWXContext() {
    return currentOpenid ? { FROM_OPENID: currentOpenid, FROM_APPID: currentAppid } : {}
  },
  openapi,
}

const originalLoad = Module._load
Module._load = function load(request, parent, isMain) {
  if (request === 'wx-server-sdk') return cloudMock
  return originalLoad.call(this, request, parent, isMain)
}

process.env.TRIP_REMINDER_TEMPLATE_ID = 'trip-template-test'
process.env.RELEASE_REMINDER_TEMPLATE_ID = 'release-template-test'
const reminderFunction = require('../cloudfunctions/shijingReminder/index.js')

async function main() {
  const schedule = reminderFunction._test.computeSchedule('2026-10-10', 3)
  assert.deepStrictEqual(schedule, {
    tripReminderDate: '2026-10-09',
    releaseReminderDate: '2026-10-07',
    advanceDays: 3,
  }, '服务端提醒日期计算错误')
  assert.strictEqual(reminderFunction._test.computeSchedule('2026-02-30', 3), null, '非法日期未拒绝')

  let result = await reminderFunction.main({
    action: 'register',
    reminder: {
      tripId: 'trip-a',
      scenicId: 'scenic-a',
      scenicName: '测试景区',
      visitDate: '2026-10-10',
      period: 'morning',
      advanceDays: 3,
      // 伪造的客户端结论必须被忽略。
      tripReminderDate: '2099-01-01',
      releaseReminderDate: '2099-01-01',
      acceptedTypes: ['tripReminder', 'releaseReminder'],
    },
  })
  assert(result.ok, '提醒登记失败')
  const registration = Array.from(collectionDocs('shijing_reminders').values())[0]
  assert.strictEqual(registration._openid, 'openid-test', '提醒未绑定调用方 openid')
  assert.strictEqual(registration.sourceAppid, 'wx-source-test', '共享环境来源 AppID 未由微信上下文绑定')
  assert.strictEqual(registration.tripReminderDate, '2026-10-09', '服务端错误信任客户端出行提醒日期')
  assert.strictEqual(registration.releaseReminderDate, '2026-10-07', '服务端错误信任客户端预约提醒日期')

  collectionDocs('shijing_user_data').set('openid-test', {
    _id: 'openid-test',
    trips: [{ id: 'trip-a', date: '2026-10-10', status: 'pending' }],
  })

  let summary = await reminderFunction._test.sendDueReminders('2026-10-07')
  assert.strictEqual(summary.sent, 1, '建议预约日提醒未发送')
  assert.strictEqual(sentMessages.length, 1, '建议预约日发送数量错误')
  assert.strictEqual(openapiTargets[0], 'wx-source-test', '共享环境发送未使用登记来源 AppID')

  summary = await reminderFunction._test.sendDueReminders('2026-10-07')
  assert.strictEqual(summary.duplicate, 1, '重复定时触发未命中幂等标记')
  assert.strictEqual(sentMessages.length, 1, '同一行程同一类型发生重复发送')

  summary = await reminderFunction._test.sendDueReminders('2026-10-09')
  assert.strictEqual(summary.sent, 1, '出行前一天提醒未发送')
  assert.strictEqual(sentMessages.length, 2, '两类提醒未各发送一次')

  result = await reminderFunction.main({ action: 'send' })
  assert(!result.ok && result.code === 'FORBIDDEN', '客户端可以错误触发批量发送')

  result = await reminderFunction.main({ action: 'cancel', tripId: 'trip-a' })
  assert(result.ok && result.data.cancelled, '取消提醒失败')
  assert.strictEqual(registration.active, true, '测试快照不应被原地修改')
  assert.strictEqual(Array.from(collectionDocs('shijing_reminders').values())[0].active, false, '取消后登记仍为 active')

  // 无 advanceDays 时只计算出行提醒，不生成预约日。
  result = await reminderFunction.main({
    action: 'register',
    reminder: {
      tripId: 'trip-b', scenicId: 'scenic-b', scenicName: '无预约规则景区',
      visitDate: '2026-11-02', period: 'all', acceptedTypes: ['tripReminder'],
    },
  })
  assert(result.ok && result.data.releaseReminderDate === '', '无 advanceDays 的行程错误生成预约提醒')

  // 即使旧客户端没有调用 cancel，云端行程已完成也必须在发送前停用提醒。
  collectionDocs('shijing_user_data').set('openid-test', {
    _id: 'openid-test',
    trips: [{ id: 'trip-b', date: '2026-11-02', status: 'done' }],
  })
  summary = await reminderFunction._test.sendDueReminders('2026-11-01')
  assert.strictEqual(summary.stale, 1, '已出行的旧客户端行程未被发送前复核拦截')
  assert.strictEqual(sentMessages.length, 2, '已出行行程仍发送了提醒')

  // 不同调用方无法通过 tripId 取消其他用户的提醒。
  currentOpenid = 'openid-other'
  result = await reminderFunction.main({ action: 'cancel', tripId: 'trip-b' })
  assert(result.ok && result.data.cancelled === false, '取消接口发生跨 openid 操作')

  console.log('订阅提醒检查通过：模板空值保护、用户手势授权、服务端日期计算、openid/AppID 隔离、取消、旧客户端兜底及发送幂等。')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
}).finally(() => {
  Module._load = originalLoad
  delete process.env.TRIP_REMINDER_TEMPLATE_ID
  delete process.env.RELEASE_REMINDER_TEMPLATE_ID
})
