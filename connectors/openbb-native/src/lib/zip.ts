// Zip archives for the providers whose downloads are too large to unzip into one string (JODI's tables are 285 MB to
// 700 MB of CSV inside a 23 to 59 MB zip). `zipMemberLines` inflates one member in 64 KB steps and hands over its
// lines as they appear, so the text is never held whole. Small archives can use fflate's `unzipSync` directly.
import { Unzip, UnzipInflate, UnzipPassThrough } from 'fflate'

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
