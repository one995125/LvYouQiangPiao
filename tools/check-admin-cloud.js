/** 管理员云函数的无云端回归测试：不会触碰真实景区数据。 */
const Module = require('module')
const assert = require('assert')

const docs = new Map([['scenic-1', {
  _id: 'scenic-1', name: '测试景区', province: 'shanxi', city: '大同', booking: '原规则',
  ticket: { type: 'none', name: '待核验' }, location: { lat: 10, lng: 20 }, address: '原地址',
  unrelatedField: '必须保留', contentRevision: 0,
}]])
let caller = 'admin-test'
let failRead = false
const REMOVE_FIELD = Symbol('remove-field')

const docRef = (id) => ({
  async get() {
    if (failRead) throw new Error('simulated network failure')
    if (!docs.has(id)) {
      const error = new Error('document does not exist')
      error.code = 'DATABASE_DOCUMENT_NOT_EXIST'
      throw error
    }
    return { data: { ...docs.get(id) } }
  },
  async update({ data }) {
    const next = { ...docs.get(id) }
    Object.entries(data).forEach(([key, value]) => {
      if (value === REMOVE_FIELD) delete next[key]
      else next[key] = value
    })
    docs.set(id, next)
  },
  async set({ data }) {
    docs.set(id, { _id: id, ...data })
  },
})
const collection = {
  doc: docRef,
  field() { return this },
  orderBy() { return this },
  skip() { return this },
  limit() { return this },
  async get() { return { data: Array.from(docs.values()) } },
}
const db = {
  command: { remove: () => REMOVE_FIELD },
  collection: () => collection,
  async createCollection() {},
  async runTransaction(callback) { return callback({ collection: () => collection }) },
}
const cloudMock = {
  DYNAMIC_CURRENT_ENV: 'test',
  init() {},
  database: () => db,
  getWXContext: () => ({ FROM_OPENID: caller, OPENID: 'wrong-resource-openid' }),
}
const originalLoad = Module._load
Module._load = function load(request, parent, isMain) {
  if (request === 'wx-server-sdk') return cloudMock
  return originalLoad.call(this, request, parent, isMain)
}
const admin = require('../cloudfunctions/shijingAdmin/index.js')
const initData = require('../cloudfunctions/shijingInitData/index.js')
Module._load = originalLoad

async function main() {
  delete process.env.ADMIN_OPENIDS
  assert.strictEqual((await admin.main({ action: 'check' })).code, 'NO_ADMIN')
  process.env.ADMIN_OPENIDS = 'admin-test'
  caller = 'ordinary-user'
  assert.strictEqual((await admin.main({ action: 'list' })).code, 'FORBIDDEN')
  assert.strictEqual((await admin.main({ action: 'get', id: 'scenic-1' })).code, 'FORBIDDEN')
  assert.strictEqual((await admin.main({ action: 'save', id: 'scenic-1' })).code, 'FORBIDDEN')
  caller = 'admin-test'
  assert.strictEqual((await admin.main({ action: 'check' })).data.authorized, true)
  assert.strictEqual((await admin.main({ action: 'get', id: 'scenic-1' })).data.revision, 0)
  const payload = {
    action: 'save', id: 'scenic-1', baseRevision: 0, booking: '预约规则以公告为准',
    officialEntries: [{ id: 'ticket-1', purpose: 'ticket', type: 'miniprogram', name: '官方票务',
      shortLink: '#小程序://官方票务/test', verified: true, sourceName: '景区官网', checkedAt: '2026-10-01' }],
    sources: [{ id: 'source-1', name: '景区官网', url: 'https://example.org', checkedAt: '2026-10-01' }],
    reservation: { required: true, advanceDays: 7, documents: ['身份证'], releaseTime: '08:00' },
    notices: [{ id: 'notice-1', type: 'info', title: '测试公告', content: '仅供测试', sourceName: '景区官网', checkedAt: '2026-10-01' }],
  }
  let result = await admin.main(payload)
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.data.revision, 1)
  assert.strictEqual(docs.get('scenic-1').unrelatedField, '必须保留')
  assert.strictEqual(docs.get('scenic-1').ticket.name, '官方票务')
  assert.deepStrictEqual(docs.get('scenic-1').location, { lat: 10, lng: 20 }, '旧客户端保存时不应清空位置')
  assert.strictEqual(docs.get('scenic-1').address, '原地址', '旧客户端保存时不应清空地址')
  result = await admin.main(payload)
  assert.strictEqual(result.code, 'SYNC_CONFLICT')
  assert.strictEqual(docs.get('scenic-1').contentRevision, 1)
  result = await admin.main({ ...payload, baseRevision: 1, location: { lat: 90.0001, lng: 20 }, address: '非法位置' })
  assert.strictEqual(result.code, 'VALIDATION_ERROR')
  result = await admin.main({ ...payload, baseRevision: 1, location: { lat: -90, lng: 180 }, address: '边界坐标' })
  assert.strictEqual(result.ok, true)
  assert.deepStrictEqual(docs.get('scenic-1').location, { lat: -90, lng: 180 })
  result = await admin.main({ ...payload, baseRevision: 2, location: null, address: '' })
  assert.strictEqual(result.ok, true)
  assert.strictEqual(Object.prototype.hasOwnProperty.call(docs.get('scenic-1'), 'location'), false, '管理端清空位置未生效')
  assert.strictEqual(Object.prototype.hasOwnProperty.call(docs.get('scenic-1'), 'address'), false, '管理端清空地址未生效')
  result = await admin.main({ ...payload, baseRevision: 3, officialEntries: [{ ...payload.officialEntries[0], checkedAt: '' }] })
  assert.strictEqual(result.code, 'VALIDATION_ERROR')
  result = await admin.main({ ...payload, baseRevision: 3, officialEntries: [{ ...payload.officialEntries[0], shortLink: '', appId: 'wx1234567890abcdef', path: '' }] })
  assert.strictEqual(result.code, 'VALIDATION_ERROR')
  failRead = true
  const originalError = console.error
  console.error = () => {} // 预期的模拟数据库故障，不污染 npm run check 输出。
  try {
    result = await admin.main({ ...payload, baseRevision: 3 })
  } finally {
    console.error = originalError
  }
  assert.strictEqual(result.code, 'DB_ERROR')
  assert.strictEqual(docs.get('scenic-1').contentRevision, 3)
  failRead = false
  result = await initData.main({ collection: 'scenics', docs: [{ _id: 'scenic-1', name: '绝不能覆盖' }] })
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.data.skipped, 1)
  assert.strictEqual(docs.get('scenic-1').name, '测试景区')
  result = await initData.main({ collection: 'scenics', docs: [{ _id: 'scenic-new', name: '新增景区' }] })
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.data.written, 1)
  failRead = true
  result = await initData.main({ collection: 'scenics', docs: [{ _id: 'scenic-1', name: '读取失败不覆盖' }] })
  assert.strictEqual(result.code, 'DB_ERROR')
  assert.strictEqual(docs.get('scenic-1').name, '测试景区')
  console.log('景区维护协议：权限、版本冲突、局部更新、初始化不覆盖及读取失败保护通过')
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
