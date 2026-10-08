/**
 * 购票渠道静态检查。
 * 只验证数据完整性与短链格式，不能替代运营主体核验和微信真机跳转测试。
 */
const fs = require('fs')
const path = require('path')

const file = path.resolve(__dirname, '../miniprogram/data/scenics.ts')
const source = fs.readFileSync(file, 'utf8')
const entryPattern = /_id:\s*'([^']+)'[\s\S]*?ticket:\s*([^\r\n]+)/g
const miniProgramPattern = /mp\('([^']*)'(?:,\s*'([^']*)')?(?:,\s*(true|false))?\)/
const shortLinkPattern = /^#小程序:\/\/[^/]+\/.+$/

const entries = []
let match
while ((match = entryPattern.exec(source))) {
  const id = match[1]
  const ticketLine = match[2].trim()
  const miniProgram = ticketLine.match(miniProgramPattern)
  if (miniProgram) {
    entries.push({ id, type: 'miniprogram', name: miniProgram[1], shortLink: miniProgram[2] || '', verified: miniProgram[3] === 'true' })
  } else if (/type:\s*'none'/.test(ticketLine)) {
    entries.push({ id, type: 'none', name: '', shortLink: '', verified: false })
  } else if (/free\(/.test(ticketLine)) {
    entries.push({ id, type: 'free', name: '', shortLink: '', verified: false })
  } else {
    entries.push({ id, type: 'other', name: '', shortLink: '', verified: false })
  }
}

const failures = []
const seenLinks = new Map()
entries.forEach((entry) => {
  if (entry.verified && !entry.shortLink) failures.push(`${entry.id}: 已核验渠道缺少可跳转短链`)
  if (entry.shortLink && !shortLinkPattern.test(entry.shortLink)) failures.push(`${entry.id}: 小程序短链格式不正确`)
  if (entry.shortLink) {
    const previous = seenLinks.get(entry.shortLink)
    if (previous) failures.push(`${entry.id}: 与 ${previous} 使用了重复短链`)
    else seenLinks.set(entry.shortLink, entry.id)
  }
})

const count = (predicate) => entries.filter(predicate).length
console.log(`购票渠道：${entries.length} 个景区`)
console.log(`- 已核验且有短链：${count((entry) => entry.verified && !!entry.shortLink)}`)
console.log(`- 有短链待核验：${count((entry) => !entry.verified && !!entry.shortLink)}`)
console.log(`- 仅有渠道名称：${count((entry) => entry.type === 'miniprogram' && !entry.shortLink)}`)
console.log(`- 免费开放：${count((entry) => entry.type === 'free')}`)
console.log(`- 尚未收录：${count((entry) => entry.type === 'none')}`)

if (entries.length !== 52) failures.push(`解析到 ${entries.length} 个景区，预期为 52；请检查数据结构或同步更新检查脚本`)
if (failures.length) {
  failures.forEach((failure) => console.error(`FAIL: ${failure}`))
  process.exitCode = 1
} else {
  console.log('购票渠道静态检查通过；官方身份与跳转结果仍需逐条人工/真机核验。')
}
