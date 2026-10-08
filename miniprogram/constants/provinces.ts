import { Province } from '../types/index'

/** 省级行政区（含港澳台），slogan 用于首页标题排版 */
export const PROVINCES: Province[] = [
  { code: 'beijing', name: '北京', region: '华北', slogan: '红墙金瓦，\n六百年的城' },
  { code: 'tianjin', name: '天津', region: '华北', slogan: '九河下梢，\n万国建筑' },
  { code: 'hebei', name: '河北', region: '华北', slogan: '燕赵故地，\n长城入海' },
  { code: 'shanxi', name: '山西', region: '华北', slogan: '表里山河，\n地上文物看山西' },
  { code: 'neimenggu', name: '内蒙古', region: '华北', slogan: '风吹草低，\n天高地阔' },
  { code: 'liaoning', name: '辽宁', region: '东北', slogan: '一宫两陵，\n渤海长风' },
  { code: 'jilin', name: '吉林', region: '东北', slogan: '长白雪岭，\n雾凇江城' },
  { code: 'heilongjiang', name: '黑龙江', region: '东北', slogan: '冰雪尔滨，\n北国风光' },
  { code: 'shanghai', name: '上海', region: '华东', slogan: '外滩灯火，\n海上繁华' },
  { code: 'jiangsu', name: '江苏', region: '华东', slogan: '水韵江苏，\n园林甲天下' },
  { code: 'zhejiang', name: '浙江', region: '华东', slogan: '诗画江南，\n一湖烟雨' },
  { code: 'anhui', name: '安徽', region: '华东', slogan: '黄山归来，\n不看岳' },
  { code: 'fujian', name: '福建', region: '华东', slogan: '武夷九曲，\n土楼人家' },
  { code: 'jiangxi', name: '江西', region: '华东', slogan: '庐山烟雨，\n瓷都千年' },
  { code: 'shandong', name: '山东', region: '华东', slogan: '一山一水，\n一圣人' },
  { code: 'henan', name: '河南', region: '华中', slogan: '行走河南，\n读懂中国' },
  { code: 'hubei', name: '湖北', region: '华中', slogan: '极目楚天，\n千湖之省' },
  { code: 'hunan', name: '湖南', region: '华中', slogan: '奇峰三千，\n潇湘洞庭' },
  { code: 'guangdong', name: '广东', region: '华南', slogan: '岭南风物，\n骑楼烟火' },
  { code: 'guangxi', name: '广西', region: '华南', slogan: '山水甲天下，\n漓江一抹青' },
  { code: 'hainan', name: '海南', region: '华南', slogan: '椰风海韵，\n天涯海角' },
  { code: 'chongqing', name: '重庆', region: '西南', slogan: '山城雾都，\n魔幻立体' },
  { code: 'sichuan', name: '四川', region: '西南', slogan: '天府之国，\n九寨归来' },
  { code: 'guizhou', name: '贵州', region: '西南', slogan: '山地公园，\n飞瀑苗寨' },
  { code: 'yunnan', name: '云南', region: '西南', slogan: '彩云之南，\n有风的地方' },
  { code: 'xizang', name: '西藏', region: '西南', slogan: '日光之城，\n离天最近' },
  { code: 'shaanxi', name: '陕西', region: '西北', slogan: '十三朝古都，\n长安月下' },
  { code: 'gansu', name: '甘肃', region: '西北', slogan: '交响丝路，\n如意敦煌' },
  { code: 'qinghai', name: '青海', region: '西北', slogan: '大美青海，\n天空之境' },
  { code: 'ningxia', name: '宁夏', region: '西北', slogan: '塞上江南，\n大漠孤烟' },
  { code: 'xinjiang', name: '新疆', region: '西北', slogan: '大美新疆，\n辽阔无垠' },
  { code: 'xianggang', name: '香港', region: '港澳台', slogan: '东方之珠，\n维港夜色' },
  { code: 'aomen', name: '澳门', region: '港澳台', slogan: '中西交汇，\n历史城区' },
  { code: 'taiwan', name: '台湾', region: '港澳台', slogan: '宝岛山海，\n日月潭影' },
]

export const REGIONS = ['华北', '东北', '华东', '华中', '华南', '西南', '西北', '港澳台']

export function getProvince(code: string): Province {
  return PROVINCES.find((p) => p.code === code) || PROVINCES[3]
}
