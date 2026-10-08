/**
 * 景区分享图：使用 Canvas 2D 在本机绘制，不上传景区或用户数据。
 * 画布按 CSS 尺寸绘制、按设备 DPR 扩大实际像素，保证真机导出文字清晰。
 */
import { TONES } from '../constants/enums'
import { Scenic } from '../types/index'
import { formatPrice } from './format'

export const SCENIC_SHARE_CANVAS_ID = 'scenicSharePoster'

interface CanvasNodeResult {
  node?: WechatMiniprogram.Canvas
  width?: number
  height?: number
}

interface WindowInfoLike {
  windowWidth: number
  pixelRatio?: number
}

/** 当前项目 typings 未声明 Canvas 2D 的 textAlign 属性，运行时基础库已支持。 */
type Canvas2DContext = WechatMiniprogram.CanvasContext & {
  textAlign: 'left' | 'center' | 'right' | 'start' | 'end'
}

const wxWindow = wx as unknown as {
  getWindowInfo?: () => WindowInfoLike
  getSystemInfoSync: () => WindowInfoLike
}

/** 获取 Canvas 2D 节点；节点尚未渲染或尺寸为 0 时明确失败，由页面回退普通分享。 */
function getCanvasNode(
  page: WechatMiniprogram.Page.TrivialInstance,
  canvasId: string,
): Promise<{ canvas: WechatMiniprogram.Canvas; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    wx.createSelectorQuery()
      .in(page)
      .select(`#${canvasId}`)
      .fields({ node: true, size: true })
      .exec((results: CanvasNodeResult[]) => {
        const result = results && results[0]
        if (!result?.node || !result.width || !result.height) {
          reject(new Error('分享图画布尚未就绪'))
          return
        }
        resolve({ canvas: result.node, width: result.width, height: result.height })
      })
  })
}

function roundedRect(
  ctx: WechatMiniprogram.CanvasContext,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const r = Math.min(radius, width / 2, height / 2)
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + width - r, y)
  ctx.quadraticCurveTo(x + width, y, x + width, y + r)
  ctx.lineTo(x + width, y + height - r)
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height)
  ctx.lineTo(x + r, y + height)
  ctx.quadraticCurveTo(x, y + height, x, y + height - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

/** 按真实文字宽度截断，避免长景区名或指标值越过卡片边界。 */
export function ellipsisText(ctx: WechatMiniprogram.CanvasContext, value: string, maxWidth: number): string {
  const text = String(value || '')
  if (ctx.measureText(text).width <= maxWidth) return text
  let shortened = text
  while (shortened && ctx.measureText(`${shortened}…`).width > maxWidth) shortened = shortened.slice(0, -1)
  return shortened ? `${shortened}…` : '…'
}

/** 长标题最多两行，按字符测量而非固定字数，兼容中英文和窄屏设备。 */
function titleLines(ctx: WechatMiniprogram.CanvasContext, value: string, maxWidth: number): string[] {
  const chars = Array.from(String(value || ''))
  const lines: string[] = []
  let current = ''
  while (chars.length && lines.length < 2) {
    const next = `${current}${chars[0]}`
    if (current && ctx.measureText(next).width > maxWidth) {
      lines.push(current)
      current = ''
    } else {
      current = next
      chars.shift()
    }
  }
  if (current && lines.length < 2) lines.push(current)
  if (chars.length && lines.length) lines[lines.length - 1] = ellipsisText(ctx, `${lines[lines.length - 1]}${chars.join('')}`, maxWidth)
  return lines.length ? lines : ['景区资料']
}

function drawMountains(ctx: WechatMiniprogram.CanvasContext, width: number, height: number) {
  ctx.save()
  ctx.globalAlpha = 0.12
  ctx.fillStyle = '#FFFFFF'
  ctx.beginPath()
  ctx.moveTo(-20, height * 0.58)
  ctx.quadraticCurveTo(width * 0.18, height * 0.36, width * 0.42, height * 0.57)
  ctx.quadraticCurveTo(width * 0.66, height * 0.74, width + 30, height * 0.43)
  ctx.lineTo(width + 30, height)
  ctx.lineTo(-20, height)
  ctx.closePath()
  ctx.fill()

  ctx.globalAlpha = 0.09
  ctx.fillStyle = '#101714'
  ctx.beginPath()
  ctx.moveTo(-20, height * 0.7)
  ctx.quadraticCurveTo(width * 0.24, height * 0.5, width * 0.55, height * 0.68)
  ctx.quadraticCurveTo(width * 0.78, height * 0.83, width + 30, height * 0.61)
  ctx.lineTo(width + 30, height)
  ctx.lineTo(-20, height)
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

function drawMetric(
  ctx: WechatMiniprogram.CanvasContext,
  label: string,
  value: string,
  x: number,
  y: number,
  width: number,
) {
  ctx.fillStyle = '#8D918D'
  ctx.font = '400 11px sans-serif'
  ctx.fillText(label, x, y)
  ctx.fillStyle = '#1E201F'
  ctx.font = '600 20px sans-serif'
  ctx.fillText(ellipsisText(ctx, value, width), x, y + 28)
}

function exportCanvas(canvas: WechatMiniprogram.Canvas): Promise<string> {
  return new Promise((resolve, reject) => {
    wx.canvasToTempFilePath({
      canvas,
      destWidth: canvas.width,
      destHeight: canvas.height,
      fileType: 'jpg',
      quality: 0.94,
      success: (result) => resolve(result.tempFilePath),
      fail: (error) => reject(new Error(error.errMsg || '分享图导出失败')),
    })
  })
}

/**
 * 生成 5:4 景区分享卡片。
 * @param page 页面实例，用于定位当前页面内的 Canvas 2D 节点。
 * @param scenic 已加载的景区资料；不会写入 storage 或上传云端。
 * @param place 已校验的省份与城市展示文本。
 */
export async function createScenicSharePoster(
  page: WechatMiniprogram.Page.TrivialInstance,
  scenic: Scenic,
  place: string,
): Promise<string> {
  const { canvas, width, height } = await getCanvasNode(page, SCENIC_SHARE_CANVAS_ID)
  const windowInfo = wxWindow.getWindowInfo ? wxWindow.getWindowInfo() : wxWindow.getSystemInfoSync()
  const dpr = Math.max(1, Number(windowInfo.pixelRatio) || 1)
  canvas.width = Math.round(width * dpr)
  canvas.height = Math.round(height * dpr)
  const ctx = canvas.getContext('2d') as Canvas2DContext
  if (!ctx) throw new Error('当前基础库不支持 Canvas 2D')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

  const palette = TONES[scenic.tone] || TONES.jade
  const gradient = ctx.createLinearGradient(0, 0, width, height)
  gradient.addColorStop(0, palette[0])
  gradient.addColorStop(1, palette[1])
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, width, height)
  drawMountains(ctx, width, height)

  const padding = Math.max(24, width * 0.075)
  ctx.fillStyle = palette[2]
  ctx.globalAlpha = 0.8
  ctx.font = '500 10px sans-serif'
  ctx.fillText('拾景 · SHIJING', padding, 34)
  ctx.globalAlpha = 1

  ctx.fillStyle = palette[2]
  ctx.font = '600 38px sans-serif'
  const lines = titleLines(ctx, scenic.name, width - padding * 2)
  lines.forEach((line, index) => ctx.fillText(line, padding, 82 + index * 45))

  const metaY = 82 + lines.length * 45 + 5
  ctx.globalAlpha = 0.82
  ctx.font = '400 13px sans-serif'
  const placeLabel = [place, scenic.level, scenic.category].filter(Boolean).join(' · ')
  ctx.fillText(ellipsisText(ctx, placeLabel, width - padding * 2), padding, metaY)
  ctx.globalAlpha = 1

  const panelY = height - 112
  const panelHeight = 82
  roundedRect(ctx, padding, panelY, width - padding * 2, panelHeight, 18)
  ctx.fillStyle = 'rgba(253, 252, 249, 0.94)'
  ctx.fill()

  const metricWidth = (width - padding * 2 - 40) / 3
  drawMetric(ctx, '旺季门票', formatPrice(scenic.price), padding + 16, panelY + 25, metricWidth - 8)
  drawMetric(ctx, '热度指数', String(scenic.heat), padding + 16 + metricWidth, panelY + 25, metricWidth - 8)
  drawMetric(ctx, '口碑评分', `${scenic.rating.toFixed(1)} / 5`, padding + 16 + metricWidth * 2, panelY + 25, metricWidth - 8)

  ctx.fillStyle = 'rgba(244, 241, 234, 0.78)'
  ctx.font = '400 9px sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText('资料仅供参考 · 拾景不参与售票', width / 2, height - 10)
  ctx.textAlign = 'left'

  // 等待本帧绘制提交后再导出，避免部分安卓机得到空白图片。
  await new Promise<void>((resolve) => {
    if (typeof canvas.requestAnimationFrame === 'function') canvas.requestAnimationFrame(() => resolve())
    else setTimeout(resolve, 30)
  })
  return exportCanvas(canvas)
}

/** 保存动作只应由用户点击触发；本函数不会在启动或页面展示时主动申请相册权限。 */
export function saveSharePoster(filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    wx.saveImageToPhotosAlbum({
      filePath,
      success: () => resolve(),
      fail: (error) => reject(new Error(error.errMsg || '保存到相册失败')),
    })
  })
}

export function isAlbumPermissionDenied(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '')
  return /auth deny|authorize|permission|cancel/i.test(message)
}
