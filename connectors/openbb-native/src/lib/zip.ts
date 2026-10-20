// Zip archives for the providers whose downloads are too large to unzip into one string (JODI's tables are 285 MB to
// 700 MB of CSV inside a 23 to 59 MB zip) or too large to fetch for one member (Fama-French's country archive).
// `zipMemberLines` inflates one member in 64 KB steps and hands over its lines as they appear, so the text is never
// held whole. `zipMemberByRange` reads one member of a remote archive with two small range requests. Small archives
// that are downloaded whole can use fflate's `unzipSync` directly.
import { inflateSync, Unzip, UnzipInflate, UnzipPassThrough, unzipSync } from 'fflate'

const STEP = 64 * 1024

/**
 * Call `onLine` for every line of the first member of `zip` whose name `pick` accepts (the line break removed, a UTF-8
 * byte order mark dropped, blank lines included). Returns that member's name, or undefined when none matched.
 */
export function zipMemberLines(zip: Uint8Array, pick: (name: string) => boolean, onLine: (line: string) => void): string | undefined {
  const unzip = new Unzip()
  unzip.register(UnzipInflate)
  unzip.register(UnzipPassThrough)
  const decoder = new TextDecoder('utf-8')
  let picked: string | undefined
  let tail = ''
  unzip.onfile = (file) => {
    if (picked !== undefined || !pick(file.name)) return
    picked = file.name
    file.ondata = (err, chunk, final) => {
      if (err) throw err
      const text = tail + decoder.decode(chunk, { stream: !final })
      let from = 0
      for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', from)) {
        onLine(text.charCodeAt(at - 1) === 13 && at > from ? text.slice(from, at - 1) : text.slice(from, at))
        from = at + 1
      }
      tail = text.slice(from)
      if (final && tail !== '') {
        onLine(tail.endsWith('\r') ? tail.slice(0, -1) : tail)
        tail = ''
      }
    }
    file.start()
  }
  for (let at = 0; at < zip.length; at += STEP) unzip.push(zip.subarray(at, at + STEP), at + STEP >= zip.length)
  if (zip.length === 0) unzip.push(zip, true)
  return picked
}

/** One ranged GET: the status (200 when the server ignored the range and sent the whole file) and the bytes. */
export type RangeGet = (range: string) => Promise<{ status: number; body: Uint8Array }>

const u16 = (b: Uint8Array, at: number): number => b[at]! | (b[at + 1]! << 8)
const u32 = (b: Uint8Array, at: number): number => (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0

/**
 * One member of a remote zip without downloading the rest: the end of the file (its central directory), then the
 * member's own bytes. The requests are made one after the other, so a recording replays them in order. Returns
 * undefined when the archive has no such member. Works on plain zips (no zip64, no encryption); a server that
 * ignores ranges sends the whole archive, which is read in memory instead.
 */
export async function zipMemberByRange(get: RangeGet, name: string, tailBytes = 64 * 1024): Promise<Uint8Array | undefined> {
  const tail = await get(`bytes=-${tailBytes}`)
  if (tail.status === 200) return unzipSync(tail.body, { filter: (f) => f.name === name })[name]
  if (tail.status !== 206) throw new Error(`Range request failed -> Status Code: ${tail.status}`)
  const bytes = tail.body

  // The end-of-central-directory record: the last occurrence of its signature.
  let eocd = -1
  for (let at = bytes.length - 22; at >= 0; at--) {
    if (u32(bytes, at) === 0x06054b50) {
      eocd = at
      break
    }
  }
  if (eocd < 0) throw new Error('zip: no end-of-central-directory record in the last bytes of the archive')
  const entries = u16(bytes, eocd + 10)
  const dirSize = u32(bytes, eocd + 12)
  const dirOffset = u32(bytes, eocd + 16)
  if (dirSize === 0xffffffff || dirOffset === 0xffffffff || entries === 0xffff) throw new Error('zip: zip64 archives are not supported')

  // The directory sits right before the end record, normally inside the bytes already fetched.
  let dir: Uint8Array
  if (eocd - dirSize >= 0) dir = bytes.subarray(eocd - dirSize, eocd)
  else {
    const res = await get(`bytes=${dirOffset}-${dirOffset + dirSize - 1}`)
    if (res.status !== 206 || res.body.length !== dirSize) throw new Error('zip: could not read the central directory')
    dir = res.body
  }

  let found: { method: number; compressed: number; size: number; offset: number; nameLength: number } | undefined
  for (let at = 0, k = 0; k < entries && at + 46 <= dir.length; k++) {
    if (u32(dir, at) !== 0x02014b50) throw new Error('zip: bad central directory entry')
    const nameLength = u16(dir, at + 28)
    if (new TextDecoder().decode(dir.subarray(at + 46, at + 46 + nameLength)) === name) {
      found = { method: u16(dir, at + 10), compressed: u32(dir, at + 20), size: u32(dir, at + 24), offset: u32(dir, at + 42), nameLength }
      break
    }
    at += 46 + nameLength + u16(dir, at + 30) + u16(dir, at + 32)
  }
  if (!found) return undefined

  // The local header repeats the name and may carry its own extra field; ask for some slack beyond the data.
  const slack = 1024
  const res = await get(`bytes=${found.offset}-${found.offset + 30 + found.nameLength + slack + found.compressed - 1}`)
  if (res.status !== 206 && res.status !== 200) throw new Error(`Range request failed -> Status Code: ${res.status}`)
  const local = res.status === 200 ? res.body.subarray(found.offset) : res.body
  if (u32(local, 0) !== 0x04034b50) throw new Error('zip: bad local file header')
  const start = 30 + u16(local, 26) + u16(local, 28)
  const data = local.subarray(start, start + found.compressed)
  if (data.length !== found.compressed) throw new Error('zip: the member is cut short')
  const out = found.method === 0 ? data : found.method === 8 ? inflateSync(data, { out: new Uint8Array(found.size) }) : undefined
  if (!out) throw new Error(`zip: unsupported compression method ${found.method}`)
  return out
}
