// firebase.js — load with <script type="module" src="firebase.js">
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, serverTimestamp,
  collection, query, orderBy, limit, onSnapshot, addDoc,
  runTransaction, getDocs, increment, writeBatch, deleteDoc,
  collectionGroup, where, documentId
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";

// --- Firebase project config ---
const firebaseConfig = {
  apiKey: "AIzaSyCG9eot9cPAkKDvzoJvfw8AGtqag3u2uWA",
  authDomain: "basic-robotics.firebaseapp.com",
  projectId: "basic-robotics",
  storageBucket: "basic-robotics.firebasestorage.app",
  messagingSenderId: "638931947308",
  appId: "1:638931947308:web:881eb4624e4f2a8b03e689",
  measurementId: "G-5QNJ38XQLE"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);
const provider = new GoogleAuthProvider();

// --- DOM refs (may be null) ---
const gate         = document.getElementById('auth-gate');
const appRoot      = document.getElementById('app-root');
const authBtn      = document.getElementById('auth-btn');
const authErr      = document.getElementById('auth-error');
const approvalGate = document.getElementById('approval-gate');

const todoFlyout = document.getElementById('todo-flyout');
const todoTimer  = document.getElementById('todo-timer');
const todoList   = document.getElementById('todo-list');
const adminRow   = document.getElementById('admin-row');

const courseLbList  = document.getElementById('course-leaderboard-list');
const weeklyLbList  = document.getElementById('weekly-leaderboard-list');

// --- Helpers ---
const TASK_BONUS = 10;

const showError = (msg) => { if (authErr) { authErr.textContent = msg; authErr.style.display = 'block'; } };
const hideError = () => { if (authErr) authErr.style.display = 'none'; };

function localDateKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function getISOWeek(d=new Date()){
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay()||7));
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(),0,1));
  const weekNo = Math.ceil((((date - yearStart) / 86400000) + 1)/7);
  const y = date.getUTCFullYear();
  return `${y}-W${String(weekNo).padStart(2,'0')}`;
}
function endOfToday() {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1, 0, 0, 0, 0);
}
function startCountdown() {
  if (!todoTimer) return;
  function tick() {
    const ms = endOfToday() - new Date();
    if (ms <= 0) { todoTimer.textContent = "00:00:00"; return; }
    const s = Math.floor(ms / 1000);
    const h = String(Math.floor(s / 3600)).padStart(2, '0');
    const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const sec = String(s % 60).padStart(2, '0');
    todoTimer.textContent = `${h}:${m}:${sec}`;
  }
  tick();
  setInterval(tick, 1000);
}

// --- Sign-in ---
authBtn?.addEventListener('click', async () => {
  try {
    hideError();
    await signInWithPopup(auth, provider);
  } catch (e) {
    console.warn('[auth] Popup sign-in failed:', e?.code, e?.message);
    showError(e?.message || 'Sign-in failed');
  }
});

let unsubWeeklyLB = null;
let unsubOverallLB = null;

onAuthStateChanged(auth, async (user) => {
  try {
    if (user) {
      // Ensure base user doc exists with approved flag = false by default
      const uref = doc(db, 'users', user.uid);
      const usnap = await getDoc(uref);

      if (!usnap.exists()) {
        await setDoc(uref, {
          displayName: user.displayName || 'Anonymous',
          photoURL: user.photoURL || '',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
          approved: false
        });
      } else {
        await updateDoc(uref, { updatedAt: serverTimestamp() });
      }

      // Admin status
      let isAdmin = false;
      try {
        const adminSnap = await getDoc(doc(db, 'admins', user.uid));
        isAdmin = adminSnap.exists();
      } catch {}
      window.__isAdmin = !!isAdmin;

      // Approval gate: admins bypass; students must be approved
      const fresh = await getDoc(uref);
      const approved = !!(fresh.exists() && fresh.data().approved);

      if (!isAdmin && !approved) {
        gate?.classList.add('hidden'); if (gate) gate.style.display = 'none';
        appRoot?.classList.add('hidden'); if (appRoot) appRoot.style.display = 'none';
        approvalGate?.classList.remove('hidden'); if (approvalGate) approvalGate.style.display = 'grid';
        return;
      }

      // Normal app view
      approvalGate?.classList.add('hidden'); if (approvalGate) approvalGate.style.display = 'none';
      gate?.classList.add('hidden'); if (gate) gate.style.display = 'none';
      appRoot?.classList.remove('hidden'); if (appRoot) appRoot.style.display = 'block';
      todoFlyout?.classList.remove('hidden'); if (todoFlyout) todoFlyout.style.display = '';

      if (adminRow) adminRow.classList.toggle('hidden', !isAdmin);
      try { window.__onAdminStateChanged && window.__onAdminStateChanged(window.__isAdmin); } catch {}

      // UI helpers
      startCountdown();
      subscribeWeeklyTaskFlyout(user.uid);
      if (weeklyLbList) subscribeWeeklyLeaderboard();
      if (courseLbList) subscribeCourseLeaderboard();

      // Auto-commit any pending session stored locally (from last close)
      try { await __fb_commitLocalPendingSession(); } catch (e) { console.warn('[pending-session] commit skipped:', e?.message || e); }

      // continue to app
      window.__initAfterLogin?.();
    } else {
      appRoot?.classList.add('hidden'); if (appRoot) appRoot.style.display = 'none';
      gate?.classList.remove('hidden'); if (gate) gate.style.display = '';
      approvalGate?.classList.add('hidden'); if (approvalGate) approvalGate.style.display = 'none';
      todoFlyout?.classList.add('hidden'); if (todoFlyout) todoFlyout.style.display = 'none';

      if (unsubWeeklyLB) { unsubWeeklyLB(); unsubWeeklyLB = null; }
      if (unsubOverallLB) { unsubOverallLB(); unsubOverallLB = null; }
    }
  } catch (err) {
    console.error('[auth] onAuthStateChanged handler error:', err);
    showError(err?.message || 'Unexpected error');
  }
});

// -----------------------------
// APPROVAL API (Admin)
// -----------------------------
window.__fb_listPending = async function () {
  const qy = query(collection(db, 'users'), where('approved','==', false), orderBy('displayName'));
  const snap = await getDocs(qy);
  const rows = [];
  snap.forEach(d => rows.push({ uid: d.id, ...(d.data()||{}) }));
  return rows;
};
window.__fb_approveUser = async function (uid) {
  await updateDoc(doc(db,'users',uid), { approved: true, approvedAt: serverTimestamp() });
};
window.__fb_listApprovedStudents = async function () {
  // get approved users, filter out admins
  const [usersSnap, adminsSnap] = await Promise.all([
    getDocs(query(collection(db,'users'), where('approved','==', true))),
    getDocs(collection(db,'admins'))
  ]);
  const admins = new Set();
  adminsSnap.forEach(a => admins.add(a.id));
  const rows = [];
  usersSnap.forEach(u => { if (!admins.has(u.id)) rows.push({ uid: u.id, ...(u.data()||{}) }); });
  rows.sort((a,b) => (a.displayName||'').localeCompare(b.displayName||''));
  return rows;
};

// -----------------------------
// WEEKLY TASKS (Admin + Student)
// tasks/{weekKey}/items/{taskId} => { title, description, dueAt, link, scoreMax, createdBy, createdAt, updatedAt }
// tasks/{weekKey}/items/{taskId}/submissions/{uid} => { link, submittedAt, score, scoredAt }
// examScores/{weekKey}/users/{uid} => { score, updatedAt }
// -----------------------------
window.__fb_createTask = async function (data) {
  const user = auth.currentUser; if (!user) throw new Error('Not signed in');
  const weekKey = getISOWeek(new Date());
  const col = collection(db, 'tasks', weekKey, 'items');
  const docRef = await addDoc(col, {
    title: data.title || '',
    description: data.description || '',
    dueAt: data.dueAt || null,
    link: data.link || '',
    scoreMax: Number(data.scoreMax || 0),
    createdBy: user.uid,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
  return docRef.id;
};
window.__fb_updateTask = async function (weekKey, taskId, patch) {
  await updateDoc(doc(db, 'tasks', weekKey, 'items', taskId), {
    ...patch, updatedAt: serverTimestamp()
  });
};
window.__fb_listTasks = async function (weekKey) {
  const qy = query(collection(db,'tasks', weekKey, 'items'), orderBy('createdAt','asc'));
  const snap = await getDocs(qy);
  const arr = [];
  snap.forEach(d => arr.push({ id: d.id, ...(d.data()||{}) }));
  return arr;
};
window.__fb_submitTask = async function (weekKey, taskId, linkUrl) {
  const user = auth.currentUser; if (!user) throw new Error('Not signed in');
  await setDoc(doc(db,'tasks',weekKey,'items',taskId,'submissions', user.uid), {
    link: (linkUrl||'').trim(),
    submittedAt: serverTimestamp()
  }, { merge: true });
};
window.__fb_listMySubmissions = async function (weekKey) {
  const user = auth.currentUser; if (!user) return {};
  const subs = {};
  const itemsSnap = await getDocs(collection(db,'tasks', weekKey, 'items'));
  for (const item of itemsSnap.docs) {
    const sRef = doc(db,'tasks', weekKey,'items', item.id, 'submissions', user.uid);
    const sSnap = await getDoc(sRef);
    if (sSnap.exists()) subs[item.id] = sSnap.data();
  }
  return subs;
};
window.__fb_scoreSubmission = async function (weekKey, taskId, uid, score) {
  await setDoc(doc(db,'tasks', weekKey,'items',taskId,'submissions', uid), {
    score: Number(score||0),
    scoredAt: serverTimestamp()
  }, { merge: true });
};
window.__fb_setExamScore = async function (weekKey, uid, score) {
  await setDoc(doc(db,'examScores', weekKey, 'users', uid), {
    score: Number(score||0),
    updatedAt: serverTimestamp()
  }, { merge: true });
};

// Student flyout shows current week tasks
let unsubTasksFlyout = null;
async function subscribeWeeklyTaskFlyout(uid) {
  if (!todoList) return;
  const wk = getISOWeek(new Date());
  if (unsubTasksFlyout) { unsubTasksFlyout(); unsubTasksFlyout = null; }

  unsubTasksFlyout = onSnapshot(collection(db,'tasks', wk,'items'), async (ss) => {
    const items = [];
    ss.forEach(d => items.push({ id: d.id, ...(d.data()||{}) }));

    const mySubs = await window.__fb_listMySubmissions(wk);

    todoList.innerHTML = '';
    if (items.length === 0) {
      const li = document.createElement('li');
      li.textContent = 'No weekly tasks assigned yet.';
      li.className = 'todo-empty';
      todoList.appendChild(li);
      return;
    }
    items.forEach(t => {
      const li = document.createElement('li');
      li.className = 'todo-item';
      const title = document.createElement('span');
      title.textContent = t.title || '(Untitled task)';
      const due = document.createElement('span');
      due.style.marginLeft = 'auto';
      due.className = 'muted';
      due.textContent = t.dueAt ? new Date(t.dueAt).toLocaleString() : 'No due';
      const badge = document.createElement('span');
      badge.className = 'muted';
      badge.style.marginLeft = '8px';
      badge.textContent = mySubs[t.id]?.submittedAt ? 'Submitted' : 'Pending';
      li.append(title, due, badge);
      li.onclick = () => { window.showSection && window.showSection('tasks-section'); };
      todoList.appendChild(li);
    });
  });
}

// ------------------------------
// Leaderboards
// ------------------------------
function subscribeCourseLeaderboard() {
  if (!courseLbList) return;

  const cg = collectionGroup(db, 'users'); // 'dailyLeaderboard/{date}/users/{uid}'
  if (unsubOverallLB) unsubOverallLB();

  unsubOverallLB = onSnapshot(cg, (ss) => {
    const agg = new Map();
    ss.forEach(docSnap => {
      const usersCol = docSnap.ref.parent;
      const dateDoc = usersCol ? usersCol.parent : null;
      if (!dateDoc || (dateDoc.parent && dateDoc.parent.id !== 'dailyLeaderboard')) return;

      const d = docSnap.data() || {};
      const uid = d.uid || docSnap.id;
      if (!agg.has(uid)) {
        agg.set(uid, {
          uid,
          displayName: d.displayName || 'Anonymous',
          practiceScore: 0,
          taskScore: 0,
          attendanceScore: 0,
          examScore: 0,
          score: 0
        });
      }
      const row = agg.get(uid);
      const practice = (d.jpEnCorrect||0) + (d.enJpCorrect||0) + (d.tasksCompleted||0)*TASK_BONUS;
      row.practiceScore += practice;
      row.score         += (d.score||practice);
      if (d.displayName) row.displayName = d.displayName;
    });

    const rows = [...agg.values()].sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 50);
    courseLbList.innerHTML = '';
    let rank = 1;
    rows.forEach(u => {
      const li = document.createElement('li');
      li.innerHTML = `
        <div class="lb-row">
          <span class="lb-rank">#${rank++}</span>
          <span class="lb-name">${u.displayName || 'Anonymous'}</span>
          <span class="lb-part">Practice: <b>${u.practiceScore}</b></span>
          <span class="lb-score">${u.score || 0} pts</span>
        </div>`;
      courseLbList.appendChild(li);
    });
  }, (err) => console.error('[course LB] snapshot error:', err));
}

// Weekly bounds helpers
function getWeekBounds(d = new Date()) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  let day = date.getUTCDay();
  if (day === 0) day = 7;
  const start = new Date(date);
  start.setUTCDate(date.getUTCDate() - day + 1);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  return { start, end };
}
function ymd(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function buildWeeklyAggregate() {
  const { start, end } = getWeekBounds(new Date());
  const startKey = ymd(start);
  const endKey   = ymd(end);
  const weekKey  = getISOWeek(new Date());

  // 1) Practice from dailyLeaderboard within week
  const agg = new Map(); // uid -> {displayName, practice, tasks, attendance, exam}
  const lbUsers = collectionGroup(db, 'users');
  const lbSnap = await getDocs(lbUsers);
  lbSnap.forEach(docSnap => {
    const usersCol = docSnap.ref.parent;
    const dateDoc = usersCol ? usersCol.parent : null;
    if (!dateDoc || (dateDoc.parent && dateDoc.parent.id !== 'dailyLeaderboard')) return;
    const dateId = dateDoc.id;
    if (dateId < startKey || dateId > endKey) return;

    const d = docSnap.data() || {};
    const uid = d.uid || docSnap.id;
    if (!agg.has(uid)) agg.set(uid, { displayName: d.displayName || 'Anonymous', practice:0, tasks:0, attendance:0, exam:0 });
    const practice = (d.jpEnCorrect||0) + (d.enJpCorrect||0);
    const tasksBonus = (d.tasksCompleted||0) * TASK_BONUS;
    agg.get(uid).practice += (practice + tasksBonus);
  });

  // 2) Task scores from tasks/{weekKey}/items/*/submissions
  const taskItems = await getDocs(collection(db,'tasks', weekKey, 'items'));
  for (const it of taskItems.docs) {
    const subs = await getDocs(collection(db,'tasks', weekKey, 'items', it.id, 'submissions'));
    subs.forEach(s => {
      const d = s.data() || {};
      const uid = s.id;
      if (!agg.has(uid)) agg.set(uid, { displayName: 'Anonymous', practice:0, tasks:0, attendance:0, exam:0 });
      agg.get(uid).tasks += Number(d.score || 0);
    });
  }

  // 3) Attendance counts within week (1 point per present)
  const dates = [];
  for (let i=0;i<7;i++){
    const dt = new Date(start); dt.setUTCDate(start.getUTCDate()+i);
    dates.push(ymd(dt));
  }
  for (const dkey of dates) {
    const stSnap = await getDocs(collection(db,'attendance', dkey, 'students'));
    stSnap.forEach(s => {
      const data = s.data() || {};
      if (!data.present) return;
      const uid = s.id;
      if (!agg.has(uid)) agg.set(uid, { displayName: data.displayName || 'Anonymous', practice:0, tasks:0, attendance:0, exam:0 });
      agg.get(uid).attendance += 1;
      if (data.displayName) agg.get(uid).displayName = data.displayName;
    });
  }

  // 4) Exam scores (optional) examScores/{weekKey}/users/*
  const exSnap = await getDocs(collection(db,'examScores', weekKey, 'users'));
  exSnap.forEach(s => {
    const uid = s.id;
    const data = s.data() || {};
    if (!agg.has(uid)) agg.set(uid, { displayName: 'Anonymous', practice:0, tasks:0, attendance:0, exam:0 });
    agg.get(uid).exam += Number(data.score || 0);
  });

  const rows = [...agg.entries()].map(([uid, v]) => ({
    uid, displayName: v.displayName,
    practiceScore: v.practice,
    taskScore: v.tasks,
    attendanceScore: v.attendance,
    examScore: v.exam,
    total: v.practice + v.tasks + v.attendance + v.exam
  })).sort((a,b)=> b.total - a.total).slice(0, 50);

  return rows;
}

function subscribeWeeklyLeaderboard() {
  if (!weeklyLbList) return;
  const cg = collectionGroup(db, 'users');
  unsubWeeklyLB && unsubWeeklyLB();
  unsubWeeklyLB = onSnapshot(cg, async () => {
    try {
      const rows = await buildWeeklyAggregate();
      weeklyLbList.innerHTML = '';
      let rank = 1;
      rows.forEach(u => {
        const li = document.createElement('li');
        li.innerHTML = `
          <div class="lb-row">
            <span class="lb-rank">#${rank++}</span>
            <span class="lb-name">${u.displayName || 'Anonymous'}</span>
            <span class="lb-part">Practice: <b>${u.practiceScore}</b></span>
            <span class="lb-part">Tasks: <b>${u.taskScore}</b></span>
            <span class="lb-part">Attendance: <b>${u.attendanceScore}</b></span>
            <span class="lb-part">Exam: <b>${u.examScore}</b></span>
            <span class="lb-score">${u.total} pts</span>
          </div>`;
        weeklyLbList.appendChild(li);
      });
    } catch (e) {
      console.error('[weekly LB] rebuild failed:', e);
    }
  }, (err) => console.error('[weekly LB] snapshot error:', err));
}

/* ------------------------------
   Commit a buffered session
--------------------------------- */
window.__fb_commitSession = async function (payload) {
  const user = auth.currentUser;
  if (!user) throw new Error('Not signed in');
  const {
    deckName = 'Unknown Set',
    mode = 'mcq',
    correct = 0, wrong = 0, skipped = 0, total = 0,
    jpEnCorrect = 0, enJpCorrect = 0
  } = payload || {};

  const dkey = localDateKey();
  const uref = doc(db, 'users', user.uid);
  const dailyRef = doc(db, 'users', user.uid, 'daily', dkey);
  const lbDaily  = doc(db, 'dailyLeaderboard', dkey, 'users', user.uid);
  const attemptsCol = collection(db, 'users', user.uid, 'attempts');

  const usnap = await getDoc(uref);
  const displayName = usnap.exists() ? (usnap.data().displayName || 'Anonymous') : 'Anonymous';

  await Promise.all([
    setDoc(dailyRef, { date: dkey, uid: user.uid, displayName }, { merge: true }),
    setDoc(lbDaily,  { uid: user.uid, displayName }, { merge: true }),
  ]);

  const batch = writeBatch(db);

  const attemptDoc = doc(attemptsCol);
  batch.set(attemptDoc, {
    deckName, mode, correct, wrong, skipped, total,
    createdAt: Date.now(), createdAtServer: serverTimestamp()
  });

  const incsDaily = {
    updatedAt: serverTimestamp(),
    jpEnCorrect: increment(jpEnCorrect),
    enJpCorrect: increment(enJpCorrect),
    score: increment(jpEnCorrect + enJpCorrect + 0)
  };
  const incsLB = {
    updatedAt: serverTimestamp(),
    jpEnCorrect: increment(jpEnCorrect),
    enJpCorrect: increment(enJpCorrect),
    score: increment(jpEnCorrect + enJpCorrect)
  };

  batch.set(dailyRef, incsDaily, { merge: true });
  batch.set(lbDaily,  incsLB,    { merge: true });

  await batch.commit();
};

async function __fb_commitLocalPendingSession() {
  const raw = localStorage.getItem('pendingSession');
  if (!raw) return;
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    localStorage.removeItem('pendingSession');
    return;
  }
  if (!payload || !payload.total) {
    localStorage.removeItem('pendingSession');
    return;
  }
  await window.__fb_commitSession(payload);
  localStorage.removeItem('pendingSession');
}
window.__fb_commitLocalPendingSession = __fb_commitLocalPendingSession;

// --- Progress (attempts) ---
window.__fb_fetchAttempts = async function (limitN = 20) {
  const user = getAuth().currentUser;
  if (!user) return [];
  const db = getFirestore();
  const colRef = collection(db, 'users', user.uid, 'attempts');
  const qy = query(colRef, orderBy('createdAt', 'desc'), limit(limitN));
  const snap = await getDocs(qy);
  const list = [];
  snap.forEach(docSnap => {
    const d = docSnap.data() || {};
    const ts = d.createdAt || (d.createdAtServer?.toMillis ? d.createdAtServer.toMillis() : Date.now());
    list.push({ id: docSnap.id, ...d, createdAt: ts });
  });
  return list;
};

window.__signOut = () => signOut(auth);

// ---------------- Attendance API ----------------
// attendance/{YYYY-MM-DD}/students/{uid} => { present: boolean, markedBy, markedAt, displayName }
// class no stored at attendance/{YYYY-MM-DD} => { classNo }
window.__fb_listStudents = async function () {
  return await window.__fb_listApprovedStudents();
};
window.__fb_getAttendance = async function (dateKey) {
  const colRef = collection(db, 'attendance', dateKey, 'students');
  const snap = await getDocs(colRef);
  const map = {};
  snap.forEach(d => map[d.id] = d.data());
  return map;
};
window.__fb_setAttendance = async function (dateKey, uid, present, displayName) {
  const user = auth.currentUser;
  if (!user) throw new Error('Not signed in');
  await setDoc(doc(db, 'attendance', dateKey, 'students', uid), {
    present: !!present,
    displayName: displayName || null,
    markedBy: user.uid,
    markedAt: serverTimestamp()
  }, { merge: true });
};
window.__fb_saveAttendanceBulk = async function (dateKey, records) {
  const user = auth.currentUser;
  if (!user) throw new Error('Not signed in');
  const batch = writeBatch(db);
  records.forEach(r => {
    const ref = doc(db, 'attendance', dateKey, 'students', r.uid);
    batch.set(ref, {
      present: !!r.present,
      displayName: r.displayName || null,
      markedBy: user.uid,
      markedAt: serverTimestamp()
    }, { merge: true });
  });
  await batch.commit();
};

// --- Attendance meta (Class No) ---
window.__fb_getAttendanceMeta = async function(dateKey){
  try{
    const ref = doc(db, 'attendance', dateKey);
    const snap = await getDoc(ref);
    return snap.exists() ? snap.data() : {};
  }catch(e){ console.warn('getAttendanceMeta failed', e); return {}; }
};
window.__fb_setAttendanceMeta = async function(dateKey, classNo){
  try{
    await setDoc(doc(db, 'attendance', dateKey), { classNo: classNo, updatedAt: serverTimestamp() }, { merge: true });
  }catch(e){ console.warn('setAttendanceMeta failed', e); throw e; }
};

// --- Student history (Date | Class No | Status) ---
window.__fb_getMyAttendanceHistoryWithClass = async function(limitN = 180){
  const user = auth.currentUser;
  if (!user) return [];

  const cg = collectionGroup(db, 'students');
  let qy;
  try { qy = query(cg, where(documentId(), '==', user.uid)); }
  catch {
    const snapAll = await getDocs(cg);
    const all = [];
    snapAll.forEach(docSnap => {
      if (docSnap.id === user.uid) {
        const dateDoc = docSnap.ref.parent ? docSnap.ref.parent.parent : null;
        if (dateDoc && dateDoc.id) {
          const d = docSnap.data() || {};
          all.push({ date: dateDoc.id, present: !!d.present });
        }
      }
    });
    all.sort((a,b)=> a.date > b.date ? -1 : (a.date < b.date ? 1 : 0));
    const top = all.slice(0, limitN);
    const out = [];
    for (const row of top) {
      let classNo = undefined;
      try {
        const msnap = await getDoc(doc(db, 'attendance', row.date));
        classNo = msnap.exists() ? msnap.data().classNo : undefined;
      } catch {}
      out.push({ date: row.date, classNo, present: row.present });
    }
    return out;
  }

  const snap = await getDocs(qy);
  const rows = [];
  snap.forEach(docSnap => {
    const dateDoc = docSnap.ref.parent ? docSnap.ref.parent.parent : null;
    if (!dateDoc) return;
    const d = docSnap.data() || {};
    rows.push({ date: dateDoc.id, present: !!d.present });
  });
  rows.sort((a,b)=> a.date > b.date ? -1 : (a.date < b.date ? 1 : 0));
  const top = rows.slice(0, limitN);

  const out = [];
  for (const row of top) {
    let classNo = undefined;
    try {
      const msnap = await getDoc(doc(db, 'attendance', row.date));
      classNo = msnap.exists() ? msnap.data().classNo : undefined;
    } catch {}
    out.push({ date: row.date, classNo, present: row.present });
  }
  return out;
};

// -----------------------------
// Weekly overview (Progress tab)
// -----------------------------
window.__fb_fetchWeeklyOverview = async function(){
  const user = auth.currentUser; if (!user) return { tasks:[], attendance:[], exam:0 };
  const wk = getISOWeek(new Date());
  const { start, end } = getWeekBounds(new Date());
  const dates = [];
  for (let i=0; i<7; i++){ const dt = new Date(start); dt.setUTCDate(start.getUTCDate()+i); dates.push(ymd(dt)); }

  // tasks
  const taskRows = [];
  const items = await getDocs(collection(db,'tasks', wk, 'items'));
  for (const it of items.docs) {
    const t = { id: it.id, ...(it.data()||{}) };
    const sub = await getDoc(doc(db,'tasks', wk, 'items', it.id, 'submissions', user.uid));
    const sd = sub.exists() ? sub.data() : null;
    taskRows.push({
      title: t.title || '(Untitled)', dueAt: t.dueAt || null,
      status: sd?.submittedAt ? 'Submitted' : 'Pending',
      score: sd?.score ?? null, scoreMax: t.scoreMax ?? null
    });
  }

  // attendance
  const attRows = [];
  for (const d of dates) {
    const s = await getDoc(doc(db,'attendance', d, 'students', user.uid));
    const meta = await getDoc(doc(db,'attendance', d));
    attRows.push({
      date: d,
      classNo: meta.exists() ? (meta.data().classNo ?? null) : null,
      status: s.exists() && s.data().present ? 'Present' : 'Absent'
    });
  }

  // exam
  const ex = await getDoc(doc(db,'examScores', wk, 'users', user.uid));
  const examScore = ex.exists() ? (ex.data().score || 0) : 0;

  return { tasks: taskRows, attendance: attRows, exam: examScore };
};

// -----------------------------
// Admin Reset / Delete a student
// -----------------------------
async function __deleteCollectionGroupDocsById(groupName, docId){
  // Deletes all collectionGroup docs whose documentId() equals docId
  const cg = collectionGroup(db, groupName);
  try{
    const qy = query(cg, where(documentId(), '==', docId));
    const snap = await getDocs(qy);
    const batch = writeBatch(db);
    snap.forEach(s => batch.delete(s.ref));
    await batch.commit();
  }catch(e){
    // Some SDKs disallow where(documentId()) on CG; fallback: scan all and match id.
    const snap = await getDocs(cg);
    const batch = writeBatch(db);
    snap.forEach(s => { if (s.id === docId) batch.delete(s.ref); });
    await batch.commit();
  }
}
async function __deleteSubcollectionDocs(userUid, subpath){
  // subpath like 'attempts' or 'daily'
  const colRef = collection(db,'users', userUid, subpath);
  const snap = await getDocs(colRef);
  const batch = writeBatch(db);
  snap.forEach(d => batch.delete(d.ref));
  await batch.commit();
}

window.__fb_adminResetUser = async function(uid){
  // Clears attempts, daily docs, dailyLeaderboard rows. Sets approved:false.
  // (Auth delete is not possible here.)
  await __deleteSubcollectionDocs(uid, 'attempts');
  await __deleteSubcollectionDocs(uid, 'daily');
  // delete in dailyLeaderboard/*/users/{uid}
  await __deleteCollectionGroupDocsById('users', uid);
  // flip approved off
  await setDoc(doc(db,'users',uid), { approved: false, updatedAt: serverTimestamp() }, { merge: true });
  return true;
};
window.__fb_adminDeleteUser = async function(uid){
  await window.__fb_adminResetUser(uid);
  // Finally remove the user profile doc
  await deleteDoc(doc(db,'users',uid));
  return true;
};
