export {
  logEvent,
  logSyncEvent,
  logHealthEvent,
  logRestartEvent,
  logErrorEvent,
  logOOMEvent,
  getRecentEvents,
} from './events';
export type { PlatformEvent, EventType } from './events';

export {
  createIssue,
  getUnresolvedIssues,
  getRecentIssues,
  getIssue,
  resolveIssue,
  getIssueCounts,
  cleanupOldIssues,
} from './issues';
export type {
  PlatformIssue,
  CreateIssueInput,
  IssueType,
  IssueSeverity,
  D1Database,
} from './issues';
