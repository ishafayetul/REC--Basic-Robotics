/* =========================
   ADMIN: View Submissions - Enhanced with caching
   ========================= */
function wireAdminSubmissions() {
  let section = $("admin-submissions-section");
  if (!section) {
    section = document.createElement("section");
    section.id = "admin-submissions-section";
    section.className = "hidden";
    section.innerHTML = `
      <h2>📥 Admin: View Submissions</h2>
      <div class="card">
        <div class="task-form">
          <select id="subs-task-select"><option value="">Loading tasks…</option></select>
          <button id="subs-refresh">Refresh</button>
        </div>
        <div class="table-wrap" style="margin-top:10px;">
          <table class="progress-table">
            <thead><tr><th>Student</th><th>Link</th><th>Score</th><th>Action</th></tr></thead>
            <tbody id="subs-tbody"></tbody>
          </table>
        </div>
      </div>
    `;
    document.querySelector(".main-content main")?.appendChild(section);
  }

  const select = $("sub-task-select") || $("subs-task-select");
  const refreshBtn = $("sub-refresh") || $("subs-refresh");
  const tbody = $("submissions-tbody") || $("subs-tbody");

  async function loadTasksIntoSelectCached() {
    if (!select) return;
    if (!window.__isAdmin) { 
      select.innerHTML = `<option value="">Admin only</option>`; 
      return; 
    }
    
    const wk = window.__getISOWeek ? window.__getISOWeek() : undefined;
    const cacheKey = `submission_tasks_${wk}`;
    let tasks = localCache.get(cacheKey);
    
    if (!tasks) {
      select.innerHTML = '<option value="">Loading tasks…</option>';
      try{
        tasks = await (window.__fb_listTasks ? window.__fb_listTasks(wk) : []);
        localCache.set(cacheKey, tasks, 2 * 60 * 1000); // Cache for 2 minutes
      }catch(e){
        select.innerHTML = '<option value="">Failed to load tasks</option>';
        return;
      }
    }
    
    select.innerHTML = '<option value="">— Select a task —</option>';
    tasks.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = `${t.title || '(Untitled)'} — ${t.dueAt ? new Date(t.dueAt).toLocaleString() : 'No due'}`;
      select.appendChild(opt);
    });
  }

  async function loadSubmissionsCached() {
    if (!tbody) return;
    if (!window.__isAdmin) { 
      tbody.innerHTML = '<tr><td colspan="4">Admin only.</td></tr>'; 
      return; 
    }
    
    const taskId = select.value;
    if (!taskId) { 
      tbody.innerHTML = '<tr><td colspan="4">Pick a task.</td></tr>'; 
      return; 
    }
    
    const wk = window.__getISOWeek ? window.__getISOWeek() : undefined;
    const cacheKey = `submissions_${wk}_${taskId}`;
    let subs = localCache.get(cacheKey);
    
    if (!subs) {
      try {
        if (typeof window.__fb_listSubmissions !== 'function') {
          tbody.innerHTML = '<tr><td colspan="4">Please update firebase.js to include __fb_listSubmissions.</td></tr>';
          return;
        }
        tbody.innerHTML = '<tr><td colspan="4">Loading…</td></tr>';
        subs = await window.__fb_listSubmissions(wk, taskId);
        localCache.set(cacheKey, subs, 2 * 60 * 1000); // Cache for 2 minutes
      } catch (e) {
        console.error(e);
        tbody.innerHTML = '<tr><td colspan="4">Failed to load.</td></tr>';
        return;
      }
    }
    
    tbody.innerHTML = '';
    if (!subs.length) { 
      tbody.innerHTML = '<tr><td colspan="4">No submissions yet.</td></tr>'; 
      return; 
    }
    
    subs.forEach(s => {
      const tr = document.createElement('tr');
      const link = s.link ? `<a href="${s.link}" target="_blank" rel="noopener">Open</a>` : '—';
      tr.innerHTML = `
        <td>${s.displayName || s.uid}</td>
        <td>${link}</td>
        <td><input data-uid="${s.uid}" type="number" min="0" step="1" value="${s.score ?? ''}" style="width:100px;"></td>
        <td><button data-uid="${s.uid}">Save</button></td>
      `;
      tr.querySelector('button[data-uid]').onclick = async (ev) => {
        const uid = ev.currentTarget.getAttribute('data-uid');
        const val = tr.querySelector('input[data-uid]').value;
        try {
          await window.__fb_scoreSubmission(wk, taskId, uid, Number(val || 0));
          // Clear cache to force refresh on next load
          localCache.clear(cacheKey);
          alert('Saved.');
        } catch (e) {
          alert('Save failed: ' + (e?.message || e));
        }
      };
      tbody.appendChild(tr);
    });
  }

  // Bind events with guards
  if (refreshBtn && !refreshBtn.dataset.bound) { 
    refreshBtn.addEventListener('click', () => {
      const wk = window.__getISOWeek ? window.__getISOWeek() : undefined;
      const taskId = select.value;
      if (taskId) {
        localCache.clear(`submissions_${wk}_${taskId}`);
      }
      loadSubmissionsCached();
    }); 
    refreshBtn.dataset.bound = "1"; 
  }
  
  if (select && !select.dataset.bound) { 
    select.addEventListener('change', loadSubmissionsCached); 
    select.dataset.bound = "1"; 
  }

  // Simple toast popup for notifications
  window.showToast = function(msg, timeoutMs = 5000){
    const cont = document.getElementById('toast-container');
    if (!cont) return alert(msg); // fallback
    const div = document.createElement('div');
    div.className = 'toast';
    div.textContent = msg;
    cont.appendChild(div);
    setTimeout(() => { div.style.opacity = '0'; div.style.transform = 'translateY(-4px)'; }, timeoutMs - 400);
    setTimeout(() => { cont.removeChild(div); }, timeoutMs);
  };

  window.__subs_refreshOnShow = async () => {
    applyAdminNavVisibility(!!window.__isAdmin);
    await loadTasksIntoSelectCached();
    await loadSubmissionsCached();
  };
  
  window.__subs_selectTaskId = async (taskId) => {
    await loadTasksIntoSelectCached();
    if (select) select.value = taskId || '';
    await loadSubmissionsCached();
  };

  // If this section is already visible, initialize it
  if (!section.classList.contains('hidden')) window.__subs_refreshOnShow();
}

/* =========================
   ATTENDANCE - Enhanced with caching and reduced writes
   ========================= */
function initAttendance() {
  const tabTake     = $('att-tab-take');
  const tabHistory  = $('att-tab-history');
  const paneTake    = $('att-pane-take');
  const paneHistory = $('att-pane-history');

  const dateInput   = $('attendance-date');
  const classNoSel  = $('attendance-classno');
  const loadBtn     = $('attendance-load');
  const tableBody   = document.querySelector('#attendance-table tbody');
  const statusEl    = $('attendance-status');
  const noteEl      = $('attendance-note');

  const markAllBtn  = $('attendance-mark-all');
  const clearAllBtn = $('attendance-clear-all');
  const saveBtn     = $('attendance-save');
  const saveStatus  = $('attendance-save-status');

  const histDateInput = $('att-hist-date');
  const histLoadBtn   = $('att-hist-load');
  const histBody      = document.querySelector('#att-hist-table tbody');
  const histMeta      = $('att-hist-meta');

  const studentView  = $('attendance-student-view');
  const myTableBody  = document.querySelector('#my-attendance-table tbody');

  // Initialize dates
  (function initDates(){
    const t = new Date();
    const yyyy = t.getFullYear(), mm = String(t.getMonth()+1).padStart(2,'0'), dd = String(t.getDate()).padStart(2,'0');
    if (dateInput)     dateInput.value = `${yyyy}-${mm}-${dd}`;
    if (histDateInput) histDateInput.value = `${yyyy}-${mm}-${dd}`;
  })();

  // Tab handlers
  tabTake?.addEventListener('click', () => {
    tabTake.classList.add('active'); tabHistory?.classList.remove('active');
    paneTake?.classList.remove('hidden'); paneHistory?.classList.add('hidden');
  });
  
  tabHistory?.addEventListener('click', () => {
    tabHistory.classList.add('active'); tabTake?.classList.remove('active');
    paneHistory?.classList.remove('hidden'); paneTake?.classList.add('hidden');
    if (histBody) histBody.innerHTML = '<tr><td colspan="2">Pick a date and press "Load History".</td></tr>';
    if (histMeta) histMeta.textContent = '—';
  });

  let students = [];
  let stateMap = {};
  let dirty = false;
  let lastSaved = {};

  const dateKey = () => (dateInput?.value || '').trim();
  const setStatus = (m) => { if (statusEl) statusEl.textContent = m || ''; };
  const setSaveStatus = (m) => { if (saveStatus) saveStatus.textContent = m || ''; };

  function renderNote() {
    const isAdmin = !!window.__isAdmin;

    if (!isAdmin) {
      tabTake && (tabTake.style.display = 'none');
      tabHistory && (tabHistory.style.display = 'none');
      paneTake && (paneTake.style.display = 'none');
      paneHistory && (paneHistory.style.display = 'none');
      studentView && studentView.classList.remove('hidden');
    } else {
      tabTake && (tabTake.style.display = '');
      tabHistory && (tabHistory.style.display = '');
      paneTake && (paneTake.style.display = '');
      paneHistory && (paneHistory.style.display = (tabHistory?.classList.contains('active') ? '' : 'none'));
      studentView && studentView.classList.add('hidden');
    }

    if (noteEl) noteEl.textContent = isAdmin ? "You can edit attendance." : "Read‑only attendance view.";

    [classNoSel, dateInput, histDateInput, markAllBtn, clearAllBtn, saveBtn].forEach(el => { 
      if (el) el.disabled = !isAdmin; 
    });

    if (!isAdmin) renderMyAttendanceCached();
  }

  async function loadAttendanceCached() {
    if (!window.__isAdmin) return;
    if (!tableBody || !dateKey()) return;

    const cacheKey = `attendance_${dateKey()}`;
    let cachedData = localCache.get(cacheKey);
    
    if (cachedData) {
      students = cachedData.students;
      stateMap = { ...cachedData.stateMap };
      lastSaved = { ...stateMap };
      renderAttendanceTable();
      setStatus(`Loaded ${students.length} students from cache.`);
      return;
    }

    setStatus('Loading students & attendance…');
    setSaveStatus(''); 
    dirty = false;
    
    try {
      const [studentsData, att, meta] = await Promise.all([
        window.__fb_listStudents ? window.__fb_listStudents() : [],
        window.__fb_getAttendance ? window.__fb_getAttendance(dateKey()) : {},
        window.__fb_getAttendanceMeta ? window.__fb_getAttendanceMeta(dateKey()) : {}
      ]);
      
      students = studentsData;
      stateMap = {};
      students.forEach(s => { 
        stateMap[s.uid] = { present: !!(att[s.uid]?.present), displayName: s.displayName || null }; 
      });
      lastSaved = { ...stateMap };

      // Cache the loaded data
      localCache.set(cacheKey, { students, stateMap }, 2 * 60 * 1000); // Cache for 2 minutes

      renderAttendanceTable();
      setStatus(`Loaded ${students.length} students.`);

      // Set class number
      if (classNoSel) {
        const v = (meta.classNo ?? '').toString();
        classNoSel.value = v && Array.from(classNoSel.options).some(o => o.value === v) ? v : '';
      }

      renderNote();
    } catch (e) {
      console.error(e);
      setStatus('Failed to load attendance.');
    }
  }

  function renderAttendanceTable() {
    if (!tableBody) return;
    tableBody.innerHTML = '';
    
    students.forEach(s => {
      const tr = document.createElement('tr');
      const nameTd = document.createElement('td'); 
      nameTd.textContent = s.displayName || '(Unnamed)';
      const presentTd = document.createElement('td');
      const chk = document.createElement('input'); 
      chk.type = 'checkbox'; 
      chk.className = 'att-present'; 
      chk.checked = !!stateMap[s.uid]?.present;
      chk.onchange = () => { 
        stateMap[s.uid] = { present: chk.checked, displayName: s.displayName }; 
        dirty = true; 
      };
      presentTd.appendChild(chk);
      tr.append(nameTd, presentTd);
      tableBody.appendChild(tr);
    });
  }

  // Debounced save to reduce Firebase writes
  async function saveAttendanceDebounced() {
    if (!window.__isAdmin || !dateKey()) return;
    
    debouncedOperations.debounce('attendance_save', async () => {
      try {
        // Only save class number if it changed
        if (classNoSel && classNoSel.value !== '') {
          try { 
            await (window.__fb_setAttendanceMeta ? window.__fb_setAttendanceMeta(dateKey(), Number(classNoSel.value)) : Promise.resolve()); 
          }
          catch(e){ console.warn('setAttendanceMeta failed', e); }
        }
        
        // Only save attendance records that changed
        if (dirty) {
          const changedRecords = students.filter(s => {
            const current = stateMap[s.uid]?.present || false;
            const saved = lastSaved[s.uid]?.present || false;
            return current !== saved;
          });
          
          if (changedRecords.length > 0) {
            const records = changedRecords.map(s => ({ 
              uid: s.uid, 
              present: !!(stateMap[s.uid]?.present), 
              displayName: s.displayName 
            }));
            
            await (window.__fb_saveAttendanceBulk ? window.__fb_saveAttendanceBulk(dateKey(), records) : Promise.resolve());
            
            // Update lastSaved
            changedRecords.forEach(s => {
              if (!lastSaved[s.uid]) lastSaved[s.uid] = {};
              lastSaved[s.uid].present = stateMap[s.uid]?.present || false;
            });
          }
          dirty = false;
        }
        
        // Clear cache to force refresh next time
        localCache.clear(`attendance_${dateKey()}`);
        setSaveStatus('Saved ✔');
        
        setTimeout(() => setSaveStatus(''), 3000);
      } catch (e) {
        console.error(e);
        setSaveStatus('Save failed.');
      }
    }, 1500); // Wait 1.5 seconds before saving
  }

  async function loadHistoryAdminCached() {
    if (!window.__isAdmin) return;
    if (!histBody || !histDateInput) return;
    
    const dkey = (histDateInput.value || '').trim();
    if (!dkey) {
      histBody.innerHTML = '<tr><td colspan="2">Pick a date first.</td></tr>';
      if (histMeta) histMeta.textContent = '—';
      return;
    }
    
    const cacheKey = `history_admin_${dkey}`;
    let cachedData = localCache.get(cacheKey);
    
    if (cachedData) {
      renderHistoryUI(cachedData);
      return;
    }
    
    histBody.innerHTML = '<tr><td colspan="2">Loading…</td></tr>';
    if (histMeta) histMeta.textContent = 'Loading…';
    
    try {
      const [studentsList, att, meta] = await Promise.all([
        window.__fb_listStudents ? window.__fb_listStudents() : [],
        window.__fb_getAttendance ? window.__fb_getAttendance(dkey) : {},
        window.__fb_getAttendanceMeta ? window.__fb_getAttendanceMeta(dkey) : {}
      ]);
      
      let presentCount = 0;
      const attendanceData = studentsList.map(s => {
        const isPresent = !!(att[s.uid]?.present);
        if (isPresent) presentCount++;
        return {
          name: s.displayName || '(Unnamed)',
          present: isPresent
        };
      });
      
      const result = {
        attendanceData,
        presentCount,
        totalCount: studentsList.length,
        classNo: meta?.classNo
      };
      
      localCache.set(cacheKey, result, 5 * 60 * 1000); // Cache for 5 minutes
      renderHistoryUI(result);
    } catch (e) {
      console.error(e);
      histBody.innerHTML = '<tr><td colspan="2">Failed to load.</td></tr>';
      if (histMeta) histMeta.textContent = 'Failed to load.';
    }
  }

  function renderHistoryUI(data) {
    const { attendanceData, presentCount, totalCount, classNo } = data;
    
    histBody.innerHTML = '';
    attendanceData.forEach(item => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${item.name}</td><td>${item.present ? 'Present' : 'Absent'}</td>`;
      histBody.appendChild(tr);
    });
    
    const absentCount = totalCount - presentCount;
    const classNoTxt = classNo ? `Class No: ${classNo} · ` : '';
    if (histMeta) {
      histMeta.textContent = `${classNoTxt}Present: ${presentCount} · Absent: ${absentCount} · Total: ${totalCount}`;
    }
  }

  async function renderMyAttendanceCached() {
    if (!myTableBody) return;
    
    const cacheKey = 'my_attendance';
    let rows = localCache.get(cacheKey);
    
    if (!rows) {
      myTableBody.innerHTML = '<tr><td colspan="3">Loading…</td></tr>';
      try {
        rows = await (window.__fb_getMyAttendanceHistoryWithClass ? window.__fb_getMyAttendanceHistoryWithClass(180) : []);
        localCache.set(cacheKey, rows, 5 * 60 * 1000); // Cache for 5 minutes
      } catch (e) {
        console.warn(e);
        myTableBody.innerHTML = '<tr><td colspan="3">Failed to load.</td></tr>';
        return;
      }
    }
    
    myTableBody.innerHTML = '';
    if (!rows.length) { 
      myTableBody.innerHTML = '<tr><td colspan="3">No records yet.</td></tr>'; 
      return; 
    }
    
    rows.forEach(r => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${r.date}</td><td>${r.classNo ?? '—'}</td><td>${r.present ? 'Present' : 'Absent'}</td>`;
      myTableBody.appendChild(tr);
    });
  }
  window.__att_renderMyAttendance = renderMyAttendanceCached;

  // Wire events with guards
  if (loadBtn && !loadBtn.dataset.bound) { 
    loadBtn.addEventListener('click', loadAttendanceCached); 
    loadBtn.dataset.bound = "1"; 
  }
  
  dateInput?.addEventListener('change', loadAttendanceCached);
  
  if (markAllBtn && !markAllBtn.dataset.bound) { 
    markAllBtn.addEventListener('click', () => {
      if (!window.__isAdmin) return;
      document.querySelectorAll('.att-present').forEach(inp => { inp.checked = true; });
      students.forEach(s => stateMap[s.uid] = { present: true, displayName: s.displayName });
      dirty = true;
    }); 
    markAllBtn.dataset.bound = "1"; 
  }
  
  if (clearAllBtn && !clearAllBtn.dataset.bound) { 
    clearAllBtn.addEventListener('click', () => {
      if (!window.__isAdmin) return;
      document.querySelectorAll('.att-present').forEach(inp => { inp.checked = false; });
      students.forEach(s => stateMap[s.uid] = { present: false, displayName: s.displayName });
      dirty = true;
    }); 
    clearAllBtn.dataset.bound = "1"; 
  }
  
  if (saveBtn && !saveBtn.dataset.bound) { 
    saveBtn.addEventListener('click', saveAttendanceDebounced); 
    saveBtn.dataset.bound = "1"; 
  }
  
  if (histLoadBtn && !histLoadBtn.dataset.bound) { 
    histLoadBtn.addEventListener('click', loadHistoryAdminCached); 
    histLoadBtn.dataset.bound = "1"; 
  }

  // Expose refresh hook
  window.__att_refreshOnShow = () => {
    if (window.__isAdmin) loadAttendanceCached();
    else renderMyAttendanceCached();
    renderNote();
  };

  // Initialize
  renderNote();
  if (window.__isAdmin) loadAttendanceCached(); 
  else renderMyAttendanceCached();
}

// React to admin role toggles with cache clearing
window.__onAdminStateChanged = function(isAdmin) {
  applyAdminNavVisibility(!!isAdmin);
  
  // Clear relevant caches
  localCache.clear('approved_students');
  localCache.clear('pending_approvals');
  localCache.clear('manage_students');
  
  // Refresh current section
  if (currentSectionId === 'attendance-section' && typeof window.__att_refreshOnShow === 'function') {
    window.__att_refreshOnShow();
  }
  if (currentSectionId === 'tasks-section' && typeof window.__tasks_refresh === 'function') {
    window.__tasks_refresh();
  }
  if (currentSectionId === 'admin-submissions-section' && typeof window.__subs_refreshOnShow === 'function') {
    window.__subs_refreshOnShow();
  }
  if (currentSectionId === 'progress-section' && typeof window.__progress_refreshOnShow === 'function') {
    window.__progress_refreshOnShow();
  }
};

function wireAdminResetDB(){
  const section = $("admin-resetdb-section");
  if (!section) return;
  const input  = $("resetdb-confirm");
  const btn    = $("resetdb-run");
  const status = $("resetdb-status");

  function refreshVisibility(){
    section.style.display = window.__isAdmin ? "" : "none";
  }

  async function runWipe(){
    if (!window.__isAdmin) { alert("Admin only."); return; }
    const phrase = (input?.value || "").trim().toUpperCase();
    if (phrase !== "I UNDERSTAND") {
      alert('Please type exactly: I UNDERSTAND');
      return;
    }
    if (!confirm("This will delete ALL course data. Are you absolutely sure?")) return;
    if (!confirm("Final confirmation: proceed with FULL WIPE?")) return;

    btn.disabled = true; 
    status.textContent = "Wiping… this may take a minute.";
    
    try {
      if (typeof window.__fb_adminWipeAll !== "function") throw new Error("Missing __fb_adminWipeAll in firebase.js");
      await window.__fb_adminWipeAll();
      
      // Clear all local caches after wipe
      localCache.clear();
      
      status.textContent = "Done. All course data cleared.";
      input.value = "";
      window.showToast && window.showToast("Database wiped successfully.");
    } catch (e) {
      console.error(e);
      status.textContent = "Failed: " + (e?.message || e);
    } finally {
      btn.disabled = false;
    }
  }

  if (btn && !btn.dataset.bound) { 
    btn.addEventListener("click", runWipe); 
    btn.dataset.bound = "1"; 
  }

  refreshVisibility();
  const obs = new MutationObserver(refreshVisibility);
  obs.observe(section, { attributes: true, attributeFilter: ["class"] });
}

function wireSoftRefreshButton(){
  const btn = $("soft-refresh-btn");
  if (!btn || btn.dataset.bound) return;

  async function doRefresh(){
    btn.disabled = true;
    try {
      // Commit any locally buffered practice
      if (typeof window.__fb_commitLocalPendingSession === 'function') {
        try { await window.__fb_commitLocalPendingSession(); } catch {}
      }

      // Clear all local caches
      localCache.clear();
      
      // Ask firebase.js to re-subscribe to Firestore live queries
      if (typeof window.__softRefreshData === 'function') {
        await window.__softRefreshData();
      }

      // Re-render UI with fresh data
      try { refreshTasksUICached(); } catch {}
      try { renderProgressCached(); } catch {}
      try { wireProgressCombined(); } catch {}

      if (currentSectionId === 'attendance-section' && typeof window.__att_refreshOnShow === 'function') {
        window.__att_refreshOnShow();
      }
      if (currentSectionId === 'admin-submissions-section' && typeof window.__subs_refreshOnShow === 'function') {
        window.__subs_refreshOnShow();
      }

      if (typeof window.showToast === 'function') {
        window.showToast('Refreshed from database.');
      }
    } finally {
      btn.disabled = false;
    }
  }

  btn.addEventListener('click', doRefresh, { passive: true });
  btn.dataset.bound = "1";
}// script.js — Optimized UI glue with reduced Firebase operations
// All Firebase operations are done via helpers exposed by firebase.js (window.__fb_*).

/* =========================
   PERFORMANCE OPTIMIZATIONS
   ========================= */
// Local caching layer to reduce Firebase reads
const localCache = {
  data: new Map(),
  timestamps: new Map(),
  TTL: 5 * 60 * 1000, // 5 minutes cache
  
  set(key, value, ttl = this.TTL) {
    this.data.set(key, value);
    this.timestamps.set(key, Date.now() + ttl);
  },
  
  get(key) {
    if (!this.data.has(key)) return null;
    if (Date.now() > this.timestamps.get(key)) {
      this.data.delete(key);
      this.timestamps.delete(key);
      return null;
    }
    return this.data.get(key);
  },
  
  clear(pattern) {
    if (pattern) {
      for (const key of this.data.keys()) {
        if (key.includes(pattern)) {
          this.data.delete(key);
          this.timestamps.delete(key);
        }
      }
    } else {
      this.data.clear();
      this.timestamps.clear();
    }
  }
};

// Debounced operations to batch Firebase writes
const debouncedOperations = {
  timers: new Map(),
  
  debounce(key, fn, delay = 2000) {
    if (this.timers.has(key)) {
      clearTimeout(this.timers.get(key));
    }
    
    const timer = setTimeout(() => {
      fn();
      this.timers.delete(key);
    }, delay);
    
    this.timers.set(key, timer);
  }
};

/* =========================
   Global state
   ========================= */
let allSets = {};                // { setName: [{q, options:[...], correctIndex:0}] }
let currentSet = [];
let currentSetName = "";
let currentIndex = 0;
let score = { correct: 0, wrong: 0, skipped: 0 };

let mistakes = JSON.parse(localStorage.getItem("mistakes") || "[]");
let masteryMap = JSON.parse(localStorage.getItem("masteryMap") || "{}");

// Session buffer with local accumulation to reduce Firebase writes
let sessionBuf = JSON.parse(localStorage.getItem("sessionBuf") || "null") || {
  deckName: "",
  mode: "mcq",
  correct: 0,
  wrong: 0,
  skipped: 0,
  total: 0,
  jpEnCorrect: 0,
  enJpCorrect: 0,
  lastCommit: 0
};

let currentSectionId = "practice-select";
let committing = false;

// Batch accumulator for multiple quick answers
let answerBatch = [];
let batchTimer = null;

/* =========================
   Resume state (per deck) - Enhanced with smarter persistence
   ========================= */
let resumeMap = JSON.parse(localStorage.getItem("practiceResume") || "{}");

function getResume(setName){
  const r = resumeMap[setName];
  if (!r || typeof r.index !== "number") return null;
  return r;
}

function setResume(setName, index, total){
  resumeMap[setName] = {
    index: Math.max(0, index|0),
    total: (total|0) || (allSets[setName]?.length || 0)
  };
  
  // Debounce localStorage writes
  debouncedOperations.debounce('resume', () => {
    localStorage.setItem("practiceResume", JSON.stringify(resumeMap));
  }, 1000);
}

function clearResume(setName){
  delete resumeMap[setName];
  localStorage.setItem("practiceResume", JSON.stringify(resumeMap));
}

/* =========================
   Tiny helpers
   ========================= */
const $ = (id) => document.getElementById(id);
const setText = (id, txt) => { const el = $(id); if (el) el.innerText = txt; };
function statusLine(id, msg) { const s = $(id); if (s) s.textContent = msg; }

// Debounced session persistence
function persistSession() { 
  debouncedOperations.debounce('session', () => {
    localStorage.setItem("sessionBuf", JSON.stringify(sessionBuf));
  }, 500);
}

function percent(n, d) { return !d ? 0 : Math.floor((n / d) * 100); }
function shuffleArray(arr) { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; }

/* =========================
   Restart helper (uses resume state)
   ========================= */
function restartDeck(name){
  clearResume(name);

  currentSet = allSets[name] || [];
  currentSetName = name;
  currentIndex = 0;

  score = { correct: 0, wrong: 0, skipped: 0 };
  sessionBuf = {
    deckName: name, mode: "mcq",
    correct: 0, wrong: 0, skipped: 0, total: 0,
    jpEnCorrect: 0, enJpCorrect: 0, lastCommit: Date.now()
  };
  persistSession();

  showSection("practice");
  showQuestion();
  updateScore();
  updateDeckProgress();

  const hint = $("resume-hint");
  if (hint) hint.textContent = "";
}

/* =========================
   Lifecycle - Enhanced with caching
   ========================= */
window.onload = () => {
  const timer = $("todo-timer"); if (timer) timer.style.display = "none";

  loadPracticeManifest();
  loadLecturesManifest();
  renderProgressCached();
  wireApprovals();
  wireTasks();
  wireManageStudents();
  wireAdminSubmissions();
  initAttendance();
  updateScore();
  wireAdminResetDB();
  wireSoftRefreshButton();
};

// Called by firebase.js once auth/admin resolved
window.__initAfterLogin = () => {
  wireApprovals();
  wireTasks();
  wireManageStudents();
  wireAdminSubmissions();
  renderProgressCached();
  wireProgressCombined();
  applyAdminNavVisibility(!!window.__isAdmin);
  wireAdminResetDB();
  wireSoftRefreshButton();
};

// Enhanced persistence with batching
["pagehide", "beforeunload"].forEach(evt => {
  window.addEventListener(evt, () => {
    try { 
      if (sessionBuf.total > 0) {
        localStorage.setItem('pendingSession', JSON.stringify(sessionBuf));
        // Immediate commit on page leave
        if (window.__fb_commitSession) {
          window.__fb_commitSession(sessionBuf);
        }
      }
    } catch {}
  });
});

/* =========================
   Router - Enhanced with section caching
   ========================= */
function showSection(id) {
  if (currentSectionId === "practice" && id !== "practice") {
    autoCommitIfNeeded("leaving practice");
  }

  document.querySelectorAll('.main-content main > section').forEach(sec => sec.classList.add('hidden'));
  const target = document.getElementById(id);
  if (target) target.classList.remove('hidden');

  currentSectionId = id;

  // Cached section updates
  if (id === "practice") updateDeckProgress();
  if (id === "tasks-section") refreshTasksUICached();
  if (id === "progress-section") {
    renderProgressCached();
    wireProgressCombined();
    if (typeof window.__progress_refreshOnShow === 'function') window.__progress_refreshOnShow();
  }

  if (id === "attendance-section") {
    if (typeof window.__att_refreshOnShow === 'function') window.__att_refreshOnShow();
  }
  if (id === "admin-submissions-section") {
    if (typeof window.__subs_refreshOnShow === 'function') window.__subs_refreshOnShow();
  }
}
window.showSection = showSection;

/* =========================
   Hide/Show admin items in sidebar
   ========================= */
function applyAdminNavVisibility(isAdmin) {
  const sidebar = document.querySelector("nav.sidebar");
  if (!sidebar) return;

  document.querySelectorAll('.admin-only').forEach(el => {
    el.style.display = isAdmin ? '' : 'none';
  });

  const injected = sidebar.querySelector('button[data-nav="admin-submissions-section"]');
  if (injected) injected.style.display = isAdmin ? '' : 'none';
}

/* =========================
   PRACTICE (MCQ) - Enhanced with local caching
   ========================= */
async function loadPracticeManifest() {
  const cacheKey = 'practice_manifest';
  const cached = localCache.get(cacheKey);
  
  if (cached) {
    allSets = cached;
    renderPracticeButtons();
    statusLine("practice-status", `Loaded ${Object.keys(allSets).length} set(s) from cache.`);
    return;
  }

  try {
    statusLine("practice-status", "Loading practice sets…");
    const res = await fetch("practice/questions.json");
    if (!res.ok) throw new Error(`HTTP ${res.status} for practice/questions.json`);
    const text = await res.text();
    if (text.trim().startsWith("<")) throw new Error("Got HTML instead of JSON for practice/questions.json");

    const setList = JSON.parse(text);
    setList.sort((a,b)=>a.localeCompare(b, undefined, {numeric:true}));

    allSets = {};
    for (const file of setList) {
      const name = file.replace(".csv", "");
      const url = `practice/${file}`;
      statusLine("practice-status", `Loading ${file}…`);
      const questions = await fetchAndParseMCQ(url);
      allSets[name] = questions;
    }
    
    // Cache the loaded sets
    localCache.set(cacheKey, allSets, 30 * 60 * 1000); // Cache for 30 minutes
    
    renderPracticeButtons();
    statusLine("practice-status", `Loaded ${Object.keys(allSets).length} set(s).`);
  } catch (err) {
    console.error("Practice manifest load failed:", err);
    statusLine("practice-status", `Failed to load: ${err.message}`);
  }
}

// Enhanced CSV parser (same as before but with better error handling)
function parseCSV(text){
  const rows = [];
  let row = [];
  let cur = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++){
    const ch = text[i];
    if (inQuotes){
      if (ch === '"'){
        if (text[i+1] === '"'){ cur += '"'; i++; }
        else { inQuotes = false; }
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"'){
        inQuotes = true;
      } else if (ch === ','){
        row.push(cur.trim());
        cur = '';
      } else if (ch === '\n'){
        row.push(cur.trim());
        if (row.some(c => c && c.length)) rows.push(row);
        row = [];
        cur = '';
      } else if (ch === '\r'){
        // ignore (normalize CRLF)
      } else {
        cur += ch;
      }
    }
  }
  if (cur.length || inQuotes || row.length) {
    row.push(cur.trim());
    if (row.some(c => c && c.length)) rows.push(row);
  }
  return rows;
}

async function fetchAndParseMCQ(url) {
  const cacheKey = `mcq_${url}`;
  const cached = localCache.get(cacheKey);
  if (cached) return cached;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const raw = await res.text();
  const rows = parseCSV(raw.replace(/\uFEFF/g, ''));

  let startIdx = 0;
  if (rows.length && (rows[0][0]||'').toLowerCase() === 'question') startIdx = 1;

  const out = [];
  for (let i = startIdx; i < rows.length; i++){
    const cols = rows[i];
    const q  = (cols[0] || '').trim();
    const o1 = (cols[1] || '').trim();
    const o2 = (cols[2] || '').trim();
    const o3 = (cols[3] || '').trim();
    const o4 = (cols[4] || '').trim();
    const ans = (cols[5] || '').trim();
    const options = [o1,o2,o3,o4].filter(Boolean);
    if (!q || options.length < 2) continue;

    let correctIndex = 0;
    if (ans){
      const ix = options.findIndex(o => o === ans);
      correctIndex = ix >= 0 ? ix : 0;
    }
    out.push({ q, options, correctIndex });
  }

  localCache.set(cacheKey, out, 60 * 60 * 1000); // Cache for 1 hour
  return out;
}

function renderPracticeButtons() {
  const container = $("practice-buttons");
  if (!container) return;
  container.innerHTML = "";

  Object.keys(allSets).forEach((name) => {
    const wrap = document.createElement("div");
    wrap.style.display = "flex";
    wrap.style.alignItems = "center";
    wrap.style.gap = "8px";
    wrap.style.flexWrap = "wrap";

    const r = getResume(name);
    const mainBtn = document.createElement("button");

    if (r && r.total){
      const done = Math.min(r.index, r.total);
      const pct = percent(done, r.total);
      mainBtn.textContent = `${name} · Continue ${done}/${r.total} (${pct}%)`;
      mainBtn.title = "Resume where you left off";
    } else {
      mainBtn.textContent = name;
    }

    mainBtn.onclick = async () => {
      if (sessionBuf.total > 0 && sessionBuf.deckName && sessionBuf.deckName !== name) {
        await autoCommitIfNeeded("switch set");
      }
      selectSet(name);
    };
    wrap.appendChild(mainBtn);

    if (r && r.total){
      const restartBtn = document.createElement("button");
      restartBtn.textContent = "↺ Restart";
      restartBtn.style.background = "#6b7280";
      restartBtn.style.whiteSpace = "nowrap";
      restartBtn.onclick = async (e) => {
        e.stopPropagation();
        if (sessionBuf.total > 0 && sessionBuf.deckName && sessionBuf.deckName !== name) {
          await autoCommitIfNeeded("switch set");
        }
        restartDeck(name);
      };
      wrap.appendChild(restartBtn);
    }

    container.appendChild(wrap);
  });
}

function selectSet(name) {
  currentSet = allSets[name] || [];
  currentSetName = name;

  if (currentSet.length === 0) { alert(`Set "${name}" is empty.`); return; }

  const r = getResume(name);
  currentIndex = r ? Math.min(r.index, currentSet.length - 1) : 0;

  score = { correct: 0, wrong: 0, skipped: 0 };
  sessionBuf = { 
    deckName: name, mode: "mcq", 
    correct: 0, wrong: 0, skipped: 0, total: 0, 
    jpEnCorrect: 0, enJpCorrect: 0, lastCommit: Date.now() 
  };
  persistSession();

  showSection("practice");
  showQuestion();
  updateScore();
  updateDeckProgress();

  const hint = $("resume-hint");
  if (hint) {
    if (r && r.index > 0) hint.textContent = `Resumed at question ${currentIndex + 1} of ${currentSet.length}.`;
    else hint.textContent = '';
  }
}

function showQuestion() {
  const q = currentSet[currentIndex];
  if (!q) return nextQuestion();

  setText("question-box", q.q);
  const optionsList = $("options"); if (!optionsList) return;
  optionsList.innerHTML = "";

  const correct = q.options[q.correctIndex];
  q.options.forEach((opt) => {
    const li = document.createElement("li");
    li.textContent = opt;
    li.onclick = () => checkAnswerBatched(opt, correct, q);
    optionsList.appendChild(li);
  });

  // Update resume pointer less frequently
  if (currentSetName && currentIndex % 5 === 0) {
    setResume(currentSetName, currentIndex, currentSet.length);
  }
  updateDeckProgress();
}

// Batched answer checking to reduce frequent Firebase writes
function checkAnswerBatched(selected, correct, qObj) {
  const options = document.querySelectorAll("#options li");
  options.forEach((li) => {
    if (li.textContent === correct) li.classList.add("correct");
    else if (li.textContent === selected) li.classList.add("wrong");
  });

  const key = qObj.q + "|" + correct;
  const isCorrect = selected === correct;

  // Batch the answer for later processing
  answerBatch.push({
    key,
    isCorrect,
    qObj,
    timestamp: Date.now()
  });

  // Update immediate UI state
  if (isCorrect) {
    score.correct++; 
    sessionBuf.correct++; 
    sessionBuf.total++; 
    sessionBuf.jpEnCorrect++;
    masteryMap[key] = (masteryMap[key] || 0) + 1;
    if (masteryMap[key] >= 5) {
      mistakes = mistakes.filter((m) => m.q !== qObj.q);
    }
  } else {
    score.wrong++; 
    sessionBuf.wrong++; 
    sessionBuf.total++;
    masteryMap[key] = 0; 
    mistakes.push(qObj);
  }

  // Process batch every 3 answers or 5 seconds
  if (answerBatch.length >= 3) {
    processBatchedAnswers();
  } else {
    if (batchTimer) clearTimeout(batchTimer);
    batchTimer = setTimeout(processBatchedAnswers, 5000);
  }

  persistSession();
  updateScore();
  setTimeout(() => { nextQuestion(); updateDeckProgress(); }, 500);
}

function processBatchedAnswers() {
  if (answerBatch.length === 0) return;

  // Process all batched answers at once
  localStorage.setItem("mistakes", JSON.stringify(mistakes));
  localStorage.setItem("masteryMap", JSON.stringify(masteryMap));
  
  answerBatch = [];
  if (batchTimer) {
    clearTimeout(batchTimer);
    batchTimer = null;
  }
}

// Original checkAnswer for compatibility
function checkAnswer(selected, correct, qObj) {
  return checkAnswerBatched(selected, correct, qObj);
}

function skipQuestion() {
  const qObj = currentSet[currentIndex]; 
  if (!qObj) return;
  const key = qObj.q + "|" + (qObj.options[qObj.correctIndex] || "");
  score.skipped++; 
  sessionBuf.skipped++; 
  sessionBuf.total++; 
  masteryMap[key] = 0; 
  mistakes.push(qObj);
  
  // Add to batch
  answerBatch.push({
    key,
    isCorrect: false,
    qObj,
    timestamp: Date.now()
  });

  persistSession(); 
  updateScore(); 
  nextQuestion(); 
  updateDeckProgress();
}
window.skipQuestion = skipQuestion;

function nextQuestion() {
  currentIndex++;

  if (currentSetName && currentIndex % 3 === 0) {
    setResume(currentSetName, Math.min(currentIndex, currentSet.length - 1), currentSet.length);
  }

  if (currentIndex >= currentSet.length) {
    clearResume(currentSetName);
    processBatchedAnswers(); // Process any remaining batched answers
    alert(`Finished! ✅ ${score.correct} ❌ ${score.wrong} ➖ ${score.skipped}\nSaving your progress…`);
    showSection("practice-select");
    renderPracticeButtons();
  } else {
    showQuestion();
  }
}

function updateScore() {
  setText("correct", String(score.correct));
  setText("wrong", String(score.wrong));
  setText("skipped", String(score.skipped));
}

function updateDeckProgress() {
  const totalQs = currentSet.length || 0;
  const done = Math.min(currentIndex, totalQs);
  const p = percent(done, totalQs);
  const bar = $("deck-progress-bar");
  const txt = $("deck-progress-text");
  if (bar) bar.style.width = `${p}%`;
  if (txt) txt.textContent = `${done} / ${totalQs} (${p}%)`;
}

// Enhanced auto-commit with intelligent timing
async function autoCommitIfNeeded(reason = "") {
  if (!window.__fb_commitSession || committing) return;
  if (!sessionBuf || sessionBuf.total <= 0) return;
  
  // Only commit if significant time has passed or significant progress made
  const timeSinceLastCommit = Date.now() - (sessionBuf.lastCommit || 0);
  const shouldCommit = timeSinceLastCommit > 60000 || sessionBuf.total >= 10;
  
  if (!shouldCommit && reason !== "leaving practice") return;

  try {
    committing = true;
    processBatchedAnswers(); // Ensure all batched answers are processed
    
    const payload = {
      deckName: sessionBuf.deckName || 'Unknown Set',
      mode: sessionBuf.mode,
      correct: sessionBuf.correct,
      wrong: sessionBuf.wrong,
      skipped: sessionBuf.skipped,
      total: sessionBuf.total,
      jpEnCorrect: sessionBuf.jpEnCorrect,
      enJpCorrect: sessionBuf.enJpCorrect
    };
    
    await window.__fb_commitSession(payload);
    
    // Reset counters but keep set metadata
    Object.assign(sessionBuf, { 
      correct:0, wrong:0, skipped:0, total:0, 
      jpEnCorrect:0, enJpCorrect:0, 
      lastCommit: Date.now() 
    });
    persistSession();
    
    // Clear progress cache to show updated data
    localCache.clear('progress');
    
  } catch (e) {
    console.warn("[autosave] failed; keeping local buffer:", e?.message || e);
  } finally {
    committing = false;
  }
}

/* =========================
   MISTAKES - Enhanced with caching
   ========================= */
function startMistakePractice() {
  if (mistakes.length === 0) return alert("No mistakes yet!");
  currentSet = mistakes.slice();
  currentSetName = "Mistakes";
  currentIndex = 0;
  showSection("practice");
  score = { correct: 0, wrong: 0, skipped: 0 };
  sessionBuf = { 
    deckName: "Mistakes", mode: "mcq", 
    correct: 0, wrong: 0, skipped: 0, total: 0, 
    jpEnCorrect: 0, enJpCorrect: 0, lastCommit: Date.now() 
  };
  showQuestion();
  updateDeckProgress();
}
window.startMistakePractice = startMistakePractice;

function clearMistakes() {
  if (confirm("Clear all mistake questions?")) {
    mistakes = [];
    localStorage.setItem("mistakes", JSON.stringify([]));
    alert("Mistakes cleared.");
  }
}
window.clearMistakes = clearMistakes;

/* =========================
   LECTURES - Enhanced with caching
   ========================= */
async function loadLecturesManifest() {
  const cacheKey = 'lectures_manifest';
  const cached = localCache.get(cacheKey);
  
  if (cached) {
    renderLectureButtons(cached);
    statusLine("lectures-status", `Loaded ${cached.length} lecture file(s) from cache.`);
    return;
  }

  try {
    statusLine("lectures-status", "Loading lectures…");
    const res = await fetch("lectures/lectures.json");
    if (!res.ok) throw new Error(`HTTP ${res.status} for lectures/lectures.json`);
    const t = await res.text();
    if (t.trim().startsWith("<")) throw new Error("Got HTML instead of JSON for lectures manifest");
    const list = JSON.parse(t);

    localCache.set(cacheKey, list, 60 * 60 * 1000); // Cache for 1 hour
    renderLectureButtons(list);
    statusLine("lectures-status", `Loaded ${list.length} lecture file(s).`);
  } catch (err) {
    console.error("Lectures manifest load failed:", err);
    statusLine("lectures-status", `Failed to load lectures: ${err.message}`);
  }
}

function renderLectureButtons(list) {
  const container = $("lectures-list");
  if (!container) return;
  container.innerHTML = "";
  
  list.forEach((file) => {
    const btn = document.createElement("button");
    btn.textContent = file.replace(".pdf", "");
    btn.onclick = () => window.open(`lectures/${file}`, "_blank");
    container.appendChild(btn);
  });
}

/* =========================
   PROGRESS - Enhanced with smart caching
   ========================= */
async function renderProgressCached() {
  const cacheKey = 'progress_data';
  const cached = localCache.get(cacheKey);
  
  // Use cached data if available, but refresh in background
  if (cached) {
    renderProgressUI(cached);
    // Refresh in background
    setTimeout(() => fetchAndRenderProgress(), 100);
  } else {
    await fetchAndRenderProgress();
  }
}

async function fetchAndRenderProgress() {
  try {
    const data = {};
    
    if (window.__fb_fetchAttempts) {
      data.attempts = await window.__fb_fetchAttempts(50);
    }
    
    if (window.__fb_fetchWeeklyOverview) {
      data.weeklyOverview = await window.__fb_fetchWeeklyOverview();
    }
    
    localCache.set('progress_data', data, 2 * 60 * 1000); // Cache for 2 minutes
    renderProgressUI(data);
  } catch (e) {
    console.warn("renderProgress failed:", e);
  }
}

function renderProgressUI(data) {
  const { attempts = [], weeklyOverview = {} } = data;
  
  // Render attempts table
  const tbody = $("progress-table")?.querySelector("tbody");
  if (tbody) {
    tbody.innerHTML = "";
    attempts.slice(0, 20).forEach(a => {
      const tr = document.createElement("tr");
      const when = a.createdAt ? new Date(a.createdAt).toLocaleString() : "—";
      tr.innerHTML = `
        <td>${when}</td>
        <td>${a.deckName || "—"}</td>
        <td>${a.mode || "—"}</td>
        <td>${a.correct ?? 0}</td>
        <td>${a.wrong ?? 0}</td>
        <td>${a.skipped ?? 0}</td>
        <td>${a.total ?? ((a.correct||0)+(a.wrong||0)+(a.skipped||0))}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  // Render comparison boxes
  const last = attempts[0];
  let prev = null;
  if (last) {
    prev = attempts.find(a => a.deckName === last.deckName && a.createdAt < last.createdAt) || null;
  }
  
  const lastBox = $("progress-last");
  const prevBox = $("progress-prev");
  const deltaBox = $("progress-delta");

  if (lastBox) {
    if (last) {
      lastBox.innerHTML = `
        <div><b>${last.deckName}</b> (${last.mode})</div>
        <div>✅ ${last.correct || 0} | ❌ ${last.wrong || 0} | ➖ ${last.skipped || 0}</div>
        <div class="muted">${new Date(last.createdAt).toLocaleString()}</div>
      `;
    } else lastBox.textContent = "No attempts yet.";
  }
  
  if (prevBox) {
    if (prev) {
      prevBox.innerHTML = `
        <div><b>${prev.deckName}</b> (${prev.mode})</div>
        <div>✅ ${prev.correct || 0} | ❌ ${prev.wrong || 0} | ➖ ${prev.skipped || 0}</div>
        <div class="muted">${new Date(prev.createdAt).toLocaleString()}</div>
      `;
    } else prevBox.textContent = "—";
  }
  
  if (deltaBox) {
    if (last && prev) {
      const d = (last.correct || 0) - (prev.correct || 0);
      const cls = d >= 0 ? "delta-up" : "delta-down";
      const sign = d > 0 ? "+" : (d < 0 ? "" : "±");
      deltaBox.innerHTML = `<span class="${cls}">${sign}${d} correct vs previous (same set)</span>`;
    } else if (last && !prev) deltaBox.textContent = "No previous attempt for this set.";
    else deltaBox.textContent = "—";
  }

  // Weekly overview
  const obody = $("overview-body");
  if (obody && weeklyOverview) {
    const w = weeklyOverview;
    obody.innerHTML = "";
    
    // tasks
    (w.tasks || []).forEach(t => {
      const scoreTxt = (t.score ?? null) !== null && (t.scoreMax ?? null) !== null
        ? `${t.score}/${t.scoreMax}` : (t.status || '—');
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>Task</td><td>${t.title || '(Untitled)'}</td><td>${scoreTxt}</td>`;
      obody.appendChild(tr);
    });
    // attendance
    (w.attendance || []).forEach(a => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>Attendance</td><td>${a.date} (Class ${a.classNo ?? '—'})</td><td>${a.status}</td>`;
      obody.appendChild(tr);
    });
    // exam
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>Exam</td><td>This Week</td><td>${w.exam ?? 0}</td>`;
    obody.appendChild(tr);
  }
}

// Alias for backward compatibility
window.renderProgress = renderProgressCached;

/* =========================
   PROGRESS (combined 4‑column table) - Enhanced with caching
   ========================= */
function applyRoleVisibilityForProgress(){
  const isAdmin = !!window.__isAdmin;
  $('progress-admin')?.classList.toggle('hidden', !isAdmin);
  $('progress-student')?.classList.toggle('hidden', isAdmin);
}

async function listApprovedIntoSelectCached(selectEl){
  if (!selectEl) return;
  
  const cacheKey = 'approved_students';
  const cached = localCache.get(cacheKey);
  
  if (cached) {
    selectEl.innerHTML = '<option value="">— Select —</option>';
    cached.forEach(u => {
      const opt = document.createElement('option');
      opt.value = u.uid;
      opt.textContent = u.displayName || u.uid;
      selectEl.appendChild(opt);
    });
    return;
  }
  
  selectEl.innerHTML = '<option value="">Loading students…</option>';
  try{
    const rows = await (window.__fb_listApprovedStudents ? window.__fb_listApprovedStudents() : []);
    localCache.set(cacheKey, rows, 5 * 60 * 1000); // Cache for 5 minutes
    selectEl.innerHTML = '<option value="">— Select —</option>';
    rows.forEach(u => {
      const opt = document.createElement('option');
      opt.value = u.uid;
      opt.textContent = u.displayName || u.uid;
      selectEl.appendChild(opt);
    });
  }catch(e){
    selectEl.innerHTML = '<option value="">Failed to load</option>';
  }
}

function fmtPracticeCell(attempt){
  if (!attempt) return '';
  const title = attempt.deckName || 'Lecture';
  const score = attempt.correct ?? 0;
  return `${title} (${score})`;
}

function fmtTaskCell(row){
  if (!row) return '';
  const completed = row.status === 'Submitted' || (row.score ?? null) !== null;
  const label = (row.score ?? null) !== null && (row.scoreMax ?? null) !== null
    ? `${row.title} (${row.score}/${row.scoreMax})`
    : `${row.title} (${completed ? 'Completed' : 'Pending'})`;
  const cls = completed ? 'status-good' : 'status-bad';
  return `<span class="${cls}">${label}</span>`;
}

function fmtAttendanceCell(row){
  if (!row) return '';
  const cls = row.status === 'Present' ? 'status-good' : 'status-bad';
  const classTxt = (row.classNo ?? '—');
  return `<span class="${cls}">Class No - ${classTxt} (${row.status.toLowerCase()})</span>`;
}

function fmtExamCell(score, idx){
  if (idx > 0) return '';
  return score ? `Exam (${score})` : '';
}

async function fetchCombinedForCached(uid){
  const cacheKey = `combined_${uid}`;
  const cached = localCache.get(cacheKey);
  if (cached) return cached;

  const attempts = await (window.__fb_fetchAttemptsFor ? window.__fb_fetchAttemptsFor(uid, 10) : []);
  const practiceRows = attempts.map(a => ({ deckName: a.deckName || 'Lecture', correct: a.correct ?? 0 }));

  const w = await (window.__fb_fetchWeeklyOverviewFor ? window.__fb_fetchWeeklyOverviewFor(uid) : {tasks:[], attendance:[], exam:0});
  const taskRows = (w.tasks || []).map(t => ({ title: t.title || 'Task', status: t.status || 'Pending', score: t.score ?? null, scoreMax: t.scoreMax ?? null }));
  const attRows  = (w.attendance || []).map(a => ({ date: a.date, classNo: a.classNo ?? '—', status: a.status || 'Absent' }));
  const examScore = w.exam || 0;

  const maxLen = Math.max(practiceRows.length, taskRows.length, attRows.length, 1);
  const rows = [];
  for (let i=0; i<maxLen; i++){
    rows.push({
      practice: practiceRows[i] || null,
      task: taskRows[i] || null,
      att: attRows[i] || null,
      examIdx: i
    });
  }

  const result = { rows, examScore };
  localCache.set(cacheKey, result, 2 * 60 * 1000); // Cache for 2 minutes
  return result;
}

async function renderCombinedTableCached(tbodyEl, uid){
  if (!tbodyEl || !uid) return;
  tbodyEl.innerHTML = `<tr><td colspan="4">Loading…</td></tr>`;
  try{
    const { rows, examScore } = await fetchCombinedForCached(uid);
    tbodyEl.innerHTML = '';
    if (!rows.length){
      tbodyEl.innerHTML = `<tr><td colspan="4">No data yet.</td></tr>`;
      return;
    }
    rows.forEach((r) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${fmtPracticeCell(r.practice)}</td>
        <td>${fmtTaskCell(r.task)}</td>
        <td>${fmtAttendanceCell(r.att)}</td>
        <td>${fmtExamCell(examScore, r.examIdx)}</td>
      `;
      tbodyEl.appendChild(tr);
    });
  }catch(e){
    tbodyEl.innerHTML = `<tr><td colspan="4">Failed to load.</td></tr>`;
  }
}

function wireProgressCombined(){
  applyRoleVisibilityForProgress();

  const sel = $('progress-student-select');
  const loadBtn = $('progress-load');
  const statusEl = $('progress-admin-status');
  const nameEl = $('progress-student-name');
  const tbodyAdmin = $('progress-admin-tbody');

  if (window.__isAdmin) {
    listApprovedIntoSelectCached(sel);
    if (loadBtn && !loadBtn.dataset.bound) {
      loadBtn.addEventListener('click', async () => {
        const uid = sel?.value || '';
        if (!uid){ statusEl && (statusEl.textContent = 'Pick a student.'); return; }
        statusEl && (statusEl.textContent = 'Loading…');
        try {
          if (nameEl && sel) nameEl.textContent = sel.options[sel.selectedIndex]?.textContent || uid;
          await renderCombinedTableCached(tbodyAdmin, uid);
          statusEl && (statusEl.textContent = '');
        } catch {
          statusEl && (statusEl.textContent = 'Failed to load.');
        }
      });
      loadBtn.dataset.bound = '1';
    }
  }

  const tbodyStu = $('progress-stu-tbody');
  if (!window.__isAdmin) {
    const uid = (window.__getCurrentUid && window.__getCurrentUid()) || null;
    if (uid) renderCombinedTableCached(tbodyStu, uid);
  }
}

window.__progress_refreshOnShow = () => {
  applyRoleVisibilityForProgress();
  if (window.__isAdmin) {
    // do nothing until admin picks a student
  } else {
    const uid = (window.__getCurrentUid && window.__getCurrentUid()) || null;
    if (uid) renderCombinedTableCached($('progress-stu-tbody'), uid);
  }
};

/* =========================
   ADMIN: Approvals - Enhanced with polling instead of real-time
   ========================= */
function wireApprovals() {
  const listEl = $("approvals-list");
  const container = $("admin-approvals-section");
  if (!listEl || !container) return;

  let refreshTimer = null;

  async function refreshApprovals() {
    if (!window.__isAdmin) { 
      listEl.innerHTML = '<div class="muted">Admin only.</div>'; 
      return; 
    }
    
    try {
      const cacheKey = 'pending_approvals';
      let rows = localCache.get(cacheKey);
      
      if (!rows) {
        listEl.innerHTML = '<div class="muted">Loading pending students…</div>';
        rows = await (window.__fb_listPending ? window.__fb_listPending() : []);
        localCache.set(cacheKey, rows, 30 * 1000); // Cache for 30 seconds
      }
      
      if (!rows.length) { 
        listEl.innerHTML = '<div class="muted">No pending approvals.</div>'; 
        return; 
      }

      listEl.innerHTML = '';
      rows.forEach(u => {
        const row = document.createElement('div');
        row.className = 'task-item';
        row.style.display = 'flex';
        row.style.alignItems = 'center';
        row.style.gap = '8px';
        const name = document.createElement('span');
        name.textContent = u.displayName || '(Unnamed)';
        const uid = document.createElement('code');
        uid.textContent = u.uid;
        uid.style.opacity = 0.8;
        uid.style.fontSize = '12px';
        const btn = document.createElement('button');
        btn.textContent = 'Approve';
        btn.onclick = async () => {
          btn.disabled = true;
          try { 
            await window.__fb_approveUser(u.uid); 
            localCache.clear('pending_approvals');
            localCache.clear('approved_students');
            refreshApprovals(); 
          }
          catch(e){ alert('Failed: ' + (e?.message || e)); btn.disabled = false; }
        };
        row.append(name, uid, btn);
        listEl.appendChild(row);
      });
    } catch (e) {
      console.error(e);
      const msg = (e && e.message) ? e.message : 'Failed to load.';
      listEl.innerHTML = `<div class="muted">${msg}</div>`;
    }
  }

  // Poll every 30 seconds instead of real-time updates
  function startPolling() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(refreshApprovals, 30000);
    refreshApprovals(); // Initial load
  }

  function stopPolling() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  // Observer for section visibility
  const observer = new MutationObserver(() => {
    if (!container.classList.contains('hidden')) {
      startPolling();
    } else {
      stopPolling();
    }
  });
  observer.observe(container, { attributes: true, attributeFilter: ['class'] });

  // Initial check
  if (!container.classList.contains('hidden')) startPolling();
}

/* =========================
   TASKS - Enhanced with caching and debounced operations
   ========================= */
function wireTasks() {
  const adminWrap   = $("tasks-admin");
  const titleIn     = $("task-title");
  const linkIn      = $("task-link");
  const dueIn       = $("task-due");
  const maxIn       = $("task-max");
  const descIn      = $("task-desc");
  const createBtn   = $("task-create");
  const adminList   = $("task-admin-list");

  const examUidIn   = $("exam-uid");
  const examScoreIn = $("exam-score");
  const examSaveBtn = $("exam-save");

  const studentWrap = $("tasks-student");
  const studentList = $("task-student-list");

  function toggleByRole() {
    if (adminWrap) adminWrap.classList.toggle('hidden', !window.__isAdmin);
    if (studentWrap) studentWrap.classList.toggle('hidden', !!window.__isAdmin);
  }

  async function listTasksForAdminCached() {
    if (!adminList) return;
    
    const wk = window.__getISOWeek ? window.__getISOWeek() : null;
    const cacheKey = `admin_tasks_${wk}`;
    let tasks = localCache.get(cacheKey);
    
    if (!tasks) {
      adminList.innerHTML = '<div class="muted">Loading…</div>';
      tasks = await (window.__fb_listTasks ? window.__fb_listTasks(wk || (void 0)) : []);
      localCache.set(cacheKey, tasks, 2 * 60 * 1000); // Cache for 2 minutes
    }
    
    adminList.innerHTML = '';
    if (!tasks.length) {
      adminList.innerHTML = '<div class="muted">No tasks this week.</div>';
      return;
    }
    
    tasks.forEach(t => {
      const row = document.createElement('div');
      row.className = 'task-item card';
      row.innerHTML = `
        <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
          <b>${t.title || '(Untitled)'}</b>
          <span class="muted">· Due: ${t.dueAt ? new Date(t.dueAt).toLocaleString() : 'No due'}</span>
          ${t.link ? `<a href="${t.link}" target="_blank" rel="noopener">Open link</a>` : ''}
        </div>
        <div class="muted" style="margin-top:6px;">${t.description || ''}</div>
        <div style="margin-top:8px; display:flex; gap:8px; flex-wrap:wrap;">
          <input data-edit="title"   placeholder="Edit title" value="${t.title || ''}">
          <input data-edit="link"    placeholder="Edit link" value="${t.link || ''}">
          <input data-edit="due"     type="datetime-local" value="">
          <input data-edit="max"     type="number" min="0" step="1" placeholder="Score max" value="${t.scoreMax ?? ''}">
        </div>
        <div style="margin-top:8px; display:flex; gap:8px; flex-wrap:wrap;">
          <textarea data-edit="desc" placeholder="Edit description">${t.description || ''}</textarea>
        </div>
        <div style="margin-top:8px; display:flex; gap:8px; flex-wrap:wrap;">
          <button data-action="save">Save</button>
          <button data-action="view">View Submissions</button>
          <button data-action="delete" style="background:#dc2626">Delete</button>
        </div>
      `;
      
      try {
        if (t.dueAt) {
          const dt = new Date(t.dueAt);
          const iso = new Date(dt.getTime() - dt.getTimezoneOffset()*60000).toISOString().slice(0,16);
          row.querySelector('input[data-edit="due"]').value = iso;
        }
      } catch {}

      row.querySelector('[data-action="save"]').onclick = async () => {
        const patch = {
          title: row.querySelector('input[data-edit="title"]').value.trim(),
          link: row.querySelector('input[data-edit="link"]').value.trim(),
          description: row.querySelector('textarea[data-edit="desc"]').value.trim()
        };
        const dueVal = row.querySelector('input[data-edit="due"]').value;
        if (dueVal) patch.dueAt = new Date(dueVal).toISOString();
        const maxVal = row.querySelector('input[data-edit="max"]').value;
        if (maxVal !== '') patch.scoreMax = Number(maxVal);
        try {
          await window.__fb_updateTask(window.__getISOWeek ? window.__getISOWeek() : undefined, t.id, patch);
          localCache.clear(`admin_tasks_${wk}`);
          await listTasksForAdminCached();
        } catch (e) {
          alert('Save failed: ' + (e?.message || e));
        }
      };

      row.querySelector('[data-action="view"]').onclick = () => {
        showSection("admin-submissions-section");
        if (typeof window.__subs_selectTaskId === 'function') window.__subs_selectTaskId(t.id);
      };

      row.querySelector('[data-action="delete"]').onclick = async () => {
        if (!confirm('Delete this task (and its submissions)?')) return;
        try {
          if (typeof window.__fb_deleteTask === 'function') {
            await window.__fb_deleteTask(window.__getISOWeek ? window.__getISOWeek() : undefined, t.id);
            localCache.clear(`admin_tasks_${wk}`);
            await listTasksForAdminCached();
          } else {
            alert('Missing __fb_deleteTask in firebase.js — update firebase.js to enable deletion.');
          }
        } catch (e) {
          alert('Delete failed: ' + (e?.message || e));
        }
      };

      adminList.appendChild(row);
    });
  }

  async function listTasksForStudentCached() {
    if (!studentList) return;
    
    const wk = window.__getISOWeek ? window.__getISOWeek() : null;
    const cacheKey = `student_tasks_${wk}`;
    const subsCacheKey = `student_subs_${wk}`;
    
    let tasks = localCache.get(cacheKey);
    let mySubs = localCache.get(subsCacheKey);
    
    if (!tasks || !mySubs) {
      studentList.innerHTML = '<div class="muted">Loading…</div>';
      tasks = tasks || await (window.__fb_listTasks ? window.__fb_listTasks(wk || (void 0)) : []);
      mySubs = mySubs || await (window.__fb_listMySubmissions ? window.__fb_listMySubmissions(wk || (void 0)) : {});
      
      if (!localCache.get(cacheKey)) localCache.set(cacheKey, tasks, 2 * 60 * 1000);
      if (!localCache.get(subsCacheKey)) localCache.set(subsCacheKey, mySubs, 1 * 60 * 1000);
    }
    
    studentList.innerHTML = '';
    if (!tasks.length) {
      studentList.innerHTML = '<div class="muted">No tasks assigned this week.</div>';
      return;
    }
    
    tasks.forEach(t => {
      const sub = mySubs[t.id] || {};
      const wrap = document.createElement('div');
      wrap.className = 'task-item card';
      wrap.innerHTML = `
        <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
          <b>${t.title || '(Untitled)'}</b>
          <span class="muted">· Due: ${t.dueAt ? new Date(t.dueAt).toLocaleString() : 'No due'}</span>
          ${t.link ? `<a href="${t.link}" target="_blank" rel="noopener">Open link</a>` : ''}
        </div>
        <div class="muted" style="margin-top:6px;">${t.description || ''}</div>
        <div style="margin-top:8px; display:flex; gap:8px; flex-wrap:wrap;">
          <input data-sub="link" placeholder="Your submission link/file URL" value="${sub.link || ''}">
          <button data-action="submit">Submit</button>
          <span class="muted">${sub.submittedAt ? 'Submitted' : 'Pending'}${(sub.score ?? null) !== null ? ` · Score: ${sub.score}/${t.scoreMax ?? '—'}` : ''}</span>
        </div>
      `;
      wrap.querySelector('[data-action="submit"]').onclick = async () => {
        const linkUrl = wrap.querySelector('input[data-sub="link"]').value.trim();
        if (!linkUrl) { alert('Please paste your submission link (e.g., Google Drive URL).'); return; }
        try {
          await window.__fb_submitTask(window.__getISOWeek ? window.__getISOWeek() : undefined, t.id, linkUrl);
          localCache.clear(subsCacheKey);
          await listTasksForStudentCached();
        } catch (e) {
          alert('Submit failed: ' + (e?.message || e));
        }
      };
      studentList.appendChild(wrap);
    });
  }

  // Debounced task creation to prevent double-clicks
  let createInProgress = false;
  async function createTask() {
    if (createInProgress) return;
    createInProgress = true;
    
    const data = {
      title: (titleIn?.value || "").trim(),
      description: (descIn?.value || "").trim(),
      link: (linkIn?.value || "").trim(),
      scoreMax: maxIn?.value ? Number(maxIn.value) : 0
    };
    const dueVal = dueIn?.value || "";
    if (dueVal) data.dueAt = new Date(dueVal).toISOString();
    if (!data.title) { 
      createInProgress = false;
      alert("Please add a title."); 
      return; 
    }
    try {
      await window.__fb_createTask(data);
      if (titleIn) titleIn.value = "";
      if (linkIn) linkIn.value = "";
      if (descIn) descIn.value = "";
      if (maxIn)  maxIn.value = "";
      if (dueIn)  dueIn.value = "";
      
      const wk = window.__getISOWeek ? window.__getISOWeek() : null;
      localCache.clear(`admin_tasks_${wk}`);
      await listTasksForAdminCached();
    } catch (e) {
      alert('Create failed: ' + (e?.message || e));
    } finally {
      createInProgress = false;
    }
  }

  async function saveExamScore() {
    const uid = examUidIn?.value.trim();
    const sc  = examScoreIn?.value.trim();
    if (!uid || sc === "") { alert("Provide UID and score."); return; }
    try {
      await window.__fb_setExamScore(window.__getISOWeek ? window.__getISOWeek() : undefined, uid, Number(sc));
      alert("Exam score saved.");
      examUidIn.value = ""; examScoreIn.value = "";
    } catch (e) {
      alert('Save failed: ' + (e?.message || e));
    }
  }

  // Wire events with guards
  if (createBtn && !createBtn.dataset.bound) { 
    createBtn.addEventListener('click', createTask, { passive: true }); 
    createBtn.dataset.bound = "1"; 
  }
  if (examSaveBtn && !examSaveBtn.dataset.bound) { 
    examSaveBtn.addEventListener('click', saveExamScore, { passive: true }); 
    examSaveBtn.dataset.bound = "1"; 
  }

  function refresh() {
    toggleByRole();
    if (window.__isAdmin) listTasksForAdminCached();
    else listTasksForStudentCached();
  }
  window.__tasks_refresh = refresh;

  refresh();
}

function refreshTasksUICached() {
  if (typeof window.__tasks_refresh === 'function') window.__tasks_refresh();
}

/* =========================
   ADMIN: Manage Students - Enhanced with caching
   ========================= */
function wireManageStudents() {
  const btn   = $("admin-refresh-students");
  const tbody = $("admin-students-tbody");
  if (!btn || !tbody) return;

  async function refreshCached() {
    if (!window.__isAdmin) { 
      tbody.innerHTML = '<tr><td colspan="3">Admin only.</td></tr>'; 
      return; 
    }
    
    const cacheKey = 'manage_students';
    let rows = localCache.get(cacheKey);
    
    if (!rows) {
      tbody.innerHTML = '<tr><td colspan="3">Loading…</td></tr>';
      rows = await (window.__fb_listApprovedStudents ? window.__fb_listApprovedStudents() : []);
      localCache.set(cacheKey, rows, 5 * 60 * 1000); // Cache for 5 minutes
    }
    
    tbody.innerHTML = '';
    if (!rows.length) { 
      tbody.innerHTML = '<tr><td colspan="3">No approved students.</td></tr>'; 
      return; 
    }
    
    rows.forEach(s => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${s.displayName || '(Unnamed)'}</td>
        <td><code>${s.uid}</code></td>
        <td>
          <button data-act="reset">Reset</button>
          <button data-act="delete" style="background:#dc2626">Delete</button>
        </td>
      `;
      tr.querySelector('[data-act="reset"]').onclick = async () => {
        if (!confirm(`Reset ${s.displayName || s.uid}?`)) return;
        try { 
          await window.__fb_adminResetUser(s.uid); 
          alert('Reset done.'); 
          localCache.clear(cacheKey);
          refreshCached(); 
        }
        catch(e){ alert('Reset failed: ' + (e?.message || e)); }
      };
      tr.querySelector('[data-act="delete"]').onclick = async () => {
        if (!confirm(`Delete ${s.displayName || s.uid}? This removes the Firestore user doc.`)) return;
        try { 
          await window.__fb_adminDeleteUser(s.uid); 
          alert('Deleted.'); 
          localCache.clear(cacheKey);
          refreshCached(); 
        }
        catch(e){ alert('Delete failed: ' + (e?.message || e)); }
      };
      tbody.appendChild(tr);
    });
  }

  if (!btn.dataset.bound) { 
    btn.addEventListener('click', () => {
      localCache.clear('manage_students');
      refreshCached();
    }); 
    btn.dataset.bound = "1"; 
  }
  
  // Auto-refresh when section is shown
  const cont = $("admin-manage-section");
  if (cont) {
    const obs = new MutationObserver(() => {
      if (!cont.classList.contains('hidden')) refreshCached();
    });
    obs.observe(cont, { attributes: true, attributeFilter: ['class'] });
  }
}