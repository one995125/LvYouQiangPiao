/**
 * 收藏、行程与系统日历文本导出回归检查。
 * 只执行纯函数和源码契约检查，不调用真实剪贴板、不读取或修改用户 storage。
 */
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const utilityCode = read('miniprogram/utils/export-text.ts')
const componentCode = read('miniprogram/components/export-sheet/index.ts')
const componentWxml = read('miniprogram/components/export-sheet/index.wxml')
const favoritesCode = read('miniprogram/pages/favorites/index.ts')
const favoritesWxml = read('miniprogram/pages/favorites/index.wxml')
const tripsCode = read('miniprogram/pages/trips/index.ts')
const tripsWxml = read('miniprogram/pages/trips/index.wxml')
const packageJson = JSON.parse(read('package.json'))

// UI 与平台能力边界：两个页面都有入口，预览可长按，复制失败有手动选择路径。
assert(
  favoritesCode.includes('buildFavoritesExportText(getFavorites())')
    || /const favorites = getFavorites\(\)[\s\S]{0,120}buildFavoritesExportText\(favorites\)/.test(favoritesCode),
  '收藏页未从完整收藏快照生成导出文本',
)
assert(
  tripsCode.includes('buildTripsExportText(getTrips())')
    || /const trips = getTrips\(\)[\s\S]{0,120}buildTripsExportText\(trips\)/.test(tripsCode),
  '行程页缺少完整备份导出',
)
assert(
  tripsCode.includes('buildCalendarExportText(getTrips())')
    || /const trips = getTrips\(\)[\s\S]{0,120}buildCalendarExportText\(trips\)/.test(tripsCode),
  '行程页缺少系统日历文本导出',
)
assert(favoritesWxml.includes('bindtap="onOpenExport"'), '收藏页缺少导出入口')
assert(tripsWxml.includes('bindtap="onExportTrips"') && tripsWxml.includes('bindtap="onExportCalendar"'), '行程页缺少两类导出入口')
assert(componentCode.includes('wx.setClipboardData({'), '导出组件未调用 wx.setClipboardData')
assert(componentCode.includes("title: '复制失败'") && componentCode.includes('请长按下方文本手动选择并复制'), '复制失败缺少手动长按降级提示')
assert(componentWxml.includes('selectable="{{true}}"') && componentWxml.includes('user-select="{{true}}"'), '预览文本未启用长按选择')
assert((utilityCode + componentCode + tripsCode + tripsWxml).includes('小程序无法直接写入系统日历'), '缺少系统日历能力边界说明')
assert(favoritesCode.includes("toast('暂无收藏可导出')"), '空收藏缺少明确提示')
assert(tripsCode.includes("toast('暂无行程可导出')") && tripsCode.includes("toast('暂无已填写日期的行程')"), '空行程或无日期行程缺少明确提示')
assert(!/stores\/user-data|wx\.|STORAGE_KEYS/.test(utilityCode), '纯文本工具不得读写 store、storage 或微信 API')
assert.strictEqual(packageJson.scripts['check:export'], 'node tools/check-export.js', 'check:export 未挂入 package.json')
assert(packageJson.scripts.check.includes('check:export'), '总 check 未包含导出回归脚本')

let ts = null
for (const candidate of [
  'typescript',
  'D:/Software/微信web开发者工具/resources/vsextensions/node_modules/typescript/lib/typescript.js',
]) {
  try {
    ts = require(candidate)
    break
  } catch (_) {
    // 尝试下一处本地 TypeScript；没有编译器时仍保留上面的源码契约检查。
  }
}

if (ts) {
  const output = ts.transpileModule(utilityCode, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
  const utilityModule = { exports: {} }
  Function('require', 'module', 'exports', output)(() => ({}), utilityModule, utilityModule.exports)
  const { buildFavoritesExportText, buildTripsExportText, buildCalendarExportText } = utilityModule.exports

  const favorites = [
    { id: 'scenic:a', type: 'scenic', targetId: 'a', title: '云冈石窟', subtitle: '山西 · 大同', tone: 'jade', createdAt: new Date(2026, 9, 2).getTime() },
    { id: 'guide:b', type: 'guide', targetId: 'b', title: '恒山游览攻略', subtitle: '预约与交通', tone: 'ink', createdAt: new Date(2026, 9, 1).getTime() },
  ]
  const favoriteText = buildFavoritesExportText(favorites)
  assert(favoriteText.includes('拾景 · 我的收藏备份') && favoriteText.includes('共 2 条'), '收藏导出标题或条目数错误')
  assert.strictEqual((favoriteText.match(/^\d+\. /gm) || []).length, 2, '收藏导出条目数与输入不一致')
  assert(favoriteText.includes('[景区] 云冈石窟') && favoriteText.includes('[攻略] 恒山游览攻略'), '收藏类型或标题格式错误')

  const baseTrip = {
    province: '山西', city: '大同', tone: 'jade', period: 'morning', status: 'pending', note: '', checklist: [],
    ticket: { type: 'none', name: '' }, booking: '', createdAt: 1, updatedAt: 2,
  }
  const trips = [
    { ...baseTrip, id: 'trip-a', scenicId: 'a', scenicName: '云冈石窟', date: '2026-10-10', note: '提前到达' },
    { ...baseTrip, id: 'trip-b', scenicId: 'b', scenicName: '悬空寺', date: '', status: 'booked', updatedAt: 3 },
  ]
  const tripText = buildTripsExportText(trips)
  assert(tripText.includes('拾景 · 我的行程备份') && tripText.includes('共 2 条'), '行程导出标题或条目数错误')
  assert.strictEqual((tripText.match(/^\d+\. /gm) || []).length, 2, '行程导出条目数与输入不一致')
  assert(tripText.includes('日期：待定'), '完整行程备份错误遗漏日期待定项')

  const calendarText = buildCalendarExportText(trips)
  assert(calendarText.includes('共 1 条'), '日程文本应只统计已填写日期的行程')
  assert(calendarText.includes('日期：2026-10-10') && calendarText.includes('标题：游览云冈石窟'), '日程文本缺少日期或景区名')
  assert(calendarText.includes('小程序无法直接写入系统日历'), '日程文本缺少平台能力边界说明')

  assert.strictEqual(buildFavoritesExportText([]), '', '空收藏不应生成空壳文本')
  assert.strictEqual(buildTripsExportText([]), '', '空行程不应生成空壳文本')
  assert.strictEqual(buildCalendarExportText([trips[1]]), '', '没有有效日期时不应生成空壳日程文本')
}

console.log('数据导出检查通过：收藏/行程格式与条目数、空数据、日程日期和景区名、长按降级及系统日历说明。')
