/** 收藏主路径的静态回归检查；不读写本机或云端用户数据。 */
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const app = JSON.parse(read('miniprogram/app.json'))
const tabPaths = app.tabBar.list.map((item) => item.pagePath)
assert(app.pages.includes('pages/favorites/index'), '收藏页面未注册')
assert(tabPaths.includes('pages/favorites/index'), '收藏未成为主导航入口')
assert(!tabPaths.includes('pages/guides/index'), '攻略不应占用收藏主导航入口')

const collectionPage = read('miniprogram/pages/favorites/index.ts')
assert(collectionPage.includes('getFavorites()'), '收藏页未读取已有快照')
assert(!collectionPage.includes('getScenic('), '收藏页不得为每条收藏并发读取景区')
assert(collectionPage.includes('visibleLimit'), '收藏页缺少增量展示')
assert(!read('miniprogram/pages/trips/index.ts').includes('Promise.all(favs'), '行程页仍逐条读取收藏景区')

console.log('收藏主路径检查通过：独立入口、快照读取、分批展示及旧行程页去并发查询。')
