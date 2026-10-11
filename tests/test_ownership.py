"""Free float from the owners lists (data/ownership.py): Mubasher's and Arab Finance's, 100% minus the big holders;
the site shows the lower one, TradingView's only without a list."""
import pytest

from egx_agent import db
from egx_agent.data import ownership

PAGE = """<h2>Ownership</h2><ul><li><span>Alpha Oryx Ltd</span> <span>(<b>21.521%</b>)</span></li>
<li><span>Saudi Egyptian Investment Co</span> <span>(<b>20.399%</b>)</span></li>
<li><span>Nasser Social Bank</span> <span>(<b>5.902%</b>)</span></li>
<li><span>Egyptian Chemical Industries</span> <span>(<b>2.695%</b>)</span></li></ul><h2>Management</h2><p>Board (1%)</p>"""
AF = """<h3>كبار المساهمين</h3><small>وفقًا لآخر إفصاح</small><div><b>Quantum Investment B. V</b><span>إجمالى عدد الأسهم</span>
<span>682,523,990</span><span>النسبة</span><span>48.75 %</span></div><div><b>RIMCO E G T INVESTMENT L L C</b>
<span>إجمالى عدد الأسهم</span><span>141,127,054</span><span>النسبة</span><span>10.08 %</span></div><script>x()</script>"""


class Page:
    def __init__(self, pages, refused=False):
        self.pages, self.asked, self.last, self.refused = pages, [], {}, refused

    def get(self, url, params=None, headers=None):
        if "arabfinance" in url:            # Arab Finance: AAA's list; it isn't counted in what Mubasher was asked
            return type("R", (), {"text": AF if params["key"] == "AAA" else "<p>none</p>", "status_code": 200})
        sym = url.split("/stocks/")[1].split("/")[0]
        self.asked.append(sym)

        status = 403 if self.refused else 500 if sym == "BAD" else 200

        def check():
            if status >= 400:
                raise OSError(status)
        return type("R", (), {"text": self.pages.get(sym, "<p>no list</p>"), "status_code": status,
                              "raise_for_status": staticmethod(check)})


def test_the_owners_list_gives_the_free_float_and_is_read_a_few_stocks_a_run(tmp_path):
    holders = ownership.parse(PAGE)
    assert holders == [("Alpha Oryx Ltd", 21.521), ("Saudi Egyptian Investment Co", 20.399),
                       ("Nasser Social Bank", 5.902), ("Egyptian Chemical Industries", 2.695)]   # not the board's
    assert ownership.free_float(holders) == round(1 - (21.521 + 20.399 + 5.902) / 100, 4)      # 2.7% is free
    assert ownership.free_float([]) is None and ownership.free_float([("A", 70.0), ("B", 40.0)]) is None
    assert ownership.free_float([("A", 2.0)]) is None                  # nobody big: a list that misses the owners
    assert ownership.parse_af(AF) == [("Quantum Investment B. V", 48.75), ("RIMCO E G T INVESTMENT L L C", 10.08)]
    conn = db.connect(tmp_path / "egx.db")
    f = Page({"AAA": PAGE})
    assert ownership.update(conn, ["AAA", "BBB", "CCC"], budget=2, f=f) == 2 and f.asked == ["AAA", "BBB"]
    assert ownership.update(conn, ["AAA", "BBB", "CCC"], budget=2, f=f) == 1 and f.asked[-1] == "CCC"  # the rest
    assert ownership.update(conn, ["AAA", "BBB", "CCC"], f=f) == 0                                     # fresh
    with pytest.raises(OSError):                           # refused: nothing is marked as read
        ownership.update(conn, ["DDD"], f=Page({}, refused=True))
    assert ownership.update(conn, ["BAD", "EEE"], f=f) == 2              # a page Mubasher can't show: the next one
    assert dict(conn.execute("SELECT symbol, free_float FROM ownership").fetchall()) == {
        "AAA": 0.5218, "BBB": None, "CCC": None, "BAD": None, "EEE": None}
    assert conn.execute("SELECT af_free_float FROM ownership WHERE symbol='AAA'").fetchone()[0] == 0.4117


def test_the_lower_owners_list_is_shown_and_tradingview_only_without_one():
    """Checked against 25 companies' own disclosures: a list mostly goes wrong by missing an owner (too high), so the
    lower one; TradingView's 100% means it doesn't know."""
    assert ownership.combined(0.34, 0.899, 0.412) == {"value": 0.412, "af": 0.412, "mub": 0.899, "tv": 0.34,
                                                     "differ": True}                       # Edita
    assert ownership.combined(1.0, 0.262, 0.257)["value"] == 0.257 and not ownership.combined(1.0, 0.262, 0.257)["differ"]
    assert ownership.combined(0.30, None, None)["value"] == 0.30                           # no list: TradingView's
    assert ownership.combined(1.0, None, None) is None and ownership.combined(None, None) is None
