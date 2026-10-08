/**
 * 色调封面：有图显示图片，无图时以传统色渐变 + 远山层叠剪影呈现，保证视觉统一且不依赖网络图片。
 */
import { toneStyle } from '../../constants/enums'
import { Tone } from '../../types/index'

Component({
  options: { styleIsolation: 'apply-shared' },
  properties: {
    tone: { type: String, value: 'jade' },
    src: { type: String, value: '' },
    radius: { type: String, value: '28rpx' },
    /** 是否显示远山剪影 */
    ridge: { type: Boolean, value: true },
    extClass: { type: String, value: '' },
  },
  data: { bg: '' },
  lifetimes: {
    attached() {
      this.setData({ bg: toneStyle(this.data.tone as Tone) })
    },
  },
  observers: {
    tone(tone: string) {
      this.setData({ bg: toneStyle(tone as Tone) })
    },
  },
})
