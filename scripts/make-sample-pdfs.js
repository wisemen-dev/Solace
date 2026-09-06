// 生成最小合法 PDF 示例（纯 Node 无依赖），用于开发期视觉测试。
// 用法：node scripts/make-sample-pdfs.js [输出目录，默认 ../tmp]
// 产出的 PDF 为单页：标题文字 + 大色块，不同样本颜色不同。

const fs = require('fs')
const path = require('path')

function makePdf (file, title, color) {
  const stream = [
    `BT /F1 34 Tf ${color} rg 64 726 Td (${title}) Tj ET`,
    `BT /F1 13 Tf 0.35 0.39 0.45 rg 64 690 Td (Solace sample document for visual testing.) Tj ET`,
    `${color} rg 64 140 467 520 re f`
  ].join('\n')

  const objects = []
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'
  objects[3] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ' +
    '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>'
  objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  objects[5] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`

  let out = '%PDF-1.4\n'
  const offsets = [0]
  for (let i = 1; i < objects.length; i++) {
    offsets[i] = Buffer.byteLength(out)
    out += `${i} 0 obj\n${objects[i]}\nendobj\n`
  }
  const xrefStart = Buffer.byteLength(out)
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`
  for (let i = 1; i < objects.length; i++) {
    out += String(offsets[i]).padStart(10, '0') + ' 00000 n \n'
  }
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`

  fs.writeFileSync(file, out, 'latin1')
  console.log('已生成', file)
}

const outDir = process.argv[2] || path.join(__dirname, '..', 'tmp')
fs.mkdirSync(outDir, { recursive: true })

makePdf(path.join(outDir, 'sample-blue.pdf'), 'Sample: Deep Work', '0.30 0.55 0.95')
makePdf(path.join(outDir, 'sample-orange.pdf'), 'Sample: The Pragmatic Way', '0.92 0.49 0.19')
makePdf(path.join(outDir, 'sample-green.pdf'), 'Sample: Quiet Reading', '0.20 0.65 0.45')
