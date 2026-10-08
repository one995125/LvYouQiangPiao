/** 客户端自动恢复、账号隔离、校时与容量保护静态回归检查；不调用微信 API、不读写用户数据。 */
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const store = read('miniprogram/stores/user-data.ts')
const app = read('miniprogram/app.ts')
const config = read('miniprogram/constants/config.ts')
const auth = read('miniprogram/services/auth.ts')
const server = read('cloudfunctions/shijingUserData/index.js')
const types = read('miniprogram/types/index.ts')
const footprintsPage = read('miniprogram/packageExtra/pages/footprints/index.ts')

assert(store.includes('PUSH_RETRY_DELAYS = [2000, 10000, 60000]'), '上传失败缺少 2s/10s/60s 退避')
assert(store.includes('schedulePushRetry()'), '上传失败未安排自动重试')
assert(store.includes('if (pushPromise)') && store.includes('if (pushPromiseOwner === owner) return pushPromise'), 'push 未保持按 owner 单飞')
assert(store.includes('if (pullPromise)') && store.includes('if (pullPromiseOwner === owner) return pullPromise'), 'pull 未保持按 owner 单飞')
assert(store.includes('!meta.baselineReady'), '自动恢复缺少 baselineReady 保护')
assert(store.includes('FOREGROUND_PULL_INTERVAL = 60 * 1000'), '前台拉取缺少 1 分钟节流')
assert(app.includes('wx.onNetworkStatusChange'), 'App 未监听网络恢复')
assert(app.includes('syncUserDataOnAppShow()'), 'App.onShow 未续接同步')
const onShowBlock = app.match(/onShow\(\)\s*\{([\s\S]*?)\n\s*\},/)?.[1] || ''
assert(!onShowBlock.includes('login('), 'App.onShow 不得改变现有静默登录策略')

assert(config.includes('MAX_SYNC_TRIPS = 500'), '客户端缺少行程上限')
assert(config.includes('MAX_SYNC_TOMBSTONES = 500'), '客户端缺少墓碑上限')
assert(store.includes('prepareSnapshotForPush()'), '上传前未逐类整理容量')
assert(store.includes('itemUpdatedAt(b) - itemUpdatedAt(a)'), '行程裁剪未按最近更新时间排序')
assert(store.includes('normalizeTombstones'), '墓碑未按时间去重裁剪')
assert(!store.includes('throw new Error(`收藏超过'), '单一类别超限仍会阻断整批同步')

// P4：只有已确认的不同真实 openid 才清空；匿名首次登录保留离线数据，并始终先拉基线。
assert(store.includes("!openid.trim().startsWith('local_')"), '缺少真实 openid 有效性前置判断')
assert(store.includes("CloudIdentityTransition = 'invalid' | 'same' | 'first-cloud' | 'switched'"), '未区分换号与匿名首次登录')
assert(store.includes('const switched = Array.from(knownOwners).some'), '缺少已确认不同 openid 的换号判定')
assert(store.includes('setSyncMeta({ ...EMPTY_META, userOpenid: nextOpenid })'), '换号后未绑定新 owner 并重置基线')
assert(store.includes('dirtyAt: meta.dirtyAt'), '匿名首次登录未保留离线数据的待同步状态')
const identityBlock = store.slice(store.indexOf('export function prepareForCloudIdentity'), store.indexOf('export const isLoggedIn'))
const switchBranch = identityBlock.slice(identityBlock.indexOf('if (switched)'), identityBlock.indexOf("return 'switched'") + 18)
const firstCloudBranch = identityBlock.slice(identityBlock.indexOf('// 首次真实登录'), identityBlock.indexOf("return 'first-cloud'") + 21)
assert(switchBranch.includes('wx.removeStorageSync'), '真实换号未执行纯本地隔离清空')
assert(!switchBranch.includes('markDirty') && !switchBranch.includes('pushToCloud'), '真实换号清空不得触发上传')
assert(!firstCloudBranch.includes('wx.removeStorageSync'), '匿名首次登录错误清除了离线数据')
assert(firstCloudBranch.includes('...EMPTY_META') && !firstCloudBranch.includes('baselineReady: true'), '匿名首次登录未保持基线关闭')
for (const key of [
  'favorites', 'footprints', 'footprintClearedAt', 'trips', 'favoriteTombstones', 'tripTombstones',
  'visitedProvinces', 'wishProvinces', 'provinceMarks', 'visitedScenics', 'wishScenics',
  'visitedScenicTombstones', 'wishScenicTombstones',
]) {
  assert(switchBranch.includes(`STORAGE_KEYS.${key}`), `换号隔离缺少 ${key}`)
}
const prepareIndex = auth.indexOf('prepareForCloudIdentity(res.openid, prev)')
const setProfileIndex = auth.indexOf('setProfile(profile)')
const pullIndex = auth.indexOf('await pullFromCloud()')
assert(prepareIndex >= 0 && prepareIndex < setProfileIndex && setProfileIndex < pullIndex, '登录时换号隔离/写 profile/拉基线顺序错误')
assert(store.includes('identityGeneration') && store.includes('isActiveIdentity'), '在途旧账号响应缺少代际隔离')
assert(store.includes('pushPromiseOwner') && store.includes('pullPromiseOwner'), '换号时 push/pull 单飞未区分 owner')

// P5：serverTime 可选；缺失时使用本机时间，存在时按请求中点持久化偏移。
assert(store.includes('serverTime?: number'), '客户端协议未把 serverTime 声明为可选字段')
assert(store.includes('clockOffsetMs: number') && store.includes('clockOffsetReady: boolean'), '时钟偏移未持久化到 syncMeta')
assert(store.includes('value - midpoint'), '时钟偏移未按请求往返中点计算')
assert(store.includes('if (!meta.clockOffsetReady || !Number.isFinite(meta.clockOffsetMs)) return localNow'), '缺少偏移不可用时的本机时间降级')
assert(store.includes('const now = correctedNow()'), '收藏写入未使用校正时间')
assert(store.includes('updatedAt: correctedNow()'), '行程更新未使用校正时间')
assert(store.includes('writeTombstone(STORAGE_KEYS.tripTombstones, id, correctedNow())'), '行程删除未使用校正时间')
assert(types.includes('localVisitedAt?: number'), '足迹缺少本机展示时间字段')
assert(footprintsPage.includes('item.localVisitedAt || item.visitedAt'), '足迹相对时间未优先使用本机真实浏览时间')

const clientWindow = store.match(/DELETE_WINS_WINDOW_MS\s*=\s*(\d+)\s*\*\s*60\s*\*\s*1000/)?.[1]
const serverWindow = server.match(/DELETE_WINS_WINDOW_MS\s*=\s*(\d+)\s*\*\s*60\s*\*\s*1000/)?.[1]
assert(clientWindow === '15' && serverWindow === clientWindow, '客户端与云函数删除优先窗口不一致')
assert(store.includes('tombstone.deletedAt + DELETE_WINS_WINDOW_MS >= stamp(item)'), '客户端未执行近时钟窗口删除优先')
assert(server.includes('tombstone.deletedAt + DELETE_WINS_WINDOW_MS >= itemStamp'), '云函数未执行近时钟窗口删除优先')
assert(server.includes('serverTime: Date.now()'), '云函数响应缺少可选服务端时间')

console.log('客户端同步恢复检查通过：网络/前台触发、退避单飞、账号隔离、匿名数据保留、服务端校时、删除优先及容量上限。')
