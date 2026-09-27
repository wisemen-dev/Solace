const MAX_DIMENSION = 8192
const MAX_PIXELS = 16 * 1024 * 1024

export function fitPageViewport (page, requestedScale, options = {}) {
  const base = page.getViewport({ scale: 1 })
  if (!(Number.isFinite(base.width) && base.width > 0 &&
    Number.isFinite(base.height) && base.height > 0 &&
    Number.isFinite(requestedScale) && requestedScale > 0)) {
    throw new Error('Invalid PDF page dimensions or scale')
  }
  const maxDimension = Math.floor(options.maxDimension ?? MAX_DIMENSION)
  const maxPixels = Math.floor(options.maxPixels ?? MAX_PIXELS)
  if (!(Number.isFinite(maxDimension) && maxDimension >= 1 &&
    Number.isFinite(maxPixels) && maxPixels >= 1)) {
    throw new Error('Invalid PDF canvas limits')
  }
  const edgeLimit = Math.min(maxDimension, maxPixels)
  const scale = Math.min(
    requestedScale,
    edgeLimit / base.width,
    edgeLimit / base.height,
    Math.sqrt(maxPixels) / Math.sqrt(base.width) / Math.sqrt(base.height)
  )
  if (!(scale > 0)) throw new Error('PDF page is too large to render')
  const viewport = page.getViewport({ scale })
  const width = Math.max(1, Math.min(edgeLimit, Math.floor(viewport.width)))
  const height = Math.max(1, Math.min(edgeLimit, Math.floor(viewport.height)))
  return { viewport, width, height, scale }
}
