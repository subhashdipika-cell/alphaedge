// ─── APP-WIDE CONSTANTS ───────────────────────────────────────────────────────
// Indian index universe + Dhan instrument metadata. AlphaEdge is an Indian
// index-options decision-support platform — these four indices are the whole
// tradable surface.

export const ASSETS = [
  { id: "NIFTY50",   label: "Nifty 50",   base: 25500, type: "index", exchange: "NSE" },
  { id: "BANKNIFTY", label: "Bank Nifty", base: 57500, type: "index", exchange: "NSE" },
  { id: "SENSEX",    label: "Sensex",     base: 83500, type: "index", exchange: "BSE" },
  { id: "FINNIFTY",  label: "Fin Nifty",  base: 27200, type: "index", exchange: "NSE" },
];

export const PAGES = ["Dashboard","Option Score","OI Pulse","Paper Trades","R&D","AI Signal","Backtest","Alerts","History","Money Mgt.","Calendar","MTF Confluence","Journal","Options","Settings"];
export const PAGE_ICONS = ["▣","◎","☲","📝","🔬","◈","⟳","◉","◷","⚑","◫","◐","✎","⊗","⚙"];

export const CAT_COLOR = { ICT:"#f59e0b", SMC:"#06b6d4", Classic:"#a78bfa", Macro:"#34d399" };

// TradingView widget symbols.
export const TV_SYMBOLS = {
  NIFTY50:   "NSE:NIFTY",
  BANKNIFTY: "NSE:BANKNIFTY",
  SENSEX:    "BSE:SENSEX",
  FINNIFTY:  "NSE:CNXFINANCE",
};
export const TV_TF_MAP = {
  "1m":"1","5m":"5","15m":"15","1H":"60","4H":"240","1D":"D","1W":"W",
};

// Assets charted from real Dhan candles (all of them, post-revamp).
export const DHAN_CHART_ASSETS = ["NIFTY50", "BANKNIFTY", "SENSEX", "FINNIFTY"];

// Dhan securityId map (IDX_I spot indices; futures auto-resolved bridge-side).
export const DHAN_INSTRUMENTS = {
  NIFTY50:   { securityId: "13", segment: "IDX_I", instrument: "INDEX", label: "Nifty 50" },
  BANKNIFTY: { securityId: "25", segment: "IDX_I", instrument: "INDEX", label: "Bank Nifty" },
  SENSEX:    { securityId: "51", segment: "IDX_I", instrument: "INDEX", label: "Sensex" },
  FINNIFTY:  { securityId: "27", segment: "IDX_I", instrument: "INDEX", label: "Fin Nifty" },
};

// Dhan intraday interval (minutes) keyed by our timeframe label.
export const DHAN_TF_INTERVAL = { "1m": "1", "5m": "5", "15m": "15", "1H": "60" };

// How many days of history to pull per timeframe (Dhan intraday keeps ~90 days).
export const DHAN_TF_DAYS = { "1m": 2, "5m": 5, "15m": 10, "1H": 30, "4H": 85, "1D": 365, "1W": 730 };

// F&O lot sizes — last-known defaults; live values refresh from the bridge.
export const LOT_SIZE_DEFAULTS = { NIFTY50: 65, BANKNIFTY: 30, SENSEX: 20, FINNIFTY: 60 };
export const APP_TO_DHAN = { NIFTY50: "NIFTY", BANKNIFTY: "BANKNIFTY", SENSEX: "SENSEX", FINNIFTY: "FINNIFTY" };

// Yahoo Finance symbols for each index (URL-encoded), used when the bridge is down.
export const YAHOO_INDEX = {
  NIFTY50:   "%5ENSEI",
  BANKNIFTY: "%5ENSEBANK",
  SENSEX:    "%5EBSESN",
  FINNIFTY:  "NIFTY_FIN_SERVICE.NS",
};

// The local Dhan data bridge always listens here; default when no URL is set.
export const DEFAULT_BRIDGE_URL = "http://127.0.0.1:5000/signal";
