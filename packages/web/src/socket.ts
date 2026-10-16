// One WebSocket per client (PLAN.md 7.4). Reconnects with backoff; every inbound message is parsed with ServerMsgSchema.
import { ServerMsgSchema, type ClientMsg, type ServerMsg } from '@terminal/core'

export type SocketStatus = 'connecting' | 'open' | 'closed'

export type SocketOptions = {
  url?: string
  onMessage: (msg: ServerMsg) => void
  onStatus?: (status: SocketStatus) => void
  /** Injected in tests. */
  WebSocketImpl?: typeof WebSocket
  minBackoffMs?: number
  maxBackoffMs?: number
}

export function socketUrl(loc: Pick<Location, 'protocol' | 'host'> = window.location): string {
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/ws`
}

export class TerminalSocket {
  status: SocketStatus = 'closed'
  private ws: WebSocket | null = null
  private attempt = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private closedByUser = false
  private queue: ClientMsg[] = []
  private readonly opts: Required<Pick<SocketOptions, 'minBackoffMs' | 'maxBackoffMs'>> & SocketOptions

  constructor(opts: SocketOptions) {
    this.opts = { minBackoffMs: 500, maxBackoffMs: 10_000, ...opts }
  }

  connect(): void {
    this.closedByUser = false
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return
    const Impl = this.opts.WebSocketImpl ?? WebSocket
    const ws = new Impl(this.opts.url ?? socketUrl())
    this.ws = ws
    this.setStatus('connecting')
    ws.onopen = () => {
      this.attempt = 0
      this.setStatus('open')
      const pending = this.queue
      this.queue = []
      for (const m of pending) this.send(m)
    }
    ws.onmessage = (ev) => {
      let raw: unknown
      try {
        raw = JSON.parse(String(ev.data))
      } catch {
        console.warn('[socket] non-JSON message dropped')
        return
      }
      const parsed = ServerMsgSchema.safeParse(raw)
      if (!parsed.success) {
        console.warn('[socket] invalid ServerMsg dropped', parsed.error.issues)
        return
      }
      this.opts.onMessage(parsed.data)
    }
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.ws = null
      this.setStatus('closed')
      if (!this.closedByUser) this.scheduleReconnect()
    }
    ws.onerror = () => {
      // onclose follows; nothing to do here.
    }
  }

  close(): void {
    this.closedByUser = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.ws?.close()
    this.ws = null
    this.setStatus('closed')
  }

  send(msg: ClientMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
      return
    }
    // Keep the newest 50 while reconnecting; a stale focus is harmless, a lost prompt is not.
    this.queue.push(msg)
    if (this.queue.length > 50) this.queue.shift()
    this.connect()
  }

  prompt(workspaceId: string, text: string): void {
    this.send({ t: 'prompt', workspaceId, text })
  }
  cancel(workspaceId: string): void {
    this.send({ t: 'cancel', workspaceId })
  }
  refresh(widgetId: string): void {
    this.send({ t: 'refresh', widgetId })
  }
  focus(workspaceId: string): void {
    this.send({ t: 'focus', workspaceId })
  }

  private scheduleReconnect(): void {
    if (this.timer) return
    const base = Math.min(this.opts.minBackoffMs * 2 ** this.attempt, this.opts.maxBackoffMs)
    const delay = base + Math.random() * base * 0.25
    this.attempt += 1
    this.timer = setTimeout(() => {
      this.timer = null
      this.connect()
    }, delay)
  }

  private setStatus(s: SocketStatus): void {
    if (this.status === s) return
    this.status = s
    this.opts.onStatus?.(s)
  }
}
