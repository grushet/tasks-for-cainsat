import {
    saveTasksRemote,
    saveSettingsRemote,
    makeDebouncedSaver,
    getPushConfig,
    savePushSubscription,
    deletePushSubscription,
} from './api.js';
import {
    ymdFromDate,
    parseDateYMD,
    parseLocalDateTime,
    getNextRepeatDate,
    nextRepeatReminder,
    formatTaskDateDisplay,
    parseTaskKeywords,
} from './planner-logic.js';

document.addEventListener('DOMContentLoaded', () => {

    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./sw.js').catch(() => {});
    }

    const pad = n => String(n).padStart(2, '0');

    /**
     * Anything that means "right now" reads the clock when it is asked, not when
     * the page loaded. A planner is commonly left open overnight, and a captured
     * Date made every one of these wrong after midnight: "Today" highlighted
     * yesterday, !today set a due date in the past, and a repeating task
     * anchored to the wrong day.
     */
    function nowDate() { return new Date(); }
    function todayYMD() { return ymdFromDate(new Date()); }

    /** Collision-free ids. Date.now() repeats when two rows are made in one tick. */
    function newId() {
        if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
        return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    }

    // Only used to pick the month the calendar opens on.
    const now = new Date();

    const yearEl = document.getElementById('year');
    const monthEl = document.getElementById('month');
    const dayEl = document.getElementById('day');

    function refreshTodayDisplay() {
        const d = nowDate();
        if (yearEl) yearEl.textContent = d.getFullYear();
        if (monthEl) monthEl.textContent = pad(d.getMonth() + 1);
        if (dayEl) dayEl.textContent = pad(d.getDate());
    }
    refreshTodayDisplay();

    /* ─── Delete confirmation ────────────────────────────────────────────
       The modal already existed but nothing reached it: the old row menu
       called deleteTask straight from its Delete item, so a task went for
       good on one click. It now holds a callback rather than a task id, so a
       subtask can be confirmed the same way. */
    const deleteConfirmModal = document.getElementById('delete-confirm-modal');
    const deleteConfirmCancel = document.getElementById('delete-confirm-cancel');
    const deleteConfirmYes = document.getElementById('delete-confirm-yes');
    const deleteConfirmHeading = deleteConfirmModal
        ? deleteConfirmModal.querySelector('.delete-confirm-content h3')
        : null;
    const deleteConfirmText = deleteConfirmModal
        ? deleteConfirmModal.querySelector('.delete-confirm-content p')
        : null;
    let pendingDelete = null;

    function confirmDelete(heading, message, run) {
        if (!deleteConfirmModal) { run(); return; }
        pendingDelete = run;
        if (deleteConfirmHeading) deleteConfirmHeading.textContent = heading;
        if (deleteConfirmText) deleteConfirmText.textContent = message;
        deleteConfirmModal.classList.remove('hidden');
        if (deleteConfirmCancel) deleteConfirmCancel.focus();
    }

    function hideDeleteConfirm() {
        if (deleteConfirmModal) deleteConfirmModal.classList.add('hidden');
        pendingDelete = null;
    }

    if (deleteConfirmCancel) deleteConfirmCancel.addEventListener('click', hideDeleteConfirm);
    if (deleteConfirmYes) {
        deleteConfirmYes.addEventListener('click', () => {
            const run = pendingDelete;
            hideDeleteConfirm();
            if (run) run();
        });
    }
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && deleteConfirmModal && !deleteConfirmModal.classList.contains('hidden')) {
            hideDeleteConfirm();
        }
    });

    // Close modal on background click
    deleteConfirmModal.addEventListener('click', (e) => {
        if (e.target === deleteConfirmModal) {
            hideDeleteConfirm();
        }
    });

    /* ─── Icons ──────────────────────────────────────────────────────────
       Inline SVG, not emoji. The row used to draw 🔔 and ↻ as text, which most
       platforms render as a full-colour emoji: it ignores `color`, so those
       buttons could not be dimmed at rest, tinted when active, or made to
       match anything else on the page. These inherit currentColor. */
    const ICON_PATHS = {
        calendar: '<path d="M8 2v4M16 2v4"/><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M3 10h18"/>',
        repeat:   '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
        bell:     '<path d="M10.3 21a2 2 0 0 0 3.4 0"/><path d="M3.3 15.3A1 1 0 0 0 4 17h16a1 1 0 0 0 .7-1.7C19.4 14 18 12.5 18 8A6 6 0 0 0 6 8c0 4.5-1.4 6-2.7 7.3"/>',
        flag:     '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><path d="M4 22v-7"/>',
        more:     '<circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
        chevron:  '<path d="m9 18 6-6-6-6"/>',
        plus:     '<path d="M5 12h14M12 5v14"/>',
        pencil:   '<path d="M21.2 6.8a1 1 0 0 0-4-4L3.8 16.2a2 2 0 0 0-.5.8l-1.3 4.4a.5.5 0 0 0 .6.6l4.4-1.3a2 2 0 0 0 .8-.5z"/><path d="m15 5 4 4"/>',
        trash:    '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
        list:     '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    };

    function icon(name) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');
        svg.setAttribute('aria-hidden', 'true');
        svg.innerHTML = ICON_PATHS[name] || '';
        return svg;
    }

    /* ─── Popovers ───────────────────────────────────────────────────────
       One popover at a time, mounted on <body>.

       Each task row used to carry its own absolutely positioned menus: a
       repeat popover, a reminder popover and a "⋯" menu, three per task, all
       `position: absolute; left: 0` inside the row. That clipped against the
       scrolling content column, ran off the right edge from the rightmost
       control, and needed a stopPropagation on every one of them to survive
       the document-wide close handler. A single fixed-position host measured
       against the anchor's own box has none of those problems, and it can flip
       above the anchor when there is no room below. */
    let activePopover = null;

    function closePopover(opts = {}) {
        if (!activePopover) return;
        const { el, anchor } = activePopover;
        activePopover = null;
        el.remove();
        if (anchor && anchor.isConnected) {
            anchor.setAttribute('aria-expanded', 'false');
            if (opts.restoreFocus) anchor.focus();
        }
    }

    function placePopover(el, anchor, align) {
        const GAP = 6;
        const EDGE = 8;
        const r = anchor.getBoundingClientRect();
        const w = el.offsetWidth;
        const h = el.offsetHeight;
        const vw = window.innerWidth;
        const vh = window.innerHeight;

        let left = align === 'end' ? r.right - w : r.left;
        left = Math.min(Math.max(EDGE, left), Math.max(EDGE, vw - w - EDGE));

        // Below the anchor unless that would run off the bottom and there is
        // genuinely more room above.
        let top = r.bottom + GAP;
        const flip = top + h > vh - EDGE && r.top - GAP - h > EDGE;
        if (flip) top = r.top - GAP - h;
        top = Math.min(Math.max(EDGE, top), Math.max(EDGE, vh - h - EDGE));

        el.classList.toggle('pop--above', flip);
        el.style.left = `${Math.round(left)}px`;
        el.style.top = `${Math.round(top)}px`;
    }

    /**
     * Opens `build(el, close)`'s content anchored to `anchor`. Clicking the
     * same anchor again closes it, so every trigger is a toggle.
     */
    function openPopover(anchor, build, opts = {}) {
        const wasMine = !!activePopover && activePopover.anchor === anchor;
        closePopover();
        if (wasMine) return null;

        const el = document.createElement('div');
        el.className = 'pop';
        el.setAttribute('role', 'dialog');

        const close = (o) => {
            if (activePopover && activePopover.el === el) closePopover(o);
        };

        build(el, close);
        document.body.appendChild(el);
        anchor.setAttribute('aria-expanded', 'true');
        activePopover = { el, anchor, align: opts.align || 'start' };
        placePopover(el, anchor, activePopover.align);

        el.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close({ restoreFocus: true }); }
        });

        if (opts.autofocus !== false) {
            const first = el.querySelector('input, select, button');
            if (first) first.focus();
        }
        return el;
    }

    // mousedown rather than click, so the popover is gone before the next
    // element's click handler runs. The anchor is excluded because its own
    // click handler is what toggles it shut.
    document.addEventListener('mousedown', (e) => {
        if (!activePopover) return;
        if (activePopover.el.contains(e.target)) return;
        if (activePopover.anchor && activePopover.anchor.contains(e.target)) return;
        closePopover();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && activePopover) closePopover({ restoreFocus: true });
    });

    // Fixed positioning does not follow a scrolling ancestor, so the popover
    // is re-measured rather than left behind. Not closed: a soft keyboard
    // opening counts as a resize, and closing there would eat a half-typed
    // reminder time.
    function repositionPopover() {
        if (!activePopover) return;
        if (!activePopover.anchor.isConnected) { closePopover(); return; }
        placePopover(activePopover.el, activePopover.anchor, activePopover.align);
    }
    window.addEventListener('resize', repositionPopover);
    window.addEventListener('scroll', repositionPopover, true);

    /* ─── Popover building blocks ─── */

    function popLabel(text) {
        const el = document.createElement('div');
        el.className = 'pop-label';
        el.textContent = text;
        return el;
    }

    function popSeparator() {
        const el = document.createElement('div');
        el.className = 'pop-sep';
        return el;
    }

    function popRow(...children) {
        const row = document.createElement('div');
        row.className = 'pop-row';
        children.forEach(c => c && row.appendChild(c));
        return row;
    }

    function popItem(iconName, text, onClick, { danger = false, value = null } = {}) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'pop-item' + (danger ? ' pop-item--danger' : '');
        b.appendChild(icon(iconName));
        const span = document.createElement('span');
        span.textContent = text;
        b.appendChild(span);
        if (value) {
            const v = document.createElement('span');
            v.className = 'pop-item-value';
            v.textContent = value;
            b.appendChild(v);
        }
        b.addEventListener('click', onClick);
        return b;
    }

    function popTextButton(text, onClick, { danger = false } = {}) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'pop-text-btn' + (danger ? ' pop-text-btn--danger' : '');
        b.textContent = text;
        b.addEventListener('click', onClick);
        return b;
    }

    /** A small pill inside a popover, e.g. the "Today" quick pick. */
    function popChip(text, onClick) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'chip';
        b.textContent = text;
        b.addEventListener('click', onClick);
        return b;
    }

    /** Segmented control. `options` is [[value, label], ...]. */
    function popSegmented(options, current, onPick) {
        const seg = document.createElement('div');
        seg.className = 'seg';
        options.forEach(([value, label]) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.dataset.v = value || 'none';
            b.textContent = label;
            b.setAttribute('aria-pressed', String((current || '') === (value || '')));
            b.addEventListener('click', () => onPick(value || null));
            seg.appendChild(b);
        });
        return seg;
    }

    /* ─── Property editors ───────────────────────────────────────────────
       Each takes the current value and a setter, so one implementation serves
       tasks, subtasks and the calendar's day list. */

    const PRIORITY_OPTIONS = [['', 'None'], ['low', 'Low'], ['med', 'Med'], ['high', 'High']];
    const PRIORITY_LABEL = { high: 'High', med: 'Medium', low: 'Low' };

    const REPEAT_PRESETS = [
        { label: 'Daily', n: 1, unit: 'days' },
        { label: 'Weekly', n: 1, unit: 'weeks' },
        { label: 'Monthly', n: 1, unit: 'months' },
    ];

    function repeatLabel(repeat) {
        if (!repeat) return null;
        const n = repeat.n || 1;
        const preset = REPEAT_PRESETS.find(p => p.n === n && p.unit === repeat.unit);
        if (preset) return preset.label;
        const unit = n === 1 ? String(repeat.unit).replace(/s$/, '') : repeat.unit;
        return `Every ${n} ${unit}`;
    }

    function reminderChipLabel(reminder) {
        const d = parseLocalDateTime(reminder);
        if (!d) return null;
        const day = formatTaskDateDisplay(ymdFromDate(d));
        const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
        return `${day}, ${time}`;
    }

    /** Today, tomorrow, and the Monday coming. Never today's weekday. */
    function dateQuickPicks() {
        const base = nowDate();
        const shift = (n) => {
            const d = new Date(base.getFullYear(), base.getMonth(), base.getDate());
            d.setDate(d.getDate() + n);
            return ymdFromDate(d);
        };
        return [
            { label: 'Today', ymd: shift(0) },
            { label: 'Tomorrow', ymd: shift(1) },
            { label: 'Next Mon', ymd: shift(((8 - base.getDay()) % 7) || 7) },
        ];
    }

    function openPriorityPopover(anchor, value, onChange) {
        openPopover(anchor, (el, close) => {
            el.appendChild(popLabel('Priority'));
            el.appendChild(popSegmented(PRIORITY_OPTIONS, value, (v) => {
                close();
                onChange(v);
            }));
        }, { autofocus: false });
    }

    function openDatePopover(anchor, value, onChange) {
        openPopover(anchor, (el, close) => {
            el.appendChild(popLabel('Due date'));

            const quick = document.createElement('div');
            quick.className = 'pop-quick';
            dateQuickPicks().forEach(({ label, ymd }) => {
                quick.appendChild(popChip(label, () => { close(); onChange(ymd); }));
            });
            el.appendChild(quick);

            const input = document.createElement('input');
            input.type = 'date';
            input.className = 'pop-input';
            input.value = value || '';
            input.addEventListener('change', () => {
                close();
                onChange(input.value || null);
            });
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); close(); onChange(input.value || null); }
            });

            const row = popRow(input);
            if (value) row.appendChild(popTextButton('Clear', () => { close(); onChange(null); }, { danger: true }));
            el.appendChild(row);
        }, { autofocus: false });
    }

    function openRepeatPopover(anchor, value, onChange) {
        openPopover(anchor, (el, close) => {
            el.appendChild(popLabel('Repeat'));

            const current = value
                ? (REPEAT_PRESETS.find(p => p.n === (value.n || 1) && p.unit === value.unit) || { label: 'Custom' }).label
                : 'Off';

            el.appendChild(popSegmented(
                [['Off', 'Off'], ...REPEAT_PRESETS.map(p => [p.label, p.label])],
                current,
                (picked) => {
                    close();
                    if (picked === 'Off') return onChange(null);
                    const preset = REPEAT_PRESETS.find(p => p.label === picked);
                    onChange(preset ? { n: preset.n, unit: preset.unit } : null);
                }
            ));

            el.appendChild(popSeparator());
            el.appendChild(popLabel('Every'));

            const n = document.createElement('input');
            n.type = 'number';
            n.min = '1';
            n.className = 'pop-input pop-input--n';
            n.value = value ? (value.n || 1) : '';
            n.placeholder = '1';

            const unit = document.createElement('select');
            unit.className = 'pop-input';
            ['days', 'weeks', 'months'].forEach(u => {
                const opt = document.createElement('option');
                opt.value = u;
                opt.textContent = u.charAt(0).toUpperCase() + u.slice(1);
                opt.selected = value ? value.unit === u : u === 'weeks';
                unit.appendChild(opt);
            });

            const commit = () => {
                const count = parseInt(n.value, 10);
                close();
                onChange(!count || count < 1 ? null : { n: count, unit: unit.value });
            };
            n.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } });
            n.addEventListener('change', commit);
            unit.addEventListener('change', () => { if (parseInt(n.value, 10) >= 1) commit(); });

            el.appendChild(popRow(n, unit));
        }, { autofocus: false });
    }

    function openReminderPopover(anchor, value, fallbackYMD, onChange) {
        openPopover(anchor, (el, close) => {
            el.appendChild(popLabel('Remind me'));

            const dateInput = document.createElement('input');
            dateInput.type = 'date';
            dateInput.className = 'pop-input';
            dateInput.value = value ? String(value).slice(0, 10) : (fallbackYMD || todayYMD());

            const timeInput = document.createElement('input');
            timeInput.type = 'time';
            timeInput.className = 'pop-input';
            timeInput.value = value ? String(value).slice(11, 16) : '09:00';

            // A reminder is a local wall-clock string, never an instant. See
            // planner-logic.js for why this is never routed through a Date.
            const commit = () => {
                const d = dateInput.value;
                const t = timeInput.value;
                close();
                onChange(d && t ? `${d}T${t}` : null);
            };
            [dateInput, timeInput].forEach(inp => {
                inp.addEventListener('change', commit);
                inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } });
            });

            el.appendChild(popRow(dateInput, timeInput));

            const actions = popRow();
            if (value) actions.appendChild(popTextButton('Clear reminder', () => { close(); onChange(null); }, { danger: true }));
            if (actions.children.length) el.appendChild(actions);

            if ('Notification' in window && Notification.permission === 'denied') {
                const note = document.createElement('p');
                note.className = 'pop-note';
                note.textContent = 'Notifications are blocked for this site, so this reminder can only show while the planner is open.';
                el.appendChild(note);
            }

            requestNotifPermission();
        }, { autofocus: false });
    }

    // Navigation: show/hide pages and set active link
    const links = document.querySelectorAll('.nav-link[data-target]');
    const pages = document.querySelectorAll('.page');

    function showPage(id, linkEl) {
        pages.forEach(p => {
            const isVisible = p.id === id;
            p.classList.toggle('active', isVisible);
            p.setAttribute('aria-hidden', !isVisible);
        });
        links.forEach(l => l.classList.toggle('active', l === linkEl));
    }

    links.forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const target = link.dataset.target;
            if (target) {
                showPage(target, link);
            }
        });
    });

    // Start the page on the first link
    links[0].click();

    // Calendar functionality
    let currentDate = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthYearEl = document.getElementById('calendar-month-year');
    const calendarDaysEl = document.getElementById('calendar-days');
    const prevMonthBtn = document.getElementById('prev-month');
    const nextMonthBtn = document.getElementById('next-month');

    // Collect all items (tasks + subtasks) for a given date string
    function getItemsForDate(dateStr) {
        const items = [];
        if (!tasks) return items;
        tasks.forEach(task => {
            if (task.dueDate === dateStr) {
                items.push({ completed: !!task.completed });
            }
            if (task.subtasks) {
                task.subtasks.forEach(sub => {
                    if (sub.dueDate === dateStr) {
                        items.push({ completed: !!sub.completed });
                    }
                });
            }
        });
        return items;
    }

    function markDayIndicator(dayDiv) {
        const items = getItemsForDate(dayDiv.dataset.date);
        if (!items.length) {
            dayDiv.classList.add('no-task');
        } else if (items.every(i => i.completed)) {
            dayDiv.classList.add('tasks-completed');
        } else {
            dayDiv.classList.add('has-task');
        }
    }

    function renderCalendar() {
        const year = currentDate.getFullYear();
        const month = currentDate.getMonth();
        const todayStr = todayYMD();
        refreshTodayDisplay();

        // Update header
        const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
            'July', 'August', 'September', 'October', 'November', 'December'];
        monthYearEl.textContent = `${monthNames[month]} ${year}`;

        // Get first day of month and number of days
        const firstDay = new Date(year, month, 1).getDay();
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const daysInPrevMonth = new Date(year, month, 0).getDate();

        calendarDaysEl.innerHTML = '';

        // Previous month's days
        for (let i = firstDay - 1; i >= 0; i--) {
            const dayNum = daysInPrevMonth - i;
            const dateObj = new Date(year, month - 1, dayNum);
            const dayDiv = document.createElement('div');
            dayDiv.className = 'calendar-day other-month';
            dayDiv.textContent = dayNum;
            dayDiv.dataset.date = ymdFromDate(dateObj);
            markDayIndicator(dayDiv);
            calendarDaysEl.appendChild(dayDiv);
        }

        // Current month's days
        for (let day = 1; day <= daysInMonth; day++) {
            const dateObj = new Date(year, month, day);
            const dayDiv = document.createElement('div');
            dayDiv.className = 'calendar-day';
            dayDiv.textContent = day;
            dayDiv.dataset.date = ymdFromDate(dateObj);
            markDayIndicator(dayDiv);

            // Highlight today
            if (dayDiv.dataset.date === todayStr) {
                dayDiv.classList.add('today');
            }

            // Highlight selected day
            if (selectedDate && dayDiv.dataset.date === selectedDate) {
                dayDiv.classList.add('selected-day');
            }

            calendarDaysEl.appendChild(dayDiv);
        }

        // Next month's days
        const totalCells = calendarDaysEl.children.length;
        const remainingCells = 42 - totalCells; // 6 rows * 7 days
        for (let day = 1; day <= remainingCells; day++) {
            const dateObj = new Date(year, month + 1, day);
            const dayDiv = document.createElement('div');
            dayDiv.className = 'calendar-day other-month';
            dayDiv.textContent = day;
            dayDiv.dataset.date = ymdFromDate(dateObj);
            markDayIndicator(dayDiv);
            calendarDaysEl.appendChild(dayDiv);
        }

        // add click handlers for date selection
        Array.from(calendarDaysEl.querySelectorAll('.calendar-day')).forEach(d => {
            d.addEventListener('click', () => {
                // clear previous selection
                const prev = calendarDaysEl.querySelector('.calendar-day.selected-day');
                if (prev) prev.classList.remove('selected-day');
                d.classList.add('selected-day');
                selectedDate = d.dataset.date || null;
                renderDayTasks();
            });
        });
    }


    // render tasks for the currently selected day
    const dayTasksEl = document.getElementById('day-tasks');
    const homeSummaryEl = document.getElementById('home-summary');

    let selectedDate = ymdFromDate(now); // default to today

    function renderDayTasks() {
        if (!dayTasksEl) return;
        const title = document.createElement('h4');
        const dateObj = parseDateYMD(selectedDate);
        const isToday = selectedDate === todayYMD();
        if (isToday) title.textContent = 'Tasks for Today';
        else title.textContent = `Tasks for ${dateObj.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
        const container = document.createElement('div');
        container.appendChild(title);

        // Add task for selected date control
        const addRow = document.createElement('div');
        addRow.className = 'day-add-row';
        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'day-add-btn';
        addBtn.textContent = '+ Add task for this day';
        addRow.appendChild(addBtn);
        container.appendChild(addRow);

        function startAddInline() {
            const input = document.createElement('input');
            input.type = 'text';
            input.placeholder = 'New task...';
            input.className = 'day-add-input';
            // replace button with input
            addRow.replaceChild(input, addBtn);
            input.focus();

            // Settled by whichever of commit or cancel happens first. Removing a
            // focused input fires blur in some browsers and not others, so
            // without this Escape could still add the task through the blur
            // handler below.
            let settled = false;

            function commit() {
                if (settled) return;
                settled = true;

                const val = (input.value || '').trim();
                if (val) {
                    addTaskWithDate(val, selectedDate);
                }
                renderDayTasks();
            }

            function cancel() {
                if (settled) return;
                settled = true;
                // restore button
                if (addRow.contains(input)) addRow.replaceChild(addBtn, input);
            }

            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); commit(); }
                if (e.key === 'Escape') { e.preventDefault(); cancel(); }
            });
            input.addEventListener('blur', () => { setTimeout(commit, 50); });
        }

        addBtn.addEventListener('click', startAddInline);

        // collect both tasks and subtasks matching the selected date
        const allMatches = [];
        tasks.forEach(task => {
            if (task.dueDate === selectedDate) {
                allMatches.push({ type: 'task', task, subtask: null });
            }
            if (task.subtasks) {
                task.subtasks.forEach(subtask => {
                    if (subtask.dueDate === selectedDate) {
                        allMatches.push({ type: 'subtask', task, subtask });
                    }
                });
            }
        });

        if (!allMatches.length) {
            const p = document.createElement('div');
            p.className = 'no-tasks';
            p.textContent = isToday ? 'No tasks scheduled for today' : 'No tasks scheduled for this day';
            container.appendChild(p);
        } else {
            const ul = document.createElement('ul');
            allMatches.forEach(item => {
                const li = document.createElement('li');
                if (item.type === 'task') {
                    const task = item.task;
                    li.className = 'day-task-item' + (task.completed ? ' completed' : '');
                    if (task.importance === 'high') li.classList.add('importance-high');
                    else if (task.importance === 'low') li.classList.add('importance-low');
                    const cb = document.createElement('input');
                    cb.type = 'checkbox';
                    cb.className = 'task-checkbox';
                    cb.dataset.id = task.id;
                    cb.checked = !!task.completed;
                    const lbl = document.createElement('span');
                    lbl.className = 'task-label';
                    lbl.textContent = task.text;
                    lbl.tabIndex = 0;
                    lbl.addEventListener('click', () => startEditingTaskName(task, li));
                    lbl.addEventListener('keydown', e => {
                        if (e.key === 'Enter') { e.preventDefault(); startEditingTaskName(task, li); }
                    });
                    li.appendChild(cb);
                    li.appendChild(lbl);
                    // Same priority chip the task list uses, rather than a
                    // second native <select> with its own four <option>s.
                    li.appendChild(priorityChip(task.importance, (v) => {
                        task.importance = v;
                        saveTasks();
                        renderTasks();
                        renderDayTasks();
                    }));
                } else {
                    const subtask = item.subtask;
                    li.className = 'day-task-item day-subtask-item' + (subtask.completed ? ' completed' : '');
                    if (subtask.importance === 'high') li.classList.add('importance-high');
                    else if (subtask.importance === 'low') li.classList.add('importance-low');
                    const cb = document.createElement('input');
                    cb.type = 'checkbox';
                    cb.className = 'subtask-checkbox';
                    cb.dataset.parentTaskId = item.task.id;
                    cb.dataset.subtaskId = subtask.id;
                    cb.checked = !!subtask.completed;
                    const typeBadge = document.createElement('span');
                    typeBadge.className = 'day-task-type';
                    typeBadge.textContent = 'Subtask';
                    const lbl = document.createElement('span');
                    lbl.className = 'task-label';
                    lbl.textContent = subtask.text;
                    lbl.tabIndex = 0;
                    lbl.addEventListener('click', () => startEditingSubtaskName(item.task.id, subtask, li));
                    lbl.addEventListener('keydown', e => {
                        if (e.key === 'Enter') { e.preventDefault(); startEditingSubtaskName(item.task.id, subtask, li); }
                    });
                    li.appendChild(cb);
                    li.appendChild(typeBadge);
                    li.appendChild(lbl);
                    li.appendChild(priorityChip(subtask.importance, (v) => {
                        subtask.importance = v;
                        saveTasks();
                        renderTasks();
                        renderDayTasks();
                    }));
                }
                ul.appendChild(li);
            });
            container.appendChild(ul);
        }

        function addTaskWithDate(text, ymd) {
            const trimmed = String(text || '').trim();
            if (!trimmed) return;
            
            // Parse keywords from task text
            const { cleanText, dueDate: parsedDate } = parseTaskKeywords(trimmed);
            if (!cleanText) return; // if all text was keywords, skip

            // Use parsed date if available, otherwise use the provided date (from calendar)
            const finalDate = parsedDate || ymd || null;
            const task = { id: newId(), text: cleanText, completed: false, dueDate: finalDate, importance: null, repeat: null, reminder: null, reminderFired: false, subtasks: [] };
            tasks.unshift(task);
            saveTasks();
            renderTasks();
            renderCalendar();
            renderDayTasks();
        }
        dayTasksEl.innerHTML = '';
        dayTasksEl.appendChild(container);
    }

    /**
     * Every open task and subtask, dated or not, sorted by due date with the
     * undated ones last.
     *
     * Undated work used to be dropped here, by requiring `task.dueDate`. That
     * made it invisible on the Home summary -- a task with no date existed
     * only on the Tasks page, which is exactly the kind of thing a planner is
     * meant not to lose.
     */
    function getUpcomingTasks() {
        const todayYMD = ymdFromDate(new Date());
        const all = [];

        tasks.forEach(task => {
            if (!task.completed) {
                all.push({
                    id: task.id,
                    title: task.text,
                    dueDate: task.dueDate || null,
                    type: 'Task',
                    importance: task.importance,
                    overdue: !!task.dueDate && task.dueDate < todayYMD,
                });
            }
            if (task.subtasks && task.subtasks.length) {
                task.subtasks.forEach(subtask => {
                    if (!subtask.completed) {
                        all.push({
                            id: task.id,
                            title: `${task.text} → ${subtask.text}`,
                            dueDate: subtask.dueDate || null,
                            type: 'Subtask',
                            importance: subtask.importance,
                            overdue: !!subtask.dueDate && subtask.dueDate < todayYMD,
                        });
                    }
                });
            }
        });

        return all.sort((a, b) => {
            // Undated last. Comparing a null date as a string would sort it
            // among the real ones.
            if (!a.dueDate !== !b.dueDate) return a.dueDate ? -1 : 1;
            if (a.dueDate && a.dueDate !== b.dueDate) return a.dueDate.localeCompare(b.dueDate);
            return a.title.localeCompare(b.title);
        });
    }

    function sortTasksBy(arr, sortBy) {
        if (!sortBy) return [...arr];
        const importanceOrder = { high: 0, med: 1, low: 2 };
        return [...arr].sort((a, b) => {
            if (sortBy === 'date') {
                const da = a.dueDate || 'zzzz';
                const db = b.dueDate || 'zzzz';
                if (da !== db) return da.localeCompare(db);
            }
            if (sortBy === 'importance') {
                const ia = a.importance ? (importanceOrder[a.importance] ?? 3) : 3;
                const ib = b.importance ? (importanceOrder[b.importance] ?? 3) : 3;
                if (ia !== ib) return ia - ib;
            }
            return 0;
        });
    }

    function groupTasksBy(arr, groupBy) {
        if (groupBy === 'date') {
            const todayYMD = ymdFromDate(new Date());
            const weekFromNow = new Date();
            weekFromNow.setDate(weekFromNow.getDate() + 7);
            const weekYMD = ymdFromDate(weekFromNow);
            return [
                { label: 'Overdue',   items: arr.filter(t => t.dueDate && t.dueDate < todayYMD) },
                { label: 'Today',     items: arr.filter(t => t.dueDate === todayYMD) },
                { label: 'This week', items: arr.filter(t => t.dueDate && t.dueDate > todayYMD && t.dueDate <= weekYMD) },
                { label: 'Later',     items: arr.filter(t => t.dueDate && t.dueDate > weekYMD) },
                { label: 'No date',   items: arr.filter(t => !t.dueDate) },
            ].filter(g => g.items.length > 0);
        }
        if (groupBy === 'importance') {
            return [
                { label: 'High',        items: arr.filter(t => t.importance === 'high') },
                { label: 'Medium',      items: arr.filter(t => t.importance === 'med') },
                { label: 'Low',         items: arr.filter(t => t.importance === 'low') },
                { label: 'No priority', items: arr.filter(t => !t.importance) },
            ].filter(g => g.items.length > 0);
        }
        return [{ label: null, items: arr }];
    }

    function renderHomeSummary() {
        if (!homeSummaryEl) return;

        const todayYMD = ymdFromDate(new Date());
        const weekFromNow = new Date();
        weekFromNow.setDate(weekFromNow.getDate() + 7);
        const weekYMD = ymdFromDate(weekFromNow);

        // Half-width boxes show three rows. The full-width No date box gets
        // more, because it has the room and a backlog is the one list where
        // seeing only the first three tells you least.
        const PER_BOX_LIMIT = 3;
        const WIDE_BOX_LIMIT = 6;

        const all = getUpcomingTasks();
        // Every filter tests for a date first. Without that guard an undated
        // item answers false to both `< today` and `> week`, so it would fall
        // through all four boxes and vanish again.
        const buckets = [
            { label: 'Overdue',   modifier: 'overdue', items: all.filter(i => i.dueDate && i.dueDate < todayYMD) },
            { label: 'Today',     modifier: 'today',   items: all.filter(i => i.dueDate === todayYMD) },
            { label: 'This week', modifier: '',        items: all.filter(i => i.dueDate && i.dueDate > todayYMD && i.dueDate <= weekYMD) },
            { label: 'Later',     modifier: '',        items: all.filter(i => i.dueDate && i.dueDate > weekYMD) },
            // Label matches the Tasks page's own date grouping, so the
            // "+N more" link below can scroll to the matching group header.
            { label: 'No date',   modifier: 'nodate',  items: all.filter(i => !i.dueDate), wide: true }
        ];

        homeSummaryEl.innerHTML = '';

        const header = document.createElement('div');
        header.className = 'home-summary-header';
        const title = document.createElement('h3');
        title.textContent = 'Task overview';
        header.appendChild(title);
        homeSummaryEl.appendChild(header);

        if (!all.length) {
            const empty = document.createElement('p');
            empty.className = 'home-summary-empty';
            empty.textContent = 'No upcoming tasks. You are all caught up!';
            homeSummaryEl.appendChild(empty);
            return;
        }

        const grid = document.createElement('div');
        grid.className = 'home-summary-cards';

        buckets.forEach(bucket => {
            const hasItems = bucket.items.length > 0;
            const card = document.createElement('div');
            // Colour modifier only when the box has tasks; empty boxes stay neutral/calm.
            card.className = 'home-summary-card'
                + (hasItems && bucket.modifier ? ` home-summary-card--${bucket.modifier}` : '')
                + (hasItems ? '' : ' home-summary-card--empty')
                + (bucket.wide ? ' home-summary-card--wide' : '');

            const cardHeader = document.createElement('div');
            cardHeader.className = 'home-summary-card-header';

            const label = document.createElement('span');
            label.className = 'home-summary-card-label';
            label.textContent = bucket.label;
            cardHeader.appendChild(label);

            const badge = document.createElement('span');
            if (hasItems) {
                badge.className = 'home-summary-card-count';
                badge.textContent = bucket.items.length;
            } else {
                badge.className = 'home-summary-card-clear';
                badge.textContent = 'All clear';
            }
            cardHeader.appendChild(badge);
            card.appendChild(cardHeader);

            if (hasItems) {
                const list = document.createElement('ul');
                list.className = 'home-summary-list';
                const limit = bucket.wide ? WIDE_BOX_LIMIT : PER_BOX_LIMIT;
                bucket.items.slice(0, limit).forEach(item => {
                    const li = document.createElement('li');
                    li.addEventListener('click', () => {
                        taskHighlightId = item.id;
                        renderTasks();
                        const tasksLink = document.querySelector('.nav-link[data-target="page-tasks"]');
                        if (tasksLink) tasksLink.click();
                    });

                    const itemText = document.createElement('span');
                    itemText.className = 'home-summary-item';
                    itemText.textContent = item.title;
                    itemText.title = item.title;

                    li.appendChild(itemText);

                    // Undated items are already under a box that says so, and
                    // an empty date column just left a gap.
                    if (item.dueDate) {
                        const date = document.createElement('span');
                        date.className = 'home-summary-date' + (item.overdue ? ' home-summary-date--overdue' : '');
                        date.textContent = formatTaskDateDisplay(item.dueDate);
                        li.appendChild(date);
                    }

                    list.appendChild(li);
                });
                card.appendChild(list);

                if (bucket.items.length > limit) {
                    const more = document.createElement('p');
                    more.className = 'home-summary-more home-summary-more--link';
                    more.textContent = `+${bucket.items.length - limit} more`;
                    more.title = 'View all in Tasks';
                    more.addEventListener('click', () => {
                        taskGroupBy = 'date';
                        taskHighlightGroup = bucket.label;
                        const gEl = document.getElementById('task-group-by');
                        if (gEl) { gEl.value = 'date'; gEl.classList.add('active'); }
                        renderTasks();
                        const tasksLink = document.querySelector('.nav-link[data-target="page-tasks"]');
                        if (tasksLink) tasksLink.click();
                    });
                    card.appendChild(more);
                }
            }

            grid.appendChild(card);
        });

        homeSummaryEl.appendChild(grid);
    }

    // listen for check toggles inside dayTasks
    if (dayTasksEl) {
        dayTasksEl.addEventListener('change', (e) => {
            const t = e.target;
            if (t && t.matches('input[type="checkbox"].task-checkbox')) {
                toggleTask(t.dataset.id, t.checked);
                renderCalendar();
                renderDayTasks();
            } else if (t && t.matches('input[type="checkbox"].subtask-checkbox')) {
                toggleSubtask(t.dataset.parentTaskId, t.dataset.subtaskId, t.checked);
                renderCalendar();
                renderDayTasks();
            }
        });
    }
    

    prevMonthBtn.addEventListener('click', () => {
        currentDate.setMonth(currentDate.getMonth() - 1);
        renderCalendar();
    });

    nextMonthBtn.addEventListener('click', () => {
        currentDate.setMonth(currentDate.getMonth() + 1);
        renderCalendar();
    });


    // ===== Task list functionality ===== \\

    let tasks = [];
    let taskGroupBy = '';
    let taskSortBy = '';
    let taskHighlightGroup = null;
    let taskHighlightId = null;
    const recentlyCompleted = new Set();
    /** Set once the server's list has arrived, so an early save cannot wipe it. */
    let plannerLoaded = false;

    const taskInput = document.getElementById('new-task-input');
    const taskListEl = document.getElementById('task-list');

    // Anything typed before the list arrives would be thrown away when the
    // server's copy replaces the in-memory array, so the box stays shut until
    // there is a list to add to.
    if (taskInput) {
        taskInput.disabled = true;
        taskInput.placeholder = 'Loading your tasks...';
    }

    // ----- Sync banner -------------------------------------------------------
    const syncBanner = document.getElementById('sync-banner');
    const syncBannerText = document.getElementById('sync-banner-text');
    const syncBannerRetry = document.getElementById('sync-banner-retry');

    function showSyncError(message) {
        if (!syncBanner) return;
        syncBannerText.textContent = message;
        syncBanner.hidden = false;
    }

    function clearSyncError() {
        if (syncBanner) syncBanner.hidden = true;
    }

    if (syncBannerRetry) {
        syncBannerRetry.addEventListener('click', async () => {
            if (syncBannerRetry.disabled) return;
            syncBannerRetry.disabled = true;
            clearSyncError();
            try {
                await Promise.all([saveTasksDebounced.flush(), saveSettingsDebounced.flush()]);
            } catch (e) { /* the saver reports through onError */ }
            syncBannerRetry.disabled = false;
            // Hiding the banner on click and never bringing it back is how this
            // read as success while nothing had been sent. The banner may only
            // stay hidden if there is genuinely nothing left unsaved.
            const stuck =
                saveTasksDebounced.hasPending() || saveTasksDebounced.lastError() ||
                saveSettingsDebounced.hasPending() || saveSettingsDebounced.lastError();
            if (stuck) {
                showSyncError('Still could not save your changes. They are on screen, but not stored yet.');
            }
        });
    }

    // ----- Saving ------------------------------------------------------------
    // Every edit posts the whole list, but the requests are coalesced: typing a
    // task name no longer means one database write per keystroke.
    const saveTasksDebounced = makeDebouncedSaver(saveTasksRemote, 700);
    const saveSettingsDebounced = makeDebouncedSaver(saveSettingsRemote, 700);

    saveTasksDebounced.onError = (err) => {
        console.error('Saving tasks failed:', err);
        showSyncError(
            err && err.unauthorized
                ? 'You have been signed out, so recent changes are not saved. Sign in again to keep them.'
                : 'Could not save your latest changes. They are still on screen, but not stored yet.'
        );
    };
    saveSettingsDebounced.onError = (err) => {
        console.error('Saving settings failed:', err);
    };

    function saveTasks() {
        // Before the first load lands, the in-memory list is empty and posting it
        // would delete everything the account already has.
        if (!plannerLoaded) return;
        clearSyncError();
        saveTasksDebounced(tasks);
    }

    function saveViewPrefs() {
        if (!plannerLoaded) return;
        saveSettingsDebounced({ prefs: { groupBy: taskGroupBy, sortBy: taskSortBy } });
    }

    // A pending save would otherwise be lost when the tab closes. pagehide alone
    // is unreliable on mobile, where a backgrounded tab is often discarded
    // without it, so the first hide flushes too.
    function flushPendingSaves() {
        saveTasksDebounced.flush();
        saveSettingsDebounced.flush();
    }
    window.addEventListener('pagehide', flushPendingSaves);
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) flushPendingSaves();
    });

    // ----- Loading -----------------------------------------------------------
    function applyPlannerData(data) {
        tasks = Array.isArray(data.tasks) ? data.tasks : [];

        // Fill in anything an older record predates, so the render path can
        // assume these exist.
        tasks.forEach(task => {
            if (!task.subtasks) task.subtasks = [];
            if (!('repeat' in task)) task.repeat = null;
            if (!('reminder' in task)) task.reminder = null;
            if (!('reminderFired' in task)) task.reminderFired = false;
            task.subtasks.forEach(subtask => {
                if (!subtask.importance) subtask.importance = null;
                if (!subtask.dueDate) subtask.dueDate = null;
            });
        });

        const prefs = data.prefs || {};
        taskGroupBy = prefs.groupBy || '';
        taskSortBy  = prefs.sortBy  || '';
        const gEl = document.getElementById('task-group-by');
        const sEl = document.getElementById('task-sort-by');
        if (gEl) { gEl.value = taskGroupBy; gEl.classList.toggle('active', !!taskGroupBy); }
        if (sEl) { sEl.value = taskSortBy;  sEl.classList.toggle('active', !!taskSortBy); }

        plannerLoaded = true;

        if (taskInput) {
            taskInput.disabled = false;
            taskInput.placeholder = 'Type a new task, then press Enter';
        }

        if (data.pomodoro && typeof window.applyPomodoroRemote === 'function') {
            window.applyPomodoroRemote(data.pomodoro);
        }

        renderTasks();
        renderCalendar();
        renderDayTasks();
        checkReminders();

        // Re-register this browser for server-sent reminders and refresh its
        // reported time zone. Only does anything if the student already granted
        // notifications; the prompt itself waits for the bell button. Deferred
        // because this can run synchronously during initial parse, before
        // syncPushSubscription's own state is initialised further down.
        if ('Notification' in window && Notification.permission === 'granted') {
            Promise.resolve().then(() => syncPushSubscription());
        }
    }

    // The fetch is kicked off by the page before this script's DOMContentLoaded
    // handler runs, so the data may already be here. Check first, then listen:
    // waiting on the event alone loses a response that arrived early.
    if (window.plannerData) {
        applyPlannerData(window.plannerData);
    } else {
        window.addEventListener('plannerDataLoaded', (e) => applyPlannerData(e.detail));
    }

    window.addEventListener('plannerLoadFailed', () => {
        // The input stays disabled: with no list loaded, a new task could not be
        // saved and would look like it had been.
        showSyncError('Could not load your tasks from cainsat.org. Reload once you are back online.');
    });

    function renderTasks() {
        if (!taskListEl) return;
        // Every row is rebuilt, so anything anchored to one is about to be
        // pointing at a detached element.
        closePopover();
        taskListEl.innerHTML = '';
        const sorted = sortTasksBy(tasks, taskSortBy);
        const activeTasks = sorted.filter(t => !t.completed || recentlyCompleted.has(String(t.id)));
        const groups = groupTasksBy(activeTasks, taskGroupBy);
        const pendingGlow = taskHighlightGroup;
        taskHighlightGroup = null;
        const pendingNewId = taskHighlightId;
        taskHighlightId = null;
        groups.forEach(group => {
            if (group.label) {
                const header = document.createElement('li');
                header.className = 'task-group-header';
                header.textContent = group.label;
                taskListEl.appendChild(header);
                if (pendingGlow && group.label === pendingGlow) {
                    requestAnimationFrame(() => {
                        header.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        header.classList.add('task-group-header--glow');
                    });
                }
            }
            group.items.forEach(task => taskListEl.appendChild(buildTaskLi(task)));
        });
        if (pendingNewId) {
            const newEl = taskListEl.querySelector(`input[data-id="${pendingNewId}"]`)?.closest('.task-item');
            if (newEl) {
                requestAnimationFrame(() => {
                    newEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    newEl.classList.add('task-item--new');
                });
            }
        }

        const completedTasks = tasks.filter(t => t.completed && !recentlyCompleted.has(String(t.id)));
        if (completedTasks.length > 0) {
            const compHeader = document.createElement('li');
            compHeader.className = 'task-group-header task-group-header--completed';
            compHeader.textContent = 'Completed';
            taskListEl.appendChild(compHeader);
            completedTasks.forEach(task => taskListEl.appendChild(buildTaskLi(task)));
        }

        renderHomeSummary();
    }

    /* ─── Subtask disclosure ─────────────────────────────────────────────
       Which tasks have their subtask panel shut. Held as the closed set, not
       the open one, so a task with subtasks starts expanded: subtasks used to
       be permanently visible, and collapsing is the new capability here, not
       a new default.

       Not persisted on purpose. It is view state, and storing it would put a
       field on every task record the API round-trips. */
    const collapsedSubtasks = new Set();

    function isSubtaskPanelOpen(taskId) { return !collapsedSubtasks.has(String(taskId)); }

    function setSubtaskPanelOpen(taskId, open) {
        const key = String(taskId);
        if (open) collapsedSubtasks.delete(key);
        else collapsedSubtasks.add(key);
    }

    /* ─── Chips ──────────────────────────────────────────────────────────
       A chip states one property of a task, and is only drawn when that
       property is set. Unset properties are added as dashed `ghost` chips:
       they take up their space at all times so the row never reflows on
       hover, but they are transparent and unclickable until the row is
       hovered, and permanently visible where there is no hover at all. */
    function buildChip({ iconName, text, classes = [], ghost = false, title, expanded = null, onClick }) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = ['chip', ...classes, ghost ? 'chip--ghost' : ''].filter(Boolean).join(' ');
        if (iconName) b.appendChild(icon(iconName));
        const span = document.createElement('span');
        span.textContent = text;
        b.appendChild(span);
        if (title) b.title = title;
        if (expanded !== null) b.setAttribute('aria-expanded', String(expanded));
        b.addEventListener('click', () => onClick(b));
        return b;
    }

    function moreButton(label) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'task-more';
        b.title = label;
        b.setAttribute('aria-label', label);
        b.setAttribute('aria-expanded', 'false');
        b.appendChild(icon('more'));
        return b;
    }

    function priorityChip(value, onChange) {
        return buildChip({
            iconName: 'flag',
            text: value ? (PRIORITY_LABEL[value] || value) : 'Priority',
            classes: value ? [`chip--${value}`] : [],
            ghost: !value,
            title: value ? `Priority: ${PRIORITY_LABEL[value] || value}` : 'Set a priority',
            onClick: (b) => openPriorityPopover(b, value, onChange),
        });
    }

    function dueDateChip(ymd, overdue, onChange) {
        const classes = [];
        if (overdue) classes.push('chip--overdue');
        else if (ymd && ymd === todayYMD()) classes.push('chip--today');

        const full = ymd ? parseDateYMD(ymd) : null;
        return buildChip({
            iconName: 'calendar',
            text: ymd ? formatTaskDateDisplay(ymd) : 'Due',
            classes,
            ghost: !ymd,
            title: full
                ? `${overdue ? 'Overdue: due ' : 'Due '}${full.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}`
                : 'Set a due date',
            onClick: (b) => openDatePopover(b, ymd, onChange),
        });
    }

    function repeatChip(repeat, onChange) {
        const label = repeatLabel(repeat);
        return buildChip({
            iconName: 'repeat',
            text: label || 'Repeat',
            classes: label ? ['chip--set'] : [],
            ghost: !label,
            title: label ? `Repeats ${label.toLowerCase()}` : 'Make this repeat',
            onClick: (b) => openRepeatPopover(b, repeat, onChange),
        });
    }

    function reminderChip(reminder, fallbackYMD, onChange) {
        const label = reminderChipLabel(reminder);
        return buildChip({
            iconName: 'bell',
            text: label || 'Remind',
            classes: label ? ['chip--set'] : [],
            ghost: !label,
            title: label ? reminderLabel(reminder) : 'Set a reminder',
            onClick: (b) => openReminderPopover(b, reminder, fallbackYMD, onChange),
        });
    }

    /* ─── A task row ─────────────────────────────────────────────────────
       Three grid columns: checkbox, body, "⋯". Because they are grid tracks
       and not flex items, the checkbox and the "⋯" line up down the whole
       list however long a title runs. The old row was a flex bag with
       `margin-left: auto` on the priority select, so every control sat at a
       different x depending on the length of the text beside it. */
    function buildTaskLi(task) {
        if (!task.subtasks) task.subtasks = [];

        const li = document.createElement('li');
        li.className = 'task-item';
        li.dataset.id = task.id;
        if (task.completed) li.classList.add('completed');
        if (task.importance) li.classList.add(`importance-${task.importance}`);

        // Applied to the task and then re-rendered, which is how every other
        // edit in this file works.
        const update = (patch) => {
            Object.assign(task, patch);
            saveTasks();
            renderTasks();
            renderCalendar();
            renderDayTasks();
        };

        // ── checkbox
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = `task-${task.id}`;
        checkbox.dataset.id = task.id;
        checkbox.checked = !!task.completed;
        checkbox.className = 'task-checkbox';
        checkbox.setAttribute('aria-label', `Mark "${task.text}" ${task.completed ? 'not done' : 'done'}`);
        li.appendChild(checkbox);

        // ── title
        const body = document.createElement('div');
        body.className = 'task-body';

        const label = document.createElement('span');
        label.className = 'task-label';
        label.textContent = task.text;
        label.tabIndex = 0;
        label.title = 'Click to rename';
        label.addEventListener('click', () => startEditingTaskName(task, li));
        label.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); startEditingTaskName(task, li); }
        });
        body.appendChild(label);

        // ── chips
        const chips = document.createElement('div');
        chips.className = 'task-chips';
        chips.appendChild(priorityChip(task.importance, (v) => update({ importance: v })));
        chips.appendChild(dueDateChip(task.dueDate, isTaskOverdue(task), (v) => update({ dueDate: v })));
        chips.appendChild(repeatChip(task.repeat, (v) => update({ repeat: v })));
        chips.appendChild(reminderChip(task.reminder, task.dueDate, (v) => update({ reminder: v, reminderFired: false })));

        const subtaskPanel = document.createElement('div');
        subtaskPanel.className = 'subtasks';

        if (task.subtasks.length) {
            const done = task.subtasks.filter(s => s.completed).length;
            const open = isSubtaskPanelOpen(task.id);
            const countChip = buildChip({
                iconName: 'chevron',
                text: `${done}/${task.subtasks.length}`,
                classes: ['chip--count'],
                expanded: open,
                title: open ? 'Hide subtasks' : 'Show subtasks',
                // Toggled in place. Re-rendering the list to open a disclosure
                // would throw away the scroll position and every hover state.
                onClick: (b) => {
                    const nowOpen = !isSubtaskPanelOpen(task.id);
                    setSubtaskPanelOpen(task.id, nowOpen);
                    subtaskPanel.hidden = !nowOpen;
                    b.setAttribute('aria-expanded', String(nowOpen));
                    b.title = nowOpen ? 'Hide subtasks' : 'Show subtasks';
                },
            });
            chips.appendChild(countChip);
        }

        body.appendChild(chips);
        li.appendChild(body);

        // ── "⋯". Every property is reachable from here as well as from its
        // chip, so nothing depends on hover being available.
        const menuBtn = moreButton('Task actions');
        menuBtn.addEventListener('click', () => {
            openPopover(menuBtn, (el, close) => {
                el.appendChild(popItem('calendar', 'Due date', () => {
                    close();
                    openDatePopover(menuBtn, task.dueDate, (v) => update({ dueDate: v }));
                }, { value: task.dueDate ? formatTaskDateDisplay(task.dueDate) : null }));

                el.appendChild(popItem('flag', 'Priority', () => {
                    close();
                    openPriorityPopover(menuBtn, task.importance, (v) => update({ importance: v }));
                }, { value: task.importance ? PRIORITY_LABEL[task.importance] : null }));

                el.appendChild(popItem('bell', 'Reminder', () => {
                    close();
                    openReminderPopover(menuBtn, task.reminder, task.dueDate, (v) => update({ reminder: v, reminderFired: false }));
                }, { value: reminderChipLabel(task.reminder) }));

                el.appendChild(popItem('repeat', 'Repeat', () => {
                    close();
                    openRepeatPopover(menuBtn, task.repeat, (v) => update({ repeat: v }));
                }, { value: repeatLabel(task.repeat) }));

                el.appendChild(popSeparator());

                el.appendChild(popItem('plus', 'Add subtask', () => {
                    close();
                    setSubtaskPanelOpen(task.id, true);
                    subtaskPanel.hidden = false;
                    startAddingSubtask(task.id, li);
                }));

                el.appendChild(popItem('pencil', 'Rename', () => {
                    close();
                    startEditingTaskName(task, li);
                }));

                el.appendChild(popSeparator());

                el.appendChild(popItem('trash', 'Delete task', () => {
                    close();
                    confirmDelete('Delete task?', `"${task.text}" and its subtasks will be removed. This cannot be undone.`, () => deleteTask(task.id));
                }, { danger: true }));
            }, { align: 'end' });
        });
        li.appendChild(menuBtn);

        // ── subtasks
        task.subtasks.forEach(subtask => subtaskPanel.appendChild(renderSubtask(subtask, task.id)));
        subtaskPanel.hidden = !task.subtasks.length || !isSubtaskPanelOpen(task.id);
        li.appendChild(subtaskPanel);

        return li;
    }


    function startEditingTaskName(task, liElement) {
        const label = liElement.querySelector('.task-label');
        if (!label) return;
        
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'task-name-editor';
        input.value = task.text;
        
        label.replaceWith(input);
        input.focus();
        input.select();
        
        let settled = false;

        function commit() {
            if (settled) return;
            settled = true;
            const newText = (input.value || '').trim();
            if (newText && newText !== task.text) {
                task.text = newText;
                saveTasks();
            }
            renderTasks();
        }

        function cancel() {
            if (settled) return;
            settled = true;
            renderTasks();
        }
        
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        });
    }

    /**
     * Pulls date shortcuts like "!today" or "!friday" out of a task name.
     *
     * Only words this function actually understands are removed. The old build
     * stripped every !word before checking, so "Buy milk !urgent" silently
     * became "Buy milk" -- text vanished with no way to tell why.
     */

    function addTask(text) {
        const trimmed = String(text || '').trim();
        if (!trimmed) return;
        
        // Parse keywords from task text
        const { cleanText, dueDate } = parseTaskKeywords(trimmed);
        if (!cleanText) return; // if all text was keywords, skip

        // Create task with parsed dueDate and no importance by default
        const task = { id: newId(), text: cleanText, completed: false, dueDate: dueDate || null, importance: null, repeat: null, reminder: null, reminderFired: false, subtasks: [] };
        tasks.unshift(task);
        saveTasks();
        taskHighlightId = task.id;
        renderTasks();
        renderCalendar();
    }

    function toggleTask(id, completed) {
        const idx = tasks.findIndex(t => String(t.id) === String(id));
        if (idx === -1) return;
        const strId = String(tasks[idx].id);
        if (completed && tasks[idx].repeat) {
            const src = tasks[idx];
            const anchorDate = src.dueDate || todayYMD();
            if (!src.dueDate) tasks[idx].dueDate = anchorDate;
            tasks[idx].completed = true;
            // Shifted in local wall-clock time. The old code moved the date and
            // then wrote it back with toISOString(), which converts to UTC: a
            // 9:00 reminder in Toronto came back as 13:00, and every further
            // repeat pushed it another offset later.
            const nextReminder = nextRepeatReminder(src.reminder, src.repeat);
            const nextTask = {
                id: newId(),
                text: src.text,
                completed: false,
                dueDate: getNextRepeatDate(anchorDate, src.repeat),
                importance: src.importance,
                repeat: src.repeat,
                reminder: nextReminder,
                reminderFired: false,
                subtasks: [],
            };
            tasks.unshift(nextTask);
        } else {
            tasks[idx].completed = !!completed;
        }
        if (completed) {
            recentlyCompleted.add(strId);
        } else {
            recentlyCompleted.delete(strId);
        }
        saveTasks();
        renderTasks();
        renderCalendar();
        renderDayTasks();
        if (completed) {
            setTimeout(() => {
                recentlyCompleted.delete(strId);
                renderTasks();
            }, 1000);
        }
    }

    function deleteTask(id) {
        const idx = tasks.findIndex(t => String(t.id) === String(id));
        if (idx === -1) return;
        tasks.splice(idx, 1);
        saveTasks();
        renderTasks();
        renderCalendar();
        renderDayTasks();
    }

    function renderSubtask(subtask, parentTaskId) {
        const el = document.createElement('div');
        el.className = 'subtask-item';
        if (subtask.completed) el.classList.add('completed');
        if (subtask.importance) el.classList.add(`importance-${subtask.importance}`);
        el.dataset.subtaskId = subtask.id;

        const update = (patch) => {
            Object.assign(subtask, patch);
            saveTasks();
            renderTasks();
            renderCalendar();
            renderDayTasks();
        };

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'subtask-checkbox';
        checkbox.checked = !!subtask.completed;
        checkbox.setAttribute('aria-label', `Mark "${subtask.text}" ${subtask.completed ? 'not done' : 'done'}`);
        checkbox.addEventListener('change', () => {
            toggleSubtask(parentTaskId, subtask.id, checkbox.checked);
        });
        el.appendChild(checkbox);

        const body = document.createElement('div');
        body.className = 'subtask-body';

        const label = document.createElement('span');
        label.className = 'subtask-label';
        label.textContent = subtask.text;
        label.tabIndex = 0;
        label.title = 'Click to rename';
        label.addEventListener('click', () => startEditingSubtaskName(parentTaskId, subtask, el));
        label.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); startEditingSubtaskName(parentTaskId, subtask, el); }
        });
        body.appendChild(label);

        // A subtask carries a due date and a priority, and nothing else. No
        // repeat and no reminder, which is what the record has always held.
        const chips = document.createElement('div');
        chips.className = 'task-chips';
        const overdue = !subtask.completed && !!subtask.dueDate && subtask.dueDate < todayYMD();
        chips.appendChild(dueDateChip(subtask.dueDate, overdue, (v) => update({ dueDate: v })));
        chips.appendChild(priorityChip(subtask.importance, (v) => update({ importance: v })));
        body.appendChild(chips);

        el.appendChild(body);

        const menuBtn = moreButton('Subtask actions');
        menuBtn.addEventListener('click', () => {
            openPopover(menuBtn, (pop, close) => {
                pop.appendChild(popItem('calendar', 'Due date', () => {
                    close();
                    openDatePopover(menuBtn, subtask.dueDate, (v) => update({ dueDate: v }));
                }, { value: subtask.dueDate ? formatTaskDateDisplay(subtask.dueDate) : null }));

                pop.appendChild(popItem('flag', 'Priority', () => {
                    close();
                    openPriorityPopover(menuBtn, subtask.importance, (v) => update({ importance: v }));
                }, { value: subtask.importance ? PRIORITY_LABEL[subtask.importance] : null }));

                pop.appendChild(popSeparator());

                pop.appendChild(popItem('pencil', 'Rename', () => {
                    close();
                    startEditingSubtaskName(parentTaskId, subtask, el);
                }));

                pop.appendChild(popItem('trash', 'Delete subtask', () => {
                    close();
                    confirmDelete('Delete subtask?', `"${subtask.text}" will be removed. This cannot be undone.`, () => deleteSubtask(parentTaskId, subtask.id));
                }, { danger: true }));
            }, { align: 'end' });
        });
        el.appendChild(menuBtn);

        return el;
    }

    function startAddingSubtask(parentTaskId, taskItemEl) {
        const subtasksContainer = taskItemEl.querySelector('.subtasks');
        if (!subtasksContainer) return;
        // A task with no subtasks yet has its panel hidden, so the input would
        // otherwise be typed into blind.
        setSubtaskPanelOpen(parentTaskId, true);
        subtasksContainer.hidden = false;
        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = 'New subtask...';
        input.className = 'subtask-input';
        
        subtasksContainer.insertBefore(input, subtasksContainer.firstChild);
        input.focus();
        
        // Settled by whichever of commit or cancel happens first, so an Escape
        // is not undone by the blur that follows removing the input.
        let settled = false;

        function commit() {
            if (settled) return;
            settled = true;

            const text = (input.value || '').trim();
            if (text) {
                addSubtask(parentTaskId, text);
            } else if (subtasksContainer.contains(input)) {
                subtasksContainer.removeChild(input);
            }
        }

        function cancel() {
            if (settled) return;
            settled = true;
            if (subtasksContainer.contains(input)) {
                subtasksContainer.removeChild(input);
            }
        }
        
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        });
        input.addEventListener('blur', () => { setTimeout(commit, 50); });
    }

    function addSubtask(parentTaskId, text) {
        const parentTask = tasks.find(t => String(t.id) === String(parentTaskId));
        if (!parentTask) return;
        if (!parentTask.subtasks) parentTask.subtasks = [];
        
        const subtask = { id: newId(), text: text, completed: false, importance: null, dueDate: null };
        parentTask.subtasks.push(subtask);
        saveTasks();
        renderTasks();
    }

    function toggleSubtask(parentTaskId, subtaskId, completed) {
        const parentTask = tasks.find(t => String(t.id) === String(parentTaskId));
        if (!parentTask) return;
        
        const subtask = parentTask.subtasks.find(st => String(st.id) === String(subtaskId));
        if (!subtask) return;
        
        subtask.completed = !!completed;
        saveTasks();
        renderTasks();
        renderCalendar();
        renderDayTasks();
    }

    function updateSubtaskImportance(parentTaskId, subtaskId, importance) {
        const parentTask = tasks.find(t => String(t.id) === String(parentTaskId));
        if (!parentTask) return;
        
        const subtask = parentTask.subtasks.find(st => String(st.id) === String(subtaskId));
        if (!subtask) return;
        
        subtask.importance = importance;
        saveTasks();
        renderTasks();
    }


    function deleteSubtask(parentTaskId, subtaskId) {
        const parentTask = tasks.find(t => String(t.id) === String(parentTaskId));
        if (!parentTask) return;
        
        const idx = parentTask.subtasks.findIndex(st => String(st.id) === String(subtaskId));
        if (idx === -1) return;
        
        parentTask.subtasks.splice(idx, 1);
        saveTasks();
        renderTasks();
    }

    function startEditingSubtaskName(parentTaskId, subtask, subtaskEl) {
        const label = subtaskEl.querySelector('.subtask-label');
        if (!label) return;
        
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'subtask-name-editor';
        input.value = subtask.text;
        
        label.replaceWith(input);
        input.focus();
        input.select();
        
        let settled = false;

        function commit() {
            if (settled) return;
            settled = true;
            const newText = (input.value || '').trim();
            if (newText && newText !== subtask.text) {
                subtask.text = newText;
                saveTasks();
            }
            renderTasks();
        }

        function cancel() {
            if (settled) return;
            settled = true;
            renderTasks();
        }
        
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        });
    }



    /** Tooltip text for the bell. Falls back rather than throwing on a bad value. */
    function reminderLabel(reminder) {
        const d = parseLocalDateTime(reminder);
        if (!d) return 'Set reminder';
        return `Reminder: ${d.toLocaleString(undefined, {
            month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
        })}`;
    }



    
    function isTaskOverdue(task) {
        // A task is overdue if it's not completed and the due date is in the past
        if (task.completed || !task.dueDate) return false;
        const today = new Date();
        const todayYMD = ymdFromDate(today);
        return task.dueDate < todayYMD;
    }

    async function requestNotifPermission() {
        if (!('Notification' in window)) return false;
        if (Notification.permission === 'granted') { syncPushSubscription(); return true; }
        if (Notification.permission === 'denied') return false;
        const granted = (await Notification.requestPermission()) === 'granted';
        if (granted) syncPushSubscription();
        return granted;
    }

    /**
     * Registers this browser with the server so a reminder can be pushed to it
     * with the tab closed. Safe to call repeatedly: it re-sends the current
     * subscription (the endpoint is the key server-side) and re-subscribes if
     * the server's VAPID key has rotated.
     *
     * Best-effort throughout. If push is not configured, not permitted, or the
     * subscribe fails, the in-tab checkReminders() loop still runs.
     *
     * Runs at most once per page load once it succeeds: the bell popover calls
     * this every time it opens, and there is nothing to redo after the
     * subscription is registered.
     */
    let pushSyncInFlight = null;
    let pushSyncDone = false;
    function syncPushSubscription() {
        if (pushSyncDone) return Promise.resolve();
        if (pushSyncInFlight) return pushSyncInFlight;
        pushSyncInFlight = (async () => {
            try {
                if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
                if (!('Notification' in window) || Notification.permission !== 'granted') return;

                const config = await getPushConfig();
                if (!config || !config.enabled || !config.publicKey) return;

                const reg = await navigator.serviceWorker.ready;
                const appKey = urlBase64ToUint8Array(config.publicKey);

                let sub = await reg.pushManager.getSubscription();
                if (sub && !applicationServerKeyMatches(sub, appKey)) {
                    // Server rotated its VAPID key; the old subscription can no
                    // longer be pushed to. Drop it here and on the server.
                    const stale = sub.endpoint;
                    await sub.unsubscribe().catch(() => {});
                    deletePushSubscription(stale).catch(() => {});
                    sub = null;
                }
                if (!sub) {
                    sub = await reg.pushManager.subscribe({
                        userVisibleOnly: true,
                        applicationServerKey: appKey,
                    });
                }

                const timeZone =
                    (Intl.DateTimeFormat().resolvedOptions().timeZone) || 'America/Toronto';
                await savePushSubscription(sub.toJSON(), timeZone);
                pushSyncDone = true;
            } catch (e) {
                console.warn('push subscription sync failed', e);
            } finally {
                pushSyncInFlight = null;
            }
        })();
        return pushSyncInFlight;
    }

    function urlBase64ToUint8Array(base64String) {
        const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
        const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
        const raw = atob(base64);
        const out = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
        return out;
    }

    function applicationServerKeyMatches(subscription, wantKey) {
        const have = subscription.options && subscription.options.applicationServerKey;
        if (!have) return true; // nothing to compare against; treat as a match
        const a = new Uint8Array(have);
        if (a.length !== wantKey.length) return false;
        for (let i = 0; i < a.length; i++) if (a[i] !== wantKey[i]) return false;
        return true;
    }

    async function fireNotification(task) {
        if (!('serviceWorker' in navigator)) return;
        try {
            const reg = await navigator.serviceWorker.ready;
            reg.showNotification(task.text, {
                body: 'Task reminder',
                tag: `task-${task.id}`,
            });
        } catch (e) {}
    }

    function checkReminders() {
        const nowMs = Date.now();
        let changed = false;
        tasks.forEach(task => {
            if (!task.reminder || task.reminderFired) return;
            const due = parseLocalDateTime(task.reminder);
            if (due && due.getTime() <= nowMs) {
                fireNotification(task);
                task.reminderFired = true;
                changed = true;
            }
        });
        if (changed) saveTasks();
    }


    // Group-by / sort-by controls
    const groupByEl = document.getElementById('task-group-by');
    const sortByEl = document.getElementById('task-sort-by');
    if (groupByEl) {
        groupByEl.addEventListener('change', () => {
            taskGroupBy = groupByEl.value;
            groupByEl.classList.toggle('active', !!taskGroupBy);
            renderTasks();
            saveViewPrefs();
        });
    }
    if (sortByEl) {
        sortByEl.addEventListener('change', () => {
            taskSortBy = sortByEl.value;
            sortByEl.classList.toggle('active', !!taskSortBy);
            renderTasks();
            saveViewPrefs();
        });
    }

    // load & initial render
    renderTasks();

    // Render calendar now that tasks are loaded so we can mark days correctly
    renderCalendar();
    renderDayTasks();

    // press enter to add
    if (taskInput) {
        taskInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                const val = taskInput.value;
                if (val && val.trim()) {
                    addTask(val);
                    taskInput.value = '';
                    taskInput.focus();
                }
            }
        });
    }

    // checkbox handling
    if (taskListEl) {
        taskListEl.addEventListener('change', (e) => {
            const target = e.target;
            if (target && target.matches('input[type="checkbox"].task-checkbox')) {
                const id = target.dataset.id;
                toggleTask(id, target.checked);
            }
        });
    }

    // ===== Pomodoro Timer Integration ===== 
    // Only initialize if pomodoro elements exist on the page
    const pomoTimerEl = document.getElementById('pomodoro-timer');
    if (pomoTimerEl) {
        const POMO_SETTINGS_KEY = 'pomoSettings';
        const POMO_STATE_KEY = 'pomoState';

        const btnPlayPause = document.getElementById('pomo-play-pause');
        const btnReset = document.getElementById('pomo-reset');
        const btnSkip = document.getElementById('pomo-skip');
        const settingsBtn = document.getElementById('pomo-settings-btn');
        const settingsDropdown = document.getElementById('pomo-settings-dropdown');
        const eyeBtn = document.getElementById('pomo-eye-btn');
        const eyeOpen = document.getElementById('pomo-eye-open');
        const eyeClosed = document.getElementById('pomo-eye-closed');
        let timerHidden = false;
        // circular progress elements (if present)
        const progressCircle = document.querySelector('.progress-ring__progress');
        const pomoModeEl = document.getElementById('pomo-mode');
        const inputWork = document.getElementById('pomo-work');
        const inputShort = document.getElementById('pomo-short');
        const inputLong = document.getElementById('pomo-long');
        const inputSessions = document.getElementById('pomo-sessions');
        const displayCurrent = document.getElementById('pomo-current');
        const displayTotal = document.getElementById('pomo-total');

        let settings = { work: 25, short: 5, long: 15, sessions: 4 };
        let state = { mode: 'work', remaining: 25 * 60, currentSession: 0, running: false };
        let intervalId = null;
        /**
         * When the current period is due to end, as a timestamp. The countdown is
         * derived from this rather than accumulated by subtracting one per tick:
         * browsers throttle timers in a background tab to about one per minute,
         * so the old counter ran far slower than real time and a 25 minute work
         * period could take an hour of wall clock while the tab sat behind others.
         */
        let endsAt = null;

        function loadSettings() {
            try {
                const raw = localStorage.getItem(POMO_SETTINGS_KEY);
                if (raw) settings = Object.assign(settings, JSON.parse(raw));
            } catch (e) { /* private browsing or malformed value */ }
        }

        /**
         * localStorage keeps the timer responsive on this device; the account
         * copy is what follows a student to another one. It is debounced and
         * only sent on real transitions, never on a tick.
         */
        function saveSettings() {
            try { localStorage.setItem(POMO_SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {}
            saveSettingsDebounced({ pomodoroSettings: { ...settings } });
        }

        function loadState() {
            try {
                const raw = localStorage.getItem(POMO_STATE_KEY);
                if (raw) state = Object.assign(state, JSON.parse(raw));
            } catch (e) { /* private browsing or malformed value */ }
            state.running = false; // never auto-resume on load
        }

        function saveState() {
            try { localStorage.setItem(POMO_STATE_KEY, JSON.stringify(state)); } catch (e) {}
            saveSettingsDebounced({
                pomodoroState: {
                    mode: state.mode,
                    remaining: state.remaining,
                    currentSession: state.currentSession,
                    runningSince: null,
                },
            });
        }

        /**
         * The account's saved timer, once it arrives. This runs well after the
         * widget has already drawn itself from localStorage: the old build read
         * the server copy synchronously at startup, before the fetch had
         * resolved, so it always saw undefined and the stored timer never
         * actually loaded on a second device.
         */
        window.applyPomodoroRemote = (pomodoro) => {
            if (!pomodoro) return;
            // A timer running here is newer than anything the server has.
            if (state.running) return;

            if (pomodoro.settings) {
                settings = Object.assign(settings, pomodoro.settings);
                if (inputWork) inputWork.value = settings.work;
                if (inputShort) inputShort.value = settings.short;
                if (inputLong) inputLong.value = settings.long;
                if (inputSessions) inputSessions.value = settings.sessions;
            }
            if (pomodoro.state) {
                state = Object.assign(state, pomodoro.state, { running: false });
                if (!state.remaining || state.remaining < 1) setRemainingFromMode();
            }
            updateUI();
        };

        function formatTime(sec) {
            const m = Math.floor(sec / 60);
            const s = sec % 60;
            return `${m}:${String(s).padStart(2, '0')}`;
        }

        function setRemainingFromMode() {
            if (state.mode === 'work') state.remaining = Math.max(1, settings.work) * 60;
            else if (state.mode === 'short') state.remaining = Math.max(1, settings.short) * 60;
            else state.remaining = Math.max(1, settings.long) * 60;
        }

        function updateCircle(remaining, total, mode) {
            if (!progressCircle || !total) return;
            try {
                const radius = progressCircle.r.baseVal.value;
                const circumference = 2 * Math.PI * radius;
                progressCircle.style.transition = 'stroke-dashoffset 1s linear';
                progressCircle.style.strokeDasharray = `${circumference}`;
                const fraction = Math.max(0, Math.min(1, remaining / total));
                const offset = circumference * (1 - fraction);
                progressCircle.style.strokeDashoffset = String(offset);
                // color by mode (class-based so the browser handles it cleanly)
                progressCircle.classList.toggle('mode-work', mode === 'work');
                progressCircle.classList.toggle('mode-break', mode !== 'work');
            } catch (e) {
                // ignore if DOM not ready
            }
        }

        function updatePlayPauseIcon() {
            const playIcon = document.querySelector('.play-icon');
            const pauseIcon = document.querySelector('.pause-icon');
            if (state.running) {
                playIcon.classList.add('hidden');
                pauseIcon.classList.remove('hidden');
            } else {
                playIcon.classList.remove('hidden');
                pauseIcon.classList.add('hidden');
            }
        }

        function updateUI() {
            pomoTimerEl.textContent = formatTime(state.remaining);
            // update center mode label
            if (pomoModeEl) {
                if (state.mode === 'work') pomoModeEl.textContent = 'Work';
                else pomoModeEl.textContent = 'Break';
            }
            displayCurrent && (displayCurrent.textContent = state.currentSession);
            displayTotal && (displayTotal.textContent = settings.sessions);
            // update circular progress ring if present
            if (progressCircle) {
                const total = state.mode === 'work' ? settings.work * 60 : (state.mode === 'short' ? settings.short * 60 : settings.long * 60);
                updateCircle(state.remaining, total, state.mode);
            }
            // update play/pause icon
            updatePlayPauseIcon();
            // disable inputs while running
            const disabled = !!state.running;
            [inputWork, inputShort, inputLong, inputSessions].forEach(i => { if (i) i.disabled = disabled; });
        }

        /**
         * Recomputes the countdown from the clock. Called on a one second
         * interval purely to repaint: if the interval is throttled or skipped
         * entirely the next call still lands on the correct remaining time,
         * because the deadline is what is authoritative, not the tick count.
         */
        function tick() {
            if (!state.running || endsAt === null) return;

            const left = Math.round((endsAt - Date.now()) / 1000);
            if (left > 0) {
                state.remaining = left;
                updateUI();
                // Deliberately no save here. This runs once a second, and the old
                // build wrote the whole timer to the database on every one of
                // them: a single 25 minute period was 1,500 writes.
                return;
            }

            state.remaining = 0;
            clearInterval(intervalId);
            intervalId = null;
            state.running = false;
            endsAt = null;
            handlePeriodEnd();
        }

        function startTimer() {
            if (intervalId) return; // already running
            state.running = true;
            endsAt = Date.now() + state.remaining * 1000;
            intervalId = setInterval(tick, 1000);
            updateUI();
            saveState();
        }

        function pauseTimer() {
            if (intervalId) {
                clearInterval(intervalId);
                intervalId = null;
            }
            // Bank the real elapsed time, not whatever the last repaint showed.
            if (state.running && endsAt !== null) {
                state.remaining = Math.max(0, Math.round((endsAt - Date.now()) / 1000));
            }
            state.running = false;
            endsAt = null;
            updateUI();
            saveState();
        }

        // Coming back to a throttled tab should show the right time at once
        // rather than after the next interval fires.
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden && state.running) tick();
        });

        function toggleTimer() {
            if (state.running) {
                pauseTimer();
            } else {
                startTimer();
            }
        }

        function resetTimer() {
            pauseTimer();
            state.mode = 'work';
            state.currentSession = 0;
            setRemainingFromMode();
            updateUI();
            saveState();
        }

        function skipPhase() {
            const wasRunning = state.running;
            pauseTimer();
            const finishedMode = state.mode;
            if (finishedMode === 'work') {
                state.currentSession = (state.currentSession || 0) + 1;
                state.mode = state.currentSession % settings.sessions === 0 ? 'long' : 'short';
            } else {
                if (finishedMode === 'long') state.currentSession = 0;
                state.mode = 'work';
            }
            setRemainingFromMode();
            if (wasRunning) startTimer();
            else updateUI();
            saveState();
        }

        const workEndSound = new Audio('workEndAlarm.mp3');
        const breakEndSound = new Audio('breakEndAlarm.mp3');

        // Unlock audio on first user interaction so timer-triggered sounds work
        let audioUnlocked = false;
        function unlockAudio() {
            if (audioUnlocked) return;
            audioUnlocked = true;
            [workEndSound, breakEndSound].forEach(snd => {
                snd.volume = 0;
                snd.play().then(() => { snd.pause(); snd.currentTime = 0; snd.volume = 1; }).catch(() => {});
            });
        }
        document.addEventListener('click', unlockAudio, { once: false });

        function playSound(snd) {
            snd.currentTime = 0;
            snd.play().catch(err => console.warn('Pomodoro sound blocked:', err));
        }

        function handlePeriodEnd() {
            // simple visual flash using body class
            document.body.classList.add('pomo-flash');
            setTimeout(() => document.body.classList.remove('pomo-flash'), 600);

            // remember which mode just finished (work/short/long)
            const finishedMode = state.mode;

            // play the appropriate alarm
            if (finishedMode === 'work') {
                playSound(workEndSound);
            } else {
                playSound(breakEndSound);
            }

            if (finishedMode === 'work') {
                state.currentSession = (state.currentSession || 0) + 1;
                // if finished cycle -> long break, otherwise short break
                if (state.currentSession % settings.sessions === 0) {
                    state.mode = 'long';
                } else {
                    state.mode = 'short';
                }
            } else {
                // a break just finished — if it was a long break, we've completed a full cycle
                if (finishedMode === 'long') {
                    // reset session counter so the next cycle starts at 0
                    state.currentSession = 0;
                }
                state.mode = 'work';
            }
            setRemainingFromMode();
            // auto-start next period
            startTimer();
            saveState();
        }

        // Wire UI events
        btnPlayPause && btnPlayPause.addEventListener('click', (e) => { e.preventDefault(); toggleTimer(); });
        btnReset && btnReset.addEventListener('click', (e) => { e.preventDefault(); resetTimer(); });
        btnSkip && btnSkip.addEventListener('click', (e) => { e.preventDefault(); skipPhase(); });

        if (eyeBtn) {
            eyeBtn.addEventListener('click', () => {
                timerHidden = !timerHidden;
                pomoTimerEl.classList.toggle('hidden-time', timerHidden);
                eyeOpen.style.display = timerHidden ? 'none' : 'block';
                eyeClosed.style.display = timerHidden ? 'block' : 'none';
            });
        }

        // Settings dropdown toggle
        if (settingsBtn && settingsDropdown) {
            settingsBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                settingsDropdown.classList.toggle('open');
            });
            document.addEventListener('click', (e) => {
                if (!settingsDropdown.contains(e.target) && e.target !== settingsBtn) {
                    settingsDropdown.classList.remove('open');
                }
            });
        }

        [inputWork, inputShort, inputLong, inputSessions].forEach(inp => {
            if (!inp) return;
            inp.addEventListener('input', () => {
                if (inputWork) settings.work = Math.max(1, parseInt(inputWork.value, 10) || 25);
                if (inputShort) settings.short = Math.max(1, parseInt(inputShort.value, 10) || 5);
                if (inputLong) settings.long = Math.max(1, parseInt(inputLong.value, 10) || 15);
                if (inputSessions) settings.sessions = Math.max(1, parseInt(inputSessions.value, 10) || 4);
                saveSettings();
                if (!state.running) {
                    setRemainingFromMode();
                    saveState();
                }
                updateUI();
            });
        });

        // Initialize
        loadSettings();
        loadState();
        // merge loaded settings into inputs
        if (inputWork) inputWork.value = settings.work;
        if (inputShort) inputShort.value = settings.short;
        if (inputLong) inputLong.value = settings.long;
        if (inputSessions) inputSessions.value = settings.sessions;
        // Only restart the period when nothing usable was stored. The old
        // threshold was 60, which threw away any paused timer with less than a
        // minute left and sent it back to a full period.
        if (!state.remaining || state.remaining < 1) setRemainingFromMode();
        updateUI();

        // The task list applies the loaded data further up this file, before
        // applyPomodoroRemote above exists. When the response had already
        // arrived by then -- the usual case, since the fetch starts before this
        // script runs -- its call found nothing and the stored timer was
        // dropped. Pick it up here instead of relying on that ordering.
        if (window.plannerData && window.plannerData.pomodoro) {
            window.applyPomodoroRemote(window.plannerData.pomodoro);
        }
    }

    setInterval(checkReminders, 60000);

});