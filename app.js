// ============================================================
// Hospital Aveiro – Workforce Schedule Manager
// Centro Hospitalar do Baixo Vouga
// ============================================================

const DAYS = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];
const DAYS_FULL = ['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado', 'Domingo'];
const SHIFTS = ['day', 'night'];
const SHIFT_LABELS = { day: 'Diurno', night: 'Noturno' };
const SHIFT_TIMES = { day: '08:30–20:30', night: '20:30–08:30' };
const DOCTORS_PER_SHIFT = 2;
const HOURS_PER_SHIFT = 12;
const MONTH_NAMES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
    'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

// ---- Supabase ----
const SUPABASE_URL = 'https://gptovrbtiosdfqawwwcb.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdwdG92cmJ0aW9zZGZxYXd3d2NiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQyMTM5MzksImV4cCI6MjA4OTc4OTkzOX0.0nZmLu7SF2elW33fIAthRM0u3-kV8xS_N7iETY60wz4';
const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const LOCAL_CACHE_KEY = 'chbv_local_cache';

// A pending local snapshot older than this is thrown away rather than replayed:
// pushing a days-old copy of everything over live data loses more than it saves.
const LOCAL_CACHE_MAX_AGE_MS = 8 * 60 * 60 * 1000; // 8h

function writeLocalCache(pending) {
    try {
        localStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify({
            version: 1, timestamp: Date.now(), pending,
            doctors, schedules, terceiros, rotations: rotationGrid
        }));
    } catch (e) { console.warn('localStorage cheia ou indisponível', e); }
}

function readLocalCache() {
    try {
        const raw = localStorage.getItem(LOCAL_CACHE_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch { return null; }
}

function clearLocalCache() {
    try { localStorage.removeItem(LOCAL_CACHE_KEY); } catch {}
}

// ---- Concurrency ----
// Several people (admin + tarefeiros on phones) use this at once, and every client
// holds the whole dataset in memory. To avoid one client's stale copy overwriting
// everyone else's work we keep the exact value we last read from the server as a
// merge BASE, then on save only push the keys we actually changed, three-way merged
// against whatever is on the server right now.
const DATA_KEYS = {
    chbv_doctors:   { get: () => doctors,      set: v => { doctors = v; } },
    chbv_schedules: { get: () => schedules,    set: v => { schedules = v; } },
    chbv_rotations: { get: () => rotationGrid, set: v => { rotationGrid = migrateRotationsToGrid(v); } },
    chbv_terceiros: { get: () => terceiros,    set: v => { terceiros = v; } },
};
let _base = {};   // key -> JSON string of the server value this client started from

function snapshotBase() {
    Object.keys(DATA_KEYS).forEach(k => { _base[k] = JSON.stringify(DATA_KEYS[k].get() ?? null); });
}

function localChanged(key) {
    return JSON.stringify(DATA_KEYS[key].get() ?? null) !== _base[key];
}

// Merge helper: for a map of independent entries, an entry I changed wins, otherwise
// the server's entry wins. Entries only I added are kept; entries only I deleted stay deleted.
function mergeById(baseArr, mineArr, theirsArr, idOf) {
    const base = new Map((baseArr || []).map(x => [idOf(x), JSON.stringify(x)]));
    const mine = new Map((mineArr || []).map(x => [idOf(x), x]));
    const theirs = new Map((theirsArr || []).map(x => [idOf(x), x]));
    const out = [];
    const seen = new Set();
    // Keep server order first, so other people's additions survive
    (theirsArr || []).forEach(t => {
        const id = idOf(t);
        seen.add(id);
        if (!mine.has(id)) {
            // I deleted it only if I had it to begin with
            if (base.has(id)) return;
            out.push(t);
            return;
        }
        const iChangedIt = JSON.stringify(mine.get(id)) !== base.get(id);
        out.push(iChangedIt ? mine.get(id) : t);
    });
    // Entries I have that the server doesn't: genuinely new locally → keep.
    // But if the BASE had it, someone else deleted it — don't resurrect a deleted card.
    (mineArr || []).forEach(m => {
        const id = idOf(m);
        if (!seen.has(id) && !base.has(id)) out.push(m);
    });
    return out;
}

// Schedules: { weekKey: { shiftKey: [ids] } }. Merge shift by shift.
function mergeSchedules(base, mine, theirs) {
    base = base || {}; mine = mine || {}; theirs = theirs || {};
    const out = JSON.parse(JSON.stringify(theirs));
    Object.keys(mine).forEach(wk => {
        Object.keys(mine[wk] || {}).forEach(sk => {
            const mineVal = JSON.stringify(mine[wk][sk]);
            const baseVal = JSON.stringify((base[wk] || {})[sk] ?? null);
            if (mineVal !== baseVal) {                     // I touched this shift → mine wins
                if (!out[wk]) out[wk] = {};
                out[wk][sk] = mine[wk][sk];
            }
        });
    });
    // Shifts I deleted (had a base value, gone locally) stay deleted
    Object.keys(base).forEach(wk => {
        Object.keys(base[wk] || {}).forEach(sk => {
            const goneLocally = !(mine[wk] || {})[sk];
            const unchangedByThem = JSON.stringify((theirs[wk] || {})[sk] ?? null) === JSON.stringify(base[wk][sk]);
            if (goneLocally && unchangedByThem && out[wk]) delete out[wk][sk];
        });
    });
    return out;
}

// Rotation grid: merge cell by cell, keeping cycle settings from whoever changed them.
function mergeRotationGrid(base, mine, theirs) {
    base = base || {}; mine = mine || {}; theirs = theirs || {};
    const out = JSON.parse(JSON.stringify(theirs));
    if (JSON.stringify(mine.cycleLength) !== JSON.stringify(base.cycleLength)) out.cycleLength = mine.cycleLength;
    if (JSON.stringify(mine.anchorWeek) !== JSON.stringify(base.anchorWeek)) out.anchorWeek = mine.anchorWeek;
    out.cells = out.cells || {};
    Object.keys(mine.cells || {}).forEach(k => {
        const mineVal = JSON.stringify(mine.cells[k]);
        const baseVal = JSON.stringify((base.cells || {})[k] ?? null);
        if (mineVal !== baseVal) out.cells[k] = mine.cells[k];
    });
    return out;
}

function mergeKey(key, theirsRaw) {
    const base = _base[key] ? JSON.parse(_base[key]) : null;
    const mine = DATA_KEYS[key].get();
    const theirs = theirsRaw ?? null;
    if (theirs === null) return mine;                       // nothing on the server yet
    switch (key) {
        case 'chbv_doctors':
        case 'chbv_terceiros':
            return mergeById(base, mine, theirs, x => x && x.id);
        case 'chbv_schedules':
            return mergeSchedules(base, mine, theirs);
        case 'chbv_rotations':
            return mergeRotationGrid(migrateRotationsToGrid(base), mine, migrateRotationsToGrid(theirs));
        default:
            return mine;
    }
}

async function loadData() {
    const { data, error } = await db.from('app_data').select('*');
    if (error) { console.error('Erro ao carregar dados:', error); }
    if (data) {
        data.forEach(row => {
            // Guard against a null/!malformed row: it used to abort sign-in entirely
            if (row.value === null || row.value === undefined) return;
            if (row.key === 'chbv_doctors' && Array.isArray(row.value)) doctors = row.value;
            if (row.key === 'chbv_schedules' && typeof row.value === 'object') schedules = row.value;
            if (row.key === 'chbv_rotations') rotationGrid = migrateRotationsToGrid(row.value);
            if (row.key === 'chbv_terceiros' && Array.isArray(row.value)) terceiros = row.value;
        });
    }
    if (!Array.isArray(doctors)) doctors = [];
    if (!Array.isArray(terceiros)) terceiros = [];
    if (!schedules || typeof schedules !== 'object') schedules = {};

    // Restore pending local edits that never reached the server — but only if recent.
    const cache = readLocalCache();
    if (cache && cache.pending) {
        const age = Date.now() - (cache.timestamp || 0);
        if (age > LOCAL_CACHE_MAX_AGE_MS) {
            console.warn(`Alterações locais pendentes demasiado antigas (${Math.round(age/3600000)}h) — descartadas.`);
            clearLocalCache();
            snapshotBase();
        } else {
            console.warn(`A restaurar alterações locais pendentes (${Math.round(age/60000)} min)`);
            snapshotBase();                       // server state is the merge base…
            if (cache.doctors)   doctors   = cache.doctors;
            if (cache.schedules) schedules = cache.schedules;
            if (cache.rotations) rotationGrid = migrateRotationsToGrid(cache.rotations);
            if (cache.terceiros) terceiros = cache.terceiros;
            setTimeout(() => save(), 500);        // …and the save merges instead of overwriting
        }
    } else {
        snapshotBase();
    }
}

// Pull other people's changes in without losing local edits (merged, never blind-replaced).
async function refreshFromServer() {
    if (_saveInFlight || _saveTimer || _retryTimer) return;              // a save is mid-flight; it will merge
    const { data, error } = await db.from('app_data').select('*');
    if (error || !data) return;
    let changed = false;
    data.forEach(row => {
        if (!DATA_KEYS[row.key] || row.value === null || row.value === undefined) return;
        const merged = mergeKey(row.key, row.value);
        if (JSON.stringify(merged) !== JSON.stringify(DATA_KEYS[row.key].get())) changed = true;
        DATA_KEYS[row.key].set(merged);
    });
    snapshotBase();
    if (changed) renderAll();
}

// Re-render whatever the current user can see.
function renderAll() {
    try {
        if (currentRole === 'tarefeiro') { renderTerceiros(); return; }
        renderSchedule(); renderDoctors(); renderTerceiros(); renderRotations(); renderHoursSummary();
    } catch (e) { console.warn('render falhou', e); }
}

// The rotation grid is a single 8-week (N-week) master schedule, like the Excel:
//   { cycleLength, anchorWeek, cells: { "<dayIdx>_<shift>": [ [docId,...] x cycleLength ] } }
function createEmptyRotationGrid() {
    return { cycleLength: 8, anchorWeek: getCurrentISOWeek(), cells: {} };
}

// Accept any stored value (new grid, legacy rotation array, or null) and
// return a well-formed rotation grid.
function migrateRotationsToGrid(value) {
    if (value && !Array.isArray(value) && value.cells) {
        return {
            cycleLength: value.cycleLength || 8,
            anchorWeek: value.anchorWeek || getCurrentISOWeek(),
            cells: value.cells || {},
        };
    }
    const grid = createEmptyRotationGrid();
    if (Array.isArray(value) && value.length) {
        let maxLen = 2, anchor = null;
        value.forEach(r => {
            const len = r.cycleLength || (r.weeks ? r.weeks.length : 2);
            if (len > maxLen) maxLen = len;
            if (!anchor) anchor = r.anchorWeek || r.startWeek;
        });
        grid.cycleLength = maxLen;
        grid.anchorWeek = anchor || grid.anchorWeek;
        value.forEach(r => {
            const weeks = r.weeks || [[r.doctorA], [r.doctorB]]; // legacy A/B
            const cell = [];
            for (let w = 0; w < grid.cycleLength; w++) {
                cell.push(weeks[w] ? weeks[w].filter(Boolean) : []);
            }
            grid.cells[`${r.dayIdx}_${r.shift}`] = cell;
        });
    }
    return grid;
}

// ---- Auth State ----
let currentUser = null;
let currentRole = null;
let suppressAuthChange = false;

// ---- State ----
let scheduleViewMode = 'calendar'; // 'calendar' or 'list'
let doctors = [];
let schedules = {};
let rotationGrid = createEmptyRotationGrid();
let terceiros = [];
let currentWeekStart = getMonday(new Date());
let currentSchedMonth = new Date().getMonth();
let currentSchedYear = new Date().getFullYear();

// Modal state for monthly calendar
let modalAvailMonth = new Date().getMonth();
let modalAvailYear = new Date().getFullYear();
let modalAvailMode = 'available'; // 'available', 'unavailable', or 'vacation'
let modalAvailData = {};    // days the doctor CAN work
let modalUnavailData = {};  // days the doctor CANNOT work
let modalVacationData = {}; // days the doctor is on vacation (férias)

// Modal state for fixed monthly calendar
let modalFixedMonth = new Date().getMonth();
let modalFixedYear = new Date().getFullYear();
let modalFixedMonthlyData = {};
let modalFixedWeeklyMode = 'works'; // 'works' or 'blocked'
let modalFixedBlockedData = {}; // separate store for blocked shifts

// Modal state for terceiro availability calendar
let modalTercAvailData = {};
let modalTercAvailBase = {};
let modalTercAvailMonth = new Date().getMonth();
let modalTercAvailYear = new Date().getFullYear();

// Role 'tarefeiro': the terceiro card linked to the logged-in user (matched by email),
// and a flag restricting the availability editor to shifts that still have a gap ("furo").
let currentTerceiroId = null;
let tercFuroOnly = false;

// Modal state for monthly day rules
let modalRulesData = []; // [ {dayOfWeek, shiftType, count}, ... ] — applies to every month

// Returns a doctor's day-of-week rules as a flat array.
// Migrates legacy month-keyed shape { "YYYY-MM": [rules] } by merging unique
// (dayOfWeek, shiftType) entries and taking the max count, so no rule is lost.
function getDoctorRules(doc) {
    const r = doc && doc.monthlyDayRules;
    if (!r) return [];
    if (Array.isArray(r)) return r;
    const merged = {};
    Object.values(r).forEach(arr => {
        if (!Array.isArray(arr)) return;
        arr.forEach(rule => {
            const k = `${rule.dayOfWeek}_${rule.shiftType}`;
            if (!merged[k] || rule.count > merged[k].count) {
                merged[k] = { dayOfWeek: rule.dayOfWeek, shiftType: rule.shiftType, count: rule.count };
            }
        });
    });
    return Object.values(merged);
}

// ---- History ----
let lastHistorySaveTime = 0;
const HISTORY_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const HISTORY_MAX_DAYS = 30;

async function saveHistory() {
    const now = Date.now();
    if (now - lastHistorySaveTime < HISTORY_INTERVAL_MS) return;
    lastHistorySaveTime = now;
    await db.from('app_data_history').insert({
        doctors, schedules, terceiros, rotations: rotationGrid
    });
    // Delete entries older than 30 days
    const cutoff = new Date(now - HISTORY_MAX_DAYS * 24 * 60 * 60 * 1000).toISOString();
    await db.from('app_data_history').delete().lt('saved_at', cutoff);
}

async function loadHistory() {
    const { data, error } = await db.from('app_data_history')
        .select('id, saved_at')
        .order('saved_at', { ascending: false })
        .limit(50);
    if (error) { console.error(error); return []; }
    return data;
}

async function restoreHistory(id) {
    const { data, error } = await db.from('app_data_history')
        .select('*').eq('id', id).single();
    if (error || !data) { alert('Erro ao carregar versão.'); return; }
    // Save current state to history before restoring
    lastHistorySaveTime = 0;
    await saveHistory();
    // Validate before overwriting live state: a malformed column used to be assigned
    // straight in and then throw inside every hours calculation.
    if (!Array.isArray(data.doctors) || !data.schedules || typeof data.schedules !== 'object') {
        alert('Essa versão está incompleta e não pode ser restaurada.');
        return;
    }
    const prev = { doctors, schedules, rotationGrid, terceiros };
    doctors = data.doctors;
    schedules = data.schedules;
    rotationGrid = migrateRotationsToGrid(data.rotations);
    terceiros = Array.isArray(data.terceiros) ? data.terceiros : [];

    const { error: writeErr } = await db.from('app_data').upsert([
        { key: 'chbv_doctors', value: doctors },
        { key: 'chbv_schedules', value: schedules },
        { key: 'chbv_rotations', value: rotationGrid },
        { key: 'chbv_terceiros', value: terceiros },
    ]);
    if (writeErr) {
        // Roll the local state back so the screen doesn't claim a restore that
        // never reached the server.
        doctors = prev.doctors; schedules = prev.schedules;
        rotationGrid = prev.rotationGrid; terceiros = prev.terceiros;
        alert('Não foi possível restaurar essa versão: ' + (writeErr.message || writeErr));
        return;
    }
    snapshotBase();                      // the server now matches what we hold
    renderAll();
    closeHistoryModal();
    showSaveStatus('Versão restaurada!');
}

function openHistoryModal() {
    const modal = document.getElementById('history-modal');
    const content = document.getElementById('history-content');
    content.innerHTML = '<p style="padding:16px;color:#7f8c8d">A carregar...</p>';
    modal.classList.add('open');
    loadHistory().then(entries => {
        if (!entries || entries.length === 0) {
            content.innerHTML = '<p style="padding:16px;color:#7f8c8d">Sem histórico guardado ainda.</p>';
            return;
        }
        content.innerHTML = entries.map(e => {
            const d = new Date(e.saved_at);
            const label = d.toLocaleString('pt-PT', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
            return `<div class="history-entry">
                <span class="history-date">📅 ${label}</span>
                <button class="btn btn-sm btn-primary" onclick="restoreHistory(${e.id})">Restaurar</button>
            </div>`;
        }).join('');
    }).catch(err => {
        content.innerHTML = `<p style="padding:16px;color:#991b1b">Erro ao carregar o histórico: ${esc(err.message || err)}</p>`;
    });
}

function closeHistoryModal() {
    document.getElementById('history-modal').classList.remove('open');
}

let _saveTimer = null;
let _saveInFlight = false;
let _retryTimer = null;
const SAVE_DEBOUNCE_MS = 400;
const RETRY_BACKOFF_MS = [1000, 3000, 8000];

function setSaveStatus(state, msg) {
    const el = document.getElementById('save-status');
    if (!el) return;
    el.classList.remove('saving', 'saved', 'failed');
    if (state) el.classList.add(state);
    el.textContent = msg;
}

function save() {
    writeLocalCache(true);             // instant local backup
    setSaveStatus('saving', '⏳ A guardar...');
    if (_saveTimer)  clearTimeout(_saveTimer);
    if (_retryTimer) { clearTimeout(_retryTimer); _retryTimer = null; }
    _saveTimer = setTimeout(performSave, SAVE_DEBOUNCE_MS);
}

async function performSave() {
    _saveTimer = null;
    if (_saveInFlight) {               // overlap → re-queue after current finishes
        _saveTimer = setTimeout(performSave, SAVE_DEBOUNCE_MS);
        return;
    }
    _saveInFlight = true;
    try {

    // Only push what THIS client actually changed, three-way merged against the
    // server's current value. A tarefeiro tapping one shift can no longer overwrite
    // the admin's schedule, and two people editing different things both survive.
    let dirtyKeys = Object.keys(DATA_KEYS).filter(localChanged);
    // A tarefeiro may only write their own availability. RLS enforces this too, but
    // the upsert is a single statement: including any other key would make the whole
    // batch fail, silently losing the one change they're allowed to make.
    if (currentRole === 'tarefeiro') dirtyKeys = dirtyKeys.filter(k => k === 'chbv_terceiros');
    if (dirtyKeys.length === 0) {
        writeLocalCache(false);
        setSaveStatus('saved', '✓ Guardado');
        return;
    }

    let lastError = null;
    for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
        // Re-read just before writing so we merge onto the freshest state
        const { data: current, error: readErr } = await db.from('app_data')
            .select('key,value').in('key', dirtyKeys);
        if (readErr) {
            lastError = readErr;
        } else {
            const serverByKey = {};
            (current || []).forEach(r => { serverByKey[r.key] = r.value; });
            const entries = dirtyKeys.map(k => {
                const merged = mergeKey(k, serverByKey[k]);
                DATA_KEYS[k].set(merged);      // keep local state = what we're writing
                return { key: k, value: merged };
            });
            const { error } = await db.from('app_data').upsert(entries);
            if (!error) { lastError = null; snapshotBase(); break; }
            lastError = error;
        }
        console.warn(`Save attempt ${attempt + 1} failed:`, lastError.message || lastError);
        if (attempt < RETRY_BACKOFF_MS.length) {
            await new Promise(r => setTimeout(r, RETRY_BACKOFF_MS[attempt]));
        }
    }
    } finally { _saveInFlight = false; }   // never wedge the session on a throw

    if (lastError) {
        setSaveStatus('failed', '⚠ Falha ao guardar — vou tentar novamente');
        if (_retryTimer) clearTimeout(_retryTimer);
        _retryTimer = setTimeout(performSave, 15000);
        return;
    }

    writeLocalCache(false);            // clean cache, no longer pending
    if (_retryTimer) { clearTimeout(_retryTimer); _retryTimer = null; }
    setSaveStatus('saved', '✓ Guardado');
    setTimeout(() => {
        const el = document.getElementById('save-status');
        if (el && el.classList.contains('saved')) el.textContent = '';
    }, 2500);
    if (typeof renderHoursSummary === 'function' && document.getElementById('hours-table')) {
        try { renderHoursSummary(); } catch(e) {}
    }
    saveHistory();
}

window.addEventListener('online', () => {
    if (_retryTimer) { clearTimeout(_retryTimer); _retryTimer = null; }
    const cache = readLocalCache();
    if (cache && cache.pending) performSave();
});

window.addEventListener('beforeunload', e => {
    const cache = readLocalCache();
    if (cache && cache.pending) {
        e.preventDefault();
        e.returnValue = 'Existem alterações por guardar. Sair mesmo assim?';
        return e.returnValue;
    }
});

// ---- Utility ----
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function getMonday(d) {
    const date = new Date(d);
    const day = date.getDay();
    const diff = date.getDate() - day + (day === 0 ? -6 : 1);
    date.setDate(diff);
    date.setHours(0, 0, 0, 0);
    return date;
}

function formatDate(d) {
    return d.toLocaleDateString('pt-PT', { day: '2-digit', month: '2-digit' });
}

function dateKey(d) {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function weekKey(date) {
    return date.toISOString().slice(0, 10);
}

function getWeekDates() {
    const dates = [];
    for (let i = 0; i < 7; i++) {
        const d = new Date(currentWeekStart);
        d.setDate(d.getDate() + i);
        dates.push(d);
    }
    return dates;
}

function getMonthDates() {
    const daysInMonth = new Date(currentSchedYear, currentSchedMonth + 1, 0).getDate();
    const dates = [];
    for (let d = 1; d <= daysInMonth; d++) {
        dates.push(new Date(currentSchedYear, currentSchedMonth, d));
    }
    return dates;
}

function shiftKey(date, shift) {
    return `${dateKey(date)}_${shift}`;
}

function getScheduleForWeek() {
    const wk = weekKey(currentWeekStart);
    if (!schedules[wk]) schedules[wk] = {};
    return schedules[wk];
}

// Get schedule for a specific date (finds the correct week)
// Read-only: must NOT create the week object. It used to, which meant merely
// rendering a view (the tarefeiro panel walks 6 months) invented dozens of empty
// weeks, marked chbv_schedules dirty, and made every tarefeiro save fail — RLS
// only lets them write chbv_terceiros, so the whole upsert was rejected.
function getScheduleForDate(date) {
    return schedules[weekKey(getMonday(date))] || EMPTY_WEEK;
}
const EMPTY_WEEK = Object.freeze({});

// Writable variant: use this only when actually assigning someone.
function getOrCreateScheduleForDate(date) {
    const wk = weekKey(getMonday(date));
    if (!schedules[wk]) schedules[wk] = {};
    return schedules[wk];
}

// Get assigned doctors for a specific date+shift
function getAssignedForShift(date, shift) {
    const sched = getScheduleForDate(date);
    const sk = shiftKey(date, shift);
    return sched[sk] || [];
}

// A shift is a "furo" (gap) when it has fewer than DOCTORS_PER_SHIFT people
// assigned (doctors + tarefeiros count together).
function isFuro(date, shift) {
    return getAssignedForShift(date, shift).length < DOCTORS_PER_SHIFT;
}

// Set assigned doctors for a specific date+shift
function setAssignedForShift(date, shift, docIds) {
    const sched = getOrCreateScheduleForDate(date);
    const sk = shiftKey(date, shift);
    sched[sk] = docIds;
}

function monthKey(year, month) {
    return `${year}-${String(month + 1).padStart(2, '0')}`;
}

// Calculate hours assigned to a doctor in a given month (only non-fixed shifts count toward limit)
function getMonthlyFlexHours(docId, year, month) {
    const doc = doctors.find(d => d.id === docId);
    let hours = 0;
    Object.keys(schedules).forEach(wk => {
        const weekSched = schedules[wk];
        Object.keys(weekSched).forEach(sk => {
            const parts = sk.split('_');
            const shiftType = parts.pop();
            const dateStr = parts.join('_');
            const d = new Date(dateStr + 'T00:00:00');
            if (d.getFullYear() === year && d.getMonth() === month) {
                if (weekSched[sk].includes(docId)) {
                    // Only count if this is NOT a fixed-schedule shift for this doctor
                    const isFixed = doc && isFixedForShiftOnDate(doc, d, shiftType);
                    if (!isFixed) {
                        hours += HOURS_PER_SHIFT;
                    }
                }
            }
        });
    });
    return hours;
}

// Total hours (fixed + flex) in a month
function getMonthlyTotalHours(docId, year, month) {
    let hours = 0;
    Object.keys(schedules).forEach(wk => {
        const weekSched = schedules[wk];
        Object.keys(weekSched).forEach(sk => {
            const parts = sk.split('_');
            const shiftType = parts.pop();
            const dateStr = parts.join('_');
            const d = new Date(dateStr + 'T00:00:00');
            if (d.getFullYear() === year && d.getMonth() === month) {
                if (weekSched[sk].includes(docId)) {
                    hours += HOURS_PER_SHIFT;
                }
            }
        });
    });
    return hours;
}

// ---- Auto refresh ----
// Clients used to read the server only once, at sign-in, so a phone left open all day
// showed hours-old data. Pull (merged) updates periodically and when the tab regains focus.
const AUTO_REFRESH_MS = 60 * 1000;
let _refreshTimer = null;

function startAutoRefresh() {
    stopAutoRefresh();
    _refreshTimer = setInterval(() => {
        if (document.visibilityState === 'visible') refreshFromServer();
    }, AUTO_REFRESH_MS);
}

function stopAutoRefresh() {
    if (_refreshTimer) { clearInterval(_refreshTimer); _refreshTimer = null; }
}

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && currentUser) refreshFromServer();
});

// ---- Auth ----

async function initAuth() {
    const { data: { session } } = await db.auth.getSession();
    if (session) {
        await onSignIn(session.user);
    } else {
        showLoginScreen();
    }

    db.auth.onAuthStateChange(async (event, session) => {
        if (suppressAuthChange) return;
        if (event === 'SIGNED_IN' && session) {
            await onSignIn(session.user);
        } else if (event === 'SIGNED_OUT') {
            currentUser = null;
            currentRole = null;
            // Don't leave one user's state (or an undo banner) behind for the next
            currentTerceiroId = null;
            stopAutoRefresh();
            document.querySelectorAll('.undo-host').forEach(h => h.remove());
            if (_undoTimer) { clearInterval(_undoTimer); _undoTimer = null; }
            clearLocalCache();
            showLoginScreen();
        }
    });
}

async function onSignIn(user) {
    currentUser = user;
    const { data: profile } = await db.from('profiles').select('role, name').eq('id', user.id).single();
    if (!profile) {
        await db.auth.signOut();
        showLoginScreen();
        document.getElementById('login-error').textContent = 'Conta removida ou sem acesso. Contacte o administrador.';
        document.getElementById('login-error').style.display = 'block';
        const sb = document.getElementById('login-submit');
        if (sb) { sb.disabled = false; sb.textContent = 'Entrar'; }
        return;
    }
    currentRole = profile.role || 'read';
    const displayName = profile.name || user.email;

    document.getElementById('user-name-display').textContent = displayName;
    const roleBadge = document.getElementById('user-role-badge');
    roleBadge.textContent = currentRole === 'admin' ? 'Admin'
        : currentRole === 'tarefeiro' ? 'Tarefeiro' : 'Leitura';
    roleBadge.className = `role-badge role-badge-${currentRole}`;
    document.getElementById('user-info').style.display = 'flex';

    applyRoleUI(currentRole);
    hideLoginScreen();

    await loadData();

    if (currentRole === 'tarefeiro') {
        // Link this user to their terceiro card by email
        const mine = terceiros.find(t => normEmail(t.email) === normEmail(user.email));
        currentTerceiroId = mine ? mine.id : null;
        enterTarefeiroMode();
        startAutoRefresh();
        return;
    }

    try {
        renderSchedule();
        renderDoctors();
        renderTerceiros();
        renderRotations();
        renderHoursSummary();
    } catch (e) {
        console.error('Erro ao desenhar a aplicação:', e);
    }
    startAutoRefresh();   // must start even if a render threw
}

// Lock the UI down to just the Tarefeiros tab for a 'tarefeiro' user.
function enterTarefeiroMode() {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    const tercNav = document.querySelector('.nav-btn[data-view="terceiros"]');
    if (tercNav) tercNav.classList.add('active');
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('terceiros-view').classList.add('active');
    document.getElementById('pdf-btn').style.display = 'none';
    document.getElementById('img-btn').style.display = 'none';
    renderTerceiros();
}

function applyRoleUI(role) {
    document.body.classList.remove('role-read', 'role-write', 'role-admin', 'role-tarefeiro');
    document.body.classList.add(`role-${role}`);
}

function showLoginScreen() {
    document.getElementById('login-screen').classList.add('visible');
    document.getElementById('login-email').value = '';
    document.getElementById('login-password').value = '';
    document.getElementById('login-error').style.display = 'none';
    document.getElementById('user-info').style.display = 'none';
}

function hideLoginScreen() {
    document.getElementById('login-screen').classList.remove('visible');
}

document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('login-submit');
    const errEl = document.getElementById('login-error');
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;

    btn.disabled = true;
    btn.textContent = 'A entrar…';
    errEl.style.display = 'none';

    const { error } = await db.auth.signInWithPassword({ email, password });
    if (error) {
        errEl.textContent = error.message === 'Invalid login credentials'
            ? 'Email ou palavra-passe incorretos.'
            : error.message;
        errEl.style.display = 'block';
        btn.disabled = false;
        btn.textContent = 'Entrar';
    }
});

document.getElementById('logout-btn').addEventListener('click', async () => {
    await db.auth.signOut();
});

// ---- Users Admin ----

// Emails are matched case- and whitespace-insensitively: a stray space typed into
// a card would otherwise silently leave a tarefeiro with "conta não associada".
function normEmail(e) {
    return (e || '').trim().toLowerCase();
}

// Escape text going into HTML/attributes. Names are admin-entered, but a stray quote
// used to silently swallow the following attributes (including data-terc on the ✓ button).
function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function renderUsersAdmin() {
    const list = document.getElementById('users-list');
    list.innerHTML = '<div class="empty-state"><p>A carregar…</p></div>';

    const { data: profiles, error } = await db.from('profiles').select('*').order('created_at');
    if (error) {
        list.innerHTML = `<div class="empty-state"><p>Erro ao carregar utilizadores: ${error.message}</p></div>`;
        return;
    }

    // Which tarefeiro cards have no account yet? (matched by email, like the login does)
    // Blank emails must never match each other, or a card with no email would look linked.
    const accountEmails = new Set(profiles.map(p => normEmail(p.email)).filter(Boolean));
    const cardsWithoutAccount = (terceiros || []).filter(t => {
        const e = normEmail(t.email);
        return !e || !accountEmails.has(e);
    });

    let html = '';
    if (cardsWithoutAccount.length) {
        const missing = cardsWithoutAccount
            .map(t => t.name + ' <em>(' + (t.email || 'cartão sem email') + ')</em>')
            .join(' · ');
        const label = cardsWithoutAccount.length === 1 ? 'tarefeiro sem conta' : 'tarefeiros sem conta';
        html += `<div class="link-warn">
            <strong>⚠ ${cardsWithoutAccount.length} ${label}:</strong> ${missing}
        </div>`;
    }

    html += `<table class="users-table">
        <thead><tr>
            <th>Nome</th><th>Email</th><th>Papel</th><th>Cartão ligado</th><th>Desde</th><th>Ações</th>
        </tr></thead><tbody>`;

    profiles.forEach(p => {
        const isSelf = p.id === currentUser.id;
        const since = new Date(p.created_at).toLocaleDateString('pt-PT');

        // For tarefeiro accounts, show whether the email finds a card — the exact
        // check the app does at login, so what you see here is what they'll get.
        let linkCell = '<span class="link-na">—</span>';
        if (p.role === 'tarefeiro') {
            const pe = normEmail(p.email);
            const card = pe ? terceiros.find(t => normEmail(t.email) === pe) : null;
            linkCell = card
                ? `<span class="link-ok">✓ ${esc(card.name)}</span>`
                : `<span class="link-bad">✗ sem cartão</span>`;
        }

        html += `<tr class="${isSelf ? 'row-self' : ''}">
            <td><strong>${p.name || '—'}</strong></td>
            <td>${esc(p.email || "—")}</td>
            <td>
                <select class="role-select" data-uid="${p.id}" ${isSelf ? 'disabled' : ''}>
                    <option value="read" ${(p.role !== 'admin' && p.role !== 'tarefeiro') ? 'selected' : ''}>Leitura</option>
                    <option value="tarefeiro" ${p.role === 'tarefeiro' ? 'selected' : ''}>Tarefeiro</option>
                    <option value="admin" ${p.role === 'admin' ? 'selected' : ''}>Admin</option>
                </select>
            </td>
            <td>${linkCell}</td>
            <td>${since}</td>
            <td>${isSelf ? '<span class="badge badge-self">Você</span>' : `<button class="btn btn-sm btn-danger" onclick="deleteUser('${p.id}')">Remover</button>`}</td>
        </tr>`;
    });

    html += '</tbody></table>';
    list.innerHTML = html;

    list.querySelectorAll('.role-select').forEach(sel => {
        sel.addEventListener('change', async () => {
            const uid = sel.dataset.uid;
            const newRole = sel.value;
            sel.disabled = true;
            const { error } = await db.from('profiles').update({ role: newRole }).eq('id', uid);
            if (error) {
                alert('Erro ao atualizar papel: ' + error.message);
                sel.value = sel.querySelector('option[selected]')?.value || 'read';
            } else {
                showSaveStatus('Papel atualizado');
            }
            sel.disabled = false;
        });
    });
}

window.deleteUser = async function(uid) {
    if (!confirm('Eliminar este utilizador permanentemente?')) return;
    const { error } = await db.rpc('delete_user_completely', { user_id: uid });
    if (error) {
        alert('Erro ao eliminar: ' + error.message);
        return;
    }
    renderUsersAdmin();
    showSaveStatus('Utilizador eliminado');
};


document.getElementById('invite-user-btn').addEventListener('click', () => {
    document.getElementById('invite-modal').classList.add('open');
    document.getElementById('invite-error').style.display = 'none';
    document.getElementById('invite-success').style.display = 'none';
    document.getElementById('invite-form').reset();
});

document.getElementById('invite-modal-close').addEventListener('click', () => {
    document.getElementById('invite-modal').classList.remove('open');
});

document.getElementById('invite-cancel').addEventListener('click', () => {
    document.getElementById('invite-modal').classList.remove('open');
});

document.getElementById('invite-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('invite-submit');
    const errEl = document.getElementById('invite-error');
    const successEl = document.getElementById('invite-success');
    const name = document.getElementById('invite-name').value.trim();
    const email = document.getElementById('invite-email').value.trim();
    const password = document.getElementById('invite-password').value;
    const role = document.getElementById('invite-role').value;

    btn.disabled = true;
    btn.textContent = 'A criar…';
    errEl.style.display = 'none';
    successEl.style.display = 'none';

    const { data: { session: adminSession } } = await db.auth.getSession();

    suppressAuthChange = true;
    try {
        const { error } = await db.auth.signUp({
            email,
            password,
            options: { data: { name, role } }
        });

        if (adminSession) {
            await db.auth.setSession({
                access_token: adminSession.access_token,
                refresh_token: adminSession.refresh_token
            });
        }

        btn.disabled = false;
        btn.textContent = 'Criar conta';

        if (error) {
            const msg = error.message.toLowerCase().includes('already registered')
                ? `O email ${email} já tem conta no sistema. Se foi removido recentemente, apaga-o em Supabase → Authentication → Users e tenta novamente.`
                : error.message;
            errEl.textContent = msg;
            errEl.style.display = 'block';
        } else {
            successEl.textContent = `Conta criada para ${email}. Pode entrar de imediato.`;
            successEl.style.display = 'block';
            document.getElementById('invite-form').reset();
            setTimeout(() => renderUsersAdmin(), 800);
        }
    } finally {
        suppressAuthChange = false;
    }
});

// ---- Navigation ----
document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        document.getElementById(`${btn.dataset.view}-view`).classList.add('active');
        if (btn.dataset.view === 'users') renderUsersAdmin();
        const isSchedule = btn.dataset.view === 'schedule';
        document.getElementById('pdf-btn').style.display = isSchedule ? '' : 'none';
        document.getElementById('img-btn').style.display = isSchedule ? '' : 'none';
    });
});

// ---- Schedule Rendering ----
// Doctor ids sitting in the rotation grid that no longer match any doctor record.
// These are invisible in the Rotações editor (it renders names by lookup) but they
// silently cost the rotation its slots: PASS 1 iterates real doctors, so an orphan
// id is simply never placed and the shift gets backfilled by whoever is free.
function getRotationOrphanIds() {
    const known = new Set(doctors.map(d => d.id));
    const orfaos = new Set();
    Object.values(rotationGrid.cells || {}).forEach(weeks => {
        (weeks || []).forEach(sem => (sem || []).forEach(id => {
            if (id && !known.has(id)) orfaos.add(id);
        }));
    });
    return [...orfaos];
}

function renderSchedule() {
    if (scheduleViewMode === 'list') { renderScheduleList(); return; }
    renderScheduleCalendar();
}

function renderScheduleCalendar() {
    const grid = document.getElementById('schedule-grid');
    const dates = getMonthDates();

    document.getElementById('week-label').textContent =
        `${MONTH_NAMES[currentSchedMonth]} ${currentSchedYear}`;

    grid.style.gridTemplateColumns = 'repeat(7, 1fr)';
    grid.classList.add('sched-calendar');
    grid.classList.remove('sched-list');

    const todayStr = new Date().toDateString();

    // Day-of-week headers
    let html = DAYS.map((d, i) =>
        `<div class="grid-header cal-dow-header${i >= 5 ? ' weekend' : ''}">${d}</div>`
    ).join('');

    // Padding before first day
    const firstDow = (dates[0].getDay() + 6) % 7;
    for (let i = 0; i < firstDow; i++) {
        html += '<div class="cal-empty"></div>';
    }

    dates.forEach(d => {
        const dk = dateKey(d);
        const dow = (d.getDay() + 6) % 7;
        const isToday = d.toDateString() === todayStr;
        const isWeekend = dow >= 5;
        const monday = getMonday(d);

        // Determine overall day status for cell border
        const dayCounts = SHIFTS.map(s => getAssignedForShift(d, s).length);
        const dayStatus = dayCounts.some(c => c === 0) ? 'has-empty'
            : dayCounts.some(c => c < DOCTORS_PER_SHIFT) ? 'has-partial' : 'all-complete';

        html += `<div class="cal-day ${isWeekend ? 'cal-weekend' : ''} ${isToday ? 'cal-today' : ''} ${dayStatus}">
            <div class="cal-day-num">${d.getDate()}</div>`;

        SHIFTS.forEach(shift => {
            const assigned = getAssignedForShift(d, shift);
            const count = assigned.length;
            const statusClass = count >= DOCTORS_PER_SHIFT ? 'complete' : count > 0 ? 'partial' : 'empty';
            const rotationDocIds = getRotationDoctorsForShift(dow, shift, monday);

            html += `<div class="cal-shift-row ${statusClass}" data-date="${dk}" data-shift="${shift}">
                <span class="cal-shift-label ${shift}">${shift === 'day' ? 'D' : 'N'}</span>`;

            assigned.forEach(docId => {
                const doc = doctors.find(x => x.id === docId) || terceiros.find(x => x.id === docId);
                const isTerceiro = !doctors.find(x => x.id === docId) && !!terceiros.find(x => x.id === docId);
                const isRotation = rotationDocIds.includes(docId);
                const isFixed = doc && isFixedForShiftOnDate(doc, d, shift);
                // Someone can be assigned and THEN marked férias/indisponível: the shift
                // stays, so flag it or the schedule quietly has them working on holiday.
                const emConflito = doc && !isTerceiro && isMonthlyUnavailable(doc, d, shift);
                const conflitoFerias = emConflito && isOnVacation(doc, d, shift);
                const tagClass = (isRotation ? 'rotation-tag' : isFixed ? 'fixed-tag' : isTerceiro ? 'terceiro-tag' : '')
                    + (emConflito ? ' tag-conflito' : '');
                const conflitoTitulo = emConflito
                    ? (conflitoFerias ? 'Está de FÉRIAS neste turno' : 'Está marcado como INDISPONÍVEL neste turno')
                    : '';
                const firstName = doc ? doc.name.split(' ')[0] : '?';
                const hoursUsed = isTerceiro ? null : getMonthlyExtraHours(docId, d.getFullYear(), d.getMonth());
                const hoursLimit = doc ? (doc.monthlyHoursLimit || 0) : 0;
                const shiftType = isTerceiro ? 'Tarefeiro' : isFixed ? 'Fixo' : 'Extra';
                html += `<div class="doctor-tag ${tagClass}"
                    ${emConflito ? `title="${esc(conflitoTitulo)}"` : ''}
                    data-fullname="${esc(doc ? doc.name : '?')}"
                    data-hours-used="${hoursUsed ?? ''}"
                    data-hours-limit="${hoursLimit}"
                    data-shift-type="${shiftType}"
                    data-doc-id="${docId}">
                    <span>${emConflito ? '⚠ ' : ''}${esc(firstName)}</span>
                    <button class="remove-doc" data-date="${dk}" data-shift="${shift}" data-doc="${docId}" aria-label="Remover">&times;</button>
                </div>`;
            });

            // Pending tarefeiro requests: shown dashed; the ✓ accepts them onto the shift.
            if (currentRole === 'admin') {
                pendingRequestsForShift(d, shift).forEach(t => {
                    html += `<div class="doctor-tag pending-tag"
                        data-fullname="${esc(t.name)}" data-shift-type="Pedido de tarefeiro">
                        <span>${esc(t.name.split(' ')[0])}</span>
                        <button class="accept-req" data-terc="${t.id}" data-date="${dk}" data-shift="${shift}" title="ACEITAR: escalar ${esc(t.name)} neste turno">✓</button>
                        <button class="decline-req" data-terc="${t.id}" data-date="${dk}" data-shift="${shift}" title="RECUSAR o pedido de ${esc(t.name)}">✕</button>
                    </div>`;
                });
            }

            if (count < DOCTORS_PER_SHIFT) {
                html += `<div class="add-slot" data-date="${dk}" data-shift="${shift}">+</div>`;
            }

            html += '</div>';
        });

        html += '</div>';
    });

    grid.innerHTML = html;

    // Event: accept a pending tarefeiro request straight from the schedule
    grid.querySelectorAll('.accept-req').forEach(el => {
        el.addEventListener('click', e => {
            e.stopPropagation();
            if (currentRole !== 'admin') return;
            acceptTerceiroRequest(el.dataset.terc, el.dataset.date, el.dataset.shift);
        });
    });

    // Event: decline a pending tarefeiro request from the schedule
    grid.querySelectorAll('.decline-req').forEach(el => {
        el.addEventListener('click', e => {
            e.stopPropagation();
            if (currentRole !== 'admin') return;
            declineTerceiroRequest(el.dataset.terc, el.dataset.date, el.dataset.shift);
        });
    });

    // Event: add doctor
    grid.querySelectorAll('.add-slot').forEach(el => {
        el.addEventListener('click', e => {
            e.stopPropagation();
            if (currentRole !== 'admin') return;
            openAssignModal(el.dataset.date, el.dataset.shift);
        });
    });

    // Event: click shift row
    grid.querySelectorAll('.cal-shift-row').forEach(el => {
        el.addEventListener('click', () => {
            if (currentRole !== 'admin') return;
            const dk = el.dataset.date;
            const shift = el.dataset.shift;
            const assigned = getAssignedForShift(parseDateKey(dk), shift);
            if (assigned.length < DOCTORS_PER_SHIFT) {
                openAssignModal(dk, shift);
            }
        });
    });

    // Event: remove doctor
    grid.querySelectorAll('.remove-doc').forEach(btn => {
        btn.addEventListener('click', e => {
            e.stopPropagation();
            if (currentRole !== 'admin') return;
            const dk = btn.dataset.date;
            const shift = btn.dataset.shift;
            const docId = btn.dataset.doc;
            const date = parseDateKey(dk);
            const sched = getOrCreateScheduleForDate(date);
            const sk = shiftKey(date, shift);
            sched[sk] = (sched[sk] || []).filter(id => id !== docId);
            save();
            renderSchedule();
        });
    });

    // Hover card
    const hoverCard = document.getElementById('doc-hover-card');
    grid.querySelectorAll('.doctor-tag').forEach(tag => {
        tag.addEventListener('mouseenter', e => {
            const name = tag.dataset.fullname;
            const used = tag.dataset.hoursUsed;
            const limit = tag.dataset.hoursLimit;
            const type = tag.dataset.shiftType;
            const hoursHtml = used !== '' && limit > 0
                ? `<div class="hc-hours"><span>${used}h extra usadas</span><span class="hc-limit">/ ${limit}h</span></div>
                   <div class="hc-bar"><div class="hc-bar-fill" style="width:${Math.min(100, Math.round(used/limit*100))}%;background:${used>limit?'#e74c3c':used/limit>0.8?'#f39c12':'#27ae60'}"></div></div>`
                : '';
            hoverCard.innerHTML = `<div class="hc-name">${name}</div><div class="hc-type">${type}</div>${hoursHtml}`;
            const rect = tag.getBoundingClientRect();
            hoverCard.style.display = 'block';
            hoverCard.style.left = `${rect.left + window.scrollX}px`;
            hoverCard.style.top = `${rect.top + window.scrollY - hoverCard.offsetHeight - 8}px`;
            scheduleDoctorHighlight(tag.dataset.docId);
        });
        tag.addEventListener('mouseleave', () => {
            hoverCard.style.display = 'none';
            cancelDoctorHighlight();
        });
        attachDoctorTouchHighlight(tag);
    });
}

function renderScheduleList() {
    const grid = document.getElementById('schedule-grid');
    const dates = getMonthDates();

    document.getElementById('week-label').textContent =
        `${MONTH_NAMES[currentSchedMonth]} ${currentSchedYear}`;

    grid.style.gridTemplateColumns = 'auto 1fr 1fr';
    grid.classList.add('sched-list');
    grid.classList.remove('sched-calendar');

    let html = '';
    const todayStr = new Date().toDateString();

    // Header row
    html += '<div class="grid-header grid-corner"></div>';
    SHIFTS.forEach(shift => {
        html += `<div class="grid-header shift-col-header ${shift}">
            ${SHIFT_LABELS[shift]}<small>${SHIFT_TIMES[shift]}</small>
        </div>`;
    });

    // One row per day
    dates.forEach(d => {
        const dk = dateKey(d);
        const dow = (d.getDay() + 6) % 7;
        const isToday = d.toDateString() === todayStr;
        const isWeekend = dow >= 5;
        const monday = getMonday(d);

        html += `<div class="day-row-label ${isWeekend ? 'weekend-header' : ''} ${isToday ? 'today-label' : ''}">
            <span class="day-num">${d.getDate()}</span>
            <span class="day-name">${DAYS[dow]}</span>
        </div>`;

        SHIFTS.forEach(shift => {
            const assigned = getAssignedForShift(d, shift);
            const count = assigned.length;
            const statusClass = count >= DOCTORS_PER_SHIFT ? 'complete' : count > 0 ? 'partial' : 'empty';
            const cellClass = shift === 'day' ? 'day-shift' : 'night-shift';
            const rotationDocIds = getRotationDoctorsForShift(dow, shift, monday);

            html += `<div class="shift-cell ${cellClass} ${statusClass} ${isWeekend ? 'weekend-cell' : ''} ${isToday ? 'today-cell' : ''}" data-date="${dk}" data-shift="${shift}">
                <div class="status-dot"></div>`;

            assigned.forEach(docId => {
                const doc = doctors.find(x => x.id === docId) || terceiros.find(x => x.id === docId);
                const isTerceiro = !doctors.find(x => x.id === docId) && !!terceiros.find(x => x.id === docId);
                const isRotation = rotationDocIds.includes(docId);
                const isFixed = doc && isFixedForShiftOnDate(doc, d, shift);
                // Someone can be assigned and THEN marked férias/indisponível: the shift
                // stays, so flag it or the schedule quietly has them working on holiday.
                const emConflito = doc && !isTerceiro && isMonthlyUnavailable(doc, d, shift);
                const conflitoFerias = emConflito && isOnVacation(doc, d, shift);
                const tagClass = (isRotation ? 'rotation-tag' : isFixed ? 'fixed-tag' : isTerceiro ? 'terceiro-tag' : '')
                    + (emConflito ? ' tag-conflito' : '');
                const conflitoTitulo = emConflito
                    ? (conflitoFerias ? 'Está de FÉRIAS neste turno' : 'Está marcado como INDISPONÍVEL neste turno')
                    : '';
                const hoursUsed = isTerceiro ? null : getMonthlyExtraHours(docId, d.getFullYear(), d.getMonth());
                const hoursLimit = doc ? (doc.monthlyHoursLimit || 0) : 0;
                const shiftType = isTerceiro ? 'Tarefeiro' : isFixed ? 'Fixo' : 'Extra';
                html += `<div class="doctor-tag ${tagClass}"
                    ${emConflito ? `title="${esc(conflitoTitulo)}"` : ''}
                    data-fullname="${esc(doc ? doc.name : '?')}"
                    data-hours-used="${hoursUsed ?? ''}"
                    data-hours-limit="${hoursLimit}"
                    data-shift-type="${shiftType}"
                    data-doc-id="${docId}">
                    <span>${emConflito ? '⚠ ' : ''}${esc(doc ? doc.name : '?')}</span>
                    <button class="remove-doc" data-date="${dk}" data-shift="${shift}" data-doc="${docId}" aria-label="Remover">&times;</button>
                </div>`;
            });

            // Pending tarefeiro requests: shown dashed; the ✓ accepts them onto the shift.
            if (currentRole === 'admin') {
                pendingRequestsForShift(d, shift).forEach(t => {
                    html += `<div class="doctor-tag pending-tag"
                        data-fullname="${esc(t.name)}" data-shift-type="Pedido de tarefeiro">
                        <span>${esc(t.name)}</span>
                        <button class="accept-req" data-terc="${t.id}" data-date="${dk}" data-shift="${shift}" title="ACEITAR: escalar ${esc(t.name)} neste turno">✓</button>
                        <button class="decline-req" data-terc="${t.id}" data-date="${dk}" data-shift="${shift}" title="RECUSAR o pedido de ${esc(t.name)}">✕</button>
                    </div>`;
                });
            }

            if (count < DOCTORS_PER_SHIFT) {
                html += `<div class="add-slot" data-date="${dk}" data-shift="${shift}">+ Médico</div>`;
            }

            html += '</div>';
        });
    });

    grid.innerHTML = html;

    // Event: accept a pending tarefeiro request straight from the list view
    grid.querySelectorAll('.accept-req').forEach(el => {
        el.addEventListener('click', e => {
            e.stopPropagation();
            if (currentRole !== 'admin') return;
            acceptTerceiroRequest(el.dataset.terc, el.dataset.date, el.dataset.shift);
        });
    });

    // Event: decline a pending tarefeiro request from the schedule
    grid.querySelectorAll('.decline-req').forEach(el => {
        el.addEventListener('click', e => {
            e.stopPropagation();
            if (currentRole !== 'admin') return;
            declineTerceiroRequest(el.dataset.terc, el.dataset.date, el.dataset.shift);
        });
    });

    grid.querySelectorAll('.add-slot').forEach(el => {
        el.addEventListener('click', e => {
            e.stopPropagation();
            if (currentRole !== 'admin') return;
            openAssignModal(el.dataset.date, el.dataset.shift);
        });
    });

    grid.querySelectorAll('.shift-cell').forEach(el => {
        el.addEventListener('click', () => {
            if (currentRole !== 'admin') return;
            const dk = el.dataset.date;
            const shift = el.dataset.shift;
            const assigned = getAssignedForShift(parseDateKey(dk), shift);
            if (assigned.length < DOCTORS_PER_SHIFT) {
                openAssignModal(dk, shift);
            }
        });
    });

    grid.querySelectorAll('.remove-doc').forEach(btn => {
        btn.addEventListener('click', e => {
            e.stopPropagation();
            if (currentRole !== 'admin') return;
            const dk = btn.dataset.date;
            const shift = btn.dataset.shift;
            const docId = btn.dataset.doc;
            const date = parseDateKey(dk);
            const sched = getOrCreateScheduleForDate(date);
            const sk = shiftKey(date, shift);
            sched[sk] = (sched[sk] || []).filter(id => id !== docId);
            save();
            renderSchedule();
        });
    });

    // Hover card
    const hoverCard = document.getElementById('doc-hover-card');
    grid.querySelectorAll('.doctor-tag').forEach(tag => {
        tag.addEventListener('mouseenter', e => {
            const name = tag.dataset.fullname;
            const used = tag.dataset.hoursUsed;
            const limit = tag.dataset.hoursLimit;
            const type = tag.dataset.shiftType;
            const hoursHtml = used !== '' && limit > 0
                ? `<div class="hc-hours"><span>${used}h extra usadas</span><span class="hc-limit">/ ${limit}h</span></div>
                   <div class="hc-bar"><div class="hc-bar-fill" style="width:${Math.min(100, Math.round(used/limit*100))}%;background:${used>limit?'#e74c3c':used/limit>0.8?'#f39c12':'#27ae60'}"></div></div>`
                : '';
            hoverCard.innerHTML = `<div class="hc-name">${name}</div><div class="hc-type">${type}</div>${hoursHtml}`;
            const rect = tag.getBoundingClientRect();
            hoverCard.style.display = 'block';
            hoverCard.style.left = `${rect.left + window.scrollX}px`;
            hoverCard.style.top = `${rect.top + window.scrollY - hoverCard.offsetHeight - 8}px`;
            scheduleDoctorHighlight(tag.dataset.docId);
        });
        tag.addEventListener('mouseleave', () => {
            hoverCard.style.display = 'none';
            cancelDoctorHighlight();
        });
        attachDoctorTouchHighlight(tag);
    });
}

let _docHighlightTimer = null;
let _docHighlightId = null;
const DOC_HIGHLIGHT_DELAY = 2000;

function scheduleDoctorHighlight(docId) {
    if (!docId || docId === 'undefined') return;
    if (_docHighlightId === docId) return;
    cancelDoctorHighlight();
    _docHighlightTimer = setTimeout(() => {
        applyDoctorHighlight(docId);
    }, DOC_HIGHLIGHT_DELAY);
}

function cancelDoctorHighlight() {
    if (_docHighlightTimer) { clearTimeout(_docHighlightTimer); _docHighlightTimer = null; }
    if (_docHighlightId) {
        document.body.classList.remove('doc-highlight-active');
        document.querySelectorAll('.doctor-tag.doc-highlight').forEach(el => el.classList.remove('doc-highlight'));
        _docHighlightId = null;
    }
}

function applyDoctorHighlight(docId) {
    _docHighlightId = docId;
    document.body.classList.add('doc-highlight-active');
    document.querySelectorAll(`.doctor-tag[data-doc-id="${docId}"]`).forEach(el => el.classList.add('doc-highlight'));
}

function attachDoctorTouchHighlight(tag) {
    let touchTimer = null;
    let startXY = null;
    let highlightTriggered = false;

    // Prevent the OS long-press context menu (text selection, copy, share)
    tag.addEventListener('contextmenu', e => e.preventDefault());

    tag.addEventListener('touchstart', e => {
        if (e.touches.length !== 1) return;
        startXY = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        highlightTriggered = false;
        touchTimer = setTimeout(() => {
            applyDoctorHighlight(tag.dataset.docId);
            highlightTriggered = true;
            touchTimer = null;
            if (navigator.vibrate) navigator.vibrate(20);
        }, DOC_HIGHLIGHT_DELAY);
    }, { passive: true });

    tag.addEventListener('touchmove', e => {
        if (!touchTimer || !startXY) return;
        const dx = e.touches[0].clientX - startXY.x;
        const dy = e.touches[0].clientY - startXY.y;
        if ((dx * dx + dy * dy) > 100) { // > 10px movement → cancel
            clearTimeout(touchTimer);
            touchTimer = null;
        }
    }, { passive: true });

    const cleanup = e => {
        if (touchTimer) { clearTimeout(touchTimer); touchTimer = null; }
        if (highlightTriggered) {
            // suppress the synthesised click so we don't open the assign modal / remove
            e.preventDefault();
            e.stopPropagation();
        }
        startXY = null;
    };
    tag.addEventListener('touchend', cleanup);
    tag.addEventListener('touchcancel', cleanup);
}

// Dismiss highlight when tapping/clicking anywhere outside a highlighted tag
document.addEventListener('click', e => {
    if (!_docHighlightId) return;
    if (e.target.closest('.doctor-tag.doc-highlight')) return;
    cancelDoctorHighlight();
});

function parseDateKey(dk) {
    const [y, m, d] = dk.split('-').map(Number);
    return new Date(y, m - 1, d);
}

// ---- Availability ----
// A doctor is available on a date+shift if:
//   1) They have a FIXED shift for that day-of-week + shift, OR
//   2) Their flexible monthly availability says they can work that date+shift
function isRuleBasedShift(doc, date, shift) {
    const year = date.getFullYear();
    const month = date.getMonth();
    const rules = getDoctorRules(doc);
    const dow = (date.getDay() + 6) % 7;

    for (const rule of rules) {
        if (rule.dayOfWeek !== dow) continue;
        const shiftMatch = rule.shiftType === '24h' || rule.shiftType === shift;
        if (!shiftMatch) continue;

        // Count fully-assigned occurrences STRICTLY BEFORE this date
        let countBefore = 0;
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        for (let d = 1; d <= daysInMonth; d++) {
            const dt = new Date(year, month, d);
            if ((dt.getDay() + 6) % 7 !== dow) continue;
            if (dt >= date) break;
            if (rule.shiftType === '24h') {
                const dayAssigned = getAssignedForShift(dt, 'day').includes(doc.id);
                const nightAssigned = getAssignedForShift(dt, 'night').includes(doc.id);
                if (dayAssigned && nightAssigned) countBefore++;
            } else {
                if (getAssignedForShift(dt, shift).includes(doc.id)) countBefore++;
            }
        }
        // If we haven't yet exhausted the rule count, this shift is rule-based
        if (countBefore < rule.count) return true;
    }
    return false;
}

function isRuleBasedForShiftOnDate(doc, date, shift) {
    const rules = getDoctorRules(doc);
    const dow = (date.getDay() + 6) % 7;
    return rules.some(r => r.dayOfWeek === dow && (r.shiftType === shift || r.shiftType === '24h'));
}

function isFixedForShiftOnDate(doc, date, shift) {
    // Rotation-grid assignment counts as fixed (single source of truth for rotations)
    const rotDayIdx = (date.getDay() + 6) % 7;
    if (getRotationDoctorsForShift(rotDayIdx, shift, getMonday(date)).includes(doc.id)) return true;
    if (doc.fixedMonthly) {
        // Day-by-day monthly schedule replaces the weekly pattern — but NOT the
        // day-of-week rules. This used to return here, so a doctor with "Fixo Mensal"
        // plus rules had every rule shift booked as EXTRA, inflating their extra
        // hours by 12-24h/month and pushing them over their own limit.
        const fmd = doc.fixedMonthlyData || {};
        const dk = dateKey(date);
        if (fmd[dk] && fmd[dk][shift]) return true;
    } else {
        // Weekly repeating pattern (works data)
        const dayIdx = (date.getDay() + 6) % 7; // Mon=0
        if (doc.fixedSchedule && doc.fixedSchedule[`${dayIdx}_${shift}`]) return true;
    }
    // Monthly day-of-week rules count as fixed (not extra), in both modes
    return isRuleBasedShift(doc, date, shift);
}

function isBlockedOnDate(doc, date, shift) {
    // Blocked days from weekly blocked data
    if (doc.fixedMonthly) return false;
    const dayIdx = (date.getDay() + 6) % 7;
    const key = `${dayIdx}_${shift}`;
    return !!(doc.fixedBlocked && doc.fixedBlocked[key]);
}

function isFlexAvailableOnDate(doc, date, shift) {
    const dk = dateKey(date);
    const avail = doc.monthlyAvailability || {};
    const unavail = doc.monthlyUnavailability || {};
    const vacation = doc.monthlyVacation || {};

    // Vacation or unavailable? No.
    if (vacation[dk] && vacation[dk][shift]) return false;
    if (unavail[dk] && unavail[dk][shift]) return false;
    // Explicitly marked as available? Yes.
    if (avail[dk] && avail[dk][shift]) return true;
    // No data for this day — not available by default
    return false;
}

function isMonthlyUnavailable(doc, date, shift) {
    const dk = dateKey(date);
    const unavail = doc.monthlyUnavailability || {};
    const vacation = doc.monthlyVacation || {};
    return !!(unavail[dk] && unavail[dk][shift]) || !!(vacation[dk] && vacation[dk][shift]);
}

function isOnVacation(doc, date, shift) {
    const dk = dateKey(date);
    const vacation = doc.monthlyVacation || {};
    return !!(vacation[dk] && vacation[dk][shift]);
}

function isDoctorAvailableOnDate(doc, date, shift) {
    // Blocked days (weekly) override everything
    if (isBlockedOnDate(doc, date, shift)) return false;
    // Monthly unavailability overrides fixed schedule (ex: férias)
    if (isMonthlyUnavailable(doc, date, shift)) return false;
    // Available if fixed OR flex-available
    return isFixedForShiftOnDate(doc, date, shift) || isFlexAvailableOnDate(doc, date, shift);
}

// Legacy wrapper for dayIdx
function isDoctorAvailable(doc, dayIdx, shift) {
    const dates = getWeekDates();
    return isDoctorAvailableOnDate(doc, dates[dayIdx], shift);
}

function isFixedForShift(doc, dayIdx, shift) {
    const dates = getWeekDates();
    return isFixedForShiftOnDate(doc, dates[dayIdx], shift);
}

// Would assigning a flex shift exceed the monthly extra hours limit?
// If no limit set, assume 0 extra hours allowed
function wouldExceedFlexLimit(doc, date) {
    const limit = doc.monthlyHoursLimit || 0;
    if (limit <= 0) return true; // No extra hours allowed
    const extraHours = getMonthlyExtraHoursForAutoFill(doc, date);
    return (extraHours + HOURS_PER_SHIFT) > limit;
}

// Reusable: count extra (non-fixed) hours for a doctor in a month
function getMonthlyExtraHoursFromSchedule(doc, date) {
    return getMonthlyExtraHoursForAutoFill(doc, date);
}

// ---- Assign Modal ----
function openAssignModal(dk, shift) {
    const date = typeof dk === 'string' ? parseDateKey(dk) : dk;
    const dayIdx = (date.getDay() + 6) % 7;
    const monday = getMonday(date);
    const sk = shiftKey(date, shift);
    const sched = getScheduleForDate(date);
    const assigned = sched[sk] || [];

    document.getElementById('assign-title').textContent =
        `${DAYS_FULL[dayIdx]} ${formatDate(date)} — ${SHIFT_LABELS[shift]}`;

    const content = document.getElementById('assign-content');

    if (doctors.length === 0) {
        content.innerHTML = '<p class="help-text">Nenhum médico registado. Adicione médicos primeiro.</p>';
        document.getElementById('assign-modal').classList.add('open');
        return;
    }

    const sorted = [...doctors].sort((a, b) => {
        const aAvail = isDoctorAvailableOnDate(a, date, shift);
        const bAvail = isDoctorAvailableOnDate(b, date, shift);
        if (aAvail && !bAvail) return -1;
        if (!aAvail && bAvail) return 1;
        return a.name.localeCompare(b.name);
    });

    let html = '<ul class="assign-list">';
    sorted.forEach(doc => {
        if (assigned.includes(doc.id)) return;

        const isFixed = isFixedForShiftOnDate(doc, date, shift);
        const isFlexAvail = isFlexAvailableOnDate(doc, date, shift);
        const blocked = isBlockedOnDate(doc, date, shift);
        const monthlyUnavail = isMonthlyUnavailable(doc, date, shift);
        const vacation = isOnVacation(doc, date, shift);
        const available = !blocked && !monthlyUnavail && (isFixed || isFlexAvail);
        const isRotationDoc = getRotationDoctorsForShift(dayIdx, shift, monday).includes(doc.id);
        const extraLimit = doc.monthlyHoursLimit || 0;
        const currentExtra = getMonthlyExtraHoursFromSchedule(doc, date);
        const overLimit = !isFixed && (currentExtra + HOURS_PER_SHIFT) > extraLimit;

        let badges = [];

        if (isRotationDoc) {
            badges.push('<span class="avail-badge rotation">Rotação</span>');
        }
        if (isFixed && !monthlyUnavail) {
            badges.push('<span class="avail-badge fixed">Fixo</span>');
        }
        if (isFlexAvail && !isFixed) {
            badges.push('<span class="avail-badge yes">Flex</span>');
        }
        if (vacation) {
            badges.push('<span class="avail-badge vacation">Férias</span>');
        } else if (monthlyUnavail) {
            badges.push('<span class="avail-badge no">Indisponível (mensal)</span>');
        }
        if (blocked) {
            badges.push('<span class="avail-badge no">Bloqueado (semanal)</span>');
        }
        if (needsRestAfterNight(doc.id, date, shift)) {
            badges.push('<span class="avail-badge no">A descansar (noite anterior)</span>');
        } else if (shift === 'night' && hasNextDayConflict(doc.id, date)) {
            badges.push('<span class="avail-badge no">Conflito dia seguinte</span>');
        }
        if (!available && !isRotationDoc && !blocked && !monthlyUnavail
            && !needsRestAfterNight(doc.id, date, shift)
            && !(shift === 'night' && hasNextDayConflict(doc.id, date))) {
            badges.push('<span class="avail-badge no">Sem disponibilidade</span>');
        }
        if (overLimit) {
            badges.push('<span class="avail-badge limit-warn">Excede limite</span>');
        }

        // Rule badges
        const dow = (date.getDay() + 6) % 7;
        const docRules = getDoctorRules(doc);
        const applicableRules = docRules.filter(r => r.dayOfWeek === dow);
        const modalHas24hRule = applicableRules.some(r => r.shiftType === '24h');
        applicableRules.forEach(rule => {
            const exclude24h = rule.shiftType !== '24h' && modalHas24hRule;
            const assigned = countMonthlyDowAssignments(doc.id, date.getFullYear(), date.getMonth(), dow, rule.shiftType, exclude24h);
            const shiftMatch = rule.shiftType === '24h' || rule.shiftType === shift;
            if (shiftMatch) {
                const label = `${DAYS[dow]} ${rule.shiftType === '24h' ? '24h' : (rule.shiftType === 'day' ? 'D' : 'N')}`;
                const cls = assigned >= rule.count ? 'rule-done' : 'rule';
                badges.push(`<span class="avail-badge ${cls}">Regra: ${assigned}/${rule.count} ${label}</span>`);
            }
        });

        let hoursHtml = '';
        hoursHtml = `<span class="hours-remaining">${currentExtra}/${extraLimit}h extra</span>`;

        const canAssign = !blocked && !monthlyUnavail && !overLimit && (available || isRotationDoc);
        html += `<li class="assign-item ${!canAssign ? 'unavailable' : ''}"
                     data-doc-id="${doc.id}" data-available="true">
            <span>${esc(doc.name)}${hoursHtml}</span>
            <span>${badges.join(' ')}</span>
        </li>`;
    });

    // Terceiros section
    const dkTerc = dateKey(date);
    if (terceiros.length > 0) {
        html += '<div class="assign-section-label">Tarefeiros</div><ul class="assign-list">';
        terceiros.sort((a, b) => a.name.localeCompare(b.name)).forEach(t => {
            if (assigned.includes(t.id)) return;
            const avail = t.monthlyAvailability || {};
            const isAvail = avail[dkTerc] && avail[dkTerc][shift];
            const resting = needsRestAfterNight(t.id, date, shift);
            const canAssign = isAvail && !resting;
            const badges = [];
            if (isAvail) badges.push('<span class="avail-badge yes">Propôs-se</span>');
            else badges.push('<span class="avail-badge no">Sem disponibilidade</span>');
            if (resting) badges.push('<span class="avail-badge no">A descansar (noite anterior)</span>');
            html += `<li class="assign-item ${!canAssign ? 'unavailable' : ''}"
                         data-doc-id="${t.id}" data-available="true">
                <span>${esc(t.name)}</span>
                <span>${badges.join(' ')}</span>
            </li>`;
        });
        html += '</ul>';
    }

    html += '';

    content.innerHTML = html;

    content.querySelectorAll('.assign-item').forEach(item => {
        item.addEventListener('click', () => {
            if (item.dataset.available === 'false') return;
            const docId = item.dataset.docId;
            if (!sched[sk]) sched[sk] = [];
            if (sched[sk].length >= DOCTORS_PER_SHIFT) return;
            sched[sk].push(docId);
            save();
            renderSchedule();
            document.getElementById('assign-modal').classList.remove('open');
        });
    });

    document.getElementById('assign-modal').classList.add('open');
}

// ---- Rotations ----
function getWeekNumber(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

// Which position in the rotation cycle a given week falls on (0-based, wraps).
function rotationWeekIndex(weekStartDate) {
    const refDate = isoWeekToDate(rotationGrid.anchorWeek);
    // Both dates are Mondays (isoWeekToDate / getMonday), so the exact number of
    // weeks between them is a clean day-count. Rounding absorbs DST hour shifts.
    // (Avoids the ISO week-year / 52-vs-53-week bugs of week-number arithmetic.)
    const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;
    const weeksDiff = Math.round((weekStartDate - refDate) / MS_PER_WEEK);
    const n = rotationGrid.cycleLength || 8;
    return ((weeksDiff % n) + n) % n; // handle past weeks (negative diff)
}

function isoWeekToDate(isoWeek) {
    const [year, week] = isoWeek.split('-W').map(Number);
    const jan4 = new Date(year, 0, 4);
    const monday = new Date(jan4);
    monday.setDate(jan4.getDate() - (jan4.getDay() || 7) + 1);
    monday.setDate(monday.getDate() + (week - 1) * 7);
    return monday;
}

// Doctor IDs on the rotation grid for a given day/shift on a given week (empty slots removed).
function getRotationDoctorsForShift(dayIdx, shift, weekStartDate) {
    const cell = rotationGrid.cells[`${dayIdx}_${shift}`];
    if (!cell || !cell.length) return [];
    const idx = rotationWeekIndex(weekStartDate);
    return (cell[idx] || []).filter(Boolean);
}

// Is this doctor part of the rotation grid at all (any cell, any week)?
function doctorHasRotation(docId) {
    return Object.values(rotationGrid.cells)
        .some(cell => cell.some(w => (w || []).includes(docId)));
}

function getCurrentISOWeek() {
    // Must use the ISO week-YEAR, not the calendar year: on 1 Jan 2027 the calendar
    // year (2027) with week 53 gave "2027-W53", which resolves to Jan 2028 — putting
    // the whole rotation cycle weeks out of phase until someone noticed.
    return isoWeekString(new Date());
}

// ISO week string (YYYY-Www) for a date, using the ISO week-year (Thursday rule)
// so it round-trips with isoWeekToDate even across year boundaries.
function isoWeekString(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7)); // move to Thursday
    const isoYear = d.getUTCFullYear();
    const yearStart = new Date(Date.UTC(isoYear, 0, 1));
    const wn = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    return `${isoYear}-W${String(wn).padStart(2, '0')}`;
}

// Build <option>s for the reference-week picker: one week per option, labelled
// with its Mon–Sun date range. Consistent across desktop/tablet/phone (unlike
// the native <input type="week"> picker, which differs per OS).
function buildAnchorWeekOptions(selectedIso) {
    const MON = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
    const base = isoWeekToDate(getCurrentISOWeek());
    let opts = '';
    let hasSelected = false;
    for (let i = -8; i <= 52; i++) {
        const mon = new Date(base); mon.setDate(base.getDate() + i * 7);
        const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
        const iso = isoWeekString(mon);
        if (iso === selectedIso) hasSelected = true;
        const label = `${mon.getDate()} ${MON[mon.getMonth()]} – ${sun.getDate()} ${MON[sun.getMonth()]} ${sun.getFullYear()}`;
        opts += `<option value="${iso}"${iso === selectedIso ? ' selected' : ''}>${label}</option>`;
    }
    // Keep a stored anchor that falls outside the visible range selectable — and label
    // it with real dates, not the raw "2026-W32", which tells the admin nothing.
    if (selectedIso && !hasSelected) {
        const mon = isoWeekToDate(selectedIso);
        const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
        const label = `${mon.getDate()} ${MON[mon.getMonth()]} – ${sun.getDate()} ${MON[sun.getMonth()]} ${sun.getFullYear()}`;
        opts = `<option value="${selectedIso}" selected>${label}</option>` + opts;
    }
    return opts;
}

// The 14 rows of the rotation grid: each weekday × each shift.
const ROTATION_ROWS = [];
for (let d = 0; d < 7; d++) for (const s of SHIFTS) ROTATION_ROWS.push({ dayIdx: d, shift: s });

// Normalise a cell to exactly `n` weeks, each an array of up to DOCTORS_PER_SHIFT slots.
// Read-only normalisation for rendering: does NOT write back. It used to, so simply
// opening the Rotações view created empty cells for all 14 rows, marked the rotation
// grid dirty, and let one admin's empty cell overwrite a row another admin had filled.
function readCell(key, n) {
    const existing = rotationGrid.cells[key] || [];
    const norm = [];
    for (let w = 0; w < n; w++) norm.push((existing[w] || []).slice(0, DOCTORS_PER_SHIFT));
    return norm;
}

// Writable variant: only call this when actually changing an assignment.
function ensureCell(key, n) {
    const norm = readCell(key, n);
    rotationGrid.cells[key] = norm;
    return norm;
}

// One <option> list for a rotation cell, empty slot first.
function rotationCellOptions(selected) {
    let opts = '<option value="">—</option>';
    doctors.forEach(doc => {
        opts += `<option value="${doc.id}"${doc.id === selected ? ' selected' : ''}>${esc(doc.name)}</option>`;
    });
    return opts;
}

// Stable per-doctor colour: hue evenly spread by the doctor's position in the list.
function doctorHue(id) {
    const i = doctors.findIndex(d => d.id === id);
    if (i < 0) return null;
    return Math.round((i * 360) / Math.max(doctors.length, 1));
}
// Inline style for a rotation cell/swatch tinted with the doctor's colour ('' if empty/unknown).
function doctorColorCss(id) {
    const h = doctorHue(id);
    return h == null ? '' : `background-color:hsl(${h} 68% 90%);color:hsl(${h} 55% 26%)`;
}

const MESES_CURTOS = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

// "3 – 9 Ago" / "31 Ago – 6 Set" — dates the admin can check against a calendar.
function intervaloSemana(segunda) {
    const dom = new Date(segunda);
    dom.setDate(segunda.getDate() + 6);
    const mesIgual = segunda.getMonth() === dom.getMonth();
    return mesIgual
        ? `${segunda.getDate()} – ${dom.getDate()} ${MESES_CURTOS[dom.getMonth()]}`
        : `${segunda.getDate()} ${MESES_CURTOS[segunda.getMonth()]} – ${dom.getDate()} ${MESES_CURTOS[dom.getMonth()]}`;
}

// The anchor -> S-number mapping, spelled out. Without this the admin has to count
// weeks from the reference by hand to know which column a given week uses.
function buildRotationMapa(n) {
    const ref = isoWeekToDate(rotationGrid.anchorWeek);
    const hojeSeg = getMonday(new Date());
    const total = Math.min(n, 12);
    let out = '';
    for (let i = 0; i < total; i++) {
        const seg = new Date(ref);
        seg.setDate(ref.getDate() + i * 7);
        const eHoje = seg.getTime() === hojeSeg.getTime();
        out += `<span class="rot-map-item${eHoje ? ' agora' : ''}">
            <b>S${i + 1}</b><span>${intervaloSemana(seg)}</span></span>`;
    }
    if (n > total) out += `<span class="rot-map-more">…</span>`;
    const fim = new Date(ref);
    fim.setDate(ref.getDate() + n * 7);
    out += `<span class="rot-map-loop">depois repete: ${intervaloSemana(fim)} volta à S1</span>`;
    return out;
}

// The whole 8-week (N-week) rotation as one big editable grid, like the Excel.
function renderRotations() {
    const mount = document.getElementById('rotations-list');
    const canEdit = currentRole === 'admin';
    const n = rotationGrid.cycleLength || 8;
    const curIdx = rotationWeekIndex(currentWeekStart);

    let html = `<div class="rot-controls">
        <div class="form-group">
            <label for="rot-cycle-len">Duração do ciclo (semanas)</label>
            <input type="number" id="rot-cycle-len" min="2" max="52" value="${n}" ${canEdit ? '' : 'disabled'}>
        </div>
        <div class="form-group">
            <label for="rot-anchor">Semana de referência (= S1)</label>
            <select id="rot-anchor" ${canEdit ? '' : 'disabled'}>${buildAnchorWeekOptions(rotationGrid.anchorWeek)}</select>
        </div>
        <div class="rot-controls-note">Esta semana (${intervaloSemana(getMonday(new Date()))}): <strong>S${curIdx + 1}</strong></div>
    </div>`;

    html += `<div class="rot-explain">
        <p><strong>Como funciona:</strong> a semana de referência é a <b>S1</b>. Cada semana seguinte avança uma coluna — S2, S3… — e ao fim de ${n} semanas volta à S1.</p>
        <div class="rot-map">${buildRotationMapa(n)}</div>
    </div>`;

    html += `<div id="rot-warnings"></div>`;

    html += `<div class="rot-grid-wrap"><table class="rot-grid"><thead><tr><th class="rot-rowhead">Dia / Turno</th>`;
    for (let w = 0; w < n; w++) html += `<th class="${w === curIdx ? 'current' : ''}">S${w + 1}</th>`;
    html += `</tr></thead><tbody>`;

    ROTATION_ROWS.forEach(({ dayIdx, shift }) => {
        const key = `${dayIdx}_${shift}`;
        const cell = readCell(key, n);        // render only — must not dirty the grid
        const shiftShort = shift === 'day' ? 'Dia' : 'Noite';
        html += `<tr class="rot-row rot-${shift}"><td class="rot-rowhead">${DAYS_FULL[dayIdx]}<span class="rot-shift">${shiftShort}</span></td>`;
        for (let w = 0; w < n; w++) {
            html += `<td class="${w === curIdx ? 'current' : ''}">`;
            for (let s = 0; s < DOCTORS_PER_SHIFT; s++) {
                html += `<select class="rot-cell" data-key="${key}" data-week="${w}" data-seat="${s}" style="${doctorColorCss(cell[w][s] || '')}" ${canEdit ? '' : 'disabled'}>${rotationCellOptions(cell[w][s] || '')}</select>`;
            }
            html += `</td>`;
        }
        html += `</tr>`;
    });
    html += `</tbody></table></div>`;

    mount.innerHTML = html;
    if (!canEdit) return; // read-only: no listeners

    document.getElementById('rot-cycle-len').addEventListener('change', e => {
        let v = parseInt(e.target.value);
        if (!v || v < 2) v = 2;
        v = Math.min(v, 52);
        const anterior = rotationGrid.cycleLength || 8;
        if (v === anterior) return;

        // Shrinking the cycle deletes the trailing weeks of all 14 rows. It used to do
        // that instantly, with no confirmation and no way back.
        if (v < anterior) {
            let turnosPerdidos = 0;
            Object.values(rotationGrid.cells).forEach(cell => {
                for (let w = v; w < (cell || []).length; w++) turnosPerdidos += (cell[w] || []).filter(Boolean).length;
            });
            if (turnosPerdidos > 0) {
                const ok = confirm(
                    `Reduzir o ciclo de ${anterior} para ${v} semanas apaga as semanas S${v + 1} a S${anterior}, ` +
                    `com ${turnosPerdidos} ${turnosPerdidos === 1 ? 'turno atribuído' : 'turnos atribuídos'}.\n\nContinuar?`);
                if (!ok) { e.target.value = anterior; return; }
            }
            const copia = JSON.parse(JSON.stringify(rotationGrid));   // for the undo banner
            rotationGrid.cycleLength = v;
            Object.keys(rotationGrid.cells).forEach(k => ensureCell(k, v));
            save(); renderRotations(); renderSchedule();
            if (turnosPerdidos > 0) {
                showUndoToast(
                    `Ciclo reduzido para <strong>${v} semanas</strong> — ${turnosPerdidos} turnos removidos.`,
                    () => { rotationGrid = copia; save(); renderRotations(); renderSchedule();
                            showSaveStatus('Ciclo restaurado'); });
            }
            return;
        }

        rotationGrid.cycleLength = v;
        Object.keys(rotationGrid.cells).forEach(k => ensureCell(k, v));
        save();
        renderRotations();
        renderSchedule();
    });

    document.getElementById('rot-anchor').addEventListener('change', e => {
        if (!e.target.value) return;
        rotationGrid.anchorWeek = e.target.value;
        save();
        renderRotations();
        renderSchedule();
    });

    renderRotationWarnings();

    mount.querySelectorAll('.rot-cell').forEach(sel => {
        sel.addEventListener('change', () => {
            const key = sel.dataset.key;
            const w = +sel.dataset.week, s = +sel.dataset.seat;
            const cell = ensureCell(key, rotationGrid.cycleLength);
            if (sel.value && cell[w].some((d, i) => i !== s && d === sel.value)) {
                alert('Esse médico já está nesta semana/turno.');
                sel.value = cell[w][s] || '';
                return;
            }
            cell[w][s] = sel.value || null;
            sel.setAttribute('style', doctorColorCss(sel.value)); // retint to match new pick

            // Pairing someone across both halves of a day is a 24h stint. Say so, but
            // never interrupt: the rotation is kept either way, and the standing list
            // below the controls carries the one-click fix.
            if (sel.value) {
                const [dia, turno] = key.split('_');
                const outro = turno === 'day' ? `${dia}_night` : `${dia}_day`;
                const par = (rotationGrid.cells[outro] || [])[w] || [];
                const doc = doctors.find(d => d.id === sel.value);
                if (doc && !doc.can24h && par.includes(sel.value)) {
                    showRotationNotice(
                        `${doc.name.split(' ')[0]} fica com 24 h seguidas à ${DAYS_FULL[+dia].toLowerCase()} (S${w + 1}) — sem "Pode fazer 24h" no perfil.`);
                }
            }
            save();
            renderRotationWarnings();
            renderSchedule();
            renderHoursSummary();
        });
    });
}

// Doctors the rotation puts on both the day and the night of the same weekday in the
// same cycle week — a 24h stint. The auto-fill honours it (configuring both halves
// reads as intent), so these shifts get worked whether or not the profile allows 24h.
// That makes the "Pode fazer 24h" flag look decorative; list the mismatches instead.
function getRotation24hMismatches() {
    const porMedico = {};
    const n = rotationGrid.cycleLength || 8;
    for (let d = 0; d < 7; d++) {
        const dia = rotationGrid.cells[`${d}_day`] || [];
        const noite = rotationGrid.cells[`${d}_night`] || [];
        for (let w = 0; w < n; w++) {
            const deDia = (dia[w] || []).filter(Boolean);
            (noite[w] || []).filter(Boolean).forEach(id => {
                if (!deDia.includes(id)) return;
                const doc = doctors.find(x => x.id === id);
                if (!doc || doc.can24h) return;
                (porMedico[id] = porMedico[id] || { doc, quando: [] })
                    .quando.push(`${DAYS[d]} S${w + 1}`);
            });
        }
    }
    return Object.values(porMedico);
}

// Non-blocking notice for the rotation editor. Deliberately not a confirm(): building
// a rotation pairs people repeatedly, and a modal per edit would be in the way. The
// standing list under the controls is where the situation gets resolved.
let _rotNoticeTimer = null;
function showRotationNotice(message) {
    const mount = document.getElementById('rotations-list');
    if (!mount) return;
    document.querySelectorAll('.rot-notice').forEach(n => n.remove());
    if (_rotNoticeTimer) { clearTimeout(_rotNoticeTimer); _rotNoticeTimer = null; }

    const el = document.createElement('div');
    el.className = 'rot-notice';
    el.setAttribute('role', 'status');
    el.innerHTML = `<span class="rot-notice-icon">⏱</span><span>${esc(message)}</span>`;
    mount.prepend(el);
    requestAnimationFrame(() => el.classList.add('in'));
    _rotNoticeTimer = setTimeout(() => { el.classList.remove('in'); setTimeout(() => el.remove(), 250); }, 6000);
}

// One-click fix from the rotation editor, so the admin doesn't have to go hunting
// through the doctor's card for a checkbox.
window.activar24h = function (docId) {
    const doc = doctors.find(d => d.id === docId);
    if (!doc) return;
    doc.can24h = true;
    save();
    renderRotations();
    renderDoctors();
    renderSchedule();
    renderHoursSummary();
};

// The two rotation warnings live in their own container so an edit can refresh them
// without rebuilding the grid underneath the admin's cursor.
function renderRotationWarnings() {
    const box = document.getElementById('rot-warnings');
    if (!box) return;
    const canEdit = currentRole === 'admin';
    let out = '';

    // Orphan ids render as blank seats in the grid below, so say plainly what is wrong.
    const orfaos = getRotationOrphanIds();
    if (orfaos.length) {
        out += `<div class="rot-orphan-warn">
            <strong>⚠ ${orfaos.length} ${orfaos.length === 1 ? 'lugar refere um médico que já não existe' : 'lugares referem médicos que já não existem'}</strong>
            <p>Aparecem em branco na grelha e a rotação perde esses turnos — o Auto-Preencher entrega-os a quem estiver livre. Volte a escolher o médico nesses lugares.</p>
            <p class="rot-orphan-ids">Referências perdidas: ${orfaos.map(esc).join(', ')}</p>
        </div>`;
    }

    // Standing list of the 24h pairings already in the grid — the edit-time prompt only
    // catches new ones, and a grid imported or built earlier is full of them.
    const sem24h = getRotation24hMismatches();
    if (sem24h.length) {
        out += `<div class="rot-24h-warn">
            <strong>${sem24h.length} ${sem24h.length === 1 ? 'médico faz 24 h na rotação sem ter a opção ativada' : 'médicos fazem 24 h na rotação sem terem a opção ativada'}</strong>
            <p>A rotação põe estas pessoas de dia <b>e</b> de noite no mesmo dia. A escala respeita isso à mesma — a opção do perfil não a impede. Ative a opção para os números baterem certo, ou mude a rotação.</p>
            <ul class="rot-24h-list">${sem24h.map(({ doc, quando }) => `
                <li>
                    <span class="rot-24h-nome">${esc(doc.name)}</span>
                    <span class="rot-24h-quando">${quando.length} ${quando.length === 1 ? 'vez' : 'vezes'}: ${esc(quando.slice(0, 4).join(', '))}${quando.length > 4 ? '…' : ''}</span>
                    ${canEdit ? `<button class="btn btn-sm rot-24h-btn" onclick="activar24h('${esc(doc.id)}')">Ativar 24 h</button>` : ''}
                </li>`).join('')}</ul>
        </div>`;
    }

    box.innerHTML = out;
}

// Read-only view of a doctor's rotation assignments across the cycle (shown in their modal).
function renderDoctorRotationView(docId) {
    const section = document.getElementById('doctor-rotation-section');
    const view = document.getElementById('doctor-rotation-view');
    if (!doctorHasRotation(docId)) {
        section.classList.add('hidden');
        view.innerHTML = '';
        return;
    }
    section.classList.remove('hidden');
    const n = rotationGrid.cycleLength || 8;
    const curIdx = rotationWeekIndex(currentWeekStart);
    const rows = ROTATION_ROWS.filter(({ dayIdx, shift }) => {
        const cell = rotationGrid.cells[`${dayIdx}_${shift}`];
        return cell && cell.some(w => (w || []).includes(docId));
    });

    let html = `<div class="rot-grid-wrap"><table class="rot-grid rot-grid-mini"><thead><tr><th class="rot-rowhead">Dia / Turno</th>`;
    for (let w = 0; w < n; w++) html += `<th class="${w === curIdx ? 'current' : ''}">S${w + 1}</th>`;
    html += `</tr></thead><tbody>`;
    rows.forEach(({ dayIdx, shift }) => {
        const cell = rotationGrid.cells[`${dayIdx}_${shift}`];
        html += `<tr class="rot-row rot-${shift}"><td class="rot-rowhead">${DAYS_FULL[dayIdx]}<span class="rot-shift">${shift === 'day' ? 'Dia' : 'Noite'}</span></td>`;
        for (let w = 0; w < n; w++) {
            const on = (cell[w] || []).includes(docId);
            const style = on ? doctorColorCss(docId) : '';
            html += `<td class="${w === curIdx ? 'current ' : ''}${on ? 'rot-on' : ''}" style="${style}">${on ? '✓' : ''}</td>`;
        }
        html += `</tr>`;
    });
    html += `</tbody></table></div>`;
    view.innerHTML = html;
}

// ---- Auto-fill ----

// Check if a doctor needs rest: after working a night shift, they cannot work the next 2 shifts
// (next day's day shift and next day's night shift = full day off after a night)
function needsRestAfterNight(docId, date, shift) {
    const prevDay = new Date(date);
    prevDay.setDate(prevDay.getDate() - 1);
    const prevNightAssigned = getAssignedForShift(prevDay, 'night');
    return prevNightAssigned.includes(docId);
}

// Check if assigning a night shift (or 24h) on `date` would conflict with
// an already-assigned shift on the next day (reverse rest check)
function hasNextDayConflict(docId, date) {
    const nextDay = new Date(date);
    nextDay.setDate(nextDay.getDate() + 1);
    return SHIFTS.some(s => getAssignedForShift(nextDay, s).includes(docId));
}

// Check if assigning this doctor to this shift would exceed their monthly hours limit
// If monthlyHoursLimit is not set (null/undefined/0), assume 0 extra hours allowed
function wouldExceedMonthlyLimit(doc, date) {
    const limit = doc.monthlyHoursLimit || 0;
    // Count only extra (non-fixed) hours
    const extraHours = getMonthlyExtraHoursForAutoFill(doc, date);
    return (extraHours + HOURS_PER_SHIFT) > limit;
}

// Count extra hours (non-fixed) assigned this month for auto-fill check
function getMonthlyExtraHoursForAutoFill(doc, date) {
    const year = date.getFullYear();
    const month = date.getMonth();
    let extraHours = 0;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    for (let d = 1; d <= daysInMonth; d++) {
        const dt = new Date(year, month, d);
        SHIFTS.forEach(s => {
            const assigned = getAssignedForShift(dt, s);
            if (assigned.includes(doc.id)) {
                // Only count if NOT a fixed shift
                if (!isFixedForShiftOnDate(doc, dt, s)) {
                    extraHours += HOURS_PER_SHIFT;
                }
            }
        });
    }
    return extraHours;
}

// Get total hours for a doctor in the current month (used for sorting/priority)
function getCurrentMonthHours(docId, dates) {
    let hours = 0;
    dates.forEach(d => {
        SHIFTS.forEach(s => {
            const assigned = getAssignedForShift(d, s);
            if (assigned.includes(docId)) hours += HOURS_PER_SHIFT;
        });
    });
    return hours;
}

// A same-day day+night pairing is only a *deliberate* 24h when the doctor can do 24h,
// or both shifts come from a genuine fixed source (weekly schedule / monthly / rotation grid).
// Used to block accidental 24h stints created by combining day-of-week rules with fixed shifts.
function isDeliberate24hDate(doc, date) {
    if (doc.can24h === true) return true;
    const dayIdx = (date.getDay() + 6) % 7;
    if (doc.fixedSchedule && doc.fixedSchedule[`${dayIdx}_day`] && doc.fixedSchedule[`${dayIdx}_night`]) return true;
    if (doc.fixedMonthly) {
        const fmd = doc.fixedMonthlyData || {};
        const dk = dateKey(date);
        if (fmd[dk] && fmd[dk].day && fmd[dk].night) return true;
    }
    const monday = getMonday(date);
    if (getRotationDoctorsForShift(dayIdx, 'day', monday).includes(doc.id) &&
        getRotationDoctorsForShift(dayIdx, 'night', monday).includes(doc.id)) return true;
    return false;
}

// Would adding this doctor to (date, shift) create an *accidental* same-day 24h?
function wouldDoubleBookSameDay(doc, date, shift) {
    const otherShift = shift === 'day' ? 'night' : 'day';
    return getAssignedForShift(date, otherShift).includes(doc.id) && !isDeliberate24hDate(doc, date);
}

document.getElementById('auto-fill-btn').addEventListener('click', () => {
    const dates = getMonthDates();

    // Helper to get/init sched array for a date+shift
    function getSk(date, shift) {
        const sched = getOrCreateScheduleForDate(date);
        const sk = shiftKey(date, shift);
        if (!sched[sk]) sched[sk] = [];
        return { sched, sk, arr: sched[sk] };
    }

    // =========================================
    // PASS 1: Fixed-schedule doctors (highest priority)
    // =========================================
    // Conflicts found while placing the admin's fixed/rotation configuration. These
    // used to be silent in both directions: a dropped fixed shift left an unexplained
    // hours deficit, and a rest violation was placed with no warning at all.
    const conflitos = [];
    const nomeCurto = id => { const d = doctors.find(x => x.id === id); return d ? d.name.split(' ')[0] : id; };
    const dataCurta = d => `${d.getDate()}/${d.getMonth() + 1}`;

    dates.forEach(date => {
        SHIFTS.forEach(shift => {
            const { arr } = getSk(date, shift);
            const turno = SHIFT_LABELS[shift].toLowerCase();
            doctors.forEach(doc => {
                if (!isFixedForShiftOnDate(doc, date, shift) || isMonthlyUnavailable(doc, date, shift)) return;
                if (arr.includes(doc.id)) return;

                // "Bloqueado (semanal)" is an explicit "never this shift", so it beats a
                // rotation cell that says otherwise. Every other pass already checked this;
                // PASS 1 did not, so the rotation silently won and the schedule contradicted
                // the assign modal, which greys the same doctor out as unavailable.
                if (isBlockedOnDate(doc, date, shift)) {
                    conflitos.push({ motivo: 'bloqueado', texto: `${nomeCurto(doc.id)} — ${dataCurta(date)} ${turno}: está bloqueado neste turno, mas a rotação/horário pede-o.` });
                    return;
                }

                if (wouldDoubleBookSameDay(doc, date, shift)) {
                    conflitos.push({ motivo: 'dia+noite', texto: `${nomeCurto(doc.id)} — ${dataCurta(date)} ${turno}: ficaria com dia+noite seguidos e não faz 24h.` });
                    return;
                }
                if (workedOtherWeekendDay(doc.id, date)) {
                    conflitos.push({ motivo: 'fim de semana', texto: `${nomeCurto(doc.id)} — ${dataCurta(date)} ${turno}: já trabalha o outro dia deste fim de semana.` });
                    return;
                }
                if (arr.length >= DOCTORS_PER_SHIFT) {
                    conflitos.push({ motivo: 'turno cheio', texto: `${nomeCurto(doc.id)} — ${dataCurta(date)} ${turno}: o turno já tinha ${DOCTORS_PER_SHIFT} pessoas.` });
                    return;
                }
                // Rest wins over the configured schedule: a fixed/rotation shift that
                // would break the post-night rest is refused, not placed with a warning.
                // The slot is left open so a rested doctor can take it in PASS 3.
                if (needsRestAfterNight(doc.id, date, shift)) {
                    conflitos.push({ motivo: 'descanso', texto: `${nomeCurto(doc.id)} — ${dataCurta(date)} ${turno}: fez a noite anterior, precisa de descanso.` });
                    return;
                }
                if (shift === 'night' && hasNextDayConflict(doc.id, date)) {
                    conflitos.push({ motivo: 'descanso', texto: `${nomeCurto(doc.id)} — ${dataCurta(date)} noturno: já trabalha no dia seguinte.` });
                    return;
                }
                arr.push(doc.id);
            });
        });
    });

    // Rotation-grid doctors are handled by PASS 1 above (isFixedForShiftOnDate
    // now treats a rotation-grid assignment as fixed).

    // =========================================
    // PASS 2.5: Monthly day-of-week rules
    // =========================================
    doctors.forEach(doc => {
        const rules = getDoctorRules(doc);
        dates.forEach(date => {
            const dow = (date.getDay() + 6) % 7;
            const applicable = rules
                .filter(r => r.dayOfWeek === dow)
                .sort((a, b) => (a.shiftType === '24h' ? 0 : 1) - (b.shiftType === '24h' ? 0 : 1));

            const has24hRule = applicable.some(r => r.shiftType === '24h');
            applicable.forEach(rule => {
                const exclude24h = rule.shiftType !== '24h' && has24hRule;
                const assigned = countMonthlyDowAssignments(
                    doc.id, date.getFullYear(), date.getMonth(), dow, rule.shiftType, exclude24h);
                if (assigned >= rule.count) return;

                const shifts = rule.shiftType === '24h' ? ['day', 'night'] : [rule.shiftType];
                if (shifts.some(s => isBlockedOnDate(doc, date, s) || isMonthlyUnavailable(doc, date, s))) return;
                // Also check rest-after-night rule
                if (shifts.some(s => needsRestAfterNight(doc.id, date, s))) return;
                // If assigning night or 24h, check no shifts already exist on next day
                if (rule.shiftType === 'night' || rule.shiftType === '24h') {
                    if (hasNextDayConflict(doc.id, date)) return;
                }
                if (rule.shiftType === '24h') {
                    const canBoth = shifts.every(s => {
                        const { arr } = getSk(date, s);
                        return !arr.includes(doc.id) && arr.length < DOCTORS_PER_SHIFT;
                    });
                    if (!canBoth) return;
                }
                if (workedOtherWeekendDay(doc.id, date)) return;

                shifts.forEach(s => {
                    const { arr } = getSk(date, s);
                    // A single-shift rule must not stack onto the other shift of the same day
                    // (that would be an accidental 24h). 24h rules place both deliberately.
                    if (rule.shiftType !== '24h' && wouldDoubleBookSameDay(doc, date, s)) return;
                    if (!arr.includes(doc.id) && arr.length < DOCTORS_PER_SHIFT) {
                        arr.push(doc.id);
                    }
                });
            });
        });
    });

    // =========================================
    // PASS 2.6 — Reposição de Turnos por Indisponibilidade
    // Regra: férias em dias de horário fixo contam como horas fixas (sem reposição).
    // Indisponibilidade não-férias gera débito de turnos a repor o mais cedo possível.
    // =========================================

    // Calcular débito de reposição por médico (apenas indisponibilidade, não férias)
    const recoveryDebt = {}; // docId -> nº de turnos a repor
    doctors.forEach(doc => {
        const unavail = doc.monthlyUnavailability || {};
        const vacation = doc.monthlyVacation || {};
        let debt = 0;
        dates.forEach(date => {
            const dk = dateKey(date);
            SHIFTS.forEach(shift => {
                // Conta apenas se marcado como indisponível, não é férias, E era um turno fixo
                if (unavail[dk] && unavail[dk][shift] && !(vacation[dk] && vacation[dk][shift])) {
                    // Only weekly-fixed / monthly / rotation misses need recovery — day-of-week
                    // rules re-route themselves to another matching day, so they don't owe a debt.
                    if (isFixedForShiftOnDate(doc, date, shift) && !isRuleBasedShift(doc, date, shift)) {
                        debt++;
                    }
                }
            });
        });
        if (debt > 0) recoveryDebt[doc.id] = debt;
    });

    // Atribuir turnos de reposição o mais cedo possível (prioridade por maior débito)
    if (Object.keys(recoveryDebt).length > 0) {
        dates.forEach(date => {
            SHIFTS.forEach(shift => {
                const { arr } = getSk(date, shift);
                if (arr.length >= DOCTORS_PER_SHIFT) return;

                const candidates = doctors
                    .filter(doc => (recoveryDebt[doc.id] || 0) > 0)
                    .filter(doc => !arr.includes(doc.id))
                    .filter(doc => !isBlockedOnDate(doc, date, shift))
                    .filter(doc => !isMonthlyUnavailable(doc, date, shift))
                    .filter(doc => !needsRestAfterNight(doc.id, date, shift))
                    .filter(doc => shift !== 'night' || !hasNextDayConflict(doc.id, date))
                    .filter(doc => !workedOtherWeekendDay(doc.id, date))
                    .filter(doc => !wouldDoubleBookSameDay(doc, date, shift))
                    .map(doc => ({
                        doc,
                        debt: recoveryDebt[doc.id] || 0,
                        // 0 = fixo ou "pode" explícito, 1 = dia neutro (último recurso)
                        availPriority: (isFixedForShiftOnDate(doc, date, shift) || isFlexAvailableOnDate(doc, date, shift)) ? 0 : 1,
                    }))
                    .sort((a, b) => a.availPriority - b.availPriority || b.debt - a.debt);

                for (const c of candidates) {
                    if (arr.length >= DOCTORS_PER_SHIFT) break;
                    arr.push(c.doc.id);
                    recoveryDebt[c.doc.id]--;
                    if (recoveryDebt[c.doc.id] <= 0) delete recoveryDebt[c.doc.id];
                }
            });
        });
    }

    // Helper: check if doctor already works the other weekend day
    function workedOtherWeekendDay(docId, date) {
        const dow = date.getDay(); // 0=Sun, 6=Sat
        if (dow === 6) {
            const sunday = new Date(date); sunday.setDate(date.getDate() + 1);
            return SHIFTS.some(s => getAssignedForShift(sunday, s).includes(docId));
        }
        if (dow === 0) {
            const saturday = new Date(date); saturday.setDate(date.getDate() - 1);
            return SHIFTS.some(s => getAssignedForShift(saturday, s).includes(docId));
        }
        return false;
    }

    // =========================================
    // PASS 2.7: Terceiros — REMOVED ON PURPOSE.
    // A tarefeiro's availability is a *request*; only an admin accepting it puts
    // them on the schedule (see the "Pedidos de tarefeiros" panel and the pending
    // markers in the monthly schedule). Auto-fill must never bypass that approval.
    // =========================================

    // =========================================
    // PASS 3a-weekend (prioritised): give each 24h-capable doctor ONE full
    // 24h shift (day+night, same day) on a weekend BEFORE any 12h singles are
    // spread. Doctor-centric so every eligible doctor gets a turn — prevents the
    // "12h num fim-de-semana + 12h noutro" split.
    // =========================================
    const weekendDates = dates.filter(d => { const w = (d.getDay() + 6) % 7; return w === 5 || w === 6; });
    doctors
        .filter(doc => doc.can24h === true && (doc.monthlyHoursLimit || 0) > 0)
        .map(doc => ({ doc, extra: getMonthlyExtraHoursForAutoFill(doc, dates[0]) }))
        .sort((a, b) => a.extra - b.extra)
        .forEach(({ doc }) => {
            // Skip doctors who already have a full weekend 24h
            const alreadyHas24 = weekendDates.some(d =>
                getAssignedForShift(d, 'day').includes(doc.id) && getAssignedForShift(d, 'night').includes(doc.id));
            if (alreadyHas24) return;
            // Prefer weekends the doctor explicitly marked available; neutral weekends only as fallback.
            const ordered = [...weekendDates].sort((a, b) => {
                const av = (isFlexAvailableOnDate(doc, a, 'day') && isFlexAvailableOnDate(doc, a, 'night')) ? 0 : 1;
                const bv = (isFlexAvailableOnDate(doc, b, 'day') && isFlexAvailableOnDate(doc, b, 'night')) ? 0 : 1;
                return av - bv;
            });
            for (const date of ordered) {
                const { arr: dayArr } = getSk(date, 'day');
                const { arr: nightArr } = getSk(date, 'night');
                if (dayArr.includes(doc.id) || nightArr.includes(doc.id)) continue;
                if (dayArr.length >= DOCTORS_PER_SHIFT || nightArr.length >= DOCTORS_PER_SHIFT) continue;
                if (isBlockedOnDate(doc, date, 'day') || isBlockedOnDate(doc, date, 'night')) continue;
                if (isMonthlyUnavailable(doc, date, 'day') || isMonthlyUnavailable(doc, date, 'night')) continue;
                if (needsRestAfterNight(doc.id, date, 'day')) continue;
                if (hasNextDayConflict(doc.id, date)) continue;
                if (workedOtherWeekendDay(doc.id, date)) continue;
                if ((getMonthlyExtraHoursForAutoFill(doc, date) + 24) > (doc.monthlyHoursLimit || 0)) continue;
                dayArr.push(doc.id);
                nightArr.push(doc.id);
                break; // one weekend 24h per doctor
            }
        });

    // =========================================
    // PASS 3a: Prefer 24h assignments for doctors with can24h=true
    // Fill both day+night slots simultaneously for eligible doctors
    // =========================================
    dates.forEach(date => {
        const { arr: dayArr } = getSk(date, 'day');
        const { arr: nightArr } = getSk(date, 'night');

        while (dayArr.length < DOCTORS_PER_SHIFT && nightArr.length < DOCTORS_PER_SHIFT) {
            const candidates = doctors
                .filter(doc => doc.can24h === true)
                .filter(doc => !dayArr.includes(doc.id) && !nightArr.includes(doc.id))
                .filter(doc => !isBlockedOnDate(doc, date, 'day') && !isBlockedOnDate(doc, date, 'night'))
                .filter(doc => !isMonthlyUnavailable(doc, date, 'day') && !isMonthlyUnavailable(doc, date, 'night'))
                .filter(doc => !needsRestAfterNight(doc.id, date, 'day'))
                .filter(doc => !hasNextDayConflict(doc.id, date))
                .filter(doc => !workedOtherWeekendDay(doc.id, date))
                .filter(doc => {
                    const limit = doc.monthlyHoursLimit || 0;
                    if (limit <= 0) return false;
                    const extra = getMonthlyExtraHoursForAutoFill(doc, date);
                    return (extra + 24) <= limit; // needs 24h headroom
                })
                // Only explicitly available doctors in PASS 3a — neutral doctors go to PASS 3
                .filter(doc => isFlexAvailableOnDate(doc, date, 'day') && isFlexAvailableOnDate(doc, date, 'night'))
                .map(doc => ({
                    doc,
                    extraHours: getMonthlyExtraHoursForAutoFill(doc, date),
                }))
                .sort((a, b) => a.extraHours - b.extraHours);

            if (candidates.length === 0) break;
            const chosen = candidates[0].doc;
            dayArr.push(chosen.id);
            nightArr.push(chosen.id);
        }
    });

    // =========================================
    // PASS 3: Fill remaining slots with flex/extra hours
    // Rules:
    //   - After a night shift, doctor rests the ENTIRE next day (next 2 shifts)
    //   - Cannot exceed monthly EXTRA hours limit (monthlyHoursLimit, default 0)
    //   - Fixed shifts don't count towards the extra hours limit
    //   - Prefer doctor with fewer extra hours this month (load balancing)
    //   - Never schedule a doctor on both Saturday and Sunday
    //   - Preferência: 1 médico por dia em mais dias > 2 num dia e 0 noutro
    //     (sub-pass A: garante 1 em cada slot vazio; sub-pass B: completa o 2º)
    // =========================================
    function pass3Candidates(arr, date, shift) {
        return doctors
            .filter(doc => !arr.includes(doc.id))
            // Never assign the same doctor to both day and night on the same date
            .filter(doc => !SHIFTS.some(s => s !== shift && getAssignedForShift(date, s).includes(doc.id)))
            .filter(doc => !isBlockedOnDate(doc, date, shift))
            .filter(doc => !isMonthlyUnavailable(doc, date, shift))
            .filter(doc => !needsRestAfterNight(doc.id, date, shift))
            .filter(doc => shift !== 'night' || !hasNextDayConflict(doc.id, date))
            .filter(doc => !workedOtherWeekendDay(doc.id, date))
            .filter(doc => {
                const limit = doc.monthlyHoursLimit || 0;
                if (limit <= 0) return false;
                return !wouldExceedMonthlyLimit(doc, date);
            })
            .map(doc => ({
                doc,
                extraHours: getMonthlyExtraHoursForAutoFill(doc, date),
                // Priority 0 = explicitly available, 1 = no data (neutral)
                availPriority: isFlexAvailableOnDate(doc, date, shift) ? 0 : 1,
            }))
            .sort((a, b) => a.availPriority - b.availPriority || a.extraHours - b.extraHours);
    }

    // Sub-pass A: atribuir no máximo 1 médico a cada slot vazio
    dates.forEach(date => {
        SHIFTS.forEach(shift => {
            const { arr } = getSk(date, shift);
            if (arr.length > 0) return; // já tem pelo menos 1, saltar
            const candidates = pass3Candidates(arr, date, shift);
            if (candidates.length > 0) arr.push(candidates[0].doc.id);
        });
    });

    // Sub-pass B: completar o 2º médico nos slots que ainda têm menos de DOCTORS_PER_SHIFT
    dates.forEach(date => {
        SHIFTS.forEach(shift => {
            const { arr } = getSk(date, shift);
            while (arr.length < DOCTORS_PER_SHIFT) {
                const candidates = pass3Candidates(arr, date, shift);
                if (candidates.length === 0) break;
                arr.push(candidates[0].doc.id);
            }
        });
    });

    // Sub-pass C (redistribuição): mover médicos de turnos com 2 para turnos com 0
    // Nunca ultrapassa limites de horas — apenas redistribui atribuições existentes
    dates.forEach(date => {
        SHIFTS.forEach(shift => {
            const { arr: emptyArr } = getSk(date, shift);
            if (emptyArr.length > 0) return; // já tem médico, ignorar

            // Procurar noutros turnos do mês com 2 médicos um candidato movível
            let moved = false;
            for (const srcDate of dates) {
                if (moved) break;
                for (const srcShift of SHIFTS) {
                    if (moved) break;
                    const { arr: srcArr } = getSk(srcDate, srcShift);
                    if (srcArr.length < DOCTORS_PER_SHIFT) continue; // só mexer em turnos completos

                    // Encontrar um médico deste turno que possa fazer o turno vazio
                    for (let i = 0; i < srcArr.length; i++) {
                        const docId = srcArr[i];
                        const doc = doctors.find(d => d.id === docId);
                        if (!doc) continue;
                        // Never move a doctor from a fixed shift
                        if (isFixedForShiftOnDate(doc, srcDate, srcShift)) continue;
                        // Never dismantle a 24h pairing (day+night same day) — weekday or weekend
                        const pairedShift = srcShift === 'day' ? 'night' : 'day';
                        if (getAssignedForShift(srcDate, pairedShift).includes(docId)) continue;
                        if (emptyArr.includes(docId)) continue;
                        // Not already working another shift on the target date
                        if (SHIFTS.some(s => s !== shift && getAssignedForShift(date, s).includes(docId))) continue;
                        if (isBlockedOnDate(doc, date, shift)) continue;
                        if (isMonthlyUnavailable(doc, date, shift)) continue;
                        if (needsRestAfterNight(docId, date, shift)) continue;
                        if (shift === 'night' && hasNextDayConflict(docId, date)) continue;
                        if (workedOtherWeekendDay(docId, date)) continue;

                        // Mover: remover da fonte e adicionar ao turno vazio
                        srcArr.splice(i, 1);
                        emptyArr.push(docId);
                        moved = true;
                        break;
                    }
                }
            }
        });
    });

    save();
    renderSchedule();
    renderHoursSummary();

    // Shifts already assigned to someone since marked férias/indisponível: auto-fill
    // never removes them, so list them too or they stay invisible.
    dates.forEach(date => {
        SHIFTS.forEach(shift => {
            getAssignedForShift(date, shift).forEach(id => {
                const doc = doctors.find(x => x.id === id);
                if (!doc || !isMonthlyUnavailable(doc, date, shift)) return;
                const motivo = isOnVacation(doc, date, shift) ? 'está de FÉRIAS' : 'está INDISPONÍVEL';
                conflitos.push({ motivo: 'escalado de férias/indisponível', texto: `${nomeCurto(id)} — ${dataCurta(date)} ${SHIFT_LABELS[shift].toLowerCase()}: continua escalado mas ${motivo}.` });
            });
        });
    });

    // Rest violations already in the schedule. PASS 1 refuses to create these, but it
    // skips anyone already assigned, so a month filled before this rule existed — or
    // filled by hand — would keep the violation and report nothing. Checking the final
    // schedule also makes the report the same on every re-run.
    dates.forEach(date => {
        SHIFTS.forEach(shift => {
            getAssignedForShift(date, shift).forEach(id => {
                const doc = doctors.find(x => x.id === id);
                if (!doc || !needsRestAfterNight(id, date, shift)) return;
                conflitos.push({ motivo: 'já escalado sem descanso', texto: `${nomeCurto(id)} — ${dataCurta(date)} ${SHIFT_LABELS[shift].toLowerCase()}: já estava escalado sem descanso.` });
            });
        });
    });

    // Orphan rotation ids cost the rotation its slots silently — report them first,
    // because every other conflict below is a consequence, not the cause.
    const orfaos = getRotationOrphanIds();
    if (orfaos.length) {
        conflitos.unshift({ motivo: 'médico já não existe', texto: `Grelha de rotação: ${orfaos.slice(0, 3).join(', ')}${orfaos.length > 3 ? '…' : ''} — a grelha pede quem já não está na lista de médicos.` });
    }

    if (conflitos.length) {
        // Grouped by cause: a month that was already filled produces dozens of identical
        // "turno cheio" lines, and a raw truncated list buried the one thing the admin
        // needed to know — why the rotation could not get in.
        const porMotivo = {};
        conflitos.forEach(c => (porMotivo[c.motivo] = porMotivo[c.motivo] || []).push(c.texto));
        const grupos = Object.entries(porMotivo).sort((a, b) => b[1].length - a[1].length);

        const SUGESTAO = {
            'turno cheio': 'já havia gente nesses turnos; Limpar Mês e preencher de novo dá a vez à rotação',
            'médico já não existe': 'corrija esses lugares na tab Rotações',
            'bloqueado': 'a grelha semanal e a rotação pedem coisas diferentes',
            'dia+noite': 'ative "Pode fazer 24h" no perfil, ou mude a rotação',
        };

        const resumo = grupos.map(([motivo, itens]) => {
            const dica = SUGESTAO[motivo] ? ` — ${SUGESTAO[motivo]}` : '';
            return `\u2022 ${itens.length} \u00d7 ${motivo}${dica}`;
        }).join('\n');

        const max = 6;
        const detalhe = grupos.flatMap(([, itens]) => itens).slice(0, max)
            .map(t => '   \u2013 ' + t).join('\n');
        const resto = conflitos.length > max ? `\n   \u2026 e mais ${conflitos.length - max}` : '';

        alert(`Escala preenchida, com ${conflitos.length} ${conflitos.length === 1 ? 'lugar do horário/rotação por resolver' : 'lugares do horário/rotação por resolver'}:\n\n${resumo}\n\nExemplos:\n${detalhe}${resto}`);
    }
});

// ---- Clear week ----
// ---- Undo toast ----
// Safety net for destructive actions: a banner with a countdown that can put
// everything back. Only one is ever on screen.
let _undoTimer = null;

function showUndoToast(message, onUndo, seconds = 5) {
    document.querySelectorAll('.undo-host').forEach(t => t.remove());
    if (_undoTimer) { clearInterval(_undoTimer); _undoTimer = null; }

    const host = document.createElement('div');
    host.className = 'undo-host';
    const el = document.createElement('div');
    el.className = 'undo-toast';
    el.innerHTML = `
        <span class="undo-icon">🗑️</span>
        <span class="undo-msg">${message}</span>
        <button class="undo-btn" type="button">↩ Desfazer</button>
        <span class="undo-count">${seconds}</span>
        <div class="undo-bar"><div class="undo-bar-fill"></div></div>`;
    host.appendChild(el);
    document.body.appendChild(host);

    // Sit just below the sticky header, whose height differs between phone and desktop.
    const headerH = document.querySelector('header')?.getBoundingClientRect().height || 0;
    host.style.top = `${Math.round(headerH) + 14}px`;

    const fill = el.querySelector('.undo-bar-fill');
    const countEl = el.querySelector('.undo-count');
    // setTimeout, not requestAnimationFrame: rAF is throttled when the page isn't
    // painting (background tab), which would leave the toast stuck off-screen.
    setTimeout(() => {
        el.classList.add('in');
        fill.style.transition = `width ${seconds}s linear`;
        fill.style.width = '0%';
    }, 20);

    let done = false;                       // guards double-click and expiry-after-undo
    function dismiss() {
        if (_undoTimer) { clearInterval(_undoTimer); _undoTimer = null; }
        el.classList.remove('in');
        setTimeout(() => host.remove(), 320);
    }

    // Wall-clock deadline, not a tick count: background tabs throttle timers, which
    // used to leave the button live long after the window should have closed.
    const deadline = Date.now() + seconds * 1000;
    _undoTimer = setInterval(() => {
        const left = Math.ceil((deadline - Date.now()) / 1000);
        countEl.textContent = Math.max(left, 0);
        if (left <= 0) { done = true; dismiss(); }
    }, 250);

    el.querySelector('.undo-btn').addEventListener('click', () => {
        if (done || Date.now() > deadline) { dismiss(); return; }
        done = true;
        dismiss();
        onUndo();
    });
}

document.getElementById('clear-week-btn').addEventListener('click', () => {
    if (!confirm(`Tem a certeza que deseja limpar toda a escala de ${MONTH_NAMES[currentSchedMonth]} ${currentSchedYear}?`)) return;

    // Snapshot every shift before wiping, so the whole month can be restored.
    const clearedMonth = currentSchedMonth, clearedYear = currentSchedYear;
    const backup = [];
    getMonthDates().forEach(date => {
        const sched = getOrCreateScheduleForDate(date);
        SHIFTS.forEach(shift => {
            const sk = shiftKey(date, shift);
            if (sched[sk] && sched[sk].length) backup.push({ date: new Date(date), shift, ids: [...sched[sk]] });
            delete sched[sk];
        });
    });
    save();
    renderSchedule();
    renderHoursSummary();

    const label = `${MONTH_NAMES[clearedMonth]} ${clearedYear}`;
    showUndoToast(
        `Escala de <strong>${label}</strong> limpa — ${backup.length} ${backup.length === 1 ? 'turno' : 'turnos'} removidos.`,
        () => {
            // Only put back shifts that are still empty. If someone (or auto-fill)
            // filled one in the meantime, restoring would silently destroy that work.
            let restored = 0, skipped = 0;
            backup.forEach(b => {
                if (getAssignedForShift(b.date, b.shift).length > 0) { skipped++; return; }
                setAssignedForShift(b.date, b.shift, b.ids);
                restored++;
            });
            if (skipped) {
                alert(`Restaurados ${restored} turnos. ${skipped} não foram repostos porque já tinham sido preenchidos entretanto.`);
            }
            save();
            // Jump back to the restored month so the result is visible
            currentSchedMonth = clearedMonth; currentSchedYear = clearedYear;
            renderSchedule();
            renderHoursSummary();
            renderTerceiros();
            showSaveStatus(`Escala de ${label} restaurada`);
        }
    );
});

// ---- Week navigation ----
function navigateMonth(delta) {
    const grid = document.getElementById('schedule-grid');
    grid.classList.add('cal-fade-out');
    setTimeout(() => {
        currentSchedMonth += delta;
        if (currentSchedMonth < 0) { currentSchedMonth = 11; currentSchedYear--; }
        if (currentSchedMonth > 11) { currentSchedMonth = 0; currentSchedYear++; }
        renderSchedule();
        grid.classList.remove('cal-fade-out');
        grid.classList.add('cal-fade-in');
        setTimeout(() => grid.classList.remove('cal-fade-in'), 200);
    }, 150);
}

// ---- Export Algorithm Rules ----
document.getElementById('export-rules-btn').addEventListener('click', () => {
    const lines = [];
    const L = (s = '') => lines.push(s);
    const H = (s) => { L(); L(s); L('-'.repeat(s.length)); };

    L('REGRAS DO ALGORITMO — ESCALA CHBV');
    L('Gerado em: ' + new Date().toLocaleString('pt-PT'));
    L('');
    L('Cada turno requer 2 médicos | Diurno 08:30–20:30 | Noturno 20:30–08:30 (12h cada)');
    L('Médicos sem limite de horas extra definido nunca recebem turnos flex.');

    H('PRIORIDADES (ordem de atribuição)');
    L('1. Horário Fixo        — atribuído primeiro; indisponibilidade/férias substitui o fixo.');
    L('2. Rotações            — pares A/B alternam semana a semana; sujeito a regras de descanso.');
    L('3. Regras mensais      — "X turnos de Y tipo às Z-feiras"; preenche até atingir o número.');
    L('4. Reposição           — indisponibilidade (não-férias) em dia fixo gera débito a repor no mês.');
    L('5. Tarefeiros          — NÃO entram no auto-preenchimento. Propõem-se aos turnos com falta');
    L('                         de pessoal e só entram na escala quando o admin aceita o pedido.');
    L('6. Turnos 24h          — só médicos com flag "Pode 24h"; só se ambos os slots (D+N) estiverem vazios.');
    L('   Fim-de-semana       — preferência reforçada por 24h ao Sáb/Dom (médicos preferem 24h a 12+12).');
    L('7. Flex (extra)        — preenche restantes: 1º um por slot vazio, 2º completa o 2º, 3º redistribui.');

    H('REGRAS SEMPRE APLICADAS');
    L('Descanso pós-noturno   — após noturno, o médico descansa o dia seguinte inteiro (D+N).');
    L('Conflito seguinte      — não atribui noturno se o médico já tiver turno no dia seguinte.');
    L('Limite horas extra     — nunca excede o limite mensal; turnos fixos/rotação não contam.');
    L('Fim-de-semana          — nenhum médico trabalha sábado E domingo na mesma semana.');

    H('DISPONIBILIDADE');
    L('Disponível   — marcado manualmente; necessário para turnos flex.');
    L('Indisponível — bloqueia o turno; sobrepõe horário fixo; gera débito de reposição.');
    L('Férias       — bloqueia o turno; sobrepõe horário fixo; NÃO gera débito.');
    L('Bloqueado    — definido semanalmente; o médico nunca faz aquele turno naquele dia.');

    H('DESEMPATE (Passagem Flex)');
    L('1º disponibilidade explícita marcada  2º menos horas extra acumuladas no mês.');

    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `regras-algoritmo-chbv-${new Date().toISOString().slice(0,10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
});

document.getElementById('prev-week').addEventListener('click', () => navigateMonth(-1));
document.getElementById('next-week').addEventListener('click', () => navigateMonth(1));

document.getElementById('view-calendar-btn').addEventListener('click', () => {
    scheduleViewMode = 'calendar';
    document.getElementById('view-calendar-btn').classList.add('active');
    document.getElementById('view-list-btn').classList.remove('active');
    renderSchedule();
});
document.getElementById('view-list-btn').addEventListener('click', () => {
    scheduleViewMode = 'list';
    document.getElementById('view-list-btn').classList.add('active');
    document.getElementById('view-calendar-btn').classList.remove('active');
    renderSchedule();
});

// ---- Doctors Rendering ----
function renderDoctors() {
    const list = document.getElementById('doctors-list');

    if (doctors.length === 0) {
        list.innerHTML = `<div class="empty-state">
            <div class="empty-icon">👨‍⚕️</div>
            <p>Nenhum médico registado.<br>Clique em "Adicionar Médico" para começar.</p>
        </div>`;
        return;
    }

    const now = new Date();
    const curMonth = now.getMonth();
    const curYear = now.getFullYear();

    let html = '';
    doctors.forEach(doc => {
        // Determine badges
        const hasFixedWeekly = (doc.fixedSchedule && Object.keys(doc.fixedSchedule).length > 0) ||
            (doc.fixedBlocked && Object.keys(doc.fixedBlocked).length > 0);
        const hasFixedMonthly = doc.fixedMonthly && doc.fixedMonthlyData && Object.keys(doc.fixedMonthlyData).length > 0;
        const hasFixed = hasFixedWeekly || hasFixedMonthly;
        const hasAvail = doc.monthlyAvailability && Object.keys(doc.monthlyAvailability).length > 0;
        const hasUnavail = doc.monthlyUnavailability && Object.keys(doc.monthlyUnavailability).length > 0;
        const hasVacation = doc.monthlyVacation && Object.keys(doc.monthlyVacation).length > 0;
        const hasMonthly = hasAvail || hasUnavail || hasVacation;

        let badgesHtml = '';
        if (hasFixed) {
            if (hasFixedMonthly) {
                badgesHtml += '<span class="badge badge-fixed">Fixo Mensal</span> ';
            } else {
                badgesHtml += '<span class="badge badge-fixed">Fixo</span> ';
            }
        }
        if (hasMonthly) badgesHtml += '<span class="badge badge-flexible">Flexível</span>';
        if (!hasFixed && !hasMonthly) badgesHtml += '<span class="badge badge-flexible">Flexível</span>';

        // Hours info - extra hours
        const extraLimit = doc.monthlyHoursLimit || 0;
        const fixedHrs = getMonthlyFixedHours(doc.id, curYear, curMonth);
        const extraUsed = getMonthlyExtraHours(doc.id, curYear, curMonth);
        const pct = extraLimit > 0 ? Math.min(100, Math.round((extraUsed / extraLimit) * 100)) : (extraUsed > 0 ? 100 : 0);
        const cls = extraUsed > extraLimit ? 'over' : pct > 80 ? 'warn' : 'ok';
        let hoursHtml = `<div class="hours-info">
            <span>Fixo: ${fixedHrs}h | Extra: ${extraUsed}h / ${extraLimit}h (${MONTH_NAMES[curMonth]})</span>
            <div class="hours-bar"><div class="hours-bar-fill ${cls}" style="width:${Math.min(pct, 100)}%"></div></div>
        </div>`;

        // Fixed schedule mini-grid
        let fixedHtml = '';
        if (hasFixedMonthly) {
            // Count fixed shifts this month
            const fmd = doc.fixedMonthlyData || {};
            const daysInMonthFixed = new Date(curYear, curMonth + 1, 0).getDate();
            let fixedDayCount = 0;
            let fixedNightCount = 0;
            for (let d = 1; d <= daysInMonthFixed; d++) {
                const dt = new Date(curYear, curMonth, d);
                const dk = dateKey(dt);
                if (fmd[dk]) {
                    if (fmd[dk].day) fixedDayCount++;
                    if (fmd[dk].night) fixedNightCount++;
                }
            }
            fixedHtml = `<div class="card-section-label">Horário Fixo — ${MONTH_NAMES[curMonth]}</div>
                <div class="avail-summary">${fixedDayCount} turnos diurnos + ${fixedNightCount} turnos noturnos fixos</div>`;
        } else if (hasFixedWeekly) {
            fixedHtml += `<div class="card-section-label">Horário Fixo Semanal</div><div class="availability-mini">`;
            DAYS.forEach(d => fixedHtml += `<div class="avail-day">${d}</div>`);
            SHIFTS.forEach(shift => {
                DAYS.forEach((d, dayIdx) => {
                    const key = `${dayIdx}_${shift}`;
                    const isWorks = doc.fixedSchedule && doc.fixedSchedule[key];
                    const isBlocked = doc.fixedBlocked && doc.fixedBlocked[key];
                    const cls = isWorks ? 'fixed-shift' : (isBlocked ? 'blocked-shift' : '');
                    fixedHtml += `<div class="avail-cell ${cls}" title="${DAYS_FULL[dayIdx]} ${SHIFT_LABELS[shift]}"></div>`;
                });
            });
            fixedHtml += '</div>';
        }

        // Monthly availability summary
        let flexSummary = '';
        const daysInMonth = new Date(curYear, curMonth + 1, 0).getDate();
        let availCount = 0;
        for (let d = 1; d <= daysInMonth; d++) {
            const dt = new Date(curYear, curMonth, d);
            if (isFlexAvailableOnDate(doc, dt, 'day') || isFlexAvailableOnDate(doc, dt, 'night')) {
                availCount++;
            }
        }
        flexSummary = `<div class="avail-summary">Flex ${MONTH_NAMES[curMonth]}: ${availCount} dias disponíveis</div>`;

        // Day-of-week rules summary (apply to all months)
        let rulesSummary = '';
        const curRules = getDoctorRules(doc);
        if (curRules.length > 0) {
            const parts = curRules.map(r => {
                const shiftLabel = r.shiftType === '24h' ? '24h' : r.shiftType === 'day' ? 'D' : 'N';
                return `${r.count}× ${DAYS[r.dayOfWeek]} ${shiftLabel}`;
            });
            rulesSummary = `<div class="rule-summary">Regras: ${parts.join(' + ')}</div>`;
        }

        html += `<div class="doctor-card">
            <div class="doctor-card-header">
                <div>
                    <h3>${esc(doc.name)}</h3>
                    <span class="specialty">${doc.specialty || '—'}</span>
                </div>
                <div>${badgesHtml}</div>
            </div>
            <div class="info-row">
                ${doc.phone ? `<span>📞 ${doc.phone}</span>` : ''}
                ${doc.email ? `<span>✉ ${doc.email}</span>` : ''}
            </div>
            ${hoursHtml}
            ${fixedHtml}
            ${rulesSummary}
            ${flexSummary}
            <div class="card-actions write-only">
                <button class="btn btn-sm" onclick="editDoctor('${doc.id}')">Editar</button>
                <button class="btn btn-sm btn-danger" onclick="deleteDoctor('${doc.id}')">Eliminar</button>
            </div>
        </div>`;
    });

    list.innerHTML = html;
}

// ---- Doctor Modal ----
const doctorModal = document.getElementById('doctor-modal');
const doctorForm = document.getElementById('doctor-form');

function buildFixedGrid(containerId, worksData, blockedData) {
    const container = document.getElementById(containerId);
    let html = '<div class="ag-header"></div>';
    DAYS.forEach(d => html += `<div class="ag-header">${d}</div>`);

    SHIFTS.forEach(shift => {
        html += `<div class="ag-label">${SHIFT_LABELS[shift]}</div>`;
        for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
            const key = `${dayIdx}_${shift}`;
            const isWorks = worksData && worksData[key];
            const isBlocked = blockedData && blockedData[key];
            const cls = isWorks ? 'works' : (isBlocked ? 'blocked' : '');
            html += `<div class="ag-cell ${cls}" data-key="${key}"></div>`;
        }
    });

    container.innerHTML = html;
    container.querySelectorAll('.ag-cell').forEach(cell => {
        cell.addEventListener('click', () => {
            const key = cell.dataset.key;
            if (modalFixedWeeklyMode === 'works') {
                if (cell.classList.contains('works')) {
                    cell.classList.remove('works');
                } else {
                    cell.classList.remove('blocked');
                    cell.classList.add('works');
                }
            } else {
                if (cell.classList.contains('blocked')) {
                    cell.classList.remove('blocked');
                } else {
                    cell.classList.remove('works');
                    cell.classList.add('blocked');
                }
            }
        });
    });
}

function getFixedGridData(containerId) {
    const cells = document.querySelectorAll(`#${containerId} .ag-cell`);
    const works = {};
    const blocked = {};
    cells.forEach(cell => {
        if (cell.classList.contains('works')) {
            works[cell.dataset.key] = true;
        } else if (cell.classList.contains('blocked')) {
            blocked[cell.dataset.key] = true;
        }
    });
    return { works, blocked };
}

// Monthly calendar
function getShiftDotClass(dk, shift) {
    const avail = modalAvailData[dk] && modalAvailData[dk][shift];
    const unavail = modalUnavailData[dk] && modalUnavailData[dk][shift];
    const vacation = modalVacationData[dk] && modalVacationData[dk][shift];
    if (vacation) return 'avail-vacation';
    if (unavail) return 'avail-no';
    if (avail) return 'avail-yes';
    return '';
}

function renderMonthlyCalendar() {
    const container = document.getElementById('monthly-calendar');
    const label = document.getElementById('avail-month-label');
    label.textContent = `${MONTH_NAMES[modalAvailMonth]} ${modalAvailYear}`;

    const firstDay = new Date(modalAvailYear, modalAvailMonth, 1);
    const daysInMonth = new Date(modalAvailYear, modalAvailMonth + 1, 0).getDate();
    let startDow = (firstDay.getDay() + 6) % 7;

    let html = '';
    ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'].forEach(d => {
        html += `<div class="cal-header">${d}</div>`;
    });

    for (let i = 0; i < startDow; i++) {
        html += '<div class="cal-day empty"></div>';
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (let d = 1; d <= daysInMonth; d++) {
        const dt = new Date(modalAvailYear, modalAvailMonth, d);
        const dk = dateKey(dt);
        const dow = (dt.getDay() + 6) % 7;
        const isWeekend = dow >= 5;
        const isPast = dt < today;

        const dayCls = getShiftDotClass(dk, 'day');
        const nightCls = getShiftDotClass(dk, 'night');

        html += `<div class="cal-day ${isWeekend ? 'weekend' : ''} ${isPast ? 'past' : ''}" data-date="${dk}">
            <div class="day-num">${d}</div>
            <div class="day-shifts">
                <div class="shift-dot day-dot ${dayCls}" data-date="${dk}" data-shift="day" title="Diurno">D</div>
                <div class="shift-dot night-dot ${nightCls}" data-date="${dk}" data-shift="night" title="Noturno">N</div>
            </div>
        </div>`;
    }

    container.innerHTML = html;

    // Helper: get the active store for current mode
    function getActiveStore() {
        if (modalAvailMode === 'available') return modalAvailData;
        if (modalAvailMode === 'unavailable') return modalUnavailData;
        return modalVacationData;
    }

    // Helper: clear a shift from all OTHER stores (not the active one)
    function clearConflicts(dk, shift) {
        const stores = [modalAvailData, modalUnavailData, modalVacationData];
        const active = getActiveStore();
        stores.forEach(store => {
            if (store === active) return;
            if (store[dk]) {
                delete store[dk][shift];
                if (!store[dk].day && !store[dk].night) delete store[dk];
            }
        });
    }

    function clearAllConflicts(dk) {
        const stores = [modalAvailData, modalUnavailData, modalVacationData];
        const active = getActiveStore();
        stores.forEach(store => {
            if (store === active) return;
            delete store[dk];
        });
    }

    container.querySelectorAll('.shift-dot').forEach(dot => {
        dot.addEventListener('click', (e) => {
            e.stopPropagation();
            const dk = dot.dataset.date;
            const shift = dot.dataset.shift;
            const store = getActiveStore();
            if (!store[dk]) store[dk] = {};
            if (store[dk][shift]) {
                delete store[dk][shift];
                if (!store[dk].day && !store[dk].night) delete store[dk];
            } else {
                store[dk][shift] = true;
                clearConflicts(dk, shift);
            }
            renderMonthlyCalendar();
        });
    });

    container.querySelectorAll('.cal-day:not(.empty)').forEach(cell => {
        cell.addEventListener('click', (e) => {
            if (e.target.classList.contains('shift-dot')) return;
            const dk = cell.dataset.date;
            const store = getActiveStore();
            const d = store[dk] || {};
            if (d.day && d.night) {
                delete store[dk];
            } else {
                store[dk] = { day: true, night: true };
                clearAllConflicts(dk);
            }
            renderMonthlyCalendar();
        });
    });

    const hint = document.getElementById('avail-mode-hint');
    const legend = '<span style="color:#27ae60">●</span> pode, <span style="color:#e74c3c">●</span> não pode, <span style="color:#f39c12">●</span> férias';
    if (modalAvailMode === 'available') {
        hint.innerHTML = `Clique nos dias em que o médico <strong>pode</strong> trabalhar. ${legend}`;
    } else if (modalAvailMode === 'unavailable') {
        hint.innerHTML = `Clique nos dias em que o médico <strong>NÃO pode</strong> trabalhar. ${legend}`;
    } else {
        hint.innerHTML = `Clique nos dias de <strong>férias</strong> do médico. ${legend}`;
    }
}

// Month navigation
document.getElementById('avail-prev-month').addEventListener('click', () => {
    modalAvailMonth--;
    if (modalAvailMonth < 0) { modalAvailMonth = 11; modalAvailYear--; }
    renderMonthlyCalendar();
});

document.getElementById('avail-next-month').addEventListener('click', () => {
    modalAvailMonth++;
    if (modalAvailMonth > 11) { modalAvailMonth = 0; modalAvailYear++; }
    renderMonthlyCalendar();
});

// Mode toggle
document.querySelectorAll('.avail-mode-toggle:not(.fixed-mode-toggle) .mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.avail-mode-toggle:not(.fixed-mode-toggle) .mode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        modalAvailMode = btn.dataset.mode;
        renderMonthlyCalendar();
    });
});

// Fixed weekly mode toggle (works / blocked)
document.querySelectorAll('.fixed-mode-toggle .mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.fixed-mode-toggle .mode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        modalFixedWeeklyMode = btn.dataset.mode;
        const hint = document.getElementById('fixed-mode-hint');
        hint.innerHTML = modalFixedWeeklyMode === 'works'
            ? 'Selecione os turnos fixos que repetem todas as semanas. <span style="color:#2980b9">■</span> = faz, <span style="color:#e74c3c">■</span> = bloqueado.'
            : 'Selecione os turnos em que o médico <strong>nunca pode</strong> trabalhar. <span style="color:#2980b9">■</span> = faz, <span style="color:#e74c3c">■</span> = bloqueado.';
    });
});

// Fixed monthly toggle
const fixedMonthlyToggle = document.getElementById('fixed-monthly-toggle');
fixedMonthlyToggle.addEventListener('change', () => {
    document.getElementById('fixed-weekly-section').classList.toggle('hidden', fixedMonthlyToggle.checked);
    document.getElementById('fixed-monthly-section').classList.toggle('hidden', !fixedMonthlyToggle.checked);
    if (fixedMonthlyToggle.checked) renderFixedMonthlyCalendar();
});

function setFixedMonthlyMode(isMonthly) {
    fixedMonthlyToggle.checked = isMonthly;
    document.getElementById('fixed-weekly-section').classList.toggle('hidden', isMonthly);
    document.getElementById('fixed-monthly-section').classList.toggle('hidden', !isMonthly);
}

// Fixed monthly calendar rendering
function renderFixedMonthlyCalendar() {
    const container = document.getElementById('fixed-monthly-calendar');
    const label = document.getElementById('fixed-month-label');
    label.textContent = `${MONTH_NAMES[modalFixedMonth]} ${modalFixedYear}`;

    const firstDay = new Date(modalFixedYear, modalFixedMonth, 1);
    const daysInMonth = new Date(modalFixedYear, modalFixedMonth + 1, 0).getDate();
    let startDow = (firstDay.getDay() + 6) % 7;

    let html = '';
    ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'].forEach(d => {
        html += `<div class="cal-header">${d}</div>`;
    });

    for (let i = 0; i < startDow; i++) {
        html += '<div class="cal-day empty"></div>';
    }

    for (let d = 1; d <= daysInMonth; d++) {
        const dt = new Date(modalFixedYear, modalFixedMonth, d);
        const dk = dateKey(dt);
        const dow = (dt.getDay() + 6) % 7;
        const isWeekend = dow >= 5;

        const dayData = modalFixedMonthlyData[dk] || {};
        const dayActive = !!dayData.day;
        const nightActive = !!dayData.night;

        html += `<div class="cal-day ${isWeekend ? 'weekend' : ''}" data-date="${dk}">
            <div class="day-num">${d}</div>
            <div class="day-shifts">
                <div class="shift-dot day-dot ${dayActive ? 'active' : ''}" data-date="${dk}" data-shift="day" title="Diurno">D</div>
                <div class="shift-dot night-dot ${nightActive ? 'active' : ''}" data-date="${dk}" data-shift="night" title="Noturno">N</div>
            </div>
        </div>`;
    }

    container.innerHTML = html;

    container.querySelectorAll('.shift-dot').forEach(dot => {
        dot.addEventListener('click', (e) => {
            e.stopPropagation();
            const dk = dot.dataset.date;
            const shift = dot.dataset.shift;
            if (!modalFixedMonthlyData[dk]) modalFixedMonthlyData[dk] = {};
            modalFixedMonthlyData[dk][shift] = !modalFixedMonthlyData[dk][shift];
            if (!modalFixedMonthlyData[dk].day && !modalFixedMonthlyData[dk].night) {
                delete modalFixedMonthlyData[dk];
            }
            dot.classList.toggle('active');
        });
    });

    container.querySelectorAll('.cal-day:not(.empty)').forEach(cell => {
        cell.addEventListener('click', (e) => {
            if (e.target.classList.contains('shift-dot')) return;
            const dk = cell.dataset.date;
            const dayData = modalFixedMonthlyData[dk] || {};
            const allActive = dayData.day && dayData.night;
            if (allActive) {
                delete modalFixedMonthlyData[dk];
            } else {
                modalFixedMonthlyData[dk] = { day: true, night: true };
            }
            renderFixedMonthlyCalendar();
        });
    });
}

document.getElementById('fixed-prev-month').addEventListener('click', () => {
    modalFixedMonth--;
    if (modalFixedMonth < 0) { modalFixedMonth = 11; modalFixedYear--; }
    renderFixedMonthlyCalendar();
});

document.getElementById('fixed-next-month').addEventListener('click', () => {
    modalFixedMonth++;
    if (modalFixedMonth > 11) { modalFixedMonth = 0; modalFixedYear++; }
    renderFixedMonthlyCalendar();
});

// ---- Day-of-Week Rules (apply to all months) ----
function renderRulesSection() {
    const container = document.getElementById('rules-list');

    if (modalRulesData.length === 0) {
        container.innerHTML = '<div class="rules-list-empty">Nenhuma regra. Clique "+ Regra" para adicionar.</div>';
        return;
    }

    let html = '';
    modalRulesData.forEach((rule, idx) => {
        html += `<div class="rule-row" data-idx="${idx}">
            <select class="rule-dow" data-idx="${idx}">
                ${DAYS_FULL.map((d, i) => `<option value="${i}" ${i === rule.dayOfWeek ? 'selected' : ''}>${d}</option>`).join('')}
            </select>
            <span class="rule-x">×</span>
            <input type="number" class="rule-count" data-idx="${idx}" min="1" max="5" value="${rule.count}">
            <select class="rule-shift" data-idx="${idx}">
                <option value="day" ${rule.shiftType === 'day' ? 'selected' : ''}>Diurno (D)</option>
                <option value="night" ${rule.shiftType === 'night' ? 'selected' : ''}>Noturno (N)</option>
                <option value="24h" ${rule.shiftType === '24h' ? 'selected' : ''}>24h (D+N)</option>
            </select>
            <button type="button" class="rule-delete" data-idx="${idx}">&times;</button>
        </div>`;
    });
    container.innerHTML = html;

    container.querySelectorAll('.rule-dow').forEach(sel => {
        sel.addEventListener('change', () => {
            modalRulesData[parseInt(sel.dataset.idx)].dayOfWeek = parseInt(sel.value);
        });
    });
    container.querySelectorAll('.rule-count').forEach(inp => {
        inp.addEventListener('change', () => {
            modalRulesData[parseInt(inp.dataset.idx)].count = parseInt(inp.value) || 1;
        });
    });
    container.querySelectorAll('.rule-shift').forEach(sel => {
        sel.addEventListener('change', () => {
            modalRulesData[parseInt(sel.dataset.idx)].shiftType = sel.value;
        });
    });
    container.querySelectorAll('.rule-delete').forEach(btn => {
        btn.addEventListener('click', () => {
            modalRulesData.splice(parseInt(btn.dataset.idx), 1);
            renderRulesSection();
        });
    });
}

document.getElementById('add-rule-btn').addEventListener('click', () => {
    modalRulesData.push({ dayOfWeek: 3, shiftType: '24h', count: 1 }); // default: Quinta, 24h, 1x
    renderRulesSection();
});

// Count how many times a doctor is already assigned on a specific day-of-week + shiftType in a month
function countMonthlyDowAssignments(docId, year, month, dayOfWeek, shiftType, exclude24h = false) {
    let count = 0;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    for (let d = 1; d <= daysInMonth; d++) {
        const dt = new Date(year, month, d);
        if ((dt.getDay() + 6) % 7 !== dayOfWeek) continue;

        const wk = weekKey(getMonday(dt));
        const weekSched = schedules[wk];
        if (!weekSched) continue;

        if (shiftType === '24h') {
            const skDay = shiftKey(dt, 'day');
            const skNight = shiftKey(dt, 'night');
            const hasDay = weekSched[skDay] && weekSched[skDay].includes(docId);
            const hasNight = weekSched[skNight] && weekSched[skNight].includes(docId);
            if (hasDay && hasNight) count++;
        } else {
            const sk = shiftKey(dt, shiftType);
            if (weekSched[sk] && weekSched[sk].includes(docId)) {
                if (exclude24h) {
                    // Only count if NOT part of a 24h shift (doctor on both day+night)
                    const otherShift = shiftType === 'night' ? 'day' : 'night';
                    const skOther = shiftKey(dt, otherShift);
                    const hasOther = weekSched[skOther] && weekSched[skOther].includes(docId);
                    if (!hasOther) count++;
                } else {
                    count++;
                }
            }
        }
    }
    return count;
}

// Add doctor
document.getElementById('add-doctor-btn').addEventListener('click', () => {
    document.getElementById('modal-title').textContent = 'Adicionar Médico';
    doctorForm.reset();
    document.getElementById('doctor-id').value = '';
    document.getElementById('doctor-hours-limit').value = '';
    document.getElementById('doctor-can24h').checked = true;
    setFixedMonthlyMode(false);
    modalFixedWeeklyMode = 'works';
    modalFixedBlockedData = {};
    buildFixedGrid('fixed-schedule-grid', {}, {});
    document.querySelectorAll('.fixed-mode-toggle .mode-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.mode === 'works');
    });
    document.getElementById('fixed-mode-hint').innerHTML = 'Selecione os turnos fixos que repetem todas as semanas. <span style="color:#2980b9">■</span> = faz, <span style="color:#e74c3c">■</span> = bloqueado.';
    modalFixedMonthlyData = {};
    modalFixedMonth = new Date().getMonth();
    modalFixedYear = new Date().getFullYear();
    modalAvailData = {};
    modalUnavailData = {};
    modalVacationData = {};
    modalAvailMode = 'available';
    modalAvailMonth = new Date().getMonth();
    modalAvailYear = new Date().getFullYear();
    document.querySelectorAll('.avail-mode-toggle:not(.fixed-mode-toggle) .mode-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.mode === 'available');
    });
    modalRulesData = [];
    renderRulesSection();
    renderMonthlyCalendar();
    document.getElementById('doctor-rotation-section').classList.add('hidden');
    doctorModal.classList.add('open');
});

// Edit doctor
window.editDoctor = function(id) {
    const doc = doctors.find(d => d.id === id);
    if (!doc) return;
    document.getElementById('modal-title').textContent = 'Editar Médico';
    document.getElementById('doctor-id').value = doc.id;
    document.getElementById('doctor-name').value = doc.name;
    document.getElementById('doctor-specialty').value = doc.specialty || '';
    document.getElementById('doctor-phone').value = doc.phone || '';
    document.getElementById('doctor-email').value = doc.email || '';
    document.getElementById('doctor-hours-limit').value = doc.monthlyHoursLimit || '';
    document.getElementById('doctor-can24h').checked = doc.can24h === true;

    const isMonthly = !!doc.fixedMonthly;
    setFixedMonthlyMode(isMonthly);
    modalFixedWeeklyMode = 'works'; // always start in works mode for clarity
    modalFixedBlockedData = JSON.parse(JSON.stringify(doc.fixedBlocked || {}));
    buildFixedGrid('fixed-schedule-grid', doc.fixedSchedule || {}, doc.fixedBlocked || {});
    document.querySelectorAll('.fixed-mode-toggle .mode-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.mode === modalFixedWeeklyMode);
    });
    document.getElementById('fixed-mode-hint').innerHTML =
        'Selecione os turnos fixos que repetem todas as semanas. <span style="color:#2980b9">■</span> = faz, <span style="color:#e74c3c">■</span> = bloqueado.';
    modalFixedMonthlyData = JSON.parse(JSON.stringify(doc.fixedMonthlyData || {}));
    modalFixedMonth = new Date().getMonth();
    modalFixedYear = new Date().getFullYear();
    if (isMonthly) renderFixedMonthlyCalendar();

    modalRulesData = JSON.parse(JSON.stringify(getDoctorRules(doc)));
    renderRulesSection();

    modalAvailData = JSON.parse(JSON.stringify(doc.monthlyAvailability || {}));
    modalUnavailData = JSON.parse(JSON.stringify(doc.monthlyUnavailability || {}));
    modalVacationData = JSON.parse(JSON.stringify(doc.monthlyVacation || {}));
    modalAvailMode = doc.availMode || 'available';
    modalAvailMonth = new Date().getMonth();
    modalAvailYear = new Date().getFullYear();
    document.querySelectorAll('.avail-mode-toggle:not(.fixed-mode-toggle) .mode-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.mode === modalAvailMode);
    });
    renderMonthlyCalendar();
    renderDoctorRotationView(doc.id);
    doctorModal.classList.add('open');
};

// Delete doctor
window.deleteDoctor = function(id) {
    const doc = doctors.find(d => d.id === id);
    if (!doc) return;
    if (!confirm(`Eliminar ${doc.name}?`)) return;
    doctors = doctors.filter(d => d.id !== id);
    Object.keys(schedules).forEach(wk => {
        Object.keys(schedules[wk]).forEach(sk => {
            schedules[wk][sk] = schedules[wk][sk].filter(did => did !== id);
        });
    });
    // Remove the doctor from every cell/week of the rotation grid.
    Object.keys(rotationGrid.cells).forEach(key => {
        rotationGrid.cells[key] = rotationGrid.cells[key].map(w => w.filter(d => d !== id));
    });
    save();
    renderDoctors();
    renderRotations();
    renderSchedule();
};

// Save doctor
doctorForm.addEventListener('submit', e => {
    e.preventDefault();
    const id = document.getElementById('doctor-id').value || generateId();
    const hoursLimit = document.getElementById('doctor-hours-limit').value;
    const isFixedMonthly = fixedMonthlyToggle.checked;
    const gridData = isFixedMonthly ? { works: {}, blocked: {} } : getFixedGridData('fixed-schedule-grid');

    const docData = {
        id,
        name: document.getElementById('doctor-name').value.trim(),
        specialty: document.getElementById('doctor-specialty').value.trim(),
        phone: document.getElementById('doctor-phone').value.trim(),
        email: document.getElementById('doctor-email').value.trim(),
        monthlyHoursLimit: hoursLimit ? parseInt(hoursLimit) : null,
        can24h: document.getElementById('doctor-can24h').checked,
        fixedMonthly: isFixedMonthly,
        fixedSchedule: gridData.works,
        fixedBlocked: gridData.blocked,
        fixedMonthlyData: isFixedMonthly ? { ...modalFixedMonthlyData } : {},
        monthlyDayRules: [...modalRulesData],
        monthlyAvailability: { ...modalAvailData },
        monthlyUnavailability: { ...modalUnavailData },
        monthlyVacation: { ...modalVacationData },
        availMode: modalAvailMode,
    };

    const idx = doctors.findIndex(d => d.id === id);
    if (idx >= 0) {
        doctors[idx] = docData;
    } else {
        doctors.push(docData);
    }

    save();
    renderDoctors();
    renderSchedule();
    doctorModal.classList.remove('open');
});

// Close modals
[document.getElementById('modal-close'), document.getElementById('modal-cancel')].forEach(el => {
    el.addEventListener('click', () => doctorModal.classList.remove('open'));
});

document.getElementById('assign-close').addEventListener('click', () => {
    document.getElementById('assign-modal').classList.remove('open');
});

[doctorModal, document.getElementById('assign-modal')].forEach(overlay => {
    overlay.addEventListener('click', e => {
        if (e.target === overlay) overlay.classList.remove('open');
    });
});

// ---- Terceiros Rendering ----
// ---- Tarefeiro: escolha de vagas (furos) ----

// A month counts as "scheduled" once it has at least one assignment. A completely
// empty month just means the escala hasn't been made yet, so its empty shifts are
// NOT offered as vagas (otherwise a whole unscheduled month looks like 62 openings).
function monthHasSchedule(year, month) {
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    for (let d = 1; d <= daysInMonth; d++) {
        const dt = new Date(year, month, d);
        for (const s of SHIFTS) {
            if (getAssignedForShift(dt, s).length > 0) return true;
        }
    }
    return false;
}

// Every shift this tarefeiro may volunteer for: today onwards, in months whose
// schedule has been started, that still have a free slot — plus any shift they
// already marked, so it stays visible (and removable) even once it fills up.
function getTarefeiroVagas(terc, monthsAhead = 6) {
    const avail = terc.monthlyAvailability || {};
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const out = [];
    for (let i = 0; i < monthsAhead; i++) {
        const cur = new Date(today.getFullYear(), today.getMonth() + i, 1);
        const yy = cur.getFullYear(), mm = cur.getMonth();
        const scheduled = monthHasSchedule(yy, mm);
        const daysInMonth = new Date(yy, mm + 1, 0).getDate();
        for (let d = 1; d <= daysInMonth; d++) {
            const dt = new Date(yy, mm, d);
            if (dt < today) continue;
            const dk = dateKey(dt);
            SHIFTS.forEach(shift => {
                const marked = !!(avail[dk] && avail[dk][shift]);
                const assignedArr = getAssignedForShift(dt, shift);
                const free = DOCTORS_PER_SHIFT - assignedArr.length;
                const assigned = assignedArr.includes(terc.id);
                // Offer real gaps in started months; always keep own marks AND shifts
                // they're actually scheduled for (an admin can roster them directly,
                // which leaves no mark — they must still see it).
                if (!marked && !assigned && !(scheduled && free > 0)) return;
                out.push({ date: dt, dk, shift, free, marked, assigned });
            });
        }
    }
    return out;
}

// What this tarefeiro's relationship to one shift is.
//   confirmed = admin put them on the schedule · pending = offered, awaiting decision
//   lost = they offered but it filled up · open = free slot they can offer for
//   full = no room and they never offered
function tarefeiroShiftState(terc, date, shift) {
    const dk = dateKey(date);
    const avail = terc.monthlyAvailability || {};
    const marked = !!(avail[dk] && avail[dk][shift]);
    const assigned = getAssignedForShift(date, shift);
    const free = DOCTORS_PER_SHIFT - assigned.length;
    if (assigned.includes(terc.id)) return { state: 'confirmed', free, marked };
    if (marked && free <= 0)        return { state: 'lost', free, marked };
    if (marked)                     return { state: 'pending', free, marked };
    if (free > 0)                   return { state: 'open', free, marked };
    return { state: 'full', free, marked };
}

// Which tab the tarefeiro is looking at: open shifts, or their own.
let tercViewFilter = 'open';
window.setTercFilter = function(f) {
    tercViewFilter = f;
    renderTerceiros();
};

// One card per DAY holding both shifts — half the scrolling of a flat list,
// and the whole day is readable at a glance.
function renderTarefeiroVagas(terc) {
    const vagas = getTarefeiroVagas(terc);

    // Collapse the flat vaga list into unique days, then resolve both shifts per day.
    const dayMap = new Map();
    vagas.forEach(v => {
        const k = dateKey(v.date);
        if (!dayMap.has(k)) dayMap.set(k, v.date);
    });
    const days = [...dayMap.values()].sort((a, b) => a - b).map(date => ({
        date,
        shifts: SHIFTS.map(shift => ({ shift, ...tarefeiroShiftState(terc, date, shift) })),
    }));

    // Counters for the summary chips
    let nConfirmed = 0, nPending = 0, nOpen = 0;
    days.forEach(d => d.shifts.forEach(s => {
        if (s.state === 'confirmed') nConfirmed++;
        else if (s.state === 'pending') nPending++;
        else if (s.state === 'open') nOpen++;
    }));
    const nMine = nConfirmed + nPending;

    const firstName = (terc.name || '').split(' ')[0];
    const greeting = /a$/i.test(firstName) ? 'Bem-vinda' : 'Bem-vindo';

    let html = `<div class="tf-wrap">
        <div class="tf-hero">
            <div class="tf-hello">${greeting}, <strong>${firstName}</strong> 👋</div>
            <div class="tf-stats">
                <div class="tf-stat ${nConfirmed ? 'lit' : ''}"><span class="tf-n">${nConfirmed}</span><span class="tf-l">Escalado</span></div>
                <div class="tf-stat ${nPending ? 'lit' : ''}"><span class="tf-n">${nPending}</span><span class="tf-l">À espera</span></div>
                <div class="tf-stat ${nOpen ? 'lit' : ''}"><span class="tf-n">${nOpen}</span><span class="tf-l">Por preencher</span></div>
            </div>
        </div>`;

    if (days.length === 0) {
        html += `<div class="tf-empty">
            <div class="tf-empty-icon">🎉</div>
            <h4>Está tudo preenchido</h4>
            <p>Não há turnos a precisar de gente neste momento.<br>Quando houver, aparecem aqui — não precisa de fazer nada.</p>
        </div></div>`;
        return html;
    }

    html += `<div class="tf-tabs">
        <button class="tf-tab ${tercViewFilter === 'open' ? 'active' : ''}" onclick="setTercFilter('open')">
            Por preencher${nOpen ? ` <span class="tf-tab-n">${nOpen}</span>` : ''}
        </button>
        <button class="tf-tab ${tercViewFilter === 'mine' ? 'active' : ''}" onclick="setTercFilter('mine')">
            Os meus turnos${nMine ? ` <span class="tf-tab-n">${nMine}</span>` : ''}
        </button>
    </div>`;

    // Keep 'pending' visible in the open tab too, so a day doesn't vanish the moment
    // you pick it — you get instant confirmation and can still undo.
    const wanted = tercViewFilter === 'mine'
        ? d => d.shifts.some(s => ['confirmed', 'pending', 'lost'].includes(s.state))
        : d => d.shifts.some(s => s.state === 'open' || s.state === 'pending');
    const shown = days.filter(wanted);

    if (shown.length === 0) {
        html += `<div class="tf-empty small">
            <div class="tf-empty-icon">${tercViewFilter === 'mine' ? '🗓️' : '✅'}</div>
            <p>${tercViewFilter === 'mine'
                ? 'Ainda não escolheu nenhum turno.<br>Veja os turnos <strong>por preencher</strong>.'
                : 'Não há turnos por preencher.'}</p>
        </div>`;
    } else {
        html += `<p class="tf-help">${tercViewFilter === 'mine'
            ? 'Verde = confirmado pelo hospital. Amarelo = ainda à espera de resposta.'
            : 'Toque num turno para se propor. O hospital confirma depois quem fica com ele.'}</p>`;

        let lastMonth = null;
        shown.forEach(d => {
            const mk = `${d.date.getFullYear()}-${d.date.getMonth()}`;
            if (mk !== lastMonth) {
                lastMonth = mk;
                html += `<div class="tf-month">${MONTH_NAMES[d.date.getMonth()]} ${d.date.getFullYear()}</div>`;
            }
            const dow = (d.date.getDay() + 6) % 7;
            html += `<div class="tf-day ${dow >= 5 ? 'weekend' : ''}">
                <div class="tf-date">
                    <span class="tf-dow">${DAYS[dow]}</span>
                    <span class="tf-dnum">${d.date.getDate()}</span>
                </div>
                <div class="tf-chips">`;

            d.shifts.forEach(s => {
                const isNight = s.shift === 'night';
                const icon = isNight ? '🌙' : '☀️';
                const name = isNight ? 'Noite' : 'Dia';
                const sub = {
                    confirmed: 'Vai trabalhar',
                    pending: 'À espera',
                    lost: 'Foi para outro',
                    open: s.free === 1 ? '1 vaga' : `${Math.max(s.free, 0)} vagas`,
                    full: 'Completo',
                }[s.state];
                const clickable = s.state !== 'confirmed' && s.state !== 'full';
                html += `<button class="tf-chip ${s.state}" ${clickable ? '' : 'disabled'}
                    ${clickable ? `onclick="toggleVaga('${dateKey(d.date)}','${s.shift}')"` : ''}
                    title="${SHIFT_LABELS[s.shift]} ${SHIFT_TIMES[s.shift]}">
                    <span class="tf-chip-name">${icon} ${name}</span>
                    <span class="tf-chip-sub">${sub}</span>
                    ${s.state === 'confirmed' ? '<span class="tf-chip-lock">🔒</span>' : ''}
                    ${s.state === 'pending' ? '<span class="tf-chip-lock">✓</span>' : ''}
                </button>`;
            });

            html += `</div></div>`;
        });
    }

    html += `</div>`;
    return html;
}

// Toggle one vaga for the logged-in tarefeiro and save immediately.
window.toggleVaga = function(dk, shift) {
    const t = terceiros.find(x => x.id === currentTerceiroId);
    if (!t) return;
    if (!t.monthlyAvailability) t.monthlyAvailability = {};
    const avail = t.monthlyAvailability;
    const removing = !!(avail[dk] && avail[dk][shift]);

    // Re-validate at click time. The screen may have been rendered hours ago: without
    // this, a tap on a stale chip wrote a request that every admin view filters out —
    // the tarefeiro waited forever for something nobody could see.
    if (!removing) {
        const dt = new Date(dk + 'T00:00:00');
        if (isNaN(dt.getTime())) return;
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const assigned = getAssignedForShift(dt, shift);
        if (dt < today) {
            alert('Esse turno já passou.');
            renderTerceiros();
            return;
        }
        if (assigned.includes(t.id)) { renderTerceiros(); return; }   // already scheduled
        if (DOCTORS_PER_SHIFT - assigned.length <= 0) {
            alert('Esse turno já foi preenchido entretanto.');
            renderTerceiros();
            return;
        }
        if (!monthHasSchedule(dt.getFullYear(), dt.getMonth())) {
            alert('A escala desse mês ainda não foi feita.');
            renderTerceiros();
            return;
        }
    }

    if (removing) {
        delete avail[dk][shift];
        if (!avail[dk].day && !avail[dk].night) delete avail[dk];
    } else {
        if (!avail[dk]) avail[dk] = {};
        avail[dk][shift] = true;
    }
    save();
    renderTerceiros();
};

// ---- Admin: pedidos de tarefeiros ----

// A tarefeiro's availability mark is a *request* until an admin accepts it.
// Pending = marked, not yet on the schedule, and the shift still has room.
function getPendingTerceiroRequests(monthsAhead = 6) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const limit = new Date(today.getFullYear(), today.getMonth() + monthsAhead, 1);
    const out = [];
    terceiros.forEach(t => {
        const avail = t.monthlyAvailability || {};
        Object.keys(avail).forEach(dk => {
            const dt = new Date(dk + 'T00:00:00');
            if (isNaN(dt.getTime()) || dt < today || dt >= limit) return;
            SHIFTS.forEach(shift => {
                if (!avail[dk][shift]) return;
                const assigned = getAssignedForShift(dt, shift);
                if (assigned.includes(t.id)) return;            // already accepted
                const free = DOCTORS_PER_SHIFT - assigned.length;
                if (free <= 0) return;                          // shift is full
                out.push({ terc: t, date: dt, dk, shift, free });
            });
        });
    });
    out.sort((a, b) => a.date - b.date || (a.shift === 'day' ? -1 : 1));
    return out;
}

// Is there a pending request for this exact shift? (used by the schedule markers)
function pendingRequestsForShift(date, shift) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    if (date < today) return [];        // never offer to accept a shift that already happened
    const dk = dateKey(date);
    const assigned = getAssignedForShift(date, shift);
    if (DOCTORS_PER_SHIFT - assigned.length <= 0) return [];
    return terceiros.filter(t => {
        const a = t.monthlyAvailability || {};
        return a[dk] && a[dk][shift] && !assigned.includes(t.id);
    });
}

function renderPendingRequestsPanel() {
    const reqs = getPendingTerceiroRequests();
    if (reqs.length === 0) return '';

    let html = `<div class="req-panel">
        <div class="req-head">
            <h3>Pedidos de tarefeiros</h3>
            <span class="req-count">${reqs.length === 1 ? '1 pendente' : `${reqs.length} pendentes`}</span>
        </div>
        <p class="req-help">Estes tarefeiros ofereceram-se para turnos com falta de pessoal. Só entram na escala se aceitar.</p>`;

    reqs.forEach(r => {
        const dow = (r.date.getDay() + 6) % 7;
        const isNight = r.shift === 'night';
        html += `<div class="req-row">
            <div class="req-who">
                <span class="req-name">${esc(r.terc.name)}</span>
                <span class="req-when">${DAYS[dow]} ${r.date.getDate()} ${MONTH_NAMES[r.date.getMonth()].slice(0,3)} ·
                    <span class="${isNight ? 'req-night' : 'req-day'}">${isNight ? '🌙' : '☀️'} ${SHIFT_LABELS[r.shift]}</span>
                    · ${r.free === 1 ? '1 vaga' : `${r.free} vagas`}</span>
            </div>
            <div class="req-actions">
                <button class="btn btn-sm req-accept" onclick="acceptTerceiroRequest('${r.terc.id}','${r.dk}','${r.shift}')">✓ Aceitar</button>
                <button class="btn btn-sm req-decline" onclick="declineTerceiroRequest('${r.terc.id}','${r.dk}','${r.shift}')">✕ Recusar</button>
            </div>
        </div>`;
    });

    html += `</div>`;
    return html;
}

// Accept: put the tarefeiro on the schedule for that shift.
window.acceptTerceiroRequest = function(tercId, dk, shift) {
    const t = terceiros.find(x => x.id === tercId);
    if (!t) return;
    const date = new Date(dk + 'T00:00:00');
    const assigned = getAssignedForShift(date, shift);
    if (assigned.includes(tercId)) return;
    if (assigned.length >= DOCTORS_PER_SHIFT) {
        alert('Este turno já está completo.');
        renderTerceiros();
        return;
    }
    setAssignedForShift(date, shift, [...assigned, tercId]);
    save();
    renderTerceiros();
    renderSchedule();
    updatePendingBadge();
};

// Decline: drop the request, so the shift goes back to being offered.
window.declineTerceiroRequest = function(tercId, dk, shift) {
    const t = terceiros.find(x => x.id === tercId);
    if (!t || !t.monthlyAvailability || !t.monthlyAvailability[dk]) return;
    delete t.monthlyAvailability[dk][shift];
    if (!t.monthlyAvailability[dk].day && !t.monthlyAvailability[dk].night) delete t.monthlyAvailability[dk];
    save();
    renderTerceiros();
    renderSchedule();
    updatePendingBadge();
};

// Little counter on the Tarefeiros tab so pending requests get noticed.
function updatePendingBadge() {
    const btn = document.querySelector('.nav-btn[data-view="terceiros"]');
    if (!btn) return;
    btn.querySelectorAll('.nav-badge').forEach(b => b.remove());
    if (currentRole !== 'admin') return;
    const n = getPendingTerceiroRequests().length;
    if (n === 0) return;
    const badge = document.createElement('span');
    badge.className = 'nav-badge';
    badge.textContent = n;
    btn.appendChild(badge);
}

function renderTerceiros() {
    const list = document.getElementById('terceiros-list');
    const isTarefeiro = currentRole === 'tarefeiro';

    // A tarefeiro only ever sees their own card.
    const cards = isTarefeiro ? terceiros.filter(t => t.id === currentTerceiroId) : terceiros;

    if (isTarefeiro && cards.length === 0) {
        list.innerHTML = `<div class="empty-state">
            <div class="empty-icon">🔗</div>
            <p>A sua conta ainda não está associada a um cartão de tarefeiro.<br>Contacte o administrador para associar o seu email.</p>
        </div>`;
        return;
    }
    if (cards.length === 0) {
        list.innerHTML = `<div class="empty-state">
            <div class="empty-icon">🩺</div>
            <p>Nenhum tarefeiro registado.<br>Clique em "Adicionar Tarefeiro" para começar.</p>
        </div>`;
        return;
    }

    const now = new Date();
    const curMonth = now.getMonth();
    const curYear = now.getFullYear();
    const daysInMonth = new Date(curYear, curMonth + 1, 0).getDate();

    // Admins see the pending-request queue above the cards.
    let html = isTarefeiro ? '' : renderPendingRequestsPanel();
    cards.forEach(t => {
        // A tarefeiro gets the purpose-built panel only — their own name, phone and
        // specialty are noise to them, and the greeting lives in its header.
        if (isTarefeiro) {
            html += renderTarefeiroVagas(t);
            return;
        }

        let availCount = 0;
        for (let d = 1; d <= daysInMonth; d++) {
            const dt = new Date(curYear, curMonth, d);
            const dk = dateKey(dt);
            const avail = t.monthlyAvailability || {};
            if (avail[dk] && (avail[dk].day || avail[dk].night)) availCount++;
        }

        html += `<div class="doctor-card">
            <div class="doctor-card-header">
                <div>
                    <h3>${esc(t.name)} <span style="font-size:11px;background:#8e44ad;color:#fff;border-radius:4px;padding:2px 6px;font-weight:600">TAREFEIRO</span></h3>
                    <span class="specialty">${t.specialty || '—'}</span>
                </div>
            </div>
            <div class="info-row">
                ${t.phone ? `<span>📞 ${esc(t.phone)}</span>` : ''}
                ${t.email ? `<span>✉ ${esc(t.email)}</span>` : ''}
            </div>
            <div class="avail-summary">Disponível em ${availCount} dias — ${MONTH_NAMES[curMonth]} ${curYear}</div>
            <div class="card-actions write-only">
                <button class="btn btn-sm" onclick="editTerceiro('${t.id}')">Editar</button>
                <button class="btn btn-sm btn-danger" onclick="deleteTerceiro('${t.id}')">Eliminar</button>
            </div>
        </div>`;
    });

    list.innerHTML = html;
    updatePendingBadge();
}

// ---- Terceiro Modal ----
const terceiroModal = document.getElementById('terceiro-modal');
const terceiroForm = document.getElementById('terceiro-form');

function renderTercModalCalendar() {
    const container = document.getElementById('terc-monthly-calendar');
    const label = document.getElementById('terc-avail-month-label');
    label.textContent = `${MONTH_NAMES[modalTercAvailMonth]} ${modalTercAvailYear}`;

    const firstDay = new Date(modalTercAvailYear, modalTercAvailMonth, 1);
    const daysInMonth = new Date(modalTercAvailYear, modalTercAvailMonth + 1, 0).getDate();
    const startDow = (firstDay.getDay() + 6) % 7;

    let html = '';
    ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'].forEach(d => {
        html += `<div class="cal-header">${d}</div>`;
    });
    for (let i = 0; i < startDow; i++) html += '<div class="cal-day empty"></div>';

    const today = new Date(); today.setHours(0, 0, 0, 0);
    for (let d = 1; d <= daysInMonth; d++) {
        const dt = new Date(modalTercAvailYear, modalTercAvailMonth, d);
        const dk = dateKey(dt);
        const dow = (dt.getDay() + 6) % 7;
        const isWeekend = dow >= 5;
        const isPast = dt < today;
        const avail = modalTercAvailData[dk] || {};
        const availDay = !!avail.day, availNight = !!avail.night;
        // In furo-only mode (tarefeiro): a shift is selectable only if it currently has a
        // gap and isn't in the past. An already-marked shift can always be removed.
        const furoDay = isFuro(dt, 'day');
        const furoNight = isFuro(dt, 'night');
        const dayLocked = tercFuroOnly && !availDay && (isPast || !furoDay);
        const nightLocked = tercFuroOnly && !availNight && (isPast || !furoNight);
        const dayCls = (availDay ? 'avail-yes ' : '') + (dayLocked ? 'locked' : (tercFuroOnly && furoDay && !isPast ? 'furo-open' : ''));
        const nightCls = (availNight ? 'avail-yes ' : '') + (nightLocked ? 'locked' : (tercFuroOnly && furoNight && !isPast ? 'furo-open' : ''));
        html += `<div class="cal-day ${isWeekend ? 'weekend' : ''} ${isPast ? 'past' : ''}" data-date="${dk}">
            <div class="day-num">${d}</div>
            <div class="day-shifts">
                <div class="shift-dot day-dot ${dayCls}" data-date="${dk}" data-shift="day" title="Diurno">D</div>
                <div class="shift-dot night-dot ${nightCls}" data-date="${dk}" data-shift="night" title="Noturno">N</div>
            </div>
        </div>`;
    }
    container.innerHTML = html;

    container.querySelectorAll('.shift-dot').forEach(dot => {
        dot.addEventListener('click', (e) => {
            e.stopPropagation();
            if (dot.classList.contains('locked')) return; // furo-only: not a gap → not selectable
            const dk = dot.dataset.date;
            const shift = dot.dataset.shift;
            if (!modalTercAvailData[dk]) modalTercAvailData[dk] = {};
            if (modalTercAvailData[dk][shift]) {
                delete modalTercAvailData[dk][shift];
                if (!modalTercAvailData[dk].day && !modalTercAvailData[dk].night) delete modalTercAvailData[dk];
            } else {
                modalTercAvailData[dk][shift] = true;
            }
            renderTercModalCalendar();
        });
    });

    container.querySelectorAll('.cal-day:not(.empty)').forEach(cell => {
        cell.addEventListener('click', (e) => {
            if (e.target.classList.contains('shift-dot')) return;
            if (tercFuroOnly) return; // furo-only: whole-day toggle disabled, use D/N dots
            const dk = cell.dataset.date;
            const d = modalTercAvailData[dk] || {};
            if (d.day && d.night) {
                delete modalTercAvailData[dk];
            } else {
                modalTercAvailData[dk] = { day: true, night: true };
            }
            renderTercModalCalendar();
        });
    });
}

document.getElementById('add-terceiro-btn').addEventListener('click', () => {
    tercFuroOnly = false;
    terceiroModal.classList.remove('furo-mode');
    document.getElementById('terc-avail-help').innerHTML = 'Clique nos dias em que o médico <strong>pode</strong> trabalhar. Clique no dia para marcar/desmarcar ambos os turnos, ou clique em D/N individualmente.';
    document.getElementById('terc-modal-title').textContent = 'Adicionar Tarefeiro';
    terceiroForm.reset();
    document.getElementById('terc-id').value = '';
    modalTercAvailData = {};
    modalTercAvailBase = {};
    modalTercAvailMonth = new Date().getMonth();
    modalTercAvailYear = new Date().getFullYear();
    renderTercModalCalendar();
    terceiroModal.classList.add('open');
});

window.editTerceiro = function(id) {
    const t = terceiros.find(x => x.id === id);
    if (!t) return;
    tercFuroOnly = false;
    terceiroModal.classList.remove('furo-mode');
    document.getElementById('terc-avail-help').innerHTML = 'Clique nos dias em que o médico <strong>pode</strong> trabalhar. Clique no dia para marcar/desmarcar ambos os turnos, ou clique em D/N individualmente.';
    document.getElementById('terc-modal-title').textContent = 'Editar Tarefeiro';
    document.getElementById('terc-id').value = t.id;
    document.getElementById('terc-name').value = t.name;
    document.getElementById('terc-specialty').value = t.specialty || '';
    document.getElementById('terc-phone').value = t.phone || '';
    document.getElementById('terc-email').value = t.email || '';
    modalTercAvailData = JSON.parse(JSON.stringify(t.monthlyAvailability || {}));
    modalTercAvailBase = JSON.parse(JSON.stringify(modalTercAvailData));
    modalTercAvailMonth = new Date().getMonth();
    modalTercAvailYear = new Date().getFullYear();
    renderTercModalCalendar();
    terceiroModal.classList.add('open');
};

window.deleteTerceiro = function(id) {
    const t = terceiros.find(x => x.id === id);
    if (!t) return;
    if (!confirm(`Eliminar ${t.name}?`)) return;
    terceiros = terceiros.filter(x => x.id !== id);
    Object.keys(schedules).forEach(wk => {
        Object.keys(schedules[wk]).forEach(sk => {
            schedules[wk][sk] = schedules[wk][sk].filter(did => did !== id);
        });
    });
    save();
    renderTerceiros();
    renderSchedule();
};

terceiroForm.addEventListener('submit', e => {
    e.preventDefault();
    const id = document.getElementById('terc-id').value || generateId();

    if (tercFuroOnly) {
        // Tarefeiro self-service: only touch their own availability, leave every other field intact.
        const t = terceiros.find(x => x.id === id);
        if (t) {
            t.monthlyAvailability = { ...modalTercAvailData };
            save();
        }
        renderTerceiros();
        terceiroModal.classList.remove('open');
        return;
    }

    const idx = terceiros.findIndex(x => x.id === id);
    // Only overwrite availability if the admin actually touched the calendar. Otherwise
    // opening a card to fix a phone number wiped every request made while it was open.
    const touchedCalendar = JSON.stringify(modalTercAvailData) !== JSON.stringify(modalTercAvailBase);
    const liveAvail = idx >= 0 ? (terceiros[idx].monthlyAvailability || {}) : {};
    const tData = {
        ...(idx >= 0 ? terceiros[idx] : {}),
        id,
        name: document.getElementById('terc-name').value.trim(),
        specialty: document.getElementById('terc-specialty').value.trim(),
        phone: document.getElementById('terc-phone').value.trim(),
        email: document.getElementById('terc-email').value.trim(),
        monthlyAvailability: touchedCalendar ? { ...modalTercAvailData } : { ...liveAvail },
    };
    if (idx >= 0) terceiros[idx] = tData;
    else terceiros.push(tData);
    save();
    renderTerceiros();
    renderSchedule();
    terceiroModal.classList.remove('open');
});

[document.getElementById('terc-modal-close'), document.getElementById('terc-modal-cancel')].forEach(el => {
    el.addEventListener('click', () => terceiroModal.classList.remove('open'));
});
terceiroModal.addEventListener('click', e => {
    if (e.target === terceiroModal) terceiroModal.classList.remove('open');
});

document.getElementById('terc-avail-prev-month').addEventListener('click', () => {
    modalTercAvailMonth--;
    if (modalTercAvailMonth < 0) { modalTercAvailMonth = 11; modalTercAvailYear--; }
    renderTercModalCalendar();
});
document.getElementById('terc-avail-next-month').addEventListener('click', () => {
    modalTercAvailMonth++;
    if (modalTercAvailMonth > 11) { modalTercAvailMonth = 0; modalTercAvailYear++; }
    renderTercModalCalendar();
});

// ---- Hours Summary ----
let hoursYear = new Date().getFullYear();

function getTheoreticalFixedHours(docId, year, month) {
    const doc = doctors.find(d => d.id === docId);
    if (!doc) return 0;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    let hours = 0;

    // Remember which (date, shift) slots were already counted, so a rule that lands
    // on a slot the doctor is already fixed for isn't added a second time.
    const counted = new Set();
    for (let day = 1; day <= daysInMonth; day++) {
        const date = new Date(year, month, day);
        SHIFTS.forEach(shift => {
            // Skip if doctor is on vacation or unavailable that day
            if (isMonthlyUnavailable(doc, date, shift)) return;
            const dayIdx = (date.getDay() + 6) % 7;
            const inRotation = getRotationDoctorsForShift(dayIdx, shift, getMonday(date)).includes(docId);
            const dk = dateKey(date);
            let isFixedSlot;
            if (doc.fixedMonthly) {
                const fmd = doc.fixedMonthlyData || {};
                isFixedSlot = !!(fmd[dk] && fmd[dk][shift]) || inRotation;
            } else {
                isFixedSlot = !!(doc.fixedSchedule && doc.fixedSchedule[`${dayIdx}_${shift}`]) || inRotation;
            }
            if (isFixedSlot) { hours += HOURS_PER_SHIFT; counted.add(dk + '_' + shift); }
        });
    }

    // Add rule-based hours: iterate actual occurrences of each rule's day-of-week
    // and subtract those that fall on vacation/unavailability
    const rules = getDoctorRules(doc);
    rules.forEach(rule => {
        const shifts = rule.shiftType === '24h' ? ['day', 'night'] : [rule.shiftType];
        // Collect all dates in month matching this rule's day-of-week
        const matchingDates = [];
        for (let day = 1; day <= daysInMonth; day++) {
            const date = new Date(year, month, day);
            const dow = (date.getDay() + 6) % 7;
            if (dow === rule.dayOfWeek) matchingDates.push(date);
        }
        // Count up to rule.count occurrences, skipping unavailable days, and only
        // charging the shifts not already counted above (a "Quinta N" rule on top of
        // a weekly-fixed Thursday night used to add a phantom 12h).
        let done = 0;
        for (const date of matchingDates) {
            if (done >= rule.count) break;
            const unavailable = shifts.some(s => isMonthlyUnavailable(doc, date, s));
            if (unavailable) continue;
            const dk = dateKey(date);
            const novos = shifts.filter(s => !counted.has(dk + '_' + s));
            hours += novos.length * HOURS_PER_SHIFT;
            novos.forEach(s => counted.add(dk + '_' + s));
            done++;                       // the rule occurrence is satisfied either way
        }
    });

    return hours;
}

function getMonthlyFixedHours(docId, year, month) {
    const doc = doctors.find(d => d.id === docId);
    if (!doc) return 0;
    let hours = 0;
    Object.keys(schedules).forEach(wk => {
        const weekSched = schedules[wk];
        Object.keys(weekSched).forEach(sk => {
            const parts = sk.split('_');
            const shiftType = parts.pop();
            const dateStr = parts.join('_');
            const d = new Date(dateStr + 'T00:00:00');
            if (d.getFullYear() === year && d.getMonth() === month) {
                if (weekSched[sk].includes(docId)) {
                    if (isFixedForShiftOnDate(doc, d, shiftType)) {
                        hours += HOURS_PER_SHIFT;
                    }
                }
            }
        });
    });
    return hours;
}

function getMonthlyExtraHours(docId, year, month) {
    return getMonthlyTotalHours(docId, year, month) - getMonthlyFixedHours(docId, year, month);
}

function renderHoursSummary() {
    document.getElementById('hours-year-label').textContent = `${hoursYear}`;
    const table = document.getElementById('hours-table');

    if (doctors.length === 0) {
        table.innerHTML = '<tr><td style="padding:40px;text-align:center;color:#7f8c8d">Nenhum médico registado.</td></tr>';
        const yt = document.getElementById('hours-yearly-table');
        if (yt) yt.innerHTML = '';
        return;
    }

    const MONTH_SHORT = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

    // Header row 1: Doctor | Month names (colspan 3 each) | Acum Extra
    let html = '<thead><tr>';
    html += '<th class="doctor-header" rowspan="2">Médico</th>';
    for (let m = 0; m < 12; m++) {
        html += `<th class="month-header" colspan="3">${MONTH_SHORT[m]}</th>`;
    }
    html += '<th class="accum-header" rowspan="2">Acum.<br>Extra</th>';
    html += '</tr>';

    // Header row 2: Prev | Fixo | Extra for each month
    html += '<tr>';
    for (let m = 0; m < 12; m++) {
        html += '<th class="sub-header sub-theor">Prev</th>';
        html += '<th class="sub-header sub-fixed">Fixo</th>';
        html += '<th class="sub-header sub-extra">Extra</th>';
    }
    html += '</tr></thead>';

    // Body
    html += '<tbody>';
    const totalsTheor = new Array(12).fill(0);
    const totalsFixed = new Array(12).fill(0);
    const totalsExtra = new Array(12).fill(0);
    let totalAccum = 0;

    doctors.forEach(doc => {
        html += '<tr>';
        html += `<td class="doctor-name">${esc(doc.name)}</td>`;
        let accumExtra = 0;

        for (let m = 0; m < 12; m++) {
            const theor = getTheoreticalFixedHours(doc.id, hoursYear, m);
            const fixed = getMonthlyFixedHours(doc.id, hoursYear, m);
            const extra = getMonthlyExtraHours(doc.id, hoursYear, m);
            accumExtra += extra;
            totalsTheor[m] += theor;
            totalsFixed[m] += fixed;
            totalsExtra[m] += extra;

            const theorCls = theor === 0 ? 'theor-cell zero' : 'theor-cell';
            const fixedCls = fixed === 0 ? 'fixed-cell zero' : 'fixed-cell';
            const extraCls = extra === 0 ? 'extra-cell zero' : 'extra-cell has-hours';
            html += `<td class="${theorCls}">${theor}h</td>`;
            html += `<td class="${fixedCls}">${fixed}h</td>`;
            html += `<td class="${extraCls}">${extra}h</td>`;
        }

        totalAccum += accumExtra;
        const accumCls = accumExtra === 0 ? 'accum-cell zero' : 'accum-cell';
        html += `<td class="${accumCls}">${accumExtra}h</td>`;
        html += '</tr>';
    });
    html += '</tbody>';

    // Footer totals
    html += '<tfoot><tr>';
    html += '<td class="doctor-name">TOTAL</td>';
    let totalAccumAll = 0;
    for (let m = 0; m < 12; m++) {
        html += `<td class="theor-cell">${totalsTheor[m]}h</td>`;
        html += `<td class="fixed-cell">${totalsFixed[m]}h</td>`;
        html += `<td class="extra-cell">${totalsExtra[m]}h</td>`;
        totalAccumAll += totalsExtra[m];
    }
    html += `<td class="accum-cell">${totalAccumAll}h</td>`;
    html += '</tr></tfoot>';

    table.innerHTML = html;

    // ---- Yearly summary table ----
    const yearlyTable = document.getElementById('hours-yearly-table');
    if (!yearlyTable) { console.error('hours-yearly-table not found'); return; }
    let yHtml = '<thead><tr>';
    yHtml += '<th class="doctor-header">Médico</th>';
    yHtml += '<th class="month-header sub-theor">Prev</th>';
    yHtml += '<th class="month-header sub-fixed">Fixo</th>';
    yHtml += '<th class="month-header sub-extra">Extra</th>';
    yHtml += '</tr></thead><tbody>';

    let grandTheor = 0, grandFixed = 0, grandExtra = 0;

    doctors.forEach(doc => {
        let yearTheor = 0, yearFixed = 0, yearExtra = 0;
        for (let m = 0; m < 12; m++) {
            yearTheor += getTheoreticalFixedHours(doc.id, hoursYear, m);
            yearFixed += getMonthlyFixedHours(doc.id, hoursYear, m);
            yearExtra += getMonthlyExtraHours(doc.id, hoursYear, m);
        }
        grandTheor += yearTheor;
        grandFixed += yearFixed;
        grandExtra += yearExtra;

        yHtml += '<tr>';
        yHtml += `<td class="doctor-name">${esc(doc.name)}</td>`;
        yHtml += `<td class="${yearTheor === 0 ? 'theor-cell zero' : 'theor-cell'}">${yearTheor}h</td>`;
        yHtml += `<td class="${yearFixed === 0 ? 'fixed-cell zero' : 'fixed-cell'}">${yearFixed}h</td>`;
        yHtml += `<td class="${yearExtra === 0 ? 'extra-cell zero' : 'extra-cell has-hours'}">${yearExtra}h</td>`;
        yHtml += '</tr>';
    });

    yHtml += '</tbody><tfoot><tr>';
    yHtml += '<td class="doctor-name">TOTAL</td>';
    yHtml += `<td class="theor-cell">${grandTheor}h</td>`;
    yHtml += `<td class="fixed-cell">${grandFixed}h</td>`;
    yHtml += `<td class="extra-cell">${grandExtra}h</td>`;
    yHtml += '</tr></tfoot>';

    yearlyTable.innerHTML = yHtml;
}

document.getElementById('hours-prev-year').addEventListener('click', () => {
    hoursYear--;
    renderHoursSummary();
});

document.getElementById('hours-next-year').addEventListener('click', () => {
    hoursYear++;
    renderHoursSummary();
});

// ---- Export / Import ----
function exportData() {
    const data = {
        version: 1,
        exportDate: new Date().toISOString(),
        doctors,
        terceiros,
        schedules,
        rotations: rotationGrid
    };
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const dateStr = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `escalas-chbv-${dateStr}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showSaveStatus('Exportado!');
}

function importData(file) {
    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const data = JSON.parse(e.target.result);
            if (!data.doctors || !data.schedules) {
                alert('Ficheiro inválido. Deve ser um ficheiro exportado por esta aplicação.');
                return;
            }
            if (!confirm(`Importar dados de ${data.exportDate ? new Date(data.exportDate).toLocaleString('pt-PT') : 'ficheiro'}?\n\nIsto vai substituir TODOS os dados atuais (${doctors.length} médicos → ${data.doctors.length} médicos).`)) {
                return;
            }
            doctors = data.doctors || [];
            terceiros = data.terceiros || [];
            schedules = data.schedules || {};
            rotationGrid = migrateRotationsToGrid(data.rotations);
            save();
            renderSchedule();
            renderDoctors();
            renderTerceiros();
            renderRotations();
            showSaveStatus('Importado!');
            alert(`Dados importados com sucesso!\n${doctors.length} médicos, ${terceiros.length} terceiros.`);
        } catch (err) {
            alert('Erro ao ler o ficheiro: ' + err.message);
        }
    };
    reader.readAsText(file);
}

function showSaveStatus(msg) {
    setSaveStatus('saved', msg || '✓ Guardado');
    setTimeout(() => {
        const el = document.getElementById('save-status');
        if (el && el.classList.contains('saved')) el.textContent = '';
    }, 2000);
}

document.getElementById('history-btn').addEventListener('click', openHistoryModal);
document.getElementById('pdf-btn').addEventListener('click', generatePDF);
document.getElementById('img-btn').addEventListener('click', generateImage);

let _origDocTitle = null;

function generatePDF() {
    const isList = scheduleViewMode === 'list';

    let pageStyle = document.getElementById('print-page-style');
    if (!pageStyle) {
        pageStyle = document.createElement('style');
        pageStyle.id = 'print-page-style';
        document.head.appendChild(pageStyle);
    }
    pageStyle.textContent = `@page { size: A4 ${isList ? 'portrait' : 'landscape'}; margin: ${isList ? '0.9cm 1cm' : '1.2cm 1cm'}; }`;

    document.body.classList.toggle('print-list', isList);
    document.body.classList.toggle('print-calendar', !isList);

    // Suppress the browser's auto-injected page title in the print header
    _origDocTitle = document.title;
    document.title = ' ';

    document.getElementById('print-view').innerHTML = isList ? buildListPdfHtml() : buildCalendarPdfHtml();
    window.print();
}

function buildImageExportHeader(month, year) {
    return `<div style="display:flex;align-items:center;gap:14px;padding:14px 20px 12px;border-bottom:2px solid #0a1929;margin-bottom:14px;font-family:'Inter',-apple-system,sans-serif;">
        <svg width="36" height="36" viewBox="0 0 36 36" fill="none" style="flex-shrink:0;">
            <rect width="36" height="36" rx="8" fill="#2563eb"/>
            <rect x="15" y="8" width="6" height="20" rx="3" fill="white"/>
            <rect x="8" y="15" width="20" height="6" rx="3" fill="white"/>
        </svg>
        <div style="flex:1;">
            <div style="font-size:18px;font-weight:800;color:#0a1929;letter-spacing:-0.3px;line-height:1.2;">Escala de Urgência</div>
            <div style="font-size:11px;color:#6b7280;margin-top:2px;font-weight:500;">Centro Hospitalar do Baixo Vouga — Hospital de Aveiro</div>
        </div>
        <div style="font-size:16px;font-weight:800;color:#2563eb;letter-spacing:-0.3px;">${MONTH_NAMES[month]} ${year}</div>
    </div>`;
}

async function generateImage() {
    if (typeof html2canvas !== 'function') {
        alert('Biblioteca html2canvas não carregou. Recarrega a página.');
        return;
    }

    const btn = document.getElementById('img-btn');
    const origLabel = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '⏳ A gerar…';

    const liveGrid = document.getElementById('schedule-grid');
    if (!liveGrid || !liveGrid.children.length) {
        alert('Nada para exportar — a escala está vazia.');
        btn.disabled = false;
        btn.innerHTML = origLabel;
        return;
    }

    // Use the live grid's current width so the clone renders with identical layout
    const gridWidth = liveGrid.offsetWidth;

    const wrapper = document.createElement('div');
    wrapper.id = 'image-export-wrapper';
    wrapper.style.cssText = `
        position: absolute;
        left: -99999px;
        top: 0;
        width: ${gridWidth}px;
        padding: 20px;
        box-sizing: content-box;
        background: #ffffff;
    `;
    wrapper.innerHTML = buildImageExportHeader(currentSchedMonth, currentSchedYear);

    const clonedGrid = liveGrid.cloneNode(true);
    clonedGrid.removeAttribute('id');
    clonedGrid.style.width = gridWidth + 'px';
    wrapper.appendChild(clonedGrid);
    document.body.appendChild(wrapper);

    // Allow layout to settle
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    try {
        const canvas = await html2canvas(wrapper, {
            backgroundColor: '#ffffff',
            scale: 2,
            useCORS: true,
            logging: false,
        });

        const mm = String(currentSchedMonth + 1).padStart(2, '0');
        const mode = scheduleViewMode === 'list' ? '_lista' : '';
        const filename = `escala_${currentSchedYear}_${mm}${mode}.jpg`;

        canvas.toBlob((blob) => {
            if (!blob) {
                alert('Falha ao gerar imagem.');
                return;
            }
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        }, 'image/jpeg', 0.92);
    } catch (err) {
        console.error('[image-export] error:', err);
        alert('Erro ao gerar imagem: ' + (err.message || err));
    } finally {
        wrapper.remove();
        btn.disabled = false;
        btn.innerHTML = origLabel;
    }
}

window.addEventListener('afterprint', () => {
    document.body.classList.remove('print-list', 'print-calendar');
    if (_origDocTitle !== null) {
        document.title = _origDocTitle;
        _origDocTitle = null;
    }
});

function buildPdfHeader(month, year) {
    return `<div class="print-header">
        <div class="print-logo-wrap">
            <svg width="32" height="32" viewBox="0 0 36 36" fill="none">
                <rect width="36" height="36" rx="8" fill="#2563eb"/>
                <rect x="15" y="8" width="6" height="20" rx="3" fill="white"/>
                <rect x="8" y="15" width="20" height="6" rx="3" fill="white"/>
            </svg>
        </div>
        <div class="print-title-block">
            <div class="print-title">Escala de Urgência</div>
            <div class="print-subtitle">Centro Hospitalar do Baixo Vouga — Hospital de Aveiro</div>
        </div>
        <div class="print-month-badge">${MONTH_NAMES[month]} ${year}</div>
    </div>`;
}

function buildPdfFooter() {
    return '';
}

function buildCalendarPdfHtml() {
    const year = currentSchedYear;
    const month = currentSchedMonth;
    const dates = getMonthDates();

    const firstDow = (dates[0].getDay() + 6) % 7;
    const weeks = [];
    let week = new Array(firstDow).fill(null);
    dates.forEach(d => {
        week.push(d);
        if (week.length === 7) { weeks.push(week); week = []; }
    });
    if (week.length) {
        while (week.length < 7) week.push(null);
        weeks.push(week);
    }

    const dayHeaders = [
        { label: 'Seg' }, { label: 'Ter' }, { label: 'Qua' }, { label: 'Qui' },
        { label: 'Sex' }, { label: 'Sáb', weekend: true }, { label: 'Dom', weekend: true }
    ];

    let totalAssigned = 0;
    let totalSlots = 0;

    const weeksHtml = weeks.map(w => {
        const cells = w.map(d => {
            if (!d) return `<td class="pcal-empty"></td>`;
            const dow = (d.getDay() + 6) % 7;
            const isWeekend = dow >= 5;
            const isToday = d.toDateString() === new Date().toDateString();

            let shiftsHtml = '';
            ['day','night'].forEach(shift => {
                const assigned = getAssignedForShift(d, shift);
                totalSlots++;
                if (assigned.length > 0) totalAssigned++;
                const names = assigned.map(id => {
                    const doc = doctors.find(x => x.id === id) || terceiros.find(x => x.id === id);
                    return doc ? doc.name.split(' ').slice(0,2).join(' ') : '?';
                });
                const isEmpty = assigned.length === 0;
                const isPartial = assigned.length > 0 && assigned.length < DOCTORS_PER_SHIFT;
                const statusCls = isEmpty ? 'pempty' : isPartial ? 'ppartial' : '';
                shiftsHtml += `<div class="pshift pshift-${shift} ${statusCls}">
                    <span class="pshift-lbl">${shift === 'day' ? 'D' : 'N'}</span>
                    <span class="pshift-names">${isEmpty ? '—' : names.join(', ')}</span>
                </div>`;
            });

            return `<td class="pcal-day ${isWeekend ? 'pcal-weekend' : ''} ${isToday ? 'pcal-today' : ''}">
                <div class="pday-num">${d.getDate()}</div>
                ${shiftsHtml}
            </td>`;
        }).join('');
        return `<tr>${cells}</tr>`;
    }).join('');

    return `${buildPdfHeader(month, year)}
        <table class="pcal">
            <thead><tr>${dayHeaders.map(h => `<th class="${h.weekend ? 'pcal-weekend-h' : ''}">${h.label}</th>`).join('')}</tr></thead>
            <tbody>${weeksHtml}</tbody>
        </table>
        ${buildPdfFooter(totalAssigned, totalSlots)}`;
}

function buildListPdfHtml() {
    const year = currentSchedYear;
    const month = currentSchedMonth;
    const dates = getMonthDates();
    const todayStr = new Date().toDateString();

    const N = DOCTORS_PER_SHIFT;
    let totalAssigned = 0;
    let totalSlots = 0;

    const rowsHtml = dates.map(d => {
        const dow = (d.getDay() + 6) % 7;
        const isWeekend = dow >= 5;
        const isToday = d.toDateString() === todayStr;

        const slotCells = [];
        ['day','night'].forEach(shift => {
            const assigned = getAssignedForShift(d, shift);
            if (assigned.length > 0) totalAssigned++;
            const isEmpty = assigned.length === 0;
            const isPartial = assigned.length > 0 && assigned.length < N;
            // shift-level status applied to every slot cell of that shift
            const statusCls = isEmpty ? 'pempty' : isPartial ? 'ppartial' : 'pcomplete';

            for (let i = 0; i < N; i++) {
                totalSlots++;
                const docId = assigned[i];
                const dividerCls = (shift === 'night' && i === 0) ? ' plist-divider' : '';
                if (docId) {
                    const doc = doctors.find(x => x.id === docId) || terceiros.find(x => x.id === docId);
                    const isTerceiro = !doctors.find(x => x.id === docId) && !!terceiros.find(x => x.id === docId);
                    const isFixed = doc && isFixedForShiftOnDate(doc, d, shift);
                    const nameCls = isFixed ? 'pname-fixed' : isTerceiro ? 'pname-terceiro' : 'pname-flex';
                    const name = doc ? doc.name.split(' ').slice(0,2).join(' ') : '?';
                    slotCells.push(`<td class="plist-slot plist-${shift} ${statusCls}${dividerCls}"><span class="${nameCls}">${name}</span></td>`);
                } else {
                    slotCells.push(`<td class="plist-slot plist-${shift} ${statusCls}${dividerCls}"><span class="pname-empty">—</span></td>`);
                }
            }
        });

        return `<tr class="${isWeekend ? 'plist-weekend' : ''} ${isToday ? 'plist-today' : ''}">
            <td class="plist-date">
                <span class="plist-day-num">${d.getDate()}</span>
                <span class="plist-day-name">${DAYS[dow]}</span>
            </td>${slotCells.join('')}
        </tr>`;
    }).join('');

    const slotHeaders = (shift) => Array.from({length: N}, (_, i) => {
        const dividerCls = (shift === 'night' && i === 0) ? ' plist-divider' : '';
        return `<th class="plist-slot-h plist-shift-${shift}${dividerCls}">Médico ${i + 1}</th>`;
    }).join('');

    return `${buildPdfHeader(month, year)}
        <table class="plist">
            <thead>
                <tr class="plist-h-shifts">
                    <th class="plist-date-h" rowspan="2">Dia</th>
                    <th class="plist-shift-h plist-shift-day" colspan="${N}">Diurno <small>08:30–20:30</small></th>
                    <th class="plist-shift-h plist-shift-night plist-divider" colspan="${N}">Noturno <small>20:30–08:30</small></th>
                </tr>
                <tr class="plist-h-slots">${slotHeaders('day')}${slotHeaders('night')}</tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
        </table>
        ${buildPdfFooter(totalAssigned, totalSlots)}`;
}
document.getElementById('import-file').addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
        importData(e.target.files[0]);
        e.target.value = '';
    }
});

// ---- Init ----
initAuth();
