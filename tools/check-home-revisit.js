/**
 * 首页个性化回流离线回归：直接执行页面使用的纯函数，不读取 storage、不连接云端。
 */
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const helperPath = path.join(root, 'miniprogram/utils/home-personalization.js')
const homePath = path.join(root, 'miniprogram/pages/home/index.ts')
const wxmlPath = path.join(root, 'miniprogram/pages/home/index.wxml')
const helperSource = fs.readFileSync(helperPath, 'utf8')
const homeSource = fs.readFileSync(homePath, 'utf8')
const wxml = fs.readFileSync(wxmlPath, 'utf8')
const { selectRecentFootprints, recommendLoadedScenics } = require(helperPath)

// 无足迹时数据必须为空，WXML 以长度为门禁，不创建空卡片、骨架或占位文案。
assert.deepStrictEqual(selectRecentFootprints([]), [])
assert(wxml.includes('wx:if="{{recentFootprints.length}}"'), '最近浏览模块缺少非空门禁')
assert(wxml.includes('wx:if="{{recommendations.length}}"'), '推荐模块缺少非空门禁')
assert(!wxml.includes('还没有最近浏览'), '首页不应渲染最近浏览空态占位')

// 无序且重复的足迹必须按 visitedAt 倒序，按 scenicId 去重并限制为 4 条。
const footprints = [
  { id: 'a-old', scenicId: 'a', visitedAt: 10 },
  { id: 'b', scenicId: 'b', visitedAt: 50 },
  { id: 'a-new', scenicId: 'a', visitedAt: 80 },
  { id: 'c', scenicId: 'c', visitedAt: 40 },
  { id: 'd', scenicId: 'd', visitedAt: 30 },
  { id: 'e', scenicId: 'e', visitedAt: 20 },
]
assert.deepStrictEqual(selectRecentFootprints(footprints).map((item) => item.scenicId), ['a', 'b', 'c', 'd'])
assert.deepStrictEqual(selectRecentFootprints(footprints, 2).map((item) => item.scenicId), ['a', 'b'])

// 推荐只能从已加载列表中产生，排除已浏览/收藏项；没有本地偏好时返回空数组。
const loaded = [
  { _id: 'seen', province: 'shanxi', category: '山岳', heat: 99 },
  { _id: 'same-category', province: 'shanxi', category: '山岳', heat: 80 },
  { _id: 'same-province', province: 'shanxi', category: '古迹', heat: 95 },
  { _id: 'other', province: 'beijing', category: '博物馆', heat: 100 },
]
const recommendations = recommendLoadedScenics(
  loaded,
  [],
  [{ id: 'seen', scenicId: 'seen', province: 'shanxi', visitedAt: 100 }],
)
assert.deepStrictEqual(recommendations.map((item) => item._id), ['same-category', 'same-province'])
assert.deepStrictEqual(recommendLoadedScenics(loaded, [], []), [])
assert(recommendations.every((item) => loaded.includes(item)), '推荐不得生成或补查未加载景区')

// 个性化纯函数不得依赖云能力；首页仍只有原有榜单的一处 listScenics 调用。
for (const forbidden of ['wx.cloud', 'callFunction', 'listScenics', 'getScenic']) {
  assert(!helperSource.includes(forbidden), `首页个性化工具不应调用 ${forbidden}`)
}
assert.strictEqual((homeSource.match(/\blistScenics\s*\(/g) || []).length, 1, '首页个性化不应新增景区列表请求')
assert(!homeSource.includes('getScenic('), '首页个性化不应逐条补查景区详情')
assert(homeSource.includes('getFootprints()') && homeSource.includes('recommendLoadedScenics(loadedScenics'), '首页未直接消费本地快照或已加载景区')

console.log('首页回流检查通过：空数据不渲染、足迹倒序去重限量、推荐仅使用本地快照与已加载景区，未新增云请求。')
