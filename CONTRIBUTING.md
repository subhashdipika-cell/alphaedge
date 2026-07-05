# Contributing to AlphaEdge

Thanks for taking a look! This is a personal project, but the notes below keep
the codebase consistent if you (or future you) come back to it.

## Getting set up

```bash
npm install      # install dependencies
npm run dev      # start the dev server at http://localhost:3000
```

## Before you commit

```bash
npm run format   # auto-format with Prettier
npm run lint      # check for problems with ESLint
npm run build     # make sure the production build still compiles
```

## Code style

- Formatting is handled by **Prettier** (`.prettierrc.json`) — don't hand-format.
- Linting rules live in `eslint.config.js`.
- Indent with 2 spaces, single quotes, semicolons.

## Project layout

```
alphaedge/
├── index.html            # app shell + global styles
├── src/
│   ├── main.jsx          # entry point (mounts <App/> inside <ErrorBoundary/>)
│   ├── ErrorBoundary.jsx # catches render errors so the app never blanks out
│   └── App.jsx           # all pages and logic (see "Roadmap" below)
├── public/assets/        # static images (logo)
├── vite.config.js        # build/dev configuration
└── dist/                 # production build output (generated)
```

## Roadmap / good next steps

- **Split `App.jsx`.** It currently holds every page in one file. Pulling each
  page into `src/pages/` and the shared helpers (AI caller, Telegram, candle
  fetcher) into `src/lib/` would make changes far safer.
- **Backend key proxy.** See [`SECURITY.md`](./SECURITY.md) before any public
  deployment.
- **Tests.** No automated tests yet; the detection engine and risk math are good
  first candidates.
