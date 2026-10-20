// A lazy zip reader for archives with thousands of members (GovInfo's BILLSTATUS bulk files hold one XML per bill):
// the central directory is read once, and each member is inflated only when asked for, where fflate's unzipSync
// inflates the whole archive at once. Stored and deflated members only; no encryption, no zip64.
import { inflateRawSync } from 'node:zlib'

export type ZipEntry = { name: string; method: number; compressedSize: number; size: number; offset: number }

export type ZipArchive = {
  entries: ZipEntry[]
  /** The member's bytes, inflated. */
  read(entry: ZipEntry): Uint8Array
  /** The member's text, decoded as UTF-8. */
  readText(entry: ZipEntry): string
}

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50

export function openZip(bytes: Uint8Array): ZipArchive {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let eocd = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === EOCD) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('not a zip archive: no end-of-central-directory record')
  const count = view.getUint16(eocd + 10, true)
  let at = view.getUint32(eocd + 16, true)
  const decoder = new TextDecoder()
  const entries: ZipEntry[] = []
  for (let i = 0; i < count; i++) {
    if (view.getUint32(at, true) !== CENTRAL) throw new Error('corrupt zip central directory')
    const method = view.getUint16(at + 10, true)
    const compressedSize = view.getUint32(at + 20, true)
    const size = view.getUint32(at + 24, true)
    const nameLength = view.getUint16(at + 28, true)
    const extraLength = view.getUint16(at + 30, true)
    const commentLength = view.getUint16(at + 32, true)
    const offset = view.getUint32(at + 42, true)
    entries.push({ name: decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength)), method, compressedSize, size, offset })
    at += 46 + nameLength + extraLength + commentLength
  }
  const read = (entry: ZipEntry): Uint8Array => {
    if (view.getUint32(entry.offset, true) !== LOCAL) throw new Error(`corrupt zip local header for ${entry.name}`)
    const start = entry.offset + 30 + view.getUint16(entry.offset + 26, true) + view.getUint16(entry.offset + 28, true)
    const data = bytes.subarray(start, start + entry.compressedSize)
    if (entry.method === 0) return data
    if (entry.method === 8) return inflateRawSync(data)
    throw new Error(`unsupported zip compression method ${entry.method} for ${entry.name}`)
  }
  return { entries, read, readText: (entry) => decoder.decode(read(entry)) }
}
