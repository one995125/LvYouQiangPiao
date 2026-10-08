/**
 * 朋友圈与景区分享图回归检查。
 * 只检查源码契约与页面配置，不调用真实分享、Canvas 或相册接口。
 */
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const readJson = (file) => JSON.parse(read(file))

const pages = {
  scenic: read('miniprogram/pages/scenic/index.ts'),
  guideDetail: read('miniprogram/packageExtra/pages/guide-detail/index.ts'),
  guides: read('miniprogram/pages/guides/index.ts'),
  home: read('miniprogram/pages/home/index.ts'),
  tripShare: read('miniprogram/packageExtra/pages/trip-share/index.ts'),
}

Object.entries(pages).forEach(([name, code]) => {
  assert(code.includes('onShareTimeline()'), `${name} 缺少 onShareTimeline`)
})
for (const [page, configPath] of [
  ['scenic', 'miniprogram/pages/scenic/index.json'],
  ['guide-detail', 'miniprogram/packageExtra/pages/guide-detail/index.json'],
  ['guides', 'miniprogram/pages/guides/index.json'],
  ['home', 'miniprogram/pages/home/index.json'],
  ['trip-share', 'miniprogram/packageExtra/pages/trip-share/index.json'],
]) {
  const config = readJson(configPath)
  assert.strictEqual(config.enableShareTimeline, true, `${page} 未启用朋友圈分享配置`)
}

// 内容详情必须通过 query 恢复相同 id；朋友圈不允许伪造 path。
assert(/onShareTimeline\(\)[\s\S]*?query:\s*`id=\$\{encodeURIComponent\(this\.data\.id\)\}`/.test(pages.scenic), '景区朋友圈深链 id 不正确')
assert(/onShareTimeline\(\)[\s\S]*?query:\s*`id=\$\{encodeURIComponent\(this\.data\.id\)\}`/.test(pages.guideDetail), '攻略详情朋友圈深链 id 不正确')
assert(/onShareTimeline\(\)[\s\S]*?query:\s*`id=\$\{encodeURIComponent\(this\.data\.shareId\)\}`/.test(pages.tripShare), '行程快照朋友圈深链 id 不正确')
assert(pages.home.includes('query: `province=${encodeURIComponent(this.data.province)}`'), '首页朋友圈未保留省份筛选')
assert(pages.guides.includes('query: this.shareQuery()') && pages.guides.includes('category=${encodeURIComponent(this.data.category)}'), '攻略列表朋友圈未保留筛选条件')

// 私人原始数据页不得直接开放朋友圈，只读快照页才允许分享。
for (const [page, configPath] of [
  ['trips', 'miniprogram/pages/trips/index.json'],
  ['favorites', 'miniprogram/pages/favorites/index.json'],
  ['footprints', 'miniprogram/packageExtra/pages/footprints/index.json'],
]) {
  const config = readJson(configPath)
  assert(config.enableShareTimeline !== true, `${page} 不应直接开放朋友圈分享`)
}

const poster = read('miniprogram/utils/share-poster.ts')
const scenicWxml = read('miniprogram/pages/scenic/index.wxml')
assert(poster.includes('getWindowInfo') && poster.includes('pixelRatio'), '分享图未读取窗口 DPR')
assert(poster.includes('canvas.width = Math.round(width * dpr)') && poster.includes('ctx.setTransform(dpr, 0, 0, dpr, 0, 0)'), 'Canvas 未按 DPR 设置实际像素')
assert(poster.includes("import { TONES } from '../constants/enums'"), '分享图未复用传统色 TONES')
assert(poster.includes('ellipsisText') && poster.includes('ctx.measureText'), '分享图缺少文字宽度裁剪')
assert(poster.includes('拾景不参与售票'), '分享图缺少平台不参与售票说明')
assert(poster.includes('wx.saveImageToPhotosAlbum({'), '缺少保存相册能力')
assert(!poster.includes('wx.authorize'), '保存相册不应在用户点击前主动申请授权')
assert(scenicWxml.includes('type="2d"') && scenicWxml.includes('id="scenicSharePoster"'), '景区详情缺少 Canvas 2D 节点')
assert(scenicWxml.includes('bindtap="onGenerateSharePoster"') && scenicWxml.includes('bindtap="onSaveSharePoster"'), '景区详情缺少生成或保存入口')

// Canvas 失败必须被页面 catch，且 onShareAppMessage 只在已有图片时附加 imageUrl。
assert(pages.scenic.includes("console.info('[scenic] 分享图生成失败，继续使用默认分享卡片'"), '分享图失败未静默降级')
assert(pages.scenic.includes('if (this.data.shareImageUrl) result.imageUrl = this.data.shareImageUrl'), '好友分享未按可用性附加 imageUrl')
assert(!/onShareAppMessage\(\)[\s\S]{0,500}await\s+this\.ensureSharePoster/.test(pages.scenic), 'onShareAppMessage 不得等待异步 Canvas')

console.log('分享能力检查通过：朋友圈页面配置、query 深链、私密页隔离、Canvas DPR、文字裁剪、相册手势与失败降级。')
