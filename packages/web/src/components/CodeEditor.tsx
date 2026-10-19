import { useEffect, useRef, type FC } from 'react'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap, placeholder as cmPlaceholder } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import { indentWithTab } from '@codemirror/commands'
import { python } from '@codemirror/lang-python'

export type CodeEditorProps = {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  /** Ctrl/⌘+Enter. */
  onRun?: () => void
  readOnly?: boolean
  className?: string
  /** Accessible name for the editor's content element. */
  label?: string
  minHeight?: number
}

/** The terminal's dark theme for CodeMirror: tokens from styles.css, the mono stack, 12px. */
const theme = EditorView.theme(
  {
    '&': { backgroundColor: 'var(--color-bg)', color: 'var(--color-fg)', fontSize: '12px', borderRadius: '4px', border: '1px solid var(--color-border)' },
    '&.cm-focused': { outline: 'none', borderColor: 'var(--color-accent)' },
    '.cm-content': { fontFamily: 'var(--font-mono)', padding: '6px 0', caretColor: 'var(--color-fg)' },
    '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.5' },
    '.cm-gutters': { backgroundColor: 'var(--color-surface)', color: 'var(--color-fg-3)', border: 'none', borderRight: '1px solid var(--color-border)' },
    '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--color-surface-2) 60%, transparent)' },
    '.cm-activeLineGutter': { backgroundColor: 'var(--color-surface-2)' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: 'color-mix(in srgb, var(--color-accent) 30%, transparent) !important' },
    '.cm-cursor': { borderLeftColor: 'var(--color-fg)' },
    '.cm-placeholder': { color: 'var(--color-fg-3)', fontStyle: 'normal' },
    '.cm-tooltip': { backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-fg)' },
  },
  { dark: true },
)

/** CodeMirror 6 with the Python language, bound to a controlled `value`. */
export const CodeEditor: FC<CodeEditorProps> = ({ value, onChange, placeholder, onRun, readOnly = false, className, label, minHeight = 160 }) => {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  const onRunRef = useRef(onRun)
  onChangeRef.current = onChange
  onRunRef.current = onRun

  useEffect(() => {
    if (!host.current) return
    const extensions: Extension[] = [
      basicSetup,
      python(),
      theme,
      keymap.of([
        {
          key: 'Mod-Enter',
          run: () => {
            onRunRef.current?.()
            return true
          },
        },
        indentWithTab,
      ]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) onChangeRef.current(u.state.doc.toString())
      }),
      EditorView.lineWrapping,
      EditorState.readOnly.of(readOnly),
      EditorView.editable.of(!readOnly),
    ]
    if (placeholder) extensions.push(cmPlaceholder(placeholder))
    const state = EditorState.create({ doc: value, extensions })
    const v = new EditorView({ state, parent: host.current })
    if (label) v.contentDOM.setAttribute('aria-label', label)
    view.current = v
    return () => {
      v.destroy()
      view.current = null
    }
    // the editor is created once (value changes from outside are applied below)
  }, [readOnly, placeholder])

  useEffect(() => {
    const v = view.current
    if (!v) return
    const current = v.state.doc.toString()
    if (current !== value) v.dispatch({ changes: { from: 0, to: current.length, insert: value } })
  }, [value])

  return <div ref={host} data-code-editor="" className={className} style={{ minHeight }} />
}
