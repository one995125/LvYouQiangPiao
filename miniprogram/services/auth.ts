/**
 * 登录与资料
 * - 云开发模式：调用云函数 shijingLogin 获取 openid（云函数天然携带用户身份，无需 code2session）
 * - 本地模式：生成设备级匿名 ID，功能完整可用，接入云开发后自动升级为真实登录
 * 头像昵称采用「头像昵称填写能力」（button open-type=chooseAvatar + input type=nickname），符合最新规范。
 */
import { getProfile, prepareForCloudIdentity, pullFromCloud, setProfile } from '../stores/user-data'
import { UserProfile } from '../types/index'
import { CLOUD_FUNCTIONS } from '../constants/config'
import { callFunction, ensureCloudReady, uploadFile } from './cloud'

export async function login(): Promise<UserProfile> {
  const prev = getProfile()
  if (await ensureCloudReady()) {
    const res = await callFunction<{ openid: string; nickName?: string; avatarUrl?: string }>(CLOUD_FUNCTIONS.login, {})
    const transition = prepareForCloudIdentity(res.openid, prev)
    if (transition === 'invalid') throw new Error('未获取到有效的云端用户身份，请稍后重试')
    const profile: UserProfile = {
      openid: res.openid.trim(),
      nickName: res.nickName || (prev && prev.nickName) || '',
      avatarUrl: res.avatarUrl || (prev && prev.avatarUrl) || '',
      cloud: true,
      loginAt: Date.now(),
    }
    setProfile(profile)
    // 换号时此处会立即拉新账号基线；匿名首次登录则在成功拉取后合并保留的离线数据。
    // 拉取失败时 baselineReady 仍为 false，绝不会把空快照或旧账号数据上传到新账号。
    await pullFromCloud()
    return profile
  }
  const profile: UserProfile = prev || {
    openid: `local_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    nickName: '',
    avatarUrl: '',
    cloud: false,
    loginAt: Date.now(),
  }
  setProfile(profile)
  return profile
}

/** 保存头像昵称；avatarUrl 若为临时路径且云端可用，会先上传到云存储 */
export async function updateProfile(patch: { nickName?: string; avatarUrl?: string }): Promise<UserProfile> {
  const current = getProfile() || (await login())
  let avatarUrl = patch.avatarUrl !== undefined ? patch.avatarUrl : current.avatarUrl
  const cloudReady = await ensureCloudReady()
  if (cloudReady && avatarUrl && !avatarUrl.startsWith('cloud://') && !avatarUrl.startsWith('https://')) {
    avatarUrl = await uploadFile(avatarUrl, 'shijing/avatars')
  }
  const next: UserProfile = {
    ...current,
    nickName: patch.nickName !== undefined ? patch.nickName : current.nickName,
    avatarUrl,
  }
  if (cloudReady) {
    await callFunction(CLOUD_FUNCTIONS.login, {
      action: 'updateProfile',
      nickName: next.nickName,
      avatarUrl: next.avatarUrl,
    })
  }
  setProfile(next)
  return next
}

export function logout() {
  setProfile(null)
}

/** 需要登录的操作前调用，未登录时静默登录（小程序内无需弹窗授权） */
export async function ensureLogin(): Promise<UserProfile> {
  return getProfile() || login()
}
