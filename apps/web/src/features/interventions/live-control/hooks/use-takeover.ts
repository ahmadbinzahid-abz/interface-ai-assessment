"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import type {
  ControlState,
  OperatorAction,
  TakeoverClientMessage,
  TakeoverServerMessage,
} from "@workspace/contracts"

/**
 * The console's half of the co-browsing channel.
 *
 * Frames come out of the live browser over CDP and land in `frame`; input goes
 * back the other way through `send`. What matters is that this is *the same
 * page* the automation was driving — same cookies, same half-filled form — not a
 * reconstruction. Reproducing a legacy session in a second browser is the hard
 * problem, and it would fail exactly when a takeover is needed.
 *
 * The hook holds no opinion about permission. Connecting gets frames; acting
 * requires a claim, and the *server* refuses input from anyone who does not hold
 * the control lease. A `denied` message coming back is the system working.
 */

export interface TakeoverFrame {
  readonly data: string
  readonly width: number
  readonly height: number
}

export interface TakeoverConnection {
  readonly connected: boolean
  readonly frame: TakeoverFrame | undefined
  readonly state: ControlState | undefined
  readonly captured: readonly OperatorAction[]
  readonly denial: string | undefined
  readonly send: (message: TakeoverClientMessage) => void
}

export const useTakeover = (url: string | undefined): TakeoverConnection => {
  const socketRef = useRef<WebSocket | undefined>(undefined)

  const [connected, setConnected] = useState(false)
  const [frame, setFrame] = useState<TakeoverFrame | undefined>(undefined)
  const [state, setState] = useState<ControlState | undefined>(undefined)
  const [captured, setCaptured] = useState<readonly OperatorAction[]>([])
  const [denial, setDenial] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (!url) return

    const socket = new WebSocket(url)
    socketRef.current = socket

    socket.onopen = () => setConnected(true)
    socket.onclose = () => setConnected(false)

    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as TakeoverServerMessage

      switch (message._tag) {
        case "hello":
          setState(message.state)
          return
        case "frame":
          setFrame({
            data: message.data,
            width: message.width,
            height: message.height,
          })
          return
        case "state":
          setState(message.state)
          // A new state means whatever was refused before no longer applies.
          setDenial(undefined)
          return
        case "captured":
          setCaptured((previous) => [...previous, message.action])
          return
        case "denied":
          setDenial(message.reason)
          return
        case "resumed":
        case "pong":
          return
      }
    }

    return () => {
      socketRef.current = undefined
      socket.close()
    }
  }, [url])

  const send = useCallback((message: TakeoverClientMessage) => {
    const socket = socketRef.current
    if (socket?.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify(message))
  }, [])

  return { connected, frame, state, captured, denial, send }
}

/**
 * Whether this console currently holds the session.
 *
 * Derived from the state the *server* broadcasts rather than from whether we
 * sent a claim, so a lease revoked underneath us — the run reclaiming control,
 * or a supervisor aborting — disables the surface immediately.
 */
export const isDriving = (
  state: ControlState | undefined,
  operatorId: string
): boolean =>
  state?._tag === "OperatorDriving" && state.operatorId === operatorId
