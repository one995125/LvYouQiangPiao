/**
 * 关于与免责声明
 * 云端模式下提供「初始化云数据」入口：将内置景区与攻略分批写入云数据库（云函数 shijingInitData 会校验管理员身份）。
 */
import { APP_NAME, APP_SLOGAN, CLOUD_ENV_ID, CLOUD_FUNCTIONS } from '../../../constants/config'
import { GUIDES } from '../../../data/guides'
import { SCENICS } from '../../../data/scenics'
import { callFunction, ensureCloudReady } from '../../../services/cloud'
import { checkAdmin } from '../../../services/admin'
import { getProfile } from '../../../stores/user-data'

// 云函数当前线上超时为 3 秒；逐条事务检查已存在记录，批次保持较小。
const BATCH = 3

Page({
  data: {
    appName: APP_NAME,
    slogan: APP_SLOGAN,
    cloud: false,
    adminVisible: false,
    envId: CLOUD_ENV_ID,
    openid: '',
    scenicCount: SCENICS.length,
    importing: false,
    progress: '',
  },

  async onShow() {
    const p = getProfile()
    const cloud = await ensureCloudReady()
    this.setData({ cloud, openid: p && p.cloud ? p.openid : '', adminVisible: false })
    if (!cloud) return
    try {
      await checkAdmin()
      this.setData({ adminVisible: true })
    } catch (_) {
      // 非管理员或尚未配置白名单时，不渲染维护操作；服务端仍会独立拒绝请求。
    }
  },

  toAdmin() {
    if (this.data.adminVisible) wx.navigateTo({ url: '/packageAdmin/pages/admin/index' })
  },

  toAdminGuides() {
    if (this.data.adminVisible) wx.navigateTo({ url: '/packageAdmin/pages/admin-guides/index' })
  },

  onCopyOpenid() {
    if (this.data.openid) wx.setClipboardData({ data: this.data.openid })
  },

  async onImport() {
    if (this.data.importing || !this.data.adminVisible) return
    const confirm = await new Promise<boolean>((resolve) =>
      wx.showModal({
        title: '初始化云数据',
        content: `仅补充云端缺失的 ${SCENICS.length} 个景区、${GUIDES.length} 篇官方攻略；已有资料不会覆盖。`,
        confirmColor: '#2F5A51',
        success: (r) => resolve(r.confirm),
        fail: () => resolve(false),
      }),
    )
    if (!confirm) return
    this.setData({ importing: true })
    try {
      const jobs: { collection: string; docs: unknown[] }[] = []
      for (let i = 0; i < SCENICS.length; i += BATCH) jobs.push({ collection: 'scenics', docs: SCENICS.slice(i, i + BATCH) })
      for (let i = 0; i < GUIDES.length; i += BATCH) jobs.push({ collection: 'guides', docs: GUIDES.slice(i, i + BATCH) })
      for (let i = 0; i < jobs.length; i++) {
        this.setData({ progress: `${i + 1}/${jobs.length}` })
        await callFunction(CLOUD_FUNCTIONS.initData, jobs[i])
      }
      wx.showToast({ title: '导入完成', icon: 'success' })
    } catch (e) {
      const err = e as { message?: string }
      wx.showModal({ title: '导入失败', content: err.message || '请查看云函数日志', showCancel: false })
    } finally {
      this.setData({ importing: false, progress: '' })
    }
  },
})
