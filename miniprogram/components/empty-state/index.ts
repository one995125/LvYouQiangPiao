/** 空状态 / 错误态 */
Component({
  options: { styleIsolation: 'apply-shared' },
  properties: {
    icon: { type: String, value: 'compass' },
    title: { type: String, value: '这里还空着' },
    desc: { type: String, value: '' },
  },
})
