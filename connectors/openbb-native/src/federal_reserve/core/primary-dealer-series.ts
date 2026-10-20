// Series tables of the primary dealer statistics. Ported from openbb_federal_reserve/utils/primary_dealer_statistics.py (OpenBB Platform 5.0.0, Apache-2.0); modified: generated as TypeScript constants.

export const FAILS_SERIES_TO_TITLE: Record<string, string> = {
  'PDFTD-CS': 'FTD Corporate Securities',
  'PDFTR-CS': 'FTR Corporate Securities',
  PDFASCFDA: 'FTD Corporate Securities',
  PDFASCFRA: 'FTR Corporate Securities',
  'PDFTD-FGEM': 'FTD Agency and GSE Securities (Ex-MBS)',
  'PDFTR-FGEM': 'FTR Agency and GSE Securities (Ex-MBS)',
  PDFASFAFDA: 'FTD Agency and GSE Securities (Ex-MBS)',
  PDFASFAFRA: 'FTR Agency and GSE Securities (Ex-MBS)',
  'PDFTD-FGM': 'FTD Agency and GSE MBS',
  'PDFTR-FGM': 'FTR Agency and GSE MBS',
  'PDFTD-OM': 'FTD Other MBS',
  'PDFTR-OM': 'FTR Other MBS',
  PDFASMBFDA: 'FTD MBS',
  PDFASMBFRA: 'FTR MBS',
  'PDFTD-UST': 'FTD TIPS',
  'PDFTR-UST': 'FTR TIPS',
  'PDFTD-USTET': 'FTD Treasury Securities (Ex-TIPS)',
  'PDFTR-USTET': 'FTR Treasury Securities (Ex-TIPS)',
  PDFASUFRA: 'FTR Treasury Securities',
  PDFASUFDA: 'FTD Treasury Securities'
}

export const POSITION_SERIES_TO_FIELD: Record<string, Record<string, string>> = {
  dealer_position: {
    'PDPOSGS-B': 'bills',
    'PDPOSGSC-L2': 'coupons_lte_2_years',
    'PDPOSGSC-G2L3': 'coupons_gt_2_years_lt_3_years',
    'PDPOSGSC-G3L6': 'coupons_gt_3_years_lt_6_years',
    'PDPOSGSC-G6L7': 'coupons_gt_6_years_lt_7_years',
    'PDPOSGSC-G7L11': 'coupons_gt_7_years_lt_11_years',
    'PDPOSGSC-G11L21': 'coupons_gt_11_years_lt_21_years',
    'PDPOSGSC-G21': 'coupons_gt_21_years',
    'PDPOSTIPS-L2': 'tips_lt_2_years',
    'PDPOSTIPS-G2': 'tips_gt_2_years_lt_6_years',
    'PDPOSTIPS-G6L11': 'tips_gt_6_years_lt_11_years',
    'PDPOSTIPS-G11': 'tips_gt_11_years',
    'PDPOSGS-BFRN': 'floating_rate_notes',
    'PDPOSFGS-DN': 'discount_notes',
    'PDPOSFGS-C': 'coupons_agency',
    'PDPOSMBSFGS-TBA': 'mbs_agency_and_gse_tba',
    'PDPOSMBSFGS-OR': 'mbs_agency_and_gse_other_residential',
    'PDPOSMBSFGS-ST': 'mbs_agency_and_gse_specified_pools',
    'PDPOSMBSNA-R': 'mbs_non_agency_residential',
    'PDPOSMBSFGS-C': 'cmbs_agency_and_gse',
    'PDPOSMBSNA-O': 'cmbs_non_agency',
    'PDPOSSMGO-L13': 'municipal_lt_13_months',
    'PDPOSSMGO-G13': 'municipal_gt_13_months_lt_5_years',
    'PDPOSSMGO-G5L10': 'municipal_gt_5_years_lt_10_years',
    'PDPOSSMGO-G10': 'municipal_gt_10_years',
    PDPOSCSCP: 'commercial_paper',
    'PDPOSCSBND-L13': 'corporate_investment_grade_lt_13_months',
    'PDPOSCSBND-G13': 'corporate_investment_grade_gt_13_months_lt_5_years',
    'PDPOSCSBND-G5L10': 'corporate_investment_grade_gt_5_years_lt_10_years',
    'PDPOSCSBND-G10': 'corporate_investment_grade_gt_10_years',
    'PDPOSCSBND-BELL13': 'corporate_junk_lt_13_months',
    'PDPOSCSBND-BELG13': 'corporate_junk_gt_13_months_lt_5_years',
    'PDPOSCSBND-BELG5L10': 'corporate_junk_gt_5_years_lt_10_years',
    'PDPOSCSBND-BELG10': 'corporate_junk_gt_10_years',
    'PDPOSABS-ALB': 'abs_autos',
    'PDPOSABS-CCB': 'abs_credit_cards',
    'PDPOSABS-SLB': 'abs_student_loans',
    'PDPOSABS-OAB': 'abs_other'
  }
}

export const POSITION_GROUPS_TO_SERIES: Record<string, string[]> = {
  treasuries: [
    'PDPOSGS-B',
    'PDPOSGSC-L2',
    'PDPOSGSC-G2L3',
    'PDPOSGSC-G3L6',
    'PDPOSGSC-G6L7',
    'PDPOSGSC-G7L11',
    'PDPOSGSC-G11L21',
    'PDPOSGSC-G21',
    'PDPOSFGS-C',
    'PDPOSTIPS-L2',
    'PDPOSTIPS-G2',
    'PDPOSTIPS-G6L11',
    'PDPOSTIPS-G11',
    'PDPOSGS-BFRN',
    'PDPOSFGS-DN'
  ],
  bills: [
    'PDPOSGS-B'
  ],
  coupons: [
    'PDPOSGSC-L2',
    'PDPOSGSC-G2L3',
    'PDPOSGSC-G3L6',
    'PDPOSGSC-G6L7',
    'PDPOSGSC-G7L11',
    'PDPOSGSC-G11L21',
    'PDPOSGSC-G21'
  ],
  notes: [
    'PDPOSGS-BFRN',
    'PDPOSFGS-DN'
  ],
  tips: [
    'PDPOSTIPS-L2',
    'PDPOSTIPS-G2',
    'PDPOSTIPS-G6L11',
    'PDPOSTIPS-G11'
  ],
  mbs: [
    'PDPOSMBSFGS-TBA',
    'PDPOSMBSFGS-OR',
    'PDPOSMBSFGS-ST',
    'PDPOSMBSNA-R',
    'PDPOSMBSFGS-C',
    'PDPOSMBSNA-O'
  ],
  cmbs: [
    'PDPOSMBSFGS-C',
    'PDPOSMBSNA-O'
  ],
  municipal: [
    'PDPOSSMGO-L13',
    'PDPOSSMGO-G13',
    'PDPOSSMGO-G5L10',
    'PDPOSSMGO-G10'
  ],
  corporate: [
    'PDPOSCSCP',
    'PDPOSCSBND-L13',
    'PDPOSCSBND-G13',
    'PDPOSCSBND-G5L10',
    'PDPOSCSBND-G10',
    'PDPOSCSBND-BELL13',
    'PDPOSCSBND-BELG13',
    'PDPOSCSBND-BELG5L10',
    'PDPOSCSBND-BELG10'
  ],
  commercial_paper: [
    'PDPOSCSCP'
  ],
  corporate_ig: [
    'PDPOSCSBND-L13',
    'PDPOSCSBND-G13',
    'PDPOSCSBND-G5L10',
    'PDPOSCSBND-G10'
  ],
  corporate_junk: [
    'PDPOSCSBND-BELL13',
    'PDPOSCSBND-BELG13',
    'PDPOSCSBND-BELG5L10',
    'PDPOSCSBND-BELG10'
  ],
  abs: [
    'PDPOSABS-ALB',
    'PDPOSABS-CCB',
    'PDPOSABS-SLB',
    'PDPOSABS-OAB'
  ]
}
