// Constants of the OECD CPI route. Ported from openbb_oecd/models/consumer_price_index.py (OpenBB Platform 5.0.0, Apache-2.0).

/** COICOP code → the name callers use. */
export const EXPENDITURE_DICT_REV: Record<string, string> = {
  "_T": "total",
  "CP01": "food_non_alcoholic_beverages",
  "CP02": "alcoholic_beverages_tobacco_narcotics",
  "CP03": "clothing_footwear",
  "CP04": "housing_water_electricity_gas",
  "CP041": "actual_rentals",
  "CP042": "imputed_rentals",
  "CP043": "maintenance_repair_dwelling",
  "CP044": "water_supply_other_services",
  "CP045": "electricity_gas_other_fuels",
  "CP05": "furniture_household_equipment",
  "CP06": "health",
  "CP07": "transport",
  "CP0722": "fuels_lubricants_personal",
  "CP08": "communication",
  "CP09": "recreation_culture",
  "CP10": "education",
  "CP11": "restaurants_hotels",
  "CP12": "miscellaneous_goods_services",
  "CP045_0722": "energy",
  "GD": "goods",
  "CP041T043": "housing",
  "CP041T043X042": "housing_excluding_rentals",
  "_TXCP01_NRG": "all_non_food_non_energy",
  "SERVXCP041_042_0432": "services_less_housing",
  "SERVXCP041_0432": "services_less_house_excl_rentals",
  "SERV": "services",
  "_TXNRG_01_02": "overall_excl_energy_food_alcohol_tobacco",
  "CPRES": "residuals",
}

export const EXPENDITURE_CHOICES: string[] = ["actual_rentals", "alcoholic_beverages_tobacco_narcotics", "all_non_food_non_energy", "clothing_footwear", "communication", "education", "electricity_gas_other_fuels", "energy", "food_non_alcoholic_beverages", "fuels_lubricants_personal", "furniture_household_equipment", "goods", "health", "housing", "housing_excluding_rentals", "housing_water_electricity_gas", "imputed_rentals", "maintenance_repair_dwelling", "miscellaneous_goods_services", "overall_excl_energy_food_alcohol_tobacco", "recreation_culture", "residuals", "restaurants_hotels", "services", "services_less_house_excl_rentals", "services_less_housing", "total", "transport", "water_supply_other_services", "all"]

/** Sort order of the expenditure categories. */
export const EXPENDITURE_ORDER: Record<string, number> = {
  "_T": 0,
  "CP01": 1,
  "CP02": 2,
  "CP03": 3,
  "CP04": 4,
  "CP041": 5,
  "CP042": 6,
  "CP043": 7,
  "CP044": 8,
  "CP045": 9,
  "CP05": 10,
  "CP06": 11,
  "CP07": 12,
  "CP0722": 13,
  "CP08": 14,
  "CP09": 15,
  "CP10": 16,
  "CP11": 17,
  "CP12": 18,
  "CP045_0722": 19,
  "GD": 20,
  "CP041T043": 21,
  "CP041T043X042": 22,
  "_TXCP01_NRG": 23,
  "SERVXCP041_042_0432": 24,
  "SERVXCP041_0432": 25,
  "SERV": 26,
  "_TXNRG_01_02": 27,
  "CPRES": 28,
}

export const TRANSFORM_MAP: Record<string, string> = {"index": "_Z", "yoy": "GY", "period": "G1"}
export const FREQ_MAP: Record<string, string> = {"annual": "A", "quarter": "Q", "monthly": "M"}
export const UNIT_LABELS: Record<string, string> = {"index": "Index", "yoy": "Year-over-year (YOY) percent change", "period": "Period-over-period percent change"}
