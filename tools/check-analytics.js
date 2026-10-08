/**
 * 埋点与错误监控回归检查。
 * 仅运行本地静态分析和模拟 API，不发送真实埋点、不调用云函数、不读写用户 storage。
 */
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const analyticsCode = read('miniprogram/constants/analytics.ts')
const appCode = read('miniprogram/app.ts')
const errorMonitorCode = read('miniprogram/services/error-monitor.ts')
const cloudLogCode = read('cloudfunctions/shijingLog/index.js')
const packageJson = JSON.parse(read('package.json'))

const expectedEvents = [
  'home_load',
  'scenic_open',
  'ticket_click',
  'favorite_toggle',
  'trip_save',
  'data_export',
  'calendar_copy',
  'guide_search',
  'share_click',
  'guide_open',
  'client_error',
]

expectedEvents.forEach((eventName) => {
  assert(analyticsCode.includes(`'${eventName}'`), `缺少埋点事件常量：${eventName}`)
})
assert(appCode.includes('onError(') && appCode.includes('onUnhandledRejection('), 'app.ts 缺少全局错误或 Promise 拒绝捕获')
assert(appCode.includes("reportClientError('app_error'") && appCode.includes("reportClientError('unhandled_rejection'"), '全局异常未接入脱敏错误监控')
assert(errorMonitorCode.includes('sanitizeErrorMessage') && errorMonitorCode.includes('{ silent: true }'), '客户端错误上报缺少脱敏或静默调用')
assert(cloudLogCode.includes("const COLLECTION = 'shijing_logs'"), '云函数未写入 shijing_logs 集合')
assert(cloudLogCode.includes('MAX_MESSAGE_LENGTH = 800') && cloudLogCode.includes('GLOBAL_LIMIT = 200'), '云端日志缺少长度截断或频率上限')
assert(!/data:\s*\{[^}]*openid/s.test(cloudLogCode), '云端日志文档不得持久化 openid')
assert.strictEqual(packageJson.scripts['check:analytics'], 'node tools/check-analytics.js', 'check:analytics 未挂入 package.json')
assert(packageJson.scripts.check.includes('check:analytics'), '总 check 未包含埋点回归脚本')
assert(packageJson.scripts['check:cloudfunctions'].includes('cloudfunctions/shijingLog/index.js'), '云函数语法检查未包含 shijingLog')

const walkTs = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const fullPath = path.join(directory, entry.name)
  if (entry.isDirectory()) return entry.name === 'miniprogram_npm' ? [] : walkTs(fullPath)
  return entry.isFile() && entry.name.endsWith('.ts') ? [fullPath] : []
})

// 提取 reportEvent(...) 调用文本，检查调用参数中没有隐私字段名或搜索原文参数。
const extractCalls = (source) => {
  const calls = []
  let cursor = 0
  while ((cursor = source.indexOf('reportEvent(', cursor)) >= 0) {
    const start = cursor
    let index = cursor + 'reportEvent('.length
    let depth = 1
    let quote = ''
    let escaped = false
    while (index < source.length && depth > 0) {
      const char = source[index]
      if (quote) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === quote) quote = ''
      } else if (char === "'" || char === '"' || char === '`') quote = char
      else if (char === '(') depth += 1
      else if (char === ')') depth -= 1
      index += 1
    }
    calls.push(source.slice(start, index))
    cursor = Math.max(index, start + 1)
  }
  return calls
}

const forbiddenPayloadKeys = /\b(?:openid|open_id|nickname|nickName|avatar|avatarUrl|note|checklist|keyword|searchText|query)\s*:/
const sourceFiles = walkTs(path.join(root, 'miniprogram'))
  .filter((file) => !file.endsWith(path.join('constants', 'analytics.ts')))
let callCount = 0
sourceFiles.forEach((file) => {
  extractCalls(fs.readFileSync(file, 'utf8')).forEach((call) => {
    callCount += 1
    assert(!forbiddenPayloadKeys.test(call), `埋点调用疑似携带隐私字段：${path.relative(root, file)}\n${call}`)
  })
})
assert(callCount >= 20, '关键路径埋点调用数量异常，可能有接入被回退')

const requiredPaths = {
  'miniprogram/pages/home/index.ts': 'HOME_LOAD',
  'miniprogram/pages/scenic/index.ts': 'TICKET_CLICK',
  'miniprogram/components/scenic-card/index.ts': 'FAVORITE_TOGGLE',
  'miniprogram/components/trip-sheet/index.ts': 'TRIP_SAVE',
  'miniprogram/components/export-sheet/index.ts': 'CALENDAR_COPY',
  'miniprogram/pages/guides/index.ts': 'GUIDE_SEARCH',
  'miniprogram/packageExtra/pages/guide-detail/index.ts': 'GUIDE_OPEN',
}
Object.entries(requiredPaths).forEach(([file, marker]) => {
  assert(read(file).includes(marker), `${file} 缺少关键路径埋点 ${marker}`)
})

let ts = null
for (const candidate of [
  'typescript',
  'D:/Software/微信web开发者工具/resources/vsextensions/node_modules/typescript/lib/typescript.js',
]) {
  try {
    ts = require(candidate)
    break
  } catch (_) {
    // 没有本地 TypeScript 时仍执行全部静态契约检查。
  }
}

if (ts) {
  const output = ts.transpileModule(analyticsCode, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
  const analyticsModule = { exports: {} }
  Function('require', 'module', 'exports', output)(() => ({}), analyticsModule, analyticsModule.exports)
  const { ANALYTICS_EVENTS, reportEvent } = analyticsModule.exports

  // 两种 API 都缺失时必须直接静默返回。
  global.wx = {}
  assert.doesNotThrow(() => reportEvent(ANALYTICS_EVENTS.HOME_LOAD, { page: 'home' }))

  // reportEvent 缺失时回退 reportAnalytics；白名单外的敏感参数必须被丢弃。
  let fallback = null
  global.wx = {
    reportAnalytics(name, data) {
      fallback = { name, data }
    },
  }
  assert.doesNotThrow(() => reportEvent(ANALYTICS_EVENTS.GUIDE_SEARCH, {
    page: 'guides', query_length: 3, hit: true, openid: 'forbidden', keyword: 'raw-search', note: 'private',
  }))
  assert.deepStrictEqual(fallback, {
    name: 'guide_search',
    data: { page: 'guides', query_length: 3, hit: 1 },
  })

  // 新接口同步抛错时仍允许静默回退；旧接口再抛错也不得向业务抛出。
  let fallbackCount = 0
  global.wx = {
    reportEvent() { throw new Error('mock reportEvent failure') },
    reportAnalytics() { fallbackCount += 1 },
  }
  assert.doesNotThrow(() => reportEvent(ANALYTICS_EVENTS.SHARE_CLICK, { page: 'home' }))
  assert.strictEqual(fallbackCount, 1, 'wx.reportEvent 异常时没有回退 wx.reportAnalytics')
  global.wx.reportAnalytics = () => { throw new Error('mock fallback failure') }
  assert.doesNotThrow(() => reportEvent(ANALYTICS_EVENTS.SHARE_CLICK, { page: 'home' }))
  delete global.wx
}

console.log(`埋点与错误监控检查通过：${expectedEvents.length} 个事件、${callCount} 处调用、隐私字段白名单、API 静默降级、全局错误捕获、云端截断与限频。`)
