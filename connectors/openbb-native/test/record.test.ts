import { describe, expect, it } from 'vitest'
import { createNativeHttp } from '../src/http.js'
import { recordingFetch, redact, replayFetch } from '../src/record.js'

const upstream: typeof fetch = async (input, init) => {
  const url = String(input)
  if (url.includes('/bin')) return new Response(new Uint8Array([0, 1, 2, 255]), { headers: { 'content-type': 'application/octet-stream' } })
  if (url.includes('/missing')) return new Response('nope', { status: 404 })
  return new Response(JSON.stringify({ url, method: init?.method, body: init?.body ?? null }), { headers: { 'content-type': 'application/json', 'set-cookie': 'sid=abc; Path=/' } })
}

describe('record and replay', () => {
  it('replays JSON, text, bytes, errors and cookies as recorded', async () => {
    const rec = recordingFetch(upstream)
    const live = createNativeHttp(rec.fetch)
    const a = await live.json('https://x.test/a', { query: { q: 'TSLA', n: 2 } })
    const b = await live.json('https://x.test/post', { body: { symbol: 'TSLA' } })
    const c = await live.bytes('https://x.test/bin')
    await expect(live.text('https://x.test/missing')).rejects.toThrow(/HTTP 404/)
    const cookie = (await live.response('https://x.test/a', { query: { q: 'TSLA', n: 2 } })).headers.getSetCookie()

    const replay = createNativeHttp(replayFetch(rec.exchanges))
    expect(await replay.json('https://x.test/a', { query: { q: 'TSLA', n: 2 } })).toEqual(a)
    expect(await replay.json('https://x.test/post', { body: { symbol: 'TSLA' } })).toEqual(b)
    expect(await replay.bytes('https://x.test/bin')).toEqual(c)
    await expect(replay.text('https://x.test/missing')).rejects.toThrow(/HTTP 404/)
    expect((await replay.response('https://x.test/a', { query: { q: 'TSLA', n: 2 } })).headers.getSetCookie()).toEqual(cookie)
    await expect(replay.json('https://x.test/other')).rejects.toThrow(/no recorded response.*\n.*closest recorded/)
  })

  it('never stores a credential, and replays with its placeholder', async () => {
    const rec = recordingFetch(upstream, { fred_api_key: 'sekret-key-123' })
    await createNativeHttp(rec.fetch).json('https://x.test/series', { query: { api_key: 'sekret-key-123', id: 'DGS10' } })
    expect(JSON.stringify(rec.exchanges)).not.toContain('sekret-key-123')
    const replay = createNativeHttp(replayFetch(rec.exchanges))
    await expect(replay.json('https://x.test/series', { query: { api_key: '{{fred_api_key}}', id: 'DGS10' } })).resolves.toBeTruthy()
  })

  it('keeps binary bodies byte for byte even when the content type looks textual (xlsx is …openxmlformats…sheet)', async () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0xff, 0xfe, 0x80])
    const xlsx: typeof fetch = async () => new Response(zip, { headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } })
    const rec = recordingFetch(xlsx)
    await createNativeHttp(rec.fetch).bytes('https://x.test/book.xlsx')
    expect(rec.exchanges[0]?.encoding).toBe('base64')
    expect(await createNativeHttp(replayFetch(rec.exchanges)).bytes('https://x.test/book.xlsx')).toEqual(zip)
  })

  it('sends one Content-Type: the caller’s when it names one', async () => {
    const seen: (string | null)[] = []
    const echo: typeof fetch = async (_input, init) => {
      seen.push(new Headers(init?.headers).get('content-type'))
      return new Response('{}', { headers: { 'content-type': 'application/json' } })
    }
    await createNativeHttp(echo).json('https://x.test/a', { body: { a: 1 }, headers: { 'Content-Type': 'application/json;charset=UTF-8' } })
    await createNativeHttp(echo).json('https://x.test/a', { body: { a: 1 } })
    expect(seen).toEqual(['application/json;charset=UTF-8', 'application/json'])
  })

  it('redacts URL-encoded secrets too', () => {
    expect(redact('a=kk%2Byy&b=kk+yy', { key: 'kk+yy' })).toBe('a={{key}}&b={{key}}')
  })
})
