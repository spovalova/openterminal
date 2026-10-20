"""Regenerate src/fred/data.json from the openbb_fred package (OpenBB Platform 5.0.0, Apache-2.0).

    ~/.venvs/openbb/bin/python -I src/fred/generate-data.py

The FRED models keep their series catalogues as module constants (which series ids make up SOFR, a bond index, a
survey topic) and a few reference tables as files (the CPI series by country, the corporate spot rate series, the
retail price series by region). This reads them from the installed package so the TypeScript port carries exactly
OpenBB's lists, in OpenBB's order. Descriptions and widget metadata are not copied.
"""

import csv
import json
import sys
from pathlib import Path

from openbb_fred.models import (
    ameribor,
    bond_indices,
    commercial_paper,
    commodity_spot_prices,
    dwpcr_rates,
    ecb_interest_rates,
    fed_projections,
    ffrmc,
    manufacturing_outlook_ny,
    manufacturing_outlook_texas,
    mortgage_indices,
    non_farm_payrolls,
    personal_consumption_expenditures,
    retail_prices,
    senior_loan_officer_survey,
    sonia_rates,
    survey_of_economic_conditions_chicago,
    tbffr,
    tmc,
)
from openbb_fred.utils import fred_helpers

HERE = Path(__file__).parent
UTILS = Path(fred_helpers.__file__).parent


def read_csv(name: str) -> list[dict]:
    return fred_helpers.read_reference(name)


# The balance of payments series ids with the country code replaced by a marker.
bop = {k: v.replace("@@", "{c}") for k, v in fred_helpers.get_bop_series("@@").items()}

data = {
    "yieldCurves": fred_helpers.YIELD_CURVES,
    "cpiCountries": fred_helpers.CPI_COUNTRIES,
    # [country, frequency, units, series_id]
    "cpi": [[r["country"], r["frequency"], r["units"], r["series_id"]] for r in read_csv("cpi.csv")],
    "harmonizedCpi": [[r["country"], r["frequency"], r["units"], r["series_id"]] for r in read_csv("harmonized_cpi.csv")],
    "bopCountries": fred_helpers.BOP_COUNTRIES,
    "bopSeries": bop,
    # [maturity, category, series id]
    "spotRates": [[r["Maturity"], r["Category"], r["FRED Series ID"]] for r in read_csv("corporate_spot_rates.csv")],
    "retailSeries": {
        region: json.loads((UTILS / f"{file}.json").read_text())
        for region, file in retail_prices.regions_dict.items()
    },
    "retail": {
        "meats": retail_prices.PRICES_MEATS,
        "dairy": retail_prices.PRICES_DAIRY,
        "cereals": retail_prices.PRICES_CEREALS,
        "produce": retail_prices.PRICES_PRODUCE,
        "beverages": retail_prices.PRICES_BEVERAGES,
        "fuel": retail_prices.PRICES_FUEL,
        "allItems": retail_prices.ALL_ITEMS,
        "regionFiles": retail_prices.regions_dict,
    },
    "ameriborMaturityToId": ameribor.MATURITY_TO_FRED_ID,
    "dwpcr": dwpcr_rates.DWPCR_PARAMETER_TO_FRED_ID,
    "ecb": ecb_interest_rates.NAME_TO_ID_ECB,
    "soniaParameterToId": sonia_rates.SONIA_PARAMETER_TO_FRED_ID,
    "projections": fed_projections.NAME_TO_ID_PROJECTION,
    "selectedTreasuryConstantMaturity": ffrmc.FFRMC_PARAMETER_TO_FRED_ID,
    "selectedTreasuryBill": tbffr.TBFFR_PARAMETER_TO_FRED_ID,
    "treasuryConstantMaturity": tmc.TMC_PARAMETER_TO_FRED_ID,
    "baml": bond_indices.BAML_CATEGORIES,
    "mortgage": {
        "titles": mortgage_indices.MORTGAGE_ID_TO_TITLE,
        "groups": mortgage_indices.MORTGAGE_GROUPS,
        "choicesToId": mortgage_indices.MORTGAGE_CHOICES_TO_ID,
    },
    "commercialPaper": commercial_paper.CP_SERIES_IDS,
    "sloos": senior_loan_officer_survey.SLOOS_CATEGORIES,
    "chicago": survey_of_economic_conditions_chicago.ID_TO_FIELD,
    "nyOutlook": manufacturing_outlook_ny.NY_MANUFACTURING_OUTLOOK,
    "nyOutlookChoices": manufacturing_outlook_ny.NY_MANUFACTURING_OUTLOOK_CHOICES,
    "texasOutlook": manufacturing_outlook_texas.TEXAS_MANUFACTURING_OUTLOOK,
    "texasOutlookChoices": manufacturing_outlook_texas.TEXAS_MANUFACTURING_OUTLOOK_CHOICES,
    "commodity": commodity_spot_prices.SERIES_MAP,
    "pce": {
        "categoryToElement": personal_consumption_expenditures.PCE_CATEGORY_TO_EID,
        "categoryToUnits": personal_consumption_expenditures.PCE_CATEGORY_TO_UNITS,
        "personalIncomeUnits": personal_consumption_expenditures.PERSONAL_INCOME_UNITS,
        "personalIncomeLineToUnits": {str(k): v for k, v in personal_consumption_expenditures.PERSONAL_INCOME_LINE_TO_UNITS.items()},
    },
    "nfp": {"elements": non_farm_payrolls.EstablishmentData, "sectorOrder": non_farm_payrolls.NFP_SECTOR_ORDER},
}

(HERE / "data.json").write_text(json.dumps(data, separators=(",", ":"), ensure_ascii=False) + "\n")
print("wrote", (HERE / "data.json").stat().st_size, "bytes", file=sys.stderr)
