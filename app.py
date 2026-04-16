import base64
import json
import logging
import os
import sys
from datetime import datetime, time, timedelta
from functools import wraps

import pytz
from dotenv import load_dotenv
from flask import (
    Flask,
    render_template,
    request,
    redirect,
    url_for,
    session,
    jsonify,
    flash,
)
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from flask_wtf.csrf import CSRFProtect
from supabase import create_client
from werkzeug.middleware.proxy_fix import ProxyFix

load_dotenv()

SUPABASE_URL = os.environ["SUPABASE_URL"].strip()
SUPABASE_KEY = os.environ["SUPABASE_KEY"].strip()
FLASK_SECRET_KEY = os.environ["FLASK_SECRET_KEY"].strip()

if (
    len(FLASK_SECRET_KEY) < 32
    or FLASK_SECRET_KEY == "change-me-to-a-long-random-string"
):
    raise RuntimeError(
        "FLASK_SECRET_KEY is missing or too weak. "
        'Generate one with: python -c "import secrets; print(secrets.token_hex(32))"'
    )

app = Flask(__name__)
app.secret_key = FLASK_SECRET_KEY

app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_prefix=1)

app.config.update(
    SESSION_COOKIE_SECURE=True,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_NAME="__Host-sankt_georg_session",
    PERMANENT_SESSION_LIFETIME=timedelta(hours=12),
    MAX_CONTENT_LENGTH=1 * 1024 * 1024,
    WTF_CSRF_TIME_LIMIT=None,
    PREFERRED_URL_SCHEME="https",
)

csrf = CSRFProtect(app)

limiter = Limiter(
    get_remote_address,
    app=app,
    default_limits=["200 per minute", "2000 per hour"],
    storage_uri="memory://",
    strategy="fixed-window",
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    stream=sys.stdout,
)
app.logger.setLevel(logging.INFO)

TIMEZONE = pytz.timezone("Europe/Berlin")


@app.after_request
def add_security_headers(response):
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    return response


@app.errorhandler(413)
def payload_too_large(_e):
    return jsonify({"error": "Payload too large"}), 413


@app.errorhandler(429)
def too_many_requests(_e):
    return jsonify({"error": "Zu viele Anfragen. Bitte später erneut versuchen."}), 429


@app.errorhandler(500)
def internal_error(e):
    app.logger.exception("Unhandled server error: %s", e)
    return (
        render_template("login.html")
        if request.path == "/"
        else (
            jsonify({"error": "Internal server error"}),
            500,
        )
    )


def get_supabase_client(access_token=None):
    client = create_client(SUPABASE_URL, SUPABASE_KEY)
    if access_token:
        client.postgrest.auth(access_token)
    return client


REFRESH_THRESHOLD_SECONDS = 5 * 60
IDLE_LIMIT_SECONDS = 10


def _jwt_exp(token):
    try:
        payload_b64 = token.split(".")[1]
        padded = payload_b64 + "=" * (-len(payload_b64) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded))
        return int(payload["exp"])
    except Exception:
        return None


def _session_is_idle():
    token = session.get("access_token")
    refresh_token = session.get("refresh_token")
    if not token or not refresh_token:
        return True
    now = int(datetime.now(pytz.utc).timestamp())
    last_activity = session.get("last_activity", now)
    return now - last_activity > IDLE_LIMIT_SECONDS


def _expire_session():
    app.logger.info("session_idle_timeout user_id=%s", session.get("user_id"))
    session.clear()
    flash("Sitzung abgelaufen. Bitte erneut anmelden.", "session_expired")


def _ensure_fresh_token():
    token = session.get("access_token")
    refresh_token = session.get("refresh_token")
    if not token or not refresh_token:
        return False

    now = int(datetime.now(pytz.utc).timestamp())
    last_activity = session.get("last_activity", now)
    if now - last_activity > IDLE_LIMIT_SECONDS:
        _expire_session()
        return False

    exp = _jwt_exp(token)
    if exp is None:
        return False

    if exp - now <= REFRESH_THRESHOLD_SECONDS:
        try:
            client = get_supabase_client()
            result = client.auth.refresh_session(refresh_token)
            session["access_token"] = result.session.access_token
            session["refresh_token"] = result.session.refresh_token
            app.logger.info("token_refresh_success user_id=%s", session.get("user_id"))
        except Exception:
            app.logger.warning(
                "token_refresh_failed user_id=%s", session.get("user_id")
            )
            session.clear()
            return False

    session["last_activity"] = now
    return True


def _unauthorized_response():
    if request.path.startswith("/api/"):
        return jsonify({"error": "session_expired"}), 401
    return redirect(url_for("login"))


def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if "access_token" not in session:
            return _unauthorized_response()
        if not _ensure_fresh_token():
            return _unauthorized_response()
        return f(*args, **kwargs)

    return decorated


def get_today_boundaries():
    now = datetime.now(TIMEZONE)
    today_5am = TIMEZONE.localize(datetime.combine(now.date(), time(5, 0)))
    if now < today_5am:
        today_5am -= timedelta(days=1)
    tomorrow_5am = today_5am + timedelta(days=1)
    return today_5am.isoformat(), tomorrow_5am.isoformat()


def get_day_boundaries(date_str):
    dt = datetime.strptime(date_str, "%Y-%m-%d")
    day_5am = TIMEZONE.localize(datetime.combine(dt.date(), time(5, 0)))
    next_5am = day_5am + timedelta(days=1)
    return day_5am.isoformat(), next_5am.isoformat()


# ---------- AUTH ----------


@app.route("/login", methods=["GET", "POST"])
@limiter.limit("5 per minute; 30 per hour", methods=["POST"])
def login():
    if request.method == "POST":
        email = request.form.get("email", "").strip()
        password = request.form.get("password", "")

        if not email or not password:
            flash("Bitte E-Mail und Passwort eingeben.", "error")
            return render_template("login.html")

        try:
            client = get_supabase_client()
            auth_response = client.auth.sign_in_with_password(
                {"email": email, "password": password}
            )
            session.clear()
            session.permanent = True
            session["access_token"] = auth_response.session.access_token
            session["refresh_token"] = auth_response.session.refresh_token
            session["user_email"] = auth_response.user.email
            session["user_id"] = auth_response.user.id
            session["last_activity"] = int(datetime.now(pytz.utc).timestamp())
            app.logger.info("login_success user_id=%s", auth_response.user.id)
            return redirect(url_for("today"))
        except Exception:
            app.logger.warning(
                "login_failed email=%s ip=%s", email, get_remote_address()
            )
            flash("Ungültige E-Mail oder Passwort.", "error")
            return render_template("login.html")

    return render_template("login.html")


@app.route("/logout", methods=["POST"])
def logout():
    session.clear()
    return redirect(url_for("login"))


# ---------- PAGES ----------


@app.route("/")
@login_required
def today():
    token = session["access_token"]
    p_from, p_to = get_today_boundaries()

    try:
        client = get_supabase_client(token)
        result = client.rpc(
            "dashboard_get_medications", {"p_from": p_from, "p_to": p_to}
        ).execute()
        medications = result.data or []
    except Exception:
        app.logger.exception("today: rpc dashboard_get_medications failed")
        medications = []
        flash("Fehler beim Laden der Daten.", "error")

    return render_template(
        "today.html",
        medications=medications,
        user_email=session.get("user_email", ""),
        p_from=p_from,
        p_to=p_to,
    )


@app.route("/history")
@login_required
def history():
    token = session["access_token"]
    date_str = request.args.get("date", "")

    try:
        client = get_supabase_client(token)
        days_result = client.rpc("dashboard_get_scan_days", {"p_limit": 1000}).execute()
        scan_days = days_result.data or []
    except Exception:
        app.logger.exception("history: rpc dashboard_get_scan_days failed")
        scan_days = []

    medications = []
    selected_date = date_str

    if date_str:
        try:
            p_from, p_to = get_day_boundaries(date_str)
            client = get_supabase_client(token)
            result = client.rpc(
                "dashboard_get_medications", {"p_from": p_from, "p_to": p_to}
            ).execute()
            medications = result.data or []
        except ValueError:
            flash("Ungültiges Datum.", "error")
        except Exception:
            app.logger.exception("history: rpc dashboard_get_medications failed")
            flash("Fehler beim Laden der Daten.", "error")

    return render_template(
        "history.html",
        medications=medications,
        scan_days=scan_days,
        selected_date=selected_date,
        user_email=session.get("user_email", ""),
        p_from=request.args.get("p_from", ""),
        p_to=request.args.get("p_to", ""),
    )


# ---------- API ----------


@app.route("/api/codes")
@login_required
@limiter.limit("60 per minute")
def api_codes():
    token = session["access_token"]
    pzn = request.args.get("pzn", "")
    p_from = request.args.get("from", "")
    p_to = request.args.get("to", "")

    if not p_from or not p_to:
        return jsonify({"codes": [], "error": "Missing time range"}), 400

    try:
        client = get_supabase_client(token)
        result = client.rpc(
            "dashboard_get_codes", {"p_from": p_from, "p_to": p_to, "p_pzn": pzn}
        ).execute()
        codes = [row["formatted_code"] for row in (result.data or [])]
        return jsonify({"codes": codes})
    except Exception:
        app.logger.exception("api_codes: rpc dashboard_get_codes failed")
        return jsonify({"codes": [], "error": "Server error"}), 500


@app.route("/api/session")
def api_session():
    if "access_token" not in session:
        return jsonify({"ok": False, "expired": True}), 401
    if _session_is_idle():
        _expire_session()
        return jsonify({"ok": False, "expired": True}), 401
    return jsonify({"ok": True})


@app.route("/healthz")
@csrf.exempt
def healthz():
    return {"status": "ok"}, 200


if __name__ == "__main__":
    app.run(debug=False, host="127.0.0.1", port=5003)
