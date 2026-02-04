#!/bin/bash
# Startup script for Moltbot in Cloudflare Sandbox
# v3: Fixed concurrent startup race condition with lockfile
# This script:
# 1. Restores config from R2 backup if available
# 2. Configures moltbot from environment variables
# 3. Starts the gateway

set -e

STARTUP_LOCK="/tmp/moltbot-startup.lock"

# Use flock to prevent concurrent startup attempts
# If another startup is in progress, wait up to 30s then exit
exec 200>"$STARTUP_LOCK"
if ! flock -w 30 200; then
    echo "Another startup is in progress, exiting."
    exit 0
fi

echo "=== Moltbot Startup $(date -Iseconds) ==="

# Check if openclaw gateway is already running - bail early if so
if pgrep -f "openclaw gateway" > /dev/null 2>&1; then
    echo "Moltbot gateway is already running, exiting."
    exit 0
fi

# ZOMBIE KILLER: Aggressively clean up any stale gateway processes
# This prevents the "port 18789 already in use" crash loop
echo "Checking for zombie processes..."

# Kill any openclaw processes (graceful then force)
pkill -f "openclaw gateway" 2>/dev/null || true
sleep 1
pkill -9 -f "openclaw" 2>/dev/null || true

# Kill anything on port 18789
fuser -k 18789/tcp 2>/dev/null || true

# Clear all lock files (except our startup lock)
rm -f /tmp/openclaw*.lock /root/.openclaw/*.lock /tmp/openclaw-gateway.lock 2>/dev/null || true

# Wait for cleanup
sleep 2

# Double-check no gateway started while we were cleaning up
if pgrep -f "openclaw gateway" > /dev/null 2>&1; then
    echo "Gateway started during cleanup, exiting."
    exit 0
fi

# Paths
CONFIG_DIR="/root/.openclaw"
CONFIG_FILE="$CONFIG_DIR/openclaw.json"
TEMPLATE_DIR="/root/.openclaw-templates"
TEMPLATE_FILE="$TEMPLATE_DIR/moltbot.json.template"
# Base R2 mount path - user data is in subdirectories
R2_MOUNT="/data/openclaw"

# Determine user-specific backup directory
if [ -n "$OPENCLAW_USER_ID" ]; then
    BACKUP_DIR="$R2_MOUNT/users/$OPENCLAW_USER_ID"
    echo "User ID: $OPENCLAW_USER_ID"
else
    # Fallback for legacy single-user mode
    BACKUP_DIR="$R2_MOUNT"
fi

echo "Config directory: $CONFIG_DIR"
echo "Backup directory: $BACKUP_DIR"

# Wait for R2 mount to be available (async mount can take a few seconds)
echo "Waiting for R2 mount..."
R2_WAIT=0
while [ ! -d "$R2_MOUNT" ] && [ $R2_WAIT -lt 30 ]; do
    sleep 1
    R2_WAIT=$((R2_WAIT + 1))
    echo "Waiting for R2... ($R2_WAIT/30)"
done

if [ -d "$R2_MOUNT" ]; then
    echo "R2 mounted at $R2_MOUNT"
    ls -la "$R2_MOUNT" | head -5
else
    echo "R2 mount not available after 30s, continuing without backup restore"
fi

# Create config directory
mkdir -p "$CONFIG_DIR"

# ============================================================
# RESTORE FROM R2 BACKUP
# ============================================================
# Check if R2 backup exists by looking for openclaw.json (or legacy clawdbot.json)
# The BACKUP_DIR may exist but be empty if R2 was just mounted
# Note: backup structure is $BACKUP_DIR/openclaw/ (or legacy $BACKUP_DIR/clawdbot/) and $BACKUP_DIR/skills/

# Helper function to parse ISO timestamp to epoch seconds (POSIX-compatible)
# Handles formats: "syncId|2024-01-15T10:30:00Z" or "2024-01-15T10:30:00+00:00"
parse_timestamp_to_epoch() {
    local input="$1"

    # If input contains |, extract the timestamp part (new format: syncId|timestamp)
    if echo "$input" | grep -q '|'; then
        input=$(echo "$input" | cut -d'|' -f2)
    fi

    # Try GNU date first (Linux)
    local epoch=$(date -d "$input" +%s 2>/dev/null)
    if [ -n "$epoch" ] && [ "$epoch" != "0" ]; then
        echo "$epoch"
        return 0
    fi

    # Try BSD date (macOS) - requires different format
    # Convert ISO format to BSD-compatible format
    local bsd_date=$(echo "$input" | sed 's/T/ /; s/\+00:00//; s/Z//')
    epoch=$(date -j -f "%Y-%m-%d %H:%M:%S" "$bsd_date" +%s 2>/dev/null)
    if [ -n "$epoch" ] && [ "$epoch" != "0" ]; then
        echo "$epoch"
        return 0
    fi

    # Fallback: extract just the date part and use simple comparison
    # Extract YYYYMMDDHHMMSS for numeric comparison
    local simple=$(echo "$input" | sed 's/[^0-9]//g' | cut -c1-14)
    if [ -n "$simple" ]; then
        echo "$simple"
        return 0
    fi

    echo "0"
    return 1
}

# Helper function to check if R2 backup is newer than local
should_restore_from_r2() {
    local R2_SYNC_FILE="$BACKUP_DIR/.last-sync"
    local LOCAL_SYNC_FILE="$CONFIG_DIR/.last-sync"

    # If no R2 sync timestamp, don't restore
    if [ ! -f "$R2_SYNC_FILE" ]; then
        echo "No R2 sync timestamp found, skipping restore"
        return 1
    fi

    # If no local sync timestamp, restore from R2
    if [ ! -f "$LOCAL_SYNC_FILE" ]; then
        echo "No local sync timestamp, will restore from R2"
        return 0
    fi

    # Read timestamps
    R2_TIME=$(cat "$R2_SYNC_FILE" 2>/dev/null)
    LOCAL_TIME=$(cat "$LOCAL_SYNC_FILE" 2>/dev/null)

    echo "R2 last sync: $R2_TIME"
    echo "Local last sync: $LOCAL_TIME"

    # Convert to epoch seconds for comparison using portable function
    R2_EPOCH=$(parse_timestamp_to_epoch "$R2_TIME")
    LOCAL_EPOCH=$(parse_timestamp_to_epoch "$LOCAL_TIME")

    echo "R2 epoch: $R2_EPOCH, Local epoch: $LOCAL_EPOCH"

    if [ "$R2_EPOCH" -gt "$LOCAL_EPOCH" ]; then
        echo "R2 backup is newer, will restore"
        return 0
    else
        echo "Local data is newer or same, skipping restore"
        return 1
    fi
}

# Check if we should restore from R2 ONCE before modifying any local state
SHOULD_RESTORE=false
if should_restore_from_r2; then
    SHOULD_RESTORE=true
fi

# Restore config from R2 backup
if [ -f "$BACKUP_DIR/openclaw/openclaw.json" ]; then
    if [ "$SHOULD_RESTORE" = true ]; then
        echo "Restoring from R2 backup at $BACKUP_DIR/openclaw..."
        cp -a "$BACKUP_DIR/openclaw/." "$CONFIG_DIR/"
        echo "Restored config from R2 backup"
    fi
elif [ -f "$BACKUP_DIR/clawdbot/clawdbot.json" ]; then
    # Legacy backup format (clawdbot naming)
    if [ "$SHOULD_RESTORE" = true ]; then
        echo "Restoring from legacy R2 backup at $BACKUP_DIR/clawdbot..."
        cp -a "$BACKUP_DIR/clawdbot/." "$CONFIG_DIR/"
        echo "Restored config from legacy R2 backup"
    fi
elif [ -f "$BACKUP_DIR/clawdbot.json" ]; then
    # Legacy backup format (flat structure)
    if [ "$SHOULD_RESTORE" = true ]; then
        echo "Restoring from legacy flat R2 backup at $BACKUP_DIR..."
        cp -a "$BACKUP_DIR/." "$CONFIG_DIR/"
        echo "Restored config from legacy flat R2 backup"
    fi
elif [ -d "$BACKUP_DIR" ]; then
    echo "R2 mounted at $BACKUP_DIR but no backup data found yet"
else
    echo "R2 not mounted, starting fresh"
fi

# Restore workspace from R2 backup if available
# This includes scripts, skills, and any other user files in /root/clawd/
WORKSPACE_DIR="/root/openclaw"
if [ -d "$BACKUP_DIR/workspace" ] && [ "$(ls -A $BACKUP_DIR/workspace 2>/dev/null)" ]; then
    if [ "$SHOULD_RESTORE" = true ]; then
        echo "Restoring workspace from $BACKUP_DIR/workspace..."
        mkdir -p "$WORKSPACE_DIR"
        cp -a "$BACKUP_DIR/workspace/." "$WORKSPACE_DIR/"
        echo "Restored workspace from R2 backup"
    fi
elif [ -d "$BACKUP_DIR/skills" ] && [ "$(ls -A $BACKUP_DIR/skills 2>/dev/null)" ]; then
    # Legacy fallback: restore just skills if no workspace backup exists
    if [ "$SHOULD_RESTORE" = true ]; then
        echo "Restoring skills from legacy $BACKUP_DIR/skills..."
        mkdir -p "$WORKSPACE_DIR/skills"
        cp -a "$BACKUP_DIR/skills/." "$WORKSPACE_DIR/skills/"
        echo "Restored skills from legacy R2 backup"
    fi
fi

# Copy sync timestamp AFTER all restores complete
if [ "$SHOULD_RESTORE" = true ]; then
    cp -f "$BACKUP_DIR/.last-sync" "$CONFIG_DIR/.last-sync" 2>/dev/null || true
    echo "Marked local state as synced with R2"
fi

# If config file still doesn't exist, create from template
if [ ! -f "$CONFIG_FILE" ]; then
    echo "No existing config found, initializing from template..."
    if [ -f "$TEMPLATE_FILE" ]; then
        cp "$TEMPLATE_FILE" "$CONFIG_FILE"
    else
        # Create minimal config if template doesn't exist
        cat > "$CONFIG_FILE" << 'EOFCONFIG'
{
  "agents": {
    "defaults": {
      "workspace": "/root/openclaw"
    }
  },
  "gateway": {
    "port": 18789,
    "mode": "local"
  }
}
EOFCONFIG
    fi
else
    echo "Using existing config"
fi

# ============================================================
# UPDATE CONFIG FROM ENVIRONMENT VARIABLES
# ============================================================
node << EOFNODE
const fs = require('fs');

const configPath = '/root/.openclaw/openclaw.json';
console.log('Updating config at:', configPath);
let config = {};

try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (e) {
    console.log('Starting with empty config');
}

// Ensure nested objects exist
config.agents = config.agents || {};
config.agents.defaults = config.agents.defaults || {};
config.agents.defaults.model = config.agents.defaults.model || {};
config.gateway = config.gateway || {};
config.channels = config.channels || {};

// Gateway configuration
config.gateway.port = 18789;
config.gateway.mode = 'local';
config.gateway.trustedProxies = ['10.1.0.0'];

// Set gateway token if provided - use token-only auth mode (no device pairing required)
if (process.env.OPENCLAW_GATEWAY_TOKEN) {
    config.gateway.auth = config.gateway.auth || {};
    config.gateway.auth.mode = 'token';  // Token-only auth, skip device pairing
    config.gateway.auth.token = process.env.OPENCLAW_GATEWAY_TOKEN;
}

// Allow insecure auth - we're behind Cloudflare proxy (HTTPS to users, HTTP internally)
// This is safe because the external connection is secure, the gateway just can't see it
config.gateway.controlUi = config.gateway.controlUi || {};
config.gateway.controlUi.allowInsecureAuth = true;

// Channel configuration (Telegram, Discord, Slack) is managed by the bot itself
// via the control UI and persisted to R2. We don't override it here.

// Base URL override (e.g., for Cloudflare AI Gateway)
// Usage: Set AI_GATEWAY_BASE_URL or ANTHROPIC_BASE_URL to your endpoint like:
//   https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/anthropic
//   https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/openai
const baseUrl = (process.env.AI_GATEWAY_BASE_URL || process.env.ANTHROPIC_BASE_URL || '').replace(/\/+$/, '');
const isOpenAI = baseUrl.endsWith('/openai');

if (isOpenAI) {
    // Create custom openai provider config with baseUrl override
    // Omit apiKey so moltbot falls back to OPENAI_API_KEY env var
    console.log('Configuring OpenAI provider with base URL:', baseUrl);
    config.models = config.models || {};
    config.models.providers = config.models.providers || {};
    config.models.providers.openai = {
        baseUrl: baseUrl,
        api: 'openai-responses',
        models: [
            { id: 'gpt-5.2', name: 'GPT-5.2', contextWindow: 200000 },
            { id: 'gpt-5', name: 'GPT-5', contextWindow: 200000 },
            { id: 'gpt-4.5-preview', name: 'GPT-4.5 Preview', contextWindow: 128000 },
        ]
    };
    // Add models to the allowlist so they appear in /models
    config.agents.defaults.models = config.agents.defaults.models || {};
    config.agents.defaults.models['openai/gpt-5.2'] = { alias: 'GPT-5.2' };
    config.agents.defaults.models['openai/gpt-5'] = { alias: 'GPT-5' };
    config.agents.defaults.models['openai/gpt-4.5-preview'] = { alias: 'GPT-4.5' };
    config.agents.defaults.model.primary = 'openai/gpt-5.2';
} else if (baseUrl) {
    console.log('Configuring Anthropic provider with base URL:', baseUrl);
    config.models = config.models || {};
    config.models.providers = config.models.providers || {};
    const providerConfig = {
        baseUrl: baseUrl,
        api: 'anthropic-messages',
        models: [
            { id: 'claude-opus-4-5-20251101', name: 'Claude Opus 4.5', contextWindow: 200000 },
            { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5', contextWindow: 200000 },
            { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', contextWindow: 200000 },
        ]
    };
    // Include API key in provider config if set (required when using custom baseUrl)
    if (process.env.ANTHROPIC_API_KEY) {
        providerConfig.apiKey = process.env.ANTHROPIC_API_KEY;
    }
    config.models.providers.anthropic = providerConfig;
    // Add models to the allowlist so they appear in /models
    config.agents.defaults.models = config.agents.defaults.models || {};
    config.agents.defaults.models['anthropic/claude-opus-4-5-20251101'] = { alias: 'Opus 4.5' };
    config.agents.defaults.models['anthropic/claude-sonnet-4-5-20250929'] = { alias: 'Sonnet 4.5' };
    config.agents.defaults.models['anthropic/claude-haiku-4-5-20251001'] = { alias: 'Haiku 4.5' };
    config.agents.defaults.model.primary = 'anthropic/claude-opus-4-5-20251101';
} else {
    // Default to Anthropic without custom base URL (uses built-in pi-ai catalog)
    config.agents.defaults.model.primary = 'anthropic/claude-opus-4-5';
}

// Write updated config
fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log('Configuration updated successfully');
console.log('Channels configured:', Object.keys(config.channels || {}).join(', ') || 'none');
EOFNODE

# ============================================================
# SHUTDOWN HANDLER (Zero-Data-Loss Protection)
# ============================================================
# This ensures data is synced to R2 before container shutdown

SHUTDOWN_IN_PROGRESS=false
SHUTDOWN_SYNC_COMPLETE=false

shutdown_handler() {
    if [ "$SHUTDOWN_IN_PROGRESS" = true ]; then
        echo "[shutdown] Shutdown already in progress, waiting..."
        return
    fi
    
    SHUTDOWN_IN_PROGRESS=true
    echo "[shutdown] Received shutdown signal, initiating emergency sync..."
    echo "[shutdown] Signal received at $(date -Iseconds)"
    
    # Give the gateway a moment to finish any in-flight requests
    sleep 2
    
    # Sync critical files to R2 if R2 is mounted
    if [ -d "$R2_MOUNT" ] && [ -d "$BACKUP_DIR" ]; then
        echo "[shutdown] Syncing critical files to R2..."
        
        # Sync credentials directory
        if [ -d "$CONFIG_DIR/credentials" ]; then
            echo "[shutdown] Syncing credentials..."
            rsync -r --no-times --delete "$CONFIG_DIR/credentials/" "$BACKUP_DIR/openclaw/credentials/" 2>/dev/null || true
        fi
        
        # Sync main config file
        if [ -f "$CONFIG_FILE" ]; then
            echo "[shutdown] Syncing openclaw.json..."
            rsync -r --no-times --delete "$CONFIG_FILE" "$BACKUP_DIR/openclaw/openclaw.json" 2>/dev/null || true
        fi
        
        # Sync .registered marker
        if [ -f "$CONFIG_DIR/.registered" ]; then
            echo "[shutdown] Syncing .registered marker..."
            rsync -r --no-times --delete "$CONFIG_DIR/.registered" "$BACKUP_DIR/openclaw/.registered" 2>/dev/null || true
        fi
        
        # Update sync timestamp
        echo "shutdown-$(date -Iseconds)" > "$BACKUP_DIR/.last-sync-shutdown"
        cp -f "$BACKUP_DIR/.last-sync-shutdown" "$CONFIG_DIR/.last-sync" 2>/dev/null || true
        
        echo "[shutdown] Critical files synced successfully"
        SHUTDOWN_SYNC_COMPLETE=true
    else
        echo "[shutdown] R2 not available, skipping sync"
    fi
    
    # Signal completion
    touch /tmp/shutdown-sync-complete 2>/dev/null || true
    echo "[shutdown] Shutdown sync complete at $(date -Iseconds)"
    
    # Allow time for sync to complete before exiting
    sleep 1
}

# Register signal handlers
trap shutdown_handler SIGTERM SIGINT

# ============================================================
# START GATEWAY
# ============================================================
# Note: R2 backup sync is handled by the Worker's cron trigger
echo "Starting Moltbot Gateway..."
echo "Gateway will be available on port 18789"

# Clean up stale lock files
rm -f /tmp/openclaw-gateway.lock 2>/dev/null || true
rm -f "$CONFIG_DIR/gateway.lock" 2>/dev/null || true

BIND_MODE="lan"
echo "Dev mode: ${OPENCLAW_DEV_MODE:-false}, Bind mode: $BIND_MODE"

if [ -n "$OPENCLAW_GATEWAY_TOKEN" ]; then
    echo "Starting gateway with token auth..."
    exec openclaw gateway --port 18789 --verbose --allow-unconfigured --bind "$BIND_MODE" --token "$OPENCLAW_GATEWAY_TOKEN"
else
    echo "Starting gateway with device pairing (no token)..."
    exec openclaw gateway --port 18789 --verbose --allow-unconfigured --bind "$BIND_MODE"
fi
