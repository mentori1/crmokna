#!/usr/bin/env python3
"""Lightweight local backend for CRM Ovsyannikov (SQLite + JSON API)."""
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import time
from datetime import datetime, timezone
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import Request, urlopen

DB_PATH = Path(os.environ.get("CRM_DB", "/var/lib/ovsyannikov-crm/crm.db"))
HOST = os.environ.get("CRM_HOST", "127.0.0.1")
PORT = int(os.environ.get("CRM_PORT", "8765"))
SESSION_TTL = 30 * 24 * 3600
SECURE_COOKIE = os.environ.get("CRM_SECURE_COOKIE", "0") == "1"
DADATA_TOKEN = os.environ.get("DADATA_TOKEN", "").strip()
DADATA_SUGGEST_URL = "https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/address"
LOGIN_ATTEMPTS = {}
ADDRESS_SUGGEST_ATTEMPTS = {}
TABLES = {"clients", "suppliers", "orders", "order_items", "transactions", "salary_payments", "product_custom", "product_hidden", "app_settings", "audit_log"}
WRITABLE = TABLES - {"audit_log"}
JSON_COLS = {"address_data", "value", "old_value", "new_value"}
EVENT_COLS = {"clients", "suppliers", "orders", "transactions", "salary_payments", "app_settings"}
MAX_CRM_ORDER_ID = 99_999_999


def db():
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("pragma foreign_keys=on")
    conn.execute("pragma busy_timeout=30000")
    return conn


def now():
    return datetime.now(timezone.utc).isoformat()


def row_dict(row):
    if row is None:
        return None
    result = dict(row)
    for key in JSON_COLS & result.keys():
        if result[key]:
            try:
                result[key] = json.loads(result[key])
            except (TypeError, json.JSONDecodeError):
                pass
    return result


def password_ok(password, encoded):
    try:
        scheme, iterations, salt, expected = encoded.split("$", 3)
        actual = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), int(iterations)).hex()
        return scheme == "pbkdf2_sha256" and hmac.compare_digest(actual, expected)
    except Exception:
        return False


def audit(conn, table, action, old, new, actor):
    row_id = (new or old or {}).get("id") or (new or old or {}).get("name")
    conn.execute(
        "insert into audit_log(table_name,row_id,action,old_value,new_value,actor,at) values(?,?,?,?,?,?,?)",
        (table, str(row_id), action, json.dumps(old, ensure_ascii=False) if old else None,
         json.dumps(new, ensure_ascii=False) if new else None, actor, now()),
    )


def bump_revision(conn):
    conn.execute("update app_meta set value=cast(value as integer)+1 where key='revision'")


class Handler(BaseHTTPRequestHandler):
    server_version = "OvsyannikovCRM/1.0"

    def log_message(self, fmt, *args):
        print(f"{self.address_string()} {fmt % args}")

    def send_json(self, status, payload, headers=None):
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length > 10_000_000:
            raise ValueError("payload too large")
        return json.loads(self.rfile.read(length) or b"{}")

    def session_user(self):
        jar = cookies.SimpleCookie(self.headers.get("Cookie", ""))
        morsel = jar.get("crm_session")
        if not morsel:
            return None
        with db() as conn:
            row = conn.execute(
                "select u.id,u.email from sessions s join users u on u.id=s.user_id where s.token=? and s.expires_at>?",
                (morsel.value, int(time.time())),
            ).fetchone()
        return dict(row) if row else None

    def require_user(self):
        user = self.session_user()
        if not user:
            self.send_json(401, {"error": "Требуется вход"})
            return None
        return user

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/health":
            with db() as conn:
                conn.execute("select 1").fetchone()
            return self.send_json(200, {"ok": True})
        if path == "/api/session":
            user = self.session_user()
            return self.send_json(200, {"session": {"user": user} if user else None})
        user = self.require_user()
        if not user:
            return
        if path == "/api/revision":
            with db() as conn:
                value = conn.execute("select value from app_meta where key='revision'").fetchone()[0]
            return self.send_json(200, {"revision": int(value)})
        return self.send_json(404, {"error": "not found"})

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            payload = self.body()
        except Exception as exc:
            return self.send_json(400, {"error": str(exc)})
        if path == "/api/login":
            return self.login(payload)
        if path == "/api/logout":
            return self.logout()
        user = self.require_user()
        if not user:
            return
        if path == "/api/query":
            return self.query(payload, user)
        if path == "/api/address-suggest":
            return self.address_suggest(payload, user)
        if path == "/api/rpc/create_order":
            return self.create_order(payload, user)
        if path == "/api/rpc/replace_order_items":
            return self.replace_order_items(payload, user)
        if path == "/api/rpc/delete_order":
            return self.delete_order(payload, user)
        return self.send_json(404, {"error": "not found"})

    def login(self, payload):
        ip = self.client_address[0]
        cutoff = time.time() - 900
        attempts = [stamp for stamp in LOGIN_ATTEMPTS.get(ip, []) if stamp > cutoff]
        LOGIN_ATTEMPTS[ip] = attempts
        if len(attempts) >= 8:
            return self.send_json(429, {"error": "Слишком много попыток. Повторите через 15 минут"})
        email = str(payload.get("email", "")).strip().lower()
        password = str(payload.get("password", ""))
        with db() as conn:
            user = conn.execute("select id,email,password_hash from users where lower(email)=?", (email,)).fetchone()
            if not user or not password_ok(password, user["password_hash"]):
                LOGIN_ATTEMPTS[ip].append(time.time())
                return self.send_json(401, {"error": "Неверный email или пароль"})
            LOGIN_ATTEMPTS.pop(ip, None)
            token = secrets.token_urlsafe(40)
            conn.execute("delete from sessions where expires_at<=?", (int(time.time()),))
            conn.execute("insert into sessions(token,user_id,expires_at) values(?,?,?)", (token, user["id"], int(time.time()) + SESSION_TTL))
        secure = "; Secure" if SECURE_COOKIE else ""
        cookie = f"crm_session={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={SESSION_TTL}{secure}"
        return self.send_json(200, {"session": {"user": {"id": user["id"], "email": user["email"]}}}, {"Set-Cookie": cookie})

    def logout(self):
        jar = cookies.SimpleCookie(self.headers.get("Cookie", ""))
        if jar.get("crm_session"):
            with db() as conn:
                conn.execute("delete from sessions where token=?", (jar["crm_session"].value,))
        return self.send_json(200, {"ok": True}, {"Set-Cookie": "crm_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"})

    def address_suggest(self, payload, user):
        query = str(payload.get("query", "")).strip()
        if len(query) < 3:
            return self.send_json(200, {"suggestions": []})
        if len(query) > 200:
            return self.send_json(400, {"error": "Адрес слишком длинный"})
        if not DADATA_TOKEN:
            return self.send_json(503, {"error": "Подсказки адреса не настроены"})

        key = user.get("id") or self.client_address[0]
        cutoff = time.time() - 60
        attempts = [stamp for stamp in ADDRESS_SUGGEST_ATTEMPTS.get(key, []) if stamp > cutoff]
        if len(attempts) >= 90:
            return self.send_json(429, {"error": "Слишком много запросов адреса"})
        attempts.append(time.time())
        ADDRESS_SUGGEST_ATTEMPTS[key] = attempts

        try:
            count = min(max(int(payload.get("count", 7)), 1), 10)
        except (TypeError, ValueError):
            count = 7
        request = Request(
            DADATA_SUGGEST_URL,
            data=json.dumps({"query": query, "count": count}, ensure_ascii=False).encode(),
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json",
                "Authorization": "Token " + DADATA_TOKEN,
                "User-Agent": "OvsyannikovCRM/1.0",
            },
            method="POST",
        )
        try:
            with urlopen(request, timeout=8) as response:
                upstream = json.loads(response.read())
        except HTTPError as exc:
            print(f"DaData HTTP error: {exc.code}")
            return self.send_json(502, {"error": "Сервис подсказок адреса временно недоступен"})
        except (URLError, TimeoutError, json.JSONDecodeError) as exc:
            print(f"DaData request error: {type(exc).__name__}")
            return self.send_json(502, {"error": "Сервис подсказок адреса временно недоступен"})

        allowed = (
            "region_with_type", "region", "city_with_type", "settlement_with_type", "city",
            "street_with_type", "house", "flat", "postal_code", "geo_lat", "geo_lon", "fias_id",
        )
        suggestions = []
        for item in upstream.get("suggestions", [])[:count]:
            if not isinstance(item, dict):
                continue
            data = item.get("data") if isinstance(item.get("data"), dict) else {}
            suggestions.append({
                "value": str(item.get("value") or ""),
                "unrestricted_value": str(item.get("unrestricted_value") or ""),
                "data": {key: data.get(key) for key in allowed},
            })
        return self.send_json(200, {"suggestions": suggestions})

    @staticmethod
    def where(filters):
        clauses, params = [], []
        for item in filters or []:
            col, op, value = item.get("column"), item.get("op"), item.get("value")
            if not col or not col.replace("_", "").isalnum():
                raise ValueError("bad filter")
            if op == "eq":
                clauses.append(f"{col}=?")
                params.append(value)
            elif op == "is" and value is None:
                clauses.append(f"{col} is null")
            else:
                raise ValueError("unsupported filter")
        return (" where " + " and ".join(clauses) if clauses else ""), params

    def query(self, req, user):
        table = req.get("table")
        action = req.get("action", "select")
        if table not in TABLES or (action != "select" and table not in WRITABLE):
            return self.send_json(400, {"error": "Недопустимая таблица"})
        try:
            where, params = self.where(req.get("filters"))
            with db() as conn:
                if action == "select":
                    limit = min(int(req.get("limit", 1000)), 5000)
                    offset = max(int(req.get("offset", 0)), 0)
                    rows = [row_dict(x) for x in conn.execute(f"select * from {table}{where} limit ? offset ?", (*params, limit, offset)).fetchall()]
                    if table == "transactions" and rows:
                        client_ids = {r["entity_id"] for r in rows if r.get("entity_type") == "client"}
                        supplier_ids = {r["entity_id"] for r in rows if r.get("entity_type") == "supplier"}
                        names = {}
                        if client_ids:
                            marks = ",".join("?" for _ in client_ids)
                            for item in conn.execute(f"select id,name,address from clients where id in ({marks})", list(client_ids)):
                                names[("client", item["id"])] = item["name"] or item["address"] or "Без имени"
                        if supplier_ids:
                            marks = ",".join("?" for _ in supplier_ids)
                            for item in conn.execute(f"select id,name from suppliers where id in ({marks})", list(supplier_ids)):
                                names[("supplier", item["id"])] = item["name"]
                        for item in rows:
                            item["entity_name"] = names.get((item.get("entity_type"), item.get("entity_id")))
                    if table == "orders" and req.get("nested_items"):
                        ids = [r["id"] for r in rows]
                        grouped = {oid: [] for oid in ids}
                        if ids:
                            marks = ",".join("?" for _ in ids)
                            items = conn.execute(f"select * from order_items where deleted_at is null and order_id in ({marks})", ids).fetchall()
                            for item in items:
                                grouped[item["order_id"]].append(row_dict(item))
                        for row in rows:
                            row["order_items"] = grouped.get(row["id"], [])
                    return self.send_json(200, {"data": rows})
                if action == "insert":
                    items = req.get("rows") if isinstance(req.get("rows"), list) else [req.get("rows")]
                    created = []
                    conn.execute("begin immediate")
                    for item in items:
                        clean = self.clean_row(conn, table, item, inserting=True, actor=user["id"])
                        if table == "transactions":
                            self.validate_transaction(conn, clean)
                            key = clean.get("idempotency_key")
                            if key:
                                existing = conn.execute("select * from transactions where idempotency_key=?", (key,)).fetchone()
                                if existing:
                                    created.append(row_dict(existing))
                                    continue
                        if table == "salary_payments":
                            self.validate_salary_payment(clean)
                            key = clean.get("idempotency_key")
                            if key:
                                existing = conn.execute("select * from salary_payments where idempotency_key=?", (key,)).fetchone()
                                if existing:
                                    created.append(row_dict(existing))
                                    continue
                        if table == "orders":
                            self.validate_order_manager(clean, required=True)
                            clean["id"] = self.next_order_id(conn)
                        if table in {"clients", "suppliers", "transactions", "salary_payments"} and clean.get("id") is not None:
                            occupied = conn.execute(f"select 1 from {table} where id=?", (clean["id"],)).fetchone()
                            if occupied:
                                clean["id"] = conn.execute(f"select coalesce(max(id),0)+1 from {table}").fetchone()[0]
                        cols = list(clean)
                        conn.execute(f"insert into {table} ({','.join(cols)}) values ({','.join('?' for _ in cols)})", [clean[c] for c in cols])
                        created.append(clean)
                        audit(conn, table, "INSERT", None, clean, user["id"])
                    bump_revision(conn)
                    conn.commit()
                    return self.send_json(200, {"data": created})
                if action == "update":
                    old = conn.execute(f"select * from {table}{where}", params).fetchone()
                    if not old:
                        return self.send_json(200, {"data": None})
                    clean = self.clean_row(conn, table, req.get("values") or {}, inserting=False, actor=user["id"])
                    clean.pop("id", None)
                    if table == "transactions":
                        merged = row_dict(old)
                        merged.update(clean)
                        self.validate_transaction(conn, merged)
                    if table == "salary_payments":
                        merged = row_dict(old)
                        merged.update(clean)
                        self.validate_salary_payment(merged)
                    if table == "orders":
                        merged = row_dict(old)
                        merged.update(clean)
                        self.validate_order_manager(merged)
                    if "version" in old.keys():
                        clean["version"] = old["version"] + 1
                        clean["updated_at"] = now()
                        clean["updated_by"] = user["id"]
                    sets = ",".join(f"{key}=?" for key in clean)
                    conn.execute(f"update {table} set {sets}{where}", [*clean.values(), *params])
                    key_col = "id" if "id" in old.keys() else "name"
                    new = row_dict(conn.execute(f"select * from {table} where {key_col}=?", (old[key_col],)).fetchone())
                    audit(conn, table, "UPDATE", row_dict(old), new, user["id"])
                    bump_revision(conn)
                    return self.send_json(200, {"data": new})
                if action == "delete":
                    old_rows = [row_dict(x) for x in conn.execute(f"select * from {table}{where}", params).fetchall()]
                    conn.execute(f"delete from {table}{where}", params)
                    for old in old_rows:
                        audit(conn, table, "DELETE", old, None, user["id"])
                    bump_revision(conn)
                    return self.send_json(200, {"data": old_rows})
                if action == "upsert":
                    items = req.get("rows") if isinstance(req.get("rows"), list) else [req.get("rows")]
                    conflict = req.get("on_conflict") or "name"
                    for item in items:
                        clean = self.clean_row(conn, table, item, inserting=True, actor=user["id"])
                        cols = list(clean)
                        updates = ",".join(f"{c}=excluded.{c}" for c in cols if c != conflict)
                        conn.execute(f"insert into {table} ({','.join(cols)}) values ({','.join('?' for _ in cols)}) on conflict({conflict}) do update set {updates}", [clean[c] for c in cols])
                    bump_revision(conn)
                    return self.send_json(200, {"data": items})
        except sqlite3.IntegrityError as exc:
            return self.send_json(409, {"error": str(exc), "code": "23505"})
        except Exception as exc:
            return self.send_json(400, {"error": str(exc)})

    @staticmethod
    def clean_row(conn, table, values, inserting, actor):
        columns = {row[1] for row in conn.execute(f"pragma table_info({table})")}
        clean = {k: v for k, v in (values or {}).items() if k in columns}
        for key in JSON_COLS & clean.keys():
            if clean[key] is not None and not isinstance(clean[key], str):
                clean[key] = json.dumps(clean[key], ensure_ascii=False)
        if inserting:
            if "version" in columns:
                clean.setdefault("version", 1)
            if "updated_at" in columns:
                clean.setdefault("updated_at", now())
            if "created_by" in columns:
                clean.setdefault("created_by", actor)
            if table == "orders" and "created_at_time" in columns:
                # Точное время создания задаёт сервер: поле не показывается в CRM,
                # но гарантирует правильный порядок нескольких заказов за день.
                clean["created_at_time"] = now()
        return clean

    @staticmethod
    def validate_transaction(conn, tx):
        if tx.get("type") not in {"income", "expense"}:
            raise ValueError("Некорректный тип финансовой операции")
        if float(tx.get("amount") or 0) <= 0:
            raise ValueError("Сумма финансовой операции должна быть больше нуля")
        order_id = tx.get("order_id")
        if order_id is None:
            raise ValueError("Финансовая операция должна быть привязана к заказу")
        order = conn.execute("select id,client_id from orders where id=? and deleted_at is null", (order_id,)).fetchone()
        if not order:
            raise ValueError("Нельзя добавить платёж: заказ удалён или не существует")
        if tx["type"] == "income":
            if tx.get("entity_type") != "client" or tx.get("entity_id") != order["client_id"]:
                raise ValueError("Платёж клиента не соответствует клиенту заказа")
        else:
            supplier_ids = {row[0] for row in conn.execute(
                "select distinct supplier_id from order_items where order_id=? and deleted_at is null and supplier_id is not null",
                (order_id,),
            )}
            if tx.get("entity_type") != "supplier" or tx.get("entity_id") not in supplier_ids:
                raise ValueError("Платёж поставщику не соответствует поставщику заказа")

    @staticmethod
    def validate_salary_payment(payment):
        if payment.get("employee_key") != "olya":
            raise ValueError("Неизвестный сотрудник")
        if float(payment.get("amount") or 0) <= 0:
            raise ValueError("Сумма выплаты должна быть больше нуля")
        month = str(payment.get("salary_month") or "")
        date = str(payment.get("date") or "")
        try:
            datetime.strptime(month + "-01", "%Y-%m-%d")
        except ValueError:
            raise ValueError("Некорректный месяц зарплаты")
        try:
            datetime.strptime(date, "%Y-%m-%d")
        except ValueError:
            raise ValueError("Некорректная дата выплаты")

    @staticmethod
    def validate_order_manager(order, required=False):
        manager_key = order.get("manager_key")
        if required and manager_key not in {"sasha", "olya"}:
            raise ValueError("Выберите, кто оформил заказ: Саша или Оля")
        if manager_key not in {None, "sasha", "olya"}:
            raise ValueError("Неизвестный сотрудник, оформивший заказ")

    @staticmethod
    def next_order_id(conn):
        """Allocate the next normal CRM ID, ignoring historical test IDs."""
        value = conn.execute(
            "select coalesce(max(id),0)+1 from orders where id between 1 and ?",
            (MAX_CRM_ORDER_ID,),
        ).fetchone()[0]
        if value > MAX_CRM_ORDER_ID:
            raise ValueError("Закончился диапазон номеров заказов")
        return value

    def create_order(self, req, user):
        order = dict(req.get("order") or {})
        items = req.get("items") or []
        try:
            with db() as conn:
                conn.execute("begin immediate")
                key = order.get("idempotency_key")
                if key:
                    existing = conn.execute("select id from orders where idempotency_key=?", (key,)).fetchone()
                    if existing:
                        return self.send_json(200, {"data": existing["id"]})
                clean = self.clean_row(conn, "orders", order, True, user["id"])
                self.validate_order_manager(clean, required=True)
                clean["id"] = self.next_order_id(conn)
                cols = list(clean)
                conn.execute(f"insert into orders ({','.join(cols)}) values ({','.join('?' for _ in cols)})", [clean[c] for c in cols])
                for item in items:
                    row = dict(item)
                    row.pop("id", None)
                    row["order_id"] = clean["id"]
                    item_clean = self.clean_row(conn, "order_items", row, True, user["id"])
                    item_cols = list(item_clean)
                    conn.execute(f"insert into order_items ({','.join(item_cols)}) values ({','.join('?' for _ in item_cols)})", [item_clean[c] for c in item_cols])
                audit(conn, "orders", "INSERT", None, clean, user["id"])
                bump_revision(conn)
                conn.commit()
                return self.send_json(200, {"data": clean["id"]})
        except sqlite3.IntegrityError as exc:
            return self.send_json(409, {"error": str(exc), "code": "23505"})
        except Exception as exc:
            return self.send_json(400, {"error": str(exc)})

    def replace_order_items(self, req, user):
        order_id = req.get("order_id")
        items = req.get("items") or []
        try:
            with db() as conn:
                conn.execute("begin immediate")
                old_rows = [row_dict(x) for x in conn.execute("select * from order_items where order_id=?", (order_id,)).fetchall()]
                conn.execute("delete from order_items where order_id=?", (order_id,))
                for item in items:
                    row = dict(item)
                    row.pop("id", None)
                    row["order_id"] = order_id
                    clean = self.clean_row(conn, "order_items", row, True, user["id"])
                    cols = list(clean)
                    conn.execute(f"insert into order_items ({','.join(cols)}) values ({','.join('?' for _ in cols)})", [clean[c] for c in cols])
                audit(conn, "order_items", "REPLACE", {"order_id": order_id, "count": len(old_rows)}, {"order_id": order_id, "count": len(items)}, user["id"])
                bump_revision(conn)
                conn.commit()
            return self.send_json(200, {"data": True})
        except Exception as exc:
            return self.send_json(400, {"error": str(exc)})

    def delete_order(self, req, user):
        order_id = req.get("order_id")
        version = req.get("version")
        stamp = now()
        try:
            with db() as conn:
                conn.execute("begin immediate")
                order = conn.execute("select * from orders where id=? and deleted_at is null", (order_id,)).fetchone()
                if not order:
                    return self.send_json(200, {"data": {"order": 0, "items": 0, "transactions": 0}})
                if version is not None and order["version"] != version:
                    return self.send_json(409, {"error": "Заказ уже изменён другим пользователем", "code": "CONFLICT"})

                tx_rows = [row_dict(x) for x in conn.execute(
                    "select * from transactions where order_id=? and deleted_at is null", (order_id,)
                ).fetchall()]
                item_rows = [row_dict(x) for x in conn.execute(
                    "select * from order_items where order_id=? and deleted_at is null", (order_id,)
                ).fetchall()]

                conn.execute(
                    "update orders set deleted_at=?,updated_at=?,updated_by=?,version=version+1 where id=?",
                    (stamp, stamp, user["id"], order_id),
                )
                conn.execute(
                    "update transactions set deleted_at=?,updated_at=?,updated_by=?,version=version+1 where order_id=? and deleted_at is null",
                    (stamp, stamp, user["id"], order_id),
                )
                conn.execute(
                    "update order_items set deleted_at=?,updated_at=?,updated_by=?,version=version+1 where order_id=? and deleted_at is null",
                    (stamp, stamp, user["id"], order_id),
                )

                new_order = row_dict(conn.execute("select * from orders where id=?", (order_id,)).fetchone())
                audit(conn, "orders", "DELETE", row_dict(order), new_order, user["id"])
                for old in tx_rows:
                    new = dict(old, deleted_at=stamp, updated_at=stamp, updated_by=user["id"], version=(old.get("version") or 1) + 1)
                    audit(conn, "transactions", "DELETE", old, new, user["id"])
                audit(conn, "order_items", "DELETE_ORDER_ITEMS",
                      {"order_id": order_id, "count": len(item_rows)}, None, user["id"])
                bump_revision(conn)
                conn.commit()
                return self.send_json(200, {"data": {
                    "order": 1, "items": len(item_rows), "transactions": len(tx_rows),
                }})
        except Exception as exc:
            return self.send_json(400, {"error": str(exc)})


if __name__ == "__main__":
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
