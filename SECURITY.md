# Security Notes

AlphaEdge is a **client-side** application: it runs entirely in your browser and
talks directly to third-party APIs (Anthropic / OpenRouter / Gemini / Groq, the
Dhan broker, Telegram, and various price feeds).

## How API keys are stored

Keys you enter in **Settings** are saved in the browser's `localStorage` and sent
straight from your browser to each provider. This is convenient and works well
when you run the app **locally on your own computer**.

## ⚠️ Do not deploy publicly with keys in the browser

If you host the built `dist/` folder on a public URL, **anyone who opens the page
can read your keys** out of the browser and use them on your accounts (running up
AI charges, placing broker requests, or posting to your Telegram bot).

If you want a hosted version, put a thin backend in front:

1. Keep all secrets in server-side environment variables (never in client code).
2. Expose a single endpoint like `POST /api/signal` that your frontend calls.
3. The backend adds the secret key and forwards the request to the provider.

## Other notes

- The Dhan quote call currently routes through a public CORS proxy
  (`allorigins.win`). That proxy can see anything passed through it, including
  your broker token — avoid using it with real credentials.
- This software is for research and education. It is **not financial advice**.
  Backtested results do not guarantee live performance. Trade at your own risk.

## Reporting

This is a personal project. If you spot a security issue, open an issue describing
the problem (without including any real keys or tokens).
