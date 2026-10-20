import { defineProvider } from '../types.js'
import { auctionResults } from './auction-results.js'
import { award } from './award.js'
import { awardSearch } from './award-search.js'
import { bulletin } from './bulletin.js'
import { dailyStatement } from './daily-statement.js'
import { debtToPenny } from './debt-to-penny.js'
import { recipientAwards } from './recipient-awards.js'
import { recipientSearch } from './recipient-search.js'
import { spendingExplorer } from './spending-explorer.js'
import { treasuryAuctions } from './treasury-auctions.js'
import { treasuryPrices } from './treasury-prices.js'
import { upcomingAuctions } from './upcoming-auctions.js'
import { weeklyBillOfferings } from './weekly-bill-offerings.js'

export default defineProvider({
  name: 'us_treasury',
  credentials: [],
  status: 'ported',
  routes: {
    'fixedincome/government/treasury_auctions': treasuryAuctions,
    'fixedincome/government/treasury_prices': treasuryPrices,
    'ustreasury/auction_results': auctionResults,
    'ustreasury/award': award,
    'ustreasury/award_search': awardSearch,
    'ustreasury/bulletin': bulletin,
    'ustreasury/daily_statement': dailyStatement,
    'ustreasury/debt_to_penny': debtToPenny,
    'ustreasury/recipient_awards': recipientAwards,
    'ustreasury/recipient_search': recipientSearch,
    'ustreasury/spending_explorer': spendingExplorer,
    'ustreasury/upcoming_auctions': upcomingAuctions,
    'ustreasury/weekly_bill_offerings': weeklyBillOfferings,
  },
})
