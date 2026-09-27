const fs = require('fs')
const path = require('path')

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function assertDocumentId (id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error('非法文档标识')
  return id
}

function containedPath (root, ...parts) {
  const base = path.resolve(root)
  const target = path.resolve(base, ...parts)
  const relative = path.relative(base, target)
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('非法资料库路径')
  }
  // Reject links as well: a safe filename must not escape through a junction.
  let current = base
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part)
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error('资料库路径不能包含符号链接')
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
  }
  return target
}

function documentPath (root, folder, id, extension = '') {
  return containedPath(root, folder, assertDocumentId(id) + extension)
}

module.exports = { assertDocumentId, containedPath, documentPath }
