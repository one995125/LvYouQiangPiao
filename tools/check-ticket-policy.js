/**
 * 购票入口策略回归测试。先将 TypeScript 编译到独立临时目录，再以模拟 wx API 验证
 * 已核验、待核验、过期和缺少路径的入口；不访问微信或云端，不上传任何数据。
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const tempParent = fs.realpathSync(os.tmpdir())
const tempDir = fs.mkdtempSync(path.join(tempParent, 'shijing-ticket-'))
const resolvedTemp = fs.realpathSync(tempDir)
if (path.dirname(resolvedTemp) !== tempParent || !path.basename(resolvedTemp).startsWith('shijing-ticket-')) {
  throw new Error('临时编译目录不在预期位置，停止运行')
}

try {
  const compiler = spawnSync('npx', ['-p', 'typescript@5', 'tsc', '-p', 'tsconfig.check.json', '--noEmit', 'false', '--outDir', resolvedTemp], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  if (compiler.status !== 0) throw new Error(`TypeScript 测试编译失败：\n${compiler.stdout}\n${compiler.stderr}`)
  const candidates = [
    path.join(resolvedTemp, 'miniprogram', 'services', 'ticket.js'),
    path.join(resolvedTemp, 'services', 'ticket.js'),
  ]
  const ticketModule = candidates.find((candidate) => fs.existsSync(candidate))
  if (!ticketModule) throw new Error('测试编译后未找到 services/ticket.js')
  const policy = require(ticketModule)
  const actions = []
  global.wx = {
    setClipboardData({ data, success }) { actions.push(['copy', data]); if (success) success() },
    showModal({ title }) { actions.push(['modal', title]) },
    showToast({ title }) { actions.push(['toast', title]) },
    makePhoneCall({ phoneNumber }) { actions.push(['phone', phoneNumber]) },
    navigateToMiniProgram({ shortLink, appId }) { actions.push(['jump', shortLink || appId]) },
  }

  const base = { id: 'active', purpose: 'ticket', type: 'miniprogram', name: '测试景区服务', shortLink: '#小程序://测试景区服务/abc', verified: true }
  assert.strictEqual(policy.canJump(base), true)
  policy.openTicket(base)
  assert.deepStrictEqual(actions.shift(), ['jump', base.shortLink])

  const unverified = { ...base, id: 'unverified', verified: false }
  assert.strictEqual(policy.canJump(unverified), false)
  assert.strictEqual(policy.copyableEntryText(unverified), base.name)
  policy.openTicket(unverified)
  assert.deepStrictEqual(actions.shift(), ['copy', base.name])
  actions.length = 0

  const yesterday = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10)
  const expired = { ...base, id: 'expired', validUntil: yesterday }
  assert.strictEqual(policy.isChannelExpired(expired), true)
  assert.strictEqual(policy.canJump(expired), false)
  assert.strictEqual(policy.ticketActionLabel(expired), '核验已过期')
  assert.strictEqual(policy.copyableEntryText(expired), base.name)
  policy.openTicket(expired)
  assert.deepStrictEqual(actions.shift(), ['copy', base.name])
  actions.length = 0

  const exactDay = { ...base, validUntil: '2026-10-01' }
  assert.strictEqual(policy.isChannelExpired(exactDay, new Date(2026, 9, 1, 12)), false)
  assert.strictEqual(policy.isChannelExpired(exactDay, new Date(2026, 9, 2, 12)), true)
  const noPath = { type: 'miniprogram', name: '无路径', appId: 'wx1234567890abcdef', verified: true }
  assert.strictEqual(policy.canJump(noPath), false)
  policy.openTicket(noPath)
  assert.deepStrictEqual(actions.shift(), ['copy', noPath.name])
  actions.length = 0

  const officialWeb = { type: 'web', name: '景区官网', url: 'https://example.org', verified: true }
  policy.openTicket(officialWeb)
  assert.deepStrictEqual(actions.shift(), ['copy', officialWeb.url])
  actions.length = 0
  const unverifiedPhone = { type: 'phone', name: '待核验电话', phone: '12345678', verified: false }
  policy.openTicket(unverifiedPhone)
  assert.deepStrictEqual(actions.shift(), ['copy', unverifiedPhone.name])
  assert.strictEqual(actions.some((item) => item[0] === 'phone'), false)
  actions.length = 0

  const selected = policy.primaryOfficialEntry({ officialEntries: [expired, unverified, base], ticket: expired })
  assert.strictEqual(selected.id, 'active')
  console.log('购票入口策略检查通过：未核验、过期、缺路径入口均不直跳；有效期当天仍有效。')
} finally {
  // 仅删除本次 mkdtempSync 创建、且经父目录校验的编译目录。
  fs.rmSync(resolvedTemp, { recursive: true, force: true })
}
