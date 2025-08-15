// script.js — Practice (MCQ), Lectures list, Progress, Leaderboards UI glue
// NOTE: All Firebase access is delegated to firebase.js helpers on window.*
// This file contains NO direct Firebase imports.

// ---------------- State ----------------
let allSets = {};                // { setName: [{q, options:[4], correctIndex:0}] }
let currentSet = [];
let currentSetName = "";
let currentIndex = 0;
let score = { correct: 0, wrong: 0, skipped: 0 };

let mistakes = JSON.parse(localStorage.getItem("mistakes") || "[]");
let masteryMap = JSON.parse(localStorage.getItem("masteryMap") || "{}");

// Session buffer (temporary storage; committed on demand/auto via firebase.js)
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

// ---------------- DOM helpers ----------------
const $ = (id) => document.getElementById(id);
const setText = (id, txt) => { const el = $(id); if (el) el.innerText = txt; };
function statusLine(id, msg) {
  const s = $(id);
  if (s) s.textContent = msg;
  console.log(`[status:${id}]`, msg);
}
function persistSession() {
  localStorage.setItem("sessionBuf", JSON.stringify(sessionBuf));
}
function percent(n, d) {
  if (!d) return 0;
  return Math.floor((n / d) * 100);
}

// ---------------- Set progress UI ----------------
function updateDeckProgress() {
  const totalQs = currentSet.length || 0;
  const done = Math.min(currentIndex, totalQs);
  const p = percent(done, totalQs);
  const bar = $("deck-progress-bar");
  const txt = $("deck-progress-text");
  if (bar) bar.style.width = `${p}%`;
  if (txt) txt.textContent = `${done} / ${totalQs} (${p}%)`;
}

// ---------------- Autosave bridge ----------------
async function autoCommitIfNeeded(reason = "") {
  if (!window.__fb_commitSession) return;
  if (committing) return;
  if (!sessionBuf || sessionBuf.total <= 0) return;

  try {
    committing = true;
    console.log("[autosave] committing buffered session", { reason, sessionBuf });
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

    // Reset counts but keep set name and mode
    sessionBuf.correct = 0;
    sessionBuf.wrong = 0;
    sessionBuf.skipped = 0;
    sessionBuf.total = 0;
    sessionBuf.jpEnCorrect = 0;
    sessionBuf.enJpCorrect = 0;
    persistSession();

    await renderProgress();
    console.log("[autosave] saved ✔");
  } catch (e) {
    console.warn("[autosave] failed → keeping local buffer:", e?.message || e);
  } finally {
    committing = false;
  }
}

// ---------------- App lifecycle ----------------
window.onload = () => {
  loadPracticeManifest();
  loadLecturesManifest();
  renderProgress();
  updateScore();
};

// Called by firebase.js when auth is ready
window.__initAfterLogin = () => {
  renderProgress();
};

// Best-effort: persist pending session for next launch auto-commit
window.addEventListener('pagehide', () => {
  try {
    if (sessionBuf.total > 0) {
      localStorage.setItem('pendingSession', JSON.stringify(sessionBuf));
    }
  } catch {}
});
window.addEventListener('beforeunload', () => {
  try {
    if (sessionBuf.total > 0) {
      localStorage.setItem('pendingSession', JSON.stringify(sessionBuf));
    }
  } catch {}
});

// ---------------- Section Router ----------------
function showSection(id) {
  // Leaving Practice? autosave the buffered progress
  if (currentSectionId === "practice" && id !== "practice") {
    autoCommitIfNeeded("leaving practice");
  }

  document.querySelectorAll('.main-content main > section').forEach(sec => {
    sec.classList.add('hidden');
  });
  const target = document.getElementById(id);
  if (target) target.classList.remove('hidden');
  else console.warn('showSection: no element with id:', id);

  currentSectionId = id;

  // Attendance: render appropriate view depending on role
  if (id === 'attendance-section') {
    if (window.__isAdmin) {
      if (typeof window.__att_renderNote === 'function') window.__att_renderNote();
    } else {
      if (typeof window.__att_renderMyAttendance === 'function') window.__att_renderMyAttendance();
      if (typeof window.__att_renderNote === 'function') window.__att_renderNote();
    }
  }

  if (id === "practice") updateDeckProgress();
}
window.showSection = showSection;

// ---------------- PRACTICE (MCQ) ----------------
async function loadPracticeManifest() {
  try {
    statusLine("practice-status", "Loading practice sets…");
    const res = await fetch("practice/questions.json");
    if (!res.ok) throw new Error(`HTTP ${res.status} for practice/questions.json`);
    const text = await res.text();
    if (text.trim().startsWith("<")) throw new Error("Manifest is HTML (check path/case for practice/questions.json)");

    /** @type {string[]} */
    const setList = JSON.parse(text);
    setList.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

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
    console.error("Failed to load practice sets:", err);
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
    // Assumption: option1 is the correct answer
    const options = [o1, o2, o3, o4].filter(Boolean);
    return { q, options, correctIndex: 0 };
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
        await autoCommitIfNeeded("switching sets");
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
  if (currentSet.length === 0) {
    alert(`Set "${name}" is empty or failed to load.`);
    return;
  }
  sessionBuf = {
    deckName: name,
    mode: "mcq",
    correct: 0, wrong: 0, skipped: 0, total: 0,
    jpEnCorrect: 0, enJpCorrect: 0
  };
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
  setText("extra-info", "");

  const optionsList = $("options");
  if (!optionsList) return;
  optionsList.innerHTML = "";

  const shuffled = q.options.slice();
  shuffleArray(shuffled);

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
    score.correct++;
    sessionBuf.correct++;
    sessionBuf.total++;
    sessionBuf.jpEnCorrect++;   // store MCQ corrects here for scoring

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

  localStorage.setItem("mistakes", JSON.stringify(mistakes));
  localStorage.setItem("masteryMap", JSON.stringify(masteryMap));
  persistSession();
  updateScore();
  setTimeout(() => {
    nextQuestion();
    updateDeckProgress();
  }, 600);
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

  localStorage.setItem("mistakes", JSON.stringify(mistakes));
  localStorage.setItem("masteryMap", JSON.stringify(masteryMap));
  persistSession();
  updateScore();
  nextQuestion();
  updateDeckProgress();
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

// ---------------- MISTAKES ----------------
function startMistakePractice() {
  if (mistakes.length === 0) return alert("No mistakes yet!");
  currentSet = mistakes.slice();
  currentSetName = "Mistakes";
  currentIndex = 0;
  showSection("practice");
  // reset running score
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

// ---------------- LECTURES ----------------
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
    console.error("Failed to load lectures:", err);
    statusLine("lectures-status", `Failed to load lectures: ${err.message}`);
  }
}

// ---------------- PROGRESS (reads via firebase.js) ----------------
async function renderProgress() {
  if (!window.__fb_fetchAttempts) return;

  try {
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
      prev = attempts.find(a =>
        a.deckName === last.deckName && a.createdAt < last.createdAt
      ) || null;
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
      } else {
        lastBox.textContent = "No attempts yet.";
      }
    }

    if (prevBox) {
      if (prev) {
        prevBox.innerHTML = `
          <div><b>${prev.deckName}</b> (${prev.mode})</div>
          <div>✅ ${prev.correct || 0} | ❌ ${prev.wrong || 0} | ➖ ${prev.skipped || 0}</div>
          <div class="muted">${new Date(prev.createdAt).toLocaleString()}</div>
        `;
      } else {
        prevBox.textContent = "—";
      }
    }

    if (deltaBox) {
      if (last && prev) {
        const d = (last.correct || 0) - (prev.correct || 0);
        const cls = d >= 0 ? "delta-up" : "delta-down";
        const sign = d > 0 ? "+" : (d < 0 ? "" : "±");
        deltaBox.innerHTML = `<span class="${cls}">${sign}${d} correct vs previous (same set)</span>`;
      } else if (last && !prev) {
        deltaBox.textContent = "No previous attempt for this set.";
      } else {
        deltaBox.textContent = "—";
      }
    }
  } catch (e) {
    console.warn("renderProgress failed:", e);
  }
}
window.renderProgress = renderProgress;

// ---------------- Utilities ----------------
function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}


// ---------------- ATTENDANCE ----------------
(function initAttendance() {
  const dateInput = document.getElementById('attendance-date');
  const loadBtn = document.getElementById('attendance-load');
  const tableBody = document.querySelector('#attendance-table tbody');
  const statusEl = document.getElementById('attendance-status');
  const noteEl = document.getElementById('attendance-note');
  const markAllBtn = document.getElementById('attendance-mark-all');
  const clearAllBtn = document.getElementById('attendance-clear-all');
  const saveBtn = document.getElementById('attendance-save');
  const saveStatus = document.getElementById('attendance-save-status');

  // NEW: student-only elements and admin containers
  const adminControls = document.getElementById('attendance-admin-controls');
  const adminTableWrap = document.getElementById('attendance-admin-table-wrap');
  const adminActions = document.getElementById('attendance-admin-actions');
  const studentView = document.getElementById('attendance-student-view');
  const myTableBody = document.querySelector('#my-attendance-table tbody');

  if (!dateInput || !tableBody) return;

  // Default date = today (local)
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth()+1).padStart(2,'0');
  const dd = String(today.getDate()).padStart(2,'0');
  dateInput.value = `${yyyy}-${mm}-${dd}`;

  let students = []; // [{uid, displayName}]
  let stateMap = {}; // uid -> {present:boolean}
  let dirty = false;

  function setStatus(msg){ if(statusEl) statusEl.textContent = msg || ''; }
  function setSaveStatus(msg){ if(saveStatus) saveStatus.textContent = msg || ''; }
  function dateKey(){ return dateInput.value; }

  // Renders admin note + toggles visibility for admin vs student
  function renderNote(){
    const isAdmin = !!window.__isAdmin;

    if (noteEl) {
      noteEl.textContent = isAdmin
        ? "You are marked as admin. You can edit attendance."
        : "You are not an admin. Attendance is read-only.";
    }

    // Hide/Show admin interface
    if (adminControls) adminControls.style.display = isAdmin ? '' : 'none';
    if (adminTableWrap) adminTableWrap.style.display = isAdmin ? '' : 'none';
    if (adminActions) adminActions.style.display = isAdmin ? '' : 'none';

    // Student view visible only for non-admins
    if (studentView) studentView.classList.toggle('hidden', isAdmin);

    // Disable inputs if somehow visible
    const inputs = document.querySelectorAll('.att-present');
    inputs.forEach(inp => inp.disabled = !isAdmin);

    // For students, (re)render their own table
    if (!isAdmin) renderMyAttendance();
  }

  // Expose so outer code can call after role resolves
  window.__att_renderNote = renderNote;

  // Build one admin row
  function buildRow(stu){
    const tr = document.createElement('tr');
    const nameTd = document.createElement('td');
    nameTd.textContent = stu.displayName || '(Unnamed)';
    const presentTd = document.createElement('td');
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.className = 'att-present';
    chk.checked = !!(stateMap[stu.uid]?.present);
    chk.onchange = () => { stateMap[stu.uid] = { present: chk.checked, displayName: stu.displayName }; dirty = true; };
    presentTd.appendChild(chk);
    tr.append(nameTd, presentTd);
    return tr;
  }

  async function loadAttendance(){
    setStatus('Loading students & attendance…');
    setSaveStatus('');
    dirty = false;
    try {
      students = await (window.__fb_listStudents ? window.__fb_listStudents() : []);
      const att = await (window.__fb_getAttendance ? window.__fb_getAttendance(dateKey()) : {});
      stateMap = {};
      students.forEach(s => {
        stateMap[s.uid] = { present: !!(att[s.uid]?.present), displayName: s.displayName || null };
      });
      // Render admin table
      tableBody.innerHTML = '';
      students.forEach(s => tableBody.appendChild(buildRow(s)));
      setStatus(`Loaded ${students.length} students.`);
      renderNote();
    } catch(e){
      console.error('Attendance load failed:', e);
      setStatus('Failed to load attendance.');
    }
  }

  // NEW: Student-only history renderer
  async function renderMyAttendance() {
    if (!myTableBody) return;
    myTableBody.innerHTML = '<tr><td colspan="3">Loading…</td></tr>';
    try {
      const rows = await (window.__fb_getMyAttendanceHistoryWithClass ? window.__fb_getMyAttendanceHistoryWithClass(180) : []);
      myTableBody.innerHTML = '';
      if (!rows.length) {
        myTableBody.innerHTML = '<tr><td colspan="3">No records yet.</td></tr>';
        return;
      }
      rows.forEach(r => {
        const tr = document.createElement('tr');
        const status = r.present ? 'Present' : 'Absent';
        tr.innerHTML = `
          <td>${r.date}</td>
          <td>${(r.classNo ?? '—')}</td>
          <td>${status}</td>
        `;
        myTableBody.appendChild(tr);
      });
    } catch (e) {
      console.warn('renderMyAttendance failed:', e);
      myTableBody.innerHTML = '<tr><td colspan="3">Failed to load.</td></tr>';
    }
  }
  // Expose so outer code can call
  window.__att_renderMyAttendance = renderMyAttendance;

  // Actions (admin)
  loadBtn?.addEventListener('click', loadAttendance);
  dateInput?.addEventListener('change', loadAttendance);
  markAllBtn?.addEventListener('click', () => {
    students.forEach(s => { stateMap[s.uid] = { present: true, displayName: s.displayName }; });
    // update checkboxes
    document.querySelectorAll('.att-present').forEach(inp => { inp.checked = true; });
    dirty = true;
  });
  clearAllBtn?.addEventListener('click', () => {
    students.forEach(s => { stateMap[s.uid] = { present: false, displayName: s.displayName }; });
    document.querySelectorAll('.att-present').forEach(inp => { inp.checked = false; });
    dirty = true;
  });
  saveBtn?.addEventListener('click', async () => {
    if (!dirty) { setSaveStatus('No changes.'); return; }
    try {
      const records = students.map(s => ({ uid: s.uid, present: !!(stateMap[s.uid]?.present), displayName: s.displayName }));
      await (window.__fb_saveAttendanceBulk ? window.__fb_saveAttendanceBulk(dateKey(), records) : Promise.resolve());
      setSaveStatus('Saved ✔');
      dirty = false;
    } catch(e){
      console.error('Attendance save failed:', e);
      setSaveStatus('Save failed.');
    }
  });

  // Initial admin load (safe even if user is student; admin UI will be hidden)
  loadAttendance();
})();

// When admin role resolves in firebase.js, adjust the attendance view immediately
window.__onAdminStateChanged = function(isAdmin) {
  if (currentSectionId === 'attendance-section') {
    if (typeof window.__att_renderNote === 'function') window.__att_renderNote();
    if (!isAdmin && typeof window.__att_renderMyAttendance === 'function') {
      window.__att_renderMyAttendance();
    }
  }
};
