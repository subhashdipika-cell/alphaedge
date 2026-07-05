# Building the AlphaEdge installers

You get **two** setup files, both produced by one script:

| File | Size | What the user needs |
|------|------|---------------------|
| `AlphaEdge_Setup_Online.exe` | small (~5 MB) | Internet during first launch. Downloads Node.js + packages automatically. |
| `AlphaEdge_Setup_Offline_SelfContained.exe` | large (~80 MB) | Nothing. Node.js runtime + all packages are bundled. Works with no internet. |

Both install the same app and run the same way: a Vite dev server at **http://localhost:3000**.
**Node.js is NOT required on the user's PC** — the installer manages it.

---

## One-time setup on YOUR build PC (not the user's)

Install these once, on the machine where you build the installers:

1. **NSIS** — https://nsis.sourceforge.io → keep defaults during install.
   Make sure `makensis.exe` is on your PATH (usually `C:\Program Files (x86)\NSIS`).
2. **Node.js 18+ LTS** — https://nodejs.org → used to run `npm install` during build.
3. **Internet** — needed once, to download the portable Node.js runtime for the offline installer.

---

## Build (one click)

From the project root (`D:\alphaedge`), double-click:

```
build_installers.bat
```

It will:
1. Run `npm install` (ensures `node_modules` is complete for the offline snapshot).
2. Build the **online** installer (small, no bundled runtime).
3. Download the portable Node.js v20 runtime zip.
4. Snapshot `node_modules` into `build_assets\node_modules_snapshot\`.
5. Build the **offline** installer (self-contained, ~80 MB).

When it finishes, both `.exe` files are in **`installer_output\`**.

---

## Installing on a new PC

1. Copy the chosen `.exe` to the new PC.
2. Run it (right-click → *Run as administrator* if prompted by UAC).
3. On the last wizard screen, leave **"Run first-time setup"** ticked and click Finish.
   - **Online**: downloads Node.js + packages (~2-3 min, internet required).
   - **Offline**: unpacks the bundled runtime + copies packages (~1-2 min, no internet needed).
4. Launch from **Start Menu → AlphaEdge → Start AlphaEdge**.
   The app opens at **http://localhost:3000**.

---

## Optional: custom icon

NSIS requires an `.ico` file (not PNG). To add a custom icon:
1. Convert `public/assets/alphaedge-logo-sidebar.png` to `alphaedge.ico`.
2. Place it at `installer/alphaedge.ico`.
3. Uncomment the `!define MUI_ICON` line in `ae_online.nsi` and `ae_offline.nsi`.

---

## Notes & troubleshooting

- **`makensis not found`**: Add `C:\Program Files (x86)\NSIS` to your PATH.
- **Rebuilding offline bundle**: delete `build_assets\node_modules_snapshot\` and
  `build_assets\node-win-x64.zip` to force a fresh download and snapshot.
- The `node_modules` folder is intentionally **excluded** from the online installer —
  it is created fresh on the user's PC by the setup script.
- The offline installer bundles a snapshot of `node_modules` taken at build time.
  If `package.json` changes, delete the snapshot and rebuild.
- **MT5 bridge**: the `mt5-bridge\` folder is included in both installers. It starts
  automatically alongside the app. Requires MetaTrader 5 to be open and logged in.
