"use client"

import { useRef } from "react"

import type { MouseButton, TakeoverClientMessage } from "@workspace/contracts"
import { Spinner } from "@workspace/ui/components/spinner"
import { cn } from "@workspace/ui/lib/utils"

import type { TakeoverFrame } from "../hooks/use-takeover"

/**
 * The live page, and the surface a person drives it through.
 *
 * The whole component is one conversion: browser event coordinates, in whatever
 * size the `<img>` happens to be laid out at, into the frame's own pixel space.
 * The gateway does not scale anything — each frame reports the size its
 * coordinates are in — so the mapping exists once, here, rather than in two
 * places that can drift apart by a few pixels and put a click on the wrong
 * button.
 *
 * Keyboard input goes through `keydown`/`keyup` rather than a text field on
 * purpose: a takeover exists precisely for screens this system has no model of,
 * so anything that first asked "which field is this?" would fail exactly when it
 * is needed.
 */

const BUTTONS: Record<number, MouseButton> = {
  0: "left",
  1: "middle",
  2: "right",
}

export function ScreencastSurface({
  frame,
  driving,
  onSend,
  idleLabel = "watching — take control to drive",
  waitingLabel = "Waiting for the first frame…",
}: {
  readonly frame: TakeoverFrame | undefined
  readonly driving: boolean
  readonly onSend: (message: TakeoverClientMessage) => void
  /**
   * What the overlay says when this viewer is not driving.
   *
   * Two callers, two truths: on an intervention nobody is driving and the label
   * invites you to take over; on a run in flight the *automation* is driving and
   * inviting a takeover would be a lie. Same surface, same guarantees, honest
   * copy either way.
   */
  readonly idleLabel?: string
  readonly waitingLabel?: string
}) {
  const imageRef = useRef<HTMLImageElement | null>(null)

  /** Rendered pixels → the frame's own coordinate space. */
  const pointFor = (event: React.MouseEvent): { x: number; y: number } => {
    const image = imageRef.current
    if (!image || !frame) return { x: 0, y: 0 }

    const box = image.getBoundingClientRect()

    return {
      x: Math.round(((event.clientX - box.left) / box.width) * frame.width),
      y: Math.round(((event.clientY - box.top) / box.height) * frame.height),
    }
  }

  const input = (event: TakeoverClientMessage) => {
    if (!driving) return
    onSend(event)
  }

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-md border bg-muted",
        driving ? "cursor-crosshair" : "cursor-not-allowed"
      )}
      tabIndex={0}
      role="application"
      aria-label="Live browser session"
      onMouseMove={(event) =>
        input({ _tag: "input", event: { _tag: "mouseMoved", ...pointFor(event) } })
      }
      onMouseDown={(event) => {
        event.preventDefault()
        // Focus the container so key events land here rather than on the page.
        event.currentTarget.focus()
        input({
          _tag: "input",
          event: {
            _tag: "mousePressed",
            ...pointFor(event),
            button: BUTTONS[event.button] ?? "left",
            clickCount: event.detail || 1,
          },
        })
      }}
      onMouseUp={(event) =>
        input({
          _tag: "input",
          event: {
            _tag: "mouseReleased",
            ...pointFor(event),
            button: BUTTONS[event.button] ?? "left",
            clickCount: event.detail || 1,
          },
        })
      }
      onWheel={(event) =>
        input({
          _tag: "input",
          event: {
            _tag: "mouseWheel",
            ...pointFor(event),
            deltaX: event.deltaX,
            deltaY: event.deltaY,
          },
        })
      }
      onKeyDown={(event) => {
        // Tab would move focus out of the surface, and the remote page is
        // exactly where a Tab is supposed to go.
        event.preventDefault()
        input({
          _tag: "input",
          event: {
            _tag: "keyDown",
            key: event.key,
            code: event.code,
            modifiers: modifiersOf(event),
          },
        })
      }}
      onKeyUp={(event) => {
        event.preventDefault()
        input({
          _tag: "input",
          event: {
            _tag: "keyUp",
            key: event.key,
            code: event.code,
            modifiers: modifiersOf(event),
          },
        })
      }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {frame ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          ref={imageRef}
          src={`data:image/jpeg;base64,${frame.data}`}
          alt="The live browser session"
          className="block w-full select-none"
          draggable={false}
        />
      ) : (
        <div className="flex aspect-[4/3] items-center justify-center gap-3 text-sm text-muted-foreground">
          <Spinner />
          {waitingLabel}
        </div>
      )}

      {!driving ? (
        <div className="pointer-events-none absolute inset-0 flex items-start justify-end p-3">
          <span className="rounded-md bg-background/90 px-2 py-1 text-xs text-muted-foreground">
            {idleLabel}
          </span>
        </div>
      ) : null}
    </div>
  )
}

/** CDP's modifier mask: alt 1, ctrl 2, meta 4, shift 8. */
const modifiersOf = (event: React.KeyboardEvent): number =>
  (event.altKey ? 1 : 0) |
  (event.ctrlKey ? 2 : 0) |
  (event.metaKey ? 4 : 0) |
  (event.shiftKey ? 8 : 0)
