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


def test_kashif_gets_two_more_tries(monkeypatch):
    """A dropped connection or a 5xx is tried again after a wait; a refusal isn't, and a third failure still raises."""
    import requests

    class Site:
        def __init__(self, *answers):
            self.answers, self.calls = list(answers), 0

        def get(self, *a, **k):
            self.calls += 1
            x = self.answers.pop(0)
            if isinstance(x, Exception):
                raise x
            r = requests.Response()
            r.status_code = x
            return r

    waits = []
    monkeypatch.setattr(shariah.time, "sleep", waits.append)
    drop = requests.ConnectionError("reset")
    site = Site(drop, 503, 200)
    assert shariah._get(site, {}).status_code == 200 and site.calls == 3 and waits == list(shariah.RETRY_WAITS)
    site = Site(403)
    assert shariah._get(site, {}).status_code == 403 and site.calls == 1
    with pytest.raises(requests.ConnectionError):
        shariah._get(Site(drop, drop, drop), {})


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


def test_a_late_github_run_goes_on_if_the_site_has_nothing_since_the_last_run_time(tmp_path):
    """GitHub's timer ran 7–8 hours late in Nov 2026: a run counts however late it starts, unless the site already has it."""
    import os
    import re
    import subprocess

    import yaml
    root = Path(__file__).parent.parent
    step = yaml.safe_load((root / ".github/workflows/site.yml").read_text(encoding="utf-8"))["jobs"]["when"]["steps"][0]["run"]
    script = re.sub(r"\$\{\{ github\.event_name \}\}", "schedule", step)
    script = re.sub(r"\$\{\{[^}]*\}\}", "x", script)
    (tmp_path / "date").write_text('#!/bin/sh\ncase "$1" in +%H%M) echo "$NOW";; *) echo 2026-11-04;; esac\n')
    (tmp_path / "curl").write_text('#!/bin/sh\n[ -n "$BUILT" ] || exit 22\necho "{\\"built\\": \\"$BUILT\\"}"\n')
    for f in ("date", "curl"):
        (tmp_path / f).chmod(0o755)

    def goes(now, built):
        out = tmp_path / "out"
        out.write_text("")
        subprocess.run(["bash", "-e", "-c", script], check=True, capture_output=True, env={
            **os.environ, "PATH": f"{tmp_path}:{os.environ['PATH']}", "GITHUB_OUTPUT": str(out), "NOW": now, "BUILT": built})
        return "go=true" in out.read_text()

    assert goes("1630", "2026-11-03T13:03:32")          # 12 seconds past the old window: the close still comes in
    assert goes("2211", "2026-11-04T14:05:00")          # very late, only a session scan so far
    assert not goes("1650", "2026-11-04T15:40:00")      # the close is already on the site
    assert goes("0935", "2026-11-03T15:40:00")          # the morning run
    assert not goes("1100", "2026-11-04T09:40:00")      # the morning run is in; the bot does the session
    assert goes("1100", "2026-11-03T15:40:00")          # it isn't: go on
    assert not goes("0830", "2026-11-03T15:40:00")      # the winter time of the 9:30 timer
    assert goes("1700", "")                             # the site didn't answer
