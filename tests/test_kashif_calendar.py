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


def test_a_scan_every_half_hour_during_the_session(tmp_path):
    """Sunday–Thursday 10:15–14:45 Cairo a run scans the live prices when the last scan is 25+ minutes old."""
    import json

    from egx_agent import db
    from egx_agent.scan import session_scan_due
    conn = db.connect(tmp_path / "egx.db")
    at = lambda d, h, m: datetime(2026, 10, d, h, m, tzinfo=CAIRO)  # noqa: E731  (4 Oct 2026 is a Sunday)
    assert session_scan_due(conn, at(4, 11, 0))                      # no scan yet
    db.set_meta(conn, "market", json.dumps({"finished": at(4, 10, 50).isoformat()}))
    assert not session_scan_due(conn, at(4, 11, 0))                  # 10 minutes ago
    assert session_scan_due(conn, at(4, 11, 20))                     # 30 minutes ago
    assert not session_scan_due(conn, at(4, 9, 50)) and not session_scan_due(conn, at(4, 15, 30))   # closed
    assert not session_scan_due(conn, at(9, 11, 20))                 # Friday
