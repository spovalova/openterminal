// `_mda_from_full_text` of management_discussion_analysis.py, provider sec (OpenBB Platform 5.0.0, Apache-2.0);
// modified: FinancialStatements is the port in ../filing/.
import type { NativeCtx } from '../../types.js'
import { financialStatementsFor } from '../filing/financial-statements.js'
import { strip } from './py.js'

/**
 * Read Item 7 (MD&A) from a filing's full-submission text.
 *
 * Old SGML filings (pre-HTML) have no locatable HTML section anchor, so the HTML parser cannot find the MD&A; the
 * plain-text item extractor reads it from the full submission instead. Returns "" on any failure.
 */
export async function mdaFromFullText(ctx: NativeCtx, url: string, useCache: boolean): Promise<string> {
  try {
    const fs = await financialStatementsFor(ctx, url, useCache)
    const item = await fs.getItem('7')
    return item ? strip(item.text || '') : ''
  } catch {
    return ''
  }
}
