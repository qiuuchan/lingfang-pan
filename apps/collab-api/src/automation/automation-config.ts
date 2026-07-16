export type AutomationProcessRole = 'api' | 'dispatcher' | 'worker' | 'scheduler' | 'all';

export interface AutomationConfig {
  readonly enabled: boolean;
  readonly cloudManualEnabled: boolean;
  readonly schedulesEnabled: boolean;
  readonly processRole: AutomationProcessRole;
  readonly redisUrl: string | null;
  readonly redisPrefix: string;
  readonly connectsToRedis: boolean;
  readonly runsOutboxDispatcher: boolean;
  readonly runsWorker: boolean;
  readonly runsScheduler: boolean;
  readonly onceMisfireWindowMs: number;
  readonly consecutiveFailureNotifyThreshold: number;
  readonly teamMaxActiveRuns: number;
  readonly workflowMaxActiveRuns: number;
  readonly teamMaxActiveInvocations: number;
  readonly actionMaxActiveInvocations: number;
  readonly teamMaxUsagePerMinute: number;
  readonly actionMaxUsagePerMinute: number;
}

export interface AutomationRedisConnection {
  disconnect?(): Promise<void>;
}

export type AutomationRedisConnectionFactory<T extends AutomationRedisConnection> = (
  redisUrl: string,
) => T;

const DISABLED_CONFIG: AutomationConfig = Object.freeze({
  enabled: false,
  cloudManualEnabled: false,
  schedulesEnabled: false,
  processRole: 'api',
  redisUrl: null,
  redisPrefix: 'lf:automation',
  connectsToRedis: false,
  runsOutboxDispatcher: false,
  runsWorker: false,
  runsScheduler: false,
  onceMisfireWindowMs: 15 * 60 * 1000,
  consecutiveFailureNotifyThreshold: 3,
  teamMaxActiveRuns: 10,
  workflowMaxActiveRuns: 5,
  teamMaxActiveInvocations: 50,
  actionMaxActiveInvocations: 20,
  teamMaxUsagePerMinute: 600,
  actionMaxUsagePerMinute: 120,
});

export function resolveAutomationConfig(env: NodeJS.ProcessEnv = process.env): AutomationConfig {
  const enabled = parseBooleanSwitch(env.AUTOMATION_ENABLED, 'AUTOMATION_ENABLED');
  // Feature-off must remain independent from automation role and Redis configuration. This
  // lets the ordinary API boot even when stale worker-only variables are invalid.
  if (!enabled) return DISABLED_CONFIG;

  const processRole = parseProcessRole(env.AUTOMATION_PROCESS_ROLE);
  const connectsToRedis = processRole !== 'api';
  const redisUrl = connectsToRedis ? requireAutomationRedisUrl(env.AUTOMATION_REDIS_URL) : null;
  const redisPrefix = parseAutomationRedisPrefix(env.AUTOMATION_REDIS_PREFIX);
  return {
    enabled: true,
    cloudManualEnabled: parseBooleanSwitch(env.CLOUD_MANUAL_ENABLED, 'CLOUD_MANUAL_ENABLED'),
    schedulesEnabled: parseBooleanSwitch(env.SCHEDULES_ENABLED, 'SCHEDULES_ENABLED'),
    processRole,
    redisUrl,
    redisPrefix,
    connectsToRedis,
    runsOutboxDispatcher: processRole === 'dispatcher' || processRole === 'all',
    runsWorker: processRole === 'worker' || processRole === 'all',
    runsScheduler: processRole === 'scheduler' || processRole === 'all',
    onceMisfireWindowMs: parsePositiveInteger(env.AUTOMATION_ONCE_MISFIRE_WINDOW_MS, 'AUTOMATION_ONCE_MISFIRE_WINDOW_MS', 15 * 60 * 1000),
    consecutiveFailureNotifyThreshold: parsePositiveInteger(env.AUTOMATION_CONSECUTIVE_FAILURE_NOTIFY_THRESHOLD, 'AUTOMATION_CONSECUTIVE_FAILURE_NOTIFY_THRESHOLD', 3),
    teamMaxActiveRuns: parsePositiveInteger(env.AUTOMATION_TEAM_MAX_ACTIVE_RUNS, 'AUTOMATION_TEAM_MAX_ACTIVE_RUNS', 10),
    workflowMaxActiveRuns: parsePositiveInteger(env.AUTOMATION_WORKFLOW_MAX_ACTIVE_RUNS, 'AUTOMATION_WORKFLOW_MAX_ACTIVE_RUNS', 5),
    teamMaxActiveInvocations: parsePositiveInteger(env.AUTOMATION_TEAM_MAX_ACTIVE_INVOCATIONS, 'AUTOMATION_TEAM_MAX_ACTIVE_INVOCATIONS', 50),
    actionMaxActiveInvocations: parsePositiveInteger(env.AUTOMATION_ACTION_MAX_ACTIVE_INVOCATIONS, 'AUTOMATION_ACTION_MAX_ACTIVE_INVOCATIONS', 20),
    teamMaxUsagePerMinute: parsePositiveInteger(env.AUTOMATION_TEAM_MAX_USAGE_PER_MINUTE, 'AUTOMATION_TEAM_MAX_USAGE_PER_MINUTE', 600),
    actionMaxUsagePerMinute: parsePositiveInteger(env.AUTOMATION_ACTION_MAX_USAGE_PER_MINUTE, 'AUTOMATION_ACTION_MAX_USAGE_PER_MINUTE', 120),
  };
}

function parsePositiveInteger(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function parseAutomationRedisPrefix(raw: string | undefined): string {
  const value = raw?.trim() || 'lf:automation';
  if (value.length > 96 || !/^[A-Za-z0-9:_-]+$/.test(value)) {
    throw new Error('AUTOMATION_REDIS_PREFIX must contain only letters, numbers, colon, underscore or hyphen and be at most 96 characters');
  }
  return value;
}

/**
 * Lazily creates the automation Redis dependency only for infrastructure roles.
 * Passing a factory instead of constructing a client in module scope is the feature-off barrier.
 */
export function createAutomationRedisConnection<T extends AutomationRedisConnection>(
  config: AutomationConfig,
  factory: AutomationRedisConnectionFactory<T>,
): T | null {
  if (!config.connectsToRedis || !config.redisUrl) return null;
  return factory(config.redisUrl);
}

function parseBooleanSwitch(raw: string | undefined, name: string): boolean {
  if (raw === undefined || raw.trim() === '') return false;
  const value = raw.trim().toLowerCase();
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new Error(`${name} must be true, false, 1 or 0`);
}

function parseProcessRole(raw: string | undefined): AutomationProcessRole {
  if (raw === undefined || raw.trim() === '') return 'api';
  const role = raw.trim().toLowerCase();
  if (role === 'api' || role === 'dispatcher' || role === 'worker' || role === 'scheduler' || role === 'all') {
    return role;
  }
  throw new Error('AUTOMATION_PROCESS_ROLE must be api, dispatcher, worker, scheduler or all');
}

function requireAutomationRedisUrl(raw: string | undefined): string {
  const value = raw?.trim();
  if (!value) throw new Error('automation infrastructure roles require AUTOMATION_REDIS_URL');
  if (!/^rediss?:\/\//i.test(value)) {
    throw new Error('AUTOMATION_REDIS_URL must start with redis:// or rediss://');
  }
  return value;
}
