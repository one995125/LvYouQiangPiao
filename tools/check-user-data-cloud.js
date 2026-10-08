/**
 * shijingUserData 云函数协议回归检查。
 * 使用内存数据库验证关键安全不变量，不访问真实云环境、不会修改生产数据。
 */
const Module = require('module')
const fs = require('fs')
const path = require('path')

// 客户端收藏上限必须与线上同步协议一致，避免第 501 条在服务端被裁剪。
const clientConfig = fs.readFileSync(path.join(__dirname, '../miniprogram/constants/config.ts'), 'utf8')
const serverCode = fs.readFileSync(path.join(__dirname, '../cloudfunctions/shijingUserData/index.js'), 'utf8')
const clientLimit = Number(clientConfig.match(/MAX_SYNC_FAVORITES\s*=\s*(\d+)/)?.[1])
const serverLimit = Number(serverCode.match(/MAX_ITEMS\s*=\s*(\d+)/)?.[1])
if (!clientLimit || clientLimit !== serverLimit) throw new Error('客户端收藏上限与云函数 MAX_ITEMS 不一致')
const clientFootprintLimit = Number(clientConfig.match(/MAX_SYNC_FOOTPRINTS\s*=\s*(\d+)/)?.[1])
const serverFootprintLimit = Number(serverCode.match(/MAX_FOOTPRINTS\s*=\s*(\d+)/)?.[1])
if (!clientFootprintLimit || clientFootprintLimit !== serverFootprintLimit) {
  throw new Error('客户端足迹上限与云函数 MAX_FOOTPRINTS 不一致')
}
const clientTripLimit = Number(clientConfig.match(/MAX_SYNC_TRIPS\s*=\s*(\d+)/)?.[1])
const clientTombstoneLimit = Number(clientConfig.match(/MAX_SYNC_TOMBSTONES\s*=\s*(\d+)/)?.[1])
if (clientTripLimit !== serverLimit || clientTombstoneLimit !== serverLimit) {
  throw new Error('客户端行程/墓碑上限与云函数 MAX_ITEMS 不一致')
}

const docs = new Map()
let failReads = false

const docRef = (id) => ({
  async get() {
    if (!docs.has(id)) {
      const error = new Error('document does not exist')
      error.code = 'DATABASE_DOCUMENT_NOT_EXIST'
      throw error
    }
    return { data: docs.get(id) }
  },
  async set({ data }) {
    docs.set(id, JSON.parse(JSON.stringify(data)))
    return {}
  },
})

const collection = {
  doc: docRef,
  where(query) {
    return {
      limit() {
        return {
          async get() {
            if (failReads) throw new Error('simulated database outage')
            return { data: docs.has(query._id) ? [docs.get(query._id)] : [] }
          },
        }
      },
    }
  },
}

const databaseInstance = {
  collection: () => collection,
  async runTransaction(callback) {
    return callback({ collection: () => collection })
  },
}

function database() {
  return databaseInstance
}
database.command = {}

const cloudMock = {
  DYNAMIC_CURRENT_ENV: 'test',
  init() {},
  database,
  getWXContext() {
    return { OPENID: 'openid-test' }
  },
}

const originalLoad = Module._load
Module._load = function load(request, parent, isMain) {
  if (request === 'wx-server-sdk') return cloudMock
  return originalLoad.call(this, request, parent, isMain)
}

const userData = require('../cloudfunctions/shijingUserData/index.js')

async function main() {
  let result = await userData.main({ action: 'get', schema: 2 })
  if (!result.ok || result.data.revision !== 0 || !Number.isFinite(result.data.serverTime)) {
    throw new Error('空文档基线读取或服务端时间返回失败')
  }

  result = await userData.main({
    action: 'save',
    schema: 2,
    baseRevision: 0,
    favorites: [{ id: 'scenic:a', targetId: 'a', createdAt: 100 }],
    footprints: [
      { id: 'a', scenicId: 'a', scenicName: '旧名称', province: 'shanxi', visitedAt: 100 },
      { id: 'a', scenicId: 'a', scenicName: '测试景区', province: 'shanxi', visitedAt: 250 },
    ],
    footprintClearedAt: 0,
    trips: [
      {
        id: 'trip:a',
        scenicId: 'a',
        scenicName: '测试景区',
        date: '2026-10-08',
        period: 'morning',
        status: 'pending',
        checklist: ['身份证件', '预约凭证'],
        createdAt: 100,
        updatedAt: 100,
      },
    ],
    favoriteTombstones: [{ id: 'scenic:a', deletedAt: 200 }],
    tripTombstones: [],
    visitedProvinces: ['shanxi'],
    wishProvinces: ['shanxi', 'beijing'],
    provinceMarks: [
      { code: 'shanxi', state: 'visited', updatedAt: 100 },
      { code: 'shanxi', state: 'wish', updatedAt: 200 },
      { code: 'beijing', state: 'wish', updatedAt: 150 },
    ],
    visitedScenics: [{ id: 'a', updatedAt: 100 }],
    wishScenics: [{ id: 'a', updatedAt: 200 }, { id: 'b', updatedAt: 150 }],
    visitedScenicTombstones: [],
    wishScenicTombstones: [],
  })
  if (
    !result.ok ||
    result.data.revision !== 1 ||
    !Number.isFinite(result.data.serverTime) ||
    docs.get('openid-test').favorites.length !== 0
  ) {
    throw new Error('revision 保存或墓碑清理失败')
  }
  const savedTrip = docs.get('openid-test').trips[0]
  if (savedTrip.period !== 'morning' || savedTrip.checklist.join(',') !== '身份证件,预约凭证') {
    throw new Error('行程时段或准备清单被云函数错误裁剪')
  }
  const savedFootprints = docs.get('openid-test').footprints
  if (savedFootprints.length !== 1 || savedFootprints[0].scenicName !== '测试景区') {
    throw new Error('足迹未按景区去重并保留最近浏览记录')
  }
  const savedTravelMap = docs.get('openid-test')
  if (
    savedTravelMap.visitedProvinces.includes('shanxi') ||
    !savedTravelMap.wishProvinces.includes('shanxi') ||
    savedTravelMap.visitedScenics.some((item) => item.id === 'a') ||
    !savedTravelMap.wishScenics.some((item) => item.id === 'a')
  ) {
    throw new Error('旅行地图后设置覆盖或去过/想去互斥失败')
  }

  // 模拟旧版 v2 客户端：没有 footprints 字段时，只更新收藏/行程，不得清空云端足迹。
  result = await userData.main({ action: 'save', schema: 2, baseRevision: 1, favorites: [], trips: [] })
  if (
    !result.ok ||
    result.data.revision !== 2 ||
    docs.get('openid-test').footprints.length !== 1 ||
    !docs.get('openid-test').wishProvinces.includes('shanxi') ||
    !docs.get('openid-test').wishScenics.some((item) => item.id === 'a')
  ) {
    throw new Error('旧版 v2 客户端保存时覆盖了云端浏览历史或旅行地图')
  }

  result = await userData.main({
    action: 'save',
    schema: 2,
    baseRevision: 2,
    favorites: [],
    trips: [],
    footprints: [],
    footprintClearedAt: 300,
  })
  if (!result.ok || docs.get('openid-test').footprints.length !== 0 || docs.get('openid-test').footprintClearedAt !== 300) {
    throw new Error('足迹清空水位保存失败')
  }

  result = await userData.main({ action: 'save', schema: 2, baseRevision: 3, favorites: [], trips: [] })
  if (!result.ok || docs.get('openid-test').footprints.length !== 0 || docs.get('openid-test').footprintClearedAt !== 300) {
    throw new Error('旧版 v2 客户端保存时使已清空足迹复活')
  }

  result = await userData.main({ action: 'save', schema: 2, baseRevision: 0, favorites: [], trips: [] })
  if (result.ok || result.code !== 'SYNC_CONFLICT' || result.data.snapshot.revision !== 4) {
    throw new Error('冲突响应失败')
  }
  if (!Number.isFinite(result.data.snapshot.serverTime)) throw new Error('冲突响应缺少服务端时间')

  const manyTrips = Array.from({ length: 501 }, (_, index) => ({
    id: `trip:${index}`,
    scenicId: `scenic:${index}`,
    scenicName: `测试景区${index}`,
    status: 'pending',
    createdAt: 10000 + index,
    updatedAt: 10000 + index,
  }))
  result = await userData.main({
    action: 'save',
    schema: 2,
    baseRevision: 4,
    favorites: [],
    trips: manyTrips,
    tripTombstones: [{ id: 'trip:a', deletedAt: 9999 }],
  })
  const cappedTrips = docs.get('openid-test').trips
  if (!result.ok || cappedTrips.length !== 500 || cappedTrips.some((item) => item.id === 'trip:0')) {
    throw new Error('行程超限时未保留最近更新的 500 条')
  }

  const manyTripTombstones = Array.from({ length: 501 }, (_, index) => ({ id: `deleted:${index}`, deletedAt: 20000 + index }))
  result = await userData.main({
    action: 'save',
    schema: 2,
    baseRevision: 5,
    favorites: [],
    trips: cappedTrips,
    tripTombstones: manyTripTombstones,
  })
  const cappedTripTombstones = docs.get('openid-test').tripTombstones
  if (!result.ok || cappedTripTombstones.length !== 500 || cappedTripTombstones.some((item) => item.id === 'deleted:0')) {
    throw new Error('行程墓碑超限时未优先保留最近 500 条')
  }

  const manyFavorites = Array.from({ length: 501 }, (_, index) => ({
    id: `scenic:${index}`,
    targetId: `${index}`,
    createdAt: 30000 + index,
  }))
  result = await userData.main({
    action: 'save',
    schema: 2,
    baseRevision: 6,
    favorites: manyFavorites,
    trips: cappedTrips,
    tripTombstones: cappedTripTombstones,
  })
  const cappedFavorites = docs.get('openid-test').favorites
  if (!result.ok || cappedFavorites.length !== 500 || cappedFavorites.some((item) => item.id === 'scenic:0')) {
    throw new Error('收藏超限时未保留最新 500 条')
  }

  const manyFootprints = Array.from({ length: 201 }, (_, index) => ({
    id: `footprint:${index}`,
    scenicId: `footprint:${index}`,
    scenicName: `足迹景区${index}`,
    province: 'shanxi',
    visitedAt: 40000 + index,
  }))
  result = await userData.main({
    action: 'save',
    schema: 2,
    baseRevision: 7,
    favorites: cappedFavorites,
    footprints: manyFootprints,
    footprintClearedAt: 300,
    trips: cappedTrips,
    tripTombstones: cappedTripTombstones,
  })
  const cappedFootprints = docs.get('openid-test').footprints
  if (!result.ok || cappedFootprints.length !== 200 || cappedFootprints.some((item) => item.id === 'footprint:0')) {
    throw new Error('足迹超限时未保留最近浏览的 200 条')
  }

  // 删除与编辑相差不超过 15 分钟时，客户端和云函数都必须优先采信删除。
  const deleteWindow = 15 * 60 * 1000
  const closeItemTime = 50_000_000
  result = await userData.main({
    action: 'save',
    schema: 2,
    baseRevision: 8,
    favorites: [{ id: 'scenic:delete-wins', targetId: 'delete-wins', createdAt: closeItemTime }],
    favoriteTombstones: [{ id: 'scenic:delete-wins', deletedAt: closeItemTime - deleteWindow + 1 }],
    trips: cappedTrips,
    tripTombstones: cappedTripTombstones,
  })
  if (!result.ok || docs.get('openid-test').favorites.some((item) => item.id === 'scenic:delete-wins')) {
    throw new Error('近时钟窗口内未优先采信删除')
  }

  // 超出窗口的明确更新仍可胜出，避免把所有较新的编辑一律当成删除。
  result = await userData.main({
    action: 'save',
    schema: 2,
    baseRevision: 9,
    favorites: [{ id: 'scenic:edit-wins', targetId: 'edit-wins', createdAt: closeItemTime }],
    favoriteTombstones: [{ id: 'scenic:edit-wins', deletedAt: closeItemTime - deleteWindow - 1 }],
    trips: cappedTrips,
    tripTombstones: cappedTripTombstones,
  })
  if (!result.ok || !docs.get('openid-test').favorites.some((item) => item.id === 'scenic:edit-wins')) {
    throw new Error('超出删除优先窗口的较新编辑被错误删除')
  }

  result = await userData.main({ action: 'save', favorites: [], trips: [] })
  if (result.ok || result.code !== 'CLIENT_UPGRADE_REQUIRED') throw new Error('旧客户端保护失败')

  failReads = true
  result = await userData.main({ action: 'get', schema: 2 })
  if (result.ok || result.code !== 'DB_ERROR') throw new Error('读取异常被错误当作空数据')

  console.log('云同步协议检查通过：读取保护、revision 冲突、服务端校时、删除优先窗口、浏览历史/旅行地图兼容、旧客户端门禁及分类容量裁剪。')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
