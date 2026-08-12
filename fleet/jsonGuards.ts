import type {FleetLogLevel} from '../shared/logging/logger.ts';

export function hasErrorCode(error: unknown, expected: string): boolean {
  return isRecord(error) && error.code === expected;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(new Date(value).getTime());
}

export function isFleetLogLevel(value: unknown): value is FleetLogLevel {
  return value === 'summary' || value === 'verbose' || value === 'debug';
}
