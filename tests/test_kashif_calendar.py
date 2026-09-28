from datetime import date, datetime
from pathlib import Path

import pytest

from egx_agent.data import shariah
from egx_agent.scan import CAIRO, expected_session_date

FIXTURE = Path(__file__).parent / "fixtures" / "kashif_egx33_page1.html"


@pytest.mark.skipif(not FIXTURE.exists(), reason="the saved Kashif page is kept on the Mac only")
def test_parse_kashif_page():
    rows = shariah.parse_rows(FIXTURE.read_text(encoding="utf-8"))
    assert len(rows) == 20
    egas = next(r for r in rows if r["symbol"] == "EGAS")
    assert egas["name_ar"] and egas["sector_ar"] and "متوافق" in egas["kashif_label"]


def test_clean_symbol_strips_rtl_marks():
    assert shariah.clean_symbol("‎RAKT‎") == "RAKT"
    assert shariah.clean_symbol(" comi ") == "COMI"


def test_shariah_filter_modes():
    s = {"kashif_status": "compliant", "egx33": 0}
    assert shariah.passes_filter(s, "off") and shariah.passes_filter(s, "kashif") and shariah.passes_filter(s, "either")
    assert not shariah.passes_filter(s, "egx33") and not shariah.passes_filter(s, "both")


def test_expected_session_date():
    at = lambda *a: datetime(*a, tzinfo=CAIRO)  # noqa: E731
    assert expected_session_date(at(2026, 9, 27, 10, 0)) == date(2026, 9, 24)   # Sunday morning → Thursday
    assert expected_session_date(at(2026, 9, 27, 16, 0)) == date(2026, 9, 27)   # Sunday after close
    assert expected_session_date(at(2026, 9, 26, 12, 0)) == date(2026, 9, 24)   # Saturday → Thursday
