import { useState, type FC, type ReactNode } from 'react'
import { Button } from '../components/Button.js'
import { IconButton } from '../components/IconButton.js'
import { Kbd } from '../components/Kbd.js'
import { Chip } from '../components/Chip.js'
import { Tabs } from '../components/Tabs.js'
import { PromptBox } from '../components/PromptBox.js'
import { WidgetFrame } from '../components/WidgetFrame.js'
import { DataTable } from '../components/DataTable.js'
import { Steps } from '../components/Steps.js'
import { Skeleton } from '../components/Skeleton.js'
import { Spinner } from '../components/Spinner.js'
import { EmptyState } from '../components/EmptyState.js'
import { Dialog } from '../components/Dialog.js'
import { PencilIcon, RefreshIcon, ExpandIcon, CloseIcon, PlusIcon } from '../components/icons.js'
import { tokens, seriesPalette, UP_COLOR, DOWN_COLOR } from '../tokens.js'
import { CandleChartDemo, LineChartDemo } from './ChartDemo.js'
import { earningsColumns, earningsRows, newsColumns, newsRows, quoteColumns, quoteRows, steps } from './fixtures.js'

const Section: FC<{ title: string; hint?: string; children: ReactNode }> = ({ title, hint, children }) => (
  <section className="flex flex-col gap-3">
    <div className="flex items-baseline gap-2">
      <h2 className="text-sm font-medium text-fg">{title}</h2>
      {hint && <span className="text-xs text-fg-3">{hint}</span>}
    </div>
    {children}
  </section>
)

const Row: FC<{ label?: string; children: ReactNode }> = ({ label, children }) => (
  <div className="flex flex-wrap items-center gap-2">
    {label && <span className="w-20 shrink-0 text-xs text-fg-3">{label}</span>}
    {children}
  </div>
)

const Swatch: FC<{ name: string; value: string }> = ({ name, value }) => (
  <div className="flex items-center gap-2 text-xs">
    <span className="size-6 rounded-sm border border-border" style={{ background: value }} />
    <span className="w-24 text-fg-2">{name}</span>
    <span className="font-mono text-fg-3">{value}</span>
  </div>
)

const MEMORY = ['MU', 'SNDK', 'WDC', 'STX']
const INTRADAY = ['NVDA', 'SPY', 'SMH']
const SIX = ['MU', 'SNDK', 'WDC', 'STX', 'SMH', 'SPY']

/** A mock of the Active shell: tab bar, three-column grid, right sidebar with the conversation. */
const Shell: FC = () => {
  const [tabs, setTabs] = useState([
    { id: 'w1', label: 'Memory' },
    { id: 'w2', label: 'NVDA drop' },
    { id: 'w3', label: 'Morning' },
  ])
  const [active, setActive] = useState('w1')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)

  return (
    <div className="flex h-[720px] flex-col overflow-hidden rounded-lg border border-border-strong bg-bg">
      <Tabs
        items={tabs}
        activeId={active}
        onSelect={setActive}
        onClose={(id) => setTabs((t) => t.filter((x) => x.id !== id))}
        onNew={() => {
          const id = `w${Date.now()}`
          setTabs((t) => [...t, { id, label: 'Untitled' }])
          setActive(id)
        }}
      />
      <div className="flex min-h-0 flex-1">
        <main className="grid min-h-0 flex-1 auto-rows-[200px] grid-cols-3 gap-2 overflow-auto p-2 [grid-auto-flow:dense]">
          <WidgetFrame title="Memory names, 3 months rebased" size="lg" onEdit={() => setEditing(true)} onRefresh={() => {}} onExpand={() => {}}>
            <LineChartDemo symbols={MEMORY} />
          </WidgetFrame>
          <WidgetFrame title="MU daily" size="md" onEdit={() => setEditing(true)} onRefresh={() => {}} onExpand={() => {}}>
            <CandleChartDemo symbol="MU" />
          </WidgetFrame>
          <WidgetFrame title="Basket snapshot" size="md" onEdit={() => setEditing(true)} onRefresh={() => {}} onExpand={() => {}}>
            <DataTable columns={quoteColumns} rows={quoteRows.slice(0, 4)} />
          </WidgetFrame>
          <WidgetFrame title="Upcoming earnings" size="sm" onEdit={() => setEditing(true)} onRefresh={() => {}} onExpand={() => {}}>
            <DataTable columns={earningsColumns} rows={earningsRows} />
          </WidgetFrame>
          <WidgetFrame title="Memory news" size="md" loading onEdit={() => {}} onRefresh={() => {}} onExpand={() => {}} />
        </main>
        <aside className="flex w-[380px] shrink-0 flex-col border-l border-border bg-surface">
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3">
            <div className="self-end rounded-lg bg-surface-3 px-3 py-1.5 text-sm text-fg">What's happening with memory?</div>
            <Steps steps={steps} durationMs={12_040} />
            <p className="text-sm leading-5 text-fg-2">
              Over three months MU is up <span className="text-fg">+31.2%</span>, SNDK <span className="text-fg">+18.4%</span>, WDC{' '}
              <span className="text-fg">+9.7%</span>, STX <span className="text-fg">+4.1%</span>. MU reports on 2026-12-17 after the close. News
              clusters around HBM demand and contract pricing.
            </p>
            <div className="flex flex-wrap gap-1">
              <Chip onClick={() => {}}>Memory names</Chip>
              <Chip onClick={() => {}}>Memory news</Chip>
              <Chip onClick={() => {}}>Upcoming earnings</Chip>
            </div>
          </div>
          <div className="shrink-0 p-3 pt-0">
            <PromptBox
              value={prompt}
              onChange={setPrompt}
              busy={busy}
              onCancel={() => setBusy(false)}
              onSubmit={() => {
                setBusy(true)
                setPrompt('')
                window.setTimeout(() => setBusy(false), 2500)
              }}
            />
          </div>
        </aside>
      </div>
      <Dialog
        open={editing}
        onClose={() => setEditing(false)}
        title="Edit widget"
        footer={
          <>
            <Button onClick={() => setEditing(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => setEditing(false)}>
              Apply
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-2 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-fg-3">Title</span>
            <input defaultValue="Memory names, 3 months rebased" className="h-7 rounded-md border border-border-strong bg-bg px-2 text-fg outline-none focus:border-accent" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-fg-3">Query (JSON)</span>
            <textarea
              rows={5}
              defaultValue={JSON.stringify({ kind: 'ohlcv', params: { symbols: MEMORY, interval: '1d', range: '3mo' } }, null, 2)}
              className="rounded-md border border-border-strong bg-bg px-2 py-1 font-mono text-xs text-fg outline-none focus:border-accent"
            />
          </label>
        </div>
      </Dialog>
    </div>
  )
}

const EmptyShell: FC = () => {
  const [v, setV] = useState('')
  return (
    <div className="flex h-[360px] flex-col items-center justify-center gap-4 rounded-lg border border-border-strong bg-bg">
      <div className="w-full max-w-[640px] px-4">
        <PromptBox value={v} onChange={setV} onSubmit={() => setV('')} autoFocus={false} />
      </div>
      <div className="flex flex-wrap justify-center gap-1.5 px-4">
        <Chip onClick={() => setV("What's happening with memory?")}>What's happening with memory?</Chip>
        <Chip onClick={() => setV("Is NVDA's drop today news or just the market?")}>Is NVDA's drop today news or just the market?</Chip>
        <Chip onClick={() => setV('Morning check on my watchlist')}>Morning check on my watchlist</Chip>
      </div>
      <div className="flex items-center gap-1 text-xs text-fg-3">
        <Kbd>⌘</Kbd>
        <Kbd>K</Kbd>
        <span>palette</span>
        <span className="mx-1">·</span>
        <Kbd>⌘</Kbd>
        <Kbd>\</Kbd>
        <span>sidebar</span>
      </div>
    </div>
  )
}

export const App: FC = () => {
  const [dialog, setDialog] = useState(false)
  const [sort, setSort] = useState<{ column: string; dir: 'asc' | 'desc' } | undefined>({ column: 'change_pct', dir: 'desc' })
  const [busyPrompt, setBusyPrompt] = useState('Compare MU and SNDK over 6 months')
  const [tab, setTab] = useState('a')

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-10 px-4 py-6">
      <header className="flex items-baseline gap-3">
        <h1 className="text-lg font-medium">@terminal/ui</h1>
        <span className="text-xs text-fg-3">every component, every state, dark only</span>
      </header>

      <Section title="Shell (Active)" hint="tab bar · three-column grid · 380px sidebar">
        <Shell />
      </Section>

      <Section title="Shell (Empty)" hint="centered PromptBox, example chips, palette hint">
        <EmptyShell />
      </Section>

      <Section title="Tokens">
        <div className="grid grid-cols-2 gap-x-8 gap-y-1 md:grid-cols-3">
          {Object.entries(tokens.color).map(([k, v]) => (
            <Swatch key={k} name={k} value={v} />
          ))}
        </div>
        <Row label="series">
          {seriesPalette.map((c, i) => (
            <Swatch key={c} name={`series-${i + 1}`} value={c} />
          ))}
        </Row>
        <Row label="direction">
          <Swatch name="UP" value={UP_COLOR} />
          <Swatch name="DOWN" value={DOWN_COLOR} />
        </Row>
        <Row label="type">
          <span className="text-xs">xs 11</span>
          <span className="text-sm">sm 12</span>
          <span className="text-base">base 13</span>
          <span className="text-lg">lg 15</span>
          <span className="text-xl">xl 18</span>
          <span className="font-mono text-sm">mono 12</span>
          <span className="text-sm tabular-nums">1,234.56 tabular</span>
        </Row>
      </Section>

      <Section title="Button">
        <Row label="md">
          <Button variant="primary">Apply</Button>
          <Button>Cancel</Button>
          <Button variant="danger">Delete</Button>
          <Button variant="primary" disabled>
            Disabled
          </Button>
          <Button disabled>Disabled</Button>
        </Row>
        <Row label="sm">
          <Button size="sm" variant="primary">
            Apply
          </Button>
          <Button size="sm">Cancel</Button>
          <Button size="sm" variant="danger">
            Delete
          </Button>
          <Button size="sm">
            <RefreshIcon size={12} /> Refresh
          </Button>
        </Row>
      </Section>

      <Section title="IconButton">
        <Row>
          <IconButton label="Edit">
            <PencilIcon />
          </IconButton>
          <IconButton label="Refresh">
            <RefreshIcon />
          </IconButton>
          <IconButton label="Expand">
            <ExpandIcon />
          </IconButton>
          <IconButton label="Close">
            <CloseIcon />
          </IconButton>
          <IconButton label="New" active>
            <PlusIcon />
          </IconButton>
          <IconButton label="Disabled" disabled>
            <PencilIcon />
          </IconButton>
        </Row>
      </Section>

      <Section title="Kbd and Chip">
        <Row label="kbd">
          <Kbd>⌘</Kbd>
          <Kbd>K</Kbd>
          <Kbd>Esc</Kbd>
          <Kbd>↵</Kbd>
          <Kbd>⇧↵</Kbd>
        </Row>
        <Row label="chip">
          <Chip>Static</Chip>
          <Chip onClick={() => {}}>Clickable</Chip>
          <Chip onClick={() => {}} active>
            Active
          </Chip>
          <Chip onClick={() => {}}>A very long chip label that should truncate at the container width</Chip>
        </Row>
      </Section>

      <Section title="Tabs">
        <Tabs
          items={[
            { id: 'a', label: 'Memory' },
            { id: 'b', label: 'NVDA drop' },
            { id: 'c', label: 'A workspace with a very long name that truncates' },
          ]}
          activeId={tab}
          onSelect={setTab}
          onClose={() => {}}
          onNew={() => {}}
        />
        <Tabs items={[{ id: 'a', label: 'Read only' }]} activeId="a" onSelect={() => {}} />
      </Section>

      <Section title="PromptBox" hint="Enter submits · Shift+Enter newline · busy shows Stop">
        <div className="grid max-w-[640px] gap-3">
          <PromptBox value="" onChange={() => {}} onSubmit={() => {}} />
          <PromptBox value={busyPrompt} onChange={setBusyPrompt} onSubmit={() => {}} />
          <PromptBox value="" onChange={() => {}} onSubmit={() => {}} busy onCancel={() => {}} />
          <PromptBox value="" onChange={() => {}} onSubmit={() => {}} busy />
        </div>
      </Section>

      <Section title="WidgetFrame" hint="loading · error · empty · with actions · without actions">
        <div className="grid auto-rows-[180px] grid-cols-3 gap-2 [grid-auto-flow:dense]">
          <WidgetFrame title="Loading" size="sm" loading onRefresh={() => {}} />
          <WidgetFrame title="Error" size="sm" error="yahoo: ETIMEDOUT query.finance.yahoo.com" onRefresh={() => {}} onEdit={() => {}} />
          <WidgetFrame title="Empty" size="sm" empty onEdit={() => {}} onRefresh={() => {}} onExpand={() => {}} />
          <WidgetFrame title="No actions" size="sm">
            <div className="p-3 text-sm text-fg-2">Children render here.</div>
          </WidgetFrame>
          <WidgetFrame title="With meta" size="md" meta={<span>1d · 3mo</span>} onExpand={() => {}}>
            <LineChartDemo symbols={INTRADAY} normalize={false} />
          </WidgetFrame>
        </div>
      </Section>

      <Section title="DataTable" hint="quote frame · controlled sort · news with time and link · earnings with date">
        <div className="grid grid-cols-2 gap-2">
          <div className="h-[240px] rounded-lg border border-border bg-surface">
            <DataTable columns={quoteColumns} rows={quoteRows} sort={sort} onSort={(c) => setSort((s) => (s?.column === c ? { column: c, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { column: c, dir: 'asc' }))} />
          </div>
          <div className="h-[240px] rounded-lg border border-border bg-surface">
            <DataTable columns={newsColumns} rows={newsRows} />
          </div>
          <div className="h-[160px] rounded-lg border border-border bg-surface">
            <DataTable columns={earningsColumns} rows={earningsRows} />
          </div>
          <div className="h-[160px] rounded-lg border border-border bg-surface">
            <DataTable columns={quoteColumns} rows={[]} />
          </div>
        </div>
      </Section>

      <Section title="Chart" hint="chartTheme + seriesPalette (six symbols, indexed to 100) · candle with UP/DOWN">
        <div className="grid grid-cols-3 gap-2">
          <div className="col-span-2 h-[300px] rounded-lg border border-border bg-surface">
            <LineChartDemo symbols={SIX} />
          </div>
          <div className="h-[300px] rounded-lg border border-border bg-surface">
            <CandleChartDemo symbol="NVDA" />
          </div>
        </div>
      </Section>

      <Section title="Steps" hint="collapsed · open · live">
        <div className="grid max-w-[380px] gap-3">
          <Steps steps={steps} durationMs={12_040} />
          <Steps steps={steps} durationMs={12_040} defaultOpen />
          <Steps steps={steps.slice(0, 2)} durationMs={2_300} live defaultOpen />
          <Steps steps={[]} durationMs={0} />
        </div>
      </Section>

      <Section title="Skeleton, Spinner, EmptyState">
        <Row label="skeleton">
          <div className="flex w-64 flex-col gap-2">
            <Skeleton className="h-3 w-1/3" />
            <Skeleton />
            <Skeleton className="h-16 w-full" />
          </div>
        </Row>
        <Row label="spinner">
          <Spinner />
          <Spinner size={20} />
          <Spinner size={28} className="text-accent" />
        </Row>
        <Row label="empty">
          <div className="h-32 w-80 rounded-lg border border-border bg-surface">
            <EmptyState title="No widgets yet" hint="Ask a question to build this workspace." />
          </div>
          <div className="h-32 w-80 rounded-lg border border-border bg-surface">
            <EmptyState title="No LLM key" hint={<span>Add one in <span className="text-fg-2">~/.terminal/config.yml</span></span>} />
          </div>
        </Row>
      </Section>

      <Section title="Dialog" hint="native <dialog>, Esc and backdrop close">
        <Row>
          <Button variant="primary" onClick={() => setDialog(true)}>
            Open dialog
          </Button>
        </Row>
        <Dialog
          open={dialog}
          onClose={() => setDialog(false)}
          title="Delete workspace?"
          footer={
            <>
              <Button onClick={() => setDialog(false)}>Cancel</Button>
              <Button variant="danger" onClick={() => setDialog(false)}>
                Delete
              </Button>
            </>
          }
        >
          <p className="text-sm text-fg-2">This removes the workspace and its conversation. There is no undo.</p>
        </Dialog>
      </Section>
    </div>
  )
}
