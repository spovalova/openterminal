// Static data the ports ship as one JSON file: the data as JSON, gzipped, base64 encoded, so a metadata catalogue of
// several megabytes stays a few hundred kilobytes in the repository and in the bundle. Unpacked once, on first use.
import { gunzipSync, strFromU8 } from 'fflate'

export type Packed = { format: number; gzip_base64: string }

/** The JSON value inside a packed file. */
export function unpackJson<T>(packed: Packed): T {
  const binary = atob(packed.gzip_base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return JSON.parse(strFromU8(gunzipSync(bytes))) as T
}
