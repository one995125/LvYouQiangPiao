/**
 * 我的旅行地图：地图几何只在本分包页加载，禁止主包引用 china-map.js。
 * TODO: 上线标准地图服务数据（含审图号）后，同步替换页面底部示意声明。
 */
import { PROVINCE_COLORS } from '../../../constants/travel-map'
import { getProvince } from '../../../constants/provinces'
import { listProvinceScenics } from '../../../services/scenic'
import {
  getProvinceMarkState,
  getVisitedProvinces,
  getVisitedScenics,
  getWishProvinces,
  getWishScenics,
  setProvinceMark,
  subscribe,
} from '../../../stores/user-data'
import { ProvinceMarkState, Scenic, ScenicMarkState } from '../../../types/index'

declare function require(path: string): unknown

type Point = [number, number]
interface MapProvince { code: string; name: string; rings: Point[][] }
interface ChinaMapData {
  provinceCount: number
  jiuduanxianSegments: number
  provinces: MapProvince[]
  jiuduanxian: Point[][]
}
interface ProvincePathView {
  code: string
  name: string
  path: string
  light: string
  dark: string
  fill: string
  stroke: string
  strokeWidth: number
  dash: string
  state: ProvinceMarkState
  bounce: boolean
}
interface TravelMapPageInstance extends WechatMiniprogram.Page.TrivialInstance {
  unsubscribeUserData?: () => void
  bounceTimer?: number
}

// 该 require 必须留在分包页；主包余量不足以容纳约 399KB 的真实省界数据。
const mapData = require('../../data/china-map.js') as ChinaMapData
const provinceCentroids = require('../../../data/province-centroids.js') as Record<string, Point>
const COS_355 = Math.cos((35.5 * Math.PI) / 180)
const MAIN_K = 481 / (53.8 - 17.8)

const mainPoint = ([lon, lat]: Point): Point => [
  (lon - 73) * COS_355 * MAIN_K,
  (53.8 - lat) * MAIN_K,
]

function pathFromRings(rings: Point[][], project: (point: Point) => Point): string {
  return rings.map((ring) => ring.map((point, index) => {
    const [x, y] = project(point)
    return `${index ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`
  }).join('') + 'Z').join('')
}

function splitHainanRings(rings: Point[][]): { main: Point[][]; inset: Point[][] } {
  const ordered = rings.map((ring, index) => ({ ring, index, size: ring.length, maxLat: Math.max(...ring.map((p) => p[1])) }))
  const mainland = ordered.slice().sort((a, b) => b.size - a.size)[0]
  // 设计稿主图含海南本岛和纬度最高的一枚近岸岛，其余 119 环全部进入南海内嵌框。
  const nearIsland = ordered.filter((item) => item.index !== mainland.index).sort((a, b) => b.maxLat - a.maxLat)[0]
  const mainIndexes = new Set([mainland.index, nearIsland.index])
  return {
    main: ordered.filter((item) => mainIndexes.has(item.index)).map((item) => item.ring),
    inset: ordered.filter((item) => !mainIndexes.has(item.index)).map((item) => item.ring),
  }
}

const hainan = mapData.provinces.find((item) => item.code === 'hainan')
const hainanRings = splitHainanRings(hainan ? hainan.rings : [])
const insetPoints = [...hainanRings.inset, ...mapData.jiuduanxian].flat()
const insetBounds = insetPoints.reduce(
  (bounds, [lon, lat]) => ({
    minLon: Math.min(bounds.minLon, lon), maxLon: Math.max(bounds.maxLon, lon),
    minLat: Math.min(bounds.minLat, lat), maxLat: Math.max(bounds.maxLat, lat),
  }),
  { minLon: Infinity, maxLon: -Infinity, minLat: Infinity, maxLat: -Infinity },
)
const INSET = { x: 572, y: 300, width: 94, height: 166 }
const insetScale = Math.min(
  INSET.width / Math.max(1, (insetBounds.maxLon - insetBounds.minLon) * COS_355),
  INSET.height / Math.max(1, insetBounds.maxLat - insetBounds.minLat),
)
const insetDrawWidth = (insetBounds.maxLon - insetBounds.minLon) * COS_355 * insetScale
const insetDrawHeight = (insetBounds.maxLat - insetBounds.minLat) * insetScale
const insetPoint = ([lon, lat]: Point): Point => [
  INSET.x + (INSET.width - insetDrawWidth) / 2 + (lon - insetBounds.minLon) * COS_355 * insetScale,
  INSET.y + (INSET.height - insetDrawHeight) / 2 + (insetBounds.maxLat - lat) * insetScale,
]

const provinceBasePaths = mapData.provinces.map((province) => ({
  code: province.code,
  name: province.name,
  path: pathFromRings(province.code === 'hainan' ? hainanRings.main : province.rings, mainPoint),
}))
const insetIslandPath = pathFromRings(hainanRings.inset, insetPoint)
const nineDashPaths = mapData.jiuduanxian.map((ring) => pathFromRings([ring], insetPoint))

function styleProvince(code: string, name: string, path: string, bounceCode = ''): ProvincePathView {
  const state = getProvinceMarkState(code)
  const colors = PROVINCE_COLORS[code]
  return {
    code, name, path, state, light: colors.light, dark: colors.dark,
    fill: state === 'visited' ? colors.dark : colors.light,
    stroke: state === 'visited' ? '#1E201F' : state === 'wish' ? '#A9844F' : '#C9C4B4',
    strokeWidth: state === 'visited' ? 2.4 : state === 'wish' ? 2 : 0.7,
    dash: state === 'wish' ? '5 3.6' : '',
    bounce: bounceCode === code,
  }
}

Page({
  data: {
    provinces: [] as ProvincePathView[],
    nineDashPaths,
    insetIslandPath,
    selectedCode: '',
    selectedName: '',
    selectedSlogan: '',
    selectedState: 'none' as ProvinceMarkState,
    labelX: 340,
    labelY: 26,
    panelVisible: false,
    scenicLoading: false,
    provinceScenics: [] as Scenic[],
    litCount: 0,
    visitedScenicCount: 0,
    wishScenicCount: 0,
  },

  onLoad() {
    const self = this as unknown as TravelMapPageInstance
    self.unsubscribeUserData = subscribe(() => this.refreshState())
    this.refreshState()
  },

  onUnload() {
    const self = this as unknown as TravelMapPageInstance
    if (self.unsubscribeUserData) self.unsubscribeUserData()
    if (self.bounceTimer) clearTimeout(self.bounceTimer)
  },

  refreshState(bounceCode = '') {
    const visited = getVisitedProvinces()
    const wish = getWishProvinces()
    const selectedCode = this.data.selectedCode
    this.setData({
      provinces: provinceBasePaths.map((item) => styleProvince(item.code, item.name, item.path, bounceCode)),
      litCount: new Set([...visited, ...wish]).size,
      visitedScenicCount: getVisitedScenics().length,
      wishScenicCount: getWishScenics().length,
      selectedState: selectedCode ? getProvinceMarkState(selectedCode) : 'none',
    })
  },

  async onProvinceTap(e: WechatMiniprogram.TouchEvent) {
    const code = String(e.currentTarget.dataset.code || '')
    if (!code) return
    const province = getProvince(code)
    const [labelX, labelY] = mainPoint(provinceCentroids[code] || [104, 35])
    const self = this as unknown as TravelMapPageInstance
    if (self.bounceTimer) clearTimeout(self.bounceTimer)
    this.setData({
      selectedCode: code,
      selectedName: province.name,
      selectedSlogan: province.slogan.replace('\n', '，'),
      selectedState: getProvinceMarkState(code),
      labelX,
      labelY: Math.max(16, labelY - 8),
      panelVisible: true,
      scenicLoading: true,
      provinceScenics: [],
    })
    this.refreshState(code)
    self.bounceTimer = setTimeout(() => this.refreshState(), 320) as unknown as number
    const list = await listProvinceScenics(code)
    if (this.data.selectedCode === code) this.setData({ provinceScenics: list, scenicLoading: false })
  },

  closePanel() {
    this.setData({ panelVisible: false })
  },

  onMarkProvince(e: WechatMiniprogram.TouchEvent) {
    const state = String(e.currentTarget.dataset.state || '') as ScenicMarkState
    const code = this.data.selectedCode
    if (!code || !['visited', 'wish'].includes(state)) return
    const next = this.data.selectedState === state ? null : state
    setProvinceMark(code, next)
    this.refreshState(code)
  },

  onOpenScenic(e: WechatMiniprogram.TouchEvent) {
    const id = String(e.currentTarget.dataset.id || '')
    if (id) wx.navigateTo({ url: `/pages/scenic/index?id=${encodeURIComponent(id)}` })
  },
})
