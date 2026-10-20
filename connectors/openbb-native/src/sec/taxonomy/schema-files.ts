// sec/schema_files, provider sec. Ported from openbb_sec/models/schema_files.py (OpenBB Platform 5.0.0, Apache-2.0);
// modified: plain rows instead of pydantic models, async downloads through ctx.
import type { NativeCtx, NativeParams, Row } from '../../types.js'
import { OpenBBError, type XBRLNode } from './xbrl-parser.js'
import { XBRLManager } from './xbrl-manager.js'

/** `_flatten_nodes`: XBRLNode trees as rows, parents before their children. */
function flattenNodes(nodes: XBRLNode[]): Row[] {
  const results: Row[] = []
  for (const node of nodes) {
    results.push({
      name: node.element_id,
      label: node.label,
      description: node.documentation,
      level: node.level,
      order: node.order,
      parent_id: node.parent_id,
      preferred_label: node.preferred_label,
      xbrl_type: node.xbrl_type,
      period_type: node.period_type,
      balance_type: node.balance_type,
      abstract: node.abstract,
      substitution_group: node.substitution_group,
      nillable: node.nillable,
    })
    if (node.children.length) results.push(...flattenNodes(node.children))
  }
  return results
}

/** A row without its null cells (pydantic output leaves out what is None). */
function compact(row: Row): Row {
  return Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null && v !== undefined))
}

const optString = (v: unknown): string | null => (v === undefined || v === null ? null : String(v))

export async function secSchemaFiles(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const taxonomy = optString(params.taxonomy)
  const year = params.year === undefined || params.year === null || params.year === '' ? null : Number(params.year)
  const component = optString(params.component)
  const category = optString(params.category)

  // `_validate_progressive_params`: year requires taxonomy, component requires taxonomy, category only lists
  if (year !== null && taxonomy === null) throw new Error("Parameter 'year' requires 'taxonomy' to be set. Provide a taxonomy first, or omit both to list all taxonomies.")
  if (component !== null && taxonomy === null) throw new Error("Parameter 'component' requires 'taxonomy' to be set.")
  if (category !== null && taxonomy !== null) throw new Error("Parameter 'category' is only used when listing all taxonomies (i.e., when 'taxonomy' is not set).")

  const manager = new XBRLManager(ctx)

  // Mode 1: list all taxonomy families
  if (taxonomy === null) {
    return Object.entries(manager.listAvailableTaxonomies(category)).map(([key, meta]) =>
      compact({
        name: key,
        label: meta.label,
        description: meta.description,
        category: meta.category,
        style: meta.style,
        has_label_linkbase: meta.has_label_linkbase === 'True',
        url: meta.sec_reference_url,
      }),
    )
  }

  // Mode 2: the most recent year when none is given
  const availableYears = await manager.getAvailableYears(taxonomy)
  let resolvedYear = year
  if (resolvedYear === null) {
    if (!availableYears.length) throw new OpenBBError(`No years found for taxonomy '${taxonomy}'. Omit all parameters to list available taxonomies.`)
    resolvedYear = Math.max(...availableYears)
  } else if (availableYears.length && !availableYears.includes(resolvedYear)) {
    throw new OpenBBError(`Year ${resolvedYear} is not available for taxonomy '${taxonomy}'. Available years: [${[...availableYears].sort((a, b) => b - a).join(', ')}]`)
  }

  let targetComponents: string[]
  if (component !== null) targetComponents = [component]
  else {
    targetComponents = await manager.listAvailableComponents(taxonomy, resolvedYear)
    if (!targetComponents.length) throw new OpenBBError(`No components found for ${taxonomy} ${resolvedYear}.`)
    // With several components the listing is returned instead of parsing everything (us-gaap has 26, IFRS 47).
    if (targetComponents.length > 1) return (await manager.getComponentsMetadata(taxonomy, resolvedYear)).map(compact)
  }

  const results: Row[] = []
  for (const comp of targetComponents) results.push(...flattenNodes(await manager.getStructure(taxonomy, resolvedYear, comp)))
  return results.map(compact)
}
