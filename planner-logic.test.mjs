/**
 * Checks for the planner's date handling. Pure functions only, no browser and
 * no database: run with `node taskplanner-cs3/planner-logic.test.mjs`.
 *
 * Most of these exist because the behaviour they pin down was previously wrong.
 * Run this with TZ set to a few zones -- America/Toronto and Asia/Tokyo either
 * side of UTC are the useful pair -- because every bug here was a timezone bug
 * that looked fine from whichever side the author happened to be on.
 */

import assert from 'node:assert/strict';
import {
    ymdFromDate,
    parseDateYMD,
    parseLocalDateTime,
    formatLocalDateTime,
    getNextRepeatDate,
    nextRepeatReminder,
    formatTaskDateDisplay,
    parseTaskKeywords,
} from './planner-logic.js';

let passed = 0;
let failed = 0;

function check(name, fn) {
    try {
        fn();
        passed++;
    } catch (err) {
        failed++;
        console.error(`  FAIL  ${name}\n        ${err.message}`);
    }
}

// ---------------------------------------------------------------- round trips

check('a calendar date survives a parse and format round trip', () => {
    for (const ymd of ['2026-01-01', '2026-06-15', '2026-12-31', '2024-02-29']) {
        assert.equal(ymdFromDate(parseDateYMD(ymd)), ymd);
    }
});

check('a due date is not shifted by the timezone', () => {
    // The old code did `new Date("2026-09-01").toLocaleDateString()`, which
    // parses as UTC midnight and renders local: a day early west of Greenwich.
    const d = parseDateYMD('2026-09-01');
    assert.equal(d.getFullYear(), 2026);
    assert.equal(d.getMonth(), 8);
    assert.equal(d.getDate(), 1);
    assert.equal(d.getHours(), 0);
});

check('a reminder keeps its wall-clock time through a round trip', () => {
    for (const value of ['2026-09-01T09:00', '2026-01-01T00:00', '2026-12-31T23:59']) {
        assert.equal(formatLocalDateTime(parseLocalDateTime(value)), value);
    }
});

check('malformed dates give null rather than an invalid Date', () => {
    for (const bad of ['', null, undefined, 'tomorrow', '2026-09', '2026-09-01T09']) {
        assert.equal(parseLocalDateTime(bad), null, `parseLocalDateTime(${bad})`);
    }
    for (const bad of ['', null, undefined, 'nope', '2026-09']) {
        assert.equal(parseDateYMD(bad), null, `parseDateYMD(${bad})`);
    }
});

// ------------------------------------------------------------------- repeats

check('a repeating due date advances by the interval', () => {
    assert.equal(getNextRepeatDate('2026-09-01', { n: 1, unit: 'days' }), '2026-09-02');
    assert.equal(getNextRepeatDate('2026-09-01', { n: 2, unit: 'weeks' }), '2026-09-15');
    assert.equal(getNextRepeatDate('2026-09-01', { n: 1, unit: 'months' }), '2026-10-01');
});

check('a repeating due date crosses a month and a year boundary', () => {
    assert.equal(getNextRepeatDate('2026-01-31', { n: 1, unit: 'days' }), '2026-02-01');
    assert.equal(getNextRepeatDate('2026-12-31', { n: 1, unit: 'days' }), '2027-01-01');
});

check('a repeating reminder keeps the same hour on every cycle', () => {
    // The bug: the next occurrence was written with toISOString(), so a 09:00
    // reminder came back as 13:00 in Toronto, then 17:00, drifting by the UTC
    // offset each time it repeated.
    let reminder = '2026-09-01T09:00';
    for (let i = 0; i < 6; i++) {
        reminder = nextRepeatReminder(reminder, { n: 1, unit: 'weeks' });
        assert.ok(reminder.endsWith('T09:00'), `cycle ${i + 1} drifted to ${reminder}`);
    }
    assert.equal(reminder, '2026-10-13T09:00');
});

check('a repeating reminder holds its hour across a DST change', () => {
    // Toronto springs forward on 2026-03-08. A student who set 09:00 wants 09:00
    // on both sides of it, not 08:00 or 10:00.
    let reminder = '2026-03-01T09:00';
    for (let i = 0; i < 3; i++) {
        reminder = nextRepeatReminder(reminder, { n: 1, unit: 'weeks' });
        assert.ok(reminder.endsWith('T09:00'), `drifted to ${reminder}`);
    }
    assert.equal(reminder, '2026-03-22T09:00');
});

check('a task with no reminder gets no reminder on repeat', () => {
    assert.equal(nextRepeatReminder(null, { n: 1, unit: 'days' }), null);
    assert.equal(nextRepeatReminder('2026-09-01T09:00', null), null);
});

// ------------------------------------------------------------------ keywords

const MON = new Date(2026, 8, 7, 14, 30); // Monday 2026-09-07

check('!today and !tomorrow set the right due date', () => {
    assert.deepEqual(parseTaskKeywords('Essay !today', MON), {
        cleanText: 'Essay', dueDate: '2026-09-07',
    });
    assert.deepEqual(parseTaskKeywords('Essay !tomorrow', MON), {
        cleanText: 'Essay', dueDate: '2026-09-08',
    });
});

check('the short forms people actually type are understood', () => {
    // None of these is a prefix of the word they shorten, which is why they
    // are listed rather than derived.
    ['!td', '!tod', '!tdy'].forEach(k => {
        assert.equal(parseTaskKeywords('x ' + k, MON).dueDate, '2026-09-07', k);
    });
    ['!tm', '!tmr', '!tmrw', '!tmw', '!tom'].forEach(k => {
        assert.equal(parseTaskKeywords('x ' + k, MON).dueDate, '2026-09-08', k);
    });
});

check('"in N days" counts forward from today', () => {
    assert.deepEqual(parseTaskKeywords('Essay !in 3 days', MON), {
        cleanText: 'Essay', dueDate: '2026-09-10',
    });
    assert.equal(parseTaskKeywords('x !in 1 day', MON).dueDate, '2026-09-08');
    assert.equal(parseTaskKeywords('x !in 2 weeks', MON).dueDate, '2026-09-21');
    assert.equal(parseTaskKeywords('x !in 1 month', MON).dueDate, '2026-10-07');
});

check('a month is matched by prefix, however it is abbreviated', () => {
    ['!september 7', '!sept 7', '!sep 7', '!septem 7', '!sep7'].forEach(k => {
        assert.equal(parseTaskKeywords('x ' + k, MON).dueDate, '2026-09-07', k);
    });
    // An ordinal suffix is allowed, and dropped with the rest.
    assert.deepEqual(parseTaskKeywords('Essay !oct 3rd', MON), {
        cleanText: 'Essay', dueDate: '2026-10-03',
    });
});

check('a month already gone means the one coming', () => {
    // Asked in September, March means next March, not the one just past.
    assert.equal(parseTaskKeywords('x !mar 1', MON).dueDate, '2027-03-01');
    assert.equal(parseTaskKeywords('x !dec 25', MON).dueDate, '2026-12-25');
});

check('an ambiguous or impossible date is left in the task name', () => {
    // "j" is January, June and July, so it is not an answer.
    assert.deepEqual(parseTaskKeywords('x !j 3', MON), {
        cleanText: 'x !j 3', dueDate: null,
    });
    // February has no 31st, and inventing March 3rd would be worse than
    // leaving the text alone.
    assert.deepEqual(parseTaskKeywords('x !feb 31', MON), {
        cleanText: 'x !feb 31', dueDate: null,
    });
});

check('a number after a day keyword stays in the title', () => {
    // The month branch matches "today 2" first. The number belongs to the
    // task name, so it is handed back rather than eaten with the keyword.
    assert.deepEqual(parseTaskKeywords('Study !today 2 hours', MON), {
        cleanText: 'Study 2 hours', dueDate: '2026-09-07',
    });
});

check('a weekday keyword means the next one, never today', () => {
    assert.equal(parseTaskKeywords('x !friday', MON).dueDate, '2026-09-11');
    assert.equal(parseTaskKeywords('x !fri', MON).dueDate, '2026-09-11');
    // Monday, asked on a Monday, is the Monday coming.
    assert.equal(parseTaskKeywords('x !monday', MON).dueDate, '2026-09-14');
    assert.equal(parseTaskKeywords('x !sunday', MON).dueDate, '2026-09-13');
});

check('an unknown keyword is left in the task name', () => {
    // The bug: every !word was stripped before being understood, so this task
    // silently became "Buy milk".
    assert.deepEqual(parseTaskKeywords('Buy milk !urgent', MON), {
        cleanText: 'Buy milk !urgent', dueDate: null,
    });
    assert.deepEqual(parseTaskKeywords('Ship !v2 !today', MON), {
        cleanText: 'Ship !v2', dueDate: '2026-09-07',
    });
});

check('a keyword that collides with an inherited property is not a weekday', () => {
    // `'constructor' in {}` is true, so a plain lookup table would have taken
    // this for a weekday and produced an invalid date.
    assert.deepEqual(parseTaskKeywords('fix !constructor', MON), {
        cleanText: 'fix !constructor', dueDate: null,
    });
    assert.equal(parseTaskKeywords('fix !toString', MON).dueDate, null);
});

check('keyword parsing tolerates empty and odd input', () => {
    assert.deepEqual(parseTaskKeywords('', MON), { cleanText: '', dueDate: null });
    assert.deepEqual(parseTaskKeywords('!today', MON), { cleanText: '', dueDate: '2026-09-07' });
    assert.equal(parseTaskKeywords('a !TODAY b', MON).dueDate, '2026-09-07');
});

// ------------------------------------------------------------------- display

check('due dates near today read as words', () => {
    const today = new Date(2026, 8, 7);
    assert.equal(formatTaskDateDisplay('2026-09-07', today), 'Today');
    assert.equal(formatTaskDateDisplay('2026-09-08', today), 'Tomorrow');
    assert.equal(formatTaskDateDisplay('2026-09-06', today), 'Yesterday');
});

check('a date later in the same week reads as a weekday', () => {
    const today = new Date(2026, 8, 7); // Monday
    assert.equal(formatTaskDateDisplay('2026-09-10', today), 'Thu');
    // Saturday used to fall through to "Sep 12" while Mon-Fri showed a weekday.
    assert.equal(formatTaskDateDisplay('2026-09-12', today), 'Sat');
    assert.equal(formatTaskDateDisplay('2026-09-13', today), 'Sun');
});

check('a date outside this week does not read as a weekday', () => {
    const today = new Date(2026, 8, 7);
    const label = formatTaskDateDisplay('2026-09-21', today);
    assert.ok(!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/.test(label), `got ${label}`);
});

check('the label near midnight follows the date it is given', () => {
    // Every "today" comparison reads the clock when asked. When this was
    // captured once at page load, a tab left open overnight called yesterday
    // "Today" until it was reloaded.
    assert.equal(formatTaskDateDisplay('2026-09-08', new Date(2026, 8, 7, 23, 59)), 'Tomorrow');
    assert.equal(formatTaskDateDisplay('2026-09-08', new Date(2026, 8, 8, 0, 1)), 'Today');
});

// ----------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed  (TZ=${process.env.TZ || 'system default'})\n`);
process.exit(failed === 0 ? 0 : 1);
