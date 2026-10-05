import type { OpeningHoursRule } from "../../business/index.js";

export interface LocalDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

const formatterFor = (timezone: string): Intl.DateTimeFormat => {
  const existing = formatterCache.get(timezone);
  if (existing) return existing;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  formatterCache.set(timezone, formatter);
  return formatter;
};

export const localParts = (date: Date, timezone: string): LocalDateTimeParts => {
  const parts = formatterFor(timezone).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return { year: value("year"), month: value("month"), day: value("day"), hour: value("hour"), minute: value("minute") };
};

export const toUtc = (local: LocalDateTimeParts, timezone: string): Date => {
  // One offset correction is wrong when the guess and the real instant sit on
  // opposite sides of a DST transition (a 7 AM opening can land an hour later).
  // Repeat until the rendered clinic-local time matches, and reject gaps such
  // as the skipped spring-forward hour instead of silently shifting them.
  let utc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  const desired = utc;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const rendered = localParts(new Date(utc), timezone);
    const actual = Date.UTC(rendered.year, rendered.month - 1, rendered.day, rendered.hour, rendered.minute);
    if (desired === actual) return new Date(utc);
    utc += desired - actual;
  }
  const rendered = localParts(new Date(utc), timezone);
  const matches = rendered.year === local.year && rendered.month === local.month
    && rendered.day === local.day && rendered.hour === local.hour && rendered.minute === local.minute;
  return matches ? new Date(utc) : new Date(Number.NaN);
};

/**
 * Converts an ISO datetime to an instant without ever consulting the host
 * computer's timezone. A datetime without an offset is clinic-local; a datetime
 * with Z or an explicit offset already identifies an instant.
 */
export const normalizeDateTimeForTimezone = (value: string, timezone: string): Date | null => {
  const local = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?$/);
  if (local) {
    const year = Number(local[1]);
    const month = Number(local[2]);
    const day = Number(local[3]);
    const hour = Number(local[4]);
    const minute = Number(local[5]);
    const candidate = toUtc({ year, month, day, hour, minute }, timezone);
    return Number.isNaN(candidate.valueOf()) ? null : candidate;
  }
  const instant = new Date(value);
  return Number.isNaN(instant.valueOf()) ? null : instant;
};

/** Formats an instant as an offset-aware clinic-local datetime for Google Calendar. */
export const dateTimeInTimezone = (value: Date, timezone: string): { dateTime: string; timeZone: string } => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((item) => item.type === type)?.value);
  const year = part("year");
  const month = part("month");
  const day = part("day");
  const hour = part("hour");
  const minute = part("minute");
  const second = part("second");
  const offsetMinutes = Math.round((Date.UTC(year, month - 1, day, hour, minute, second) - value.valueOf()) / 60_000);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(offsetMinutes);
  const offset = `${String(Math.floor(absoluteOffset / 60)).padStart(2, "0")}:${String(absoluteOffset % 60).padStart(2, "0")}`;
  return {
    dateTime: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}${sign}${offset}`,
    timeZone: timezone,
  };
};

export const minuteOfDay = (time: string): number => {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
};

export const rulesForDay = (rules: OpeningHoursRule[], dayOfWeek: number): OpeningHoursRule[] =>
  rules.filter((rule) => rule.dayOfWeek === dayOfWeek);

export const intersects = (start: Date, end: Date, intervals: Array<{ startAt: string; endAt: string }>): boolean =>
  intervals.some((interval) => {
    const intervalStart = new Date(interval.startAt);
    const intervalEnd = new Date(interval.endAt);
    return intervalStart < end && start < intervalEnd;
  });
