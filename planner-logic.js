/**
 * The planner's date handling, kept apart from the DOM so it can be checked
 * without a browser.
 *
 * Every bug this module exists to prevent was a timezone bug. Two rules hold
 * throughout:
 *
 *   A due date is a calendar day ("2026-09-01"), not an instant. It is never
 *   put through `new Date(string)`, because that parses the date-only form as
 *   UTC midnight and then renders it in local time, showing the previous day
 *   for anyone west of Greenwich.
 *
 *   A reminder is a local wall-clock time ("2026-09-01T09:00"), also not an
 *   instant. Nine in the morning means nine in the morning wherever the student
 *   is; converting it to UTC and back moves it.
 */

const pad = (n) => String(n).padStart(2, '0');

/** A Date to its local calendar day, as "YYYY-MM-DD". */
export function ymdFromDate(date) {
    if (!date || Number.isNaN(date.getTime())) return null;
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** "YYYY-MM-DD" to local midnight on that day. */
export function parseDateYMD(ymd) {
    const parts = String(ymd || '').split('-');
    if (parts.length !== 3) return null;
    const y = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10) - 1;
    const d = parseInt(parts[2], 10);
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
    const date = new Date(y, m, d);
    return Number.isNaN(date.getTime()) ? null : date;
}

/** "YYYY-MM-DDTHH:mm" to that local time. */
export function parseLocalDateTime(value) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(value || ''));
    if (!m) return null;
    const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0, 0);
    return Number.isNaN(d.getTime()) ? null : d;
}

/** The inverse of parseLocalDateTime. Never goes through UTC. */
export function formatLocalDateTime(date) {
    if (!date || Number.isNaN(date.getTime())) return null;
    return `${ymdFromDate(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Local midnight on the Monday of that date's week. */
export function startOfWeekMon(date) {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    d.setHours(0, 0, 0, 0);
    return d;
}

/** The due date one interval on from `ymd`. */
export function getNextRepeatDate(ymd, repeat) {
    const d = parseDateYMD(ymd);
    if (!d || !repeat) return ymd;
    const n = repeat.n || 1;
    if (repeat.unit === 'days') d.setDate(d.getDate() + n);
    else if (repeat.unit === 'weeks') d.setDate(d.getDate() + n * 7);
    else if (repeat.unit === 'months') d.setMonth(d.getMonth() + n);
    return ymdFromDate(d);
}

/**
 * The reminder one interval on from `reminder`, keeping the same wall-clock
 * time. Returns null when there is nothing to carry forward.
 */
export function nextRepeatReminder(reminder, repeat) {
    const d = parseLocalDateTime(reminder);
    if (!d || !repeat) return null;
    const n = repeat.n || 1;
    if (repeat.unit === 'days') d.setDate(d.getDate() + n);
    else if (repeat.unit === 'weeks') d.setDate(d.getDate() + n * 7);
    else if (repeat.unit === 'months') d.setMonth(d.getMonth() + n);
    else return null;
    return formatLocalDateTime(d);
}

/** How a due date is labelled on a task row. */
export function formatTaskDateDisplay(ymd, today = new Date()) {
    const d = parseDateYMD(ymd);
    if (!d) return '';

    const shift = (days) => {
        const t = new Date(today.getFullYear(), today.getMonth(), today.getDate());
        t.setDate(t.getDate() + days);
        return ymdFromDate(t);
    };

    if (ymd === shift(0)) return 'Today';
    if (ymd === shift(1)) return 'Tomorrow';
    if (ymd === shift(-1)) return 'Yesterday';

    // A weekday name is only unambiguous inside the current week.
    if (startOfWeekMon(d).getTime() === startOfWeekMon(today).getTime()) {
        return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
    }
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// A Map rather than an object literal: `'constructor' in {}` is true, so a
// plain object would accept "!constructor" as a weekday.
const DAY_KEYWORDS = new Map([
    ['sunday', 0], ['sun', 0],
    ['monday', 1], ['mon', 1],
    ['tuesday', 2], ['tue', 2],
    ['wednesday', 3], ['wed', 3],
    ['thursday', 4], ['thu', 4],
    ['friday', 5], ['fri', 5],
    ['saturday', 6], ['sat', 6],
]);

/**
 * Pulls date shortcuts like "!today" or "!friday" out of a task name.
 *
 * Only words this understands are removed. The previous version stripped every
 * !word before deciding whether it meant anything, so "Buy milk !urgent" became
 * "Buy milk" and the student had no way to tell where the text went.
 */
export function parseTaskKeywords(text, base = new Date()) {
    let dueDate = null;

    const cleanText = String(text ?? '').replace(/\s*!(\w+)/g, (match, word) => {
        const keyword = word.toLowerCase();
        const d = new Date(base.getFullYear(), base.getMonth(), base.getDate());

        if (keyword === 'today') {
            dueDate = ymdFromDate(d);
        } else if (keyword === 'tomorrow') {
            d.setDate(d.getDate() + 1);
            dueDate = ymdFromDate(d);
        } else if (keyword === 'nextweek') {
            d.setDate(d.getDate() + 7);
            dueDate = ymdFromDate(d);
        } else if (DAY_KEYWORDS.has(keyword)) {
            // The next such weekday, never today: "!friday" on a Friday means
            // the Friday coming.
            const shift = (DAY_KEYWORDS.get(keyword) - d.getDay() + 7) % 7 || 7;
            d.setDate(d.getDate() + shift);
            dueDate = ymdFromDate(d);
        } else {
            // Not a date shortcut, so it belongs to the task name.
            return match;
        }
        return '';
    }).trim();

    return { cleanText, dueDate };
}
