// Regenerate catalog/openbb.json, the OpenBB route catalog the native providers answer, from a running OpenBB API:
//   pnpm --filter @openterminal/openbb-native snapshot [--base http://127.0.0.1:6900]
// It is the same generator the openbb connector runs on a live API (core's descriptorsFromOpenApi), frozen so a
// machine without OpenBB still has every route's params and fields.
import { writeFileSync } from 'node:fs'
import { descriptorsFromOpenApi } from '@openterminal/core'

const args = process.argv.slice(2)
const at = args.indexOf('--base')
const base = ((at >= 0 ? args[at + 1] : undefined) ?? 'http://127.0.0.1:6900').replace(/\/+$/, '')
const res = await fetch(`${base}/openapi.json`)
if (!res.ok) throw new Error(`GET ${base}/openapi.json: HTTP ${res.status}`)
const doc = (await res.json()) as { info?: { title?: string; version?: string } }
const descriptors = descriptorsFromOpenApi(doc, 'openbb').sort((a, b) => a.route.localeCompare(b.route))
const out = new URL('../catalog/openbb.json', import.meta.url)
writeFileSync(out, `${JSON.stringify({ source: `${doc.info?.title ?? 'OpenBB Platform API'} openapi.json`, openbb: '5.0.0', descriptors }, null, 0)}\n`)
const pairs = descriptors.reduce((n, d) => n + d.providers.length, 0)
console.log(`${descriptors.length} routes, ${pairs} route-provider pairs → ${out.pathname}`)
