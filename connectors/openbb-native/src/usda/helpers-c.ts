// Helpers for the part c ports (usda), beside helpers.ts: list params and the CSV decoders the ERS files need.
import type { NativeParams } from '../types.js'

/**
 * A comma-separated or array param as trimmed, non-empty values; undefined when the param is absent or has none
 * (`values = v.split(",") if isinstance(v, str) else list(v)`, blanks dropped).
 */
export function optList(params: NativeParams, name: string): string[] | undefined {
  const v = params[name]
  if (v === undefined || v === null || v === '') return undefined
  const parts = Array.isArray(v) ? v.map(String) : String(v).split(',')
  const values = parts.map((s) => s.trim()).filter(Boolean)
  return values.length ? values : undefined
}

/** `content.decode("utf-8-sig")`, else `content.decode("cp1252")` when the bytes are not valid UTF-8. */
export function decodeUtf8SigOrCp1252(bytes: Uint8Array): string {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  } catch {
    return new TextDecoder('windows-1252').decode(bytes)
  }
}
