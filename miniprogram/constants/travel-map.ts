/**
 * 旅行地图定稿色板。
 * 颜色映射直接来自 map-design.html，硬编码以保证不同设备与版本显示一致。
 */
export interface ProvinceColor {
  light: string
  dark: string
}

const color = (hue: number): ProvinceColor => ({
  light: `hsl(${hue},30%,78%)`,
  dark: `hsl(${hue},34%,56%)`,
})

export const PROVINCE_COLORS: Record<string, ProvinceColor> = {
  beijing: color(10), tianjin: color(34), hebei: color(52), shanxi: color(88),
  neimenggu: color(132), liaoning: color(168), jilin: color(202), heilongjiang: color(226),
  shanghai: color(288), jiangsu: color(332), zhejiang: color(10), anhui: color(34),
  fujian: color(52), jiangxi: color(88), shandong: color(202), henan: color(132),
  hubei: color(168), hunan: color(226), guangdong: color(288), guangxi: color(332),
  hainan: color(10), chongqing: color(34), sichuan: color(52), guizhou: color(88),
  yunnan: color(132), xizang: color(168), shaanxi: color(202), gansu: color(226),
  qinghai: color(288), ningxia: color(332), xinjiang: color(10), taiwan: color(34),
  xianggang: color(52), aomen: color(88),
}

export const TRAVEL_MAP_TOTAL_PROVINCES = 34

