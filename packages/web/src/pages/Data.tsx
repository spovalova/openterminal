import { useCallback, useEffect, useMemo, useState, type FC } from 'react'
import clsx from 'clsx'
import { Button, Dialog, IconButton, Spinner } from '@terminal/ui'
import { recipeParams, type CatalogHit, type Descriptor, type Recipe, type RegisteredConnector, type Workspace } from '@terminal/core'
import { api, type CatalogStats, type ConnectorCatalog, type StoreInfo } from '../api'
import { parseRecipeText, recipeFromWidget } from './recipe-promote'

type ConnectorInfo = RegisteredConnector & { needsKey?: boolean; configured?: boolean }

const STATUS_LABEL: Record<RegisteredConnector['status'], string> = { ok: 'ok', missing_config: 'missing key', unreachable: 'not running', error: 'error' }
const STATUS_CLASS: Record<RegisteredConnector['status'], string> = { ok: 'text-up', missing_config: 'text-fg-2', unreachable: 'text-down', error: 'text-down' }
const inputCls = 'rounded border border-border bg-bg px-2 py-1 text-fg outline-none focus:border-accent'
const sectionTitle = 'text-[11px] tracking-wide text-fg-2 uppercase'

function statusLabel(c: ConnectorInfo): string {
  if (c.status === 'missing_config' && c.needsKey === false) return 'not configured'
  return STATUS_LABEL[c.status]
}

function ago(ms: number | undefined, now = Date.now()): string {
  if (!ms) return 'never'
  const m = Math.round((now - ms) / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} h ago`
  return `${Math.round(h / 24)} d ago`
}

/**
 * The Data page (PLAN.md section 17, "Also in v2"): replaces the Connectors page. Connectors with their keys and
 * catalog stats and a probe button; the catalog browser with search, liveness and a per-route provider override;
 * the recipe library with promote and edit; the store's state.
 */
export const DataPage: FC<{ onClose: () => void; workspace?: Workspace }> = ({ onClose, workspace }) => {
  const [connectors, setConnectors] = useState<ConnectorInfo[] | null>(null)
  const [stats, setStats] = useState<CatalogStats>({})
  const [catalogConnectors, setCatalogConnectors] = useState<string[]>([])
  const [recipes, setRecipes] = useState<{ builtin: Recipe[]; user: Recipe[] } | null>(null)
  const [store, setStore] = useState<StoreInfo | null>(null)
  const [providers, setProviders] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    setError(null)
    api.connectors().then(setConnectors).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
    api
      .catalog()
      .then((c) => {
        setStats(c.stats)
        setCatalogConnectors(c.connectors)
      })
      .catch(() => {})
    api.recipes().then(setRecipes).catch(() => setRecipes({ builtin: [], user: [] }))
    api.storeInfo().then(setStore).catch(() => {})
    api
      .setting<Record<string, string>>('providers')
      .then((v) => setProviders(v && typeof v === 'object' ? v : {}))
      .catch(() => {})
  }, [])
  useEffect(load, [load])

  const saveProviders = async (next: Record<string, string>) => {
    setProviders(next)
    try {
      setProviders(await api.setSetting('providers', next))
    } catch {
      /* keep local */
    }
  }

  return (
    <div data-page="data" className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="flex items-center gap-3 border-b border-border px-4 py-2">
        <h2 className="text-sm font-medium text-fg">Data</h2>
        <span className="text-xs text-fg-2">Connectors, the route catalog, recipes and the store. Keys stay on this machine in ~/.terminal/config.yml.</span>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={load}>
            Reload
          </Button>
          <IconButton label="Close" onClick={onClose}>
            ×
          </IconButton>
        </div>
      </div>
      {error && <div className="px-4 py-2 text-down">{error}</div>}
      <div className="grid gap-6 p-4 xl:grid-cols-[minmax(0,5fr)_minmax(0,4fr)]">
        <div className="flex min-w-0 flex-col gap-6">
          <ConnectorsSection connectors={connectors} stats={stats} onSaved={(saved) => setConnectors((cs) => cs?.map((x) => (x.name === saved.name ? { ...x, ...saved } : x)) ?? null)} onProbed={load} />
          <CatalogSection connectors={catalogConnectors} providers={providers} onProvider={(key, value) => void saveProviders(value ? { ...providers, [key]: value } : Object.fromEntries(Object.entries(providers).filter(([k]) => k !== key)))} />
        </div>
        <div className="flex min-w-0 flex-col gap-6">
          <RecipesSection recipes={recipes} workspace={workspace} onChanged={(user) => setRecipes((r) => (r ? { ...r, user } : r))} />
          <StoreSection store={store} />
        </div>
      </div>
    </div>
  )
}

// ---- connectors ----

function ConnectorsSection({ connectors, stats, onSaved, onProbed }: { connectors: ConnectorInfo[] | null; stats: CatalogStats; onSaved: (c: ConnectorInfo) => void; onProbed: () => void }) {
  const [probing, setProbing] = useState<string | null>(null)
  const [probeNote, setProbeNote] = useState<string | null>(null)
  const probe = async (connector?: string) => {
    setProbing(connector ?? '*')
    setProbeNote(null)
    try {
      const r = await api.probe(connector)
      setProbeNote(`${r.alive} alive, ${r.dead} dead of ${r.probed} routes in ${Math.round(r.ms / 1000)} s`)
      onProbed()
    } catch (err) {
      setProbeNote(err instanceof Error ? err.message : String(err))
    } finally {
      setProbing(null)
    }
  }
  return (
    <section data-section="connectors" className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h3 className={sectionTitle}>Connectors</h3>
        <div className="ml-auto flex items-center gap-2">
          {probeNote && <span className="text-xs text-fg-2">{probeNote}</span>}
          <Button size="sm" variant="ghost" onClick={() => void probe()} disabled={probing !== null} title="Call every route once with a sample symbol and record which answer">
            {probing === '*' ? 'Probing…' : 'Probe routes'}
          </Button>
        </div>
      </div>
      {!connectors && <Spinner />}
      {connectors?.map((c) => (
        <ConnectorRow key={c.name} connector={c} stats={stats[c.name]} onSaved={onSaved} onProbe={() => void probe(c.name)} probing={probing === c.name} />
      ))}
    </section>
  )
}

function ConnectorRow({ connector, stats, onSaved, onProbe, probing }: { connector: ConnectorInfo; stats?: CatalogStats[string]; onSaved: (c: ConnectorInfo) => void; onProbe: () => void; probing: boolean }) {
  const [key, setKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setMessage(null)
    try {
      const saved = await api.setConnectorConfig(connector.name, { apiKey: key.trim() })
      onSaved(saved ?? connector)
      setKey('')
      setMessage('Saved.')
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }
  return (
    <form onSubmit={save} data-connector={connector.name} className="flex flex-col gap-2 rounded border border-border bg-surface px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="font-medium text-fg">{connector.name}</span>
        <span className={STATUS_CLASS[connector.status]}>{statusLabel(connector)}</span>
        {connector.mode && connector.mode !== 'kinds' && <span className="rounded bg-surface-3 px-1 text-[10px] tracking-wide text-fg-2 uppercase">{connector.mode === 'both' ? 'routes + kinds' : 'routes'}</span>}
        {stats && (
          <span className="num ml-auto text-xs text-fg-2" title="routes · alive · dead · unprobed">
            {stats.routes} routes · <span className="text-up">{stats.alive}</span> alive · <span className={stats.dead ? 'text-down' : ''}>{stats.dead}</span> dead · {stats.unknown} unprobed · probed {ago(stats.probedAt)}
          </span>
        )}
        {stats && (
          <Button type="button" size="sm" variant="ghost" onClick={onProbe} disabled={probing}>
            {probing ? 'Probing…' : 'Probe'}
          </Button>
        )}
      </div>
      <div className="text-xs text-fg-2">{connector.kinds.join(', ')}</div>
      {connector.detail && <div className="text-xs text-fg-2">{connector.detail}</div>}
      {connector.error && <pre className="whitespace-pre-wrap font-sans text-xs text-fg-2">{connector.error}</pre>}
      {connector.needsKey !== false && (
        <div className="flex gap-2">
          <input className={clsx(inputCls, 'num flex-1')} type="password" autoComplete="off" placeholder={connector.status === 'ok' ? 'API key (replace)' : 'API key'} value={key} onChange={(e) => setKey(e.target.value)} />
          <Button type="submit" size="sm" variant="primary" disabled={saving || !key.trim()}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      )}
      {message && <div className="text-xs text-fg-2">{message}</div>}
    </form>
  )
}

// ---- catalog ----

function CatalogSection({ connectors, providers, onProvider }: { connectors: string[]; providers: Record<string, string>; onProvider: (key: string, value: string) => void }) {
  const [q, setQ] = useState('')
  const [connector, setConnector] = useState<string>('')
  const [includeDead, setIncludeDead] = useState(true)
  const [hits, setHits] = useState<CatalogHit[]>([])
  const [browse, setBrowse] = useState<ConnectorCatalog | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [detail, setDetail] = useState<Record<string, Descriptor>>({})
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!connector) {
      setBrowse(null)
      return
    }
    let alive = true
    api
      .connectorCatalog(connector)
      .then((c) => {
        if (!alive) return
        setBrowse(c)
        setDetail((d) => ({ ...d, ...Object.fromEntries(c.descriptors.map((x) => [`${x.connector}:${x.route}`, x])) }))
      })
      .catch(() => alive && setBrowse(null))
    return () => {
      alive = false
    }
  }, [connector])

  useEffect(() => {
    if (!q.trim()) {
      setHits([])
      return
    }
    let alive = true
    setLoading(true)
    const t = setTimeout(() => {
      api
        .catalog(q, { limit: 25, includeDead, ...(connector ? { connectors: [connector] } : {}) })
        .then((r) => alive && setHits(r.hits))
        .catch(() => alive && setHits([]))
        .finally(() => alive && setLoading(false))
    }, 150)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [q, connector, includeDead])

  const ensureDetail = async (key: string, c: string) => {
    if (detail[key]) return
    const cat = await api.connectorCatalog(c).catch(() => null)
    if (cat) setDetail((d) => ({ ...d, ...Object.fromEntries(cat.descriptors.map((x) => [`${x.connector}:${x.route}`, x])) }))
  }

  const rows: { key: string; connector: string; route: string; summary: string; liveness?: Descriptor['liveness']; providers: string[] }[] = q.trim()
    ? hits.map((h) => ({ key: `${h.connector}:${h.route}`, connector: h.connector, route: h.route, summary: h.summary, liveness: h.liveness, providers: h.providers }))
    : (browse?.descriptors ?? []).map((d) => ({ key: `${d.connector}:${d.route}`, connector: d.connector, route: d.route, summary: d.summary, liveness: d.liveness, providers: d.providers }))

  return (
    <section data-section="catalog" className="flex flex-col gap-2">
      <h3 className={sectionTitle}>Catalog</h3>
      <div className="flex flex-wrap items-center gap-2">
        <input aria-label="Search the catalog" className={clsx(inputCls, 'min-w-60 flex-1')} placeholder="Search routes: price history, bond yields, screener, economic calendar…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="Connector" className={inputCls} value={connector} onChange={(e) => setConnector(e.target.value)}>
          <option value="">{q.trim() ? 'every connector' : 'browse a connector…'}</option>
          {connectors.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1 text-xs text-fg-2">
          <input type="checkbox" checked={includeDead} onChange={(e) => setIncludeDead(e.target.checked)} /> show dead routes
        </label>
        {loading && <Spinner />}
      </div>
      {rows.length === 0 && <div className="text-xs text-fg-3">{q.trim() ? (loading ? '' : 'No routes match.') : 'Type to search every connector\'s routes, or pick a connector to browse its catalog. The agent searches this same index with find_route.'}</div>}
      <ul data-catalog-rows="" className="max-h-[52vh] divide-y divide-border overflow-y-auto rounded border border-border bg-surface">
        {rows.map((r) => {
          const d = detail[r.key]
          const isOpen = open === r.key
          const live = r.liveness
          return (
            <li key={r.key}>
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-2"
                onClick={() => {
                  setOpen(isOpen ? null : r.key)
                  if (!isOpen) void ensureDetail(r.key, r.connector)
                }}
              >
                <span className={clsx('text-[9px]', live ? (live.ok ? 'text-up' : 'text-down') : 'text-fg-3')} title={live ? (live.ok ? `alive · ${live.rows ?? '?'} rows · ${live.ms ?? '?'} ms` : `dead · ${live.error ?? ''}`) : 'not probed'} aria-label={live ? (live.ok ? 'alive' : 'dead') : 'unprobed'}>
                  ●
                </span>
                <span className="text-xs text-fg-3">{r.connector}</span>
                <span className="num text-fg">{r.route}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-fg-2">{r.summary}</span>
                {providers[r.key] && <span className="rounded bg-surface-3 px-1 text-[10px] text-fg-2">{providers[r.key]}</span>}
              </button>
              {isOpen && (
                <div className="flex flex-col gap-2 border-t border-border bg-bg px-3 py-2 text-xs">
                  {!d && <Spinner />}
                  {d && (
                    <>
                      {d.description && d.description !== d.summary && <p className="text-fg-2">{d.description}</p>}
                      <div>
                        <span className="text-fg-3">params: </span>
                        {d.params.length === 0 && <span className="text-fg-2">none</span>}
                        {d.params.map((p) => (
                          <span key={p.name} className="num mr-2 text-fg" title={p.description}>
                            {p.name}
                            {p.required ? '' : '?'}
                            <span className="text-fg-3">:{p.type}</span>
                          </span>
                        ))}
                      </div>
                      <div className="truncate">
                        <span className="text-fg-3">fields: </span>
                        <span className="num text-fg-2">{d.fields.map((f) => f.name).join(', ') || 'inferred at run time'}</span>
                      </div>
                      {live && !live.ok && <div className="text-down">last probe failed: {live.error}</div>}
                      {live?.ok && live.sampleColumns && <div className="text-fg-2">sample columns: {live.sampleColumns.join(', ')}</div>}
                      {d.providers.length > 0 && (
                        <label className="flex items-center gap-2">
                          <span className="text-fg-3">provider override</span>
                          <select className={inputCls} value={providers[r.key] ?? ''} onChange={(e) => onProvider(r.key, e.target.value)}>
                            <option value="">route default</option>
                            {d.providers.map((p) => (
                              <option key={p} value={p}>
                                {p}
                              </option>
                            ))}
                          </select>
                          <span className="text-fg-3">applies to every query of this route that names no provider</span>
                        </label>
                      )}
                    </>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

// ---- recipes ----

function RecipesSection({ recipes, workspace, onChanged }: { recipes: { builtin: Recipe[]; user: Recipe[] } | null; workspace?: Workspace; onChanged: (user: Recipe[]) => void }) {
  const [editing, setEditing] = useState<{ original?: string; text: string; error?: string } | null>(null)
  const [promoteOpen, setPromoteOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [saving, setSaving] = useState(false)
  const all = useMemo(() => (recipes ? [...recipes.user, ...recipes.builtin] : []), [recipes])
  const shown = all.filter((r) => !filter.trim() || `${r.name} ${r.summary ?? ''} ${r.title}`.toLowerCase().includes(filter.toLowerCase()))

  const saveUser = async (user: Recipe[]) => {
    setSaving(true)
    try {
      const res = await api.setRecipes(user)
      onChanged(res.user)
      return true
    } catch (err) {
      setEditing((e) => (e ? { ...e, error: err instanceof Error ? err.message : String(err) } : e))
      return false
    } finally {
      setSaving(false)
    }
  }

  const submitEdit = async () => {
    if (!editing || !recipes) return
    const parsed = parseRecipeText(editing.text)
    if (!parsed.ok) {
      setEditing({ ...editing, error: parsed.error })
      return
    }
    const next = recipes.user.filter((r) => r.name !== editing.original && r.name !== parsed.recipe.name)
    if (await saveUser([...next, { ...parsed.recipe, user: true }])) setEditing(null)
  }

  const remove = async (name: string) => {
    if (!recipes || !window.confirm(`Delete recipe "${name}"?`)) return
    await saveUser(recipes.user.filter((r) => r.name !== name))
  }

  const promote = (widgetId: string) => {
    const widget = workspace?.widgets.find((w) => w.id === widgetId)
    if (!widget || !recipes) return
    const recipe = recipeFromWidget(widget, recipes.builtin, new Set(all.map((r) => r.name)))
    setPromoteOpen(false)
    setEditing({ text: JSON.stringify(recipe, null, 2) })
  }

  return (
    <section data-section="recipes" className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h3 className={sectionTitle}>Recipes</h3>
        <span className="text-xs text-fg-3">{recipes ? `${recipes.builtin.length} built in · ${recipes.user.length} yours` : ''}</span>
        <div className="ml-auto flex items-center gap-2">
          <input aria-label="Filter recipes" className={clsx(inputCls, 'w-40')} placeholder="filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <Button size="sm" variant="ghost" onClick={() => setPromoteOpen(true)} disabled={!workspace || workspace.widgets.length === 0} title="Save one of the current workspace's widgets as a recipe">
            Promote a widget…
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing({ text: JSON.stringify({ name: 'my_recipe', title: '{symbols} something', params: { type: 'object', properties: { symbols: { type: 'array', items: { type: 'string' } } }, required: ['symbols'] }, view: { preset: 'table' }, routes: [{ connector: 'openbb', route: 'equity/price/quote', params: { symbol: '{symbols}' } }] }, null, 2) })}>
            New
          </Button>
        </div>
      </div>
      {!recipes && <Spinner />}
      <ul data-recipe-rows="" className="max-h-[48vh] divide-y divide-border overflow-y-auto rounded border border-border bg-surface">
        {shown.map((r) => (
          <li key={r.name} className="flex items-center gap-2 px-3 py-1.5">
            <span className="num text-fg">{r.name}</span>
            {r.user && <span className="rounded bg-accent/20 px-1 text-[10px] tracking-wide text-accent uppercase">user</span>}
            <span className="min-w-0 flex-1 truncate text-xs text-fg-2" title={r.summary ?? r.title}>
              {r.summary ?? r.title}
            </span>
            <span className="num shrink-0 text-[11px] text-fg-3">
              {recipeParams(r)
                .map((p) => `${p.name}${p.required ? '' : '?'}`)
                .join(' ')}{' '}
              · {r.view.preset}
            </span>
            {r.user ? (
              <>
                <Button size="sm" variant="ghost" onClick={() => setEditing({ original: r.name, text: JSON.stringify(r, null, 2) })}>
                  Edit
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void remove(r.name)}>
                  Delete
                </Button>
              </>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => setEditing({ text: JSON.stringify({ ...r, name: `${r.name}_copy`, user: true }, null, 2) })} title="Start a user recipe from this one">
                Copy
              </Button>
            )}
          </li>
        ))}
      </ul>

      <Dialog open={editing !== null} onClose={() => setEditing(null)} title={editing?.original ? `Edit recipe ${editing.original}` : 'New recipe'} size="wide">
        {editing && (
          <div className="flex h-[70vh] flex-col gap-2">
            <p className="text-xs text-fg-2">A recipe is data: name (snake_case), title template, params (JSON schema), view preset, and `routes` (ordered alternatives) or `data` (a graph with transforms). Templates: {'"{symbols}"'}, {'"{range|start_date}"'}.</p>
            <textarea aria-label="Recipe JSON" className={clsx(inputCls, 'num min-h-0 flex-1 resize-none text-xs')} value={editing.text} onChange={(e) => setEditing({ ...editing, text: e.target.value })} spellCheck={false} />
            {editing.error && (
              <div data-recipe-error="" className="text-xs text-down">
                {editing.error}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button size="sm" variant="primary" onClick={() => void submitEdit()} disabled={saving}>
                {saving ? 'Saving…' : 'Save recipe'}
              </Button>
            </div>
          </div>
        )}
      </Dialog>

      <Dialog open={promoteOpen} onClose={() => setPromoteOpen(false)} title="Promote a widget to a recipe">
        <div className="flex w-[min(90vw,480px)] flex-col gap-2">
          <p className="text-xs text-fg-2">Pick a widget of the current workspace. Its data graph becomes the recipe's routes (symbol params templated, the rest literal), its preset the recipe's view; you can edit the result before saving.</p>
          <ul className="divide-y divide-border rounded border border-border">
            {workspace?.widgets.map((w) => (
              <li key={w.id}>
                <button type="button" className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-2" onClick={() => promote(w.id)}>
                  <span className="text-fg">{w.title}</span>
                  <span className="ml-auto text-xs text-fg-3">{'preset' in w.view ? w.view.preset : w.view.type}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </Dialog>
    </section>
  )
}

// ---- store ----

function StoreSection({ store }: { store: StoreInfo | null }) {
  if (!store) return null
  const m = store.migration
  return (
    <section data-section="store" className="flex flex-col gap-1 text-xs text-fg-2">
      <h3 className={sectionTitle}>Store</h3>
      <div>
        {store.kind ?? 'store'} at <span className="num text-fg">{store.location}</span> · <span className="num">{store.frames}</span> cached frames
      </div>
      {m && (
        <div>
          {m.alreadyDone ? 'JSON workspaces migrated earlier' : 'JSON workspaces migrated on this start'}: {m.workspaces} workspaces, {m.widgets} widgets ({m.v1Widgets} v1 rewritten as recipes){m.backup ? <> · backup at <span className="num">{m.backup}</span></> : ''}
        </div>
      )}
      <div className="text-fg-3">Recipes you save go to ~/.terminal/recipes.yml; field annotations you add go to ~/.terminal/annotations.yml (read at start).</div>
    </section>
  )
}
