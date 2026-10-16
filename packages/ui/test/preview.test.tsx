import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { App } from '../src/preview/App.js'

/** Renders every component through the preview page. Charts mount in effects, so they are skipped here. */
describe('preview App', () => {
  it('server-renders without React warnings and formats cells', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const html = renderToString(createElement(App)).replace(/<!-- -->/g, '')
    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()

    expect(html).toContain('view-transition-name:prompt-box')
    expect(html).toContain('Worked for 12s')
    expect(html).toContain('6 steps')
    expect(html).toMatch(/text-up[^>]*>\+3\.12%/)
    expect(html).toMatch(/text-down[^>]*>-1\.07%/)
    expect(html).toContain('24,310,552')
    expect(html).toContain('178.42')
    expect(html).toMatch(/<a href="https:\/\/www\.reuters\.com[^"]*"[^>]*target="_blank"[^>]*>reuters\.com/)
    expect(html).toContain('aria-label="Edit"')
    expect(html).toContain('aria-label="Refresh"')
    expect(html).toContain('aria-label="Expand"')
  })
})
