import { GuideCategory, SortKey, Tone, TripStatus } from '../types/index'

export const SORT_OPTIONS: { key: SortKey; label: string; hint: string }[] = [
  { key: 'heat', label: '综合热度', hint: '热度指数' },
  { key: 'nearest', label: '离我最近', hint: '直线距离 · 仅按已核验坐标' },
  { key: 'visitors', label: '游客量', hint: '年接待 · 万人次' },
  { key: 'rating', label: '口碑评分', hint: '综合评分' },
  { key: 'price', label: '门票从低', hint: '旺季门票' },
]

export const GUIDE_CATEGORIES: { key: GuideCategory | 'all'; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'guide', label: '游玩攻略' },
  { key: 'avoid', label: '避雷' },
  { key: 'ticket', label: '抢票技巧' },
  { key: 'route', label: '路线交通' },
  { key: 'food', label: '吃住推荐' },
]

export const GUIDE_CATEGORY_LABEL: Record<GuideCategory, string> = {
  guide: '游玩攻略',
  avoid: '避雷',
  ticket: '抢票技巧',
  route: '路线交通',
  food: '吃住推荐',
}

export const TRIP_STATUS: Record<TripStatus, { label: string; cls: string }> = {
  pending: { label: '待抢票', cls: 'pending' },
  booked: { label: '已购票', cls: 'booked' },
  done: { label: '已出行', cls: 'done' },
}

/** 封面渐变：[起始色, 终止色, 文字色] —— 取自传统色谱，低饱和保持质感 */
export const TONES: Record<Tone, [string, string, string]> = {
  jade: ['#2F5A51', '#8FB2A4', '#F4F1EA'],
  ochre: ['#8A5A3B', '#D4A77A', '#FBF5EC'],
  mist: ['#5E6F78', '#BCC8CC', '#F7F8F6'],
  lake: ['#2C4F6B', '#86A9BF', '#F2F6F8'],
  dusk: ['#5B3F56', '#C79AA6', '#FAF2F3'],
  ink: ['#26292A', '#6C7373', '#F2F1EC'],
  rose: ['#9A4B3E', '#E0A38F', '#FDF4EF'],
  sand: ['#8C7A55', '#DCCDA6', '#FBF8EF'],
}

export function toneStyle(tone: Tone): string {
  const t = TONES[tone] || TONES.jade
  return `background: linear-gradient(135deg, ${t[0]} 0%, ${t[1]} 100%); color: ${t[2]};`
}
