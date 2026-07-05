"""
dhan_token_refresh.py — auto-generate a fresh Dhan access token via PIN + TOTP
=============================================================================
Dhan SELF access tokens expire every 24h, which breaks the unattended daily
pipeline. This script generates a new token programmatically and writes it
back into dhan_config.json, so the 6:30 AM run always has a valid token.

Prerequisites (one-time):
  1. On web.dhan.co enable TOTP (Optional Settings -> Set-up TOTP). When the
     QR code shows, also reveal the manual/secret key (base32 string).
  2. Put your PIN and that TOTP secret into dhan_config.json:
        "pin": "1234",
        "totp_secret": "BASE32SECRETFROMDHAN"
     (These are sensitive — the file stays local and is never shared.)

Usage:
  python dhan_token_refresh.py          # refresh and save token
  python dhan_token_refresh.py --check  # only print whether refresh is possible

Endpoint (per Dhan docs):
  POST https://auth.dhan.co/app/generateAccessToken?dhanClientId=..&pin=..&totp=..
  -> { "accessToken": "...", "expiryTime": "..." }
"""
import argparse
import io
import json
import sys
import time
from pathlib import Path
from urllib import parse as urlparse, request as urlrequest, error as urlerror

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

CONFIG = Path(__file__).parent / "dhan_config.json"
AUTH_URL = "https://auth.dhan.co/app/generateAccessToken"


def load_config() -> dict:
    if not CONFIG.exists():
        print("FAIL: dhan_config.json not found.")
        sys.exit(1)
    return json.loads(CONFIG.read_text(encoding="utf-8"))


def save_token(cfg: dict, token: str):
    cfg["access_token"] = token
    CONFIG.write_text(json.dumps(cfg, indent=2), encoding="utf-8")


def refresh(cfg: dict) -> str | None:
    client = str(cfg.get("client_id", "")).strip()
    pin    = str(cfg.get("pin", "")).strip()
    secret = str(cfg.get("totp_secret", "")).strip()
    if not client or not pin or not secret or secret.startswith("PASTE_") or pin.startswith("PASTE_"):
        print("FAIL: need client_id, pin and totp_secret in dhan_config.json. "
              "Enable TOTP on Dhan and copy the secret key.")
        return None

    try:
        import pyotp
    except ImportError:
        print("FAIL: pyotp not installed — run: pip install pyotp")
        return None

    # Retry across TOTP windows: right after a cold boot the clock can be a few
    # seconds off (or Dhan's auth can hiccup), which yields "Invalid TOTP" once
    # and then works. Each attempt waits for the NEXT 30s window so a fresh
    # code is sent every time.
    attempts = 3
    for attempt in range(1, attempts + 1):
        if attempt > 1:
            totp = pyotp.TOTP(secret)
            wait = totp.interval - (time.time() % totp.interval) + 1
            print(f"  retrying in {wait:.0f}s (next TOTP window, attempt {attempt}/{attempts})...")
            time.sleep(wait)
        code = pyotp.TOTP(secret).now()
        params = urlparse.urlencode({"dhanClientId": client, "pin": pin, "totp": code})
        req = urlrequest.Request(f"{AUTH_URL}?{params}", data=b"", method="POST")
        req.add_header("Accept", "application/json")
        try:
            with urlrequest.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except urlerror.HTTPError as e:
            body = e.read().decode("utf-8", "replace")[:300]
            print(f"FAIL (attempt {attempt}/{attempts}): HTTP {e.code} from Dhan auth: {body}")
            continue
        except Exception as e:
            print(f"FAIL (attempt {attempt}/{attempts}): token request error: {e}")
            continue

        token = data.get("accessToken") or data.get("access_token")
        if not token:
            print(f"FAIL (attempt {attempt}/{attempts}): no accessToken in response: {data}")
            continue
        print(f"OK: new token generated (expires {data.get('expiryTime', 'in ~24h')}).")
        return token
    return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true",
                        help="Only report whether auto-refresh is configured")
    args = parser.parse_args()
    cfg = load_config()

    if args.check:
        ok = all(str(cfg.get(k, "")).strip() and not str(cfg.get(k, "")).startswith("PASTE_")
                 for k in ("client_id", "pin", "totp_secret"))
        print("Auto-refresh configured." if ok else
              "Auto-refresh NOT configured — add pin + totp_secret to dhan_config.json.")
        return

    token = refresh(cfg)
    if token:
        save_token(cfg, token)
        print("Saved fresh access_token to dhan_config.json.")
    else:
        sys.exit(1)


if __name__ == "__main__":
    main()
