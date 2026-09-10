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

// Everyone shortens "tomorrow" differently and almost none of the common forms
// are prefixes of the word, so they are listed rather than derived.
const TODAY_WORDS = new Set(['today', 'tod', 'tdy', 'td']);
const TOMORROW_WORDS = new Set(['tomorrow', 'tomorow', 'tomoro', 'tomo', 'tom', 'tmrw', 'tmw', 'tmr', 'tmo', 'tm']);

const MONTHS = [
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december',
];

/**
 * The month a prefix names, or null.
 *
 * Months are matched by prefix rather than against a list of abbreviations,
 * because people write Sept, Sep and Septem for the same month. A prefix that
 * fits more than one month is not an answer: "j" could be January, June or
 * July, so it is left alone rather than guessed at.
 */
export function monthFromPrefix(word) {
    const w = String(word || '').toLowerCase();
    if (!w) return null;
    const hits = [];
    for (let i = 0; i < MONTHS.length; i++) {
        if (MONTHS[i].startsWith(w)) hits.push(i);
    }
    return hits.length === 1 ? hits[0] : null;
}

/**
 * Pulls date shortcuts out of a task name.
 *
 * Understood, all after a "!":
 *   today / tod / td, and tomorrow / tmrw / tm and friends
 *   a weekday, meaning the next one and never today
 *   in 3 days, in 2 weeks, in 1 month
 *   a month and a day: sept 7, september 7, sep7, s 7
 *
 * Only what this understands is removed. Every !word used to be stripped
 * before being understood, so "Buy milk !urgent" silently became "Buy milk"
 * and the student had no way to tell where the text went.
 */
export function parseTaskKeywords(text, base = new Date()) {
    let dueDate = null;

    const midnight = () => new Date(base.getFullYear(), base.getMonth(), base.getDate());

    // "in 3 days" first, then "<word> <number>" for a month and a day, then a
    // bare word. Order matters: the bare-word branch would otherwise take the
    // "in" of "in 3 days" and leave "3 days" sitting in the title.
    const PATTERN = /\s*!(?:in\s+(\d{1,4})\s*(day|days|week|weeks|month|months)\b|([a-z]+)\s*(\d{1,2})(?:st|nd|rd|th)?\b|(\w+))/gi;

    const fromWord = (raw) => {
        const word = String(raw).toLowerCase();
        const d = midnight();
        if (TODAY_WORDS.has(word)) return ymdFromDate(d);
        if (TOMORROW_WORDS.has(word)) { d.setDate(d.getDate() + 1); return ymdFromDate(d); }
        if (DAY_KEYWORDS.has(word)) {
            // The next such weekday, never today: "!friday" on a Friday means
            // the Friday coming.
            const shift = (DAY_KEYWORDS.get(word) - d.getDay() + 7) % 7 || 7;
            d.setDate(d.getDate() + shift);
            return ymdFromDate(d);
        }
        return null;
    };

    const cleanText = String(text ?? '').replace(
        PATTERN,
        (match, inCount, inUnit, monthWord, monthDay, bareWord) => {
            if (inUnit) {
                const n = parseInt(inCount, 10);
                const d = midnight();
                if (inUnit.startsWith('day')) d.setDate(d.getDate() + n);
                else if (inUnit.startsWith('week')) d.setDate(d.getDate() + n * 7);
                else d.setMonth(d.getMonth() + n);
                dueDate = ymdFromDate(d);
                return '';
            }

            if (monthWord) {
                const month = monthFromPrefix(monthWord);
                const day = parseInt(monthDay, 10);
                if (month !== null && day >= 1 && day <= 31) {
                    let year = base.getFullYear();
                    let d = new Date(year, month, day);
                    // A month already gone means the one coming: "!sept 7"
                    // typed in December is next September, not last.
                    if (ymdFromDate(d) < ymdFromDate(midnight())) d = new Date(++year, month, day);
                    // A day the month does not have, like Feb 31, would roll
                    // into the next month. Leaving the text alone is more
                    // honest than inventing a date the student did not name.
                    if (d.getMonth() !== month) return match;
                    dueDate = ymdFromDate(d);
                    return '';
                }
                // Not a month after all. The word may still be a day keyword,
                // and the number belongs to the title either way, so it is
                // handed back rather than eaten.
                const asDay = fromWord(monthWord);
                if (asDay) { dueDate = asDay; return ' ' + monthDay; }
                return match;
            }

            const ymd = fromWord(bareWord);
            if (ymd) { dueDate = ymd; return ''; }
            // Not a date shortcut, so it belongs to the task name.
            return match;
        }
    ).replace(/\s{2,}/g, ' ').trim();

    return { cleanText, dueDate };
}
