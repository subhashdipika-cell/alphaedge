#!/bin/bash

echo ""
echo "  ============================================================"
echo "   AlphaEdge AI Trading Platform v3.0 — Setup"
echo "  ============================================================"
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "  [ERROR] Node.js is NOT installed."
    echo ""
    echo "  Install it from: https://nodejs.org"
    echo "  Or with nvm:  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash"
    echo "                nvm install --lts"
    echo ""
    exit 1
fi

NODE_VER=$(node --version)
echo "  [OK] Node.js $NODE_VER detected."

# Check npm
if ! command -v npm &> /dev/null; then
    echo "  [ERROR] npm not found. Please reinstall Node.js."
    exit 1
fi

NPM_VER=$(npm --version)
echo "  [OK] npm $NPM_VER detected."
echo ""

# Install dependencies
echo "  Installing dependencies..."
echo "  (This may take 1-2 minutes on first run)"
echo ""

npm install

if [ $? -ne 0 ]; then
    echo ""
    echo "  [ERROR] npm install failed. Check your internet connection."
    exit 1
fi

echo ""
echo "  ============================================================"
echo "   Setup complete! Starting AlphaEdge..."
echo "  ============================================================"
echo ""
echo "  The app will open at: http://localhost:3000"
echo "  Press Ctrl+C to stop the server."
echo ""

npm run dev
