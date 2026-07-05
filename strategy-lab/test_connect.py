import MetaTrader5 as mt5
if mt5.initialize():
    print("MT5 connected OK")
    for sym in ["XAUUSD", "BTCUSD"]:
        info = mt5.symbol_info(sym)
        if info:
            mt5.symbol_select(sym, True)
            rates = mt5.copy_rates_from_pos(sym, mt5.TIMEFRAME_M5, 0, 5)
            if rates is not None and len(rates) > 0:
                print(f"  {sym}: {len(rates)} bars, last close={rates[-1]['close']:.2f}")
            else:
                print(f"  {sym}: no bars returned")
        else:
            print(f"  {sym}: NOT FOUND in MT5")
    mt5.shutdown()
else:
    print(f"MT5 connect FAILED: {mt5.last_error()}")
