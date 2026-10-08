/**
 * 业务数据模型
 * 云数据库文档结构与本地示例数据保持一致，便于无缝切换。
 */

/** 景区色调，用于生成封面渐变（无图时的高级感兜底） */
export type Tone = 'jade' | 'ochre' | 'mist' | 'lake' | 'dusk' | 'ink' | 'rose' | 'sand'

export type ScenicCategory = '山岳' | '古迹' | '水域' | '博物馆' | '古镇' | '自然' | '主题乐园' | '宗教'

/** 官方渠道的用途，同一景区可分别维护门票、索道、演出等入口。 */
export type OfficialEntryPurpose = 'ticket' | 'reservation' | 'cableway' | 'performance' | 'transport' | 'guide' | 'other'

/**
 * 官方购票渠道
 * - miniprogram：跳转其他小程序（优先 shortLink，其次 appId + path）
 * - web：官方网站（小程序内无法直接打开外链，采用复制链接方式）
 * - phone：电话预约
 * - free：免费开放 / 无需预约
 * - none：暂未收录
 */
export interface TicketChannel {
  type: 'miniprogram' | 'web' | 'phone' | 'free' | 'none'
  /** 渠道名称，如「云冈石窟文旅」 */
  name: string
  /** 小程序短链，形如 #小程序://名称/xxxx */
  shortLink?: string
  appId?: string
  path?: string
  url?: string
  phone?: string
  /** 是否已人工核验为官方渠道 */
  verified?: boolean
  /** 渠道用途；旧数据未填时默认为 ticket。 */
  purpose?: OfficialEntryPurpose
  /** 渠道信息的来源和核验日期，便于追溯与过期检查。 */
  sourceName?: string
  sourceUrl?: string
  checkedAt?: string
  validUntil?: string
  note?: string
}

/** 景区官方服务入口，id 在同一景区内保持唯一。 */
export interface OfficialEntry extends TicketChannel {
  id: string
  purpose: OfficialEntryPurpose
}

/** 景区资料来源；来源地址只用于追溯，不应冒充可跳转的官方小程序入口。 */
export interface ScenicSource {
  id: string
  name: string
  url?: string
  checkedAt?: string
  validUntil?: string
  note?: string
}

/** 结构化预约规则；未确认的字段留空，页面不做推测。 */
export interface ReservationRule {
  required?: boolean
  advanceDays?: number
  releaseTime?: string
  realName?: boolean
  documents?: string[]
  timeSlotRequired?: boolean
  refundRule?: string
  audienceRule?: string
  note?: string
}

export type ScenicNoticeType = 'closure' | 'weather' | 'limit' | 'maintenance' | 'info'

/** 景区临时公告；开始/结束日期使用 YYYY-MM-DD，超出有效期后页面自动隐藏。 */
export interface ScenicNotice {
  id: string
  type: ScenicNoticeType
  title: string
  content: string
  startAt?: string
  endAt?: string
  sourceName: string
  sourceUrl?: string
  checkedAt: string
}

/** 已人工核验的景区坐标；地图能力统一使用 GCJ-02 坐标。 */
export interface ScenicLocation {
  lat: number
  lng: number
}

export interface Scenic {
  _id: string
  name: string
  /** 英文 / 拼音副标题，用于排版点缀 */
  alias: string
  province: string
  city: string
  /** 未核验时保持为空，不根据城市或名称推测。 */
  location?: ScenicLocation
  /** 与坐标对应的已核验地址；允许旧数据暂未填写。 */
  address?: string
  level: '5A' | '4A' | '世界遗产' | ''
  category: ScenicCategory
  tone: Tone
  cover?: string
  /** 年接待游客量（万人次，参考值） */
  visitors: number
  /** 综合评分 0-5 */
  rating: number
  /** 热度指数 0-100 */
  heat: number
  /** 旺季门票（元），0 表示免费 */
  price: number
  /** 建议游玩时长 */
  duration: string
  openTime: string
  intro: string
  highlights: string[]
  /** 放票 / 预约规则 */
  booking: string
  /** 新数据优先使用结构化规则；booking 保留作为旧数据兜底。 */
  reservation?: ReservationRule
  tips: string[]
  pitfalls: string[]
  /** 可配置多个官方服务入口；ticket 保留作为旧数据兜底。 */
  officialEntries?: OfficialEntry[]
  sources?: ScenicSource[]
  /** 别名、拼音或运营人员明确录入的搜索词。 */
  searchKeywords?: string[]
  tags?: string[]
  notices?: ScenicNotice[]
  ticket: TicketChannel
  updatedAt: string
  /** 管理员维护资料的服务端版本；旧文档按 0 处理。 */
  contentRevision?: number
}

/** 首页列表视图可附带本次定位计算出的距离，不写回云端景区文档。 */
export interface ScenicListItem extends Scenic {
  distanceKm?: number
}

export type SortKey = 'heat' | 'visitors' | 'rating' | 'price' | 'nearest'

export type GuideCategory = 'guide' | 'avoid' | 'ticket' | 'food' | 'route'

export interface GuideBlock {
  type: 'h' | 'p' | 'tip' | 'warn'
  text: string
}

export interface Guide {
  _id: string
  _openid?: string
  title: string
  summary: string
  category: GuideCategory
  province: string
  scenicId?: string
  scenicName?: string
  tone: Tone
  /** 编辑整理的主题标签；旧攻略未填写时按空数组展示。 */
  tags?: string[]
  blocks: GuideBlock[]
  /** approved 公开 / pending 管理员草稿（历史投稿仍不可公开） / local 仅本地 */
  status: 'approved' | 'pending' | 'local'
  official?: boolean
  createdAt: number
  updatedAt?: number
  /** 管理员编辑的服务端版本；旧资料按 0 处理。 */
  contentRevision?: number
}

export interface FavoriteItem {
  /** `${type}:${targetId}` */
  id: string
  type: 'scenic' | 'guide'
  targetId: string
  title: string
  subtitle: string
  tone: Tone
  createdAt: number
}

/** 景区浏览足迹；每个景区只保留最近一次浏览快照。 */
export interface FootprintItem {
  /** 与 scenicId 相同，便于按景区去重和同步合并。 */
  id: string
  scenicId: string
  scenicName: string
  province: string
  city: string
  tone: Tone
  cover?: string
  /** 用户浏览时的本机真实时间，仅用于相对时间展示；同步冲突排序使用 visitedAt。 */
  localVisitedAt?: number
  visitedAt: number
}

/** 旅行地图的互斥标记；none 仅用于同步“取消标记”的确定性状态。 */
export type ScenicMarkState = 'visited' | 'wish'
export type ProvinceMarkState = ScenicMarkState | 'none'

/** 景区标记只同步最小数据，详情展示始终读取景区资料。 */
export interface ScenicMarkItem {
  id: string
  updatedAt: number
}

/** 省份标记带校正时间，保证跨设备合并时“后设置者覆盖”。 */
export interface ProvinceMarkRecord {
  code: string
  state: ProvinceMarkState
  updatedAt: number
}

export type TripStatus = 'pending' | 'booked' | 'done'
export type TripPeriod = 'all' | 'morning' | 'afternoon' | 'evening'

export interface TripItem {
  id: string
  scenicId: string
  scenicName: string
  province: string
  city: string
  tone: Tone
  /** 计划出行日期 YYYY-MM-DD，可为空 */
  date: string
  /** 老数据未填时按全天处理。 */
  period?: TripPeriod
  status: TripStatus
  note: string
  /** 用户选择的出行前准备项，不包含身份证号等敏感内容。 */
  checklist?: string[]
  ticket: TicketChannel
  booking: string
  createdAt: number
  updatedAt: number
}

/**
 * 行程分享快照中的单条只读数据。
 * 默认只包含景区、日期、时段和状态；备注与清单仅在分享者明确勾选后由云函数加入。
 */
export interface TripShareItem {
  scenicName: string
  date: string
  period: TripPeriod
  status: TripStatus
  note?: string
  checklist?: string[]
}

/** 云函数返回的公开只读快照；不包含分享者 openid 或本地同步字段。 */
export interface TripShareSnapshot {
  shareId: string
  trips: TripShareItem[]
  createdAt: number
  expiresAt: number
  /** 仅为匿名查看次数，不记录或返回查看者身份。 */
  viewCount?: number
}

export interface UserProfile {
  openid: string
  nickName: string
  avatarUrl: string
  /** 是否为云端真实登录 */
  cloud: boolean
  loginAt: number
}

export interface Province {
  code: string
  name: string
  region: string
  slogan: string
}
