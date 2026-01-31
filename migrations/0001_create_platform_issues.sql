-- Platform Issues table for tracking problems across the platform
-- Used for alerting and debugging

CREATE TABLE IF NOT EXISTS platform_issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,              -- 'sync_failure', 'health_failure', 'restart', 'oom', 'error'
    severity TEXT NOT NULL,          -- 'critical', 'high', 'medium', 'low'
    user_id TEXT,                    -- User ID if applicable
    message TEXT NOT NULL,           -- Human-readable description
    details TEXT,                    -- JSON blob for extra context
    resolved INTEGER DEFAULT 0,      -- 0 = unresolved, 1 = resolved
    resolved_at TEXT,                -- ISO timestamp when resolved
    resolved_by TEXT,                -- Who resolved it (user ID or 'auto')
    created_at TEXT DEFAULT (datetime('now'))
);

-- Index for querying unresolved issues
CREATE INDEX IF NOT EXISTS idx_platform_issues_unresolved
    ON platform_issues(resolved, created_at DESC);

-- Index for querying by user
CREATE INDEX IF NOT EXISTS idx_platform_issues_user
    ON platform_issues(user_id, created_at DESC);

-- Index for querying by type
CREATE INDEX IF NOT EXISTS idx_platform_issues_type
    ON platform_issues(type, created_at DESC);
