#!/usr/bin/env python3
"""
Локальный отправщик заявок на производство (для теста автоотправки).
CRM (фронт) шлёт сюда POST с заявкой — скрипт отправляет письмо по SMTP.

ВАЖНО: пароль почты НЕ хранится в коде. Передаётся через переменные
окружения. Скрипт их только читает.

Запуск:
    export SMTP_HOST=smtp.gmail.com
    export SMTP_PORT=587
    export SMTP_USER=ваша_почта@gmail.com
    export SMTP_PASS=пароль_приложения      # app password, НЕ основной пароль
    export SMTP_FROM="Центр окон и дверей <ваша_почта@gmail.com>"
    python3 integration/mail_sender.py

Готовые профили (SMTP_HOST/PORT):
    Gmail   : smtp.gmail.com   / 587   (нужен App Password)
    Yandex  : smtp.yandex.ru   / 465   (нужен пароль приложения; SSL)
    Mail.ru : smtp.mail.ru     / 465   (нужен пароль для внешних приложений; SSL)

Контракт (тот же, что потом на сервере/n8n):
    POST /send-production-request
    { "to": "prod@example.com", "subject": "...", "body": "...", "crm_id": "CRM-04942" }
    → 200 { "ok": true }  |  4xx/5xx { "ok": false, "error": "..." }
"""
import json
import os
import smtplib
import ssl
import sys
from email.message import EmailMessage
from email.utils import formataddr, parseaddr
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("SENDER_PORT", "8765"))
# Разрешаем запросы от локальной CRM и с GitHub Pages
ALLOWED_ORIGINS = {
    "http://localhost:3457", "http://127.0.0.1:3457",
    "https://mentori1.github.io",
}

def smtp_config():
    cfg = {
        "host": os.environ.get("SMTP_HOST"),
        "port": int(os.environ.get("SMTP_PORT", "587")),
        "user": os.environ.get("SMTP_USER"),
        "password": os.environ.get("SMTP_PASS"),
        "from": os.environ.get("SMTP_FROM") or os.environ.get("SMTP_USER"),
    }
    missing = [k for k in ("host", "user", "password") if not cfg[k]]
    if missing:
        raise RuntimeError("Не заданы переменные окружения: " +
                           ", ".join("SMTP_" + m.upper() for m in missing))
    return cfg

def send_email(to_addr, subject, body):
    cfg = smtp_config()
    msg = EmailMessage()
    name, addr = parseaddr(cfg["from"])
    msg["From"] = formataddr((name or "Центр окон и дверей", addr or cfg["user"]))
    msg["To"] = to_addr
    msg["Subject"] = subject
    msg.set_content(body)

    if cfg["port"] == 465:
        ctx = ssl.create_default_context()
        with smtplib.SMTP_SSL(cfg["host"], cfg["port"], context=ctx, timeout=30) as s:
            s.login(cfg["user"], cfg["password"])
            s.send_message(msg)
    else:
        with smtplib.SMTP(cfg["host"], cfg["port"], timeout=30) as s:
            s.starttls(context=ssl.create_default_context())
            s.login(cfg["user"], cfg["password"])
            s.send_message(msg)

class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        origin = self.headers.get("Origin", "")
        allow = origin if origin in ALLOWED_ORIGINS else "*"
        self.send_header("Access-Control-Allow-Origin", allow)
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        # health-check
        try:
            smtp_config()
            self._json(200, {"ok": True, "status": "отправщик готов, SMTP настроен"})
        except Exception as e:
            self._json(200, {"ok": False, "status": str(e)})

    def do_POST(self):
        if self.path.rstrip("/") != "/send-production-request":
            return self._json(404, {"ok": False, "error": "unknown endpoint"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            data = json.loads(self.rfile.read(length) or "{}")
            to_addr = (data.get("to") or "").strip()
            subject = (data.get("subject") or "").strip()
            body = data.get("body") or ""
            if not to_addr or not subject:
                return self._json(400, {"ok": False, "error": "нужны поля to и subject"})
            send_email(to_addr, subject, body)
            print(f"✓ Отправлено: {data.get('crm_id', '?')} → {to_addr}")
            self._json(200, {"ok": True})
        except Exception as e:
            print(f"✗ Ошибка отправки: {e}", file=sys.stderr)
            self._json(500, {"ok": False, "error": str(e)})

    def log_message(self, *a):
        pass  # тише в консоли

def main():
    try:
        cfg = smtp_config()
        print(f"→ SMTP: {cfg['user']} через {cfg['host']}:{cfg['port']}")
    except Exception as e:
        print(f"⚠ {e}\n  Экспортируйте SMTP_* перед запуском (см. шапку файла).")
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"→ Отправщик заявок слушает http://localhost:{PORT}")
    print("  Health-check: открыть этот адрес в браузере.")
    print("  Ctrl+C — остановить.")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nОстановлен.")

if __name__ == "__main__":
    main()
