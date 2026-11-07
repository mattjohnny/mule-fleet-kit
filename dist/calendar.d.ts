/** A business day as its calendar date, `YYYY-MM-DD`. */
export type BusinessDay = string;
/**
 * The business day an instant belongs to: 4 a.m. to 4 a.m. Toronto time, so a
 * sale or a punch after midnight belongs to the day before.
 */
export declare function businessDayOf(instant: Date | number): BusinessDay;
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
/**
 * Pre-fill a fiscal year from P1's first day: thirteen straight 28-day periods,
 * Tuesday to Monday, 364 days in all. An Ops user confirms or changes the
 * dates; this is only the starting point.
 */
export declare function prefillFiscalYear(p1Start: BusinessDay): FiscalYear;
/**
 * Add the 53rd week to a fiscal year: P13 ends seven days later and nothing
 * else moves. An Ops user's deliberate choice, made before P13 starts; never
 * automatic. Refuses a year whose P13 is already longer than four weeks.
 */
export declare function addWeek53(year: FiscalYear): FiscalYear;
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
export declare function periodOf(day: BusinessDay, calendar: FiscalYear | readonly FiscalYear[]): CalendarPeriod | undefined;
