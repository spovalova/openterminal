import { useCallback, useLayoutEffect, useState } from 'react'

/**
 * Measure an element's width. Returns a callback ref to put on the element and its current width in
 * px, kept up to date by a ResizeObserver. The width is `undefined` until the element exists and has
 * been measured (and in environments without ResizeObserver, such as tests), so callers fall back to a
 * size hint. A callback ref, not a ref object, so an element that mounts after a loading or empty
 * state is still observed.
 */
export function useWidth(): [(el: HTMLElement | null) => void, number | undefined] {
  const [el, setEl] = useState<HTMLElement | null>(null)
  const [width, setWidth] = useState<number | undefined>(undefined)
  const ref = useCallback((node: HTMLElement | null) => setEl(node), [])
  useLayoutEffect(() => {
    if (!el || typeof ResizeObserver === 'undefined') return
    setWidth(el.clientWidth)
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [el])
  return [ref, width]
}
