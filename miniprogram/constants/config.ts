/**
 * 全局配置
 * 当前与「记得」项目共用一个云开发环境。
 * 共享环境中的云函数、集合与云存储目录统一使用 shijing 命名空间，避免跨项目覆盖。
 */

/** 共享云开发环境 ID */
export const CLOUD_ENV_ID = 'cloud1-d4gfatip0edd01506'

/** 共享云环境的资源方小程序 AppID（四象限待办清单） */
export const CLOUD_RESOURCE_APP_ID = 'wx754380008b8e5ace'

/** 当前小程序自己的默认环境，仅用于启用基础 Cloud API，不承载拾景业务数据 */
export const CLOUD_BOOTSTRAP_ENV_ID = 'cloud1-d8g54xsccc92bf00a'

/** 是否启用云开发 */
export const USE_CLOUD = CLOUD_ENV_ID.length > 0

export const APP_NAME = '拾景'
export const APP_SLOGAN = '景区官方购票入口 · 一处收拢'

/**
 * 一次性订阅消息模板。
 * TODO: 在微信公众平台「功能 → 订阅消息」申请模板后填入；上线前还需把相同 ID 配到
 * shijingReminder 云函数环境变量 TRIP_REMINDER_TEMPLATE_ID / RELEASE_REMINDER_TEMPLATE_ID。
 * 保持空字符串时客户端会静默跳过授权与登记，不影响行程保存。
 */
export const SUBSCRIBE_TEMPLATE_IDS = {
  tripReminder: '',
  releaseReminder: '',
} as const

/**
 * 第三方天气服务配置。
 * TODO: 上线前填写已备案并加入 request 合法域名的 HTTPS endpoint 与服务端 key。
 * 两项任一为空时天气能力完全关闭，客户端不会发起任何天气请求。
 */
export const WEATHER_API_CONFIG = {
  endpoint: '',
  key: '',
  timeoutMs: 5000,
} as const

/** 默认省份（首次进入时展示） */
export const DEFAULT_PROVINCE = 'shanxi'

/** 列表分页大小 */
export const PAGE_SIZE = 20

/** 与已部署的 shijingUserData 云函数 MAX_ITEMS 保持一致，防止超额收藏被云端静默裁剪。 */
export const MAX_SYNC_FAVORITES = 500

/** 足迹只保留最近 200 个景区；客户端与云函数必须保持一致。 */
export const MAX_SYNC_FOOTPRINTS = 200

/** 行程与云函数 MAX_ITEMS 保持一致；超限时保留最近更新的行程。 */
export const MAX_SYNC_TRIPS = 500

/** 每类删除墓碑最多保留最近 500 条，与云函数上限保持一致。 */
export const MAX_SYNC_TOMBSTONES = 500

/** 旅行地图覆盖全部 34 个省级行政区；客户端与云函数保持同一上限。 */
export const MAX_SYNC_PROVINCES = 34

/** “去过/想去”景区各自独立保留最近更新的 500 条。 */
export const MAX_SYNC_SCENIC_MARKS = 500

/** 攻略标签由管理员维护；客户端和 shijingGuide 云函数须保持相同上限。 */
export const MAX_GUIDE_TAGS = 10
export const MAX_GUIDE_TAG_LENGTH = 16

/** 本地存储 key */
export const STORAGE_KEYS = {
  province: 'sj_province',
  favorites: 'sj_favorites',
  footprints: 'sj_footprints',
  footprintClearedAt: 'sj_footprint_cleared_at',
  trips: 'sj_trips',
  profile: 'sj_profile',
  localGuides: 'sj_local_guides',
  likedGuides: 'sj_liked_guides',
  searchHistory: 'sj_search_history',
  /** 攻略搜索词与景区搜索词分开保存，避免两类历史互相污染。 */
  guideSearchHistory: 'sj_guide_search_history',
  syncedAt: 'sj_synced_at',
  favoriteTombstones: 'sj_favorite_tombstones',
  tripTombstones: 'sj_trip_tombstones',
  visitedProvinces: 'sj_visited_provinces',
  wishProvinces: 'sj_wish_provinces',
  provinceMarks: 'sj_province_marks',
  visitedScenics: 'sj_visited_scenics',
  wishScenics: 'sj_wish_scenics',
  visitedScenicTombstones: 'sj_visited_scenic_tombstones',
  wishScenicTombstones: 'sj_wish_scenic_tombstones',
  syncMeta: 'sj_sync_meta_v2',
  compareIds: 'sj_compare_ids',
  /** 天气结果与已核验景区地点的本地派生缓存，不参与用户数据云同步。 */
  weatherCache: 'sj_weather_cache_v1',
}

/** 共享云环境中的云函数名 */
export const CLOUD_FUNCTIONS = {
  login: 'shijingLogin',
  userData: 'shijingUserData',
  guide: 'shijingGuide',
  initData: 'shijingInitData',
  correction: 'shijingCorrection',
  reminder: 'shijingReminder',
  tripShare: 'shijingTripShare',
  log: 'shijingLog',
  admin: 'shijingAdmin',
} as const

/** 共享云环境中的云数据库集合名 */
export const COLLECTIONS = {
  scenics: 'shijing_scenics',
  guides: 'shijing_guides',
  users: 'shijing_users',
  userData: 'shijing_user_data',
  guideLikes: 'shijing_guide_likes',
  corrections: 'shijing_corrections',
  reminders: 'shijing_reminders',
  reminderLogs: 'shijing_reminder_logs',
  tripShares: 'shijing_trip_shares',
  logs: 'shijing_logs',
} as const
