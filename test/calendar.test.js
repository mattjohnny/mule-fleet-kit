// The business calendar: the 4 a.m. Toronto business day and the thirteen-period
// fiscal year (End of Period Reporting spec §1, ADR 0001).
//
// Expected values come from three independent sources, never from the module's
// own arithmetic: worked dates from the glossary and spec, an explicit
// statement of Toronto's daylight-saving rule (an oracle that does not use the
// Intl time-zone database the module uses), and day-of-week facts checked
// against a calendar.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { addWeek53, businessDayOf, periodOf, prefillFiscalYear } from "../dist/index.js";

// --- an oracle that knows nothing about Intl ---------------------------------

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// The n-th Sunday of a month, as a UTC day number.
function nthSunday(year, monthIndex, n) {
  const first = Date.UTC(year, monthIndex, 1);
  const firstSunday = first + ((7 - new Date(first).getUTCDay()) % 7) * DAY;
  return firstSunday + (n - 1) * 7 * DAY;
}

// Toronto since 2007: daylight time from 2 a.m. EST on the second Sunday of
// March (07:00Z) to 2 a.m. EDT on the first Sunday of November (06:00Z).
function torontoOffsetHours(ms) {
  const year = new Date(ms).getUTCFullYear();
  const start = nthSunday(year, 2, 2) + 7 * HOUR;
  const end = nthSunday(year, 10, 1) + 6 * HOUR;
  return ms >= start && ms < end ? -4 : -5;
}

function oracleBusinessDay(ms) {
  const wall = ms + torontoOffsetHours(ms) * HOUR - 4 * HOUR;
  return new Date(wall).toISOString().slice(0, 10);
}

// A small seeded generator, so a failing property names a reproducible case.
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const at = (iso) => new Date(iso);

// --- the business day --------------------------------------------------------

describe("business day: 4 a.m. to 4 a.m. Toronto time", () => {
  it("a sale after midnight belongs to the day before", () => {
    // 1:30 a.m. EST on Wed Jan 14, 2026 is 06:30Z.
    assert.equal(businessDayOf(at("2026-01-14T06:30:00Z")), "2026-01-13");
  });

  it("3:59:59.999 a.m. is still the day before; 4 a.m. starts the new day", () => {
    assert.equal(businessDayOf(at("2026-01-14T08:59:59.999Z")), "2026-01-13");
    assert.equal(businessDayOf(at("2026-01-14T09:00:00Z")), "2026-01-14");
  });

  it("the boundary is 4 a.m. Toronto in summer too, not 4 a.m. UTC or EST", () => {
    // 4 a.m. EDT is 08:00Z.
    assert.equal(businessDayOf(at("2026-07-14T07:59:59.999Z")), "2026-07-13");
    assert.equal(businessDayOf(at("2026-07-14T08:00:00Z")), "2026-07-14");
  });

  it("is correct across the spring change (Sun Mar 8, 2026)", () => {
    // Clocks jump 2 a.m. EST (07:00Z) to 3 a.m. EDT.
    assert.equal(businessDayOf(at("2026-03-08T06:59:59Z")), "2026-03-07"); // 1:59 EST
    assert.equal(businessDayOf(at("2026-03-08T07:00:00Z")), "2026-03-07"); // 3:00 EDT
    assert.equal(businessDayOf(at("2026-03-08T07:59:59.999Z")), "2026-03-07"); // 3:59 EDT
    assert.equal(businessDayOf(at("2026-03-08T08:00:00Z")), "2026-03-08"); // 4:00 EDT
  });

  it("is correct across the fall change (Sun Nov 1, 2026)", () => {
    // Clocks fall back 2 a.m. EDT (06:00Z) to 1 a.m. EST; 1:30 happens twice.
    assert.equal(businessDayOf(at("2026-11-01T05:30:00Z")), "2026-10-31"); // 1:30 EDT
    assert.equal(businessDayOf(at("2026-11-01T06:30:00Z")), "2026-10-31"); // 1:30 EST
    assert.equal(businessDayOf(at("2026-11-01T08:59:59.999Z")), "2026-10-31"); // 3:59 EST
    assert.equal(businessDayOf(at("2026-11-01T09:00:00Z")), "2026-11-01"); // 4:00 EST
  });

  it("a business day around a year end belongs to the right year", () => {
    // 2 a.m. EST on Jan 1, 2027 is still Dec 31, 2026's trading day.
    assert.equal(businessDayOf(at("2027-01-01T07:00:00Z")), "2026-12-31");
    assert.equal(businessDayOf(at("2027-01-01T09:00:00Z")), "2027-01-01");
  });

  it("accepts epoch milliseconds as well as a Date", () => {
    assert.equal(businessDayOf(Date.parse("2026-01-14T06:30:00Z")), "2026-01-13");
  });

  it("refuses an instant that is not a time", () => {
    assert.throws(() => businessDayOf(new Date("not a date")), RangeError);
    assert.throws(() => businessDayOf(Number.NaN), RangeError);
    assert.throws(() => businessDayOf("2026-01-14T06:30:00Z"), TypeError);
  });

  it("property: matches Toronto's written daylight-saving rule, 2007-2060", () => {
    const next = random(20261107);
    const from = Date.parse("2007-01-01T00:00:00Z");
    const to = Date.parse("2060-12-31T00:00:00Z");
    for (let i = 0; i < 20_000; i += 1) {
      const ms = Math.floor(from + next() * (to - from));
      assert.equal(businessDayOf(ms), oracleBusinessDay(ms), new Date(ms).toISOString());
    }
  });

  it("property: every changeover hour, both DST changes, 2007-2060", () => {
    for (let year = 2007; year <= 2060; year += 1) {
      for (const sunday of [nthSunday(year, 2, 2), nthSunday(year, 10, 1)]) {
        // Every minute from 10 p.m. Saturday UTC to 10 a.m. Sunday UTC.
        for (let ms = sunday - 2 * HOUR; ms <= sunday + 10 * HOUR; ms += 60_000) {
          for (const edge of [ms, ms - 1]) {
            assert.equal(businessDayOf(edge), oracleBusinessDay(edge), new Date(edge).toISOString());
          }
        }
      }
    }
  });

  it("property: business days are 24 hours, except 23 in spring and 25 in fall", () => {
    // Walk the 4 a.m. boundaries of 2026 by hour and measure each day.
    const lengths = new Map();
    let previous = businessDayOf(Date.parse("2026-01-01T12:00:00Z"));
    let started = null;
    for (let ms = Date.parse("2026-01-01T12:00:00Z"); ms < Date.parse("2027-01-01T12:00:00Z"); ms += HOUR) {
      const day = businessDayOf(ms);
      if (day !== previous) {
        assert.ok(day > previous, `business day went backwards at ${new Date(ms).toISOString()}`);
        if (started !== null) lengths.set(previous, (ms - started) / HOUR);
        started = ms;
        previous = day;
      }
    }
    assert.equal(lengths.get("2026-03-07"), 23);
    assert.equal(lengths.get("2026-10-31"), 25);
    const other = [...lengths].filter(([day]) => day !== "2026-03-07" && day !== "2026-10-31");
    assert.ok(other.length > 360);
    for (const [day, hours] of other) assert.equal(hours, 24, day);
  });
});

// --- the fiscal year ---------------------------------------------------------

const DAY_OF_WEEK = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const weekday = (day) => DAY_OF_WEEK[new Date(`${day}T00:00:00Z`).getUTCDay()];
const daysBetween = (a, b) =>
  (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY;
const plusDays = (day, n) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

// Random Tuesdays from 1990 to 2150 (Jan 2, 1990 was a Tuesday).
function randomTuesday(next) {
  return plusDays("1990-01-02", 7 * Math.floor(next() * 8_350));
}

describe("pre-fill: thirteen 28-day Tuesday-to-Monday periods from P1's start", () => {
  it("FY2027 from Tue Oct 13, 2026: P1 Oct 13 - Nov 9, 2026; P13 ends Mon Oct 11, 2027", () => {
    const year = prefillFiscalYear("2026-10-13");
    assert.equal(year.fiscalYear, 2027);
    assert.equal(year.periods.length, 13);
    assert.deepEqual(year.periods[0], { period: 1, start: "2026-10-13", end: "2026-11-09" });
    assert.deepEqual(year.periods[12], { period: 13, start: "2027-09-14", end: "2027-10-11" });
  });

  it("FY2026 from Tue Oct 14, 2025 matches the workbook: P13 = Sept 15 - Oct 12, 2026", () => {
    const year = prefillFiscalYear("2025-10-14");
    assert.equal(year.fiscalYear, 2026);
    assert.deepEqual(year.periods[0], { period: 1, start: "2025-10-14", end: "2025-11-10" });
    assert.deepEqual(year.periods[12], { period: 13, start: "2026-09-15", end: "2026-10-12" });
  });

  it("a period that crosses the calendar year end is still one 28-day period", () => {
    // FY2027 P3 runs Dec 8, 2026 to Jan 4, 2027.
    assert.deepEqual(prefillFiscalYear("2026-10-13").periods[2], {
      period: 3,
      start: "2026-12-08",
      end: "2027-01-04",
    });
  });

  it("a leap day is an ordinary day inside its period", () => {
    // FY2028 starts Tue Oct 12, 2027; Feb 29, 2028 opens P6.
    const year = prefillFiscalYear("2027-10-12");
    assert.deepEqual(year.periods[4], { period: 5, start: "2028-02-01", end: "2028-02-28" });
    assert.deepEqual(year.periods[5], { period: 6, start: "2028-02-29", end: "2028-03-27" });
  });

  it("refuses a P1 start that is not a Tuesday", () => {
    assert.throws(() => prefillFiscalYear("2026-10-12"), RangeError); // a Monday
    assert.throws(() => prefillFiscalYear("2026-10-14"), RangeError); // a Wednesday
  });

  it("refuses anything that is not a real YYYY-MM-DD date", () => {
    for (const bad of ["2026-02-30", "2026-13-01", "2026-1-13", "Oct 13, 2026", "", "2026-10-13T00:00:00Z"]) {
      assert.throws(() => prefillFiscalYear(bad), RangeError, bad);
    }
    assert.throws(() => prefillFiscalYear(new Date("2026-10-13")), TypeError);
  });

  it("property: any Tuesday gives 13 contiguous 28-day Tue-Mon periods, 364 days", () => {
    const next = random(13);
    for (let i = 0; i < 2_000; i += 1) {
      const p1Start = randomTuesday(next);
      const year = prefillFiscalYear(p1Start);
      assert.equal(year.periods.length, 13, p1Start);
      assert.equal(year.periods[0].start, p1Start);
      year.periods.forEach((p, index) => {
        assert.equal(p.period, index + 1, p1Start);
        assert.equal(weekday(p.start), "Tue", `${p1Start} P${p.period}`);
        assert.equal(weekday(p.end), "Mon", `${p1Start} P${p.period}`);
        assert.equal(daysBetween(p.start, p.end) + 1, 28, `${p1Start} P${p.period}`);
        if (index > 0) assert.equal(daysBetween(year.periods[index - 1].end, p.start), 1);
      });
      assert.equal(daysBetween(p1Start, year.periods[12].end) + 1, 364, p1Start);
      // Named by the calendar year it ends in.
      assert.equal(year.fiscalYear, Number(year.periods[12].end.slice(0, 4)), p1Start);
    }
  });

  it("property: chaining years gives an unbroken calendar across year ends", () => {
    let year = prefillFiscalYear("2025-10-14");
    for (let i = 0; i < 120; i += 1) {
      const following = prefillFiscalYear(plusDays(year.periods[12].end, 1));
      assert.equal(daysBetween(year.periods[12].end, following.periods[0].start), 1);
      // 364-day years drift a day earlier each year; over 120 years P13 still
      // ends in summer or autumn, so each name is one more than the last.
      assert.equal(following.fiscalYear, year.fiscalYear + 1);
      year = following;
    }
  });
});

// --- the 53-week year --------------------------------------------------------

describe("53-week year: the extra week goes on the end of P13", () => {
  it("FY2027 with a 53rd week: P13 runs Sept 14 - Oct 18, 2027, 35 days", () => {
    const year = addWeek53(prefillFiscalYear("2026-10-13"));
    assert.equal(year.fiscalYear, 2027);
    assert.deepEqual(year.periods[12], { period: 13, start: "2027-09-14", end: "2027-10-18" });
  });

  it("lengthens only P13, by seven days", () => {
    const before = prefillFiscalYear("2026-10-13");
    const after = addWeek53(before);
    assert.deepEqual(after.periods.slice(0, 12), before.periods.slice(0, 12));
    assert.equal(after.periods[12].start, before.periods[12].start);
    assert.equal(daysBetween(before.periods[12].end, after.periods[12].end), 7);
  });

  it("leaves the year it was given unchanged", () => {
    const before = prefillFiscalYear("2026-10-13");
    addWeek53(before);
    assert.equal(before.periods[12].end, "2027-10-11");
  });

  it("the next year's pre-fill starts the Tuesday after the longer P13", () => {
    const year = addWeek53(prefillFiscalYear("2026-10-13"));
    const next = prefillFiscalYear(plusDays(year.periods[12].end, 1));
    assert.equal(next.periods[0].start, "2027-10-19");
    assert.equal(next.fiscalYear, 2028);
  });

  it("refuses a year that already has its 53rd week", () => {
    const year = addWeek53(prefillFiscalYear("2026-10-13"));
    assert.throws(() => addWeek53(year), RangeError);
  });

  it("refuses something that is not a thirteen-period fiscal year", () => {
    const year = prefillFiscalYear("2026-10-13");
    assert.throws(() => addWeek53({ fiscalYear: 2027, periods: year.periods.slice(0, 12) }), RangeError);
    assert.throws(() => addWeek53(undefined), TypeError);
  });

  it("property: any year with a 53rd week is 371 contiguous days, P13 35, the rest 28", () => {
    const next = random(53);
    for (let i = 0; i < 2_000; i += 1) {
      const p1Start = randomTuesday(next);
      const before = prefillFiscalYear(p1Start);
      const year = addWeek53(before);
      assert.deepEqual(year.periods.slice(0, 12), before.periods.slice(0, 12), p1Start);
      year.periods.forEach((p, index) => {
        assert.equal(weekday(p.start), "Tue", `${p1Start} P${p.period}`);
        assert.equal(weekday(p.end), "Mon", `${p1Start} P${p.period}`);
        assert.equal(daysBetween(p.start, p.end) + 1, index === 12 ? 35 : 28, `${p1Start} P${p.period}`);
        if (index > 0) assert.equal(daysBetween(year.periods[index - 1].end, p.start), 1);
      });
      assert.equal(daysBetween(p1Start, year.periods[12].end) + 1, 371, p1Start);
      assert.equal(year.fiscalYear, Number(year.periods[12].end.slice(0, 4)), p1Start);
    }
  });
});

// --- which period a business day is in ---------------------------------------

describe("period of a business day, for a given calendar", () => {
  const fy2026 = prefillFiscalYear("2025-10-14");
  const fy2027 = prefillFiscalYear("2026-10-13");
  const calendar = [fy2026, fy2027];

  it("a business day inside a period", () => {
    assert.deepEqual(periodOf("2026-11-07", calendar), {
      fiscalYear: 2027,
      period: 1,
      start: "2026-10-13",
      end: "2026-11-09",
    });
  });

  it("a period's first Tuesday and last Monday both belong to it", () => {
    assert.equal(periodOf("2026-10-13", calendar).period, 1);
    assert.equal(periodOf("2026-11-09", calendar).period, 1);
    assert.equal(periodOf("2026-11-10", calendar).period, 2);
  });

  it("the Monday that ends a fiscal year and the Tuesday that starts the next", () => {
    assert.deepEqual(
      [periodOf("2026-10-12", calendar).fiscalYear, periodOf("2026-10-12", calendar).period],
      [2026, 13],
    );
    assert.deepEqual(
      [periodOf("2026-10-13", calendar).fiscalYear, periodOf("2026-10-13", calendar).period],
      [2027, 1],
    );
  });

  it("a 1:30 a.m. sale on the Tuesday a period starts is in the period before", () => {
    // 1:30 a.m. EDT on Tue Oct 13, 2026 is 05:30Z: still Monday Oct 12's trading day.
    const day = businessDayOf(at("2026-10-13T05:30:00Z"));
    assert.equal(periodOf(day, calendar).fiscalYear, 2026);
    assert.equal(periodOf(day, calendar).period, 13);
  });

  it("a day in the 53rd week belongs to P13", () => {
    const longYear = addWeek53(fy2027);
    assert.equal(periodOf("2027-10-18", [longYear]).period, 13);
    assert.equal(periodOf("2027-10-18", [fy2027]), undefined);
  });

  it("a day outside every fiscal year in the calendar has no period", () => {
    assert.equal(periodOf("2025-10-13", calendar), undefined);
    assert.equal(periodOf("2027-10-12", calendar), undefined);
    assert.equal(periodOf("2026-11-07", []), undefined);
  });

  it("takes a single fiscal year as a calendar too", () => {
    assert.equal(periodOf("2026-11-07", fy2027).period, 1);
  });

  it("refuses a calendar whose fiscal years overlap", () => {
    const shifted = prefillFiscalYear("2026-10-06");
    assert.throws(() => periodOf("2026-11-07", [fy2027, shifted]), RangeError);
  });

  it("refuses a fiscal year with a gap or an overlap between its periods", () => {
    const gap = { fiscalYear: 2027, periods: fy2027.periods.map((p) => (p.period === 2 ? { ...p, start: "2026-11-17" } : p)) };
    assert.throws(() => periodOf("2026-11-07", [gap]), RangeError);
    const overlap = { fiscalYear: 2027, periods: fy2027.periods.map((p) => (p.period === 1 ? { ...p, end: "2026-11-16" } : p)) };
    assert.throws(() => periodOf("2026-11-07", [overlap]), RangeError);
  });

  it("refuses a business day that is not a real YYYY-MM-DD date", () => {
    assert.throws(() => periodOf("2026-02-30", calendar), RangeError);
    assert.throws(() => periodOf(new Date(), calendar), TypeError);
  });

  it("property: across chained years with random 53rd weeks, every day has exactly its period", () => {
    const next = random(28);
    const years = [];
    let start = "2025-10-14";
    for (let i = 0; i < 40; i += 1) {
      const plain = prefillFiscalYear(start);
      const year = next() < 0.2 ? addWeek53(plain) : plain;
      years.push(year);
      start = plusDays(year.periods[12].end, 1);
    }
    // Every day, against the year and its neighbours (an app's usual calendar).
    years.forEach((year, index) => {
      const window = years.slice(Math.max(0, index - 1), index + 2);
      for (const p of year.periods) {
        for (let d = 0; d <= daysBetween(p.start, p.end); d += 1) {
          const day = plusDays(p.start, d);
          assert.deepEqual(periodOf(day, window), { fiscalYear: year.fiscalYear, ...p }, day);
        }
      }
    });
    // Sampled days against all forty years at once, in shuffled order.
    const shuffled = [...years].sort(() => next() - 0.5);
    for (let i = 0; i < 300; i += 1) {
      const year = years[Math.floor(next() * years.length)];
      const p = year.periods[Math.floor(next() * 13)];
      const day = plusDays(p.start, Math.floor(next() * (daysBetween(p.start, p.end) + 1)));
      assert.deepEqual(periodOf(day, shuffled), { fiscalYear: year.fiscalYear, ...p }, day);
    }
    assert.equal(periodOf(plusDays(years[0].periods[0].start, -1), years), undefined);
    assert.equal(periodOf(start, years), undefined);
  });
});
