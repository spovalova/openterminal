// Open Terminal landing page: the prompt tabs and the copy buttons. Everything works without this file (every prompt
// and its screenshot render in order); with it, the prompts become tabs over one screenshot.
/* global document, navigator, window */

// index.html adds the `js` class in its head, so the first paint already shows one panel; this keeps it for a copy
// of the page without that line.
document.documentElement.classList.add('js')

// Copy buttons: data-copy holds the text, or data-copy-target names the element whose text is copied.
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Older browsers and insecure origins: a hidden textarea and execCommand.
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    let ok
    try {
      ok = document.execCommand('copy')
    } catch {
      ok = false
    }
    area.remove()
    return ok
  }
}

for (const button of document.querySelectorAll('[data-copy], [data-copy-target]')) {
  const label = button.querySelector('.copy-label')
  const idle = label ? label.textContent : ''
  const status = document.getElementById('copy-status')
  button.addEventListener('click', async () => {
    const target = button.getAttribute('data-copy-target')
    const text = target ? document.getElementById(target)?.textContent ?? '' : button.getAttribute('data-copy') ?? ''
    const ok = await copyText(text.trim())
    if (!ok) return
    button.setAttribute('data-copied', '')
    if (label) label.textContent = 'Copied'
    if (status) status.textContent = 'Copied to the clipboard'
    window.setTimeout(() => {
      button.removeAttribute('data-copied')
      if (label) label.textContent = idle
      if (status) status.textContent = ''
    }, 1600)
  })
}

// Prompt tabs (WAI-ARIA tabs pattern, automatic activation): arrow keys, Home and End move between prompts.
for (const list of document.querySelectorAll('[role="tablist"]')) {
  const tabs = [...list.querySelectorAll('[role="tab"]')]
  const panels = tabs.map((tab) => document.getElementById(tab.getAttribute('aria-controls')))
  const select = (index, focus) => {
    tabs.forEach((tab, i) => {
      const on = i === index
      tab.setAttribute('aria-selected', String(on))
      tab.tabIndex = on ? 0 : -1
      if (panels[i]) panels[i].hidden = !on
    })
    if (focus) tabs[index].focus()
  }
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => select(i, false))
    tab.addEventListener('keydown', (event) => {
      const vertical = list.getAttribute('aria-orientation') === 'vertical'
      const next = vertical ? ['ArrowDown', 'ArrowRight'] : ['ArrowRight', 'ArrowDown']
      const prev = vertical ? ['ArrowUp', 'ArrowLeft'] : ['ArrowLeft', 'ArrowUp']
      let to = -1
      if (next.includes(event.key)) to = (i + 1) % tabs.length
      else if (prev.includes(event.key)) to = (i - 1 + tabs.length) % tabs.length
      else if (event.key === 'Home') to = 0
      else if (event.key === 'End') to = tabs.length - 1
      if (to < 0) return
      event.preventDefault()
      select(to, true)
    })
  })
  select(Math.max(0, tabs.findIndex((tab) => tab.getAttribute('aria-selected') === 'true')), false)
}
document.documentElement.classList.add('tabs-ready')
