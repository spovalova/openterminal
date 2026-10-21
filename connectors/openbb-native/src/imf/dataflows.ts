// The IMF catalogue commands: the dataflows, one dataflow's dimensions, and the presentation tables. The dataflow
// catalogue and the curated tables are data/commands.json (built by data/generate-commands.py); the dimensions and the
// indicator counts are the metadata the data routes already read (metadata.ts).
import { text } from '../lib/params.js'
import type { NativeParams, Row } from '../types.js'
import catalogue from './data/commands.json' with { type: 'json' }
import { compareText } from './helpers.js'
import { dataflowParameters, getDataflow, type Param } from './metadata.js'

type Presentation = { id: string; name: string; description: string; codelist_id: string; agency_id: string; friendly_name: string }
type Catalogue = { dataflows: Record<string, { name?: string; description?: string } & Row>; tables: [string, Presentation[]][] }
const { dataflows, tables } = catalogue as unknown as Catalogue

/** `results` that Python's API puts out as a string: the connector keeps only object rows, so the rows of such a call are none. */
const asResults = (markdown: string): Row => markdown as unknown as Row

/** `_render_dataflows_markdown`: the whole catalogue as a markdown summary. */
function renderDataflows(): string {
  const parts: string[] = []
  for (const id of Object.keys(dataflows).sort(compareText)) {
    const details = dataflows[id]!
    // `get_indicators_in` raises KeyError for a dataflow without an indicator dimension, which the router reads as none.
    const series = getDataflow(id)?.ind?.length ?? 0
    const dimensions = Object.keys(getDataflow(id)?.params ?? {})
    parts.push(`## \`${id}\` - ${details.name ?? ''}\n\n`)
    if (series > 0) parts.push(`**Number of Series:** ${series}\n\n`)
    if (dimensions.length > 0) parts.push(`**Dimensions:** ${dimensions.map((d) => `\`${d}\``).join(', ')}\n\n`)
    const presentations = tables.find(([dataflow]) => dataflow === id)?.[1] ?? []
    if (presentations.length > 0) {
      parts.push('### Presentation Tables\n\n')
      const seen = new Set<string>()
      for (const pres of presentations) {
        const name = pres.name.trim()
        if (seen.has(name)) continue
        seen.add(name)
        const description = pres.description.trim()
        parts.push(`#### ${name}\n\n`)
        if (pres.friendly_name) parts.push(`**Friendly Name:** \`${pres.friendly_name}\`\n\n`)
        parts.push(`**Symbol:** \`${id}::${pres.id}\`\n\n`)
        if (description && description !== name) parts.push(`${description}\n\n`)
      }
    }
    parts.push(`${(details.description ?? '').trim()}\n\n`, '---\n\n')
  }
  return parts.join('')
}

/** `_render_parameters_markdown`: a per-dimension code list. */
function renderParameters(parameters: Record<string, Param[]>): string {
  return Object.entries(parameters)
    .map(([dim, options]) => `### \`${dim}\`\n\n${options.map((o) => `- \`${o.value}\` : ${o.label}\n\n`).join('')}---\n\n`)
    .join('')
}

// imf/list_dataflows (command, no provider). Ported from openbb_imf/imf_router.py (OpenBB Platform 5.0.0, Apache-2.0); modified: the catalogue is the data file, and the markdown summary reads the indicator counts and dimensions of imf.json.
export async function listDataflows(params: NativeParams): Promise<Row> {
  if (text(params, 'output_format') === 'markdown') return asResults(renderDataflows())
  return structuredClone(dataflows)
}

// imf/get_dataflow_dimensions (command, no provider). Ported from openbb_imf/imf_router.py (OpenBB Platform 5.0.0, Apache-2.0); modified: the dimensions are the ones imf.json holds.
export async function getDataflowDimensions(params: NativeParams): Promise<Row> {
  const parameters = dataflowParameters(text(params, 'dataflow_id') ?? '')
  return text(params, 'output_format') === 'markdown' ? asResults(renderParameters(parameters)) : parameters
}

// imf/list_tables (command, no provider). Ported from openbb_imf/imf_router.py (OpenBB Platform 5.0.0, Apache-2.0); modified: the curated tables are the data file's, plain rows instead of ImfTableMetadata.
export async function listTables(): Promise<Row[]> {
  return tables.flatMap(([dataflow, presentations]) =>
    presentations.map((pres) => ({
      name: pres.name,
      description: pres.description.trim(),
      symbol: `${dataflow}::${pres.id}`,
      agency_id: pres.agency_id,
      dataflow_id: dataflow,
      codelist_id: pres.codelist_id,
    })),
  )
}
