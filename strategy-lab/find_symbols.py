import MetaTrader5 as mt5
mt5.initialize()
all_syms = mt5.symbols_get()
xau = [s.name for s in all_syms if "XAU" in s.name.upper() or "GOLD" in s.name.upper()]
btc = [s.name for s in all_syms if "BTC" in s.name.upper()]
print("XAU/GOLD symbols:", xau)
print("BTC symbols:", btc)
mt5.shutdown()
