// pdf.js 共享加载点：预览与封面/索引统一从这里拿实例，worker 只配置一次
import * as pdfjsLib from '../../../node_modules/pdfjs-dist/build/pdf.min.mjs'

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  '../../../node_modules/pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).href

// 打开 PDF 必须随附的资源：
// - cmaps：未嵌入字体的中文 PDF（CIDFontType0 + Adobe-GB1 等 CMap 编码）
//   靠它解码文字，缺了整段文字渲染/提取不出来；
// - standard_fonts：未嵌入的标准 14 字体（Helvetica 等）的字形数据。
// 均以相对 URL 指向 node_modules，随 getDocument 参数下发
export const docParams = {
  cMapUrl: new URL('../../../node_modules/pdfjs-dist/cmaps/', import.meta.url).href,
  cMapPacked: true,
  standardFontDataUrl: new URL('../../../node_modules/pdfjs-dist/standard_fonts/', import.meta.url).href
}

export default pdfjsLib
