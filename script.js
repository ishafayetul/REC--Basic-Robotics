// script.js — UI glue for Practice, Lectures, Progress, Approvals, Attendance, Tasks, Submissions
// All Firebase operations are done via helpers exposed by firebase.js (window.__fb_*).

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

let sessionBuf = JSON.parse(localStorage.getItem("sessionBuf") || "null") || {
  deckName: "",
  mode: "mcq",
  correct: 0,
  wrong: 0,
  skipped: 0,
  total: 0,
  jpEnCorrect: 0,
  enJpCorrect: 0
};

let currentSectionId = "practice-select";
let committing = false;

/* =========================
   Tiny helpers
   ========================= */
const $ = (id) => document.getElementById(id);
const setText = (id, txt) => { const el = $(id); if (el) el.innerText = txt; };
function statusLine(id, msg) { const s = $(id); if (s) s.textContent = msg; }
function persistSession() { localStorage.setItem("sessionBuf", JSON.stringify(sessionBuf)); }
function percent(n, d) { return !d ? 0 : Math.floor((n / d) * 100); }
function shuffleArray(arr) { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; }

/* =========================
   Lifecycle
   ========================= */
window.onload = () => {
  // Hide the countdown badge if present
  const timer = $("todo-timer"); if (timer) timer.style.display = "none";

  loadPracticeManifest();
  loadLecturesManifest();
  renderProgress();
  wireApprovals();
  wireTasks();
  wireManageStudents();
  wireAdminSubmissions(); // new admin-only section
  initAttendance(); // sets up attendance tabs + handlers
  updateScore();
};

// Called by firebase.js once auth/admin resolved
window.__initAfterLogin = () => {
  // Refresh admin-dependent UIs
  wireApprovals();
  wireTasks();
  wireManageStudents();
  wireAdminSubmissions();
  renderProgress();
  // Hide admin-only nav items for students
  applyAdminNavVisibility(!!window.__isAdmin);
};

// Persist pending session safely on leave (firebase.js will try to commit next launch)
["pagehide", "beforeunload"].forEach(evt => {
  window.addEventListener(evt, () => {
    try { if (sessionBuf.total > 0) localStorage.setItem('pendingSession', JSON.stringify(sessionBuf)); } catch {}
  });
});

/* =========================
   Router
   ========================= */
function showSection(id) {
  // Leaving Practice? autosave buffered progress
  if (currentSectionId === "practice" && id !== "practice") {
    autoCommitIfNeeded("leaving practice");
  }

  document.querySelectorAll('.main-content main > section').forEach(sec => sec.classList.add('hidden'));
  const target = document.getElementById(id);
  if (target) target.classList.remove('hidden');

  currentSectionId = id;

  if (id === "practice") updateDeckProgress();
  if (id === "tasks-section") refreshTasksUI();
  if (id === "progress-section") renderProgress();
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
  // Buttons are defined in HTML; we'll hide admin ones for students
  // Admin buttons have these targets in your HTML. 
  const adminBtns = [
    "admin-approvals-section",
    "admin-manage-section",
    "admin-submissions-section" // injected button id below
  ];
  // Inject "Admin: View Submissions" button when admin
  let subsBtn = sidebar.querySelector('button[data-nav="admin-submissions-section"]');
  if (isAdmin && !subsBtn) {
    subsBtn = document.createElement("button");
    subsBtn.dataset.nav = "admin-submissions-section";
    subsBtn.textContent = "📥 Admin: View Submissions";
    subsBtn.onclick = () => showSection("admin-submissions-section");
    sidebar.insertBefore(subsBtn, sidebar.querySelector('button[onclick*="simulation-section"]') || sidebar.lastElementChild);
  }
  // Toggle visibility
  adminBtns.forEach(id => {
    const btn = id === "admin-submissions-section"
      ? sidebar.querySelector('button[data-nav="admin-submissions-section"]')
      : sidebar.querySelector(`button[onclick*="${id}"]`);
    if (btn) btn.style.display = isAdmin ? "" : "none";
  });
}

/* =========================
   PRACTICE (MCQ)
   ========================= */
async function loadPracticeManifest() {
  try {
    statusLine("practice-status", "Loading practice sets…");
    const res = await fetch("practice/questions.json");
    if (!res.ok) throw new Error(`HTTP ${res.status} for practice/questions.json`);
    const text = await res.text();
    if (text.trim().startsWith("<")) throw new Error("Got HTML instead of JSON for practice/questions.json");

    const setList = JSON.parse(text); // ["Lecture-01.csv", ...]
    setList.sort((a,b)=>a.localeCompare(b, undefined, {numeric:true}));

    allSets = {};
    for (const file of setList) {
      const name = file.replace(".csv", "");
      const url = `practice/${file}`;
      statusLine("practice-status", `Loading ${file}…`);
      const questions = await fetchAndParseMCQ(url);
      allSets[name] = questions;
    }
    renderPracticeButtons();
    statusLine("practice-status", `Loaded ${Object.keys(allSets).length} set(s).`);
  } catch (err) {
    console.error("Practice manifest load failed:", err);
    statusLine("practice-status", `Failed to load: ${err.message}`);
  }
}

async function fetchAndParseMCQ(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const text = await res.text();

  const lines = text.replace(/\r\n?/g, "\n").split("\n").filter(Boolean);
  const rows = lines.map((line) => {
    // CSV format: Question, option1, option2, option3, option4  (no header)
    const parts = line.split(",");
    const q  = (parts[0] || "").trim();
    const o1 = (parts[1] || "").trim();
    const o2 = (parts[2] || "").trim();
    const o3 = (parts[3] || "").trim();
    const o4 = (parts[4] || "").trim();
    const options = [o1, o2, o3, o4].filter(Boolean);
    return { q, options, correctIndex: 0 }; // first option is correct
  }).filter(r => r.q && r.options.length >= 2);
  return rows;
}

function renderPracticeButtons() {
  const container = $("practice-buttons");
  if (!container) return;
  container.innerHTML = "";
  Object.keys(allSets).forEach((name) => {
    const btn = document.createElement("button");
    btn.textContent = name;
    btn.onclick = async () => {
      if (sessionBuf.total > 0 && sessionBuf.deckName && sessionBuf.deckName !== name) {
        await autoCommitIfNeeded("switch set");
      }
      selectSet(name);
    };
    container.appendChild(btn);
  });
}

function selectSet(name) {
  currentSet = allSets[name] || [];
  currentSetName = name;
  currentIndex = 0;
  if (currentSet.length === 0) { alert(`Set "${name}" is empty.`); return; }

  score = { correct: 0, wrong: 0, skipped: 0 };
  sessionBuf = { deckName: name, mode: "mcq", correct: 0, wrong: 0, skipped: 0, total: 0, jpEnCorrect: 0, enJpCorrect: 0 };
  persistSession();
  showSection("practice");
  showQuestion();
  updateScore();
  updateDeckProgress();
}

function showQuestion() {
  const q = currentSet[currentIndex];
  if (!q) return nextQuestion();

  setText("question-box", q.q);
  const optionsList = $("options"); if (!optionsList) return;
  optionsList.innerHTML = "";

  const shuffled = q.options.slice();
  // No shuffling required by spec.

  const correct = q.options[q.correctIndex];
  shuffled.forEach((opt) => {
    const li = document.createElement("li");
    li.textContent = opt;
    li.onclick = () => checkAnswer(opt, correct, q);
    optionsList.appendChild(li);
  });

  updateDeckProgress();
}

function checkAnswer(selected, correct, qObj) {
  const options = document.querySelectorAll("#options li");
  options.forEach((li) => {
    if (li.textContent === correct) li.classList.add("correct");
    else if (li.textContent === selected) li.classList.add("wrong");
  });

  const key = qObj.q + "|" + correct;

  if (selected === correct) {
    score.correct++; sessionBuf.correct++; sessionBuf.total++; sessionBuf.jpEnCorrect++;
    masteryMap[key] = (masteryMap[key] || 0) + 1;
    if (masteryMap[key] >= 5) mistakes = mistakes.filter((m) => m.q !== qObj.q);
  } else {
    score.wrong++; sessionBuf.wrong++; sessionBuf.total++;
    masteryMap[key] = 0; mistakes.push(qObj);
  }

  localStorage.setItem("mistakes", JSON.stringify(mistakes));
  localStorage.setItem("masteryMap", JSON.stringify(masteryMap));
  persistSession();
  updateScore();
  setTimeout(() => { nextQuestion(); updateDeckProgress(); }, 500);
}

function skipQuestion() {
  const qObj = currentSet[currentIndex]; if (!qObj) return;
  const key = qObj.q + "|" + (qObj.options[qObj.correctIndex] || "");
  score.skipped++; sessionBuf.skipped++; sessionBuf.total++; masteryMap[key] = 0; mistakes.push(qObj);
  localStorage.setItem("mistakes", JSON.stringify(mistakes));
  localStorage.setItem("masteryMap", JSON.stringify(masteryMap));
  persistSession(); updateScore(); nextQuestion(); updateDeckProgress();
}
window.skipQuestion = skipQuestion;

function nextQuestion() {
  currentIndex++;
  if (currentIndex >= currentSet.length) {
    alert(`Finished! ✅ ${score.correct} ❌ ${score.wrong} ➖ ${score.skipped}\nSaving your progress…`);
    showSection("practice-select");
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

async function autoCommitIfNeeded(reason = "") {
  if (!window.__fb_commitSession || committing) return;
  if (!sessionBuf || sessionBuf.total <= 0) return;
  try {
    committing = true;
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
    // reset counters but keep set metadata
    Object.assign(sessionBuf, { correct:0, wrong:0, skipped:0, total:0, jpEnCorrect:0, enJpCorrect:0 });
    persistSession();
    await renderProgress();
  } catch (e) {
    console.warn("[autosave] failed; keeping local buffer:", e?.message || e);
  } finally {
    committing = false;
  }
}

/* =========================
   MISTAKES
   ========================= */
function startMistakePractice() {
  if (mistakes.length === 0) return alert("No mistakes yet!");
  currentSet = mistakes.slice();
  currentSetName = "Mistakes";
  currentIndex = 0;
  showSection("practice");
  score = { correct: 0, wrong: 0, skipped: 0 };
  sessionBuf = { deckName: "Mistakes", mode: "mcq", correct: 0, wrong: 0, skipped: 0, total: 0, jpEnCorrect: 0, enJpCorrect: 0 };
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
   LECTURES
   ========================= */
async function loadLecturesManifest() {
  try {
    statusLine("lectures-status", "Loading lectures…");
    const res = await fetch("lectures/lectures.json");
    if (!res.ok) throw new Error(`HTTP ${res.status} for lectures/lectures.json`);
    const t = await res.text();
    if (t.trim().startsWith("<")) throw new Error("Got HTML instead of JSON for lectures manifest");
    const list = JSON.parse(t); // string[] of PDF filenames

    const container = $("lectures-list");
    if (!container) return;
    container.innerHTML = "";
    list.forEach((file) => {
      const btn = document.createElement("button");
      btn.textContent = file.replace(".pdf", "");
      btn.onclick = () => window.open(`lectures/${file}`, "_blank");
      container.appendChild(btn);
    });
    statusLine("lectures-status", `Loaded ${list.length} lecture file(s).`);
  } catch (err) {
    console.error("Lectures manifest load failed:", err);
    statusLine("lectures-status", `Failed to load lectures: ${err.message}`);
  }
}

/* =========================
   PROGRESS (attempts + weekly overview)
   ========================= */
async function renderProgress() {
  try {
    // attempts table
    if (window.__fb_fetchAttempts) {
      const attempts = await window.__fb_fetchAttempts(50);
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
    }

    // weekly overview (tasks + attendance + exam)
    const obody = $("overview-body");
    if (obody && window.__fb_fetchWeeklyOverview) {
      obody.innerHTML = `<tr><td colspan="3">Loading weekly overview…</td></tr>`;
      const w = await window.__fb_fetchWeeklyOverview();
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
  } catch (e) {
    console.warn("renderProgress failed:", e);
  }
}
window.renderProgress = renderProgress;

/* =========================
   ADMIN: Approvals
   ========================= */
function wireApprovals() {
  const listEl = $("approvals-list");
  const container = $("admin-approvals-section");
  if (!listEl || !container) return;

  async function refreshApprovals() {
    if (!window.__isAdmin) { listEl.innerHTML = '<div class="muted">Admin only.</div>'; return; }
    try {
      listEl.innerHTML = '<div class="muted">Loading pending students…</div>';
      const rows = await (window.__fb_listPending ? window.__fb_listPending() : []);
      if (!rows.length) { listEl.innerHTML = '<div class="muted">No pending approvals.</div>'; return; }

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
          try { await window.__fb_approveUser(u.uid); refreshApprovals(); }
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

  // auto-refresh whenever section is shown
  const observer = new MutationObserver(() => {
    if (!container.classList.contains('hidden')) refreshApprovals();
  });
  observer.observe(container, { attributes: true, attributeFilter: ['class'] });

  // initial (if section already visible)
  if (!container.classList.contains('hidden')) refreshApprovals();
}

/* =========================
   TASKS (Admin + Student)
   ========================= */
function wireTasks() {
  // Admin controls
  const adminWrap   = $("tasks-admin");
  const titleIn     = $("task-title");
  const linkIn      = $("task-link");
  const dueIn       = $("task-due");
  const maxIn       = $("task-max");
  const descIn      = $("task-desc");
  const createBtn   = $("task-create");
  const adminList   = $("task-admin-list");

  // Exam set
  const examUidIn   = $("exam-uid");
  const examScoreIn = $("exam-score");
  const examSaveBtn = $("exam-save");

  // Student view
  const studentWrap = $("tasks-student");
  const studentList = $("task-student-list");

  function toggleByRole() {
    if (adminWrap) adminWrap.classList.toggle('hidden', !window.__isAdmin);
    if (studentWrap) studentWrap.classList.toggle('hidden', !!window.__isAdmin);
  }

  async function listTasksForAdmin() {
    if (!adminList) return;
    adminList.innerHTML = '<div class="muted">Loading…</div>';
    try {
      const wk = window.__getISOWeek ? window.__getISOWeek() : null;
      const tasks = await (window.__fb_listTasks ? window.__fb_listTasks(wk || (void 0)) : []);
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
        // fill datetime-local if t.dueAt is an ISO/timestamp
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
            await listTasksForAdmin();
          } catch (e) {
            alert('Save failed: ' + (e?.message || e));
          }
        };

        row.querySelector('[data-action="view"]').onclick = () => {
          // jump to the Admin Submissions section and preselect this task
          showSection("admin-submissions-section");
          if (typeof window.__subs_selectTaskId === 'function') window.__subs_selectTaskId(t.id);
        };

        row.querySelector('[data-action="delete"]').onclick = async () => {
          if (!confirm('Delete this task (and its submissions)?')) return;
          try {
            if (typeof window.__fb_deleteTask === 'function') {
              await window.__fb_deleteTask(window.__getISOWeek ? window.__getISOWeek() : undefined, t.id);
              await listTasksForAdmin();
            } else {
              alert('Missing __fb_deleteTask in firebase.js — update firebase.js to enable deletion.');
            }
          } catch (e) {
            alert('Delete failed: ' + (e?.message || e));
          }
        };

        adminList.appendChild(row);
      });
    } catch (e) {
      adminList.innerHTML = '<div class="muted">Failed to load tasks.</div>';
      console.error(e);
    }
  }

  async function listTasksForStudent() {
    if (!studentList) return;
    studentList.innerHTML = '<div class="muted">Loading…</div>';
    try {
      const wk = window.__getISOWeek ? window.__getISOWeek() : null;
      const tasks = await (window.__fb_listTasks ? window.__fb_listTasks(wk || (void 0)) : []);
      const mySubs = await (window.__fb_listMySubmissions ? window.__fb_listMySubmissions(wk || (void 0)) : {});
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
            await listTasksForStudent();
          } catch (e) {
            alert('Submit failed: ' + (e?.message || e));
          }
        };
        studentList.appendChild(wrap);
      });
    } catch (e) {
      studentList.innerHTML = '<div class="muted">Failed to load tasks.</div>';
      console.error(e);
    }
  }

  async function createTask() {
    const data = {
      title: (titleIn?.value || "").trim(),
      description: (descIn?.value || "").trim(),
      link: (linkIn?.value || "").trim(),
      scoreMax: maxIn?.value ? Number(maxIn.value) : 0
    };
    const dueVal = dueIn?.value || "";
    if (dueVal) data.dueAt = new Date(dueVal).toISOString();
    if (!data.title) { alert("Please add a title."); return; }
    try {
      await window.__fb_createTask(data);
      if (titleIn) titleIn.value = "";
      if (linkIn) linkIn.value = "";
      if (descIn) descIn.value = "";
      if (maxIn)  maxIn.value = "";
      if (dueIn)  dueIn.value = "";
      await listTasksForAdmin();
    } catch (e) {
      alert('Create failed: ' + (e?.message || e));
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

  // Wire events (guarded to avoid duplicate listeners that caused double task creation)
  if (createBtn && !createBtn.dataset.bound) { createBtn.addEventListener('click', createTask, { passive: true }); createBtn.dataset.bound = "1"; }
  if (examSaveBtn && !examSaveBtn.dataset.bound) { examSaveBtn.addEventListener('click', saveExamScore, { passive: true }); examSaveBtn.dataset.bound = "1"; }

  // Refresh based on role & section visibility
  function refresh() {
    toggleByRole();
    if (window.__isAdmin) listTasksForAdmin();
    else listTasksForStudent();
  }
  window.__tasks_refresh = refresh;

  // Initial pass
  refresh();
}

// Refresh tasks when the section is shown
function refreshTasksUI() {
  if (typeof window.__tasks_refresh === 'function') window.__tasks_refresh();
}

/* =========================
   ADMIN: Manage Students (Reset/Delete) — Refresh List button
   ========================= */
function wireManageStudents() {
  const btn   = $("admin-refresh-students");
  const tbody = $("admin-students-tbody");
  if (!btn || !tbody) return;

  async function refresh() {
    if (!window.__isAdmin) { tbody.innerHTML = '<tr><td colspan="3">Admin only.</td></tr>'; return; }
    tbody.innerHTML = '<tr><td colspan="3">Loading…</td></tr>';
    try {
      const rows = await (window.__fb_listApprovedStudents ? window.__fb_listApprovedStudents() : []);
      tbody.innerHTML = '';
      if (!rows.length) { tbody.innerHTML = '<tr><td colspan="3">No approved students.</td></tr>'; return; }
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
          try { await window.__fb_adminResetUser(s.uid); alert('Reset done.'); refresh(); }
          catch(e){ alert('Reset failed: ' + (e?.message || e)); }
        };
        tr.querySelector('[data-act="delete"]').onclick = async () => {
          if (!confirm(`Delete ${s.displayName || s.uid}? This removes the Firestore user doc.`)) return;
          try { await window.__fb_adminDeleteUser(s.uid); alert('Deleted.'); refresh(); }
          catch(e){ alert('Delete failed: ' + (e?.message || e)); }
        };
        tbody.appendChild(tr);
      });
    } catch (e) {
      console.error(e);
      tbody.innerHTML = '<tr><td colspan="3">Failed to load.</td></tr>';
    }
  }

  if (!btn.dataset.bound) { btn.addEventListener('click', refresh); btn.dataset.bound = "1"; }
  // Auto-refresh when section is shown
  const cont = $("admin-manage-section");
  if (cont) {
    const obs = new MutationObserver(() => {
      if (!cont.classList.contains('hidden')) refresh();
    });
    obs.observe(cont, { attributes: true, attributeFilter: ['class'] });
  }
}

/* =========================
   ADMIN: View Submissions (navbar item injected for admins)
   ========================= */
function wireAdminSubmissions() {
  // Build section if not present
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

  const select = $("subs-task-select");
  const refreshBtn = $("subs-refresh");
  const tbody = $("subs-tbody");

  async function loadTasksIntoSelect() {
    if (!window.__isAdmin) { select.innerHTML = `<option value="">Admin only</option>`; return; }
    try {
      const wk = window.__getISOWeek ? window.__getISOWeek() : undefined;
      const tasks = await (window.__fb_listTasks ? window.__fb_listTasks(wk) : []);
      select.innerHTML = `<option value="">— Select a task —</option>`;
      tasks.forEach(t => {
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = `${t.title || '(Untitled)'} — ${t.dueAt ? new Date(t.dueAt).toLocaleString() : 'No due'}`;
        select.appendChild(opt);
      });
    } catch (e) {
      console.warn('loadTasksIntoSelect failed:', e);
      select.innerHTML = `<option value="">Failed to load tasks</option>`;
    }
  }

  async function loadSubmissions() {
    if (!window.__isAdmin) { tbody.innerHTML = '<tr><td colspan="4">Admin only.</td></tr>'; return; }
    const taskId = select.value;
    if (!taskId) { tbody.innerHTML = '<tr><td colspan="4">Pick a task.</td></tr>'; return; }
    try {
      if (typeof window.__fb_listSubmissions !== 'function') {
        tbody.innerHTML = '<tr><td colspan="4">Please update firebase.js to include __fb_listSubmissions.</td></tr>';
        return;
      }
      const wk = window.__getISOWeek ? window.__getISOWeek() : undefined;
      const subs = await window.__fb_listSubmissions(wk, taskId);
      tbody.innerHTML = '';
      if (!subs.length) { tbody.innerHTML = '<tr><td colspan="4">No submissions yet.</td></tr>'; return; }
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
            alert('Saved.');
          } catch (e) {
            alert('Save failed: ' + (e?.message || e));
          }
        };
        tbody.appendChild(tr);
      });
    } catch (e) {
      console.error(e);
      tbody.innerHTML = '<tr><td colspan="4">Failed to load.</td></tr>';
    }
  }

  // Bind (guarded)
  if (refreshBtn && !refreshBtn.dataset.bound) { refreshBtn.addEventListener('click', loadSubmissions); refreshBtn.dataset.bound = "1"; }
  if (select && !select.dataset.bound) { select.addEventListener('change', loadSubmissions); select.dataset.bound = "1"; }

  // Expose helpers for deep-linking from Tasks
  window.__subs_refreshOnShow = async () => {
    applyAdminNavVisibility(!!window.__isAdmin);
    await loadTasksIntoSelect();
    await loadSubmissions();
  };
  window.__subs_selectTaskId = async (taskId) => {
    await loadTasksIntoSelect();
    if (select) select.value = taskId || '';
    await loadSubmissions();
  };

  // If this section is already visible (e.g., after injection), initialize it
  if (!section.classList.contains('hidden')) window.__subs_refreshOnShow();
}

/* =========================
   ATTENDANCE (Admin + Student)
   ========================= */
function initAttendance() {
  // Elements
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

  // Defaults: fill today in date pickers
  (function initDates(){
    const t = new Date();
    const yyyy = t.getFullYear(), mm = String(t.getMonth()+1).padStart(2,'0'), dd = String(t.getDate()).padStart(2,'0');
    if (dateInput)     dateInput.value = `${yyyy}-${mm}-${dd}`;
    if (histDateInput) histDateInput.value = `${yyyy}-${mm}-${dd}`;
  })();

  // Tabs
  tabTake?.addEventListener('click', () => {
    tabTake.classList.add('active'); tabHistory?.classList.remove('active');
    paneTake?.classList.remove('hidden'); paneHistory?.classList.add('hidden');
  });
  tabHistory?.addEventListener('click', () => {
    tabHistory.classList.add('active'); tabTake?.classList.remove('active');
    paneHistory?.classList.remove('hidden'); paneTake?.classList.add('hidden');
    if (histBody) histBody.innerHTML = '<tr><td colspan="2">Pick a date and press “Load History”.</td></tr>';
    if (histMeta) histMeta.textContent = '—';
  });

  let students = []; // [{uid, displayName}]
  let stateMap = {}; // uid -> {present:boolean}
  let dirty = false;

  const dateKey = () => (dateInput?.value || '').trim();
  const setStatus = (m) => { if (statusEl) statusEl.textContent = m || ''; };
  const setSaveStatus = (m) => { if (saveStatus) saveStatus.textContent = m || ''; };

  function renderNote() {
    const isAdmin = !!window.__isAdmin;

    // Toggle admin vs student panels
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

    // Disable admin-only controls if not admin
    [classNoSel, dateInput, histDateInput, markAllBtn, clearAllBtn, saveBtn].forEach(el => { if (el) el.disabled = !isAdmin; });

    if (!isAdmin) renderMyAttendance();
  }

  async function loadAttendance() {
    if (!window.__isAdmin) return;
    if (!tableBody || !dateKey()) return;

    setStatus('Loading students & attendance…');
    setSaveStatus(''); dirty = false;
    try {
      students = await (window.__fb_listStudents ? window.__fb_listStudents() : []);
      const att = await (window.__fb_getAttendance ? window.__fb_getAttendance(dateKey()) : {});
      stateMap = {};
      students.forEach(s => { stateMap[s.uid] = { present: !!(att[s.uid]?.present), displayName: s.displayName || null }; });

      // render table
      tableBody.innerHTML = '';
      students.forEach(s => {
        const tr = document.createElement('tr');
        const nameTd = document.createElement('td'); nameTd.textContent = s.displayName || '(Unnamed)';
        const presentTd = document.createElement('td');
        const chk = document.createElement('input'); chk.type = 'checkbox'; chk.className = 'att-present'; chk.checked = !!stateMap[s.uid]?.present;
        chk.onchange = () => { stateMap[s.uid] = { present: chk.checked, displayName: s.displayName }; dirty = true; };
        presentTd.appendChild(chk);
        tr.append(nameTd, presentTd);
        tableBody.appendChild(tr);
      });
      setStatus(`Loaded ${students.length} students.`);

      // meta: class no
      try {
        const meta = await (window.__fb_getAttendanceMeta ? window.__fb_getAttendanceMeta(dateKey()) : {});
        if (classNoSel) {
          const v = (meta.classNo ?? '').toString();
          classNoSel.value = v && Array.from(classNoSel.options).some(o => o.value === v) ? v : '';
        }
      } catch { if (classNoSel) classNoSel.value = ''; }

      renderNote();
    } catch (e) {
      console.error(e);
      setStatus('Failed to load attendance.');
    }
  }

  async function saveAttendance() {
    if (!window.__isAdmin || !dateKey()) return;
    try {
      if (classNoSel && classNoSel.value !== '') {
        try { await (window.__fb_setAttendanceMeta ? window.__fb_setAttendanceMeta(dateKey(), Number(classNoSel.value)) : Promise.resolve()); }
        catch(e){ console.warn('setAttendanceMeta failed', e); }
      }
      if (dirty) {
        const records = students.map(s => ({ uid: s.uid, present: !!(stateMap[s.uid]?.present), displayName: s.displayName }));
        await (window.__fb_saveAttendanceBulk ? window.__fb_saveAttendanceBulk(dateKey(), records) : Promise.resolve());
        dirty = false;
      }
      setSaveStatus('Saved ✔');
    } catch (e) {
      console.error(e);
      setSaveStatus('Save failed.');
    }
  }

  async function loadHistoryAdmin() {
    if (!window.__isAdmin) return;
    if (!histBody || !histDateInput) return;
    const dkey = (histDateInput.value || '').trim();
    if (!dkey) {
      histBody.innerHTML = '<tr><td colspan="2">Pick a date first.</td></tr>';
      if (histMeta) histMeta.textContent = '—';
      return;
    }
    histBody.innerHTML = '<tr><td colspan="2">Loading…</td></tr>';
    if (histMeta) histMeta.textContent = 'Loading…';
    try {
      const studentsList = await (window.__fb_listStudents ? window.__fb_listStudents() : []);
      const att = await (window.__fb_getAttendance ? window.__fb_getAttendance(dkey) : {});
      let presentCount = 0;
      histBody.innerHTML = '';
      studentsList.forEach(s => {
        const isPresent = !!(att[s.uid]?.present);
        if (isPresent) presentCount++;
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${s.displayName || '(Unnamed)'}</td><td>${isPresent ? 'Present' : 'Absent'}</td>`;
        histBody.appendChild(tr);
      });
      const absentCount = studentsList.length - presentCount;
      const meta = await (window.__fb_getAttendanceMeta ? window.__fb_getAttendanceMeta(dkey) : {});
      const classNoTxt = meta?.classNo ? `Class No: ${meta.classNo} · ` : '';
      if (histMeta) histMeta.textContent = `${classNoTxt}Present: ${presentCount} · Absent: ${absentCount} · Total: ${studentsList.length}`;
    } catch (e) {
      console.error(e);
      histBody.innerHTML = '<tr><td colspan="2">Failed to load.</td></tr>';
      if (histMeta) histMeta.textContent = 'Failed to load.';
    }
  }

  async function renderMyAttendance() {
    if (!myTableBody) return;
    myTableBody.innerHTML = '<tr><td colspan="3">Loading…</td></tr>';
    try {
      const rows = await (window.__fb_getMyAttendanceHistoryWithClass ? window.__fb_getMyAttendanceHistoryWithClass(180) : []);
      myTableBody.innerHTML = '';
      if (!rows.length) { myTableBody.innerHTML = '<tr><td colspan="3">No records yet.</td></tr>'; return; }
      rows.forEach(r => {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${r.date}</td><td>${r.classNo ?? '—'}</td><td>${r.present ? 'Present' : 'Absent'}</td>`;
        myTableBody.appendChild(tr);
      });
    } catch (e) {
      console.warn(e);
      myTableBody.innerHTML = '<tr><td colspan="3">Failed to load.</td></tr>';
    }
  }
  window.__att_renderMyAttendance = renderMyAttendance;

  // Wire events
  if (loadBtn && !loadBtn.dataset.bound) { loadBtn.addEventListener('click', loadAttendance); loadBtn.dataset.bound = "1"; }
  dateInput?.addEventListener('change', loadAttendance);
  if (markAllBtn && !markAllBtn.dataset.bound) { markAllBtn.addEventListener('click', () => {
    if (!window.__isAdmin) return;
    document.querySelectorAll('.att-present').forEach(inp => { inp.checked = true; });
    students.forEach(s => stateMap[s.uid] = { present: true, displayName: s.displayName });
    dirty = true;
  }); markAllBtn.dataset.bound = "1"; }
  if (clearAllBtn && !clearAllBtn.dataset.bound) { clearAllBtn.addEventListener('click', () => {
    if (!window.__isAdmin) return;
    document.querySelectorAll('.att-present').forEach(inp => { inp.checked = false; });
    students.forEach(s => stateMap[s.uid] = { present: false, displayName: s.displayName });
    dirty = true;
  }); clearAllBtn.dataset.bound = "1"; }
  if (saveBtn && !saveBtn.dataset.bound) { saveBtn.addEventListener('click', saveAttendance); saveBtn.dataset.bound = "1"; }
  if (histLoadBtn && !histLoadBtn.dataset.bound) { histLoadBtn.addEventListener('click', loadHistoryAdmin); histLoadBtn.dataset.bound = "1"; }

  // Expose a hook so router can refresh on show
  window.__att_refreshOnShow = () => {
    if (window.__isAdmin) loadAttendance();
    else renderMyAttendance();
    renderNote();
  };

  // First pass
  renderNote();
  if (window.__isAdmin) loadAttendance(); else renderMyAttendance();
}

// React to admin role toggles immediately (called from firebase.js)
window.__onAdminStateChanged = function(isAdmin) {
  applyAdminNavVisibility(!!isAdmin);
  // Attendance refresh
  if (currentSectionId === 'attendance-section' && typeof window.__att_refreshOnShow === 'function') {
    window.__att_refreshOnShow();
  }
  // Tasks refresh
  if (currentSectionId === 'tasks-section' && typeof window.__tasks_refresh === 'function') {
    window.__tasks_refresh();
  }
  // Submissions refresh
  if (currentSectionId === 'admin-submissions-section' && typeof window.__subs_refreshOnShow === 'function') {
    window.__subs_refreshOnShow();
  }
};
