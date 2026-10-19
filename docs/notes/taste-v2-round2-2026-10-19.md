# Taste review, round 2: Open Terminal v2 after the fifteen changes

Graded by eye only, against the Instinct bar (`ss.png`): two rows of three chart widgets, each with a title and a one-line description; legend chips inside the plot; last-value badges on the axis; and a chat reply that cites widgets. I looked at every 1440x900 agent-built image (12 cases), every `accept-v2-*` image at both viewports, ten hand-built `accept-<case>` images at 1440 (plus 1920 where flagged), and the three production screenshots. Unless marked `prod-`, image names are under `docs/screenshots/`. Data correctness was not graded, except where the reply and a widget on the same screen show different numbers, because the user sees that.

## 1. Verdict

**6 / 10 against Instinct.** This round removed most of what looked like bugs:
- no portrait charts, no `spread_10y_2y` or `eps_history` in a legend, and no red "Not in any frame" line;
- chips sit at the ends of paragraphs, and stat cards are compact;
- the compare table and the macro calendar are now above the fold;
- CRWV's own candles, with news markers, are now the hero;
- the yield curve uses categorical tenors, and open interest is drawn as paired bars.

Several widgets would now pass at Instinct unchanged: the puts chain, the Mag 7 heatmap, the compact quote cards, the wide 10Y/2Y chart, the post-earnings reactions table and the backtest summary.

The screens still do not pass:
- **Layout.** Every layout is one 2/3 + 1/3 row followed by full-width rows. No screen puts three widgets side by side the way Instinct does. When the content runs out, so does the page: eight screens leave the bottom 300 px of a 900 px viewport empty.
- **Facts cards.** They no longer clip (two exceptions), but they now pin the hero number to the top and the fields to the bottom, with 70–180 px of nothing between them.
- **Comparison charts.** Five to seven badges stack into a solid coloured column. It hides every y tick, and each badge sits away from its own line.
- **A new regression.** Legend changes are now tinted with the series colour, and candle series use the up-candle green. The hero of "Why is CRWV down?" therefore reads `CRWV 61.39 -28.14%` in green.
- **Reply against widgets.** The reply is now the best-written thing on the screen, but in five cases it contradicts the widget beside it. In `morning` it says "AAPL is the only one down, at -0.2%" next to an AAPL card showing +0.04% in green, under a footer saying every figure was verified.

This is one point above the first critic's 5. The fixes landed as components, but the grid and the cards, which that critic said would move the score most, landed only partly. So the score for whole screens moved less than the score for individual widgets.

## 2. The first critic's fifteen changes

| # | Change | Landed | Evidence | Remaining problem |
|---|---|---|---|---|
| 1 | Packer: three columns, content-sized heights, no portrait charts, answer table above the stat row | Partly | Compare table above the fold (`taste-after-agent-neoclouds-1440`); calendar above the fold (`accept-v2-rates-week-1440`); SMA chart now landscape (`taste-after-agent-spy-backtest-1440`) | Every row is 2/3 + 1/3 or full width, never three across (all images). Short workspaces leave the bottom 300–330 px empty (`taste-after-agent-nvda-pe-1440/1920`, `accept-agent-cheap-tech-1440/1920`, `accept-agent-morning-1440/1920`, `accept-v2-cheap-tech-1440`, `accept-spy-backtest-1440`, `accept-amd-rsi-1440`, `accept-mag7-corr-1440`, `accept-morning-1440`). Narrow tables still get the full width: Pairs ranked uses 300 of 1,040 px (`accept-agent-mag7-corr-1440`); the reactions table uses 550 of 1,520 px (`taste-after-agent-tsla-earnings-1920`). The trades table is still below the fold at 1440 (`taste-after-agent-spy-backtest-1440`). |
| 2 | Compact stat card by default; no orphan cards; quote hero ≤ 32 px in a 3 × 2 grid | Partly | 2 × 2 "Today" cards (`accept-v2-neoclouds-1440`); Quotes as compact cards (`taste-after-agent-crwv-1920`); AMD quote hero about 24 px with a 3 × 2 grid (`accept-agent-amd-rsi-1440`) | Orphan cards remain: DIA alone on row 2 (`taste-after-agent-spx-1440`, `accept-v2-spx-last-week-1440`); APLD alone and centred (`taste-after-agent-neoclouds-1920`); AAPL dropped into the benchmark row (`accept-agent-morning`). The TSLA quote is still two columns wide, 690 × 240 and 1,010 × 300 (`accept-agent-tsla-puts-1440`, `accept-v2-tsla-puts-1920`). At 1920 the cards stretch to 130 px tall (`accept-agent-morning-1920`). |
| 3 | Facts card: one hero, body-size fields, no wrap, height from content | Partly | "P/E now" has one hero and a field grid, no clipping (`taste-after-agent-nvda-pe-1440`); Consensus shows "Buy" at body size (`accept-v2-tsla-earnings-1440`) | Height still comes from the row, not the content, so the hero sits at the top, the fields at the bottom and the middle is empty: P/E now 160 px (`taste-after-agent-nvda-pe-1920`), Screen count 180 px (`accept-agent-cheap-tech-1920`), 10s2s now 130 px (`accept-agent-curve-1920`), Implied move about 90 px (`accept-v2-tsla-earnings-1920`). Labels wrap ("Median next-day / move", "Large-cap tech / universe", "Median P/E of / passers"). Cards still clip at 1440: Street consensus cuts "Analysts 38 / Price 354.72" (`accept-tsla-earnings-1440`), and "Next report" cuts "Period ending" (`prod-rddt-investment-analysis`). In two-column cards at 1920, labels sit 300 px from their values (`accept-agent-amd-rsi-1920` Next earnings, `accept-agent-tsla-puts-1920` quote). |
| 4 | Multi-series: legend off the plot, seven-hue palette, badge collisions resolved, covered tick hidden | Partly | Legend above the plot and seven distinct hues (`accept-agent-mag7-corr-1440`); right-hand legend column (`accept-neoclouds-1440`); 71.86 / 71.08 now stack (`taste-after-agent-crwv-1440`) | Stacking 5–7 badges makes a solid coloured column that removes every y tick and pulls each badge off its line, with no leader line. TSLA gets no badge at all (`accept-agent-mag7-corr`, `accept-agent-cheap-tech`, `accept-mag7-corr`). Covered ticks are half hidden, not removed: 7,650 under 7,659.44, 80.00 under 71.86, 240.00 under 234.94, 60.00 under 61.39, 100.00 under 103.96. On rebased charts the legend shows the price and the badge shows the index (CRWV 61.39 in the legend, 71.86 on the badge). AMD's candle green and the SMA 200 teal are two greens on one chart. |
| 5 | Tables: content-width columns, numbers right-aligned in one format, cells vertically centred, display-name headers | Partly | Fundamentals table left-packed, mono and right-aligned (`accept-v2-neoclouds-1440`); trades headers fixed (`taste-after-agent-spy-backtest-1920`); screener (`accept-agent-cheap-tech-1920`) | Calendar tables use a sans font, left-align their numbers, mix `200.00K` with `200K`, show `-` for missing values, put dates under a "Time" header, and list "Core CPI" twice with no m/m or y/y (`accept-v2-rates-week`, `taste-after-agent-spx`). In news tables every Date reads "04:00", and the headline wraps at 1920 while 600 px sits empty to the right of Source (`accept-agent-amd-rsi-1920`, `taste-after-agent-crwv-1920`). At 1440 "Last week vs peers" drops "Last week %", the one column that answers the question (`taste-after-agent-crwv-1440`). `Is convertible` shows `false`/`true`. Duplicate tables: peers and Quotes repeat the same four closes (crwv), and rates-week at 1920 has two calendars. In the trades table, Exit date is in sans while Date is in mono. |
| 6 | Best/worst only where meaningful, as a 2 px bar instead of a fill | Partly | Fills replaced by 2 px bars (`accept-agent-cheap-tech`, `accept-v2-neoclouds`, `taste-after-agent-tsla-earnings`) | The bar sits at the cell's left edge. With right-aligned numbers that puts it 40–80 px from the digits and flush against the neighbouring column's number. The red bar for IREN 328.05 reads as NBIS 184.15's (`accept-v2-neoclouds-1440`, EV/EBITDA), and FIS's bar floats in the Name column (`accept-agent-cheap-tech-1440`). In 58 px rows the bar becomes a full-height rule that looks like a cell border (`accept-v2-tsla-earnings-1440`). The bars are still combined with red/green text. The "best" Fwd P/E is marked on 4.13 while 0.01 sits two rows above it. |
| 7 | Red/green restraint | Partly, with a regression | "Vs 52w high" is neutral (`accept-agent-cheap-tech-1920`); no red "(2 failed)" (`accept-v2-rates-week`); legend change tinted with the series colour (crwv peers chart) | Candle series take the up-candle green, so negative changes render green: `CRWV 61.39 -28.14%` on the hero (`taste-after-agent-crwv`), `^GSPC -1.36%` (`taste-after-agent-spx`), `TSLA -0.80%` (`accept-agent-tsla-puts`, `accept-v2-tsla-puts`), `RDDT -23.68%` (`prod-rddt-investment-analysis`). The IV change under the volatility hero is red (`-3.90%`), as if falling IV were a loss. |
| 8 | Muted verification footer; no red unverified list | Yes | "15 figures verified against the data" in muted text (`taste-after-agent-crwv`); no red list on any screen | The footer sits under replies whose numbers disagree with the widgets beside them: AAPL "-0.2%" against a +0.04% card (`accept-agent-morning`); RSI 41.2 against 40.09 and MACD 3.49 against 3.17 (`accept-agent-amd-rsi`); "40 of the 173" against a card showing 41 and 174 (`accept-agent-cheap-tech`); straddle $29.12 against 29.05 and stock $368.73 against 366.60 / 367.91 (`accept-agent-tsla-puts`). No dotted underline was visible anywhere to check. |
| 9 | Chips at the end of the paragraph, nothing after a chip, clear of the composer | Yes | `accept-v2-spx-last-week-1440` (no stranded full stop); `accept-agent-tsla-puts-1440` (footer clear of the composer) | Nothing material. |
| 10 | Reply: answer first, short, rounded, no system talk | Partly | "95M shares, against a 32M three-month average" (`taste-after-agent-crwv`); "If by 'next Friday' you meant Oct 30, I can pull that expiry instead." (`accept-v2-tsla-puts`) | A 9–12 line paragraph recites the table in prose in neoclouds (both runs), spx (both) and rates-week. ISO dates appear in prose ("2026-10-21", "the 2020-03-30 cross", "Wed 2026-10-21 at 08:30"). Percentages carry two decimals (47.72 %, 102.27 %, 43.93 %). Some system talk remains ("the earnings row puts the report on…", "from the first bar of the window", "I picked the basket myself"). |
| 11 | No raw identifiers | Partly | "10Y-2Y" (`accept-v2-rates-week`); "After the close", "Estimates" (`accept-agent-amd-rsi`); "Earnings" chip (`taste-after-agent-nvda-pe`) | `2 datasets` / `3 datasets` sits in the header of every overlay chart and makes the sub-header wrap in 340 px widgets (`accept-agent-tsla-puts` TSLA daily, `accept-morning`). Also remaining: `^GSPC` and `derived markers` (spx); `Is convertible`, and "12 bars" for bonds (crwv); `CRWV6083302` and `21873SAB4 · 350 bars` (`accept-crwv-1440`); `Settlement` (`prod-rddt-investment-analysis`). |
| 12 | Event markers anchored to the bar, unclipped, deduped, legend chip | Yes | N markers sit above the bars with stems (`taste-after-agent-crwv`); the first E is unclipped at x = 17 (`taste-after-agent-nvda-pe-1440`); "Earnings" / "News" chips | "E · Events" on an index is ambiguous, because E reads as earnings (spx). The future TSLA report appears to be marked on the last bar rather than on its date (`accept-agent-tsla-puts`, TSLA daily). |
| 13 | Axis legibility | Partly | 7,875…7,600 (spx); last tick 30Y fits (`accept-agent-curve-1920`); "Charts by TradingView" moved to the status bar | Ticks with no thousands separator: `1200.00` and `1000.00` (`prod-memory-rollover-check`, `prod-memory-trade`). Bare day numbers between month ticks: "Nov **3** 2026 Feb **3** Apr" (`accept-agent-curve`, `accept-agent-amd-rsi-1920`). Stray final ticks "6" and "2" (`taste-after-agent-spy-backtest-1920`, `accept-v2-tsla-earnings-1920`). Strike axis "340 355 372.50 390" mixes decimals. The bond chart's last tick is clipped to `1!` (`accept-crwv-1440`). |
| 14 | Three presets: OI bars, yield curve, last-week band (plus candle cap) | Partly | Paired OI and volume bars with an underlying rule (`accept-v2-tsla-puts`); dots on categorical tenors (`accept-agent-curve`); faint band with 1 px edges (`taste-after-agent-spx`) | Candle cap dropped: 20 candles still render at 35 px (1440) and 52 px (1920) as slabs. The OI chart's legend and badges show the last strike ("OI 19", "Volume 0"), the bars are 2 px wide, and one volume outlier sets the y scale. At 1440 the curve labels only 1M / 5Y / 30Y, so 2Y and 10Y, the two legs of the spread, are unmarked. |
| 15 | Shell chrome: 140 px tabs, drop "22 kinds" | Yes | Tabs about 140 px with full names (all images); status bar is clean | Production shows an "Untitled" tab and two "Memory stocks" tabs. Some tab titles repeat the ticker ("AMD · AMD: RSI and MACD", "CRWV · CRWV: why down"). The status bar reads "pre-market session pre-market". |

Tally: four yes, eleven partly (one of them a regression), none not attempted.

## 3. Per case

### Agent-built (`taste-after-agent-*`, `accept-agent-*`)

| Case | Score | Change first |
|---|---|---|
| crwv-why-down | 7 | The hero legend shows `-28.14%` in green on a "why is it down" screen; candle legends must not take the up-candle colour. Also merge "Last week vs peers" with Quotes: they repeat the same four closes, and at 1440 the peers table hides its "Last week %" column. |
| neoclouds | 6 | Reply paragraph 2 is an 11-line recital of the fundamentals table (1,027 %, 0.46, 4.03, 454 %, 3.13 %, 35x, 10.5x, -26.7 %, 21.65 %). Cut it to one takeaway plus the table chip. Show negative forward P/E as "n/m", not `-33.03`. |
| spx-last-week | 6 | The answer is "tech sell-off, XLK -7.7%", but Sectors is below the fold at 1440 and sorted best first, so XLK is the last row even at 1920. Put Sectors, worst first, in the slot beside the chart and move the CPI table down. Also fix the orphaned DIA card. |
| spy-backtest | 6 | Draw B/S markers on the equity curve (the hand-built version has them) and replace the 100 px-tall SMA chart, with its three stacked badges, with the Cross trades table, which is still below the fold at 1440. |
| tsla-earnings | 6 | The "TSLA volatility" card shows Prev close, Open, Day high, Volume and 52w high under "30-day IV and realized". Use the IV30 / HV30 / IV rank grid that `accept-agent-tsla-puts` already renders. |
| nvda-pe | 6 | Three widgets end at y = 560, leaving 300 px (1440) or 330 px (1920) of empty canvas. Let the P/E chart and Reported EPS run the full height, or add an EPS bar chart. "P/E now" at 1920 has a 160 px hole. |
| amd-rsi | 6 | The reply's headline numbers disagree with the cards beside it: RSI 41.2 against 40.09, MACD 3.49 against 3.17, histogram -14.75 against -15.01. Separately, the RSI pane is 50 px tall and the three badges 70 / 40.09 / 30 fill its whole axis. |
| cheap-tech | 5 | The screener is the answer and shows 15 of 41 rows, while the bottom 300 px of the canvas is empty. Let the table run to the bottom. The 340 × 130 "Largest cheap names" chart has six stacked badges and no y ticks; use a bar chart of 6-month change instead. |
| curve | 7 | Mark and label 2Y and 10Y on the curve (at 1440 only 1M / 5Y / 30Y are labelled). Those are the two legs of the spread the left chart plots. Also give the spread in bp throughout: the axis reads 0.20 %…0.80 % and the reply says "0.33 percentage points". |
| mag7-corr | 6 | Swap the slots. Pairs ranked is a 300 px table in a 1,040 px full-width slot, while the seven-line chart is squeezed into 340 × 90 with six badges and no ticks. The hand-built layout already puts Pairs on the right. Leave the 1.00 diagonal neutral, not the brightest cells on the map. |
| morning | 6 | The reply says "AAPL is the only one down, at -0.2%" beside an AAPL card showing +0.04% in green; TSLA 3.6 % vs 3.35 % and MU 3.2 % vs 2.66 % also disagree. Read the reply and the cards from one snapshot. Also: the Date column shows "04:00" in every news row, and "After the / close" wraps. |
| tsla-puts | 7 | Four TSLA prices on one screen: chain 367.91, quote 366.60, legend 366.60, reply $368.73. Drop the 690 × 240 quote widget (the chain header already carries the underlying) and give the space to the news or an OI-by-strike chart. |

### v2 prompts (`accept-v2-*`)

| Case | Score | Change first |
|---|---|---|
| cheap-tech | 5 | "Screen count" wraps "Large-cap tech / universe" and "Median P/E of / passers" beside 90 px of empty card. Make it a one-line strip in the table header ("36 of 160 · median 14.3x") and let the table use the height; 300 px is empty below. |
| neoclouds | 6 | The legend uses names (Applied Digital, CoreWeave, Nebius) while the table and cards use tickers (CRWV, NBIS, APLD). Pick tickers. The fundamentals bars are misread: the red bar beside NBIS 184.15 belongs to IREN 328.05. |
| rates-week | 6 | At 1920 there are two calendars, "This week's key releases" and "Full US calendar", listing the same events with different date formats, headers (When / Date), fonts and column order. Keep one: mono, right-aligned, Actual first, "200K" not "200.00K", "—" not "-". |
| spx-last-week | 6 | Sectors is sorted best first, so XLK -7.7 % (the reply's headline) is below the six visible rows. Sort worst first. Also fix the orphaned DIA card in the 2 + 1 Index ETFs row. |
| tsla-earnings | 6 | The reactions table stretches its rows to 58 px to fill a 480 px slot, so the 2 px best/worst bars become 58 px rules that read as cell borders. Use 28 px rows and end the widget where the table ends. |
| tsla-puts | 7 | "Put OI by strike" puts the last strike's values in the legend and on the badges ("OI 19", "Volume 0"), which means nothing on a by-strike chart. Drop the badges and put total OI in the legend. At 1920 the quote widget is 1,010 × 300, the second-largest thing on the screen. |

### Hand-built baseline (`accept-<case>`, ten looked at)

| Case | Score | Change first |
|---|---|---|
| crwv | 6 | The bond chart's series label is `CRWV6083302`, its sub-header reads `21873SAB4 · 350 bars`, and the last x tick is clipped to `1!`. Use "CRWV 9.25% 2030" for the label and drop "bars". |
| neoclouds | 6 | The right-hand legend column takes 170 px of a 1,040 px chart and holds five rows in 400 px of height. Put the legend above the plot in two rows and give the width back. |
| spx | 6 | `^GSPC -1.36%` shows in green. Otherwise the cleanest spx layout in the set: leaders and laggards on the right, sectors under the chart. |
| tsla-earnings | 5 | Street consensus clips its last row at 1440 ("Analysts 38 / Price 354.72"). The field order is also arbitrary (Symbol first, High and Low target in different columns). |
| nvda-pe | 4 | The widget titled "NVDA P/E (TTM), two years" still plots price (214.13 on a 100–260 axis) next to a second price chart. The agent run fixed this; the hand-built baseline did not. |
| spy-backtest | 5 | Three widgets and 300 px of empty canvas. Badges read `169.4x` / `159.8x` on an equity curve; drop the "x". The B/S trade markers are right and should be the default. |
| amd-rsi | 5 | One widget, then 300 px of nothing. Add the RSI / MACD readout cards from the agent run. |
| morning | 6 | News mixes "04:00" and "2026-10-18" in one Date column, and "TSM,MU" beside "GOOGL, ANET, AAPL +57". TSLA-into-the-report wraps its sub-header to two lines because of `2 datasets`. |
| mag7-corr | 6 | Six stacked badges with no ticks on the 90 px rebased chart; drop the badges above three series. The layout (Pairs on the right) is the one the agent run should copy. |
| tsla-puts | 6 | "TSLA volatility" still shows quote fields (Prev close … 52w high) under the IV hero, the same mislabel the first critic flagged. Put IV by strike, with its underlying rule, is a good chart. |

### Production (returning user)

| Screen | Score | Change first |
|---|---|---|
| prod-memory-rollover-check | 6 | "Upcoming earnings" is a v1 vertical card per symbol: only WDC is visible, with eight label-over-value fields. Render the v2 earnings table (Date · Symbol · Session · EPS est.). The 6-month compare is a 90 px plot with five stacked badges. |
| prod-rddt-investment-analysis | 6 | "Next report" clips its last row and dumps Symbol, Name and Period ending. "EPS vs estimates" has no estimate column and repeats `RDDT` in every row. The valuation table puts `Settlement 2026-09-30` (constant) and Name between Last and P/E. |
| prod-memory-trade | 5 | "Upcoming earnings" opens scrolled into the middle of the first card, so a headless "1.64 / After the close" fragment sits under the header. The MU axis reads `1000.00` and `1250.00`. The `2 datasets` label wraps the MU sub-header. |

## 4. Remaining changes, ranked (ten)

1. **Packer fills the page, puts three widgets in a row, and keeps narrow tables narrow.**
   - After placement, if the grid ends above the bottom of the viewport, grow the answer widget (the table, or the hero chart) to fill it. Never leave more than 40 px of empty canvas.
   - A widget whose content is less than one column wide (pairs, reactions, trades, day-by-day, quote, next earnings) gets one column, not two or three. The freed space puts three widgets in at least one row, as Instinct does.
   - A compare or oscillator chart never gets less than 160 px of plot height. Give it two columns or drop it.

   Affects nvda-pe, cheap-tech (agent, v2), morning, mag7-corr (agent, hand), spy-backtest (agent, hand), amd-rsi (hand), tsla-earnings 1920, spx 1920. **M.**
2. **Cards size to their content.**
   - Hero, then 8 px, then the fields; the card ends there and the spare row height goes to the neighbour.
   - Each label sits beside its value in a pair at most 180 px wide, never spread across the card.
   - Labels never wrap: shorten them to "Median move", "Universe", "Median P/E".
   - Nothing clips.
   - A card is never wider than one column.

   Affects nvda-pe, cheap-tech (both), curve, tsla-earnings (all three), tsla-puts (both), amd-rsi, morning 1920, spx ETFs 1920, prod RDDT. **M.**
3. **Badges: at most three per chart.**
   - Above three series, drop the axis badges and let the legend carry the last value, or put a label at the end of each line.
   - Never move a badge off its value without a leader line.
   - When a badge covers a tick, remove the tick completely; no half-hidden 7,650.
   - On rebased charts, the legend and the badge use the same units.
   - No badges on by-strike charts.

   Affects cheap-tech, mag7-corr, morning, crwv, neoclouds, spy-backtest, rates-week, amd-rsi, tsla-puts (both), all three prod screens. **M.**
4. **Candle-series legend colour.** Use a neutral or two-tone candle glyph, and colour the change by its sign (or leave it neutral), never by the up-candle colour. IV change under the volatility hero is neutral. Affects crwv (agent, hand), spx (all three), tsla-puts (all three), morning (hand), prod RDDT. **S.**
5. **One snapshot for the reply and the widgets.** The reply quotes the values the widgets show, or the widgets freeze at reply time, with an "as of" on the footer. A "verified" footer under contradicting numbers costs more trust than no footer. Affects morning, amd-rsi, tsla-puts, cheap-tech, tsla-earnings (v2), mag7-corr. **S–M.**
6. **Finish the tables.**
   - Calendar and news tables: mono, right-aligned numbers in one format; "—" for missing; Actual first; m/m or y/y on repeated releases; dates as "Wed Oct 21 08:30".
   - Drop constant columns (Date "04:00", Symbol `RDDT`, Topic "Stocks", Settlement).
   - The headline gets the width and the source is muted.
   - Never drop the answer column at narrow widths.
   - Merge duplicate tables: crwv peers with Quotes, and the two rates calendars.

   Affects rates-week, spx (all three), crwv, amd-rsi, morning, tsla-puts 1920, prod RDDT. **M.**
7. **Reply.**
   - At most three paragraphs; a paragraph that recites a table collapses to one sentence plus its chip.
   - Percentages to whole numbers above 10 (48 %, not 47.72 %); dates as "Oct 21" or "Wed 8:30".
   - No "row", "first bar of the window" or "I picked the basket myself".

   Affects neoclouds (both), spx (both), rates-week, cheap-tech (v2), spy-backtest, tsla-earnings (v2), morning, tsla-puts (v2). **S.**
8. **Remove the last internal strings.**
   - Remove `2 datasets` and `3 datasets` from widget headers.
   - Replace `^GSPC` with "S&P 500" and drop `derived markers`.
   - `Is convertible` becomes a "Conv." tick; drop "bars" on bonds.
   - Label bonds "CRWV 9.25% 2030", not `CRWV6083302` / `21873SAB4`.
   - Tab titles never repeat the ticker.
   - Never restore an "Untitled" tab.
   - Status bar reads "pre-market".

   Affects crwv, spx, tsla-puts, tsla-earnings, morning, curve, rates-week, prod. **S.**
9. **Best/worst on the number, not the cell edge.** Use a 2 px underline under the digits, or bold plus a tint. Keep rows at 28 px so the mark never becomes a rule. Skip columns where an outlier or a negative makes "best" meaningless (Fwd P/E 0.01, negative P/E, EV/EBITDA -90). Affects neoclouds (both, hand), cheap-tech (both), tsla-earnings (agent, v2). **S.**
10. **Chart detail pass.**
    - Candles: rather than capping the width and leaving space, widen the window when there are fewer than about 30 bars. For "last week", show two to three months with the week shaded. That fills the plot and answers better.
    - Oscillator panes at least 25 % of the chart height.
    - Thousands separators on every axis.
    - No bare day numbers between month ticks, and no stray final tick.
    - Mark 2Y and 10Y on the curve.
    - Neutral heatmap diagonal.

    Affects spx (all), amd-rsi, curve, rates-week, mag7-corr, spy-backtest, prod memory. **S–M.**

### The three that move the score most

1. **Packer fill and three in a row (1).** The empty bottom third, and the identical 2/3 + 1/3 rhythm, are the first things the eye reads on every short screen. They are the main visible difference from Instinct's two full rows of three.
2. **Cards sized to content (2).** The void between hero and fields shows up on almost every screen, and clipping still appears on two. Fixing it makes the cards look intentional and lets the packer use the freed height.
3. **Badges capped at three (3).** Every comparison chart, which is half the cases, currently ends in a solid coloured column with no y scale. Capping them gives those charts an axis back.

With these three the set would reach 7. Changes 4 and 5 are small and should ship regardless: one is a visible regression and the other is a trust problem. Tables, reply and strings (6–8) take it to about 8.
