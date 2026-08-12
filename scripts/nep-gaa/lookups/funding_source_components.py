"""
UACS funding source component lookups.

The hardcoded values for FUND_CLUSTERS, FINANCING_SOURCES, and AUTHORIZATIONS
come from the official UACS Manual (Fund Cluster codes 01-07) and match the
FY2026 reference data in bettergovph/open-budget-data.

IMPORTANT - known encoding mismatch:
  - The UACS reference data uses codes prefixed with the official cluster
    number (e.g. "01101101" = FC "01" + FS "1" + AUTH "01" + CAT "101").
  - The DBM NEP Excel exports (NEP-FY2026.xlsx, NEP-FY2027.xlsx) use a
    different prefix where every FUNDCD starts with "10" (e.g. "10101101"
    for the same logical entity "Specific Budgets of NGAs / General Fund /
    New General Appropriations").
  - Verified empirically: 100% of FUNDCD values in NEP-FY2026.xlsx and
    NEP-FY2027.xlsx start with "10". Both files use identical encodings.

This means the NEP FUNDCD[0:2] = "10" is the de-facto code for the
"Regular Agency Fund" cluster (which is "01" in UACS reference data). The
upstream open-budget-data pipeline ingested FY2026 NEP JSON exports that
had already been transformed to use the "01" prefix, so the existing
funding_sources.json in the repo uses "01xxxxxx" while our NEP source
files use "10xxxxxx".

To stay self-consistent within our NEP-FY2027 dataset:
  - We emit funding_sources.json with uacs_code = the raw FUNDCD verbatim
    (e.g. "10101101"), so the BudgetRecord.funding_uacs_code joins work.
  - We emit fund_categories.json likewise, so FundCategory -> FundingSource
    joins work.
  - The hardcoded lookup tables here are used to provide fund cluster /
    financing source / authorization code->description mappings for the
    NEP's "10xxxxxx" encoding (with "10" mapped to Regular Agency Fund).
"""

# NEP FUNDCD encoding: the first 2 digits are the fund cluster code.
# The DBM NEP Excel exports use "10" for the primary cluster (Regular
# Agency Fund) -- this is an NEP-export convention, not the official UACS
# code (which is "01"). Both encodings refer to the same logical fund.
FUND_CLUSTERS = {
    "10": "Regular Agency Fund (NEP encoding)",  # dominant in NEP exports
    "01": "Regular Agency Fund",                  # official UACS code
    "02": "Foreign Assisted Projects Fund",
    "03": "Special Account - Locally Funded/Domestic Grants Fund",
    "04": "Special Account - Foreign Assisted/Foreign Grants Fund",
    "05": "Internally Generated Funds",
    "06": "Business Related Funds",
    "07": "Trust Receipts",
}

FINANCING_SOURCES = {
    "1": "General Fund",
    "2": "Off - Budgetary Funds",
    "3": "Custodial Funds",
    # "4" appears in NEP FUNDCD position 2 (e.g. "10401102") but has no
    # description in the official UACS table. We mark it as unknown rather
    # than guess; inspection of the source descriptions suggests it groups
    # SAGF / retirement / trust-type funds but we cannot confirm.
    "4": "(NEP export - sub-category 4)",
}

AUTHORIZATIONS = {
    "01": "New General Appropriations",
    "02": "Continuing Appropriations",
    "03": "Supplemental Appropriations",
    "04": "Automatic Appropriations",
    "05": "Unprogrammed Appropriations",
    "06": "Retained Income/Funds",
    "07": "Revolving Funds",
    "08": "Trust Receipts",
}

# Reverse lookups (description -> code).
FUND_CLUSTER_BY_DESC = {v: k for k, v in FUND_CLUSTERS.items()}
FINANCING_BY_DESC = {v: k for k, v in FINANCING_SOURCES.items()}
AUTHORIZATION_BY_DESC = {v: k for k, v in AUTHORIZATIONS.items()}

# Authorization -> Financing Source mapping (parent reference), per UACS.
AUTHORIZATION_TO_FINANCING = {
    "01": "General Fund",
    "02": "General Fund",
    "03": "General Fund",
    "04": "General Fund",
    "05": "General Fund",
    "06": "Off - Budgetary Funds",
    "07": "Off - Budgetary Funds",
    "08": "Custodial Funds",
}


def parse_funding_code(fundcd: str) -> dict:
    """
    Parse an 8-digit FUNDCD into its four components with descriptions.

    Format: [FC(2)][FS(1)][AUTH(2)][CAT(3)]
    Example (NEP encoding): "10101101"
      fund_cluster:        code="10", description="Regular Agency Fund (NEP encoding)"
      financing_source:    code="1",  description="General Fund"
      authorization:       code="01", description="New General Appropriations"
      category_code:       "101"

    Returns a dict with all four components. Caller supplies the category
    description from the source row (UACS_FUNDSUBCAT_DSC).
    """
    code = str(fundcd).strip().zfill(8)
    if len(code) != 8 or code == "00000000":
        raise ValueError(f"Invalid funding code: {fundcd!r}")

    fc_code = code[0:2]
    fs_code = code[2:3]
    auth_code = code[3:5]
    cat_code = code[5:8]

    return {
        "uacs_code": code,
        "fund_cluster_code": fc_code,
        "fund_cluster": FUND_CLUSTERS.get(fc_code, f"(unknown cluster {fc_code})"),
        "financing_source_code": fs_code,
        "financing_source": FINANCING_SOURCES.get(fs_code, f"(unknown financing {fs_code})"),
        "authorization_code": auth_code,
        "authorization": AUTHORIZATIONS.get(auth_code, f"(unknown authorization {auth_code})"),
        "category_code": cat_code,
    }


def as_neo4j_records() -> dict:
    """
    Return the three lookup tables as lists of records matching sync.py's
    expected JSON shapes.
    """
    fund_clusters = [
        {"code": k, "description": v, "status": "Active"}
        for k, v in FUND_CLUSTERS.items()
    ]
    financing_sources = [
        {"code": k, "description": v, "status": "Active"}
        for k, v in FINANCING_SOURCES.items()
    ]
    authorizations = [
        {
            "code": k,
            "description": v,
            "financing_source": AUTHORIZATION_TO_FINANCING.get(k, ""),
            "status": "Active",
        }
        for k, v in AUTHORIZATIONS.items()
    ]
    return {
        "fund_clusters": fund_clusters,
        "financing_sources": financing_sources,
        "authorizations": authorizations,
    }

