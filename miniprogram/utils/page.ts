/** 页面级工具 */

import { pendingTripCount } from '../stores/user-data'

/** 同步自定义 tabBar 选中态（需在 tab 页 onShow 调用） */
export function syncTabBar(page: WechatMiniprogram.Page.TrivialInstance, index: number) {
  const self = page as unknown as { getTabBar?: () => WechatMiniprogram.Component.TrivialInstance | undefined }
  const bar = typeof self.getTabBar === 'function' ? self.getTabBar() : undefined
  if (bar) bar.setData({ selected: index, badge: pendingTripCount() })
}

/** 胶囊按钮与状态栏布局信息，供自定义头部对齐使用 */
export interface NavMetrics {
  statusBar: number
  navHeight: number
  menuRight: number
  menuWidth: number
}

let cached: NavMetrics | null = null

interface MenuRect {
  top: number
  left: number
  width: number
  height: number
}

/** 项目内置 typings 较旧，getWindowInfo（基础库 2.20.1+）需手动声明 */
const wxx = wx as unknown as {
  getWindowInfo?: () => { statusBarHeight: number; windowWidth: number }
  getSystemInfoSync: () => { statusBarHeight: number; windowWidth: number }
  getMenuButtonBoundingClientRect: () => MenuRect
}

export function getNavMetrics(): NavMetrics {
  if (cached) return cached
  const win = wxx.getWindowInfo ? wxx.getWindowInfo() : wxx.getSystemInfoSync()
  let menu: MenuRect | null = null
  try {
    menu = wxx.getMenuButtonBoundingClientRect()
  } catch (e) {
    menu = null
  }
  const statusBar = win.statusBarHeight || 20
  const navHeight = menu && menu.top ? (menu.top - statusBar) * 2 + menu.height : 44
  cached = {
    statusBar,
    navHeight,
    menuRight: menu ? win.windowWidth - menu.left : 100,
    menuWidth: menu ? menu.width : 87,
  }
  return cached
}

export function toast(title: string) {
  wx.showToast({ title, icon: 'none', duration: 1800 })
}

export function vibrate() {
  wx.vibrateShort({ type: 'light' }).catch(() => undefined)
}
