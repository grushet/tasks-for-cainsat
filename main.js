import { saveTasksRemote, saveSettingsRemote, makeDebouncedSaver } from './api.js';
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

    // Delete confirmation modal setup
    const deleteConfirmModal = document.getElementById('delete-confirm-modal');
    const deleteConfirmCancel = document.getElementById('delete-confirm-cancel');
    const deleteConfirmYes = document.getElementById('delete-confirm-yes');
    let pendingDeleteId = null;

    function showDeleteConfirm(taskId) {
        pendingDeleteId = taskId;
        deleteConfirmModal.classList.remove('hidden');
    }

    function hideDeleteConfirm() {
        deleteConfirmModal.classList.add('hidden');
        pendingDeleteId = null;
    }

    deleteConfirmCancel.addEventListener('click', hideDeleteConfirm);
    deleteConfirmYes.addEventListener('click', () => {
        if (pendingDeleteId) {
            deleteTask(pendingDeleteId);
        }
        hideDeleteConfirm();
    });

    // Close modal on background click
    deleteConfirmModal.addEventListener('click', (e) => {
        if (e.target === deleteConfirmModal) {
            hideDeleteConfirm();
        }
    });

    // Close all open menus
    function closeAllMenus() {
        const allMenus = document.querySelectorAll('.task-menu-container, .subtask-menu-container, .task-repeat-popover, .task-bell-popover');
        allMenus.forEach(menu => menu.classList.add('hidden'));
    }

    // Close menus when clicking outside
    document.addEventListener('click', () => {
        closeAllMenus();
    });

    /**
     * The subtask panel resize, held in one place for the whole page.
     *
     * Null unless a divider is actually being dragged. These two listeners are
     * registered once; the per-task versions they replaced were added again for
     * every task on every render and never cleaned up, so a long session ended
     * up running thousands of handlers on each mouse move.
     */
    let activeDrag = null;

    document.addEventListener('mousemove', (e) => {
        if (!activeDrag) return;
        const newHeight = Math.max(0, activeDrag.startHeight + (e.clientY - activeDrag.startY));
        activeDrag.container.style.maxHeight = `${newHeight}px`;
        activeDrag.container.style.overflow = newHeight === 0 ? 'hidden' : 'auto';
    });

    document.addEventListener('mouseup', () => {
        if (!activeDrag) return;
        activeDrag.divider.classList.remove('dragging');
        activeDrag = null;
        document.body.style.cursor = 'default';
        document.body.style.userSelect = 'auto';
    });

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
                    // importance dropdown
                    const impSelect = document.createElement('select');
                    impSelect.className = 'task-importance-select';
                    impSelect.dataset.id = task.id;
                    const noneOpt = document.createElement('option'); noneOpt.value = ''; noneOpt.textContent = 'None'; noneOpt.selected = !task.importance; impSelect.appendChild(noneOpt);
                    const highOpt = document.createElement('option'); highOpt.value = 'high'; highOpt.textContent = 'High'; highOpt.selected = task.importance === 'high'; impSelect.appendChild(highOpt);
                    const medOpt = document.createElement('option'); medOpt.value = 'med'; medOpt.textContent = 'Med'; medOpt.selected = task.importance === 'med'; impSelect.appendChild(medOpt);
                    const lowOpt = document.createElement('option'); lowOpt.value = 'low'; lowOpt.textContent = 'Low'; lowOpt.selected = task.importance === 'low'; impSelect.appendChild(lowOpt);
                    impSelect.addEventListener('change', (e) => {
                        const newImp = e.target.value || null;
                        task.importance = newImp;
                        saveTasks();
                        renderTasks();
                        renderDayTasks();
                    });
                    li.appendChild(impSelect);
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
                    const impSelect = document.createElement('select');
                    impSelect.className = 'task-importance-select';
                    impSelect.dataset.parentTaskId = item.task.id;
                    impSelect.dataset.subtaskId = subtask.id;
                    const noneOpt = document.createElement('option'); noneOpt.value = ''; noneOpt.textContent = 'None'; noneOpt.selected = !subtask.importance; impSelect.appendChild(noneOpt);
                    const highOpt = document.createElement('option'); highOpt.value = 'high'; highOpt.textContent = 'High'; highOpt.selected = subtask.importance === 'high'; impSelect.appendChild(highOpt);
                    const medOpt = document.createElement('option'); medOpt.value = 'med'; medOpt.textContent = 'Med'; medOpt.selected = subtask.importance === 'med'; impSelect.appendChild(medOpt);
                    const lowOpt = document.createElement('option'); lowOpt.value = 'low'; lowOpt.textContent = 'Low'; lowOpt.selected = subtask.importance === 'low'; impSelect.appendChild(lowOpt);
                    impSelect.addEventListener('change', (e) => {
                        const newImp = e.target.value || null;
                        subtask.importance = newImp;
                        saveTasks();
                        renderTasks();
                        renderDayTasks();
                    });
                    li.appendChild(impSelect);
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

    function getUpcomingTasks() {
        const todayYMD = ymdFromDate(new Date());
        const all = [];

        tasks.forEach(task => {
            if (task.dueDate && !task.completed) {
                all.push({ id: task.id, title: task.text, dueDate: task.dueDate, type: 'Task', importance: task.importance, overdue: task.dueDate < todayYMD });
            }
            if (task.subtasks && task.subtasks.length) {
                task.subtasks.forEach(subtask => {
                    if (subtask.dueDate && !subtask.completed) {
                        all.push({ id: task.id, title: `${task.text} → ${subtask.text}`, dueDate: subtask.dueDate, type: 'Subtask', importance: subtask.importance, overdue: subtask.dueDate < todayYMD });
                    }
                });
            }
        });

        return all.sort((a, b) => {
            if (a.dueDate !== b.dueDate) return a.dueDate.localeCompare(b.dueDate);
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

        const PER_BOX_LIMIT = 3;

        const all = getUpcomingTasks();
        const buckets = [
            { label: 'Overdue',   modifier: 'overdue', items: all.filter(i => i.dueDate < todayYMD) },
            { label: 'Today',     modifier: 'today',   items: all.filter(i => i.dueDate === todayYMD) },
            { label: 'This week', modifier: '',        items: all.filter(i => i.dueDate > todayYMD && i.dueDate <= weekYMD) },
            { label: 'Later',     modifier: '',        items: all.filter(i => i.dueDate > weekYMD) }
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
                + (hasItems ? '' : ' home-summary-card--empty');

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
                bucket.items.slice(0, PER_BOX_LIMIT).forEach(item => {
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

                    const date = document.createElement('span');
                    date.className = 'home-summary-date' + (item.overdue ? ' home-summary-date--overdue' : '');
                    date.textContent = formatTaskDateDisplay(item.dueDate);

                    li.appendChild(itemText);
                    li.appendChild(date);
                    list.appendChild(li);
                });
                card.appendChild(list);

                if (bucket.items.length > PER_BOX_LIMIT) {
                    const more = document.createElement('p');
                    more.className = 'home-summary-more home-summary-more--link';
                    more.textContent = `+${bucket.items.length - PER_BOX_LIMIT} more`;
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

    function buildTaskLi(task) {
        const li = document.createElement('li');
        li.className = 'task-item';
            if (task.completed) li.classList.add('completed');
            if (task.importance === 'high') li.classList.add('importance-high');
            else if (task.importance === 'low') li.classList.add('importance-low');

            // checkbox
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.id = `task-${task.id}`;
            checkbox.dataset.id = task.id;
            checkbox.checked = !!task.completed;
            checkbox.className = 'task-checkbox';

            // task name display (clicking now edits instead of toggling)
            const label = document.createElement('span');
            label.textContent = task.text;
            label.className = 'task-label';
            label.tabIndex = 0; // make keyboard-focusable
            // clicking the name opens inline editor
            label.addEventListener('click', () => {
                startEditingTaskName(task, li);
            });
            label.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    startEditingTaskName(task, li);
                }
            });

            li.appendChild(checkbox);
            li.appendChild(label);
            
            // importance dropdown
            const impSelect = document.createElement('select');
            impSelect.className = 'task-importance-select';
            impSelect.dataset.id = task.id;
            
            const noneOpt = document.createElement('option');
            noneOpt.value = '';
            noneOpt.textContent = 'None';
            noneOpt.selected = !task.importance;
            impSelect.appendChild(noneOpt);
            
            const highOpt = document.createElement('option');
            highOpt.value = 'high';
            highOpt.textContent = 'High';
            highOpt.selected = task.importance === 'high';
            impSelect.appendChild(highOpt);
            
            const medOpt = document.createElement('option');
            medOpt.value = 'med';
            medOpt.textContent = 'Med';
            medOpt.selected = task.importance === 'med';
            impSelect.appendChild(medOpt);
            
            const lowOpt = document.createElement('option');
            lowOpt.value = 'low';
            lowOpt.textContent = 'Low';
            lowOpt.selected = task.importance === 'low';
            impSelect.appendChild(lowOpt);
            
            impSelect.addEventListener('change', (e) => {
                const newImp = e.target.value || null;
                task.importance = newImp;
                saveTasks();
                renderTasks();
            });
            li.appendChild(impSelect);
            
            // date badge or 'add date' affordance
            if (task.dueDate) {
                const badge = document.createElement('span');
                badge.className = 'task-date-badge';
                badge.tabIndex = 0;
                badge.title = parseDateYMD(task.dueDate).toLocaleDateString();
                badge.textContent = formatTaskDateDisplay(task.dueDate);
                
                // Apply red color if task is overdue
                if (isTaskOverdue(task)) {
                    badge.style.color = '#ff6b6b';
                }
                
                // click or Enter on badge to edit
                badge.addEventListener('click', () => startEditingDate(task));
                badge.addEventListener('keydown', (e) => { if (e.key === 'Enter') startEditingDate(task); });
                li.appendChild(badge);
            } else {
                const add = document.createElement('button');
                add.type = 'button';
                add.className = 'task-date-add';
                add.textContent = '+ Add date';
                add.addEventListener('click', () => startEditingDate(task));
                li.appendChild(add);
            }
            
            // repeat button + popover
            const repeatWrapper = document.createElement('span');
            repeatWrapper.className = 'task-repeat-wrapper';

            const repeatBtn = document.createElement('button');
            repeatBtn.type = 'button';
            repeatBtn.className = 'task-repeat-btn' + (task.repeat ? ' active' : '');
            repeatBtn.textContent = '↻';
            repeatBtn.title = task.repeat ? `Every ${task.repeat.n} ${task.repeat.unit}` : 'Set repeat';

            const repeatPopover = document.createElement('div');
            repeatPopover.className = 'task-repeat-popover hidden';

            const repeatNInput = document.createElement('input');
            repeatNInput.type = 'number';
            repeatNInput.className = 'task-repeat-n';
            repeatNInput.min = '1';
            repeatNInput.placeholder = '1';
            if (task.repeat) repeatNInput.value = task.repeat.n;

            const repeatUnitSelect = document.createElement('select');
            repeatUnitSelect.className = 'task-repeat-unit';
            ['days', 'weeks', 'months'].forEach(unit => {
                const opt = document.createElement('option');
                opt.value = unit;
                opt.textContent = unit.charAt(0).toUpperCase() + unit.slice(1);
                opt.selected = task.repeat ? task.repeat.unit === unit : unit === 'days';
                repeatUnitSelect.appendChild(opt);
            });

            function applyRepeat() {
                const n = parseInt(repeatNInput.value, 10);
                if (!n || n < 1) {
                    task.repeat = null;
                    repeatBtn.classList.remove('active');
                    repeatBtn.title = 'Set repeat';
                } else {
                    task.repeat = { n, unit: repeatUnitSelect.value };
                    repeatBtn.classList.add('active');
                    repeatBtn.title = `Every ${n} ${repeatUnitSelect.value}`;
                }
                saveTasks();
            }

            repeatNInput.addEventListener('change', applyRepeat);
            repeatUnitSelect.addEventListener('change', () => {
                applyRepeat();
                repeatPopover.classList.add('hidden');
            });
            repeatNInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); applyRepeat(); repeatPopover.classList.add('hidden'); }
                if (e.key === 'Escape') repeatPopover.classList.add('hidden');
            });

            repeatBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                closeAllMenus();
                repeatPopover.classList.toggle('hidden');
                if (!repeatPopover.classList.contains('hidden')) repeatNInput.focus();
            });

            repeatPopover.addEventListener('click', (e) => e.stopPropagation());

            repeatPopover.appendChild(repeatNInput);
            repeatPopover.appendChild(repeatUnitSelect);
            repeatWrapper.appendChild(repeatBtn);
            repeatWrapper.appendChild(repeatPopover);
            li.appendChild(repeatWrapper);

            // bell button + reminder popover
            const bellWrapper = document.createElement('span');
            bellWrapper.className = 'task-bell-wrapper';

            const bellBtn = document.createElement('button');
            bellBtn.type = 'button';
            bellBtn.className = 'task-bell-btn' + (task.reminder ? ' active' : '');
            bellBtn.textContent = '🔔';
            bellBtn.title = task.reminder
                ? reminderLabel(task.reminder)
                : 'Set reminder';

            const bellPopover = document.createElement('div');
            bellPopover.className = 'task-bell-popover hidden';

            const reminderDateInput = document.createElement('input');
            reminderDateInput.type = 'date';
            reminderDateInput.className = 'task-reminder-date';
            reminderDateInput.value = task.reminder ? task.reminder.slice(0, 10) : '';

            const reminderTimeInput = document.createElement('input');
            reminderTimeInput.type = 'time';
            reminderTimeInput.className = 'task-reminder-time';
            reminderTimeInput.value = task.reminder ? task.reminder.slice(11, 16) : '09:00';

            const clearReminderBtn = document.createElement('button');
            clearReminderBtn.type = 'button';
            clearReminderBtn.className = 'task-reminder-clear';
            clearReminderBtn.textContent = '✕';
            clearReminderBtn.title = 'Clear reminder';

            function applyReminder() {
                const d = reminderDateInput.value;
                const t = reminderTimeInput.value;
                if (d && t) {
                    task.reminder = `${d}T${t}`;
                    task.reminderFired = false;
                    bellBtn.classList.add('active');
                    bellBtn.title = reminderLabel(task.reminder);
                } else {
                    task.reminder = null;
                    task.reminderFired = false;
                    bellBtn.classList.remove('active');
                    bellBtn.title = 'Set reminder';
                }
                saveTasks();
            }

            reminderTimeInput.addEventListener('change', applyReminder);
            reminderDateInput.addEventListener('change', applyReminder);
            [reminderDateInput, reminderTimeInput].forEach(inp => {
                inp.addEventListener('keydown', (e) => {
                    if (e.key === 'Escape') bellPopover.classList.add('hidden');
                });
            });
            clearReminderBtn.addEventListener('click', () => {
                task.reminder = null;
                task.reminderFired = false;
                bellBtn.classList.remove('active');
                bellBtn.title = 'Set reminder';
                reminderDateInput.value = '';
                saveTasks();
                bellPopover.classList.add('hidden');
            });

            bellBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                closeAllMenus();
                bellPopover.classList.toggle('hidden');
                if (!bellPopover.classList.contains('hidden')) {
                    if (!reminderDateInput.value) reminderDateInput.value = task.dueDate || todayYMD();
                    requestNotifPermission();
                    reminderDateInput.focus();
                }
            });
            bellPopover.addEventListener('click', (e) => e.stopPropagation());

            bellPopover.appendChild(reminderDateInput);
            bellPopover.appendChild(reminderTimeInput);
            bellPopover.appendChild(clearReminderBtn);
            bellWrapper.appendChild(bellBtn);
            bellWrapper.appendChild(bellPopover);
            li.appendChild(bellWrapper);

            // add subtask button
            if (!task.subtasks) task.subtasks = [];
            const addSubtaskBtn = document.createElement('button');
            addSubtaskBtn.type = 'button';
            addSubtaskBtn.className = 'add-subtask-btn-inline';
            addSubtaskBtn.textContent = '+ Subtask';
            addSubtaskBtn.addEventListener('click', () => {
                startAddingSubtask(task.id, li);
            });
            li.appendChild(addSubtaskBtn);
            
            // three-dot menu button (at the end - rightmost)
            const menuBtn = document.createElement('button');
            menuBtn.type = 'button';
            menuBtn.className = 'task-menu-btn';
            menuBtn.textContent = '⋯';
            menuBtn.title = 'More options';
            
            // create menu container
            const menuContainer = document.createElement('div');
            menuContainer.className = 'task-menu-container hidden';
            
            const editBtn = document.createElement('button');
            editBtn.type = 'button';
            editBtn.className = 'task-menu-option';
            editBtn.textContent = 'Edit';
            editBtn.addEventListener('click', () => {
                closeAllMenus();
                startEditingTaskName(task, li);
            });
            
            const deleteBtn = document.createElement('button');
            deleteBtn.type = 'button';
            deleteBtn.className = 'task-menu-option delete-option';
            deleteBtn.textContent = 'Delete';
            deleteBtn.addEventListener('click', () => {
                closeAllMenus();
                deleteTask(task.id);
            });
            
            menuContainer.appendChild(editBtn);
            menuContainer.appendChild(deleteBtn);
            
            menuBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                closeAllMenus();
                menuContainer.classList.remove('hidden');
            });
            
            li.appendChild(menuBtn);
            li.appendChild(menuContainer);
            
            // Draggable divider between task and subtasks
            const divider = document.createElement('div');
            divider.className = 'subtask-divider';
            divider.dataset.taskId = task.id;
            
            // Only the mousedown lives on the element. The move and release
            // handlers are registered once for the whole document (see
            // activeDrag below): binding them here meant two new document
            // listeners per task on every single re-render, none ever removed.
            divider.addEventListener('mousedown', (e) => {
                e.preventDefault();
                activeDrag = {
                    divider,
                    container: subtasksContainer,
                    startY: e.clientY,
                    startHeight: subtasksContainer.offsetHeight,
                };
                divider.classList.add('dragging');
                document.body.style.cursor = 'row-resize';
                document.body.style.userSelect = 'none';
            });

            li.appendChild(divider);
            
            // Subtasks container (rendered below the main task row)
            const subtasksContainer = document.createElement('div');
            subtasksContainer.className = 'subtasks-container';
            
            // Render existing subtasks
            task.subtasks.forEach(subtask => {
                const subtaskEl = renderSubtask(subtask, task.id);
                subtasksContainer.appendChild(subtaskEl);
            });
            
            li.appendChild(subtasksContainer);
            return li;
    }

    function startEditingDate(task) {
        // find the task's list item and replace the display with a date input
        const li = taskListEl.querySelector(`input[data-id="${task.id}"]`)?.closest('.task-item');
        if (!li) return;
        const existingBadge = li.querySelector('.task-date-badge, .task-date-add');
        const input = document.createElement('input');
        input.type = 'date';
        input.className = 'task-date-editor';
        input.value = task.dueDate || '';
        // replace badge/add-button with the editor
        if (existingBadge) existingBadge.replaceWith(input);
        input.focus();

        let settled = false;

        function commit() {
            if (settled) return;
            settled = true;
            const val = input.value || null;
            tasks = tasks.map(t => t.id === task.id ? Object.assign({}, t, { dueDate: val }) : t);
            saveTasks();
            renderTasks();
            renderCalendar();
            renderDayTasks();
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
        const subtaskEl = document.createElement('div');
        subtaskEl.className = 'subtask-item';
        if (subtask.completed) subtaskEl.classList.add('completed');
        if (subtask.importance === 'high') subtaskEl.classList.add('importance-high');
        else if (subtask.importance === 'low') subtaskEl.classList.add('importance-low');
        subtaskEl.dataset.subtaskId = subtask.id;
        
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'subtask-checkbox';
        checkbox.checked = !!subtask.completed;
        checkbox.addEventListener('change', () => {
            toggleSubtask(parentTaskId, subtask.id, checkbox.checked);
        });
        
        const label = document.createElement('span');
        label.className = 'subtask-label';
        label.textContent = subtask.text;
        label.tabIndex = 0;
        label.addEventListener('click', () => {
            startEditingSubtaskName(parentTaskId, subtask, subtaskEl);
        });
        label.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                startEditingSubtaskName(parentTaskId, subtask, subtaskEl);
            }
        });
        
        // importance dropdown
        const impSelect = document.createElement('select');
        impSelect.className = 'subtask-importance-select';
        impSelect.dataset.id = subtask.id;
        
        const noneOpt = document.createElement('option');
        noneOpt.value = '';
        noneOpt.textContent = 'None';
        noneOpt.selected = !subtask.importance;
        impSelect.appendChild(noneOpt);
        
        const highOpt = document.createElement('option');
        highOpt.value = 'high';
        highOpt.textContent = 'High';
        highOpt.selected = subtask.importance === 'high';
        impSelect.appendChild(highOpt);
        
        const medOpt = document.createElement('option');
        medOpt.value = 'med';
        medOpt.textContent = 'Med';
        medOpt.selected = subtask.importance === 'med';
        impSelect.appendChild(medOpt);
        
        const lowOpt = document.createElement('option');
        lowOpt.value = 'low';
        lowOpt.textContent = 'Low';
        lowOpt.selected = subtask.importance === 'low';
        impSelect.appendChild(lowOpt);
        
        impSelect.addEventListener('change', (e) => {
            const newImp = e.target.value || null;
            updateSubtaskImportance(parentTaskId, subtask.id, newImp);
        });
        
        // date badge or 'add date' affordance
        let dateElement;
        if (subtask.dueDate) {
            const badge = document.createElement('span');
            badge.className = 'subtask-date-badge';
            badge.title = parseDateYMD(subtask.dueDate).toLocaleDateString();
            badge.textContent = formatTaskDateDisplay(subtask.dueDate);
            badge.addEventListener('click', () => startEditingSubtaskDate(parentTaskId, subtask.id, subtaskEl));
            dateElement = badge;
        } else {
            const add = document.createElement('button');
            add.type = 'button';
            add.className = 'subtask-date-add';
            add.textContent = '+ Date';
            add.addEventListener('click', () => startEditingSubtaskDate(parentTaskId, subtask.id, subtaskEl));
            dateElement = add;
        }
        
        // three-dot menu button for subtask
        const menuBtn = document.createElement('button');
        menuBtn.type = 'button';
        menuBtn.className = 'subtask-menu-btn';
        menuBtn.textContent = '⋯';
        menuBtn.title = 'More options';
        
        // create menu container
        const menuContainer = document.createElement('div');
        menuContainer.className = 'subtask-menu-container hidden';
        
        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'subtask-menu-option';
        editBtn.textContent = 'Edit';
        editBtn.addEventListener('click', () => {
            closeAllMenus();
            startEditingSubtaskName(parentTaskId, subtask, subtaskEl);
        });
        
        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'subtask-menu-option delete-option';
        deleteBtn.textContent = 'Delete';
        deleteBtn.addEventListener('click', () => {
            closeAllMenus();
            deleteSubtask(parentTaskId, subtask.id);
        });
        
        menuContainer.appendChild(editBtn);
        menuContainer.appendChild(deleteBtn);
        
        menuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            closeAllMenus();
            menuContainer.classList.remove('hidden');
        });
        
        subtaskEl.appendChild(checkbox);
        subtaskEl.appendChild(label);
        subtaskEl.appendChild(impSelect);
        subtaskEl.appendChild(dateElement);
        subtaskEl.appendChild(menuBtn);
        subtaskEl.appendChild(menuContainer);
        
        return subtaskEl;
    }

    function startAddingSubtask(parentTaskId, taskItemEl) {
        const subtasksContainer = taskItemEl.querySelector('.subtasks-container');
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

    function startEditingSubtaskDate(parentTaskId, subtaskId, subtaskEl) {
        const parentTask = tasks.find(t => String(t.id) === String(parentTaskId));
        if (!parentTask) return;
        
        const subtask = parentTask.subtasks.find(st => String(st.id) === String(subtaskId));
        if (!subtask) return;
        
        const existingDateEl = subtaskEl.querySelector('.subtask-date-badge, .subtask-date-add');
        const input = document.createElement('input');
        input.type = 'date';
        input.className = 'subtask-date-editor';
        input.value = subtask.dueDate || '';
        
        if (existingDateEl) existingDateEl.replaceWith(input);
        input.focus();
        
        let settled = false;

        function commit() {
            if (settled) return;
            settled = true;
            subtask.dueDate = input.value || null;
            saveTasks();
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
        if (Notification.permission === 'granted') return true;
        if (Notification.permission === 'denied') return false;
        return (await Notification.requestPermission()) === 'granted';
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