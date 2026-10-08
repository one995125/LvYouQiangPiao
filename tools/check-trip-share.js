/**
 * 行程只读分享回归检查。
 * 使用内存数据库，不访问微信、不创建真实分享、不读写云端集合。
 */
const assert = require('assert')
const fs = require('fs')
const Module = require('module')
const path = require('path')

const root = path.resolve(__dirname, '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const functionCode = read('cloudfunctions/shijingTripShare/index.js')
const tripsCode = read('miniprogram/pages/trips/index.ts')
const tripsWxml = read('miniprogram/pages/trips/index.wxml')
const sharePageCode = read('miniprogram/packageExtra/pages/trip-share/index.ts')
const sharePageWxml = read('miniprogram/packageExtra/pages/trip-share/index.wxml')
const appConfig = JSON.parse(read('miniprogram/app.json'))

assert(functionCode.includes('crypto.randomBytes(24)'), 'shareId 必须使用至少 192 位加密随机数')
assert(functionCode.includes('event.includeNotes === true'), '备注必须严格按显式布尔值包含')
assert(functionCode.includes('event.includeChecklist === true'), '清单必须严格按显式布尔值包含')
assert(tripsCode.includes('syncUserDataOnAppShow()'), '生成分享前未续接既有云同步')
assert(tripsCode.includes('if (!profile?.cloud)'), '未登录分享缺少友好拦截')
assert(tripsWxml.includes('open-type="share"'), '生成快照后缺少微信原生分享按钮')
assert(tripsWxml.includes('checked="{{shareIncludeNotes}}"') && tripsWxml.includes('checked="{{shareIncludeChecklist}}"'), '私密字段缺少默认关闭的显式选项')
assert(sharePageCode.includes("error.code !== 'SHARE_UNAVAILABLE'"), '失效快照未转换为统一空态')
assert(sharePageWxml.includes('这份行程暂时看不到'), '分享页缺少友好失效空态')
const extraPackage = appConfig.subPackages.find((item) => item.root === 'packageExtra')
assert(extraPackage && extraPackage.pages.includes('pages/trip-share/index'), 'app.json 未在扩展分包注册行程分享页')

const collections = new Map()
const docsOf = (name) => {
  if (!collections.has(name)) collections.set(name, new Map())
  return collections.get(name)
}
const clone = (value) => JSON.parse(JSON.stringify(value))
const missingError = () => {
  const error = new Error('document does not exist')
  error.code = 'DATABASE_DOCUMENT_NOT_EXIST'
  return error
}
const matches = (doc, query) => Object.entries(query).every(([key, value]) => doc[key] === value)
const applyUpdate = (current, patch) => {
  const next = { ...current }
  Object.entries(patch).forEach(([key, value]) => {
    if (value && typeof value === 'object' && value.__inc !== undefined) {
      next[key] = (Number(next[key]) || 0) + Number(value.__inc)
    } else {
      next[key] = value
    }
  })
  return next
}
const collection = (name) => {
  const docs = docsOf(name)
  return {
    doc(id) {
      return {
        async get() {
          if (!docs.has(id)) throw missingError()
          return { data: clone(docs.get(id)) }
        },
        async set({ data }) {
          docs.set(id, clone({ _id: id, ...data }))
          return {}
        },
        async update({ data }) {
          if (!docs.has(id)) throw missingError()
          docs.set(id, clone(applyUpdate(docs.get(id), data)))
          return {}
        },
      }
    },
    where(query) {
      let size = 20
      const chain = {
        limit(value) { size = value; return chain },
        async get() {
          return { data: clone(Array.from(docs.values()).filter((doc) => matches(doc, query)).slice(0, size)) }
        },
      }
      return chain
    },
  }
}

const db = {
  command: { inc: (value) => ({ __inc: Number(value) }) },
  collection,
  async createCollection(name) { docsOf(name); return {} },
}
let currentOpenid = 'owner-openid'
const cloudMock = {
  DYNAMIC_CURRENT_ENV: 'test',
  init() {},
  database() { return db },
  getWXContext() { return currentOpenid ? { FROM_OPENID: currentOpenid } : {} },
}

const originalLoad = Module._load
Module._load = function load(request, parent, isMain) {
  if (request === 'wx-server-sdk') return cloudMock
  return originalLoad.call(this, request, parent, isMain)
}
const tripShareFunction = require('../cloudfunctions/shijingTripShare/index.js')

async function main() {
  docsOf('shijing_user_data').set('owner-openid', {
    _id: 'owner-openid',
    trips: [{
      id: 'trip-a', scenicId: 'scenic-a', scenicName: '测试景区', date: '2026-11-03',
      period: 'morning', status: 'pending', note: '私密备注', checklist: ['身份证', '雨伞'],
      ticket: { type: 'none', name: '' }, booking: '私密预约规则', createdAt: 1, updatedAt: 2,
    }],
  })

  const first = await tripShareFunction.main({ action: 'create' })
  const second = await tripShareFunction.main({ action: 'create' })
  assert(first.ok && second.ok, '默认分享创建失败')
  assert(/^[a-f0-9]{48}$/.test(first.data.shareId), 'shareId 格式不符合 192 位随机标识')
  assert.notStrictEqual(first.data.shareId, second.data.shareId, '两次分享生成了相同 shareId')

  currentOpenid = 'viewer-openid'
  let result = await tripShareFunction.main({ action: 'get', shareId: first.data.shareId })
  assert(result.ok, '同行人无法读取有效快照')
  const serialized = JSON.stringify(result.data)
  assert(!serialized.includes('owner-openid') && !serialized.includes('_openid'), '公开响应泄露分享者 openid')
  assert(!Object.hasOwn(result.data.trips[0], 'note'), '默认分享错误包含备注')
  assert(!Object.hasOwn(result.data.trips[0], 'checklist'), '默认分享错误包含清单')
  assert(!serialized.includes('scenic-a') && !serialized.includes('私密预约规则'), '公开响应泄露非白名单行程字段')

  currentOpenid = 'owner-openid'
  const privateShare = await tripShareFunction.main({ action: 'create', includeNotes: true, includeChecklist: true })
  assert(privateShare.ok, '勾选私密字段后分享创建失败')
  currentOpenid = 'viewer-openid'
  result = await tripShareFunction.main({ action: 'get', shareId: privateShare.data.shareId })
  assert.strictEqual(result.data.trips[0].note, '私密备注', '显式勾选后备注未包含')
  assert.deepStrictEqual(result.data.trips[0].checklist, ['身份证', '雨伞'], '显式勾选后清单未包含')

  // 失效快照与不存在、撤销统一返回 SHARE_UNAVAILABLE，页面据此展示同一友好空态。
  const firstDoc = docsOf('shijing_trip_shares').get(first.data.shareId)
  docsOf('shijing_trip_shares').set(first.data.shareId, { ...firstDoc, expiresAt: Date.now() - 1 })
  result = await tripShareFunction.main({ action: 'get', shareId: first.data.shareId })
  assert(!result.ok && result.code === 'SHARE_UNAVAILABLE', '过期快照未进入统一失效分支')

  result = await tripShareFunction.main({ action: 'revoke', shareId: privateShare.data.shareId })
  assert(!result.ok && result.code === 'FORBIDDEN', '非分享者可以越权撤销快照')
  currentOpenid = 'owner-openid'
  result = await tripShareFunction.main({ action: 'revoke', shareId: privateShare.data.shareId })
  assert(result.ok && result.data.revoked, '分享者本人撤销失败')
  currentOpenid = 'viewer-openid'
  result = await tripShareFunction.main({ action: 'get', shareId: privateShare.data.shareId })
  assert(!result.ok && result.code === 'SHARE_UNAVAILABLE', '撤销后快照仍可读取')

  const viewedDoc = docsOf('shijing_trip_shares').get(first.data.shareId)
  assert.strictEqual(viewedDoc.viewCount, 1, '查看次数没有按打开次数累计')

  console.log('行程分享检查通过：随机 shareId、字段最小化、私密字段显式同意、失效空态、查看统计与撤销权限。')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
}).finally(() => {
  Module._load = originalLoad
})
