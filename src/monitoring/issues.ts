/**
 * Platform issues tracking using D1 database
 * Records and manages issues for alerting and debugging
 */

/**
 * Issue types
 */
export type IssueType =
  | 'sync_failure'
  | 'health_failure'
  | 'restart'
  | 'oom'
  | 'error'
  | 'config_error';

/**
 * Issue severity levels
 */
export type IssueSeverity = 'critical' | 'high' | 'medium' | 'low';

/**
 * Platform issue record
 */
export interface PlatformIssue {
  id: number;
  type: IssueType;
  severity: IssueSeverity;
  userId?: string;
  message: string;
  details?: Record<string, unknown>;
  resolved: boolean;
  resolvedAt?: string;
  resolvedBy?: string;
  createdAt: string;
}

/**
 * Input for creating a new issue
 */
export interface CreateIssueInput {
  type: IssueType;
  severity: IssueSeverity;
  userId?: string;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * D1 database binding type
 */
export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<D1ExecResult>;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(colName?: string): Promise<T | null>;
  all<T = unknown>(): Promise<D1Result<T>>;
  run(): Promise<D1Result<unknown>>;
}

interface D1Result<T> {
  success: boolean;
  results: T[];
  meta: {
    last_row_id?: number;
    changes?: number;
  };
}

interface D1ExecResult {
  count: number;
}

/**
 * Create a new platform issue
 */
export async function createIssue(
  db: D1Database,
  input: CreateIssueInput
): Promise<number | null> {
  try {
    const result = await db
      .prepare(
        `INSERT INTO platform_issues (type, severity, user_id, message, details)
         VALUES (?, ?, ?, ?, ?)`
      )
      .bind(
        input.type,
        input.severity,
        input.userId || null,
        input.message,
        input.details ? JSON.stringify(input.details) : null
      )
      .run();

    console.log(`[Issues] Created issue: ${input.type} - ${input.message}`);
    return result.meta.last_row_id ?? null;
  } catch (err) {
    console.error('[Issues] Failed to create issue:', err);
    return null;
  }
}

/**
 * Get unresolved issues
 */
export async function getUnresolvedIssues(
  db: D1Database,
  options: { limit?: number; userId?: string; type?: IssueType } = {}
): Promise<PlatformIssue[]> {
  const { limit = 50, userId, type } = options;

  let query = 'SELECT * FROM platform_issues WHERE resolved = 0';
  const params: unknown[] = [];

  if (userId) {
    query += ' AND user_id = ?';
    params.push(userId);
  }
  if (type) {
    query += ' AND type = ?';
    params.push(type);
  }

  query += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);

  try {
    const stmt = db.prepare(query);
    const result = await stmt.bind(...params).all<RawIssueRow>();
    return result.results.map(parseIssueRow);
  } catch (err) {
    console.error('[Issues] Failed to get unresolved issues:', err);
    return [];
  }
}

/**
 * Get recent issues (resolved and unresolved)
 */
export async function getRecentIssues(
  db: D1Database,
  options: { limit?: number; userId?: string } = {}
): Promise<PlatformIssue[]> {
  const { limit = 50, userId } = options;

  let query = 'SELECT * FROM platform_issues';
  const params: unknown[] = [];

  if (userId) {
    query += ' WHERE user_id = ?';
    params.push(userId);
  }

  query += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);

  try {
    const stmt = db.prepare(query);
    const result = await stmt.bind(...params).all<RawIssueRow>();
    return result.results.map(parseIssueRow);
  } catch (err) {
    console.error('[Issues] Failed to get recent issues:', err);
    return [];
  }
}

/**
 * Get issue by ID
 */
export async function getIssue(
  db: D1Database,
  id: number
): Promise<PlatformIssue | null> {
  try {
    const row = await db
      .prepare('SELECT * FROM platform_issues WHERE id = ?')
      .bind(id)
      .first<RawIssueRow>();
    return row ? parseIssueRow(row) : null;
  } catch (err) {
    console.error('[Issues] Failed to get issue:', err);
    return null;
  }
}

/**
 * Resolve an issue
 */
export async function resolveIssue(
  db: D1Database,
  id: number,
  resolvedBy?: string
): Promise<boolean> {
  try {
    await db
      .prepare(
        `UPDATE platform_issues
         SET resolved = 1, resolved_at = datetime('now'), resolved_by = ?
         WHERE id = ?`
      )
      .bind(resolvedBy || 'manual', id)
      .run();

    console.log(`[Issues] Resolved issue #${id}`);
    return true;
  } catch (err) {
    console.error('[Issues] Failed to resolve issue:', err);
    return false;
  }
}

/**
 * Get issue counts by type (for dashboard)
 */
export async function getIssueCounts(
  db: D1Database
): Promise<Record<string, { total: number; unresolved: number }>> {
  try {
    const result = await db
      .prepare(
        `SELECT type,
                COUNT(*) as total,
                SUM(CASE WHEN resolved = 0 THEN 1 ELSE 0 END) as unresolved
         FROM platform_issues
         GROUP BY type`
      )
      .all<{ type: string; total: number; unresolved: number }>();

    const counts: Record<string, { total: number; unresolved: number }> = {};
    for (const row of result.results) {
      counts[row.type] = { total: row.total, unresolved: row.unresolved };
    }
    return counts;
  } catch (err) {
    console.error('[Issues] Failed to get issue counts:', err);
    return {};
  }
}

/**
 * Clean up old resolved issues (older than N days)
 */
export async function cleanupOldIssues(
  db: D1Database,
  olderThanDays: number = 30
): Promise<number> {
  try {
    const result = await db
      .prepare(
        `DELETE FROM platform_issues
         WHERE resolved = 1
         AND created_at < datetime('now', '-' || ? || ' days')`
      )
      .bind(olderThanDays)
      .run();

    const deleted = result.meta.changes ?? 0;
    if (deleted > 0) {
      console.log(`[Issues] Cleaned up ${deleted} old resolved issues`);
    }
    return deleted;
  } catch (err) {
    console.error('[Issues] Failed to cleanup old issues:', err);
    return 0;
  }
}

// Helper types and functions

interface RawIssueRow {
  id: number;
  type: string;
  severity: string;
  user_id: string | null;
  message: string;
  details: string | null;
  resolved: number;
  resolved_at: string | null;
  resolved_by: string | null;
  created_at: string;
}

function parseIssueRow(row: RawIssueRow): PlatformIssue {
  return {
    id: row.id,
    type: row.type as IssueType,
    severity: row.severity as IssueSeverity,
    userId: row.user_id || undefined,
    message: row.message,
    details: row.details ? JSON.parse(row.details) : undefined,
    resolved: row.resolved === 1,
    resolvedAt: row.resolved_at || undefined,
    resolvedBy: row.resolved_by || undefined,
    createdAt: row.created_at,
  };
}
