// cboe/index/documents, provider cboe. Ported from openbb_cboe/models/index_documents.py and get_index_documents in
// openbb_cboe/utils/helpers.py (OpenBB Platform 5.0.0, Apache-2.0); modified: the catalog (assets/index_documents.json)
// is embedded as a module (index-documents-data.ts).
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { factsheetOf } from './helpers.js'
import { INDEX_DOCUMENTS } from './index-documents-data.js'

export async function indexDocuments(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const symbol = typeof params.symbol === 'string' && params.symbol ? params.symbol.replaceAll('^', '').toUpperCase() : undefined
  let documents: Row[] = INDEX_DOCUMENTS
  if (symbol) {
    documents = INDEX_DOCUMENTS.filter((d) => d.symbols?.includes(symbol) || !d.symbols?.length).map(({ category, title, url }) => ({ category, title, url }))
    // Cboe publishes a factsheet for some indices; the file is there or it is not.
    const factsheet = await factsheetOf(ctx, symbol)
    if (factsheet) documents.unshift({ ...factsheet })
  }
  const category = typeof params.category === 'string' && params.category ? params.category : undefined
  const matching = documents.filter((d) => !category || d.category === category)
  if (matching.length === 0) throw new Error('No documents match the query.')
  return matching
}
