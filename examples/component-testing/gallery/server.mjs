import { readFile } from 'node:fs/promises'
// Minimal static dev server for the story gallery — no dependencies, so the
// exact same file runs under Bun locally and under Node inside the official
// Playwright Docker image (`node gallery/server.mjs`).
//
// URLs below /playwright/ map to files in this project:
//   /playwright/gallery/index.html  ->  ./gallery/index.html
//   /playwright/src/...             ->  ./src/...
import { createServer } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const port = Number(process.env.PORT ?? 5173)

/** @type {Record<string, string>} */
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {string} project-relative path of the requested file
 */
function requestedPath(req) {
  const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname)
  const underPlaywright = pathname === '/playwright' ? '/' : pathname.replace(/^\/playwright\//, '/')
  return underPlaywright === '/' ? join('gallery', 'index.html') : normalize(underPlaywright.slice(1))
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
async function serve(req, res) {
  const filePath = join(projectRoot, requestedPath(req))
  if (filePath !== projectRoot && !filePath.startsWith(projectRoot + sep)) throw new Error('path escapes project root')
  const body = await readFile(filePath)
  res.setHeader('Content-Type', CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream')
  res.end(body)
}

createServer((req, res) => {
  serve(req, res).catch(() => {
    res.statusCode = 404
    res.end('Not found')
  })
}).listen(port, () => {
  console.log(`gallery listening on http://localhost:${port}/playwright/gallery/index.html`)
})
