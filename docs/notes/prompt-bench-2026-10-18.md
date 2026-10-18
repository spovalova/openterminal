# Prompt bench, 2026-10-18

Nine prompts chosen to show the agent off and to stress it, run once each against the production instance (`127.0.0.1:4242`, Opus 5.5, connectors openbb → yahoo → finnhub, OpenBB 5.0.0 running). Sunday, so every "today" is Friday 2026-10-16's session. Raw transcripts: `prompt-bench-2026-10-18.transcript.txt` next to this file. Rerun with `pnpm bench` (prompts in `scripts/prompts.json`); the workspaces it made are still in the sidebar as `test: <name>`.

Every number quoted in a reply was recomputed from the frames the agent received (first and last close per symbol, quote change, earnings rows). All of them matched. The verdicts below are about behaviour, not arithmetic.

## Scorecard

| # | Prompt | Verdict | Time to reply | Widgets | What happened |
|---|---|---|---|---|---|
| 1 | semis | **fail** (cosmetic) | 16.9 s | 5 | Right answer (AMD +89.9%, MU +93.1% vs SOXX +18.7%, SPY +7.5%; AVGO the drag; Friday's rout; next catalysts). The reply **starts with a leaked planning line**: "Tickers are known; skip search." |
| 2 | earnings-setup | **pass** | 17.0 s | 5 | Five of seven report in the window, all after the close, dates and EPS right; month-into-report moves per name; the news table was built but not cited. |
| 3 | aapl-today | **pass** | 19.5 s | 5 | Candles, AAPL vs QQQ rebased, quote with after-hours, news, next report. Separated the Apple-specific headline from the market-wide one. Fetched AAPL 5m twice (pair then alone), harmless. |
| 4 | storage | **pass** (with a data gap) | 18.0 s | 5 | Found SNDK, WDC, STX. Pure Storage: nasdaq search empty, yahoo search also returns nothing, PSTG quotes as unknown on both. The agent said so plainly instead of guessing. News skewed 16/20 to SNDK. |
| 5 | mag7 | **pass** | 18.8 s | 6 | "An intraday chart for each" is seven charts; the six-widget guideline made it pick one rebased chart of all seven plus candles for the two worst (META, TSLA) and explain the choice. Reasonable, and said out loud. |
| 6 | gold | **partial** | 24.9 s | 5 | Catalog has no `2y` range, so it showed 5y weekly plus 1y weekly and told the user. Answer itself is good (UUP at a 12-month high as the headwind). GLD news from nasdaq took 8.2 s. |
| 7 | nvda-week | **pass** | 16.7 s | 4 | Clean diagnosis: NVDA −5.4% Mon→Fri vs SOXX −9.4%, heaviest days named with volume, peers on Friday, news themes (OpenAI revenue miss, CoreWeave debt). Best reply of the set. |
| 8 | followups (3 turns) | **fail** on turn 3 | 13.9 / 13.9 / 18.4 s | 4 / 4 / 4 | Turns 1 and 2 did exactly what was asked (added names, switched to 1y normalized, calendar beside it). Turn 3, "drop the quotes, I only want the chart and the calendar", kept **four** widgets by adding two charts nobody asked for and said "a workspace needs at least four widgets". That is a prompt guideline; the tool schema allows one. |
| 9 | vague | **pass** | 20.2 s | 6 | Picked MU, SNDK, WDC, STX and SMH as the benchmark unprompted, answered the question with the one-month divergence (memory −10 to −22% vs SMH −3.7%) and framed it as a pullback after a huge run. |
| + | ad-hoc "Quote MU and SNDK, nothing else." | **fail** (cosmetic) | 6.5 s | 1 | Honoured "nothing else" with one widget, so the four-widget floor is not hard-wired. Reply again opens with a leaked planning line: "Try a single widget, honoring \"nothing else\"." |

Totals: 7 pass or partial, 3 fail; none crashed, timed out, or produced a frame error. 23 of 39 frames came from openbb; the rest were quote tables that fell back to yahoo because they included an ETF (SPY, QQQ, SOXX, GLD...), which is the designed behaviour.

## Prompts worth showing people

In order of how well they land, from this run:

1. "What happened to NVDA last week? Daily candles, the news by day, and tell me whether it was semis-wide (SOXX) or NVDA specific."
2. "I think memory is about to roll over. Am I right?" (shows the agent choosing symbols and a benchmark itself)
3. "Which of MU, SNDK, WDC, STX, NVDA, AAPL, MSFT report earnings in the next 3 weeks? For each one, show how the stock has traded into the report over the last month."
4. "AAPL today: 5 minute candles, the headlines that moved it, and how it did against QQQ."
5. The follow-up sequence (watchlist, then add names and switch the chart, then trim), stopping after turn 2 until finding 2 is fixed.

## Findings

1. **Leaked planning sentence at the top of the reply** (runs 1 and the ad-hoc one, 2 of 10). The model writes a one-line plan ("Tickers are known; skip search.") before the actual reply and it is streamed to the user. Fix in `packages/server/src/agent/prompt.ts`: say that the reply must begin with the answer and that any planning goes in tool calls, not text; or strip a leading line that precedes the first tool call when the step list is non-empty. Prompt fix first, it is cheaper.
2. **"Four to six widgets" treated as a floor against an explicit instruction** (run 8, turn 3). The prompt says four to six twice (`prompt.ts` lines 28 and 52, and the `set_workspace` description in `tools.ts`). Fix: "four to six unless the user asks for fewer; a request for one or two widgets wins". The ad-hoc run shows the model already can do this when the wording is strong.
3. **No `2y` range** (run 6). `RangeSchema` in `packages/core/src/kinds.ts` is `1d 5d 1mo 3mo 6mo 1y 5y`. Two years is a common ask for weekly charts. Adding it touches the yahoo and openbb range tables and their tests; the kinds catalog in PLAN.md section 7.1 should change in the same commit.
4. **Empty search is a final answer.** openbb's nasdaq search returned zero rows for "Pure Storage" and the registry did not try yahoo, because an empty frame is a success. Here yahoo had nothing either, so the outcome was right, but a connector with thin search coverage listed first would hide symbols another connector knows. Worth deciding in the registry: for `search`, an empty frame could fall through to the next connector.
5. **Multi-symbol news is dominated by one name** (run 4: 16 of 20 rows SNDK; run 9: 19 of 20 MU). The openbb news handler sorts newest-first across all symbols and then cuts to `limit`. A per-symbol share (round-robin by symbol, then by time) would give the table more spread. Same consideration for finnhub.
6. **Candle widget built but never cited** (runs 1, 2, 9): the agent adds a single-name candle chart as a sixth widget and the reply never draws on it. Known from Phase 2; still true.
7. **Latency**: 14 to 25 s to the first reply, dominated by model time (data steps are 0.3 to 4 s, except nasdaq news at up to 8 s). Follow-ups cost about the same as first prompts because the agent re-queries; cached frames come back in 4 ms when the query is identical.
8. **ETF quotes always fall back** because yfinance has no `last_price` for ETFs. Correct but it means any watchlist with SPY in it gets its quote table from yahoo; a per-symbol merge (openbb for stocks, yahoo for the ETF) would keep openbb first for the table. Low priority.

Nothing here changes the five-kind catalog or the contracts; findings 1 and 2 are prompt edits, 3 is a small catalog change, 4 and 5 are registry and connector policy.
