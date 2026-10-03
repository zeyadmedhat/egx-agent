"""EGX Trading Agent dashboard: a small web server (JSON API + the page in app/static).

On your Mac: double-click "Start Trading Agent.command", or run  .venv/bin/python -m app.server
On the website: .venv/bin/python -m app.server --server --domain NAME.duckdns.org   (behind Caddy, see deploy/)
"""
from __future__ import annotations

import argparse
import base64
import datetime as dt
import hashlib
import json
import math
import re
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import traceback
import zipfile
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

import pandas as pd
import uvicorn
import yaml
from fastapi import Body, Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask
from starlette.middleware.trustedhost import TrustedHostMiddleware

from egx_agent import config, corporate, db, levels, portfolio
from egx_agent.data import prices

from . import accounts, alerts, auth, jobs, schedule, views
from .accounts import LOCAL, Person

STATIC = Path(__file__).with_name("static")
APP_ID = "egx-trading-agent"
COOKIE = "egx_session"
KEEP_ON_RESET = ("capital", "paper_capital", "broker", "fee_pct_per_side",  # your own numbers and connections, not rules
                 "telegram_token", "telegram_chat_id", "telegram_only_action")
PUBLIC_API = {"/api/health", "/api/auth/login", "/api/auth/invite", "/api/auth/join", "/api/auth/reset"}
BEFORE_TERMS = {"/api/me", "/api/auth/accept-terms", "/api/auth/logout"}


class JSON(Response):
    media_type = "application/json"

    def render(self, content) -> bytes:
        return json.dumps(views.clean(content), ensure_ascii=False, separators=(",", ":"),
                          allow_nan=False).encode("utf-8")


def fail(status: int, message: str, **extra):
    raise HTTPException(status, detail={"message": message, **extra})


class BuyIn(BaseModel):
    symbol: str = Field(min_length=1, max_length=20)
    date: dt.date
    price: float = Field(gt=0)
    shares: int = Field(ge=1)
    stop: float | None = Field(default=None, ge=0)
    notes: str = Field(default="", max_length=500)
    fees_in: bool = False          # the price is your broker's average cost, fees already in it


class SellIn(BaseModel):
    trade_id: int
    date: dt.date
    price: float = Field(gt=0)
    shares: int = Field(ge=1)
    reason: str = Field(default="Other / my decision", max_length=100)


class BacktestIn(BaseModel):
    years: int = Field(default=3, ge=1, le=4)
    universe: Literal["all", "egx30", "egx33"] = "all"


class ScanIn(BaseModel):
    update_data: bool = True


class AdjustIn(BaseModel):
    event_id: int
    shares: int | None = Field(default=None, ge=1)
    ignore: bool = False


class DividendIn(BaseModel):
    date: dt.date
    amount: float = Field(gt=0)
    note: str = Field(default="", max_length=200)


class CheckIn(BaseModel):
    session: dt.date
    item: str = Field(min_length=1, max_length=60)
    done: bool


class TokenIn(BaseModel):
    token: str = Field(min_length=1, max_length=120)


class WatchlistIn(BaseModel):
    symbols: list[str] = Field(default_factory=list, max_length=200)


class AlertOptionsIn(BaseModel):
    only_action: bool


class ScheduleIn(BaseModel):
    on: bool


class LoginIn(BaseModel):
    username: str = Field(max_length=60)
    password: str = Field(max_length=200)


class JoinIn(BaseModel):
    code: str = Field(max_length=100)
    username: str = Field(max_length=60)
    display_name: str = Field(default="", max_length=60)
    password: str = Field(max_length=200)


class ResetIn(BaseModel):
    code: str = Field(max_length=100)
    password: str = Field(max_length=200)


class PasswordIn(BaseModel):
    old: str = Field(max_length=200)
    new: str = Field(max_length=200)


class InviteIn(BaseModel):
    note: str = Field(default="", max_length=60)


class DisableIn(BaseModel):
    disabled: bool


def _csp() -> str:
    """Only this site's own files may run; the two small inline scripts in index.html are allowed by their hash."""
    page = (STATIC / "index.html").read_text(encoding="utf-8")
    hashes = " ".join(f"'sha256-{base64.b64encode(hashlib.sha256(m.encode()).digest()).decode()}'"
                      for m in re.findall(r"<script(?:\s[^>]*)?>(.*?)</script>", page, flags=re.S) if m.strip())
    return ("default-src 'self'; script-src 'self' " + hashes + "; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; "
            "frame-src https://s.tradingview.com https://www.tradingview-widget.com; "
            "form-action 'self'; frame-ancestors 'none'")


def create_app(db_path: Path | str = config.DB_PATH, autoscan: bool = True, multi_user: bool = False,
               secure_cookies: bool | None = None, hosts: list[str] | None = None) -> FastAPI:
    """multi_user=False: the dashboard on your Mac (one person, no login). True: the website for invited friends."""
    site = accounts.Site(db_path, multi_user)
    secure = multi_user if secure_cookies is None else secure_cookies
    cache = views.Cache()
    runner = jobs.JobRunner(site, on_finish=cache.clear)
    throttle = auth.Throttle()
    stop = threading.Event()
    csp = _csp()

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        market = site.market()
        try:
            for _person, conn, cfg in site.each(market):
                portfolio.migrate_real_positions(conn, cfg)  # merges duplicate positions from old versions
        finally:
            market.close()
        if autoscan:
            threading.Thread(target=runner.autoscan_loop, args=(stop,), daemon=True, name="autoscan").start()
        yield
        stop.set()

    app = FastAPI(title="EGX Trading Agent", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None,
                  default_response_class=JSON)
    app.state.runner = runner
    app.state.site = site
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=["localhost", "127.0.0.1", "testserver", *(hosts or [])])

    def who(request: Request) -> Person | None:
        conn = site.market()
        try:
            row = auth.session_user(conn, request.cookies.get(COOKIE))
        finally:
            conn.close()
        return accounts.Person.from_row(row) if row is not None else None

    @app.middleware("http")
    async def guard(request: Request, call_next):
        path = request.url.path
        is_api = path.startswith("/api/")
        # Only the dashboard sends this header, so other websites open in your browser can't change your data.
        if is_api and request.method not in ("GET", "HEAD") and request.headers.get("x-egx-agent") != "1":
            return JSON({"detail": {"message": "Requests must come from the dashboard."}}, status_code=403)
        if multi_user and is_api and path not in PUBLIC_API:
            person = who(request)
            if person is None:
                return JSON({"detail": {"message": "Please log in.", "login": True}}, status_code=401)
            if not person.accepted_terms and path not in BEFORE_TERMS:
                return JSON({"detail": {"message": "Please read and accept the notice first.", "terms": True}},
                            status_code=403)
            request.state.person = person
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store" if is_api else "no-cache"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-Robots-Tag"] = "noindex, nofollow"
        response.headers["Content-Security-Policy"] = csp
        return response

    @app.exception_handler(Exception)
    async def crashed(_request: Request, exc: Exception):
        traceback.print_exc()
        return JSON({"detail": {"message": f"Something went wrong: {exc}"}}, status_code=500)

    # ------------------------------------------------------------ who is asking, and their data
    def get_person(request: Request) -> Person:
        if not multi_user:
            return LOCAL
        person = getattr(request.state, "person", None)
        if person is None:
            fail(401, "Please log in.", login=True)
        return person

    def require_admin(person: Person = Depends(get_person)) -> Person:
        if not person.is_admin:
            fail(403, "Only the admin can do this.")
        return person

    def only_website():
        if not multi_user:
            fail(404, "Not available in the Mac dashboard.")

    def get_conn(person: Person = Depends(get_person)):
        conn = site.connect(person)
        try:
            yield conn
        finally:
            conn.close()

    def get_market():
        conn = site.market()
        try:
            yield conn
        finally:
            conn.close()

    def get_data(conn=Depends(get_conn), person: Person = Depends(get_person)) -> views.Data:
        return views.Data(conn, site.cfg(conn), cache, is_admin=person.is_admin, multi_user=multi_user)

    def start_job(kind: str, label: str, fn, summary, owner: int | None = None) -> JSON:
        try:
            return JSON({"job": runner.start(kind, label, fn, summary, owner=owner)})
        except jobs.Busy as exc:
            fail(409, str(exc))

    def set_cookie(response: Response, token: str) -> Response:
        response.set_cookie(COOKIE, token, max_age=auth.SESSION_DAYS * 86400, httponly=True, secure=secure,
                            samesite="lax", path="/")
        return response

    def save_own(conn, person: Person, **values) -> None:
        """Your own settings: in config.yaml on your Mac, in your own file on the website."""
        if multi_user:
            db.save_personal_settings(conn, values)
        else:
            alerts.save(**values)

    # ------------------------------------------------------------ accounts and logging in
    @app.get("/api/health")
    def health():
        return JSON({"app": APP_ID, "version": 3, "multi_user": multi_user})

    @app.get("/api/me")
    def me(person: Person = Depends(get_person)):
        return JSON({"multi_user": multi_user, "user": person.public()})

    @app.post("/api/auth/login")
    def login(body: LoginIn, request: Request, market=Depends(get_market)):
        only_website()
        try:
            token, user_id = auth.login(market, body.username, body.password, throttle,
                                        request.client.host if request.client else "?")
        except auth.AuthError as exc:
            fail(401, str(exc))
        return set_cookie(JSON({"user": auth.public(auth.user_row(market, user_id))}), token)

    @app.post("/api/auth/logout")
    def logout(request: Request, market=Depends(get_market)):
        only_website()
        auth.end_session(market, request.cookies.get(COOKIE))
        response = JSON({"message": "Signed out."})
        response.delete_cookie(COOKIE, path="/")
        return response

    @app.post("/api/auth/logout-all")
    def logout_all(person: Person = Depends(get_person), market=Depends(get_market)):
        only_website()
        auth.end_all_sessions(market, person.id)
        response = JSON({"message": "Signed out on every device."})
        response.delete_cookie(COOKIE, path="/")
        return response

    @app.get("/api/auth/invite")
    def invite_check(code: str, market=Depends(get_market)):
        only_website()
        info = auth.invite_info(market, code)
        if info is None:
            fail(404, "This link has expired or was already used. Ask for a new one.")
        return JSON(info)

    @app.post("/api/auth/join")
    def join(body: JoinIn, market=Depends(get_market)):
        only_website()
        try:
            user_id = auth.accept_invite(market, body.code, body.username, body.display_name, body.password)
        except auth.AuthError as exc:
            fail(400, str(exc))
        row = auth.user_row(market, user_id)
        site.connect(Person.from_row(row)).close()   # creates their own data file
        return set_cookie(JSON({"user": auth.public(row)}), auth.new_session(market, user_id))

    @app.post("/api/auth/reset")
    def reset_password(body: ResetIn, market=Depends(get_market)):
        only_website()
        try:
            user_id = auth.accept_reset(market, body.code, body.password)
        except auth.AuthError as exc:
            fail(400, str(exc))
        return set_cookie(JSON({"user": auth.public(auth.user_row(market, user_id))}),
                          auth.new_session(market, user_id))

    @app.post("/api/auth/password")
    def change_password(body: PasswordIn, person: Person = Depends(get_person), market=Depends(get_market)):
        only_website()
        try:
            auth.change_password(market, person.id, body.old, body.new)
        except auth.AuthError as exc:
            fail(400, str(exc))
        auth.end_all_sessions(market, person.id)   # other devices sign in again with the new password
        return set_cookie(JSON({"message": "Password changed. Other devices were signed out."}),
                          auth.new_session(market, person.id))

    @app.post("/api/auth/accept-terms")
    def accept_terms(person: Person = Depends(get_person), market=Depends(get_market)):
        only_website()
        auth.accept_terms(market, person.id)
        return JSON({"ok": True})

    # ------------------------------------------------------------ admin (website only)
    @app.get("/api/admin")
    def admin_page(request: Request, _admin: Person = Depends(require_admin), market=Depends(get_market)):
        only_website()
        return JSON({"people": auth.people(market), "invites": auth.pending_invites(market),
                     "site": str(request.base_url).rstrip("/")})

    @app.post("/api/admin/invites")
    def admin_invite(body: InviteIn, request: Request, admin: Person = Depends(require_admin),
                     market=Depends(get_market)):
        only_website()
        code = auth.create_invite(market, admin.id, "invite", note=body.note)
        return JSON({"link": f"{str(request.base_url).rstrip('/')}/#/join?code={code}", "days": auth.INVITE_DAYS,
                     "message": f"Invite link ready. It works once, within {auth.INVITE_DAYS} days."})

    @app.delete("/api/admin/invites/{invite_id}")
    def admin_invite_delete(invite_id: int, _admin: Person = Depends(require_admin), market=Depends(get_market)):
        only_website()
        auth.delete_invite(market, invite_id)
        return JSON({"message": "Invite link cancelled."})

    @app.post("/api/admin/users/{user_id}/reset")
    def admin_reset_link(user_id: int, request: Request, admin: Person = Depends(require_admin),
                         market=Depends(get_market)):
        only_website()
        row = auth.user_row(market, user_id)
        if row is None or row["pw_hash"] == auth.NO_PASSWORD:
            fail(404, "No such person.")
        code = auth.create_invite(market, admin.id, "reset", user_id, note=f"reset for {row['username']}", days=3)
        return JSON({"link": f"{str(request.base_url).rstrip('/')}/#/reset?code={code}",
                     "message": f"Password reset link for {row['display_name']}. It works once, within 3 days."})

    @app.post("/api/admin/users/{user_id}/disable")
    def admin_disable(user_id: int, body: DisableIn, admin: Person = Depends(require_admin),
                      market=Depends(get_market)):
        only_website()
        row = auth.user_row(market, user_id)
        if row is None:
            fail(404, "No such person.")
        if user_id == admin.id:
            fail(400, "You can't switch off your own account.")
        auth.set_disabled(market, user_id, body.disabled)
        return JSON({"message": f"{row['display_name']} can {'no longer' if body.disabled else 'again'} log in."})

    @app.get("/api/admin/backup")
    def admin_backup(_admin: Person = Depends(require_admin)):
        only_website()
        tmp = Path(tempfile.mkdtemp(prefix="egx-backup-"))
        stamp = dt.datetime.now().strftime("%Y%m%d-%H%M")
        out = tmp / f"egx-backup-{stamp}.zip"
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
            for src in [site.market_path, *sorted(site.users_dir.glob("*.db"))]:
                copy = tmp / src.name
                a, b = sqlite3.connect(src), sqlite3.connect(copy)
                try:
                    a.backup(b)
                finally:
                    a.close()
                    b.close()
                z.write(copy, str(src.relative_to(site.market_path.parent)))
            cfg = {k: v for k, v in config.load_config().items() if k != "telegram_token"}   # no secrets
            z.writestr("config.yaml", yaml.safe_dump(cfg, sort_keys=False, allow_unicode=True))
        return FileResponse(out, filename=out.name, media_type="application/zip",
                            background=BackgroundTask(shutil.rmtree, tmp, ignore_errors=True))

    # ------------------------------------------------------------ reading
    @app.get("/api/status")
    def status(d: views.Data = Depends(get_data), person: Person = Depends(get_person)):
        return JSON({**views.status(d), "job": runner.status(person)})

    @app.get("/api/stocks")
    def stocks(d: views.Data = Depends(get_data)):
        return JSON(views.stocks_list(d))

    @app.get("/api/today")
    def today(d: views.Data = Depends(get_data)):
        return JSON(views.today(d))

    @app.get("/api/stock/{symbol}")
    def stock(symbol: str, d: views.Data = Depends(get_data)):
        return JSON(views.stock_detail(d, symbol))

    @app.get("/api/stock/{symbol}/intraday")
    def stock_intraday(symbol: str, d: views.Data = Depends(get_data)):
        try:        # a stock opened before the next scan downloads its hourly bars: fetch them now
            prices.refresh_intraday(d.conn, symbol.upper(), aliases=d.cfg.get("symbol_aliases"))
        except Exception:  # offline or TradingView busy: the chart shows what's stored
            pass
        return JSON(views.stock_intraday(d, symbol))

    @app.get("/api/quotes")
    def quotes(s: str = "", d: views.Data = Depends(get_data)):
        """Live prices for the page's positions (prices.live_quotes, about 15 minutes late): {} when offline."""
        syms = [x for x in dict.fromkeys(s.upper().split(",")) if re.fullmatch(r"[A-Z0-9]{1,12}", x)][:40]
        try:
            return JSON(prices.live_quotes(syms, d.cfg.get("symbol_aliases")))
        except Exception:
            return JSON({})

    @app.get("/api/watchlist")
    def watchlist(d: views.Data = Depends(get_data)):
        return JSON({"symbols": views.watchlist(d)})

    @app.put("/api/watchlist")
    def watchlist_save(body: WatchlistIn, d: views.Data = Depends(get_data)):
        return JSON(views.save_watchlist(d, body.symbols))

    @app.get("/api/dividends")
    def dividends_page(d: views.Data = Depends(get_data)):
        return JSON(views.dividends_view(d))

    @app.get("/api/news")
    def news_page(d: views.Data = Depends(get_data)):
        return JSON(views.news_view(d))

    @app.get("/api/screener")
    def screener_page(d: views.Data = Depends(get_data)):
        return JSON(views.screener_view(d))

    @app.get("/api/calc")
    def calc(d: views.Data = Depends(get_data)):
        return JSON(views.calc_view(d))

    @app.get("/api/portfolio")
    def portfolio_page(d: views.Data = Depends(get_data)):
        return JSON(views.portfolio_view(d))

    @app.get("/api/portfolio/history")
    def portfolio_history(d: views.Data = Depends(get_data)):
        return JSON(views.portfolio_history(d))

    @app.get("/api/paper")
    def paper(d: views.Data = Depends(get_data)):
        return JSON(views.paper_view(d))

    @app.get("/api/backtest")
    def backtest_last(person: Person = Depends(get_person)):
        path = site.backtest_path(person)
        if path.exists():
            return Response(path.read_bytes(), media_type="application/json")
        return JSON(None)

    @app.get("/api/settings")
    def settings(d: views.Data = Depends(get_data)):
        return JSON(views.settings_view(d))

    @app.get("/api/jobs/current")
    def job_current(person: Person = Depends(get_person)):
        return JSON({"job": runner.status(person)})

    @app.get("/api/market")
    def market(d: views.Data = Depends(get_data)):
        return JSON(views.market_view(d))

    @app.get("/api/egx30")
    def egx30(d: views.Data = Depends(get_data)):
        return JSON(views.index_view(d))

    @app.put("/api/orders/check")
    def order_check(body: CheckIn, conn=Depends(get_conn)):
        if body.done:
            conn.execute("INSERT OR REPLACE INTO checklist(session, item, done_at) VALUES (?,?,?)",
                         (str(body.session), body.item, dt.datetime.now().isoformat(timespec="seconds")))
        else:
            conn.execute("DELETE FROM checklist WHERE session=? AND item=?", (str(body.session), body.item))
        conn.commit()
        return JSON({"ok": True})

    # ------------------------------------------------------------ your trades
    @app.post("/api/portfolio/buy")
    def buy(body: BuyIn, d: views.Data = Depends(get_data)):
        sym = body.symbol.strip().upper()
        if sym not in d.table.index:
            fail(400, f"{sym} isn't an EGX stock the agent knows.")
        if body.stop and body.stop >= body.price:
            fail(400, "The stop-loss must be below the price you paid.")
        ind = d.indicators(sym)
        atr = None
        if len(ind):
            hist = ind.loc[:pd.Timestamp(body.date)]
            atr = float((hist if len(hist) else ind)["atr14"].iloc[-1])
        chart = levels.plan_at(ind, d.cfg, body.date) if len(ind) and d.cfg.get("levels_mode") == "chart" else None
        if (atr is None or not math.isfinite(atr)) and not body.stop:
            fail(400, "There's no price history for this stock, so the automatic stop can't be calculated. "
                      "Enter a stop-loss.")
        had = portfolio.open_position(d.conn, "real", sym) is not None
        portfolio.add_real_buy(d.conn, d.cfg, sym, str(body.date), body.price, body.shares, atr,
                               sector=d.info(sym).get("sector") or "", stop=body.stop or None,
                               notes=body.notes.strip(), chart=chart, fees_in=body.fees_in)
        pos = portfolio.open_position(d.conn, "real", sym)
        if had:
            msg = (f"Added {body.shares:,} {sym} to your position: now {pos['shares']:,} shares at an average of "
                   f"{pos['entry_price']:.3f}. New stop {pos['stop']:.2f}, target {pos['target']:.2f}.")
        else:
            msg = f"Saved: {body.shares:,} {sym} at {body.price:.2f}. Stop {pos['stop']:.2f}, target {pos['target']:.2f}."
        return JSON({"message": msg, "trade_id": pos["id"]})

    @app.post("/api/portfolio/sell")
    def sell(body: SellIn, d: views.Data = Depends(get_data)):
        pos = d.conn.execute("SELECT * FROM trades WHERE id=? AND account='real' AND status='open'",
                             (body.trade_id,)).fetchone()
        if pos is None:
            fail(404, "This position is no longer open. Refresh the page.")
        if body.shares > pos["shares"]:
            fail(400, f"You hold {pos['shares']:,} shares, so you can't sell {body.shares:,}.")
        pnl = ((body.price - pos["entry_price"]) * body.shares - (pos["fees"] or 0) * body.shares / pos["shares"]
               - config.order_fee(body.price * body.shares, d.cfg))
        try:
            result = portfolio.sell_real(d.conn, d.cfg, body.trade_id, str(body.date), body.price, body.shares,
                                         body.reason)
        except ValueError as exc:
            fail(400, str(exc))
        left = pos["shares"] - body.shares
        msg = (f"Sold {body.shares:,} {pos['symbol']} at {body.price:.2f} (P&L after fees {pnl:+,.0f} EGP). "
               + (f"{left:,} shares still open at an average of {pos['entry_price']:.3f}." if result == "partial"
                  else "Position closed."))
        return JSON({"message": msg, "result": result, "pnl": pnl})

    @app.post("/api/portfolio/{trade_id}/adjust")
    def adjust(trade_id: int, body: AdjustIn, conn=Depends(get_conn)):
        pos = conn.execute("SELECT * FROM trades WHERE id=? AND account='real' AND status='open'",
                           (trade_id,)).fetchone()
        ev = corporate.pending(conn, "real").get(trade_id)
        if pos is None or ev is None or ev["event_id"] != body.event_id:
            fail(409, "This position was already updated. Refresh the page.")
        if body.ignore:
            corporate.ignore(conn, trade_id, body.event_id)
            return JSON({"message": f"Kept your {pos['symbol']} position as it is ({pos['shares']:,} shares)."})
        if not body.shares:
            fail(400, "Enter how many shares you hold now.")
        expected = pos["shares"] * ev["factor"]
        if not 0.75 * expected <= body.shares <= 1.25 * expected:
            fail(400, f"{body.shares:,} shares is far from the expected {ev['shares_expected']:,}. Check the number "
                      "at your broker. If your shares didn't change, choose 'My shares didn't change'.")
        res = corporate.apply(conn, trade_id, body.event_id, body.shares)
        return JSON({"message": f"Updated {res['symbol']}: {res['old']:,} → {res['new']:,} shares at an average of "
                               f"{res['avg']:.3f}. The stop and target moved by the same ratio."})

    @app.post("/api/portfolio/{trade_id}/dividend")
    def dividend(trade_id: int, body: DividendIn, conn=Depends(get_conn)):
        try:
            res = corporate.add_dividend(conn, trade_id, str(body.date), body.amount, body.note.strip())
        except ValueError as exc:
            fail(400, str(exc))
        return JSON({"message": f"Recorded a {body.amount:,.2f} EGP dividend on {res['symbol']} "
                               f"({res['per_share']:.3f} per share). It now counts in your P&L."})

    @app.delete("/api/dividends/{dividend_id}")
    def dividend_delete(dividend_id: int, conn=Depends(get_conn)):
        row = corporate.delete_dividend(conn, dividend_id)
        if row is None:
            fail(404, "Dividend not found.")
        return JSON({"message": f"Removed the {row['amount']:,.2f} EGP {row['symbol']} dividend."})

    @app.delete("/api/portfolio/{trade_id}")
    def delete_position(trade_id: int, conn=Depends(get_conn)):
        row = conn.execute("SELECT symbol FROM trades WHERE id=? AND account='real' AND status='open'",
                           (trade_id,)).fetchone()
        if row is None:
            fail(404, "Position not found.")
        portfolio.delete_trade(conn, trade_id)
        return JSON({"message": f"Deleted the {row['symbol']} position and its transactions."})

    @app.post("/api/paper/reset")
    def paper_reset(conn=Depends(get_conn)):
        conn.execute("DELETE FROM trades WHERE account='paper'")
        conn.commit()
        return JSON({"message": "Paper account reset. New paper trades start after the next scan."})

    # ------------------------------------------------------------ settings
    @app.put("/api/settings")
    def settings_save(values: dict = Body(...), d: views.Data = Depends(get_data),
                      person: Person = Depends(get_person)):
        new, errors = views.parse_settings(values, d.cfg)
        if errors:
            fail(400, "Some settings need fixing.", errors=errors)
        changed = {k: new[k] for k in views.FIELDS if k in new and new[k] != d.cfg.get(k)}
        try:
            site.save_settings(d.conn, person, changed)
        except PermissionError as exc:
            fail(403, str(exc))
        for sym in changed.get("symbol_aliases") or {}:  # retry these on the next download instead of in a week
            d.conn.execute("UPDATE stocks SET price_missing_since=NULL, price_note=NULL WHERE symbol=?", (sym,))
        d.conn.commit()
        cache.clear()
        msg = ("Settings saved. Press Re-score now to apply them to the latest data." if person.is_admin
               else "Settings saved. Your BUY signals and share counts use them from now on.")
        return JSON({"message": msg, "values": {k: new[k] for k in new if not k.startswith("telegram_")}})

    @app.post("/api/settings/defaults")
    def settings_defaults(conn=Depends(get_conn), person: Person = Depends(get_person)):
        if not multi_user:
            current = config.load_config()
            config.save_config({**config.DEFAULTS, **{k: current[k] for k in KEEP_ON_RESET}})
            cache.clear()
            return JSON({"message": "Default rules restored (your capital and fees were kept)."})
        keep = [k for k in KEEP_ON_RESET if k in config.PERSONAL_KEYS]
        conn.execute(f"DELETE FROM settings WHERE key NOT IN ({','.join('?' * len(keep))})", keep)
        conn.commit()
        if person.is_admin:
            current = config.load_config()
            config.save_config({**config.DEFAULTS, "telegram_token": current.get("telegram_token", "")})
        cache.clear()
        return JSON({"message": ("Default rules restored for everyone" if person.is_admin else "Your settings are back "
                                 "to the defaults") + " (your capital and fees were kept)."})

    # ------------------------------------------------------------ alerts: Telegram + the daily scan
    @app.get("/api/alerts")
    def alerts_status(d: views.Data = Depends(get_data), person: Person = Depends(get_person)):
        out = {"telegram": alerts.status(d.conn, d.cfg, person.is_admin), "multi_user": multi_user}
        if not multi_user:
            last = db.get_meta(d.conn, "daily_last_run")
            out["schedule"] = {**schedule.status(), "last_run": json.loads(last) if last else None}
        return JSON(out)

    @app.post("/api/alerts/telegram")
    def telegram_token(body: TokenIn, market=Depends(get_market), _admin: Person = Depends(require_admin)):
        try:
            bot = alerts.check_token(body.token)
        except alerts.TelegramError as exc:
            fail(400, str(exc))
        old = json.loads(db.get_meta(market, "telegram_bot") or "null")
        config.save_config({**config.load_config(), "telegram_token": body.token.strip()})
        if not old or old.get("username") != bot["username"]:
            # A different bot can't message anyone who hasn't pressed Start in it: everyone connects again.
            for _person, pconn, _cfg in site.each(market):
                if multi_user:
                    pconn.execute("DELETE FROM settings WHERE key='telegram_chat_id'")
                    pconn.commit()
                else:
                    alerts.save(telegram_chat_id="")
                alerts.forget_me(pconn)
        db.set_meta(market, "telegram_bot", json.dumps(bot))
        market.execute("DELETE FROM meta WHERE key IN ('telegram_starts', 'telegram_update_offset')")
        market.commit()
        return JSON({"message": f"Found the bot @{bot['username']}. Now connect your own Telegram below.", "bot": bot})

    @app.post("/api/alerts/telegram/link")
    def telegram_link(d: views.Data = Depends(get_data)):
        token = d.cfg.get("telegram_token")
        bot = json.loads(db.get_meta(d.conn, "telegram_bot") or "null")
        if not token or not bot:
            fail(400, "The Telegram bot isn't set up yet.")
        code = db.get_user_meta(d.conn, "telegram_link_code") or alerts.new_link_code()   # same link until used
        db.set_user_meta(d.conn, "telegram_link_code", code)
        return JSON({"url": f"https://t.me/{bot['username']}?start={code}", "bot": bot})

    @app.post("/api/alerts/telegram/connect")
    def telegram_connect(d: views.Data = Depends(get_data), person: Person = Depends(get_person)):
        token = d.cfg.get("telegram_token")
        code = db.get_user_meta(d.conn, "telegram_link_code")
        if not token:
            fail(400, "The Telegram bot isn't set up yet.")
        if not code:
            fail(400, "Press Open Telegram first, then Start in the bot.")
        try:
            chat = alerts.find_chat_by_code(d.conn, token, code)
            if chat is None:
                fail(400, "The bot hasn't heard from you yet. Press Open Telegram, then Start in the bot, "
                          "then press Connect again.")
            alerts.send(token, chat["id"], "✅ <b>EGX Trading Agent is connected.</b>\nAfter each scan you'll get "
                                           "the orders for the next session here.")
        except alerts.TelegramError as exc:
            fail(400, str(exc))
        save_own(d.conn, person, telegram_chat_id=chat["id"])
        db.set_user_meta(d.conn, "telegram_chat_name", chat["name"])
        db.set_user_meta(d.conn, "telegram_link_code", None)
        return JSON({"message": f"Connected to {chat['name']}. Check Telegram for a welcome message."})

    @app.post("/api/alerts/telegram/test")
    def telegram_test(d: views.Data = Depends(get_data)):
        try:
            result = alerts.after_scan(d.conn, d.cfg, force=True)
        except alerts.TelegramError as exc:
            fail(400, str(exc))
        if result != "sent":
            fail(400, "Connect Telegram first." if result == "off" else "Run a scan first.")
        return JSON({"message": "Sent the latest summary to Telegram."})

    @app.put("/api/alerts/options")
    def alerts_options(body: AlertOptionsIn, conn=Depends(get_conn), person: Person = Depends(get_person)):
        save_own(conn, person, telegram_only_action=body.only_action)
        return JSON({"message": "Saved. " + ("You'll only get a message on days with something to do."
                                             if body.only_action else "You'll get a message after every scan.")})

    @app.delete("/api/alerts/telegram")
    def telegram_off(conn=Depends(get_conn), person: Person = Depends(get_person)):
        alerts.forget_me(conn)
        if multi_user:
            conn.execute("DELETE FROM settings WHERE key='telegram_chat_id'")
            conn.commit()
            return JSON({"message": "Telegram disconnected. You won't get messages any more."})
        alerts.save(telegram_token="", telegram_chat_id="")
        conn.execute("DELETE FROM meta WHERE key LIKE 'telegram_%'")
        conn.commit()
        return JSON({"message": "Telegram disconnected. The token was removed from this Mac."})

    @app.delete("/api/admin/telegram-bot")
    def telegram_bot_off(market=Depends(get_market), _admin: Person = Depends(require_admin)):
        only_website()
        config.save_config({**config.load_config(), "telegram_token": ""})
        market.execute("DELETE FROM meta WHERE key LIKE 'telegram_%'")
        market.commit()
        return JSON({"message": "The Telegram bot was removed. Nobody gets messages until you add one again."})

    @app.post("/api/alerts/schedule")
    def schedule_set(body: ScheduleIn):
        if multi_user:
            fail(404, "The website scans by itself every trading day.")
        try:
            schedule.install() if body.on else schedule.uninstall()
        except (RuntimeError, OSError, subprocess.SubprocessError) as exc:
            fail(500, f"Couldn't change the daily scan: {exc}")
        times = schedule.status().get("times") or []
        return JSON({"message": (f"Daily scan on: Sunday–Thursday at {times[0]}, again at {' and '.join(times[1:])} "
                                 "if prices were late. It runs even when the dashboard is closed.")
                     if body.on else "Daily scan turned off. The dashboard still scans by itself while it's open."})

    # ------------------------------------------------------------ background jobs
    @app.post("/api/jobs/scan")
    def job_scan(body: ScanIn, _admin: Person = Depends(require_admin)):
        label = "Scan" if body.update_data else "Re-score"
        return start_job("scan", label, jobs.scan_job(body.update_data, site), jobs.scan_summary)

    @app.post("/api/jobs/kashif")
    def job_kashif(_admin: Person = Depends(require_admin)):
        return start_job("kashif", "Kashif refresh", jobs.kashif_job, jobs.kashif_summary)

    @app.get("/api/predict")
    def predict_page(d: views.Data = Depends(get_data)):
        return views.predict_view(d)

    @app.post("/api/predict/train")
    def predict_train(_admin: Person = Depends(require_admin)):
        return start_job("train", "Prediction model", jobs.train_job, jobs.train_summary)

    @app.post("/api/backtest")
    def backtest_run(body: BacktestIn, d: views.Data = Depends(get_data), person: Person = Depends(get_person)):
        return start_job("backtest", "Backtest",
                         jobs.backtest_job(body.years, body.universe, site.backtest_path(person), d.cfg),
                         jobs.backtest_summary, owner=person.id if multi_user else None)

    # ------------------------------------------------------------ the page
    app.mount("/static", StaticFiles(directory=STATIC), name="static")

    @app.get("/robots.txt", include_in_schema=False)
    def robots():
        return PlainTextResponse("User-agent: *\nDisallow: /\n")

    @app.get("/", include_in_schema=False)
    def index():
        return FileResponse(STATIC / "index.html")

    return app


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(description="EGX Trading Agent dashboard")
    p.add_argument("--port", type=int, default=8501)
    p.add_argument("--host", default="127.0.0.1", help="127.0.0.1 = only this computer (or Caddy) can open it")
    p.add_argument("--db", help="database file (default: data/egx.db, or data/market.db with --server)")
    p.add_argument("--config", help="settings file (default: config.yaml in the project folder)")
    p.add_argument("--no-autoscan", action="store_true", help="don't scan by itself after the close")
    p.add_argument("--server", action="store_true", help="the website: logins, one data file per person")
    p.add_argument("--domain", action="append", default=[], help="the website's address, e.g. name.duckdns.org")
    p.add_argument("--insecure-cookies", action="store_true", help="testing a --server copy over plain http only")
    a = p.parse_args(argv)
    if a.config:
        config.CONFIG_PATH = Path(a.config)
    db_path = a.db or str(config.ROOT / "data" / ("market.db" if a.server else "egx.db"))
    app = create_app(db_path, autoscan=not a.no_autoscan, multi_user=a.server,
                     secure_cookies=False if a.insecure_cookies else None, hosts=a.domain)
    where = f"https://{a.domain[0]}" if a.server and a.domain else f"http://localhost:{a.port}"
    print(f"EGX Trading Agent is running at {where}  (press Ctrl+C to stop)", flush=True)
    uvicorn.run(app, host=a.host, port=a.port, log_level="warning", proxy_headers=a.server,
                forwarded_allow_ips="127.0.0.1")


if __name__ == "__main__":
    main()
