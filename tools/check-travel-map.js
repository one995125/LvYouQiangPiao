/** P2-12 旅行地图静态与资产一致性回归检查；不调用微信 API，不读写用户数据。 */
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const miniRoot = path.join(root, 'miniprogram')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const mapData = require('../miniprogram/packageExtra/data/china-map.js')
const provinceSource = read('miniprogram/constants/provinces.ts')
const store = read('miniprogram/stores/user-data.ts')
const config = read('miniprogram/constants/config.ts')
const cloud = read('cloudfunctions/shijingUserData/index.js')
const home = read('miniprogram/pages/home/index.ts') + read('miniprogram/pages/home/index.wxml')
const mapPageTs = read('miniprogram/packageExtra/pages/travel-map/index.ts')
const mapPageWxml = read('miniprogram/packageExtra/pages/travel-map/index.wxml')
const mapPage = mapPageTs + mapPageWxml

assert.strictEqual(mapData.provinceCount, 34, 'china-map provinceCount 必须为 34')
assert.strictEqual(mapData.provinces.length, 34, 'china-map provinces 必须含 34 项')
assert.strictEqual(mapData.jiuduanxianSegments, 10, 'china-map 九段线段数声明必须为 10')
assert.strictEqual(mapData.jiuduanxian.length, 10, 'china-map 九段线几何必须为 10 段')
const hainanRings = mapData.provinces.find((item) => item.code === 'hainan').rings
const mainlandIndex = hainanRings.map((ring) => ring.length).indexOf(Math.max(...hainanRings.map((ring) => ring.length)))
const nearIndex = hainanRings
  .map((ring, index) => ({ index, maxLat: Math.max(...ring.map((point) => point[1])) }))
  .filter((item) => item.index !== mainlandIndex)
  .sort((a, b) => b.maxLat - a.maxLat)[0].index
assert.strictEqual(hainanRings.filter((_, index) => index !== mainlandIndex && index !== nearIndex).length, 119, '南海内嵌框必须完整容纳 119 个岛屿环')
const mapCodes = mapData.provinces.map((item) => item.code).sort()
for (const code of ['taiwan', 'xianggang', 'aomen']) assert(mapCodes.includes(code), `china-map 缺少 ${code}`)
const provinceCodes = Array.from(provinceSource.matchAll(/code:\s*'([^']+)'/g), (match) => match[1]).sort()
assert.deepStrictEqual(mapCodes, provinceCodes, 'china-map 与 constants/provinces.ts 的省份 code 集合不一致')

// 从页面实现读取内嵌投影区与外框，避免检查脚本另存一份坐标后发生漂移。
const insetMatch = mapPageTs.match(/const INSET = \{\s*x:\s*([\d.]+),\s*y:\s*([\d.]+),\s*width:\s*([\d.]+),\s*height:\s*([\d.]+)\s*\}/)
assert(insetMatch, '地图页缺少可解析的 INSET 投影区常量')
const inset = {
  x: Number(insetMatch[1]),
  y: Number(insetMatch[2]),
  width: Number(insetMatch[3]),
  height: Number(insetMatch[4]),
}
const frameMatch = mapPageWxml.match(/<rect\s+class="inset-box"\s+x="([\d.]+)"\s+y="([\d.]+)"\s+width="([\d.]+)"\s+height="([\d.]+)"\s+rx="([\d.]+)"\s*\/>/)
assert(frameMatch, '地图页缺少可解析的南海诸岛内嵌框')
const insetFrame = {
  x: Number(frameMatch[1]),
  y: Number(frameMatch[2]),
  width: Number(frameMatch[3]),
  height: Number(frameMatch[4]),
}
assert.deepStrictEqual(
  insetFrame,
  { x: inset.x - 6, y: inset.y - 6, width: inset.width + 12, height: inset.height + 12 },
  '内嵌框必须与 INSET 投影区保持四周 6 个 SVG 单位的安全边距',
)
const insetTitleMatch = mapPageWxml.match(/<text\s+class="inset-title"\s+x="([\d.]+)"\s+y="([\d.]+)"/)
assert(insetTitleMatch, '地图页缺少南海诸岛标题坐标')
assert.strictEqual(Number(insetTitleMatch[1]), insetFrame.x + insetFrame.width / 2, '南海诸岛标题必须在内嵌框内水平居中')

const cos355 = Math.cos((35.5 * Math.PI) / 180)
const mainK = 481 / (53.8 - 17.8)
const mainPoint = ([lon, lat]) => [(lon - 73) * cos355 * mainK, (53.8 - lat) * mainK]
const pointInRect = ([x, y], rect) => (
  x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height
)

// 合规红线：外框不得覆盖任何省份的主图投影，台湾单独保留明确断言。
const provinceFrameHits = mapData.provinces.flatMap((province) => province.rings.flatMap((ring) => (
  ring.filter((point) => pointInRect(mainPoint(point), insetFrame)).map((point) => ({ code: province.code, point }))
)))
assert.strictEqual(provinceFrameHits.length, 0, `南海内嵌框覆盖省份几何：${provinceFrameHits.map((item) => item.code).join(', ')}`)
const taiwan = mapData.provinces.find((province) => province.code === 'taiwan')
assert(taiwan, 'china-map 缺少台湾省几何')
assert(taiwan.rings.flat().every((point) => !pointInRect(mainPoint(point), insetFrame)), '南海内嵌框不得覆盖台湾省')

// 用页面相同的自适应等比投影，验证 119 个岛屿环与 10 段九段线均无越界、无裁剪。
const insetRings = hainanRings.filter((_, index) => index !== mainlandIndex && index !== nearIndex)
const insetSourcePoints = [...insetRings, ...mapData.jiuduanxian].flat()
const insetBounds = insetSourcePoints.reduce((bounds, [lon, lat]) => ({
  minLon: Math.min(bounds.minLon, lon),
  maxLon: Math.max(bounds.maxLon, lon),
  minLat: Math.min(bounds.minLat, lat),
  maxLat: Math.max(bounds.maxLat, lat),
}), { minLon: Infinity, maxLon: -Infinity, minLat: Infinity, maxLat: -Infinity })
const insetScale = Math.min(
  inset.width / Math.max(1, (insetBounds.maxLon - insetBounds.minLon) * cos355),
  inset.height / Math.max(1, insetBounds.maxLat - insetBounds.minLat),
)
const insetDrawWidth = (insetBounds.maxLon - insetBounds.minLon) * cos355 * insetScale
const insetDrawHeight = (insetBounds.maxLat - insetBounds.minLat) * insetScale
const insetPoint = ([lon, lat]) => [
  inset.x + (inset.width - insetDrawWidth) / 2 + (lon - insetBounds.minLon) * cos355 * insetScale,
  inset.y + (inset.height - insetDrawHeight) / 2 + (insetBounds.maxLat - lat) * insetScale,
]
assert(insetSourcePoints.every((point) => pointInRect(insetPoint(point), inset)), '南海岛屿或九段线超出 INSET 投影区')
assert(insetSourcePoints.every((point) => pointInRect(insetPoint(point), insetFrame)), '南海岛屿或九段线超出内嵌框')

assert(config.includes('MAX_SYNC_PROVINCES = 34'), '省份列表缺少 34 项独立上限')
assert(config.includes('MAX_SYNC_SCENIC_MARKS = 500'), '景区标记缺少 500 项独立上限')
for (const field of ['visitedProvinces', 'wishProvinces', 'visitedScenics', 'wishScenics']) {
  assert(config.includes(`${field}:`), `${field} 未使用统一 STORAGE_KEYS`)
  assert(store.includes(field), `${field} 未并入本地仓库与同步快照`)
}
assert(store.includes("normalized.filter((item) => item.state === 'visited')") && store.includes("normalized.filter((item) => item.state === 'wish')"), '省份去过/想去未从单一互斥状态派生')
assert(store.includes("const nextState: ProvinceMarkState = state || 'none'"), '省份标记缺少后设置覆盖逻辑')
assert(store.includes('visited.slice(MAX_SYNC_SCENIC_MARKS)') && store.includes('wish.slice(MAX_SYNC_SCENIC_MARKS)'), '两类景区标记未各自独立裁剪')
assert(store.includes('visitedScenicTombstones') && store.includes('wishScenicTombstones'), '景区标记裁剪/删除缺少独立墓碑')
assert(cloud.includes('hasProvinceMarks') && cloud.includes('hasVisitedScenics') && cloud.includes('hasWishScenics'), '云函数未按可选字段参与合并')
assert(cloud.includes('? cleanGroup(') && cloud.includes(': { items: current.visitedScenics'), '旧客户端缺字段时未明确保留云端旅行地图数据')

const mainFiles = []
function walk(directory) {
  fs.readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
    const full = path.join(directory, entry.name)
    const relative = path.relative(miniRoot, full).replace(/\\/g, '/')
    if (entry.isDirectory()) {
      if (relative === 'packageExtra' || relative === 'packageAdmin') return
      walk(full)
    } else if (/\.(ts|js|wxml|json)$/.test(entry.name)) mainFiles.push(full)
  })
}
walk(miniRoot)
mainFiles.forEach((file) => assert(!fs.readFileSync(file, 'utf8').includes('china-map.js'), `主包禁止引用 china-map.js：${path.relative(root, file)}`))
assert(home.includes('province-centroids.js'), '首页点阵未直接使用省份质心资产')
assert(!home.includes('rings') && !home.includes('jiuduanxian'), '首页卡片错误引入地图几何语义')
assert(mapPage.includes('<svg') && mapPage.includes('<path') && mapPage.includes('insetIslandPath'), '地图页未使用 SVG path 或缺少南海内嵌图')
assert(mapPage.includes('地图底图仅作示意，非标准地图'), '地图页缺少固定示意声明')

console.log('旅行地图检查通过：34 省/港澳台/九段线一致，状态互斥、独立裁剪与墓碑齐全，主包未引用省界几何。')
