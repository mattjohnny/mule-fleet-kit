// The business calendar: the fleet's trading day and the thirteen-period fiscal
// year (day-one standard 6; End of Period Reporting ADR 0001).
//
// It holds no state. The confirmed fiscal-year and period dates are data an app
// stores; this module only does the arithmetic that needs no stored state.
//
// A business day is written as its calendar date, `YYYY-MM-DD`: the day the
// trading day starts on. Business-day arithmetic is done on those dates in UTC,
// where every day is 24 hours long, so daylight-saving changes cannot shift it.

/** A business day as its calendar date, `YYYY-MM-DD`. */
export type BusinessDay = string;

const ZONE = "America/Toronto";
const BOUNDARY_HOUR = 4;
const DAY_MS = 86_400_000;

const torontoParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
});

/**
 * The business day an instant belongs to: 4 a.m. to 4 a.m. Toronto time, so a
 * sale or a punch after midnight belongs to the day before.
 */
export function businessDayOf(instant: Date | number): BusinessDay {
  if (!(instant instanceof Date) && typeof instant !== "number") {
    throw new TypeError("businessDayOf takes a Date or epoch milliseconds");
  }
  const ms = instant instanceof Date ? instant.getTime() : instant;
  if (!Number.isFinite(ms)) throw new RangeError("businessDayOf needs a valid instant");

  const parts = Object.fromEntries(
    torontoParts.formatToParts(ms).map((part) => [part.type, part.value]),
  );
  const torontoDate = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
  const before = Number(parts.hour) < BOUNDARY_HOUR;
  return toDay(before ? torontoDate - DAY_MS : torontoDate);
}

/** One period: its number in the fiscal year and its first and last business days. */
export interface Period {
  readonly period: number;
  /** The first business day, a Tuesday. */
  readonly start: BusinessDay;
  /** The last business day, inclusive: a Monday. */
  readonly end: BusinessDay;
}

/** A fiscal year: thirteen periods, named by the calendar year it ends in. */
export interface FiscalYear {
  readonly fiscalYear: number;
  readonly periods: readonly Period[];
}

const PERIODS = 13;
const PERIOD_DAYS = 28;
const WEEK_53_DAYS = 7;
const MONDAY = 1;
const TUESDAY = 2;

/**
 * Pre-fill a fiscal year from P1's first day: thirteen straight 28-day periods,
 * Tuesday to Monday, 364 days in all. An Ops user confirms or changes the
 * dates; this is only the starting point.
 */
export function prefillFiscalYear(p1Start: BusinessDay): FiscalYear {
  const first = parseDay(p1Start, "prefillFiscalYear");
  if (new Date(first).getUTCDay() !== TUESDAY) {
    throw new RangeError(`P1 must start on a Tuesday; ${p1Start} is not`);
  }
  const periods = Array.from({ length: PERIODS }, (_, index) => {
    const start = first + index * PERIOD_DAYS * DAY_MS;
    return Object.freeze({
      period: index + 1,
      start: toDay(start),
      end: toDay(start + (PERIOD_DAYS - 1) * DAY_MS),
    });
  });
  return fiscalYearOf(periods);
}

/**
 * Add the 53rd week to a fiscal year: P13 ends seven days later and nothing
 * else moves. An Ops user's deliberate choice, made before P13 starts; never
 * automatic. Refuses a year whose P13 is already longer than four weeks.
 */
export function addWeek53(year: FiscalYear): FiscalYear {
  const periods = readFiscalYear(year, "addWeek53");
  const p13 = periods[PERIODS - 1];
  const p13End = parseDay(p13.end, "addWeek53");
  if (p13End - parseDay(p13.start, "addWeek53") + DAY_MS > PERIOD_DAYS * DAY_MS) {
    throw new RangeError(`FY${year.fiscalYear} P13 is already longer than four weeks`);
  }
  const longer = Object.freeze({ period: PERIODS, start: p13.start, end: toDay(p13End + WEEK_53_DAYS * DAY_MS) });
  return fiscalYearOf([...periods.slice(0, PERIODS - 1), longer]);
}

/** A period as {@link periodOf} answers it: which fiscal year, which period, its dates. */
export interface CalendarPeriod extends Period {
  readonly fiscalYear: number;
}

/**
 * The period a business day falls in, for a given calendar (one fiscal year or
 * several), or `undefined` when the calendar does not cover that day. Turn an
 * instant into a business day with {@link businessDayOf} first. Refuses a
 * calendar whose periods or fiscal years overlap or leave a gap inside a year.
 */
export function periodOf(
  day: BusinessDay,
  calendar: FiscalYear | readonly FiscalYear[],
): CalendarPeriod | undefined {
  const target = parseDay(day, "periodOf");
  const years: readonly FiscalYear[] = Array.isArray(calendar) ? calendar : [calendar as FiscalYear];
  const spans = years
    .map((year) => {
      const periods = readFiscalYear(year, "periodOf");
      return {
        year,
        periods,
        start: parseDay(periods[0].start, "periodOf"),
        end: parseDay(periods[PERIODS - 1].end, "periodOf"),
      };
    })
    .sort((a, b) => a.start - b.start);
  spans.forEach((span, index) => {
    if (index > 0 && span.start <= spans[index - 1].end) {
      throw new RangeError("periodOf: the calendar's fiscal years overlap");
    }
  });

  const span = spans.find((candidate) => candidate.start <= target && target <= candidate.end);
  if (!span) return undefined;
  const period = span.periods.find((candidate) => parseDay(candidate.end, "periodOf") >= target)!;
  return Object.freeze({
    fiscalYear: span.year.fiscalYear,
    period: period.period,
    start: period.start,
    end: period.end,
  });
}

// A fiscal year's periods, refusing anything that is not thirteen contiguous
// Tuesday-to-Monday periods numbered 1 to 13. Lengths are not checked: Ops may
// confirm dates other than the pre-fill's.
function readFiscalYear(year: unknown, caller: string): readonly Period[] {
  const periods = (year as { periods?: unknown } | null | undefined)?.periods;
  if (typeof year !== "object" || year === null || !Array.isArray(periods)) {
    throw new TypeError(`${caller} takes a fiscal year`);
  }
  if (periods.length !== PERIODS) {
    throw new RangeError(`${caller}: a fiscal year has ${PERIODS} periods, not ${periods.length}`);
  }
  let previousEnd: number | undefined;
  periods.forEach((period: Period, index) => {
    const start = parseDay(period?.start, caller);
    const end = parseDay(period?.end, caller);
    if (period.period !== index + 1) throw new RangeError(`${caller}: period ${index + 1} is numbered ${period.period}`);
    if (new Date(start).getUTCDay() !== TUESDAY || new Date(end).getUTCDay() !== MONDAY || end < start) {
      throw new RangeError(`${caller}: P${index + 1} must run Tuesday to Monday`);
    }
    if (previousEnd !== undefined && start !== previousEnd + DAY_MS) {
      throw new RangeError(`${caller}: P${index + 1} does not start the day after P${index} ends`);
    }
    previousEnd = end;
  });
  return periods as readonly Period[];
}

function fiscalYearOf(periods: readonly Period[]): FiscalYear {
  return Object.freeze({
    fiscalYear: Number(periods[periods.length - 1].end.slice(0, 4)),
    periods: Object.freeze(periods),
  });
}

const DAY_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

// A business day's UTC midnight, refusing anything that is not a real date.
function parseDay(day: unknown, caller: string): number {
  if (typeof day !== "string") throw new TypeError(`${caller} takes a YYYY-MM-DD business day`);
  const ms = DAY_SHAPE.test(day) ? Date.parse(`${day}T00:00:00Z`) : Number.NaN;
  if (!Number.isFinite(ms) || toDay(ms) !== day) {
    throw new RangeError(`${caller} needs a real YYYY-MM-DD date; got ${JSON.stringify(day)}`);
  }
  return ms;
}

function toDay(utcMidnight: number): BusinessDay {
  return new Date(utcMidnight).toISOString().slice(0, 10);
}
