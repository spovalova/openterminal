// sec/financial_statements: one filing's income, balance, cash flow or equity statement as reported, provider sec.
// Ported from openbb_sec/models/sec_financials.py (`_download_statement`, `_download_statement_from_url`; OpenBB
// Platform 5.0.0, Apache-2.0); modified: the pandas frames are tables of rows (./pandas-lite.ts reads the R pages),
// and the per-tag metadata table that OpenBB builds but never returns is not built.
import { NativeUnsupported } from '../../types.js'
import type { Row } from '../../types.js'
import type { FinancialStatements } from './financial-statements.js'
import { parseNonXbrlStatement } from './non-xbrl.js'
import { isEmpty, nrows, pyStrCell, pyStrip, pySplitWs, type Frame } from './pandas-lite.js'
import { fmtDate, monthEnd, nextMonthBegin, parseDate, sameDayLastYearPlusOne, subMonths } from './pydate.js'

type Dict = Record<string, any>
/** A table of rows; a null cell is NaN or None. */
type Tbl = { columns: string[]; rows: any[][] }

const emptyTbl = (): Tbl => ({ columns: [], rows: [] })
const isEmptyTbl = (t: Tbl): boolean => t.rows.length === 0 || t.columns.length === 0

/** Python's `float(text)`: the number, or null where it raises ValueError. */
export function pyFloatOrNull(text: string): number | null {
  const t = pyStrip(text)
  if (/^[+-]?(\d+(_\d+)*(\.(\d+(_\d+)*)?)?|\.\d+(_\d+)*)([eE][+-]?\d+(_\d+)*)?$/.test(t)) return Number(t.replaceAll('_', ''))
  const lower = t.toLowerCase()
  if (/^[+-]?(inf|infinity)$/.test(lower)) return lower.startsWith('-') ? -Infinity : Infinity
  if (/^[+-]?nan$/.test(lower)) return NaN
  return null
}

/** `str(x)` of a cell Python would hold (a float prints with its ".0"). */
function pyStr(x: any): string {
  if (x === null || x === undefined) return 'None'
  if (typeof x === 'number') return Number.isNaN(x) ? 'nan' : Number.isInteger(x) ? `${x}` : String(x)
  return String(x)
}

const isNull = (x: unknown): boolean => x === null || x === undefined || (typeof x === 'number' && Number.isNaN(x))

/** `_multiplier_map` */
function multiplierMap(s: string): number {
  switch (s.toLowerCase()) {
    case 'millions':
      return 1000000
    case 'hundreds of thousands':
      return 100000
    case 'tens of thousands':
      return 10000
    case 'thousands':
      return 1000
    case 'hundreds':
      return 100
    case 'tens':
      return 10
    default:
      return 1
  }
}

/** `format_date`: the first three words of a column label as a date, or null. */
function formatDate(x: unknown): string | null {
  if (!x) return null
  try {
    return fmtDate(parseDate(pySplitWs(String(x)).slice(0, 3).join(' ')))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------------------------------------------
// one R page
// ---------------------------------------------------------------------------------------------------------------

/** A level-0 / level-1 column key as `df.columns[i][0]` reads it (the first character of a flat label). */
const firstOfLabel = (key: string | number | string[]): string => (Array.isArray(key) ? key[0]! : String(key)[0]!)

function selectColumns(f: Frame, idx: number[]): Frame {
  return { columns: idx.map((i) => f.columns[i]!), multi: f.multi, data: idx.map((i) => f.data[i]!) }
}

/** A frame with plain string labels from the given level of its columns. */
function toTbl(f: Frame, level: 'last' | 'plain'): Tbl {
  const columns = f.columns.map((c) => (Array.isArray(c) ? (level === 'last' ? c.at(-1)! : c[0]!) : String(c)))
  const n = nrows(f)
  const rows: any[][] = []
  for (let r = 0; r < n; r++) rows.push(f.data.map((col) => col.values[r] ?? null))
  return { columns, rows }
}

/** `DataFrame.droplevel(0, axis=1)` */
const dropLevel0 = (f: Frame): Frame => ({ columns: f.columns.map((c) => (Array.isArray(c) ? c.slice(1).join('\0') : c)), multi: false, data: f.data })

async function downloadStatementFromUrl(fs: FinancialStatements, url: string, isEquity: boolean): Promise<[Tbl, Tbl]> {
  const tables = await fs.getDocumentTables(url)
  let df = tables[0]!
  if (df.columns.length < 2) throw new Error('index 1 is out of bounds for axis 0 with size 1')
  const isMultiIndex = df.columns.length === 5 || Array.isArray(df.columns[1])

  if (isMultiIndex && fs.documentType === '10-K' && df.columns.length === 5) df = selectColumns(df, [0, 2, 3, 4])

  const isAnnualMulti = df.columns.length === 4 && df.multi
  let df1: Frame = { columns: [], multi: false, data: [] }
  let df2: Frame | undefined
  if (isAnnualMulti) {
    fs._periodEnd1 = firstOfLabel(df.columns[1]!)
    df1 = dropLevel0(df)
  } else if (isMultiIndex) {
    if (df.columns.length === 5) {
      df1 = selectColumns(df, [0, 1, 2])
      fs._periodEnd1 = firstOfLabel(df1.columns[1]!)
      df2 = selectColumns(df, [0, 3, 4])
      fs._periodEnd2 = firstOfLabel(df2.columns[1]!)
    } else if (df.columns.length === 3) {
      fs._periodEnd1 = firstOfLabel(df.columns[1]!)
      df1 = dropLevel0(df)
    }
  } else {
    if (df.columns[0] === String(df.columns[1]).replaceAll('.1', '')) df = selectColumns(df, df.columns.map((_, i) => i).filter((i) => i !== 1))
    df1 = df
    fs._periodEnd1 = '12 Months Ended'
  }

  const processStatement = (statementFrame: Frame): [Tbl, Tbl] => {
    if (statementFrame.columns.length === 0) throw new Error('index 0 is out of bounds for axis 0 with size 0')
    let periodEnd: string | null =
      (fs._periodEnd2 && fs._periodEnd2.toLowerCase().endsWith('ended') ? fs._periodEnd2 : null) || (fs._periodEnd1 && fs._periodEnd1.toLowerCase().endsWith('ended') ? fs._periodEnd1 : null) || null

    let statement: Tbl
    if (statementFrame.multi) {
      periodEnd = firstOfLabel(statementFrame.columns[1]!)
      statement = toTbl(statementFrame, 'last')
    } else statement = toTbl(statementFrame, 'plain')

    const first = statement.columns[0]!
    const multiplierStr = first.includes('$ in ') ? first.split('$ in ').at(-1)! : ''
    const sharesMultiplierStr = first.toLowerCase().includes(' shares in ') ? first.split(' shares in ').at(-1)!.split(',')[0]! : ''
    const multiplier = multiplierStr ? multiplierMap(multiplierStr) : 1
    const sharesMultiplier = sharesMultiplierStr ? multiplierMap(sharesMultiplierStr) : 1

    const pattern = /\(in [a-zA-Z] per share\)|per\s+(?:common\s+)?share\b|weighted average number of/i
    const patternShares = /(shares authorized|shares issued|shares outstanding)$/i

    const cleanCol = (x: unknown): number | null => {
      if (String(pyStr(x)).startsWith('[')) return null
      const newStr = pyStr(x).replaceAll('(', '-').replaceAll(')', '').replaceAll(',', '').replaceAll('$', '').replaceAll(' ', '')
      return pyFloatOrNull(newStr)
    }

    statement = { columns: statement.columns, rows: statement.rows.filter((r) => !(typeof r[0] === 'string' && /^\[\d+\]/.test(r[0]))) }

    if (!isEquity) {
      // "--" is NaN. has_label is true for every row (an empty label is NaN, and NaN != ""), so no row is dropped.
      statement = { columns: statement.columns, rows: statement.rows.map((r) => r.map((c, i) => (i > 0 && c === '--' ? null : c))) }
    }

    const dateColMap = new Map<string, string>()
    if (!isEquity) {
      for (const col of statement.columns.slice(1)) {
        const parsed = formatDate(col)
        if (parsed) dateColMap.set(col, parsed)
      }
      if (dateColMap.size > 0) {
        const keep = [0, ...statement.columns.map((c, i) => (i > 0 && dateColMap.has(c) ? i : -1)).filter((i) => i > 0)]
        if (new Set(keep.map((i) => statement.columns[i])).size !== keep.length) throw new NativeUnsupported('a statement with repeated period columns')
        statement = { columns: keep.map((i) => statement.columns[i]!), rows: statement.rows.map((r) => keep.map((i) => r[i])) }
      }
    }

    for (let c = 1; c < statement.columns.length; c++) {
      for (const r of statement.rows) {
        const x = cleanCol(r[c])
        r[c] = x
      }
      for (const r of statement.rows) {
        const x = r[c] as number | null
        if (isNull(x)) {
          r[c] = '--'
          continue
        }
        const label = pyStr(r[0]).toLowerCase()
        const isPerShare = pattern.test(label) || label.includes('(in dollars per share)')
        const isShareCount = label.includes('(in shares)') || patternShares.test(label)
        if (isPerShare) r[c] = x
        else if (isShareCount) r[c] = Math.trunc(x! * sharesMultiplier)
        else r[c] = Math.trunc(x! * multiplier)
      }
    }

    const col1 = statement.columns[0]!.split(' $ in ')[0]!
    if (periodEnd) {
      if (!isEquity) statement = { columns: [col1, ...statement.columns.slice(1).map((d) => `${dateColMap.get(d) || formatDate(d)} -- ${periodEnd}`)], rows: statement.rows }
    } else if (!isEquity) {
      statement = { columns: [col1, ...statement.columns.slice(1).map((d) => String(dateColMap.get(d) || formatDate(d)))], rows: statement.rows }
    }

    // the definition tables after the statement: one row of facts per element
    let itemMap = emptyTbl()
    for (const table of tables.slice(1)) {
      const keys = table.data[0]!.values.map((v) => String(v ?? 'nan').replaceAll(':', ''))
      for (let c = 1; c < table.data.length; c++) {
        const row: Dict = {}
        keys.forEach((k, i) => {
          row[k] = table.data[c]!.values[i] ?? null
        })
        const next: Tbl = { columns: keys, rows: [keys.map((k) => row[k])] }
        itemMap = isEmptyTbl(itemMap) ? next : concatTbl(itemMap, next)
      }
    }

    const instance = fs._instance
    const tags = fs._tags
    const tagOf = (x: unknown): Dict => (typeof x === 'string' && x in tags ? tags[x] : {})
    const mapUnits = (x: unknown): string | null => {
      const ctx: Dict[] = (typeof x === 'string' && x in instance ? instance[x].context : undefined) ?? []
      if (ctx.length < 1) return null
      return ctx[0]!.unit || null
    }
    const mapDecimals = (x: unknown): string | null => {
      const ctx: Dict[] = (typeof x === 'string' && x in instance ? instance[x].context : undefined) ?? []
      if (ctx.length < 1) return null
      return ctx[0]!.decimals || null
    }
    const applyParentTag = (x: unknown): string | null => {
      const tag = tagOf(x)
      return tag.parentTag || tag.parent_tag || null
    }

    if (!isEquity) {
      const nameIdx = itemMap.columns.indexOf('Name')
      if (nameIdx < 0) throw new Error("'DataFrame' object has no attribute 'Name'")
      const add = (name: string, fn: (nameValue: unknown) => unknown): void => {
        itemMap.columns.push(name)
        for (const r of itemMap.rows) r.push(fn(r[nameIdx]))
      }
      add('weight', (x) => tagOf(x).weight ?? null)
      add('unit', mapUnits)
      add('decimals', mapDecimals)
      const bt = itemMap.columns.indexOf('Balance Type')
      if (bt < 0) throw new Error("'Balance Type'")
      for (const r of itemMap.rows) r[bt] = r[bt] === null || r[bt] === undefined ? null : r[bt] ? pyStr(r[bt]).replaceAll('na', '') : null
      add('name', (x) => tagOf(x).name ?? null)
      add('preferred_label', (x) => tagOf(x).preferred_label ?? null)
      add('parent_tag', applyParentTag)
      add('description', (x) => tagOf(x).documentation ?? null)
      for (const col of itemMap.columns.slice()) {
        const i = itemMap.columns.indexOf(col)
        if (col.startsWith('[')) {
          itemMap = { columns: itemMap.columns.filter((_, k) => k !== i), rows: itemMap.rows.map((r) => r.filter((_, k) => k !== i)) }
        } else {
          for (const r of itemMap.rows) r[i] = r[i] && !['na', 'n', 'nan'].includes(pyStrip(pyStr(r[i]))) ? r[i] : null
        }
      }
    }
    // item_map.dropna(): rows with any missing value go
    itemMap = { columns: itemMap.columns, rows: itemMap.rows.filter((r) => r.every((v) => !isNull(v))) }
    return [statement, itemMap]
  }

  if (df2 && !isEmpty(df2)) {
    let mergedDf = emptyTbl()
    let mergedMeta = emptyTbl()
    for (const data of [df1, df2]) {
      const [statement, itemMap] = processStatement(data)
      // set_index(label) then concat(axis=1): the two halves line up by row, and must have the same labels
      if (isEmptyTbl(mergedDf)) mergedDf = statement
      else {
        if (mergedDf.rows.length !== statement.rows.length || mergedDf.rows.some((r, i) => r[0] !== statement.rows[i]![0])) throw new NativeUnsupported('statement halves with different rows')
        mergedDf = { columns: [...mergedDf.columns, ...statement.columns.slice(1)], rows: mergedDf.rows.map((r, i) => [...r, ...statement.rows[i]!.slice(1)]) }
      }
      mergedMeta = isEmptyTbl(mergedMeta) ? itemMap : concatTbl(mergedMeta, itemMap)
    }
    return [mergedDf, mergedMeta]
  }
  return processStatement(df1)
}

/** `pandas.concat([a, b], axis=0)`: the union of the columns in order of appearance, gaps are missing. */
function concatTbl(a: Tbl, b: Tbl): Tbl {
  const columns = [...a.columns]
  for (const c of b.columns) if (!columns.includes(c)) columns.push(c)
  const place = (t: Tbl): any[][] =>
    t.rows.map((r) => {
      const out: any[] = columns.map(() => null)
      t.columns.forEach((c, i) => {
        out[columns.indexOf(c)] = r[i]
      })
      return out
    })
  return { columns, rows: [...place(a), ...place(b)] }
}

// ---------------------------------------------------------------------------------------------------------------
// the statement
// ---------------------------------------------------------------------------------------------------------------

const TRY_ORDER = ['totalLabel', 'negatedPeriodStartLabel', 'negatedPeriodEndLabel', 'periodStartLabel', 'periodEndLabel', 'negatedTerseLabel', 'terseLabel', 'negatedLabel', 'label', 'verboseLabel']
const STATEMENT_MAP: Record<string, string> = { balance: 'balance sheet', cash: 'cash flows', income: 'income', operations: 'operations', equity: 'equity', financial_conditions: 'financial condition' }
const MONTH_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 }

/** Python's `str.isdigit()` for text that may hold other number scripts. */
const isDigits = (s: string): boolean => s.length > 0 && /^[\p{Nd}²³¹]+$/u.test(s)

/** Compare two possibly-missing keys the way `sort_values` does: missing last, direction applies to the rest. */
function compareKey(a: unknown, b: unknown, ascending: boolean): number {
  const an = isNull(a)
  const bn = isNull(b)
  if (an || bn) return an && bn ? 0 : an ? 1 : -1
  const c = (a as any) < (b as any) ? -1 : (a as any) > (b as any) ? 1 : 0
  return ascending ? c : -c
}

function sortRows(rows: Dict[], keys: [string, boolean][]): Dict[] {
  return rows
    .map((row, i) => ({ row, i }))
    .sort((x, y) => {
      for (const [k, asc] of keys) {
        const c = compareKey(x.row[k], y.row[k], asc)
        if (c !== 0) return c
      }
      return x.i - y.i
    })
    .map((x) => x.row)
}

/** `fs.get_statement(statement)` as the rows of `data.to_dict("records")`. */
export async function downloadStatement(fs: FinancialStatements, statement: string): Promise<Row[]> {
  await fs.ensureXbrl()
  // For non-XBRL filings, use the HTML parsing method
  if (!fs.isXbrl) return parseNonXbrlStatement(fs, statement)

  const statementsInfo = fs.getStatementsInfo()
  const entries = Object.entries<Dict>(statementsInfo)
  let matched: [string, Dict][]
  if (statement === 'income') matched = entries.filter(([k]) => (k.toLowerCase().includes('operations') || k.toLowerCase().includes('income')) && !k.toLowerCase().includes('parenthetical'))
  else if (statement === 'balance') matched = entries.filter(([k]) => (k.toLowerCase().includes('balance') || k.toLowerCase().includes('condition')) && !k.toLowerCase().includes('parenthetical'))
  else {
    const searchTerm = STATEMENT_MAP[statement]
    matched = entries.filter(([k]) => searchTerm && k.toLowerCase().includes(searchTerm) && !k.toLowerCase().includes('parenthetical'))
  }
  if (matched.length === 0) {
    throw new Error(`No items found in the filing, cannot proceed with document type: ${fs.documentType} and statement: ${statement} -> ${fs.documentType} -> LazyDict(keys=[${Object.keys(statementsInfo).map((k) => `'${k}'`).join(', ')}])`)
  }
  const urls = matched.map(([, v]) => v.url).filter((u) => u)
  if (urls.length === 0) throw new Error(`No URLs found for statement: ${statement} -> matched: [${matched.map(([k]) => `'${k}'`).join(', ')}]`)

  let outputStatement = emptyTbl()
  let outputMeta = emptyTbl()
  let col1Name = ''
  try {
    for (const url of urls) {
      const [tableIn, itemMapIn] = await downloadStatementFromUrl(fs, url, statement === 'equity')
      let table = tableIn
      if (!isEmptyTbl(table)) {
        col1Name = col1Name || table.columns[0]!
        table = { columns: [col1Name, ...table.columns.slice(1)], rows: table.rows }
        outputStatement = !isEmptyTbl(outputStatement) ? concatTbl(outputStatement, table) : table
      }
      if (!isEmptyTbl(itemMapIn)) {
        // dropna(how="all", axis=1): columns that hold nothing go
        const keep = itemMapIn.columns.map((_, i) => i).filter((i) => itemMapIn.rows.some((r) => !isNull(r[i])))
        const itemMap: Tbl = { columns: keep.map((i) => itemMapIn.columns[i]!), rows: itemMapIn.rows.map((r) => keep.map((i) => r[i])) }
        outputMeta = isEmptyTbl(outputMeta) ? itemMap : concatTbl(outputMeta, itemMap)
      }
    }
  } catch (e) {
    if (e instanceof NativeUnsupported) throw e
    throw new Error(`Failed to download statement: ${e instanceof Error ? e.message : String(e)}`, { cause: e })
  }

  const statementCols = outputStatement.columns.slice()
  if (statement !== 'equity') {
    outputStatement = { columns: ['label', ...statementCols.slice(1)], rows: outputStatement.rows }
    if (!isEmptyTbl(outputMeta)) {
      const rename: Record<string, string> = { Name: 'tag', 'Namespace Prefix': 'taxonomy', 'Data Type': 'data_type', 'Balance Type': 'balance_type', 'Period Type': 'period_type' }
      outputMeta = { columns: outputMeta.columns.map((c) => rename[c] ?? c), rows: outputMeta.rows }
      const dt = outputMeta.columns.indexOf('data_type')
      if (dt >= 0) for (const r of outputMeta.rows) r[dt] = r[dt] && typeof pyStr(r[dt]) === 'string' ? pyStr(r[dt]).split(':').at(-1) : r[dt]
    }
  }

  const instanceDict: Dict = fs._instance
  const tags: Dict = fs._tags
  const metaCol = (name: string): number => outputMeta.columns.indexOf(name)
  const metaLookup = (tag: unknown, attr: string): { found: boolean; value: any } => {
    const t = metaCol('tag')
    const a = metaCol(attr)
    if (isEmptyTbl(outputMeta) || t < 0 || a < 0) return { found: false, value: null }
    const row = outputMeta.rows.find((r) => r[t] === tag)
    return row ? { found: true, value: row[a] } : { found: false, value: null }
  }
  const tagGet = (x: unknown): Dict => (typeof x === 'string' && Object.hasOwn(tags, x) ? tags[x] : {})
  const instanceContext = (x: unknown): Dict[] => (typeof x === 'string' && Object.hasOwn(instanceDict, x) ? (instanceDict[x].context ?? []) : [])

  const normalizeInstanceKey = (instanceKey: string): string => {
    if (Object.hasOwn(tags, instanceKey)) return instanceKey
    if (instanceKey.includes('_')) {
      const localName = instanceKey.split('_').slice(1).join('_')
      for (const tagKey of Object.keys(tags)) if (tagKey.includes('_') && tagKey.split('_').slice(1).join('_') === localName) return tagKey
    }
    return instanceKey
  }

  const valueToTags = new Map<number, string[]>()
  for (const [tagKey, data] of Object.entries<Dict>(instanceDict)) {
    const normalizedKey = normalizeInstanceKey(tagKey)
    for (const ctx of data.context ?? []) {
      const ctxValue = ctx.value ?? ''
      if (ctxValue && isDigits(String(ctxValue).replaceAll('-', '').replaceAll('.', ''))) {
        const n = pyFloatOrNull(String(ctxValue))
        if (n === null) continue
        const absVal = Math.abs(n)
        if (!valueToTags.has(absVal)) valueToTags.set(absVal, [])
        if (!valueToTags.get(absVal)!.includes(normalizedKey)) valueToTags.get(absVal)!.push(normalizedKey)
      }
    }
  }

  const normalizeLabel = (label: string): string => {
    const s = pyStrip(label).toLowerCase()
    for (const prefix of ['total ', 'net ']) if (s.startsWith(prefix)) return pyStrip(s.slice(prefix.length)).replace(/,+$/, '')
    for (const suffix of [', total', ',total', ', net', ',net']) if (s.endsWith(suffix)) return pyStrip(s.slice(0, -suffix.length))
    return s
  }

  const tagEntries = Object.entries<Dict>(tags)
  const applyLabel = (x: unknown): string | null => {
    const xText = x === null || x === undefined ? '' : pyStrip(pyStr(x))
    if (!xText || xText.toLowerCase() === 'nan') return null
    const xLower = xText.toLowerCase()
    for (const [key, value] of tagEntries) {
      for (const match of TRY_ORDER) {
        const tagLabel = value[match] ?? ''
        if (tagLabel && String(tagLabel).toLowerCase() === xLower) return key
      }
    }
    const xBase = normalizeLabel(xLower)
    if (xBase !== xLower) {
      for (const [key, value] of tagEntries) {
        for (const match of TRY_ORDER) {
          const tagLabel = value[match] ?? ''
          if (tagLabel && normalizeLabel(String(tagLabel).toLowerCase()) === xBase) return key
        }
      }
    }
    return null
  }

  if (statement === 'equity') {
    const columns = ['label', ...outputStatement.columns.slice(1), 'tag']
    const rows = outputStatement.rows.map((r) => [...r, applyLabel(r[0])])
    return rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, isNull(r[i]) ? null : r[i]]).filter(([, v]) => v !== null)) as Row)
  }

  // order, tag, label + the period columns, melted into one row per label and period
  const labelRows = outputStatement.rows.map((r, i) => ({ order: i + 1, label: r[0] as any, values: r.slice(1) as any[], tag: applyLabel(r[0]) as string | null }))
  const periodCols = outputStatement.columns.slice(1)
  let flat: Dict[] = []
  periodCols.forEach((period, c) => {
    for (const lr of labelRows) flat.push({ order: lr.order, tag: lr.tag, label: lr.label, period_ending: period, value: lr.values[c] })
  })

  const checkValues = (tag: unknown): number[] => {
    const value = instanceContext(tag)
    const result: number[] = []
    for (const v of value) {
      const raw = v.value ?? ''
      if (raw && isDigits(String(raw).replaceAll('-', '').replaceAll('.', '').replaceAll(',', ''))) {
        const n = pyFloatOrNull(String(raw))
        if (n !== null) result.push(Math.abs(n))
      }
    }
    return result
  }

  const cleanWords = (text: string): Set<string> => new Set(text.toLowerCase().replace(/[,;:()'"|]/g, ' ').split(/[\s]+/).filter((w) => w.length > 3))

  const applyFixTag = (row: Dict): void => {
    const label = row.label
    const rowValueRaw = row.value
    if (!rowValueRaw || rowValueRaw === '--') return
    const rowValue = Math.abs(typeof rowValueRaw === 'number' ? rowValueRaw : (pyFloatOrNull(String(rowValueRaw)) ?? NaN))
    const potential = checkValues(row.tag)
    if (potential.includes(rowValue)) return
    const matchingKeys = valueToTags.get(rowValue) ?? []
    if (matchingKeys.length === 0) return
    if (matchingKeys.length === 1) {
      row.tag = matchingKeys[0]
      return
    }
    const labelLower = String(label).toLowerCase()
    for (const key of matchingKeys) {
      if (key in tags) {
        for (const match of TRY_ORDER) {
          if (String(tags[key][match] ?? '').toLowerCase() === labelLower) {
            row.tag = key
            return
          }
        }
      }
    }
    const labelWords = cleanWords(String(label))
    for (const key of matchingKeys) {
      if (key in tags) {
        for (const match of TRY_ORDER) {
          const tagLabel = tags[key][match] ?? ''
          if (tagLabel) {
            const tagWords = cleanWords(String(tagLabel))
            if (labelWords.size > 0 && tagWords.size > 0 && [...labelWords].filter((w) => tagWords.has(w)).length >= 2) {
              row.tag = key
              return
            }
          }
        }
      }
    }
    for (const key of matchingKeys) {
      if (key in tags) {
        const localName = key.includes('_') ? key.split('_').slice(1).join('_') : key
        const tagNameWords = new Set((localName.match(/[A-Z][a-z]+/g) ?? []).filter((w) => w.length > 3).map((w) => w.toLowerCase()))
        const overlap = [...labelWords].filter((w) => tagNameWords.has(w)).length
        if (labelWords.size > 0 && tagNameWords.size > 0 && (overlap >= 2 || (overlap >= 1 && tagNameWords.size === 1))) {
          row.tag = key
          return
        }
      }
    }
    const tagsMatching = matchingKeys.filter((k) => k in tags)
    if (tagsMatching.length === 1) row.tag = tagsMatching[0]
  }
  for (const row of flat) applyFixTag(row)

  const getInstanceContext = (tagKey: unknown): Dict[] => {
    if (typeof tagKey !== 'string') return []
    if (Object.hasOwn(instanceDict, tagKey)) return instanceDict[tagKey].context ?? []
    if (tagKey.includes('_')) {
      const localName = tagKey.split('_').slice(1).join('_')
      for (const [instKey, instData] of Object.entries<Dict>(instanceDict)) if (instKey.includes('_') && instKey.split('_').slice(1).join('_') === localName) return instData.context ?? []
    }
    return []
  }

  const applyContextRef = (row: Dict): string | null => {
    const context = getInstanceContext(row.tag)
    const value = row.value
    if (context.length < 1) return null
    let expectedEnd: string | null = null
    let expectedMonths: number | null = null
    const periodLabel = String(row.period_ending ?? '')
    if (periodLabel) {
      expectedEnd = pyStrip(periodLabel.split(' -- ')[0]!)
      if (periodLabel.includes(' -- ')) {
        const suffix = pyStrip(periodLabel.split(' -- ').slice(1).join(' -- ')).toLowerCase()
        const monthMatch = /(\d+)\s*months?/.exec(suffix)
        if (monthMatch) expectedMonths = Number(monthMatch[1])
        else {
          for (const [word, months] of Object.entries(MONTH_WORDS)) {
            if (new RegExp(`\\b${word}\\s+months?\\b`).test(suffix)) {
              expectedMonths = months
              break
            }
          }
        }
      }
    }
    if (value && value !== '--') {
      for (const c of context) {
        if (!c) continue
        const con = c.context_ref ?? ''
        if (!con) continue
        const conEnd = c.end
        if (expectedEnd && conEnd) {
          let parsedEnd: string | null
          try {
            parsedEnd = fmtDate(parseDate(conEnd))
          } catch {
            parsedEnd = null
          }
          if (parsedEnd !== expectedEnd) continue
        }
        if (expectedMonths && c.start && c.end) {
          let parsedMonths: number | null
          try {
            const start = parseDate(c.start)
            const end = parseDate(c.end)
            parsedMonths = (end.y - start.y) * 12 + end.m - start.m + 1
          } catch {
            parsedMonths = null
          }
          if (parsedMonths !== expectedMonths) continue
        } else if (expectedMonths && c.end && !c.start) continue
        const val = c.value
        if (!val || val === '--') continue
        if (val && !String(val).includes('--')) {
          const a = pyFloatOrNull(String(val))
          const b = typeof value === 'number' ? value : pyFloatOrNull(String(value))
          if (a === null || b === null) continue
          if (Math.abs(a) === Math.abs(b)) return con
        }
      }
    }
    return null
  }
  for (const row of flat) row.context_ref = applyContextRef(row)

  const applyDimensionLabel = (row: Dict): any => {
    const contextRef = row.context_ref
    if (!contextRef || typeof contextRef !== 'string') return row.label
    const generic = new Set(['net sales and revenues', 'revenues', 'net sales and revenue', 'revenue', 'sales and revenues', 'sales'])
    if (!generic.has(String(row.label).toLowerCase())) return row.label
    const matches = [...contextRef.matchAll(/([a-z-]+)_([A-Za-z]+Member)/g)]
    if (matches.length === 0) return row.label
    for (const [, prefix, memberName] of matches) {
      const memberInfo = tagGet(`${prefix}_${memberName}`)
      const terse = memberInfo.terseLabel
      if (terse && String(terse).toLowerCase() !== String(row.label).toLowerCase()) return terse
    }
    return row.label
  }
  for (const row of flat) row.label = applyDimensionLabel(row)

  flat = sortRows(flat, [
    ['order', true],
    ['period_ending', false],
  ])

  const unitOf = (x: unknown): string | null => {
    if (!x || x === 'na' || x === 'n') return null
    const m = metaLookup(x, 'unit')
    if (m.found) return checkUnit(m.value)
    const instance = instanceContext(x)
    if (instance.length < 1) return null
    const unit = instance[0]!.unit
    return unit ? checkUnit(unit) : null
  }
  const checkUnit = (x: unknown): string | null => {
    if (!x || x === 'na' || x === 'n') return null
    const s = String(x)
    // Legacy unitRef ID format: 'unit_Standard_iso4217_USD', 'U_iso4217USD'
    if (s.toLowerCase().startsWith('unit') || s.toLowerCase().startsWith('u_')) {
      const parts = s.split('_')
      if (parts.length > 2) {
        if (parts[1]!.toLowerCase() === 'standard') return parts[2]!
        if (parts[1]!.toLowerCase() === 'divide') return `${parts[2]}per${pyTitle(parts[3] ?? '')}`
      }
      if (parts.length === 2 && (parts[1]!.length === 3 || ['shares', 'pure'].includes(parts[1]!))) return parts[1]!
    }
    // Resolved compound unit: 'iso4217:USD / shares'
    if (s.includes(' / ')) {
      const [num, ...rest] = s.split(' / ')
      const den = rest.join(' / ')
      const numClean = num!.includes(':') ? num!.split(':').at(-1)! : num!
      const denClean = den.includes(':') ? den.split(':').at(-1)! : den
      return `${numClean}Per${pyTitle(denClean)}`
    }
    if (s.includes(':')) return s.split(':').at(-1)!
    return s
  }
  const decimalsOf = (x: unknown): unknown => {
    const m = metaLookup(x, 'decimals')
    if (m.found) return m.value
    const instance = instanceContext(x)
    if (instance.length < 1) return null
    return instance[0]!.decimals || null
  }
  const parentTagOf = (x: unknown): unknown => {
    const t = tagGet(x)
    const parentTag = t.parentTag || t.parent_tag
    if (parentTag) return parentTag
    const m = metaLookup(x, 'parent_tag')
    if (m.found) return m.value
    return null
  }
  const balanceOf = (x: unknown): unknown => {
    const balance = tagGet(x).crdr
    if (balance) return balance
    const m = metaLookup(x, 'balance_type')
    if (m.found && m.value !== 'n' && m.value !== 'na') return m.value
    return null
  }
  const weightOf = (x: unknown): unknown => {
    const weight = tagGet(x).weight
    if (weight) return weight
    const m = metaLookup(x, 'weight')
    if (m.found) return m.value
    return null
  }
  const preferredOf = (x: unknown): unknown => {
    const preferred = tagGet(x).preferred_label
    if (preferred) return preferred
    const m = metaLookup(x, 'preferred_label')
    if (m.found) return m.value
    return null
  }
  for (const row of flat) {
    row.parent_tag = parentTagOf(row.tag)
    row.unit = unitOf(row.tag)
    row.decimals = decimalsOf(row.tag)
    row.balance = balanceOf(row.tag)
    row.weight = weightOf(row.tag)
    row.preferred_label = preferredOf(row.tag)
  }

  const periodContext: Dict = fs._periodContext
  const applyPeriodBeginning = (row: Dict): string | null => {
    const context = row.context_ref
    let periodStart: string | null | undefined = ''
    if (context && typeof context === 'string') {
      if (context.toLowerCase().startsWith('as_of')) return periodStart
      if (context.toLowerCase().startsWith('duration')) {
        const startDate = context.split('_').slice(1, 4).join('_').replaceAll('_', '-')
        return fmtDate(parseDate(startDate))
      }
      periodStart = Object.hasOwn(periodContext, context) ? periodContext[context].start : undefined
      if (!periodStart && (context.split('_').slice(0, 3).join('_').length === 23 || (context[2] === '_' && context.split('_').slice(0, 2).join('_').length === 12))) periodStart = context.split('_')[1]
      if (periodStart) return periodStart
    }
    const pe = row.period_ending as string
    if (row.value && row.value !== '--' && pe.includes(' -- ')) {
      const periodMonths = pe.split(' -- ').at(-1)![0]!
      const n = Number(periodMonths)
      if (!Number.isInteger(n)) throw new Error(`invalid literal for int() with base 10: '${periodMonths}'`)
      const end = parseDate(pe.split(' -- ')[0]!)
      return fmtDate(nextMonthBegin(monthEnd(subMonths(end, n))))
    }
    if (row.value && row.value !== '--' && pe && fs.documentType === '10-K') {
      return fmtDate(sameDayLastYearPlusOne(parseDate(pe.split(' -- ')[0]!)))
    }
    return null
  }
  for (const row of flat) row.period_beginning = applyPeriodBeginning(row)

  const applyFixPeriodEnd = (row: Dict): void => {
    const conRef = row.context_ref
    if (conRef && typeof conRef === 'string') {
      const contextData: Dict = Object.hasOwn(periodContext, conRef) ? periodContext[conRef] : {}
      const contextEnd = contextData.end
      const contextStart = contextData.start
      const contextPeriodType = contextData.period_type
      if (contextEnd) {
        try {
          const periodEnd = fmtDate(parseDate(contextEnd))
          if (contextPeriodType === 'duration' && contextStart && contextEnd) {
            const start = parseDate(contextStart)
            const end = parseDate(contextEnd)
            const nMonths = (end.y - start.y) * 12 + end.m - start.m + 1
            row.period_ending = `${periodEnd} -- ${nMonths} Months Ended`
          } else row.period_ending = periodEnd
        } catch {
          // contexts with dates that do not parse keep their label
        }
      }
    }
  }
  for (const row of flat) applyFixPeriodEnd(row)

  const periodEndLookup = new Map<string, string>()
  for (const row of flat) {
    const label = row.period_ending
    if (isNull(label)) continue
    const s = String(label)
    if (s.includes(' -- ')) {
      const date = s.split(' -- ')[0]!
      if (!periodEndLookup.has(date)) periodEndLookup.set(date, s)
    }
  }
  if (periodEndLookup.size > 0) {
    for (const row of flat) {
      const x = row.period_ending
      if (!isNull(x) && !String(x).includes(' -- ')) row.period_ending = periodEndLookup.get(String(x)) ?? String(x)
    }
  }

  flat = sortRows(flat, [
    ['order', true],
    ['period_ending', false],
    ['period_beginning', false],
  ])
  const seen = new Set<string>()
  flat = flat.filter((row) => {
    const key = JSON.stringify([row.tag ?? null, row.value ?? null, row.period_ending ?? null, row.period_beginning ?? null, row.context_ref ?? null])
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  flat = sortRows(flat, [
    ['order', true],
    ['period_ending', false],
    ['period_beginning', false],
  ])

  const formatValue = (x: unknown): unknown => {
    if (x === null || x === undefined || x === '--' || x === '') return null
    if (typeof x === 'number') return Number.isNaN(x) ? x : x
    const f = pyFloatOrNull(String(x))
    return f === null ? x : f
  }

  return flat.map((row) => {
    const out: Row = {}
    for (const k of ['order', 'tag', 'parent_tag', 'preferred_label', 'balance', 'weight', 'decimals', 'context_ref', 'period_beginning', 'period_ending', 'unit', 'label']) {
      const v = row[k]
      if (!isNull(v) && v !== '') out[k] = v
    }
    const v = formatValue(row.value)
    if (!isNull(v)) out.value = v
    return out
  })
}

/** `str.title()` of a word. */
function pyTitle(s: string): string {
  return s.replace(/[A-Za-z]+/g, (w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase())
}

void pyStrCell
