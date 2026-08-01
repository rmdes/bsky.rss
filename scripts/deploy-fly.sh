#!/bin/bash
# Quick deployment script for Fly.io

set -e

echo "🚀 Deploying bsky.rss to Fly.io..."

# Check if fly CLI is installed
if ! command -v fly &> /dev/null; then
    echo "❌ Fly CLI is not installed. Install it from: https://fly.io/docs/hands-on/install-flyctl/"
    exit 1
fi

# Check if user is logged in
if ! fly auth whoami &> /dev/null; then
    echo "🔐 Please log in to Fly.io first:"
    fly auth login
fi

# Check if app exists
APP_NAME="bsky-rss"
if ! fly apps list | grep -q "$APP_NAME"; then
    echo "📦 Creating new Fly.io app: $APP_NAME"
    fly apps create "$APP_NAME"

    echo "💾 Creating persistent volume..."
    fly volumes create bsky_data --size 1 --region iad

    echo "🔑 Setting environment secrets..."
    echo "Enter your Bluesky IDENTIFIER (username or email):"
    read -r IDENTIFIER
    fly secrets set IDENTIFIER="$IDENTIFIER"

    echo "Enter your Bluesky APP_PASSWORD:"
    read -rs APP_PASSWORD
    fly secrets set APP_PASSWORD="$APP_PASSWORD"

    echo "Enter your RSS FETCH_URL:"
    read -r FETCH_URL
    fly secrets set FETCH_URL="$FETCH_URL"

    fly secrets set INSTANCE_URL="https://bsky.social"

    echo "✅ App created and configured!"
fi

# Deploy
echo "🚢 Deploying..."
fly deploy

echo ""
echo "✅ Deployment complete!"
echo ""
echo "📊 Check status: fly status"
echo "📝 View logs: fly logs"
echo "🏥 Health check: curl https://$APP_NAME.fly.dev/health"
echo ""
