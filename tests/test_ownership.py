"""Free float's second source (data/ownership.py): Mubasher's owners list read, 100% minus the 5% holders, and how it
sits next to TradingView's."""
from egx_agent import db
from egx_agent.data import ownership

PAGE = """<h2>Ownership</h2><ul><li><span>Alpha Oryx Ltd</span> <span>(<b>21.521%</b>)</span></li>
<li><span>Saudi Egyptian Investment Co</span> <span>(<b>20.399%</b>)</span></li>
<li><span>Nasser Social Bank</span> <span>(<b>5.902%</b>)</span></li>
<li><span>Egyptian Chemical Industries</span> <span>(<b>2.695%</b>)</span></li></ul><h2>Management</h2><p>Board (1%)</p>"""


class Page:
    def __init__(self, pages):
        self.pages, self.asked, self.last = pages, [], {}

    def get(self, url):
        sym = url.split("/stocks/")[1].split("/")[0]
        self.asked.append(sym)
        return type("R", (), {"text": self.pages.get(sym, "<p>no list</p>")})


def test_the_owners_list_gives_the_free_float_and_is_read_a_few_stocks_a_run(tmp_path):
    holders = ownership.parse(PAGE)
    assert holders == [("Alpha Oryx Ltd", 21.521), ("Saudi Egyptian Investment Co", 20.399),
                       ("Nasser Social Bank", 5.902), ("Egyptian Chemical Industries", 2.695)]   # not the board's
    assert ownership.free_float(holders) == round(1 - (21.521 + 20.399 + 5.902) / 100, 4)      # 2.7% is free
    assert ownership.free_float([]) is None and ownership.free_float([("A", 70.0), ("B", 40.0)]) is None
    conn = db.connect(tmp_path / "egx.db")
    f = Page({"AAA": PAGE})
    assert ownership.update(conn, ["AAA", "BBB", "CCC"], budget=2, f=f) == 2 and f.asked == ["AAA", "BBB"]
    assert ownership.update(conn, ["AAA", "BBB", "CCC"], budget=2, f=f) == 1 and f.asked[-1] == "CCC"  # the rest
    assert ownership.update(conn, ["AAA", "BBB", "CCC"], f=f) == 0                                     # fresh
    assert dict(conn.execute("SELECT symbol, free_float FROM ownership").fetchall()) == {
        "AAA": 0.5218, "BBB": None, "CCC": None}


def test_one_number_when_the_sources_agree_both_when_they_dont():
    assert ownership.combined(0.22, 0.25) == {"value": 0.22, "tv": 0.22, "mub": 0.25}     # 3 points: TradingView's
    assert ownership.combined(None, 0.26) == {"value": 0.26, "tv": None, "mub": 0.26}
    assert ownership.combined(1.0, 0.26) == {"value": None, "tv": 1.0, "mub": 0.26}
    assert ownership.combined(None, None) is None
