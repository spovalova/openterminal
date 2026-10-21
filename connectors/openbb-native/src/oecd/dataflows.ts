// The OECD catalogue commands: topics, dataflows, tables, and one dataflow's parameters and detail. The catalogue they
// read is catalogue.ts's.
import { text } from '../lib/params.js'
import { split } from '../sec/markdown/py.js'
import type { NativeParams, Row } from '../types.js'
import { constrainedValues, describeDataflow, listDataflows as catalogueDataflows, listTables as catalogueTables, tableMap, topicRows, type IndicatorNode } from './catalogue.js'

/** `results` that Python's API puts out as a string: the connector keeps only object rows, so the rows of such a call are none. */
const asResults = (markdown: string): Row => markdown as unknown as Row

/** `output_format`: `json` unless the call says `markdown` (the API refuses anything else). */
function outputFormat(params: NativeParams): 'json' | 'markdown' {
  const format = text(params, 'output_format') ?? 'json'
  if (format !== 'json' && format !== 'markdown') throw new Error("Input should be 'json' or 'markdown'")
  return format
}

// oecd/list_dataflows (command, no provider). Ported from openbb_oecd/oecd_router.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows, and the metadata singleton is catalogue.ts.
export async function listDataflows(params: NativeParams): Promise<Row[]> {
  const subtopic = text(params, 'subtopic')
  let dataflows = catalogueDataflows(text(params, 'topic'))
  if (subtopic) dataflows = dataflows.filter((d) => d.subtopic.toUpperCase() === subtopic.toUpperCase())
  return dataflows.map((d) => ({ dataflow_id: d.value.includes('@') ? d.value.split('@').at(-1)! : d.value, name: d.label, topic: d.topic_name, subtopic: d.subtopic_name }))
}

// oecd/list_topics (command, no provider). Ported from openbb_oecd/oecd_router.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows, and the metadata singleton is catalogue.ts.
export async function listTopics(params: NativeParams): Promise<Row[]> {
  const query = text(params, 'query')
  const rows = topicRows()
  if (!query) return rows
  const needle = query.toLowerCase()
  return rows.filter((r) => r.topic.toLowerCase().includes(needle) || r.subtopic.toLowerCase().includes(needle))
}

// oecd/get_dataflow_parameters (command, no provider). Ported from openbb_oecd/oecd_router.py (OpenBB Platform 5.0.0, Apache-2.0); modified: the constrained values are catalogue.ts's.
export async function getDataflowParameters(params: NativeParams): Promise<Row> {
  const parameters = constrainedValues(text(params, 'dataflow_id') ?? '')
  if (outputFormat(params) === 'json') return parameters
  const sections = Object.entries(parameters).map(([dim, options]) => {
    const inner = options.map((o) => `| ${o.value} | ${o.label} |`).join('\n')
    return `<details>\n<summary><b>${dim}</b> (${options.length} values)</summary>\n\n| Code | Label |\n|---|---|\n${inner}\n\n</details>`
  })
  return asResults(sections.join('\n\n'))
}

// oecd/list_tables (command, no provider). Ported from openbb_oecd/oecd_router.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows, and the metadata singleton is catalogue.ts.
export async function listTables(params: NativeParams): Promise<Row[]> {
  const rows = catalogueTables(text(params, 'query'), text(params, 'topic'), text(params, 'subtopic'))
  const dataflow = text(params, 'dataflow_id')
  if (!dataflow) return rows
  const needle = dataflow.toUpperCase()
  return rows.filter((r) => r.table_id.toUpperCase().includes(needle) || r.dataflow_id.toUpperCase().includes(needle))
}

/** The indicator tree as an indented list (`_render_tree`). */
function renderTree(nodes: IndicatorNode[], lines: string[], depth = 0): void {
  for (const node of nodes) {
    lines.push(`${'  '.repeat(depth)}- **${node.code}** — ${node.label}`)
    renderTree(node.children, lines, depth + 1)
  }
}

// oecd/get_table_detail (command, no provider). Ported from openbb_oecd/oecd_router.py (OpenBB Platform 5.0.0, Apache-2.0); modified: the dataflow's description is catalogue.ts's, and the document is returned as the one string OpenBB puts in `results`.
export async function getTableDetail(params: NativeParams): Promise<Row> {
  const tableId = text(params, 'table_id') ?? ''
  const detail = describeDataflow(tableId)
  const shortId = detail.short_id
  // The topic path of the table, for context.
  const tableRow = tableMap().find((row) => row.short_id === shortId || row.dataflow_id === detail.dataflow_id)

  const lines: string[] = [`# ${detail.name}`, `**Dataflow ID:** \`${shortId}\``]
  const path = tableRow?.path ?? ''
  if (path) lines.push(`\n**Category:** ${path}`)
  if (detail.description) lines.push(`\n${detail.description}`)
  lines.push('')

  const indicatorDimension = detail.indicator_dimension
  if (detail.table_groups.length > 0) {
    lines.push('## Tables\n')
    for (const g of detail.table_groups) {
      lines.push(`### ${g.value} — ${g.label}`)
      // The description only when it adds something beyond the label.
      if (g.description && g.description !== g.label) lines.push(`\n${g.description}\n`)
      else lines.push('')
    }
  }

  // The table-grouping dimension is shown above, so the dimensions section skips it.
  const groupDimension = detail.table_groups.length > 0 ? ['TABLE_IDENTIFIER', 'CHAPTER'].find((c) => detail.dimensions.some((d) => d.id === c)) : undefined
  if (detail.dimensions.length > 0) {
    lines.push('## Dimensions\n')
    for (const dim of detail.dimensions) {
      if (dim.id === groupDimension) continue
      const tag = dim.id === indicatorDimension ? ' *(indicator dimension)*' : ''
      let summary = `\`${dim.id}\``
      if (dim.name && dim.name !== dim.id) summary += ` — ${dim.name}`
      summary += `  (${dim.constrained_codes} values)${tag}`
      lines.push(`<details>\n<summary>${summary}</summary>\n`)
      if (dim.values.length > 0) {
        lines.push('| Code | Label | Description |', '|---|---|---|')
        for (const v of dim.values) {
          const description = split(v.description).join(' ')
          lines.push(`| ${v.value} | ${v.label} | ${description && description !== v.label ? description : ''} |`)
        }
      }
      lines.push('\n</details>\n')
    }
  }

  if (detail.indicator_count > 0) {
    lines.push(`## Indicators\n\n**${detail.indicator_count}** indicators in dimension \`${indicatorDimension}\`.\n`)
    if (detail.indicator_tree.length > 0) {
      lines.push('<details>\n<summary>Indicator tree</summary>\n')
      renderTree(detail.indicator_tree, lines)
      lines.push('\n</details>\n')
    }
  }
  return asResults(lines.join('\n'))
}
