/**
 * 云开发封装
 * - 统一初始化与云函数调用，返回值约定：{ ok: true, data } / { ok: false, code, message, debug }
 * - 通过环境共享访问资源方云环境，必须等待共享实例 init 完成后再调用数据库、云函数或云存储
 * - 未配置 CLOUD_ENV_ID 时 isCloudReady() 恒为 false，业务层自动走本地兜底
 */
import { CLOUD_BOOTSTRAP_ENV_ID, CLOUD_ENV_ID, CLOUD_RESOURCE_APP_ID, USE_CLOUD } from '../constants/config'

let ready = false
let initPromise: Promise<boolean> | null = null

/**
 * wx.cloud.Cloud 是环境共享专用实例。当前 typings 版本尚未声明该构造器，
 * 因此只在此处做最小类型补充，业务层仍使用微信官方 Cloud API。
 */
interface SharedCloudClient {
  init(): Promise<void>
  callFunction(param: { name: string; data?: Record<string, unknown> }): Promise<ICloud.CallFunctionResult>
  database(): DB.Database
  uploadFile(param: { cloudPath: string; filePath: string }): Promise<ICloud.UploadFileResult>
}

interface SharedCloudConstructor {
  new (options: { resourceAppid: string; resourceEnv: string }): SharedCloudClient
}

let cloudClient: SharedCloudClient | null = null

export function initCloud(): Promise<boolean> {
  if (!USE_CLOUD) return Promise.resolve(false)
  if (!wx.cloud) {
    console.warn('[cloud] 当前基础库不支持云开发，请使用 2.2.3 以上基础库')
    return Promise.resolve(false)
  }
  if (initPromise) return initPromise

  initPromise = (async () => {
    try {
      const Cloud = (wx.cloud as typeof wx.cloud & { Cloud?: SharedCloudConstructor }).Cloud
      if (!Cloud) throw new Error('当前基础库不支持云开发环境共享，请升级到 2.13.0 以上')

      // 部分基础库要求先启用当前小程序的默认 Cloud API，随后共享实例才能使用 database()。
      // 业务请求仍全部经 shared 发往 resourceEnv，不会读写当前小程序自己的云环境。
      wx.cloud.init({ env: CLOUD_BOOTSTRAP_ENV_ID, traceUser: true })
      const shared = new Cloud({
        resourceAppid: CLOUD_RESOURCE_APP_ID,
        resourceEnv: CLOUD_ENV_ID,
      })
      await shared.init()
      cloudClient = shared
      ready = true
      console.info('[cloud] 共享云环境初始化完成')
      return true
    } catch (error) {
      ready = false
      cloudClient = null
      console.error('[cloud] 共享云环境初始化失败，业务将使用本地兜底', error)
      return false
    }
  })().then((success) => {
    // 首次鉴权或网络超时后允许页面“重新加载”再试；成功时继续复用同一实例。
    if (!success) initPromise = null
    return success
  })
  return initPromise
}

export const isCloudReady = (): boolean => ready

/** 等待共享环境完成鉴权；所有异步业务入口均应先调用。 */
export async function ensureCloudReady(): Promise<boolean> {
  return ready || initCloud()
}

export interface CloudResult<T> {
  ok: boolean
  data?: T
  code?: string
  message?: string
  debug?: string
}

export class CloudError extends Error {
  code: string
  data?: unknown
  debug?: string
  constructor(code: string, message: string, data?: unknown, debug?: string) {
    super(message)
    this.code = code
    this.data = data
    this.debug = debug
  }
}

export async function callFunction<T = unknown>(
  name: string,
  data: Record<string, unknown> = {},
  options: { silent?: boolean } = {},
): Promise<T> {
  if (!(await ensureCloudReady()) || !cloudClient) throw new CloudError('CLOUD_DISABLED', '云开发未启用')
  try {
    const res = await cloudClient.callFunction({ name, data })
    const result = res.result as CloudResult<T> | undefined
    if (!result || !result.ok) {
      if (result && result.debug && !options.silent) console.warn(`[cloud:${name}]`, result.debug)
      throw new CloudError(
        (result && result.code) || 'UNKNOWN',
        (result && result.message) || '服务开小差了',
        result && result.data,
        result && result.debug,
      )
    }
    return result.data as T
  } catch (err) {
    if (err instanceof CloudError) throw err
    if (!options.silent) console.error(`[cloud:${name}] 调用失败，请检查云函数是否已部署`, err)
    throw new CloudError('CALL_FAILED', '网络不太稳定，请稍后再试')
  }
}

export function db(): DB.Database {
  if (!ready || !cloudClient) throw new CloudError('CLOUD_DISABLED', '云开发尚未初始化完成')
  return cloudClient.database()
}

/** 上传本地临时文件到云存储，返回 fileID */
export async function uploadFile(tempPath: string, dir: string): Promise<string> {
  if (!(await ensureCloudReady()) || !cloudClient) throw new CloudError('CLOUD_DISABLED', '云开发未启用')
  const ext = (tempPath.match(/\.(\w+)$/) || [])[1] || 'jpg'
  const cloudPath = `${dir}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
  const res = await cloudClient.uploadFile({ cloudPath, filePath: tempPath })
  return res.fileID
}
