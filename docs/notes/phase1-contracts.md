# Phase 1 seams

Written in Phase 0 so the eight workstreams compile against each other before any of them is finished. Every seam below exists as a typed stub; the owning workstream replaces the stub body and keeps the exported names and signatures. Change a signature only by editing this file in the same commit.

## Names and ports

| Thing | Value |
|---|---|
| Package scope | `@terminal/core`, `@terminal/server`, `@terminal/ui`, `@terminal/web`, `@terminal/connector-yahoo`, `@terminal/connector-finnhub`; CLI package `terminal`, bin `terminal` |
| Server | `http://localhost:4242`; HTTP routes under `/api`; WebSocket at `/ws` |
| Web dev server | `http://localhost:5173`, proxies `/api` and `/ws` to 4242 |
| UI preview page | `http://localhost:5174` |
| Config | `~/.terminal/config.yml` (override the directory with `TERMINAL_HOME`) |
| Workspaces | `~/.terminal/workspaces/<id>.json` |

## core (frozen)

`@terminal/core` exports: Frame/Column schemas, `KINDS`, `QuerySchema`, `parseQuery`, `ttlFor`, `WidgetSchema`/`parseWidget`, `SIZE_SPANS`, `WorkspaceSchema`, `createWorkspace`, `WIDGET_CHIP_RE`, `preview`, `defineConnector`, `toFrame`, `createHttp`, `MemoryCache`, `ConnectorRegistry`, `ClientMsgSchema`, `ServerMsgSchema`, `AgentRunner`. Read `packages/core/src` before building; report gaps, do not patch.

## connectors → server

Each connector package's default export is a `Connector` from `defineConnector`. The server holds a built-in map `{ yahoo, finnhub }` from config name to module and registers them in config order. Yahoo's config schema is `z.object({})`; Finnhub's is `z.object({ apiKey: z.string().min(1) })`.

## server → agent

`packages/server/src/agent/index.ts` exports:

```ts
export type LlmConfig = { provider: 'anthropic' | 'openai'; model: string; apiKey: string }
export function createAgentRunner(deps: { registry: Registry; llm: LlmConfig; log?: (msg: string) => void; now?: () => Date }): AgentRunner
```

The server also owns `packages/server/src/stub-agent.ts`: an `AgentRunner` that returns a fixed use-case-A widget set, used when no LLM key is configured and in route tests. `src/main.ts` picks real or stub from config.

## ui → web, views

`@terminal/ui` exports (components are React function components; props below are the minimum):

- `Button { variant?: 'primary' | 'ghost' | 'danger'; size?: 'sm' | 'md' } & ButtonHTMLAttributes`
- `IconButton { label: string } & ButtonHTMLAttributes` (children is the icon)
- `Kbd { children }`
- `Chip { children; onClick?; active? }`
- `Tabs { items: { id: string; label: string }[]; activeId?: string; onSelect(id); onClose?(id); onNew?() }`
- `PromptBox { value; onChange(v); onSubmit(); busy?; onCancel?(); placeholder?; autoFocus?; className? }` with `view-transition-name: prompt-box` set on its root
- `WidgetFrame { title; size: Size; loading?; error?: string; empty?: boolean; onEdit?(); onRefresh?(); onExpand?(); children }`
- `DataTable { columns: Column[]; rows: unknown[][]; formats?: Record<string, CellFormat>; sort?: { column: string; dir: 'asc' | 'desc' }; onSort?(column) }` where `CellFormat = 'text' | 'price' | 'percent' | 'integer' | 'time' | 'date' | 'link'`
- `Steps { steps: Step[]; durationMs: number; defaultOpen? }`
- `Skeleton { className? }`, `Spinner`, `EmptyState { title; hint? }`
- `Dialog { open; onClose(); title; children }`
- `tokens` (the color/spacing scale as a JS object), `chartTheme` (lightweight-charts `DeepPartial<ChartOptions>` for the dark theme), `seriesPalette: string[]` (six), `UP_COLOR`, `DOWN_COLOR`
- `@terminal/ui/styles.css`: Tailwind v4 entry with `@theme` tokens; the web app imports it once

## web → views

`packages/web/src/views/index.ts` exports:

```ts
export type ViewProps = { widget: Widget; frame: Frame }
export const SeriesView: React.FC<ViewProps>
export const TableView: React.FC<ViewProps>
export function viewFor(view: View): React.FC<ViewProps>
```

Views own everything under `packages/web/src/views`; they import components and the chart theme from `@terminal/ui` and nothing from the rest of `packages/web`.

## root

`pnpm query <kind> <params…>` (`scripts/query.ts`) builds a registry from `~/.terminal/config.yml` (yahoo only when absent) and prints a frame. Owned by the server workstream after Phase 0.
