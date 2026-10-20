// The CLI's hidden question for the API key: nothing echoed, not even a mask. Assumes a TTY; the caller checks first.

/** Escape sequences (arrow keys, bracketed paste markers) are dropped, not typed into the key. */
const ESCAPES = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|O.|.)/g // eslint-disable-line no-control-regex

export type KeyState = { text: string; done?: 'enter' | 'cancel' }

/**
 * Fold one chunk of raw-mode input into the hidden answer: Enter (or ctrl-D) ends it, ctrl-C cancels, backspace
 * deletes, other control characters are ignored. Pure, for the tests.
 */
export function foldKeys(state: KeyState, chunk: string): KeyState {
  let text = state.text
  for (const ch of chunk.replace(ESCAPES, '')) {
    if (ch === '\r' || ch === '\n' || ch === '\u0004') return { text, done: 'enter' }
    if (ch === '\u0003') return { text, done: 'cancel' }
    if (ch === '\u007f' || ch === '\b') text = text.slice(0, -1)
    else if (ch === '\u0015') text = '' // ctrl-U
    else if (ch >= ' ') text += ch
  }
  return { text }
}

/** Ask with echo off. Resolves to the trimmed answer ('' when skipped); ctrl-C exits with 130. */
export function askHidden(question: string, input: NodeJS.ReadStream = process.stdin, output: NodeJS.WriteStream = process.stdout): Promise<string> {
  return new Promise((resolveAnswer) => {
    // Echo off before the question shows, so a key typed or pasted the moment it appears is never echoed.
    const wasRaw = input.isRaw
    input.setRawMode(true)
    output.write(question)
    input.setEncoding('utf8')
    let state: KeyState = { text: '' }
    const onData = (chunk: string | Buffer) => {
      state = foldKeys(state, String(chunk))
      if (!state.done) return
      input.off('data', onData)
      input.setRawMode(wasRaw)
      input.pause()
      output.write('\n')
      if (state.done === 'cancel') process.exit(130)
      resolveAnswer(state.text.trim())
    }
    input.on('data', onData)
    input.resume()
  })
}
