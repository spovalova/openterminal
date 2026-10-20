// usda/milk_cost_of_production tables. Ported from openbb_government_us/usda/utils/ers_milk_cost_of_production.py (OpenBB Platform 5.0.0, Apache-2.0); modified: generated as data.
// Generated from the Python constants (OpenBB Platform 5.0.0, Apache-2.0).

export const MILK_COST_FILES: Record<string, { media_id: number; slug: string; dimension: string }> = {
  by_state: {
    media_id: 5057,
    slug: 'by-state',
    dimension: 'state',
  },
  by_size_of_operation: {
    media_id: 5059,
    slug: 'by-size-of-operation',
    dimension: 'size_of_operation',
  },
}

export const STATE_CHOICES: Record<string, string> = {
  us_total: 'U.S. total',
  california: 'California',
  indiana: 'Indiana',
  iowa: 'Iowa',
  kentucky: 'Kentucky',
  michigan: 'Michigan',
  minnesota: 'Minnesota',
  new_york: 'New York',
  ohio: 'Ohio',
  pennsylvania: 'Pennsylvania',
  wisconsin: 'Wisconsin',
}

export const SIZE_CHOICES: Record<string, string> = {
  fewer_than_50_cows: 'Fewer than 50 cows',
  '50_99_cows': '50–99 cows',
  '100_199_cows': '100–199 cows',
  '200_499_cows': '200–499 cows',
  '500_999_cows': '500–999 cows',
  '1000_1999_cows': '1,000–1,999 cows',
  '2000_cows_or_more': '2,000 cows or more',
  all_sizes: 'All sizes',
}

export const CATEGORY_CHOICES: Record<string, string> = {
  gross_value_of_production: 'Gross value of production',
  operating_costs: 'Operating costs',
  allocated_overhead: 'Allocated overhead',
  costs_listed: 'Costs listed',
  net_value: 'Net value',
  supporting_information: 'Supporting information',
}

export const ITEM_CHOICES: Record<string, string> = {
  bedding_and_litter: 'Bedding and litter',
  capital_recovery_of_machinery_and_equipment: 'Capital recovery of machinery and equipment',
  cattle: 'Cattle',
  custom_services: 'Custom services',
  fuel_lube_and_electricity: 'Fuel, lube, and electricity',
  general_farm_overhead: 'General farm overhead',
  grazed_feed: 'Grazed feed',
  hired_labor: 'Hired labor',
  homegrown_harvested_feed: 'Homegrown harvested feed',
  interest_on_operating_capital: 'Interest on operating capital',
  marketing: 'Marketing',
  milk_cows: 'Milk cows',
  milk_sold: 'Milk sold',
  opportunity_cost_of_land: 'Opportunity cost of land',
  opportunity_cost_of_unpaid_labor: 'Opportunity cost of unpaid labor',
  other_income: 'Other income',
  other_operating_costs: 'Other, operating costs',
  output_per_cow: 'Output per cow',
  purchased_feed: 'Purchased feed',
  repairs: 'Repairs',
  taxes_and_insurance: 'Taxes and insurance',
  total_allocated_overhead: 'Total, allocated overhead',
  total_costs_listed: 'Total, costs listed',
  total_feed_costs: 'Total, feed costs',
  total_gross_value_of_production: 'Total, gross value of production',
  total_operating_costs: 'Total, operating costs',
  value_of_production_less_operating_costs: 'Value of production less operating costs',
  value_of_production_less_total_costs_listed: 'Value of production less total costs listed',
  veterinary_and_medicine: 'Veterinary and medicine',
}
