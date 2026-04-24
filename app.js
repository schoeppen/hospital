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

async function loadData() {
    const { data, error } = await db.from('app_data').select('*');
    if (error) { console.error('Erro ao carregar dados:', error); return; }
    data.forEach(row => {
        if (row.key === 'chbv_doctors') doctors = row.value;
        if (row.key === 'chbv_schedules') schedules = row.value;
        if (row.key === 'chbv_rotations') rotations = row.value;
        if (row.key === 'chbv_terceiros') terceiros = row.value;
    });
}

// ---- Auth State ----
let currentUser = null;
let currentRole = null;
let suppressAuthChange = false;

// ---- State ----
let scheduleViewMode = 'calendar'; // 'calendar' or 'list'
let doctors = [];
let schedules = {};
let rotations = [];
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
let modalTercAvailMonth = new Date().getMonth();
let modalTercAvailYear = new Date().getFullYear();

// Modal state for monthly day rules
let modalRulesMonth = new Date().getMonth();
let modalRulesYear = new Date().getFullYear();
let modalRulesData = {}; // { "2026-03": [ {dayOfWeek, shiftType, count}, ... ] }

// ---- History ----
let lastHistorySaveTime = 0;
const HISTORY_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const HISTORY_MAX_DAYS = 30;

async function saveHistory() {
    const now = Date.now();
    if (now - lastHistorySaveTime < HISTORY_INTERVAL_MS) return;
    lastHistorySaveTime = now;
    await db.from('app_data_history').insert({
        doctors, schedules, rotations, terceiros
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
    doctors = data.doctors;
    schedules = data.schedules;
    rotations = data.rotations;
    terceiros = data.terceiros;
    await db.from('app_data').upsert([
        { key: 'chbv_doctors', value: doctors },
        { key: 'chbv_schedules', value: schedules },
        { key: 'chbv_rotations', value: rotations },
        { key: 'chbv_terceiros', value: terceiros },
    ]);
    renderSchedule(); renderDoctors(); renderTerceiros(); renderRotations(); renderHoursSummary();
    closeHistoryModal();
    showSaveStatus('Versão restaurada!');
}

function openHistoryModal() {
    const modal = document.getElementById('history-modal');
    const content = document.getElementById('history-content');
    content.innerHTML = '<p style="padding:16px;color:#7f8c8d">A carregar...</p>';
    modal.classList.add('open');
    loadHistory().then(entries => {
        if (entries.length === 0) {
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
    });
}

function closeHistoryModal() {
    document.getElementById('history-modal').classList.remove('open');
}

function save() {
    const el = document.getElementById('save-status');
    if (el) { el.textContent = '⏳ A guardar...'; }
    const entries = [
        { key: 'chbv_doctors', value: doctors },
        { key: 'chbv_schedules', value: schedules },
        { key: 'chbv_rotations', value: rotations },
        { key: 'chbv_terceiros', value: terceiros },
    ];
    db.from('app_data').upsert(entries).then(({ error }) => {
        if (error) { console.error('Erro ao guardar:', error); if (el) el.textContent = '✗ Erro'; return; }
        if (el) {
            el.textContent = '✓ Guardado';
            el.classList.add('saved');
            setTimeout(() => el.classList.remove('saved'), 2000);
        }
        if (typeof renderHoursSummary === 'function' && document.getElementById('hours-table')) {
            try { renderHoursSummary(); } catch(e) {}
        }
        saveHistory();
    });
}

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
function getScheduleForDate(date) {
    const monday = getMonday(date);
    const wk = weekKey(monday);
    if (!schedules[wk]) schedules[wk] = {};
    return schedules[wk];
}

// Get assigned doctors for a specific date+shift
function getAssignedForShift(date, shift) {
    const sched = getScheduleForDate(date);
    const sk = shiftKey(date, shift);
    return sched[sk] || [];
}

// Set assigned doctors for a specific date+shift
function setAssignedForShift(date, shift, docIds) {
    const sched = getScheduleForDate(date);
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
        return;
    }
    currentRole = profile.role;
    const displayName = profile.name || user.email;

    document.getElementById('user-name-display').textContent = displayName;
    const roleBadge = document.getElementById('user-role-badge');
    roleBadge.textContent = currentRole === 'admin' ? 'Admin' : 'Leitura';
    roleBadge.className = `role-badge role-badge-${currentRole}`;
    document.getElementById('user-info').style.display = 'flex';

    applyRoleUI(currentRole);
    hideLoginScreen();

    await loadData();
    renderSchedule();
    renderDoctors();
    renderTerceiros();
    renderRotations();
    renderHoursSummary();
}

function applyRoleUI(role) {
    document.body.classList.remove('role-read', 'role-write', 'role-admin');
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

async function renderUsersAdmin() {
    const list = document.getElementById('users-list');
    list.innerHTML = '<div class="empty-state"><p>A carregar…</p></div>';

    const { data: profiles, error } = await db.from('profiles').select('*').order('created_at');
    if (error) {
        list.innerHTML = `<div class="empty-state"><p>Erro ao carregar utilizadores: ${error.message}</p></div>`;
        return;
    }

    const roleLabels = { read: 'Leitura', write: 'Escrita', admin: 'Admin' };
    let html = `<table class="users-table">
        <thead><tr>
            <th>Nome</th><th>Email</th><th>Papel</th><th>Desde</th><th>Ações</th>
        </tr></thead><tbody>`;

    profiles.forEach(p => {
        const isSelf = p.id === currentUser.id;
        const since = new Date(p.created_at).toLocaleDateString('pt-PT');
        html += `<tr class="${isSelf ? 'row-self' : ''}">
            <td><strong>${p.name || '—'}</strong></td>
            <td>${p.email}</td>
            <td>
                <select class="role-select" data-uid="${p.id}" ${isSelf ? 'disabled' : ''}>
                    <option value="read" ${p.role !== 'admin' ? 'selected' : ''}>Leitura</option>
                    <option value="admin" ${p.role === 'admin' ? 'selected' : ''}>Admin</option>
                </select>
            </td>
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
    suppressAuthChange = false;

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
});

// ---- Navigation ----
document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        document.getElementById(`${btn.dataset.view}-view`).classList.add('active');
        if (btn.dataset.view === 'users') renderUsersAdmin();
        document.getElementById('pdf-btn').style.display = btn.dataset.view === 'schedule' ? '' : 'none';
    });
});

// ---- Schedule Rendering ----
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

    const todayStr = new Date().toDateString();

    // Day-of-week headers
    let html = DAYS.map(d =>
        `<div class="grid-header cal-dow-header">${d}</div>`
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
            const cellRotations = getRotationsForShift(dow, shift);
            const rotationDocIds = cellRotations.map(r => getRotationDoctor(r, monday));

            html += `<div class="cal-shift-row ${statusClass}" data-date="${dk}" data-shift="${shift}">
                <span class="cal-shift-label ${shift}">${shift === 'day' ? 'D' : 'N'}</span>`;

            assigned.forEach(docId => {
                const doc = doctors.find(x => x.id === docId) || terceiros.find(x => x.id === docId);
                const isTerceiro = !doctors.find(x => x.id === docId) && !!terceiros.find(x => x.id === docId);
                const isRotation = rotationDocIds.includes(docId);
                const isFixed = doc && isFixedForShiftOnDate(doc, d, shift);
                const tagClass = isRotation ? 'rotation-tag' : isFixed ? 'fixed-tag' : isTerceiro ? 'terceiro-tag' : '';
                const firstName = doc ? doc.name.split(' ')[0] : '?';
                const hoursUsed = isTerceiro ? null : getMonthlyExtraHours(docId, d.getFullYear(), d.getMonth());
                const hoursLimit = doc ? (doc.monthlyHoursLimit || 0) : 0;
                const shiftType = isTerceiro ? 'Tarefeiro' : isFixed ? 'Fixo' : 'Extra';
                html += `<div class="doctor-tag ${tagClass}"
                    data-fullname="${doc ? doc.name : '?'}"
                    data-hours-used="${hoursUsed ?? ''}"
                    data-hours-limit="${hoursLimit}"
                    data-shift-type="${shiftType}">
                    <span>${firstName}</span>
                    <button class="remove-doc" data-date="${dk}" data-shift="${shift}" data-doc="${docId}">&times;</button>
                </div>`;
            });

            if (count < DOCTORS_PER_SHIFT) {
                html += `<div class="add-slot" data-date="${dk}" data-shift="${shift}">+</div>`;
            }

            html += '</div>';
        });

        html += '</div>';
    });

    grid.innerHTML = html;

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
            const sched = getScheduleForDate(date);
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
        });
        tag.addEventListener('mouseleave', () => { hoverCard.style.display = 'none'; });
    });
}

function renderScheduleList() {
    const grid = document.getElementById('schedule-grid');
    const dates = getMonthDates();

    document.getElementById('week-label').textContent =
        `${MONTH_NAMES[currentSchedMonth]} ${currentSchedYear}`;

    grid.style.gridTemplateColumns = 'auto 1fr 1fr';

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
            const cellRotations = getRotationsForShift(dow, shift);
            const rotationDocIds = cellRotations.map(r => getRotationDoctor(r, monday));

            html += `<div class="shift-cell ${cellClass} ${statusClass} ${isWeekend ? 'weekend-cell' : ''} ${isToday ? 'today-cell' : ''}" data-date="${dk}" data-shift="${shift}">
                <div class="status-dot"></div>`;

            assigned.forEach(docId => {
                const doc = doctors.find(x => x.id === docId) || terceiros.find(x => x.id === docId);
                const isTerceiro = !doctors.find(x => x.id === docId) && !!terceiros.find(x => x.id === docId);
                const isRotation = rotationDocIds.includes(docId);
                const isFixed = doc && isFixedForShiftOnDate(doc, d, shift);
                const tagClass = isRotation ? 'rotation-tag' : isFixed ? 'fixed-tag' : isTerceiro ? 'terceiro-tag' : '';
                const hoursUsed = isTerceiro ? null : getMonthlyExtraHours(docId, d.getFullYear(), d.getMonth());
                const hoursLimit = doc ? (doc.monthlyHoursLimit || 0) : 0;
                const shiftType = isTerceiro ? 'Tarefeiro' : isFixed ? 'Fixo' : 'Extra';
                html += `<div class="doctor-tag ${tagClass}"
                    data-fullname="${doc ? doc.name : '?'}"
                    data-hours-used="${hoursUsed ?? ''}"
                    data-hours-limit="${hoursLimit}"
                    data-shift-type="${shiftType}">
                    <span>${doc ? doc.name : '?'}</span>
                    <button class="remove-doc" data-date="${dk}" data-shift="${shift}" data-doc="${docId}">&times;</button>
                </div>`;
            });

            if (count < DOCTORS_PER_SHIFT) {
                html += `<div class="add-slot" data-date="${dk}" data-shift="${shift}">+ Médico</div>`;
            }

            html += '</div>';
        });
    });

    grid.innerHTML = html;

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
            const sched = getScheduleForDate(date);
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
        });
        tag.addEventListener('mouseleave', () => { hoverCard.style.display = 'none'; });
    });
}

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
    const mk = monthKey(year, month);
    const rules = (doc.monthlyDayRules && doc.monthlyDayRules[mk]) || [];
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
    const mk = monthKey(date.getFullYear(), date.getMonth());
    const rules = (doc.monthlyDayRules && doc.monthlyDayRules[mk]) || [];
    const dow = (date.getDay() + 6) % 7;
    return rules.some(r => r.dayOfWeek === dow && (r.shiftType === shift || r.shiftType === '24h'));
}

function isFixedForShiftOnDate(doc, date, shift) {
    // Check monthly fixed first (day-by-day overrides)
    if (doc.fixedMonthly) {
        const fmd = doc.fixedMonthlyData || {};
        const dk = dateKey(date);
        return !!(fmd[dk] && fmd[dk][shift]);
    }
    // Weekly repeating pattern (works data)
    const dayIdx = (date.getDay() + 6) % 7; // Mon=0
    const key = `${dayIdx}_${shift}`;
    if (doc.fixedSchedule && doc.fixedSchedule[key]) return true;
    // Monthly day-of-week rules count as fixed (not extra)
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
        const shiftRotations = getRotationsForShift(dayIdx, shift);
        const isRotationDoc = shiftRotations.some(r => getRotationDoctor(r, monday) === doc.id);
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
        const mk = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}`;
        const dow = (date.getDay() + 6) % 7;
        const docRules = (doc.monthlyDayRules && doc.monthlyDayRules[mk]) || [];
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
            <span>${doc.name}${hoursHtml}</span>
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
            if (isAvail) badges.push('<span class="avail-badge yes">Disponível</span>');
            if (isAvail) badges.push('<span class="avail-badge yes">Disponível</span>');
            else badges.push('<span class="avail-badge no">Sem disponibilidade</span>');
            if (resting) badges.push('<span class="avail-badge no">A descansar (noite anterior)</span>');
            html += `<li class="assign-item ${!canAssign ? 'unavailable' : ''}"
                         data-doc-id="${t.id}" data-available="true">
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

function getRotationDoctor(rotation, weekStartDate) {
    const refDate = isoWeekToDate(rotation.startWeek);
    const refWeekNum = getWeekNumber(refDate);
    const currentWeekNum = getWeekNumber(weekStartDate);
    const refYear = refDate.getFullYear();
    const curYear = weekStartDate.getFullYear();
    const weeksDiff = (curYear - refYear) * 52 + (currentWeekNum - refWeekNum);
    return (weeksDiff % 2 === 0) ? rotation.doctorA : rotation.doctorB;
}

function isoWeekToDate(isoWeek) {
    const [year, week] = isoWeek.split('-W').map(Number);
    const jan4 = new Date(year, 0, 4);
    const monday = new Date(jan4);
    monday.setDate(jan4.getDate() - (jan4.getDay() || 7) + 1);
    monday.setDate(monday.getDate() + (week - 1) * 7);
    return monday;
}

function getRotationsForShift(dayIdx, shift) {
    return rotations.filter(r => r.dayIdx === dayIdx && r.shift === shift);
}

function renderRotations() {
    const list = document.getElementById('rotations-list');

    if (rotations.length === 0) {
        list.innerHTML = `<div class="empty-state">
            <div class="empty-icon">🔄</div>
            <p>Nenhuma rotação definida.<br>Clique em "Nova Rotação" para criar uma alternância entre dois médicos.</p>
        </div>`;
        return;
    }

    let html = '';
    rotations.forEach(rot => {
        const docA = doctors.find(d => d.id === rot.doctorA);
        const docB = doctors.find(d => d.id === rot.doctorB);
        const activeDoc = getRotationDoctor(rot, currentWeekStart);
        const activeIsA = activeDoc === rot.doctorA;

        html += `<div class="rotation-card">
            <h3>${DAYS_FULL[rot.dayIdx]} — ${SHIFT_LABELS[rot.shift]} (${SHIFT_TIMES[rot.shift]})</h3>
            <div class="this-week-indicator">Esta semana: ${activeIsA ? (docA ? docA.name : '?') : (docB ? docB.name : '?')}</div>
            <div class="rotation-detail">
                <span class="week-label week-a">Semana A</span>
                <span>${docA ? docA.name : '(eliminado)'}</span>
            </div>
            <div class="rotation-detail">
                <span class="week-label week-b">Semana B</span>
                <span>${docB ? docB.name : '(eliminado)'}</span>
            </div>
            <div class="rotation-info">Referência: semana ${rot.startWeek} — ${docA ? docA.name.split(' ')[0] : '?'} começa</div>
            <div class="card-actions write-only">
                <button class="btn btn-sm" onclick="editRotation('${rot.id}')">Editar</button>
                <button class="btn btn-sm btn-danger" onclick="deleteRotation('${rot.id}')">Eliminar</button>
            </div>
        </div>`;
    });

    list.innerHTML = html;
}

function populateRotationDoctorSelects(selectedA, selectedB) {
    const selA = document.getElementById('rotation-doc-a');
    const selB = document.getElementById('rotation-doc-b');
    let opts = '<option value="">— Selecionar médico —</option>';
    doctors.forEach(doc => {
        opts += `<option value="${doc.id}">${doc.name}</option>`;
    });
    selA.innerHTML = opts;
    selB.innerHTML = opts;
    if (selectedA) selA.value = selectedA;
    if (selectedB) selB.value = selectedB;
}

function getCurrentISOWeek() {
    const d = new Date();
    const wn = getWeekNumber(d);
    return `${d.getFullYear()}-W${String(wn).padStart(2, '0')}`;
}

document.getElementById('add-rotation-btn').addEventListener('click', () => {
    document.getElementById('rotation-modal-title').textContent = 'Nova Rotação';
    document.getElementById('rotation-id').value = '';
    document.getElementById('rotation-day').value = '3';
    document.getElementById('rotation-shift').value = 'night';
    document.getElementById('rotation-start').value = getCurrentISOWeek();
    populateRotationDoctorSelects('', '');
    document.getElementById('rotation-modal').classList.add('open');
});

window.editRotation = function(id) {
    const rot = rotations.find(r => r.id === id);
    if (!rot) return;
    document.getElementById('rotation-modal-title').textContent = 'Editar Rotação';
    document.getElementById('rotation-id').value = rot.id;
    document.getElementById('rotation-day').value = rot.dayIdx;
    document.getElementById('rotation-shift').value = rot.shift;
    document.getElementById('rotation-start').value = rot.startWeek;
    populateRotationDoctorSelects(rot.doctorA, rot.doctorB);
    document.getElementById('rotation-modal').classList.add('open');
};

window.deleteRotation = function(id) {
    if (!confirm('Eliminar esta rotação?')) return;
    rotations = rotations.filter(r => r.id !== id);
    save();
    renderRotations();
    renderSchedule();
};

document.getElementById('rotation-form').addEventListener('submit', e => {
    e.preventDefault();
    const docA = document.getElementById('rotation-doc-a').value;
    const docB = document.getElementById('rotation-doc-b').value;
    if (!docA || !docB) return alert('Selecione ambos os médicos.');
    if (docA === docB) return alert('Os dois médicos devem ser diferentes.');

    const id = document.getElementById('rotation-id').value || generateId();
    const rotData = {
        id, doctorA: docA, doctorB: docB,
        dayIdx: parseInt(document.getElementById('rotation-day').value),
        shift: document.getElementById('rotation-shift').value,
        startWeek: document.getElementById('rotation-start').value,
    };

    const idx = rotations.findIndex(r => r.id === id);
    if (idx >= 0) rotations[idx] = rotData;
    else rotations.push(rotData);

    save();
    renderRotations();
    renderSchedule();
    document.getElementById('rotation-modal').classList.remove('open');
});

document.getElementById('rotation-modal-close').addEventListener('click', () => {
    document.getElementById('rotation-modal').classList.remove('open');
});
document.getElementById('rotation-cancel').addEventListener('click', () => {
    document.getElementById('rotation-modal').classList.remove('open');
});
document.getElementById('rotation-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('rotation-modal'))
        document.getElementById('rotation-modal').classList.remove('open');
});

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

document.getElementById('auto-fill-btn').addEventListener('click', () => {
    const dates = getMonthDates();

    // Helper to get/init sched array for a date+shift
    function getSk(date, shift) {
        const sched = getScheduleForDate(date);
        const sk = shiftKey(date, shift);
        if (!sched[sk]) sched[sk] = [];
        return { sched, sk, arr: sched[sk] };
    }

    // =========================================
    // PASS 1: Fixed-schedule doctors (highest priority)
    // =========================================
    dates.forEach(date => {
        SHIFTS.forEach(shift => {
            const { arr } = getSk(date, shift);
            doctors.forEach(doc => {
                if (isFixedForShiftOnDate(doc, date, shift) && !isMonthlyUnavailable(doc, date, shift)) {
                    if (!arr.includes(doc.id) && arr.length < DOCTORS_PER_SHIFT && !workedOtherWeekendDay(doc.id, date)) {
                        arr.push(doc.id);
                    }
                }
            });
        });
    });

    // =========================================
    // PASS 2: Rotation doctors (fill remaining slots)
    // =========================================
    dates.forEach(date => {
        const dayIdx = (date.getDay() + 6) % 7;
        const monday = getMonday(date);
        SHIFTS.forEach(shift => {
            const { arr } = getSk(date, shift);
            const shiftRotations = getRotationsForShift(dayIdx, shift);
            shiftRotations.forEach(rot => {
                const docId = getRotationDoctor(rot, monday);
                const doc = doctors.find(d => d.id === docId);
                if (!doc) return;
                if (isBlockedOnDate(doc, date, shift)) return;
                if (isMonthlyUnavailable(doc, date, shift)) return;
                if (needsRestAfterNight(docId, date, shift)) return;
                if (shift === 'night' && hasNextDayConflict(docId, date)) return;
                if (workedOtherWeekendDay(docId, date)) return;
                if (SHIFTS.some(s => s !== shift && getAssignedForShift(date, s).includes(docId))) return;
                if (!arr.includes(docId) && arr.length < DOCTORS_PER_SHIFT) {
                    arr.push(docId);
                }
            });
        });
    });

    // =========================================
    // PASS 2.5: Monthly day-of-week rules
    // =========================================
    doctors.forEach(doc => {
        const rules = doc.monthlyDayRules || {};
        dates.forEach(date => {
            const mk = monthKey(date.getFullYear(), date.getMonth());
            const monthRules = rules[mk] || [];
            const dow = (date.getDay() + 6) % 7;
            const applicable = monthRules
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
                    if (isFixedForShiftOnDate(doc, date, shift)) {
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
                    .filter(doc => isFixedForShiftOnDate(doc, date, shift) || isFlexAvailableOnDate(doc, date, shift))
                    .sort((a, b) => (recoveryDebt[b.id] || 0) - (recoveryDebt[a.id] || 0));

                for (const doc of candidates) {
                    if (arr.length >= DOCTORS_PER_SHIFT) break;
                    arr.push(doc.id);
                    recoveryDebt[doc.id]--;
                    if (recoveryDebt[doc.id] <= 0) delete recoveryDebt[doc.id];
                }
            });
        });
    }

    // Helper: count total days assigned this month for a terceiro (for load balancing)
    function getTerceiroMonthDays(tercId, dates) {
        const assigned = new Set();
        dates.forEach(d => {
            SHIFTS.forEach(s => {
                if (getAssignedForShift(d, s).includes(tercId)) assigned.add(dateKey(d));
            });
        });
        return assigned.size;
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
    // PASS 2.7: Terceiros (after fixed, before extra-hours doctors)
    // =========================================
    dates.forEach(date => {
        const dk = dateKey(date);
        SHIFTS.forEach(shift => {
            const { arr } = getSk(date, shift);
            while (arr.length < DOCTORS_PER_SHIFT) {
                const candidates = terceiros
                    .filter(t => !arr.includes(t.id))
                    .filter(t => {
                        const avail = t.monthlyAvailability || {};
                        return avail[dk] && avail[dk][shift];
                    })
                    .filter(t => !needsRestAfterNight(t.id, date, shift))
                    .filter(t => shift !== 'night' || !hasNextDayConflict(t.id, date))
                    .filter(t => !workedOtherWeekendDay(t.id, date))
                    .map(t => ({ t, days: getTerceiroMonthDays(t.id, dates) }))
                    .sort((a, b) => a.days - b.days);

                if (candidates.length === 0) break;
                arr.push(candidates[0].t.id);
            }
        });
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
});

// ---- Clear week ----
document.getElementById('clear-week-btn').addEventListener('click', () => {
    if (!confirm(`Tem a certeza que deseja limpar toda a escala de ${MONTH_NAMES[currentSchedMonth]} ${currentSchedYear}?`)) return;
    const dates = getMonthDates();
    dates.forEach(date => {
        const sched = getScheduleForDate(date);
        SHIFTS.forEach(shift => {
            const sk = shiftKey(date, shift);
            delete sched[sk];
        });
    });
    save();
    renderSchedule();
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
    L('5. Tarefeiros          — só dias com disponibilidade marcada; nunca sáb+dom na mesma semana.');
    L('6. Turnos 24h          — só médicos com flag "Pode 24h"; só se ambos os slots (D+N) estiverem vazios.');
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

        // Monthly day rules summary
        let rulesSummary = '';
        const docRules = doc.monthlyDayRules || {};
        const curMk = monthKey(curYear, curMonth);
        const curRules = docRules[curMk] || [];
        if (curRules.length > 0) {
            const parts = curRules.map(r => {
                const shiftLabel = r.shiftType === '24h' ? '24h' : r.shiftType === 'day' ? 'D' : 'N';
                return `${r.count}× ${DAYS[r.dayOfWeek]} ${shiftLabel}`;
            });
            rulesSummary = `<div class="rule-summary">Regras ${MONTH_NAMES[curMonth]}: ${parts.join(' + ')}</div>`;
        }

        html += `<div class="doctor-card">
            <div class="doctor-card-header">
                <div>
                    <h3>${doc.name}</h3>
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

// ---- Monthly Day Rules ----
function rulesMonthKey() {
    return monthKey(modalRulesYear, modalRulesMonth);
}

function renderRulesSection() {
    const mk = rulesMonthKey();
    document.getElementById('rules-month-label').textContent =
        `${MONTH_NAMES[modalRulesMonth]} ${modalRulesYear}`;

    const rules = modalRulesData[mk] || [];
    const container = document.getElementById('rules-list');

    if (rules.length === 0) {
        container.innerHTML = '<div class="rules-list-empty">Nenhuma regra para este mês. Clique "+ Regra" para adicionar.</div>';
        return;
    }

    let html = '';
    rules.forEach((rule, idx) => {
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

    // Event listeners
    container.querySelectorAll('.rule-dow').forEach(sel => {
        sel.addEventListener('change', () => {
            const mk = rulesMonthKey();
            modalRulesData[mk][parseInt(sel.dataset.idx)].dayOfWeek = parseInt(sel.value);
        });
    });
    container.querySelectorAll('.rule-count').forEach(inp => {
        inp.addEventListener('change', () => {
            const mk = rulesMonthKey();
            modalRulesData[mk][parseInt(inp.dataset.idx)].count = parseInt(inp.value) || 1;
        });
    });
    container.querySelectorAll('.rule-shift').forEach(sel => {
        sel.addEventListener('change', () => {
            const mk = rulesMonthKey();
            modalRulesData[mk][parseInt(sel.dataset.idx)].shiftType = sel.value;
        });
    });
    container.querySelectorAll('.rule-delete').forEach(btn => {
        btn.addEventListener('click', () => {
            const mk = rulesMonthKey();
            modalRulesData[mk].splice(parseInt(btn.dataset.idx), 1);
            if (modalRulesData[mk].length === 0) delete modalRulesData[mk];
            renderRulesSection();
        });
    });
}

document.getElementById('add-rule-btn').addEventListener('click', () => {
    const mk = rulesMonthKey();
    if (!modalRulesData[mk]) modalRulesData[mk] = [];
    modalRulesData[mk].push({ dayOfWeek: 3, shiftType: '24h', count: 1 }); // default: Quinta, 24h, 1x
    renderRulesSection();
});

document.getElementById('rules-prev-month').addEventListener('click', () => {
    modalRulesMonth--;
    if (modalRulesMonth < 0) { modalRulesMonth = 11; modalRulesYear--; }
    renderRulesSection();
});
document.getElementById('rules-next-month').addEventListener('click', () => {
    modalRulesMonth++;
    if (modalRulesMonth > 11) { modalRulesMonth = 0; modalRulesYear++; }
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
    modalRulesData = {};
    modalRulesMonth = new Date().getMonth();
    modalRulesYear = new Date().getFullYear();
    renderRulesSection();
    renderMonthlyCalendar();
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

    modalRulesData = JSON.parse(JSON.stringify(doc.monthlyDayRules || {}));
    modalRulesMonth = new Date().getMonth();
    modalRulesYear = new Date().getFullYear();
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
    rotations = rotations.filter(r => r.doctorA !== id && r.doctorB !== id);
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
        monthlyDayRules: { ...modalRulesData },
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
function renderTerceiros() {
    const list = document.getElementById('terceiros-list');
    if (terceiros.length === 0) {
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

    let html = '';
    terceiros.forEach(t => {
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
                    <h3>${t.name} <span style="font-size:11px;background:#8e44ad;color:#fff;border-radius:4px;padding:2px 6px;font-weight:600">TAREFEIRO</span></h3>
                    <span class="specialty">${t.specialty || '—'}</span>
                </div>
            </div>
            <div class="info-row">
                ${t.phone ? `<span>📞 ${t.phone}</span>` : ''}
                ${t.email ? `<span>✉ ${t.email}</span>` : ''}
            </div>
            <div class="avail-summary">Disponível em ${availCount} dias — ${MONTH_NAMES[curMonth]} ${curYear}</div>
            <div class="card-actions write-only">
                <button class="btn btn-sm" onclick="editTerceiro('${t.id}')">Editar</button>
                <button class="btn btn-sm btn-danger" onclick="deleteTerceiro('${t.id}')">Eliminar</button>
            </div>
        </div>`;
    });

    list.innerHTML = html;
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
        const dayCls = avail.day ? 'avail-yes' : '';
        const nightCls = avail.night ? 'avail-yes' : '';
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
    document.getElementById('terc-modal-title').textContent = 'Adicionar Tarefeiro';
    terceiroForm.reset();
    document.getElementById('terc-id').value = '';
    modalTercAvailData = {};
    modalTercAvailMonth = new Date().getMonth();
    modalTercAvailYear = new Date().getFullYear();
    renderTercModalCalendar();
    terceiroModal.classList.add('open');
});

window.editTerceiro = function(id) {
    const t = terceiros.find(x => x.id === id);
    if (!t) return;
    document.getElementById('terc-modal-title').textContent = 'Editar Tarefeiro';
    document.getElementById('terc-id').value = t.id;
    document.getElementById('terc-name').value = t.name;
    document.getElementById('terc-specialty').value = t.specialty || '';
    document.getElementById('terc-phone').value = t.phone || '';
    document.getElementById('terc-email').value = t.email || '';
    modalTercAvailData = JSON.parse(JSON.stringify(t.monthlyAvailability || {}));
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
    const tData = {
        id,
        name: document.getElementById('terc-name').value.trim(),
        specialty: document.getElementById('terc-specialty').value.trim(),
        phone: document.getElementById('terc-phone').value.trim(),
        email: document.getElementById('terc-email').value.trim(),
        monthlyAvailability: { ...modalTercAvailData },
    };
    const idx = terceiros.findIndex(x => x.id === id);
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

    for (let day = 1; day <= daysInMonth; day++) {
        const date = new Date(year, month, day);
        SHIFTS.forEach(shift => {
            // Skip if doctor is on vacation or unavailable that day
            if (isMonthlyUnavailable(doc, date, shift)) return;
            if (doc.fixedMonthly) {
                const fmd = doc.fixedMonthlyData || {};
                const dk = dateKey(date);
                if (fmd[dk] && fmd[dk][shift]) hours += HOURS_PER_SHIFT;
            } else {
                const dayIdx = (date.getDay() + 6) % 7;
                const key = `${dayIdx}_${shift}`;
                if (doc.fixedSchedule && doc.fixedSchedule[key]) hours += HOURS_PER_SHIFT;
            }
        });
    }

    // Add rule-based hours: iterate actual occurrences of each rule's day-of-week
    // and subtract those that fall on vacation/unavailability
    const mk = monthKey(year, month);
    const rules = (doc.monthlyDayRules && doc.monthlyDayRules[mk]) || [];
    rules.forEach(rule => {
        const shifts = rule.shiftType === '24h' ? ['day', 'night'] : [rule.shiftType];
        // Collect all dates in month matching this rule's day-of-week
        const matchingDates = [];
        for (let day = 1; day <= daysInMonth; day++) {
            const date = new Date(year, month, day);
            const dow = (date.getDay() + 6) % 7;
            if (dow === rule.dayOfWeek) matchingDates.push(date);
        }
        // Count up to rule.count occurrences, skipping unavailable days
        let counted = 0;
        for (const date of matchingDates) {
            if (counted >= rule.count) break;
            const unavailable = shifts.some(s => isMonthlyUnavailable(doc, date, s));
            if (!unavailable) {
                hours += shifts.length * HOURS_PER_SHIFT;
                counted++;
            }
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
        html += `<td class="doctor-name">${doc.name}</td>`;
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
        yHtml += `<td class="doctor-name">${doc.name}</td>`;
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
        rotations
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
            rotations = data.rotations || [];
            save();
            renderSchedule();
            renderDoctors();
            renderTerceiros();
            renderRotations();
            showSaveStatus('Importado!');
            alert(`Dados importados com sucesso!\n${doctors.length} médicos, ${terceiros.length} terceiros, ${rotations.length} rotações.`);
        } catch (err) {
            alert('Erro ao ler o ficheiro: ' + err.message);
        }
    };
    reader.readAsText(file);
}

function showSaveStatus(msg) {
    const el = document.getElementById('save-status');
    el.textContent = msg || '✓ Guardado';
    el.classList.add('saved');
    setTimeout(() => {
        el.textContent = '✓ Guardado';
        el.classList.remove('saved');
    }, 2000);
}

document.getElementById('history-btn').addEventListener('click', openHistoryModal);
document.getElementById('pdf-btn').addEventListener('click', generatePDF);

function generatePDF() {
    const year = currentSchedYear;
    const month = currentSchedMonth;
    const dates = getMonthDates();

    // Build calendar weeks
    const firstDow = (dates[0].getDay() + 6) % 7; // 0=Mon
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

    const dayHeaders = ['Seg','Ter','Qua','Qui','Sex','Sáb','Dom'];

    let totalAssigned = 0;
    let totalSlots = 0;

    const weeksHtml = weeks.map(w => {
        const cells = w.map(d => {
            if (!d) return `<td class="pcal-empty"></td>`;
            const dk = dateKey(d);
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

    const filledPct = totalSlots > 0 ? Math.round((totalAssigned / totalSlots) * 100) : 0;
    const now = new Date().toLocaleDateString('pt-PT');

    const html = `<div class="print-header">
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
    </div>
    <table class="pcal">
        <thead><tr>${dayHeaders.map(h => `<th>${h}</th>`).join('')}</tr></thead>
        <tbody>${weeksHtml}</tbody>
    </table>
    <div class="print-footer">
        <span>Gerado em ${now}</span>
        <span>${doctors.length} médicos · ${totalAssigned}/${totalSlots} turnos preenchidos (${filledPct}%)</span>
    </div>`;

    document.getElementById('print-view').innerHTML = html;
    window.print();
}
document.getElementById('import-file').addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
        importData(e.target.files[0]);
        e.target.value = '';
    }
});

// ---- Init ----
initAuth();
