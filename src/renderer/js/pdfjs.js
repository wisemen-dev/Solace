// pdf.js 共享加载点：预览与封面生成统一从这里拿实例，worker 只配置一次
import * as pdfjsLib from '../../../node_modules/pdfjs-dist/build/pdf.min.mjs'

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  '../../../node_modules/pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).href

export default pdfjsLib
