/**
 * Structured event logging for the platform
 * Events can be sent to Analytics Engine for metrics and dashboards
 */

/**
 * Platform event types
 */
export type EventType =
  | 'request'
  | 'error'
  | 'sync'
  | 'health'
  | 'restart'
  | 'oom'
  | 'auth';

/**
 * Structured platform event
 */
export interface PlatformEvent {
  type: EventType;
  userId?: string;
  duration?: number;
  success: boolean;
  details?: Record<string, unknown>;
  timestamp?: string;
}

/**
 * Event buffer for batching writes (for future Analytics Engine integration)
 */
const eventBuffer: PlatformEvent[] = [];
const MAX_BUFFER_SIZE = 100;

/**
 * Log a platform event
 * Currently logs to console, can be extended to Analytics Engine
 */
export function logEvent(event: PlatformEvent): void {
  const timestamp = event.timestamp || new Date().toISOString();
  const eventWithTimestamp = { ...event, timestamp };

  // Buffer event
  eventBuffer.push(eventWithTimestamp);
  if (eventBuffer.length > MAX_BUFFER_SIZE) {
    eventBuffer.shift();
  }

  // Log to console with structured format
  const prefix = event.success ? '[EVENT]' : '[EVENT:FAIL]';
  const userIdShort = event.userId ? event.userId.slice(0, 8) : '-';
  const durationStr = event.duration !== undefined ? `${event.duration}ms` : '-';

  console.log(
    `${prefix} type=${event.type} user=${userIdShort} success=${event.success} duration=${durationStr}`,
    event.details ? JSON.stringify(event.details) : ''
  );
}

/**
 * Get recent events (for debugging)
 */
export function getRecentEvents(limit: number = 50): PlatformEvent[] {
  return eventBuffer.slice(-limit);
}

/**
 * Helper to log a sync event
 */
export function logSyncEvent(
  userId: string,
  success: boolean,
  durationMs: number,
  details?: { fileCount?: number; error?: string; syncId?: string }
): void {
  logEvent({
    type: 'sync',
    userId,
    success,
    duration: durationMs,
    details,
  });
}

/**
 * Helper to log a health check event
 */
export function logHealthEvent(
  userId: string,
  healthy: boolean,
  details?: {
    consecutiveFailures?: number;
    processRunning?: boolean;
    portReachable?: boolean;
    uptimeSeconds?: number;
  }
): void {
  logEvent({
    type: 'health',
    userId,
    success: healthy,
    details,
  });
}

/**
 * Helper to log a restart event
 */
export function logRestartEvent(
  userId: string,
  success: boolean,
  reason: string,
  details?: { previousFailures?: number }
): void {
  logEvent({
    type: 'restart',
    userId,
    success,
    details: { reason, ...details },
  });
}

/**
 * Helper to log an error event
 */
export function logErrorEvent(
  error: string,
  userId?: string,
  details?: Record<string, unknown>
): void {
  logEvent({
    type: 'error',
    userId,
    success: false,
    details: { error, ...details },
  });
}

/**
 * Helper to log an OOM event
 */
export function logOOMEvent(userId: string, details?: Record<string, unknown>): void {
  logEvent({
    type: 'oom',
    userId,
    success: false,
    details,
  });
}
