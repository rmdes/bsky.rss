#!/bin/bash
# Quick deployment script for Railway

set -e

echo "🚀 Deploying bsky.rss to Railway..."

# Check if railway CLI is installed
if ! command -v railway &> /dev/null; then
    echo "❌ Railway CLI is not installed. Installing..."
    npm i -g @railway/cli
fi

# Check if user is logged in
if ! railway whoami &> /dev/null; then
    echo "🔐 Please log in to Railway:"
    railway login
fi

# Initialize project if needed
if [ ! -f "railway.json" ]; then
    echo "📦 Initializing Railway project..."
    railway init
fi

# Set environment variables
echo "🔑 Setting environment variables..."
echo "Enter your Bluesky IDENTIFIER (username or email):"
read -r IDENTIFIER
railway variables set IDENTIFIER="$IDENTIFIER"

echo "Enter your Bluesky APP_PASSWORD:"
read -rs APP_PASSWORD
railway variables set APP_PASSWORD="$APP_PASSWORD"

echo ""
echo "Enter your RSS FETCH_URL:"
read -r FETCH_URL
railway variables set FETCH_URL="$FETCH_URL"

railway variables set INSTANCE_URL="https://bsky.social"
railway variables set HEALTH_CHECK_PORT="8080"

# Deploy
echo "🚢 Deploying..."
railway up

echo ""
echo "✅ Deployment complete!"
echo ""
echo "📊 View in dashboard: railway open"
echo "📝 View logs: railway logs"
echo ""
