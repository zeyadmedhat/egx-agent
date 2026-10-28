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


def test_parse_kashif_cards():
    """Kashif's page since Oct 2026: a card a stock, no table (the old reader found 0 stocks)."""
    card = """<div class="stock-card"><h5 class="stock-card-title">شركة {sym}</h5><span class="stock-ticker">‎{sym}</span>
      <span class="status-badge">متوافق</span>
      <div class="stock-meta-row"><span class="meta-label">القطاع</span><span class="meta-value">بنوك</span></div>
      <div class="stock-meta-row"><span class="meta-label">نسبة التطهير</span><span class="meta-value purity-rate">{pct}</span></div>
      <div class="stock-meta-row"><span class="meta-label">درجة النقاء</span><div class="meta-value"><span class="badge">شرعي مختلط C</span></div></div>
      <div class="review-date"><span>تاريخ إصدار القوائم المالية:</span><strong>30/06/2026</strong></div></div>"""
    rows = shariah.parse_rows(card.format(sym="ETEL", pct="0.2٪") + card.format(sym="MISR", pct="-"))
    assert [r["symbol"] for r in rows] == ["ETEL", "MISR"]
    assert rows[0] == {"symbol": "ETEL", "name_ar": "شركة ETEL", "sector_ar": "بنوك", "kashif_label": "متوافق",
                       "purity": "شرعي مختلط C", "purification_pct": "0.20%", "statements_date": "30/06/2026"}
    assert rows[1]["purification_pct"] is None


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
