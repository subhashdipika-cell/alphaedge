"""
dhan_test.py — validate the Dhan access token in dhan_config.json
=================================================================
Quick PASS/FAIL check so you can confirm a freshly generated token works
before running the collector. Dhan SELF access tokens are short-lived
(often 24h), so you'll run this each time you refresh the token.

  python dhan_test.py
"""
import base64
import io
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

CONFIG = Path(__file__).parent / "dhan_config.json"


def decode_exp(token: str):
    try:
        p = token.split(".")[1]
        p += "=" * (-len(p) % 4)
        d = json.loads(base64.urlsafe_b64decode(p))
        return d.get("iat"), d.get("exp"), d.get("dhanClientId")
    except Exception:
        return None, None, None


def main():
    if not CONFIG.exists():
        print("FAIL: dhan_config.json not found."); return
    cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
    token, client = cfg.get("access_token", ""), str(cfg.get("client_id", ""))
    if not token or token.startswith("PASTE_"):
        print("FAIL: no access_token in dhan_config.json."); return

    iat, exp, tok_client = decode_exp(token)
    now = int(time.time())
    print(f"Token clientId : {tok_client}  (config client_id: {client})")
    if exp:
        print(f"Valid window   : {datetime.fromtimestamp(iat)}  ->  {datetime.fromtimestamp(exp)}")
        if now > exp:
            print("FAIL: token EXPIRED — generate a fresh one."); return
        if tok_client and tok_client != client:
            print("WARN: token clientId does not match config client_id.")

    # Canonical token check per Dhan docs: GET /v2/profile returns token validity
    # AND the Data-API subscription status in one call.
    print("\n-- Profile check (GET /v2/profile — official token validator) --")
    import urllib.request, urllib.error
    try:
        req = urllib.request.Request("https://api.dhan.co/v2/profile", method="GET")
        req.add_header("access-token", token)
        req.add_header("client-id", client)
        req.add_header("Accept", "application/json")
        with urllib.request.urlopen(req, timeout=20) as r:
            prof = json.loads(r.read().decode())
        print(f"  PASS: token valid. Profile: {prof}")
        ds = prof.get("dataValidity") or prof.get("dataPlan") or prof.get("activeSegment")
        print(f"  Data-API subscription field: {ds}")
    except urllib.error.HTTPError as e:
        print(f"  FAIL: HTTP {e.code} {e.read().decode()[:200]}")
        print("  -> Token rejected. Generate a NEW Access Token (Access Token toggle),")
        print("     copy it immediately, paste here, and DO NOT regenerate again before testing.")
        return
    except Exception as e:
        print(f"  network error: {e}")

    try:
        from dhanhq import DhanContext, dhanhq
    except ImportError:
        print("FAIL: dhanhq not installed — run: pip install dhanhq"); return

    dhan = dhanhq(DhanContext(client, token))

    print("\n-- Trading API check (fund_limits) --")
    fl = dhan.get_fund_limits()
    if fl.get("status") == "failure":
        print(f"  FAIL: {fl.get('remarks')}")
        print("  -> Token rejected by Dhan. Generate a NEW Access Token (Access Token toggle),")
        print("     copy it immediately, paste here, and DO NOT regenerate again before testing.")
        return
    print(f"  PASS: {fl.get('data')}")

    print("\n-- Data API check (NIFTY50 daily, 5 days) --")
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    frm   = datetime.fromtimestamp(now - 7*86400, timezone.utc).strftime("%Y-%m-%d")
    # Use the SAME instrument the collector pulls (nearest-expiry future via
    # current_futures), not the raw index — the index id 13/IDX_I returns DH-905.
    try:
        from dhan_futures import current_futures
        meta = current_futures().get("NIFTY50")
    except Exception as e:
        print(f"  SKIP: could not resolve NIFTY50 contract ({e})."); return
    if not meta:
        print("  SKIP: NIFTY50 not in current_futures()."); return
    dd = dhan.historical_daily_data(security_id=meta["security_id"],
                                    exchange_segment=meta["segment"],
                                    instrument_type=meta["instrument"],
                                    from_date=frm, to_date=today)
    if dd.get("status") == "failure":
        print(f"  FAIL: {dd.get('remarks')}")
        print("  -> Trading works but Data API does not: check the 'Data APIs' subscription is ACTIVE.")
        return
    n = len(((dd.get("data") or {}).get("close")) or [])
    print(f"  PASS: received {n} daily candles for NIFTY50.")
    print("\nALL GOOD — token works for both Trading and Data APIs.")


if __name__ == "__main__":
    main()
