import { useEffect, useId, useMemo, useState, type FC } from 'react'
import clsx from 'clsx'
import { Button } from '@openterminal/ui'
import { describeQuery, isRecipeQuery, isRouteQuery, isTransformQuery, recipeParams, type AnyQuery, type CatalogHit, type Descriptor, type Recipe } from '@openterminal/core'
import { api } from '../api'
import { datasetKind, newTransform, nextDatasetName, removeDataset, renameDataset, transformEdges, validDatasetName, type DatasetKind, type EditorDraft } from './editor-model'
import { FramePreview, type PreviewState } from './FramePreview'
import { Field, ParamsForm, inputCls, labelCls } from './ParamsForm'

export type EditorDataProps = {
  draft: EditorDraft
  onChange: (next: EditorDraft) => void
  previews: Record<string, PreviewState>
  runPreview: (name: string, refresh?: boolean) => Promise<void>
  recipes: Recipe[]
  connectors: string[]
  loadDescriptors: (connector: string) => Promise<Descriptor[]>
}

const KIND_BADGE: Record<DatasetKind, string> = { recipe: 'recipe', route: 'route', transform: 'transform' }

/** The data tab: the graph on the left (one row per dataset, transforms with their inputs), the selected dataset's form and preview on the right. */
export const EditorData: FC<EditorDataProps> = ({ draft, onChange, previews, runPreview, recipes, connectors, loadDescriptors }) => {
  const names = Object.keys(draft.data)
  const [selected, setSelected] = useState<string>(names[0] ?? '')
  const current = draft.data[selected] ? selected : (names[0] ?? '')
  const q = draft.data[current]
  const uid = useId()
  const [renaming, setRenaming] = useState<string | null>(null)

  const setQuery = (name: string, next: AnyQuery) => onChange({ ...draft, data: { ...draft.data, [name]: next } })

  const add = (kind: DatasetKind) => {
    const name = nextDatasetName(draft.data, kind === 'transform' ? 'derived' : 'data')
    const q: AnyQuery =
      kind === 'recipe'
        ? { recipe: recipes[0]?.name ?? 'quote', params: {} }
        : kind === 'route'
          ? { connector: connectors[0] ?? 'openbb', route: '', params: {} }
          : newTransform(draft.data, names.filter((n) => !isTransformQuery(draft.data[n]!)))
    onChange({ ...draft, data: { ...draft.data, [name]: q } })
    setSelected(name)
  }

  return (
    <div className="grid h-full min-h-0 grid-cols-[260px_1fr] gap-4">
      <div className="flex min-h-0 flex-col gap-2">
        <div className={labelCls}>Datasets</div>
        <ul data-graph="" className="flex flex-col gap-1">
          {names.map((name) => {
            const dq = draft.data[name]!
            const kind = datasetKind(dq)
            const edges = transformEdges(name, draft.data)
            const p = previews[name]
            return (
              <li key={name}>
                <button
                  type="button"
                  data-dataset={name}
                  aria-current={name === current ? 'true' : undefined}
                  onClick={() => setSelected(name)}
                  className={clsx('flex w-full flex-col gap-0.5 rounded border px-2 py-1.5 text-left', name === current ? 'border-accent bg-surface-2' : 'border-border hover:border-border-strong')}
                >
                  <span className="flex items-center gap-2">
                    <span className="num font-medium text-fg">{name}</span>
                    <span className="rounded bg-surface-3 px-1 text-[10px] tracking-wide text-fg-2 uppercase">{KIND_BADGE[kind]}</span>
                    <span className="ml-auto text-[10px] text-fg-3">{p?.status === 'ok' ? `${p.frame.rows.length} rows` : p?.status === 'error' ? 'error' : p?.status === 'loading' ? '…' : ''}</span>
                  </span>
                  <span className="truncate text-xs text-fg-2" title={describeQuery(dq)}>
                    {describeQuery(dq) || '(empty)'}
                  </span>
                  {edges.length > 0 && <span className="text-[11px] text-fg-3">← {edges.join(', ')}</span>}
                </button>
              </li>
            )
          })}
        </ul>
        <div className="flex flex-wrap gap-1">
          <Button type="button" size="sm" variant="ghost" onClick={() => add('recipe')}>
            + recipe
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => add('route')}>
            + route
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => add('transform')}>
            + transform
          </Button>
        </div>
      </div>

      {q && (
        <div className="flex min-h-0 flex-col gap-3">
          <div className="flex items-center gap-2">
            {renaming === current ? (
              <RenameInput
                name={current}
                onDone={(to) => {
                  setRenaming(null)
                  if (to !== current && validDatasetName(to) && !(to in draft.data)) {
                    onChange(renameDataset(draft, current, to))
                    setSelected(to)
                  }
                }}
              />
            ) : (
              <button type="button" className="num text-sm font-medium text-fg hover:underline" title="Rename" onClick={() => setRenaming(current)}>
                {current}
              </button>
            )}
            <span className="text-xs text-fg-3">{KIND_BADGE[datasetKind(q)]}</span>
            <div className="ml-auto flex gap-1">
              <Button type="button" size="sm" variant="ghost" onClick={() => void runPreview(current)} disabled={previews[current]?.status === 'loading'}>
                Preview
              </Button>
              {names.length > 1 && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    onChange(removeDataset(draft, current))
                    setSelected(names.find((n) => n !== current) ?? '')
                  }}
                >
                  Remove
                </Button>
              )}
            </div>
          </div>

          {isTransformQuery(q) ? (
            <div className="rounded border border-border bg-bg px-3 py-2 text-fg-2">
              A transform over {Object.keys(q.inputs).join(', ') || 'no inputs'}; edit its inputs and code on the Transform tab.
              <pre className="num mt-2 max-h-32 overflow-auto text-xs text-fg-3">{q.code}</pre>
            </div>
          ) : isRecipeQuery(q) ? (
            <RecipeForm id={`${uid}-r`} query={q} recipes={recipes} onChange={(next) => setQuery(current, next)} />
          ) : isRouteQuery(q) ? (
            <RouteForm id={`${uid}-o`} query={q} connectors={connectors} loadDescriptors={loadDescriptors} onChange={(next) => setQuery(current, next)} />
          ) : null}

          <div className="flex min-h-0 flex-col gap-1">
            <div className={labelCls}>Preview</div>
            <FramePreview preview={previews[current] ?? { status: 'idle' }} query={q} />
          </div>
        </div>
      )}
    </div>
  )
}

function RenameInput({ name, onDone }: { name: string; onDone: (to: string) => void }) {
  const [v, setV] = useState(name)
  return (
    <input
      autoFocus
      aria-label="Dataset name"
      className={clsx(inputCls, 'num w-40')}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => onDone(v.trim())}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          onDone(v.trim())
        }
        if (e.key === 'Escape') onDone(name)
      }}
    />
  )
}

// ---- recipe ----

function RecipeForm({ id, query, recipes, onChange }: { id: string; query: { recipe: string; params: Record<string, unknown> }; recipes: Recipe[]; onChange: (q: AnyQuery) => void }) {
  const recipe = recipes.find((r) => r.name === query.recipe)
  const params = useMemo(() => (recipe ? recipeParams(recipe) : []), [recipe])
  return (
    <div className="flex flex-col gap-3">
      <Field id={`${id}-recipe`} label="Recipe">
        <select id={`${id}-recipe`} className={inputCls} value={query.recipe} onChange={(e) => onChange({ recipe: e.target.value, params: {} })}>
          {!recipe && <option value={query.recipe}>{query.recipe}</option>}
          {recipes.map((r) => (
            <option key={r.name} value={r.name}>
              {r.name}
              {r.user ? ' (user)' : ''}
            </option>
          ))}
        </select>
      </Field>
      {recipe && <p className="text-xs text-fg-2">{recipe.summary ?? recipe.title}</p>}
      <ParamsForm id={id} params={params} values={query.params} onChange={(params) => onChange({ recipe: query.recipe, params })} />
    </div>
  )
}

// ---- route ----

function RouteForm({
  id,
  query,
  connectors,
  loadDescriptors,
  onChange,
}: {
  id: string
  query: { connector: string; route: string; params: Record<string, unknown> }
  connectors: string[]
  loadDescriptors: (connector: string) => Promise<Descriptor[]>
  onChange: (q: AnyQuery) => void
}) {
  const [descriptors, setDescriptors] = useState<Descriptor[]>([])
  const [search, setSearch] = useState('')
  const [hits, setHits] = useState<CatalogHit[]>([])
  useEffect(() => {
    let alive = true
    void loadDescriptors(query.connector).then((d) => alive && setDescriptors(d))
    return () => {
      alive = false
    }
  }, [query.connector, loadDescriptors])
  useEffect(() => {
    if (!search.trim()) {
      setHits([])
      return
    }
    let alive = true
    const t = setTimeout(() => {
      api
        .catalog(search, { connectors: [query.connector], limit: 8, includeDead: true })
        .then((r) => alive && setHits(r.hits))
        .catch(() => alive && setHits([]))
    }, 150)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [search, query.connector])
  const descriptor = descriptors.find((d) => d.route === query.route)
  const options = connectors.includes(query.connector) ? connectors : [query.connector, ...connectors]
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-[140px_1fr] gap-3">
        <Field id={`${id}-connector`} label="Connector">
          <select id={`${id}-connector`} className={inputCls} value={query.connector} onChange={(e) => onChange({ connector: e.target.value, route: '', params: {} })}>
            {options.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </Field>
        <Field id={`${id}-route`} label="Route" hint="Type to search the connector's catalog, or the exact path">
          <input id={`${id}-route`} className={clsx(inputCls, 'num')} value={query.route} placeholder="equity/price/historical" list={`${id}-routes`} onChange={(e) => onChange({ connector: query.connector, route: e.target.value.trim(), params: {} })} />
          <datalist id={`${id}-routes`}>
            {descriptors.map((d) => (
              <option key={d.route} value={d.route}>
                {d.summary}
              </option>
            ))}
          </datalist>
        </Field>
      </div>
      <div className="flex flex-col gap-1">
        <input aria-label="Search routes" className={inputCls} value={search} placeholder={`Search ${query.connector} routes (price history, bond yields, screener…)`} onChange={(e) => setSearch(e.target.value)} />
        {hits.length > 0 && (
          <ul className="max-h-40 divide-y divide-border overflow-y-auto rounded border border-border bg-bg">
            {hits.map((h) => (
              <li key={`${h.connector}:${h.route}`}>
                <button
                  type="button"
                  className="flex w-full flex-col px-2 py-1 text-left hover:bg-surface-2"
                  onClick={() => {
                    onChange({ connector: h.connector, route: h.route, params: {} })
                    setSearch('')
                  }}
                >
                  <span className="num text-fg">{h.route}</span>
                  <span className="truncate text-xs text-fg-2">{h.summary}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {descriptor ? (
        <>
          <p className="text-xs text-fg-2">{descriptor.summary}</p>
          <ParamsForm id={id} params={descriptor.params} values={query.params} onChange={(params) => onChange({ ...query, params })} providers={descriptor.providers} />
        </>
      ) : query.route ? (
        <p className="text-xs text-fg-3">{descriptors.length ? `"${query.route}" is not a route of ${query.connector}.` : `Loading ${query.connector}'s routes…`}</p>
      ) : null}
    </div>
  )
}
