/**
 * 分包、页面路由与分享深链回归检查。
 * 只读取 app.json 和源码字符串，不启动微信、不访问网络、不修改任何用户数据。
 */
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const miniRoot = path.join(root, 'miniprogram')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const app = JSON.parse(read('miniprogram/app.json'))
const sitemap = JSON.parse(read('miniprogram/sitemap.json'))
const packageJson = JSON.parse(read('package.json'))

const expectedPackages = {
  packageAdmin: [
    'pages/admin/index',
    'pages/admin-editor/index',
    'pages/admin-guides/index',
    'pages/admin-guide-editor/index',
  ],
  packageExtra: [
    'pages/compare/index',
    'pages/correction/index',
    'pages/trip-share/index',
    'pages/about/index',
    'pages/profile/index',
    'pages/search/index',
    'pages/guide-detail/index',
    'pages/footprints/index',
    'pages/travel-map/index',
  ],
}

assert(Array.isArray(app.pages) && app.pages.length > 0, 'app.json 主包 pages 不能为空')
assert(Array.isArray(app.subPackages) && app.subPackages.length === 2, 'app.json 必须声明两个分包')
const roots = app.subPackages.map((item) => item.root)
assert.strictEqual(new Set(roots).size, roots.length, '分包 root 不得重复')

const registered = new Set(app.pages)
app.subPackages.forEach((pkg) => {
  assert(pkg && typeof pkg.root === 'string' && pkg.root && !pkg.root.startsWith('/'), '分包 root 非法')
  assert(Array.isArray(pkg.pages) && pkg.pages.length > 0, `${pkg.root} pages 不能为空`)
  assert.deepStrictEqual(pkg.pages, expectedPackages[pkg.root], `${pkg.root} 页面划分与约定不一致`)
  pkg.pages.forEach((page) => {
    assert(typeof page === 'string' && page && !page.startsWith('/'), `${pkg.root} 包含非法页面路径`)
    const fullRoute = `${pkg.root}/${page}`
    assert(!registered.has(fullRoute), `页面重复注册：${fullRoute}`)
    registered.add(fullRoute)
  })
})

const mainTabs = ['pages/home/index', 'pages/favorites/index', 'pages/trips/index', 'pages/mine/index']
assert.deepStrictEqual(app.tabBar.list.map((item) => item.pagePath), mainTabs, 'tabBar 页面或顺序被改变')
mainTabs.forEach((page) => assert(app.pages.includes(page), `tabBar 页面必须留在主包：${page}`))
assert(app.pages.includes('pages/scenic/index') && app.pages.includes('pages/guides/index'), '高频景区/攻略入口必须留在主包')

// 每个注册页面至少具备逻辑、模板与页面配置，且物理路径与 root + page 拼接一致。
registered.forEach((route) => {
  for (const extension of ['.ts', '.wxml', '.json']) {
    assert(fs.existsSync(path.join(miniRoot, `${route}${extension}`)), `注册页面文件不存在：${route}${extension}`)
  }
})

const sourceExtensions = new Set(['.ts', '.js', '.wxml', '.json'])
const sourceFiles = []
const walk = (directory) => {
  fs.readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
    if (entry.name === 'miniprogram_npm') return
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) walk(fullPath)
    else if (sourceExtensions.has(path.extname(entry.name))) sourceFiles.push(fullPath)
  })
}
walk(miniRoot)

const routePattern = /\/(?:pages|package[A-Za-z0-9_-]+\/pages)\/[A-Za-z0-9_-]+\/index/g
const referencedRoutes = new Set()
sourceFiles.forEach((file) => {
  const source = fs.readFileSync(file, 'utf8')
  const matches = source.match(routePattern) || []
  matches.forEach((route) => referencedRoutes.add(route.slice(1)))
})
referencedRoutes.forEach((route) => assert(registered.has(route), `源码页面路径未注册或分包拼接错误：/${route}`))

// 分享给好友使用 path，朋友圈使用当前页 query；这里确认所有可分享页面的好友深链仍可解析。
const sharePaths = [
  ['miniprogram/pages/home/index.ts', '/pages/home/index'],
  ['miniprogram/pages/scenic/index.ts', '/pages/scenic/index'],
  ['miniprogram/pages/guides/index.ts', '/pages/guides/index'],
  ['miniprogram/packageExtra/pages/guide-detail/index.ts', '/packageExtra/pages/guide-detail/index'],
  ['miniprogram/packageExtra/pages/trip-share/index.ts', '/packageExtra/pages/trip-share/index'],
  ['miniprogram/pages/trips/index.ts', '/packageExtra/pages/trip-share/index'],
]
sharePaths.forEach(([file, pagePath]) => {
  const source = read(file)
  assert(source.includes('onShareAppMessage()'), `${file} 缺少好友分享入口`)
  assert(source.includes(pagePath), `${file} 分享 path 未指向有效页面 ${pagePath}`)
  assert(registered.has(pagePath.slice(1)), `分享 path 未注册：${pagePath}`)
})

assert(Array.isArray(sitemap.rules) && sitemap.rules.some((rule) => rule.action === 'allow' && rule.page === '*'), 'sitemap 未覆盖分包页面')
assert.strictEqual(packageJson.scripts['check:subpackages'], 'node tools/check-subpackages.js', 'check:subpackages 未挂入 package.json')
assert(packageJson.scripts.check.includes('check:subpackages'), '总 check 未包含分包回归脚本')

const filesOf = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const fullPath = path.join(directory, entry.name)
  return entry.isDirectory() ? filesOf(fullPath) : [fullPath]
})
const bytesOf = (directory) => filesOf(directory).reduce((total, file) => total + fs.statSync(file).size, 0)
const totalBytes = bytesOf(miniRoot)
const adminBytes = bytesOf(path.join(miniRoot, 'packageAdmin'))
const extraBytes = bytesOf(path.join(miniRoot, 'packageExtra'))
const mainBytes = totalBytes - adminBytes - extraBytes
const scenicsBytes = fs.statSync(path.join(miniRoot, 'data/scenics.ts')).size
const guidesBytes = fs.statSync(path.join(miniRoot, 'data/guides.ts')).size

console.log(`分包检查通过：${registered.size} 个页面、${referencedRoutes.size} 条源码路由均可解析。`)
console.log(`源文件实测：scenics.ts=${scenicsBytes} B，guides.ts=${guidesBytes} B，当前主包=${mainBytes} B，packageAdmin=${adminBytes} B，packageExtra=${extraBytes} B，总计=${totalBytes} B。`)
