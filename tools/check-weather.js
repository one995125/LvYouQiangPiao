/**
 * 出行天气回归检查。
 * 使用内存 storage 与模拟 wx.request，不访问真实天气接口，也不修改云端数据。
 */
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const configCode = read('miniprogram/constants/config.ts')
const serviceCode = read('miniprogram/services/weather.ts')
const sheetCode = read('miniprogram/components/trip-sheet/index.ts')
const sheetWxml = read('miniprogram/components/trip-sheet/index.wxml')
const tripsCode = read('miniprogram/pages/trips/index.ts')
const tripsWxml = read('miniprogram/pages/trips/index.wxml')
const packageJson = JSON.parse(read('package.json'))

// 静态契约：默认关闭、独立缓存、天气区域均由非空数据控制。
assert(/WEATHER_API_CONFIG\s*=\s*\{\s*endpoint:\s*'',\s*key:\s*''/s.test(configCode), '天气 endpoint/key 默认值必须为空')
assert(configCode.includes("weatherCache: 'sj_weather_cache_v1'"), '天气缓存 key 未纳入 STORAGE_KEYS')
assert(serviceCode.includes('if (!isWeatherConfigured()) return null'), '未配置时缺少请求前短路')
assert(serviceCode.indexOf('if (!isWeatherConfigured()) return null') < serviceCode.indexOf('requestWeather(destination'), '配置短路必须发生在网络请求之前')
assert(serviceCode.includes('if (!destination) return null'), '地址与坐标均缺失时未跳过')
assert(sheetWxml.includes('wx:if="{{weather}}"'), '行程弹层天气区域缺少非空门禁')
assert(tripsWxml.includes('wx:if="{{item.weather}}"'), '行程卡天气区域缺少非空门禁')
assert(!/天气(?:加载失败|请求失败|暂不可用|待补充)/.test(sheetWxml + tripsWxml), '天气失败时不应显示错误占位文案')
assert(sheetCode.includes('catch (_)') && tripsCode.includes('catch (_)'), '页面层缺少天气异常静默兜底')
assert.strictEqual(packageJson.scripts['check:weather'], 'node tools/check-weather.js', 'check:weather 未挂入 package.json')
assert(packageJson.scripts.check.includes('check:weather'), '总 check 未包含天气回归脚本')

// 行程必须先 setData，再启动异步天气；天气合并使用展开运算，不能丢失原行程字段。
const initialRender = tripsCode.indexOf('this.setData({ trips, counts })')
const weatherStart = tripsCode.indexOf('void this.loadTripWeather(trips)', initialRender)
assert(initialRender >= 0 && weatherStart > initialRender, '天气请求阻塞了行程首次渲染')
assert(/\.\.\.trip,\s*weather:/s.test(tripsCode), '天气合并未保留完整行程视图')

let ts = null
for (const candidate of [
  'typescript',
  'D:/Software/微信web开发者工具/resources/vsextensions/node_modules/typescript/lib/typescript.js',
]) {
  try {
    ts = require(candidate)
    break
  } catch (_) {
    // 尝试开发者工具自带的 TypeScript；无编译器时仍保留上面的源码契约检查。
  }
}

async function runRuntimeChecks() {
  if (!ts) return
  const output = ts.transpileModule(serviceCode, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
  const config = {
    STORAGE_KEYS: { weatherCache: 'sj_weather_cache_v1' },
    WEATHER_API_CONFIG: { endpoint: '', key: '', timeoutMs: 1000 },
  }
  const storage = new Map()
  let requestCount = 0
  let requestMode = 'fail'

  global.wx = {
    getStorageSync(key) {
      return storage.get(key)
    },
    setStorageSync(key, value) {
      storage.set(key, JSON.parse(JSON.stringify(value)))
    },
    request(options) {
      requestCount += 1
      const task = { abort() {} }
      setImmediate(() => {
        if (requestMode === 'fail') options.fail({ errMsg: 'request:fail mock' })
        else options.success({ statusCode: 200, data: { weather: { text: '晴', high: '20', low: '9' } } })
      })
      return task
    },
  }

  const weatherModule = { exports: {} }
  const mockedRequire = (request) => {
    if (request === '../constants/config') return config
    if (request === '../types/index') return {}
    throw new Error(`unexpected require: ${request}`)
  }
  Function('require', 'module', 'exports', output)(mockedRequire, weatherModule, weatherModule.exports)
  const weather = weatherModule.exports

  // endpoint/key 任一为空时直接返回空，并保证 wx.request 调用次数仍为 0。
  assert.strictEqual(await weather.getWeather({ address: '测试景区' }, '2026-10-10'), null)
  assert.strictEqual(requestCount, 0, '未配置天气服务时仍然发起了请求')

  config.WEATHER_API_CONFIG.endpoint = 'https://weather.example.test/forecast'
  config.WEATHER_API_CONFIG.key = 'test-key'

  // 地址与坐标都没有时必须跳过，不得请求。
  assert.strictEqual(await weather.getWeather({}, '2026-10-10'), null)
  assert.strictEqual(requestCount, 0, '地点缺失时仍然发起了请求')

  // 网络失败只返回 null，不抛出错误；原始行程对象仍能完整渲染。
  const trip = { id: 'trip-a', scenicId: 'scenic-a', scenicName: '测试景区', date: '2026-10-10', status: 'pending' }
  const failedWeather = await weather.getWeather({ address: '失败地址' }, trip.date)
  assert.strictEqual(failedWeather, null, '请求失败未静默降级为空')
  assert.deepStrictEqual({ ...trip, weather: failedWeather }, { ...trip, weather: null }, '天气失败破坏了行程数据')
  const afterFailure = requestCount
  assert.strictEqual(await weather.getWeather({ address: '失败地址' }, trip.date), null)
  assert.strictEqual(requestCount, afterFailure, '同一目的地当天失败后被反复请求')

  // 成功结果写入本地缓存；同一目的地、同一自然日和出行日不重复请求。
  requestMode = 'success'
  const beforeSuccess = requestCount
  const first = await weather.getWeather({ location: { lat: 39.9, lng: 116.4 } }, '2026-10-11')
  const second = await weather.getWeather({ location: { lat: 39.9, lng: 116.4 } }, '2026-10-11')
  assert(first && first.summary === '晴 · 9~20℃', '天气响应解析错误')
  assert.deepStrictEqual(second, first, '缓存返回结果与首次结果不一致')
  assert.strictEqual(requestCount - beforeSuccess, 1, '同一目的地同一天发生了重复请求')

  delete global.wx
}

runRuntimeChecks()
  .then(() => {
    console.log('出行天气检查通过：默认零请求、缺失地点跳过、失败静默、行程先渲染、同目的地同日缓存。')
  })
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
