"""
Hardcoded UACS sector outcomes.

Transcribed from scripts/uacs/mfo-pap/converter.py in
bettergovph/open-budget-data. These are 3-digit codes (100, 120, 140, ...)
representing Philippine government sector and sub-sector outcomes,
originally transcribed from a DBM UACS PDF.

sync.py loads these into SectorOutcome nodes keyed on `code`, and they
serve as the top-level grouping for budget analysis queries.
"""

SECTOR_OUTCOMES = {
    # General Public Services
    "100": {"type": "Sector", "description": "General public services"},
    "101": {"type": "Sub-Sector", "description": "Executive and legislative organs, financial and fiscal affairs, external affairs"},
    "102": {"type": "Sub-Sector", "description": "Foreign economic aid"},
    "103": {"type": "Sub-Sector", "description": "General services"},
    "104": {"type": "Sub-Sector", "description": "Basic research"},
    "105": {"type": "Sub-Sector", "description": "R&D General public services"},
    "106": {"type": "Sub-Sector", "description": "General public services n.e.c."},
    "107": {"type": "Sub-Sector", "description": "Public debt transactions"},
    "108": {"type": "Sub-Sector", "description": "Transfers of a general character between different levels of government"},
    "109": {"type": "Sub-Sector", "description": "Governance / Government Institutions and Regulatory Regime"},

    # Defense
    "120": {"type": "Sector", "description": "Defense"},
    "121": {"type": "Sub-Sector", "description": "Military Defense"},
    "122": {"type": "Sub-Sector", "description": "Civil Defense"},
    "123": {"type": "Sub-Sector", "description": "Foreign military aid"},
    "124": {"type": "Sub-Sector", "description": "R&D Defense"},
    "125": {"type": "Sub-Sector", "description": "Territorial integrity"},
    "126": {"type": "Sub-Sector", "description": "Defense against cybercrimes"},
    "127": {"type": "Sub-Sector", "description": "Defense n.e.c."},

    # Public Order and Safety
    "140": {"type": "Sector", "description": "Public order and safety"},
    "141": {"type": "Sub-Sector", "description": "Police services"},
    "142": {"type": "Sub-Sector", "description": "Fire-protection services"},
    "143": {"type": "Sub-Sector", "description": "Law courts"},
    "144": {"type": "Sub-Sector", "description": "Prisons"},
    "145": {"type": "Sub-Sector", "description": "R&D Public order and safety"},
    "146": {"type": "Sub-Sector", "description": "Public order and safety n.e.c."},

    # Economic Affairs
    "160": {"type": "Sector", "description": "Economic affairs"},
    "161": {"type": "Sub-Sector", "description": "General economic, commercial and labor affairs"},
    "162": {"type": "Sub-Sector", "description": "Agriculture, forestry, fishing and hunting"},
    "163": {"type": "Sub-Sector", "description": "Fuel and energy"},
    "164": {"type": "Sub-Sector", "description": "Mining, manufacturing and construction"},
    "165": {"type": "Sub-Sector", "description": "Transport"},
    "166": {"type": "Sub-Sector", "description": "Communication"},
    "167": {"type": "Sub-Sector", "description": "Other industries"},
    "168": {"type": "Sub-Sector", "description": "R&D Economic affairs"},
    "169": {"type": "Sub-Sector", "description": "Economic affairs n.e.c."},

    # Environmental Protection
    "180": {"type": "Sector", "description": "Environmental protection"},
    "181": {"type": "Sub-Sector", "description": "Waste management"},
    "182": {"type": "Sub-Sector", "description": "Waste water management"},
    "183": {"type": "Sub-Sector", "description": "Pollution abatement"},
    "184": {"type": "Sub-Sector", "description": "Protection of biodiversity and landscape"},
    "185": {"type": "Sub-Sector", "description": "R&D Environmental protection"},
    "186": {"type": "Sub-Sector", "description": "Environmental protection n.e.c."},

    # Housing and Community Amenities
    "200": {"type": "Sector", "description": "Housing and community amenities"},
    "201": {"type": "Sub-Sector", "description": "Housing development"},
    "202": {"type": "Sub-Sector", "description": "Community development"},
    "203": {"type": "Sub-Sector", "description": "Water supply"},
    "204": {"type": "Sub-Sector", "description": "Street lighting"},
    "205": {"type": "Sub-Sector", "description": "R&D Housing and community amenities"},
    "206": {"type": "Sub-Sector", "description": "Housing and community amenities n.e.c."},

    # Health
    "220": {"type": "Sector", "description": "Health"},
    "221": {"type": "Sub-Sector", "description": "Medical products, appliances and equipment"},
    "222": {"type": "Sub-Sector", "description": "Outpatient services"},
    "223": {"type": "Sub-Sector", "description": "Hospital services"},
    "224": {"type": "Sub-Sector", "description": "Public health services"},
    "225": {"type": "Sub-Sector", "description": "R&D Health"},
    "226": {"type": "Sub-Sector", "description": "Health insurance"},
    "227": {"type": "Sub-Sector", "description": "Health n.e.c."},

    # Recreation and Culture
    "240": {"type": "Sector", "description": "Recreation and culture"},
    "241": {"type": "Sub-Sector", "description": "Recreational and sporting services"},
    "242": {"type": "Sub-Sector", "description": "Cultural services"},
    "243": {"type": "Sub-Sector", "description": "Broadcasting and publishing services"},
    "244": {"type": "Sub-Sector", "description": "Other community services"},
    "245": {"type": "Sub-Sector", "description": "R&D Recreation and, culture"},
    "246": {"type": "Sub-Sector", "description": "Recreation and, culture n.e.c."},

    # Education
    "260": {"type": "Sector", "description": "Education"},
    "261": {"type": "Sub-Sector", "description": "Pre-primary and primary education"},
    "262": {"type": "Sub-Sector", "description": "Secondary education"},
    "263": {"type": "Sub-Sector", "description": "Post-secondary non-tertiary education"},
    "264": {"type": "Sub-Sector", "description": "Tertiary education"},
    "265": {"type": "Sub-Sector", "description": "Education not definable by level"},
    "266": {"type": "Sub-Sector", "description": "Subsidiary services to education"},
    "267": {"type": "Sub-Sector", "description": "R&D Education"},
    "268": {"type": "Sub-Sector", "description": "School Buildings"},
    "269": {"type": "Sub-Sector", "description": "Education n.e.c."},
    "270": {"type": "Sub-Sector", "description": "Pre-Primary, Primary, and Secondary Education"},

    # Social Protection
    "280": {"type": "Sector", "description": "Social protection"},
    "281": {"type": "Sub-Sector", "description": "Sickness and disability"},
    "282": {"type": "Sub-Sector", "description": "Old age"},
    "283": {"type": "Sub-Sector", "description": "Survivors"},
    "284": {"type": "Sub-Sector", "description": "Family and children"},
    "285": {"type": "Sub-Sector", "description": "Unemployment"},
    "286": {"type": "Sub-Sector", "description": "Housing"},
    "287": {"type": "Sub-Sector", "description": "Pantawid Pamilya Program or the Conditional Cash Transfer (CCT)"},
    "288": {"type": "Sub-Sector", "description": "Social exclusion n.e.c"},
    "289": {"type": "Sub-Sector", "description": "R&D Social protection"},
    "290": {"type": "Sub-Sector", "description": "Local membership to insurance"},
    "291": {"type": "Sub-Sector", "description": "Conflict-affected areas"},
    "292": {"type": "Sub-Sector", "description": "Social protection n.e.c."},
}

HORIZONTAL_PROGRAMS = {
    "00": "None",
    "01": "Disaster Related",
    "02": "Climate Change Mitigation",
    "03": "Climate Change Adaptation",
}


def as_neo4j_records() -> dict:
    """Return sector outcomes and horizontal programs as sync.py-ready records."""
    sector_list = [
        {"code": k, **v} for k, v in SECTOR_OUTCOMES.items()
    ]
    horizontal_list = [
        {"code": k, "description": v} for k, v in HORIZONTAL_PROGRAMS.items()
    ]
    return {
        "sector_outcomes": sector_list,
        "horizontal_programs": horizontal_list,
    }
