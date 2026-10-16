import { createContext, useContext } from 'react'
import type { TerminalSocket } from './socket'

export const SocketContext = createContext<TerminalSocket | null>(null)

export function useSocket(): TerminalSocket {
  const s = useContext(SocketContext)
  if (!s) throw new Error('useSocket must be used inside SocketContext')
  return s
}
