/* =========================================================
   Basic Robotics – script.js
   Role: UI + Router + Rendering (no direct Firestore I/O)
   Firestore access is delegated to firebase.js adapters.
   ========================================================= */

(() => {
  'use strict';

  /* -------------------------------------------------------
   * Globals kept intentionally small + namespaced
   * ----------------------------------------------------- */
  const APP = {
    booted: false,
    currentSection: null,
    lastSection: null,
    sections: new Map(), // id -> {enter, exit}
    cache: {
      questionsManifest: null, // questions.json
      lecturesList: null,      // lectures.json
      decks: new Map(),        // deckName -> array of Qs
    },
    ui: {
      toastContainer: null,
      srStatus: null,
      score: { correct: 0, wrong: 0, skipped: 0 },
      progressBar: null,
      progressText: null,
      softRefreshBtn: null,
    },
    run: {
      mode: null,           // 'practice' | 'mistakes'
      deckName: null,
      questions: [],
      index: 0,
      correct: 0,
      wrong: 0,
      skipped: 0,
      optionsPerQ: 4,
    },
    meter: {
      reads: 0,
      writes: 0,
      deletes: 0,
      logTimer: null
    },
    // Firebase adapter is injected by firebase.js later
    FB: {
      // auth/ui gates
      signIn: () => {},
      signOut: () => {},
      // lifecycle; firebase.js should call these UI hooks:
      // UI.onAuth({ user, isAdmin, approved })
      // UI.onRoleChange({ isAdmin })
      // UI.onApprovalChange({ approved })
      // practice/session
      commitSession: async (_payload) => {},
      // tasks
      fetchWeekTasksStudent: async () => ([]),
      toggleTaskCompletion: async (_taskId, _checked) => {},
      // admin tasks
      fetchWeekTasksAdmin: async () => ([]),
      createTask: async (_task) => {},
      deleteTask: async (_taskId) => {},
      // progress
      fetchStudentProgress: async () => ({}),
      fetchAllApprovedStudents: async () => ([]),
      fetchAdminStudentProgress: async (_uid) => ({}),
      // leaderboards
      fetchCourseLeaderboard: async () => ([]),
      subscribeWeeklyLeaderboard: (_cb) => ({ unsubscribe: () => {} }),
      // submissions (admin)
      fetchTasksForSelect: async () => ([]),
      fetchSubmissionsForTask: async (_taskId) => ([]),
      scoreSubmission: async (_taskId, _uid, _score) => {},
      // attendance
      fetchStudentAttendance: async (_uid) => ([]),
      loadAttendanceAdmin: async (_date) => ([]), // [{uid, name, present}]
      saveAttendanceAdmin: async (_date, _classNo, _rows) => ({writes: 0}),
      loadAttendanceHistoryAdmin: async (_date) => ([]),
      // approvals/admin
      fetchApprovals: async () => ([]),
      approveUser: async (_uid) => {},
      // manage students
      fetchStudentsForManage: async () => ([]),
      resetStudent: async (_uid) => ({writes:0, deletes:0}),
      deleteStudent: async (_uid) => ({writes:0, deletes:0}),
      // reset DB (admin)
      resetDatabase: async () => ({ writes: 0, deletes: 0 }),
      // subscriptions lifecycle
      onSectionEnter: async (_id) => {},
      onSectionExit: async (_id) => {},
    }
  };

  // Expose meter so firebase.js can increment real costs
  window.__meter_read  = (n = 1) => { APP.meter.reads += n; };
  window.__meter_write = (n = 1) => { APP.meter.writes += n; };
  window.__meter_delete = (n = 1) => { APP.meter.deletes += n; };

  // Allow firebase.js to inject its adapter safely
  window.__bindFirebaseAdapters = function bindFirebaseAdapters(fbAdapters) {
    APP.FB = Object.assign(APP.FB, fbAdapters || {});
    console.debug('[adapter] Firebase adapters bound.');
  };

  /* -------------------------------------------------------
   * Utilities
   * ----------------------------------------------------- */
  const $ = (id) => document.getElementById(id);
  const bySel = (sel, root = document) => root.querySelector(sel);
  const bySelAll = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function setHidden(el, hide = true) {
    if (!el) return;
    el.classList.toggle('hidden', !!hide);
  }

  function safeText(s) {
    return (s ?? '').toString();
  }

  function setSRStatus(msg) {
    APP.ui.srStatus.textContent = msg;
  }

  function toast(msg, type = 'success', ttl = 3000) {
    const host = APP.ui.toastContainer;
    if (!host) return;

    const card = document.createElement('div');
    card.className = `toast ${type}`;
    card.textContent = msg;
    host.appendChild(card);
    // Force reflow to enable transition
    requestAnimationFrame(() => card.classList.add('show'));

    setTimeout(() => {
      card.classList.remove('show');
      setTimeout(() => card.remove(), 200);
    }, ttl);
  }

  function humanDate(dateStr) {
    const d = (dateStr instanceof Date) ? dateStr : new Date(dateStr);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString();
  }

  // Console meter reporter (1x/min + after refreshAll)
  function scheduleMeterLog() {
    clearTimeout(APP.meter.logTimer);
    APP.meter.logTimer = setTimeout(() => {
      logMeter('[idle]');
      scheduleMeterLog();
    }, 60_000);
  }

  function logMeter(tag = '') {
    const { reads, writes, deletes } = APP.meter;
    if (reads + writes + deletes === 0) return;
    console.groupCollapsed(`Firestore Meter ${tag}: R=${reads} W=${writes} D=${deletes}`);
    console.log({ reads, writes, deletes });
    console.groupEnd();
  }

  /* -------------------------------------------------------
   * CSV parsing (robust, quote/newline/BOM safe)
   * ----------------------------------------------------- */
  function parseCSV(text) {
    // remove UTF-8 BOM
    if (text.charCodeAt(0) === 0xFEFF) {
      text = text.slice(1);
    }
    const rows = [];
    let row = [];
    let i = 0, cur = '', inQuotes = false;

    const pushCell = () => { row.push(cur); cur = ''; };
    const endRow = () => { rows.push(row); row = []; };

    while (i < text.length) {
      const ch = text[i];

      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') {
            cur += '"';
            i += 2;
            continue;
          } else {
            inQuotes = false;
            i++;
            continue;
          }
        } else {
          cur += ch;
          i++;
          continue;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
          i++;
          continue;
        }
        if (ch === ',') {
          pushCell();
          i++;
          continue;
        }
        if (ch === '\r') { // normalize CRLF/CR to LF handling
          i++;
          continue;
        }
        if (ch === '\n') {
          pushCell();
          endRow();
          i++;
          continue;
        }
        cur += ch;
        i++;
      }
    }
    // flush trailing cell/row
    if (cur.length > 0 || row.length > 0) {
      pushCell();
      endRow();
    }
    return rows;
  }

  async function fetchAndParseCSV(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const text = await res.text();
    const raw = parseCSV(text);
    // Normalize to { front, back, romaji } ignoring blank lines
    const list = raw.map(cols => {
      const word = safeText(cols[0]).trim();
      const meaning = safeText(cols[1]).trim();
      const romaji = safeText(cols[2]).trim();
      return { front: word, back: meaning, romaji };
    }).filter(r => r.front && r.back);
    return list;
  }

  /* -------------------------------------------------------
   * Router + Section lifecycle
   * ----------------------------------------------------- */
  function showSection(id) {
    if (APP.currentSection === id) return;

    const main = $('main');
    const sections = main.querySelectorAll(':scope > section');
    sections.forEach(sec => setHidden(sec, true));

    const el = $(id);
    if (!el) return;
    setHidden(el, false);
    el.focus({ preventScroll: false });

    APP.lastSection = APP.currentSection;
    APP.currentSection = id;

    // Pause listeners for previous section
    if (APP.lastSection && APP.sections.has(APP.lastSection)) {
      const conf = APP.sections.get(APP.lastSection);
      try { conf.exit?.(); } catch (e) { console.warn(e); }
      // notify firebase adapter
      APP.FB.onSectionExit?.(APP.lastSection);
    }

    // Resume/attach listeners for current section
    if (APP.sections.has(id)) {
      const conf = APP.sections.get(id);
      try { conf.enter?.(); } catch (e) { console.warn(e); }
      APP.FB.onSectionEnter?.(id);
    }
  }

  function registerSection(id, { enter, exit } = {}) {
    APP.sections.set(id, { enter, exit });
  }

  /* -------------------------------------------------------
   * Navigation bindings (no inline onclicks)
   * ----------------------------------------------------- */
  function bindNav() {
    // Sidebar nav
    bySelAll('[data-nav]').forEach(btn => {
      btn.addEventListener('click', () => {
        showSection(btn.getAttribute('data-nav'));
      }, { passive: true });
    });

    // Auth buttons
    const authBtn = $('auth-btn');
    if (authBtn) authBtn.addEventListener('click', () => APP.FB.signIn?.());

    const signOutBtn = $('signout-btn');
    if (signOutBtn) signOutBtn.addEventListener('click', () => APP.FB.signOut?.());

    // Practice actions
    $('btn-skip')?.addEventListener('click', onSkip, { passive: true });

    // Mistakes actions
    $('btn-mistakes-start')?.addEventListener('click', startMistakes, { passive: true });
    $('btn-mistakes-clear')?.addEventListener('click', clearMistakes, { passive: true });

    // Refresh
    APP.ui.softRefreshBtn = $('soft-refresh-btn');
    APP.ui.softRefreshBtn?.addEventListener('click', async () => {
      APP.ui.softRefreshBtn.disabled = true;
      try {
        await refreshAll();
        toast('Refreshed.');
        logMeter('[manual-refresh]');
      } catch (e) {
        console.error(e);
        toast('Refresh failed', 'error');
      } finally {
        APP.ui.softRefreshBtn.disabled = false;
      }
    });

    // Attendance tabs
    $('att-tab-take')?.addEventListener('click', () => switchAttTab('take'));
    $('att-tab-history')?.addEventListener('click', () => switchAttTab('history'));
  }

  /* -------------------------------------------------------
   * Gates: manage visibility (called by firebase.js through UI hooks)
   * ----------------------------------------------------- */
  const UI = {
    onAuth({ user, isAdmin, approved }) {
      const gate = $('auth-gate');
      const approvalGate = $('approval-gate');
      const app = $('app-root');

      if (!user) {
        setHidden(gate, false);
        setHidden(approvalGate, true);
        setHidden(app, true);
        return;
      }

      if (!approved && !isAdmin) {
        setHidden(gate, true);
        setHidden(approvalGate, false);
        setHidden(app, true);
        return;
      }

      setHidden(gate, true);
      setHidden(approvalGate, true);
      setHidden(app, false);

      // Admin-only visibility handled by firebase.js, but default-hide here
      bySelAll('.admin-only').forEach(el => setHidden(el, !isAdmin));
      // Show default section
      if (!APP.currentSection) showSection('practice-select');
    },
    onRoleChange({ isAdmin }) {
      bySelAll('.admin-only').forEach(el => setHidden(el, !isAdmin));
    },
    onApprovalChange({ approved }) {
      if (approved) {
        setHidden($('approval-gate'), true);
        setHidden($('app-root'), false);
        if (!APP.currentSection) showSection('practice-select');
      } else {
        setHidden($('approval-gate'), false);
        setHidden($('app-root'), true);
      }
    }
  };

  // Expose so firebase.js can drive the gates
  window.__UI = UI;

  /* -------------------------------------------------------
   * Practice
   * ----------------------------------------------------- */
  async function ensureQuestionsManifest() {
    if (APP.cache.questionsManifest) return APP.cache.questionsManifest;
    const res = await fetch('questions.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('Failed to load questions.json');
    const data = await res.json();
    APP.cache.questionsManifest = data;
    return data;
  }

  function getDeckFilePath(entry) {
    // entry can be a string or object with path
    if (!entry) return null;
    if (typeof entry === 'string') return entry;
    if (entry.path) return entry.path;
    if (entry.file) return entry.file;
    return null;
  }

  async function renderPracticeSelect() {
    const box = $('practice-buttons');
    if (!box) return;
    box.innerHTML = '';

    const manifest = await ensureQuestionsManifest();
    const frag = document.createDocumentFragment();

    (manifest.decks || manifest || []).forEach((entry) => {
      const name = entry.name || entry.title || getDeckFilePath(entry) || 'Deck';
      const btn = document.createElement('button');
      btn.textContent = name;
      btn.setAttribute('type', 'button');
      btn.addEventListener('click', () => startPractice(name, entry), { passive: true });
      frag.appendChild(btn);
    });

    box.appendChild(frag);
    $('practice-status').textContent = `Loaded ${ (manifest.decks || manifest || []).length } decks`;
  }

  async function ensureDeckLoaded(name, entry) {
    if (APP.cache.decks.has(name)) return APP.cache.decks.get(name);
    const path = getDeckFilePath(entry);
    if (!path) throw new Error(`No file for deck ${name}`);
    const qs = await fetchAndParseCSV(path);
    APP.cache.decks.set(name, qs);
    return qs;
  }

  function updateScoreUI() {
    const { correct, wrong, skipped } = APP.run;
    $('correct').textContent = correct;
    $('wrong').textContent = wrong;
    $('skipped').textContent = skipped;
  }

  function updateProgressUI() {
    const total = APP.run.questions.length || 0;
    const done = Math.min(APP.run.index, total);
    const pct = total ? Math.round((done / total) * 100) : 0;
    if (APP.ui.progressBar) APP.ui.progressBar.style.width = `${pct}%`;
    if (APP.ui.progressText) APP.ui.progressText.textContent = `${done} / ${total} (${pct}%)`;
  }

  function pickOptions(correctItem, pool, n = 4) {
    const opts = [correctItem.back];
    const seen = new Set([correctItem.back]);
    // simple distractor sampling
    for (let i = 0; i < pool.length && opts.length < n; i++) {
      const idx = Math.floor(Math.random() * pool.length);
      const cand = pool[idx]?.back;
      if (cand && !seen.has(cand)) {
        opts.push(cand);
        seen.add(cand);
      }
    }
    // shuffle
    for (let i = opts.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [opts[i], opts[j]] = [opts[j], opts[i]];
    }
    return opts;
  }

  function renderQuestion() {
    const qBox = $('question-box');
    const optList = $('options');
    if (!qBox || !optList) return;

    const idx = APP.run.index;
    const item = APP.run.questions[idx];
    if (!item) {
      // End
      finishPractice();
      return;
    }

    qBox.innerHTML = '';
    const word = document.createElement('div');
    word.style.fontSize = '1.4rem';
    word.style.fontWeight = '700';
    word.textContent = item.front;

    const meaning = document.createElement('div');
    meaning.className = 'muted';
    meaning.style.marginTop = '6px';
    meaning.textContent = item.romaji ? `${item.back} (${item.romaji})` : item.back;

    qBox.appendChild(word);
    qBox.appendChild(meaning);

    // Options
    optList.innerHTML = '';
    const options = pickOptions(item, APP.run.questions, APP.run.optionsPerQ);
    const frag = document.createDocumentFragment();
    options.forEach((txt) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.textContent = txt;
      btn.addEventListener('click', () => onAnswer(txt === item.back), { passive: true });
      li.appendChild(btn);
      frag.appendChild(li);
    });
    optList.appendChild(frag);

    updateProgressUI();
  }

  function onAnswer(correct) {
    if (correct) {
      APP.run.correct++;
      toast('✅ Correct', 'success', 1200);
    } else {
      APP.run.wrong++;
      toast('❌ Wrong', 'warn', 1500);
      pushMistake(APP.run.questions[APP.run.index]);
    }
    updateScoreUI();
    APP.run.index++;
    renderQuestion();
  }

  function onSkip() {
    APP.run.skipped++;
    updateScoreUI();
    APP.run.index++;
    renderQuestion();
  }

  async function finishPractice() {
    // Commit session to Firestore via adapter (debounced in firebase.js)
    try {
      const total = APP.run.correct + APP.run.wrong + APP.run.skipped;
      if (total > 0) {
        await APP.FB.commitSession({
          deckName: APP.run.deckName,
          mode: 'practice',
          correct: APP.run.correct,
          wrong: APP.run.wrong,
          skipped: APP.run.skipped,
          total
        });
      }
    } catch (e) {
      console.warn('[practice commit] skipped:', e?.message || e);
    }

    toast('Finished practice!');
    showSection('practice-select');
  }

  async function startPractice(name, entry) {
    APP.run.mode = 'practice';
    APP.run.deckName = name;
    APP.run.questions = await ensureDeckLoaded(name, entry);
    // Simple shuffle for practice order
    APP.run.questions = APP.run.questions.slice().sort(() => Math.random() - 0.5);
    APP.run.index = 0;
    APP.run.correct = 0;
    APP.run.wrong = 0;
    APP.run.skipped = 0;
    updateScoreUI();
    showSection('practice');
    renderQuestion();
  }

  /* -------------------------------------------------------
   * Mistakes (localStorage, capped at 200)
   * ----------------------------------------------------- */
  function getMistakes() {
    try {
      const raw = localStorage.getItem('mistakes');
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  function setMistakes(arr) {
    try {
      localStorage.setItem('mistakes', JSON.stringify(arr.slice(0, 200)));
    } catch {}
  }

  function pushMistake(item) {
    const arr = getMistakes();
    arr.unshift({ front: item.front, back: item.back, romaji: item.romaji || '' });
    // dedupe by front/back
    const seen = new Set();
    const deduped = [];
    for (const it of arr) {
      const key = `${it.front}__${it.back}`;
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(it);
      }
      if (deduped.length >= 200) break;
    }
    setMistakes(deduped);
  }

  function startMistakes() {
    const items = getMistakes();
    if (!items.length) {
      toast('No mistakes saved yet.', 'warn');
      return;
    }
    APP.run.mode = 'mistakes';
    APP.run.deckName = 'Mistakes';
    APP.run.questions = items.slice().sort(() => Math.random() - 0.5);
    APP.run.index = 0;
    APP.run.correct = 0;
    APP.run.wrong = 0;
    APP.run.skipped = 0;
    updateScoreUI();
    showSection('practice');
    renderQuestion();
  }

  function clearMistakes() {
    setMistakes([]);
    toast('Mistakes cleared.');
  }

  /* -------------------------------------------------------
   * Lectures
   * ----------------------------------------------------- */
  async function ensureLectures() {
    if (APP.cache.lecturesList) return APP.cache.lecturesList;
    const res = await fetch('lectures.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('Failed to load lectures.json');
    const data = await res.json();
    APP.cache.lecturesList = data;
    return data;
  }

  async function renderLectures() {
    const list = $('lectures-list');
    const status = $('lectures-status');
    if (!list || !status) return;

    list.innerHTML = '';
    const data = await ensureLectures();
    const items = data.lectures || data || [];
    if (!items.length) {
      status.textContent = 'No lectures available.';
      return;
    }
    status.textContent = `Loaded ${items.length} lectures`;

    const frag = document.createDocumentFragment();
    items.forEach((it) => {
      const a = document.createElement('a');
      a.href = it.url || it.link || '#';
      a.target = '_blank';
      a.rel = 'noopener';
      a.innerHTML = `<b>${safeText(it.title || 'Lecture')}</b><br><span class="muted">${safeText(it.desc || '')}</span>`;
      frag.appendChild(a);
    });
    list.appendChild(frag);
  }

  /* -------------------------------------------------------
   * Tasks (Student/Admin)
   * ----------------------------------------------------- */
  async function renderTasksStudent() {
    const host = $('task-student-list');
    const container = $('tasks-student');
    if (!host || !container) return;

    const items = await APP.FB.fetchWeekTasksStudent();
    setHidden(container, false);
    host.innerHTML = '';

    if (!items.length) {
      host.textContent = 'No tasks assigned this week.';
      return;
    }

    const frag = document.createDocumentFragment();
    items.forEach((t) => {
      const li = document.createElement('div');
      li.className = 'task-row';
      const left = document.createElement('div');
      const right = document.createElement('div');

      left.innerHTML = `
        <div><b>${safeText(t.title)}</b></div>
        <div class="muted">${t.desc ? safeText(t.desc) : ''}</div>
        ${t.link ? `<div><a href="${t.link}" target="_blank" rel="noopener">Reference</a></div>` : ''}
        ${t.due ? `<div class="muted">Due: ${humanDate(t.due)}</div>` : ''}
      `;

      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.checked = !!t.done;
      chk.addEventListener('change', async () => {
        try {
          await APP.FB.toggleTaskCompletion(t.id, chk.checked);
          toast(chk.checked ? 'Task marked done' : 'Task unchecked');
        } catch (e) {
          chk.checked = !chk.checked;
          toast('Failed to update task', 'error');
        }
      });
      right.appendChild(chk);

      li.appendChild(left);
      li.appendChild(right);
      frag.appendChild(li);
    });
    host.appendChild(frag);
  }

  function validateAdminTaskInput() {
    const title = $('task-title').value.trim();
    const link = $('task-link').value.trim();
    const due = $('task-due').value;
    const max = parseInt($('task-max').value, 10);
    const desc = $('task-desc').value.trim();

    const errors = [];
    if (!title) errors.push('Title is required.');
    if (Number.isNaN(max) || max < 0) errors.push('Score must be a non-negative number.');

    return { ok: errors.length === 0, errors, payload: { title, link, due: due || null, max: max || 0, desc } };
  }

  async function renderTasksAdmin() {
    const wrap = $('tasks-admin');
    const list = $('task-admin-list');
    const btnCreate = $('task-create');
    if (!wrap || !list || !btnCreate) return;

    // Bind once
    if (!btnCreate.__bound) {
      btnCreate.addEventListener('click', async () => {
        const { ok, errors, payload } = validateAdminTaskInput();
        if (!ok) { toast(errors.join(' '), 'warn'); return; }
        btnCreate.disabled = true;
        try {
          await APP.FB.createTask(payload);
          $('task-title').value = '';
          $('task-link').value = '';
          $('task-due').value = '';
          $('task-max').value = '';
          $('task-desc').value = '';
          await renderTasksAdmin(); // refresh list
          toast('Task created.');
        } catch (e) {
          console.error(e);
          toast('Failed to create task', 'error');
        } finally {
          btnCreate.disabled = false;
        }
      });
      btnCreate.__bound = true;
    }

    const items = await APP.FB.fetchWeekTasksAdmin();
    list.innerHTML = '';
    if (!items.length) {
      list.textContent = 'No tasks created this week.';
      return;
    }

    const frag = document.createDocumentFragment();
    items.forEach(t => {
      const row = document.createElement('div');
      row.className = 'task-row';
      const left = document.createElement('div');
      left.innerHTML = `<div><b>${safeText(t.title)}</b> <span class="muted">(${t.max ?? 0} pts)</span></div>
                        ${t.desc ? `<div class="muted">${safeText(t.desc)}</div>` : ''}
                        ${t.link ? `<div><a href="${t.link}" target="_blank" rel="noopener">Reference</a></div>` : ''}
                        ${t.due ? `<div class="muted">Due: ${humanDate(t.due)}</div>` : ''}`;
      const right = document.createElement('div');
      const del = document.createElement('button');
      del.textContent = 'Delete';
      del.className = 'danger';
      del.addEventListener('click', async () => {
        if (!confirm('Delete this task?')) return;
        del.disabled = true;
        try {
          await APP.FB.deleteTask(t.id);
          row.remove();
          toast('Task deleted.');
        } catch (e) {
          console.error(e);
          toast('Failed to delete task', 'error');
        } finally {
          del.disabled = false;
        }
      });
      right.appendChild(del);

      row.appendChild(left);
      row.appendChild(right);
      frag.appendChild(row);
    });
    list.appendChild(frag);
  }

  /* -------------------------------------------------------
   * Progress
   * ----------------------------------------------------- */
  async function renderProgressStudent() {
    const tbody = $('progress-stu-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    const agg = await APP.FB.fetchStudentProgress();
    const rows = [
      ['Practice', agg.practice ?? 0],
      ['Tasks', agg.tasks ?? 0],
      ['Attendance', agg.attendance ?? 0],
      ['Exam', agg.exam ?? 0],
    ];

    const frag = document.createDocumentFragment();
    rows.forEach(([label, val]) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td data-th="Metric">${label}</td><td data-th="Score">${val}</td><td data-th="—"></td><td data-th="—"></td>`;
      frag.appendChild(tr);
    });
    tbody.appendChild(frag);
  }

  async function renderProgressAdmin() {
    const sel = $('progress-student-select');
    const loadBtn = $('progress-load');
    const nameSpan = $('progress-student-name');
    const tbody = $('progress-admin-tbody');
    const status = $('progress-admin-status');
    if (!sel || !loadBtn || !tbody) return;

    status.textContent = 'Loading students...';
    const students = await APP.FB.fetchAllApprovedStudents();
    sel.innerHTML = '';
    const frag = document.createDocumentFragment();
    students.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.uid;
      opt.textContent = s.displayName || s.uid;
      frag.appendChild(opt);
    });
    sel.appendChild(frag);
    status.textContent = `${students.length} students`;

    if (!loadBtn.__bound) {
      loadBtn.addEventListener('click', async () => {
        const uid = sel.value;
        if (!uid) return;
        nameSpan.textContent = sel.options[sel.selectedIndex]?.textContent || uid;
        tbody.innerHTML = '';
        const agg = await APP.FB.fetchAdminStudentProgress(uid);
        const rows = [
          ['Practice', agg.practice ?? 0],
          ['Tasks', agg.tasks ?? 0],
          ['Attendance', agg.attendance ?? 0],
          ['Exam', agg.exam ?? 0],
        ];
        const f = document.createDocumentFragment();
        rows.forEach(([label, val]) => {
          const tr = document.createElement('tr');
          tr.innerHTML = `<td data-th="Metric">${label}</td><td data-th="Score">${val}</td><td data-th="—"></td><td data-th="—"></td>`;
          f.appendChild(tr);
        });
        tbody.appendChild(f);
      });
      loadBtn.__bound = true;
    }
  }

  /* -------------------------------------------------------
   * Leaderboards
   * ----------------------------------------------------- */
  async function renderCourseLeaderboard() {
    const list = $('course-leaderboard-list');
    if (!list) return;
    list.innerHTML = '';
    const rows = await APP.FB.fetchCourseLeaderboard(); // on-demand (no idle reads)
    if (!rows.length) {
      list.innerHTML = '<li>No data yet.</li>';
      return;
    }
    const frag = document.createDocumentFragment();
    rows.forEach((r, i) => {
      const li = document.createElement('li');
      li.textContent = `${i + 1}. ${safeText(r.name)} — ${r.score}`;
      frag.appendChild(li);
    });
    list.appendChild(frag);
  }

  // Weekly: subscribe only while visible
  let weeklyLBUnsub = null;
  async function enterWeeklyLeaderboard() {
    const list = $('weekly-leaderboard-list');
    if (!list) return;
    list.innerHTML = '<li>Loading...</li>';
    weeklyLBUnsub = APP.FB.subscribeWeeklyLeaderboard((rows) => {
      list.innerHTML = '';
      if (!rows?.length) {
        list.innerHTML = '<li>No data yet.</li>';
        return;
      }
      const frag = document.createDocumentFragment();
      rows.forEach((r, i) => {
        const li = document.createElement('li');
        li.textContent = `${i + 1}. ${safeText(r.name)} — ${r.score}`;
        frag.appendChild(li);
      });
      list.appendChild(frag);
    });
  }
  function exitWeeklyLeaderboard() {
    try { weeklyLBUnsub?.unsubscribe?.(); } catch {}
    weeklyLBUnsub = null;
  }

  /* -------------------------------------------------------
   * Submissions (Admin)
   * ----------------------------------------------------- */
  async function renderAdminSubmissions() {
    const sel = $('sub-task-select');
    const tbody = $('submissions-tbody');
    const btn = $('sub-refresh');
    if (!sel || !tbody || !btn) return;

    // Load tasks into select once at enter
    const tasks = await APP.FB.fetchTasksForSelect();
    sel.innerHTML = '';
    const f = document.createDocumentFragment();
    tasks.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = `${t.title} (${t.max ?? 0} pts)`;
      f.appendChild(opt);
    });
    sel.appendChild(f);

    async function loadSubs() {
      const taskId = sel.value;
      tbody.innerHTML = '';
      if (!taskId) return;
      const subs = await APP.FB.fetchSubmissionsForTask(taskId);
      if (!subs.length) {
        tbody.innerHTML = '<tr><td colspan="4">No submissions yet.</td></tr>';
        return;
      }
      const frag = document.createDocumentFragment();
      subs.forEach((s) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td data-th="Student">${safeText(s.name || s.uid)}</td>
          <td data-th="Submission">${s.link ? `<a href="${s.link}" target="_blank" rel="noopener">Open</a>` : '—'}</td>
          <td data-th="Score"><input type="number" min="0" step="1" value="${Number(s.score ?? 0)}" style="max-width:100px"></td>
          <td data-th="Actions"><button>Save</button></td>
        `;
        const input = tr.querySelector('input');
        const btn = tr.querySelector('button');
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try {
            const score = parseInt(input.value, 10) || 0;
            await APP.FB.scoreSubmission(taskId, s.uid, score);
            toast('Score saved.');
          } catch (e) {
            console.error(e);
            toast('Failed to save score', 'error');
          } finally {
            btn.disabled = false;
          }
        });
        frag.appendChild(tr);
      });
      tbody.appendChild(frag);
    }

    if (!btn.__bound) {
      btn.addEventListener('click', loadSubs);
      btn.__bound = true;
    }
    await loadSubs();
  }

  /* -------------------------------------------------------
   * Attendance
   * ----------------------------------------------------- */
  function switchAttTab(which) {
    const takeBtn = $('att-tab-take');
    const histBtn = $('att-tab-history');
    const takePane = $('att-pane-take');
    const histPane = $('att-pane-history');

    const takeActive = which === 'take';
    takeBtn.classList.toggle('active', takeActive);
    histBtn.classList.toggle('active', !takeActive);
    setHidden(takePane, !takeActive);
    setHidden(histPane, takeActive);
  }

  async function attendanceAdminEnter() {
    // Bind admin controls
    $('attendance-load')?.addEventListener('click', loadAttendanceAdminOnce);
    $('attendance-mark-all')?.addEventListener('click', markAllPresent);
    $('attendance-clear-all')?.addEventListener('click', clearAllAttendanceMarks);
    $('attendance-save')?.addEventListener('click', saveAttendanceAdmin);
    $('att-hist-load')?.addEventListener('click', loadAttendanceHistoryAdminOnce);
  }

  let _attRows = []; // [{uid, name, present}]
  async function loadAttendanceAdminOnce() {
    const date = $('attendance-date').value;
    if (!date) { toast('Select a date', 'warn'); return; }
    const rows = await APP.FB.loadAttendanceAdmin(date);
    _attRows = rows || [];
    renderAttendanceTable(_attRows);
    $('attendance-note').textContent = `Loaded ${_attRows.length} students for ${date}`;
  }

  function renderAttendanceTable(rows) {
    const tbody = bySel('#attendance-table tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    const frag = document.createDocumentFragment();
    rows.forEach((r, idx) => {
      const tr = document.createElement('tr');
      const name = document.createElement('td');
      name.textContent = r.name || r.uid;
      const present = document.createElement('td');
      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.checked = !!r.present;
      chk.addEventListener('change', () => { _attRows[idx].present = chk.checked; }, { passive: true });
      present.appendChild(chk);
      tr.appendChild(name);
      tr.appendChild(present);
      frag.appendChild(tr);
    });
    tbody.appendChild(frag);
  }

  function markAllPresent() {
    _attRows = _attRows.map(r => ({ ...r, present: true }));
    renderAttendanceTable(_attRows);
  }
  function clearAllAttendanceMarks() {
    _attRows = _attRows.map(r => ({ ...r, present: false }));
    renderAttendanceTable(_attRows);
  }

  async function saveAttendanceAdmin() {
    const date = $('attendance-date').value;
    const classNo = $('attendance-classno').value;
    if (!date || !classNo) { toast('Pick date and class no.', 'warn'); return; }
    const res = await APP.FB.saveAttendanceAdmin(date, classNo, _attRows);
    $('attendance-save-status').textContent = `Saved (${res.writes ?? 0} writes).`;
    toast('Attendance saved.');
  }

  async function loadAttendanceHistoryAdminOnce() {
    const date = $('att-hist-date').value;
    if (!date) { toast('Select a date', 'warn'); return; }
    const rows = await APP.FB.loadAttendanceHistoryAdmin(date);
    const tbody = bySel('#att-hist-table tbody');
    const meta = $('att-hist-meta');
    tbody.innerHTML = '';
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="2">No records.</td></tr>';
      meta.textContent = '—';
      return;
    }
    const frag = document.createDocumentFragment();
    rows.forEach(r => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td data-th="Student">${safeText(r.name || r.uid)}</td><td data-th="Status">${r.present ? 'Present' : 'Absent'}</td>`;
      frag.appendChild(tr);
    });
    tbody.appendChild(frag);
    meta.textContent = `Total: ${rows.length}`;
  }

  async function renderAttendanceStudent() {
    const tbody = bySel('#my-attendance-table tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    const rows = await APP.FB.fetchStudentAttendance('me');
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="3">No attendance yet.</td></tr>';
      return;
    }
    const frag = document.createDocumentFragment();
    rows.forEach(r => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td data-th="Date">${safeText(r.date)}</td><td data-th="Class No">${safeText(r.classNo ?? '')}</td><td data-th="Status">${r.present ? 'Present' : 'Absent'}</td>`;
      frag.appendChild(tr);
    });
    tbody.appendChild(frag);
  }

  /* -------------------------------------------------------
   * Approvals & Manage Students
   * ----------------------------------------------------- */
  async function renderApprovals() {
    const host = $('approvals-list');
    if (!host) return;
    host.innerHTML = '';
    const items = await APP.FB.fetchApprovals();
    if (!items.length) {
      host.textContent = 'No pending approvals.';
      return;
    }
    const frag = document.createDocumentFragment();
    items.forEach(u => {
      const row = document.createElement('div');
      row.className = 'task-row';
      row.innerHTML = `<div><b>${safeText(u.displayName || u.email || u.uid)}</b><div class="muted">${safeText(u.email || '')}</div></div>`;
      const right = document.createElement('div');
      const btn = document.createElement('button');
      btn.textContent = 'Approve';
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await APP.FB.approveUser(u.uid);
          row.remove();
          toast('User approved.');
        } catch (e) {
          console.error(e);
          toast('Failed to approve', 'error');
        } finally {
          btn.disabled = false;
        }
      });
      right.appendChild(btn);
      row.appendChild(right);
      frag.appendChild(row);
    });
    host.appendChild(frag);
  }

  async function renderManageStudents() {
    const tbody = $('admin-students-tbody');
    const refreshBtn = $('admin-refresh-students');
    if (!tbody || !refreshBtn) return;

    async function loadList() {
      tbody.innerHTML = '';
      const list = await APP.FB.fetchStudentsForManage();
      if (!list.length) {
        tbody.innerHTML = '<tr><td colspan="3">No students.</td></tr>';
        return;
      }
      const frag = document.createDocumentFragment();
      list.forEach(s => {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td data-th="Name">${safeText(s.displayName || s.email || s.uid)}</td>
                        <td data-th="UID" style="font-family:monospace;">${safeText(s.uid)}</td>
                        <td data-th="Actions"></td>`;
        const tdActions = tr.lastElementChild;

        const btnReset = document.createElement('button');
        btnReset.textContent = 'Reset';
        btnReset.addEventListener('click', async () => {
          if (!confirm('Reset this student?')) return;
          btnReset.disabled = true;
          try {
            await APP.FB.resetStudent(s.uid);
            toast('Student reset.');
          } catch (e) {
            console.error(e);
            toast('Failed to reset', 'error');
          } finally {
            btnReset.disabled = false;
          }
        });

        const btnDelete = document.createElement('button');
        btnDelete.textContent = 'Delete';
        btnDelete.className = 'danger';
        btnDelete.addEventListener('click', async () => {
          if (!confirm('Delete this student and all related data?')) return;
          btnDelete.disabled = true;
          try {
            await APP.FB.deleteStudent(s.uid);
            tr.remove();
            toast('Student deleted.');
          } catch (e) {
            console.error(e);
            toast('Failed to delete', 'error');
          } finally {
            btnDelete.disabled = false;
          }
        });

        tdActions.appendChild(btnReset);
        tdActions.appendChild(btnDelete);
        frag.appendChild(tr);
      });
      tbody.appendChild(frag);
    }

    if (!refreshBtn.__bound) {
      refreshBtn.addEventListener('click', loadList);
      refreshBtn.__bound = true;
    }
    await loadList();
  }

  /* -------------------------------------------------------
   * Admin: Reset DB
   * ----------------------------------------------------- */
  function bindResetDB() {
    const input = $('resetdb-confirm');
    const btn = $('resetdb-run');
    const status = $('resetdb-status');
    if (!input || !btn) return;

    if (!btn.__bound) {
      btn.addEventListener('click', async () => {
        if ((input.value || '').trim() !== 'I UNDERSTAND') {
          toast('Type: I UNDERSTAND', 'warn');
          input.focus();
          return;
        }
        btn.disabled = true;
        status.textContent = 'Wiping...';
        try {
          const res = await APP.FB.resetDatabase();
          status.textContent = `Done. Writes: ${res.writes ?? 0}, Deletes: ${res.deletes ?? 0}. Signing out...`;
          toast('Database wiped. Signing out...');
          setTimeout(() => APP.FB.signOut?.(), 1000);
        } catch (e) {
          console.error(e);
          status.textContent = 'Failed.';
          toast('Reset failed', 'error');
        } finally {
          btn.disabled = false;
        }
      });
      btn.__bound = true;
    }
  }

  /* -------------------------------------------------------
   * Section registrations
   * ----------------------------------------------------- */
  registerSection('practice-select', {
    enter: () => renderPracticeSelect()
  });

  registerSection('practice', {
    enter: () => {
      APP.ui.progressBar = $('deck-progress-bar');
      APP.ui.progressText = $('deck-progress-text');
      updateProgressUI();
    },
    exit: () => {
      // nothing to unsubscribe here; session commit handled on finish
    }
  });

  registerSection('lectures-section', {
    enter: () => renderLectures()
  });

  registerSection('tasks-section', {
    enter: async () => {
      // firebase.js will toggle admin/student visibility
      await Promise.allSettled([
        renderTasksStudent(),
        renderTasksAdmin()
      ]);
    },
    exit: () => {}
  });

  registerSection('progress-section', {
    enter: async () => {
      await Promise.allSettled([
        renderProgressStudent(),
        renderProgressAdmin()
      ]);
    }
  });

  registerSection('course-leaderboard-section', {
    enter: () => renderCourseLeaderboard()
  });

  registerSection('weekly-leaderboard-section', {
    enter: () => enterWeeklyLeaderboard(),
    exit: () => exitWeeklyLeaderboard()
  });

  registerSection('admin-submissions-section', {
    enter: () => renderAdminSubmissions()
  });

  registerSection('attendance-section', {
    enter: async () => {
      switchAttTab('take');
      await attendanceAdminEnter();
      await renderAttendanceStudent();
    }
  });

  registerSection('admin-approvals-section', {
    enter: () => renderApprovals()
  });

  registerSection('admin-manage-section', {
    enter: () => renderManageStudents()
  });

  registerSection('admin-resetdb-section', {
    enter: () => bindResetDB()
  });

  registerSection('mistakes-section', {});

  /* -------------------------------------------------------
   * Refresh pipeline (manual)
   * ----------------------------------------------------- */
  async function refreshAll() {
    await Promise.allSettled([
      // practice-select: nothing persistent to refresh (manifest cached)
      // lectures:
      ensureLectures().then(renderLectures).catch(() => {}),
      // tasks (student/admin):
      renderTasksStudent().catch(() => {}),
      renderTasksAdmin().catch(() => {}),
      // progress:
      renderProgressStudent().catch(() => {}),
      renderProgressAdmin().catch(() => {}),
      // leaderboards:
      renderCourseLeaderboard().catch(() => {}),
      // submissions (only if visible):
      (APP.currentSection === 'admin-submissions-section' ? renderAdminSubmissions() : Promise.resolve()),
      // attendance student view (self):
      renderAttendanceStudent().catch(() => {}),
    ]);
  }

  /* -------------------------------------------------------
   * Boot
   * ----------------------------------------------------- */
  function boot() {
    if (APP.booted) return;
    APP.booted = true;

    APP.ui.toastContainer = $('toast-container');
    APP.ui.srStatus = $('sr-status');

    bindNav();
    scheduleMeterLog();

    // if firebase.js already authenticated before this file loaded,
    // it should call window.__UI.onAuth(...) again; otherwise app stays gated.
    setSRStatus('Ready.');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
