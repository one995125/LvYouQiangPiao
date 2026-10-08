/**
 * 攻略类目收口的离线回归测试：模拟云数据库，不连接或改动真实云端数据。
 * 验证公开读取、管理员草稿/发布/下架、版本冲突，以及旧客户端无法投稿/点赞。
 */
const assert = require('assert')
const Module = require('module')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const app = JSON.parse(fs.readFileSync(path.join(root, 'miniprogram/app.json'), 'utf8'))
const registeredPages = new Set([
  ...app.pages,
  ...(app.subPackages || []).flatMap((pkg) => pkg.pages.map((page) => `${pkg.root}/${page}`)),
])
// 产品决策：攻略模块必须继续公开展示，不能因关闭用户投稿而误删页面或入口。
for (const page of ['pages/guides/index', 'packageExtra/pages/guide-detail/index', 'packageAdmin/pages/admin-guides/index', 'packageAdmin/pages/admin-guide-editor/index']) {
  assert(registeredPages.has(page), `${page} 未注册，攻略展示或管理员发布流程会被隐藏`)
}
const homePage = fs.readFileSync(path.join(root, 'miniprogram/pages/home/index.wxml'), 'utf8')
const homeLogic = fs.readFileSync(path.join(root, 'miniprogram/pages/home/index.ts'), 'utf8')
assert(homePage.includes('bindtap="toGuides"'), '首页缺少公开攻略入口')
assert(homeLogic.includes("wx.navigateTo({ url: '/pages/guides/index' })"), '首页攻略入口未跳转到攻略页')

// 普通用户发布页面、按钮和旧投稿入口必须持续保持关闭。
assert(!app.pages.includes('pages/guide-publish/index'))
assert(!app.pages.includes('pages/my-posts/index'))
for (const pageDir of ['guide-publish', 'my-posts']) {
  const fullPath = path.join(root, 'miniprogram/pages', pageDir)
  assert(!fs.existsSync(fullPath) || fs.readdirSync(fullPath).length === 0, `${pageDir} 仍有旧页面文件`)
}
for (const [file, token] of [
  ['pages/guides/index.wxml', 'toPublish'],
  ['pages/mine/index.wxml', 'toPosts'],
  ['packageExtra/pages/guide-detail/index.wxml', 'onLike'],
]) {
  assert(!fs.readFileSync(path.join(root, 'miniprogram', file), 'utf8').includes(token), `${file} 仍有用户投稿互动入口`)
}
const guideData = fs.readFileSync(path.join(root, 'miniprogram/data/guides.ts'), 'utf8')
assert(!/\b(?:likes|views):\s*\d+/.test(guideData), '内置资料不应包含虚构互动数')
assert(!guideData.includes('300+ 条真实反馈'), '内置资料不应声称未经证实的用户反馈量')
const guideService = fs.readFileSync(path.join(root, 'miniprogram/services/guide.ts'), 'utf8')
assert(!guideService.includes('if ((q.page || 0) === 0 && !list.length) return filterLocal(q)'), '云端空列表不能回退内置资料')
assert(!guideService.includes('云端详情读取失败，使用本地兜底'), '云端详情下架不能回退内置资料')
const guideAdminService = fs.readFileSync(path.join(root, 'miniprogram/services/guide-admin.ts'), 'utf8')
assert(guideAdminService.includes("action: 'adminSave'"), '管理员攻略保存接口缺失')
assert(guideAdminService.includes("action: 'adminSetStatus'"), '管理员攻略发布/下架接口缺失')
const guidePage = fs.readFileSync(path.join(root, 'miniprogram/pages/guides/index.ts'), 'utf8')
const guidePageWxml = fs.readFileSync(path.join(root, 'miniprogram/pages/guides/index.wxml'), 'utf8')
assert(guidePage.includes('listGuideTags') && guidePage.includes('keyword: this.data.appliedKeyword') && guidePage.includes('tag: this.data.tag'), '攻略页未接入关键词与标签查询')
assert(guidePage.includes('}, 300)') && guidePage.includes('guideSearchHistory'), '攻略搜索缺少 300ms 防抖或独立历史记录')
assert(guidePageWxml.includes('没有找到相关攻略') || guidePage.includes('没有找到相关攻略'), '攻略页缺少无结果空态')
assert(guidePageWxml.includes('资料暂时无法加载'), '攻略页缺少云端不可用空态')
assert(guidePageWxml.includes('onTagFilter'), '攻略页缺少标签筛选入口')

const docs = new Map([
  ['editorial', {
    _id: 'editorial', _openid: 'system', status: 'approved', official: true, createdAt: 3,
    title: '热门景区抢票准备', summary: '提前核对同行人的实名信息。', scenicName: '云冈石窟',
    tags: ['山西', '预约'], blocks: [{ type: 'p', text: '放票前核对日期和官方入口。' }],
  }],
  ['old-user', {
    _id: 'old-user', _openid: 'author', status: 'approved', official: false, createdAt: 2,
    title: '用户抢票投稿', summary: '实名信息与预约。', scenicName: '云冈石窟', tags: ['山西'], blocks: [],
  }],
  ['draft', {
    _id: 'draft', _openid: 'system', status: 'pending', official: true, createdAt: 1,
    title: '未发布抢票稿', summary: '实名信息与预约。', scenicName: '云冈石窟', tags: ['山西'], blocks: [],
  }],
])
let caller = 'viewer'
let writes = 0
let nextId = 1

/** 仅实现被 shijingGuide 使用的查询链，避免测试依赖真实 CloudBase。 */
function query(where = {}) {
  let offset = 0
  let size = 100
  return {
    orderBy() { return this },
    skip(value) { offset = value; return this },
    limit(value) { size = value; return this },
    async get() {
      const data = Array.from(docs.values())
        .filter((doc) => Object.entries(where).every(([key, value]) => {
          if (value && typeof value === 'object' && Array.isArray(value.$in)) return value.$in.includes(doc[key])
          return doc[key] === value
        }))
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(offset, offset + size)
      return { data }
    },
    async remove() {
      const matches = (await this.get()).data
      matches.forEach((doc) => docs.delete(doc._id))
      writes += matches.length
      return { stats: { removed: matches.length } }
    },
  }
}

const collection = {
  where: query,
  async add({ data }) {
    const _id = `admin-${nextId++}`
    docs.set(_id, { _id, ...data })
    writes += 1
    return { _id }
  },
  doc(id) {
    return {
      async get() {
        if (!docs.has(id)) throw new Error('document does not exist')
        return { data: { ...docs.get(id) } }
      },
      async update({ data }) {
        if (!docs.has(id)) throw new Error('document does not exist')
        docs.set(id, { ...docs.get(id), ...data })
        writes += 1
        return { stats: { updated: 1 } }
      },
    }
  },
}
const cloudMock = {
  DYNAMIC_CURRENT_ENV: 'test',
  init() {},
  database: () => ({
    command: { in: (values) => ({ $in: values }) },
    collection: () => collection,
    runTransaction: async (work) => ({ result: await work({ collection: () => collection }) }),
  }),
  getWXContext: () => ({ FROM_OPENID: caller, OPENID: 'resource-owner' }),
}
const originalLoad = Module._load
Module._load = function load(request, parent, isMain) {
  if (request === 'wx-server-sdk') return cloudMock
  return originalLoad.call(this, request, parent, isMain)
}
const guide = require('../cloudfunctions/shijingGuide/index.js')
Module._load = originalLoad

async function main() {
  const previousAdmins = process.env.ADMIN_OPENIDS
  delete process.env.ADMIN_OPENIDS
  const listed = await guide.main({ action: 'list', query: { category: 'all' } })
  assert.strictEqual(listed.ok, true)
  assert.deepStrictEqual(listed.data.list.map((doc) => doc._id), ['editorial'])
  assert.strictEqual(listed.data.list[0]._openid, undefined)
  // 旧客户端不携带 keyword/tag 时，公开边界、顺序和返回结果保持原样。
  const oldClientListed = await guide.main({ action: 'list', query: {} })
  assert.deepStrictEqual(oldClientListed.data.list.map((doc) => doc._id), ['editorial'])
  // keyword + tag 必须在服务端组合过滤，且标题、摘要、正文与景区名均可命中。
  for (const keyword of ['抢票', '实名信息', '放票前', '云冈石窟']) {
    const searched = await guide.main({ action: 'list', query: { keyword, tag: '山西' } })
    assert.deepStrictEqual(searched.data.list.map((doc) => doc._id), ['editorial'])
  }
  assert.deepStrictEqual((await guide.main({ action: 'list', query: { keyword: '抢票', tag: '亲子' } })).data.list, [])
  const publicTags = await guide.main({ action: 'tags' })
  assert.strictEqual(publicTags.ok, true)
  assert.deepStrictEqual(new Set(publicTags.data.tags), new Set(['山西', '预约']))
  assert.strictEqual((await guide.main({ action: 'get', id: 'editorial' })).ok, true)
  assert.strictEqual((await guide.main({ action: 'get', id: 'old-user' })).code, 'NOT_FOUND')
  assert.strictEqual((await guide.main({ action: 'get', id: 'draft' })).code, 'NOT_FOUND')
  assert.strictEqual((await guide.main({ action: 'publish', guide: { title: '旧客户端投稿' } })).code, 'FEATURE_CLOSED')
  assert.strictEqual((await guide.main({ action: 'like', id: 'editorial', like: true })).code, 'FEATURE_CLOSED')
  assert.strictEqual((await guide.main({ action: 'adminList' })).code, 'NO_ADMIN')
  assert.strictEqual(writes, 0)
  assert.strictEqual(docs.has('old-user'), true)

  process.env.ADMIN_OPENIDS = 'admin'
  const draft = {
    title: '山西景区预约准备清单', summary: '整理景区预约前需要核对的入口、日期与实名信息。',
    category: 'guide', province: 'shanxi', scenicId: '', scenicName: '', tone: 'jade',
    tags: ['山西', '预约', '山西', ' ', 123],
    blocks: [{ type: 'h', text: '预约前' }, { type: 'p', text: '以景区官方公告为准。' }],
  }
  assert.strictEqual((await guide.main({ action: 'adminSave', draft })).code, 'FORBIDDEN')
  assert.strictEqual(writes, 0)
  caller = 'admin'
  assert.strictEqual((await guide.main({ action: 'publish', guide: draft })).code, 'FEATURE_CLOSED')
  const writesBeforeInvalidTags = writes
  assert.strictEqual((await guide.main({ action: 'adminSave', draft: { ...draft, tags: Array.from({ length: 11 }, (_, i) => `标签${i}`) } })).code, 'VALIDATION_ERROR')
  assert.strictEqual((await guide.main({ action: 'adminSave', draft: { ...draft, tags: ['超'.repeat(17)] } })).code, 'VALIDATION_ERROR')
  assert.strictEqual(writes, writesBeforeInvalidTags, '非法标签不应写入数据库')
  const saved = await guide.main({ action: 'adminSave', draft })
  assert.strictEqual(saved.ok, true)
  assert.strictEqual(saved.data.status, 'pending')
  const id = saved.data.id
  assert.deepStrictEqual(docs.get(id).tags, ['山西', '预约'], '标签应过滤非字符串、空值并去重')
  assert.strictEqual((await guide.main({ action: 'get', id })).code, 'NOT_FOUND')
  assert((await guide.main({ action: 'adminList', status: 'pending' })).data.list.some((doc) => doc._id === id))
  assert.strictEqual((await guide.main({ action: 'adminSetStatus', id, baseRevision: 0, status: 'approved' })).code, 'SYNC_CONFLICT')
  const published = await guide.main({ action: 'adminSetStatus', id, baseRevision: 1, status: 'approved' })
  assert.strictEqual(published.ok, true)
  assert.strictEqual((await guide.main({ action: 'get', id })).ok, true)
  assert.strictEqual((await guide.main({ action: 'adminSave', id, baseRevision: 1, draft })).code, 'SYNC_CONFLICT')
  assert.strictEqual((await guide.main({ action: 'adminSave', id: 'old-user', baseRevision: 0, draft })).code, 'FORBIDDEN')
  assert.strictEqual((await guide.main({ action: 'adminSetStatus', id: 'old-user', baseRevision: 0, status: 'approved' })).code, 'FORBIDDEN')
  const unpublished = await guide.main({ action: 'adminSetStatus', id, baseRevision: 2, status: 'pending' })
  assert.strictEqual(unpublished.ok, true)
  assert.strictEqual((await guide.main({ action: 'get', id })).code, 'NOT_FOUND')
  assert.strictEqual(docs.has(id), true)

  caller = 'author'
  const mine = await guide.main({ action: 'mine' })
  assert.deepStrictEqual(mine.data.map((doc) => doc._id), ['old-user'])
  caller = 'viewer'
  assert.strictEqual((await guide.main({ action: 'remove', id: 'old-user' })).code, 'FORBIDDEN')
  assert.strictEqual(docs.has('old-user'), true)
  if (previousAdmins === undefined) delete process.env.ADMIN_OPENIDS
  else process.env.ADMIN_OPENIDS = previousAdmins
  console.log('攻略维护检查通过：官方发布边界、关键词与标签组合、旧客户端兼容、标签白名单、版本冲突及投稿关闭。')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
