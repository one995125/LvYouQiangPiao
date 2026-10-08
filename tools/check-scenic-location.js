/**
 * 景区位置与导航回归检查。
 * 使用内存/源码检查，不调用 getLocation、openLocation，不读取或修改云端数据。
 */
const assert = require('assert')
const fs = require('fs')
const Module = require('module')
const path = require('path')

const root = path.resolve(__dirname, '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const typesCode = read('miniprogram/types/index.ts')
const utilityCode = read('miniprogram/utils/location.ts')
const serviceCode = read('miniprogram/services/scenic.ts')
const homeCode = read('miniprogram/pages/home/index.ts')
const scenicCode = read('miniprogram/pages/scenic/index.ts')
const scenicWxml = read('miniprogram/pages/scenic/index.wxml')
const editorCode = read('miniprogram/packageAdmin/pages/admin-editor/index.ts')
const builtInData = read('miniprogram/data/scenics.ts')
const appConfig = JSON.parse(read('miniprogram/app.json'))

assert(/location\?:\s*ScenicLocation/.test(typesCode) && /address\?:\s*string/.test(typesCode), 'Scenic 缺少可选位置字段')
assert(!/(^|\n)\s*(location|lat|lng)\s*:/m.test(builtInData), '内置景区数据不得凭空填写坐标')
assert(scenicWxml.includes('wx:if="{{hasLocation}}"'), '详情页位置区域没有按坐标条件渲染')
assert(scenicWxml.includes('bindtap="onNavigate"') && scenicCode.includes('wx.openLocation({'), '详情页缺少一键导航')
assert(!scenicCode.includes('wx.authorize'), 'openLocation 不应额外申请 scope.userLocation')
assert(!/位置待补充|坐标待补充/.test(scenicWxml), '无坐标时不应显示位置占位文案')
assert(homeCode.includes("type: 'gcj02'") && homeCode.includes('wx.getLocation({'), '最近排序未主动获取 GCJ-02 位置')
assert(homeCode.includes("toast('未能获取位置，已按热度展示')"), '定位失败缺少友好降级提示')
assert(serviceCode.includes("result.locatedCount ? result.list : sortLocal(list, 'heat')"), '无景区坐标时未回退热度排序')
assert(serviceCode.includes('missingLocationCount'), '部分景区无坐标时缺少降级标记')
assert(editorCode.includes('lat < -90 || lat > 90') && editorCode.includes('lng < -180 || lng > 180'), '管理端缺少坐标边界校验')
assert(editorCode.includes('经纬度须同时填写或清空'), '管理端不支持成对清空/填写经纬度')
assert.deepStrictEqual(appConfig.requiredPrivateInfos, ['getLocation'], 'app.json 未准确声明 getLocation')
assert(appConfig.permission?.['scope.userLocation']?.desc, 'app.json 缺少用户位置用途说明')

// 使用开发者工具附带的 TypeScript 时执行真实距离排序；其他环境仍保留上面的源码契约检查。
let ts = null
for (const candidate of [
  'typescript',
  'D:/Software/微信web开发者工具/resources/vsextensions/node_modules/typescript/lib/typescript.js',
]) {
  try { ts = require(candidate); break } catch (error) { /* 尝试下一个本地编译器 */ }
}
if (ts) {
  const output = ts.transpileModule(utilityCode, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
  const locationModule = { exports: {} }
  Function('require', 'module', 'exports', output)(() => ({}), locationModule, locationModule.exports)
  const { isValidScenicLocation, sortScenicsByDistance } = locationModule.exports
  assert(isValidScenicLocation({ lat: -90, lng: 180 }), '合法边界坐标被拒绝')
  assert(!isValidScenicLocation({ lat: 90.0001, lng: 0 }), '越界纬度未拒绝')
  assert(!isValidScenicLocation({ lat: 0, lng: -180.0001 }), '越界经度未拒绝')
  const base = { alias: '', province: 'test', city: '', level: '', category: '自然', tone: 'jade', visitors: 0, rating: 0, price: 0, duration: '', openTime: '', intro: '', highlights: [], booking: '', tips: [], pitfalls: [], ticket: { type: 'none', name: '' }, updatedAt: '' }
  const result = sortScenicsByDistance([
    { ...base, _id: 'far', name: '远', heat: 10, location: { lat: 0, lng: 2 } },
    { ...base, _id: 'missing', name: '无坐标', heat: 99 },
    { ...base, _id: 'near', name: '近', heat: 1, location: { lat: 0, lng: 1 } },
  ], { lat: 0, lng: 0 })
  assert.deepStrictEqual(result.list.map((item) => item._id), ['near', 'far', 'missing'], '距离排序或无坐标后置错误')
  assert.strictEqual(result.missingLocationCount, 1)
}

// 服务端边界校验必须与客户端一致。
const cloudMock = {
  DYNAMIC_CURRENT_ENV: 'test', init() {}, database: () => ({ collection: () => ({}) }), getWXContext: () => ({}),
}
const originalLoad = Module._load
Module._load = function load(request, parent, isMain) {
  if (request === 'wx-server-sdk') return cloudMock
  return originalLoad.call(this, request, parent, isMain)
}
const admin = require('../cloudfunctions/shijingAdmin/index.js')
Module._load = originalLoad
assert.deepStrictEqual(admin._test.cleanLocation({ lat: 90, lng: -180 }), { lat: 90, lng: -180 })
assert.throws(() => admin._test.cleanLocation({ lat: 91, lng: 0 }), /纬度/)
assert.throws(() => admin._test.cleanLocation({ lat: 0, lng: 181 }), /经度/)
assert.strictEqual(admin._test.cleanLocation(null), null)

console.log('景区位置检查通过：无坐标隐藏、坐标边界、距离排序、无坐标后置/热度降级、导航与隐私声明。')
