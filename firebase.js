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

// --- Firebase project config (updated) ---
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
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
const gate       = document.getElementById('auth-gate');
const appRoot    = document.getElementById('app-root');
const authBtn    = document.getElementById('auth-btn');
const authErr    = document.getElementById('auth-error');

const todoFlyout = document.getElementById('todo-flyout');
const todoTimer  = document.getElementById('todo-timer');
const todoList   = document.getElementById('todo-list');
const adminRow   = document.getElementById('admin-row');
const attendanceNote = document.getElementById('attendance-note');
const adminInput = document.getElementById('admin-task-input');
const adminAdd   = document.getElementById('admin-task-add');

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
let unsubTasks = null;

onAuthStateChanged(auth, async (user) => {
  try {
    if (user) {
      gate?.classList.add('hidden'); if (gate) gate.style.display = 'none';
      appRoot?.classList.remove('hidden'); if (appRoot) appRoot.style.display = 'block';
      todoFlyout?.classList.remove('hidden'); if (todoFlyout) todoFlyout.style.display = '';

      // Ensure base user doc exists
      const uref = doc(db, 'users', user.uid);
      const usnap = await getDoc(uref);
      if (!usnap.exists()) {
        await setDoc(uref, {
          displayName: user.displayName || 'Anonymous',
          photoURL: user.photoURL || '',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } else {
        await updateDoc(uref, { updatedAt: serverTimestamp() });
      }

      // Admin UI
      if (adminRow) {
        try {
          const adminSnap = await getDoc(doc(db, 'admins', user.uid));
          const isAdmin = adminSnap.exists();
          window.__isAdmin = !!isAdmin;
          try { window.__onAdminStateChanged && window.__onAdminStateChanged(window.__isAdmin); } catch {}
          adminRow.classList.toggle('hidden', !isAdmin);
        } catch {
          window.__isAdmin = false;
          adminRow.classList.add('hidden');
        }
      } else {
        window.__isAdmin = false;
      }

      // Admin add-task
      if (adminAdd && adminInput) {
        adminAdd.onclick = async () => {
          const text = (adminInput.value || '').trim();
          if (!text) return;
          const dkey = localDateKey();
          await addDoc(collection(db, 'dailyTasks', dkey, 'tasks'), {
            text, createdAt: serverTimestamp()
          });
          adminInput.value = '';
        };
      }

      // Start optional UI bits
      startCountdown();
      if (todoList) subscribeTodayTasks(user.uid);
      if (weeklyLbList) subscribeWeeklyLeaderboard();
      if (courseLbList) subscribeCourseLeaderboard();

      // Auto-commit any pending session stored locally (from last close)
      try {
        await __fb_commitLocalPendingSession();
      } catch (e) {
        console.warn('[pending-session] commit skipped:', e?.message || e);
      }

      // let app JS continue
      window.__initAfterLogin?.();
    } else {
      appRoot?.classList.add('hidden'); if (appRoot) appRoot.style.display = 'none';
      gate?.classList.remove('hidden'); if (gate) gate.style.display = '';
      todoFlyout?.classList.add('hidden'); if (todoFlyout) todoFlyout.style.display = 'none';

      if (unsubWeeklyLB) { unsubWeeklyLB(); unsubWeeklyLB = null; }
      if (unsubOverallLB) { unsubOverallLB(); unsubOverallLB = null; }
      if (unsubTasks) { unsubTasks(); unsubTasks = null; }
    }
  } catch (err) {
    console.error('[auth] onAuthStateChanged handler error:', err);
    showError(err?.message || 'Unexpected error');
  }
});

// --- Today’s tasks (To-Do) ---
let unsubTasksDaily = null;
let unsubTasksStatus = null;

async function subscribeTodayTasks(uid) {
  if (!todoList) return;
  const dkey = localDateKey();

  // Cached data from each stream
  let lastTasks = [];           // [{id, text, ...}]
  let lastStatusMap = {};       // { taskId: { done: boolean } }

  function renderTodos() {
    todoList.innerHTML = '';
    if (lastTasks.length === 0) {
      const li = document.createElement('li');
      li.textContent = 'No tasks yet for today.';
      li.className = 'todo-empty';
      todoList.appendChild(li);
      return;
    }
    lastTasks.forEach(t => {
      const li = document.createElement('li');
      li.className = 'todo-item';

      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.checked = !!(lastStatusMap[t.id]?.done);

      const label = document.createElement('span');
      label.textContent = t.text || '(untitled task)';

      chk.onchange = async () => {
        await markTask(uid, dkey, t.id, label.textContent, chk.checked);
      };

      li.append(chk, label);
      todoList.appendChild(li);
    });
  }

  // Unsubscribe old
  if (unsubTasksDaily)  { unsubTasksDaily();  unsubTasksDaily  = null; }
  if (unsubTasksStatus) { unsubTasksStatus(); unsubTasksStatus = null; }

  // 1) Stream of shared tasks for today
  unsubTasksDaily = onSnapshot(collection(db, 'dailyTasks', dkey, 'tasks'), (ss) => {
    const arr = [];
    ss.forEach((docSnap) => arr.push({ id: docSnap.id, ...docSnap.data() }));
    lastTasks = arr;
    renderTodos();
  });

  // 2) Stream of YOUR status docs for today
  unsubTasksStatus = onSnapshot(collection(db, 'users', uid, 'taskCompletion', dkey, 'tasks'), (statusQs) => {
    const map = {};
    statusQs.forEach(s => map[s.id] = s.data());
    lastStatusMap = map;
    renderTodos();
  });
}

async function markTask(uid, dkey, taskId, text, done) {
  const statusRef = doc(db, 'users', uid, 'taskCompletion', dkey, 'tasks', taskId);
  const dailyRef  = doc(db, 'users', uid, 'daily', dkey);
  const lbRef     = doc(db, 'dailyLeaderboard', dkey, 'users', uid);
  const uref      = doc(db, 'users', uid);

  await runTransaction(db, async (tx) => {
    const userSnap = await tx.get(uref);
    const displayName = userSnap.exists() ? (userSnap.data().displayName || 'Anonymous') : 'Anonymous';

    const ds = await tx.get(dailyRef);
    const data = ds.exists() ? ds.data() : { jpEnCorrect: 0, enJpCorrect: 0, tasksCompleted: 0 };

    let tasksCompleted = data.tasksCompleted || 0;
    const statusSnap = await tx.get(statusRef);
    const prev = statusSnap.exists() ? !!statusSnap.data().done : false;

    if (done && !prev) tasksCompleted += 1;
    if (!done && prev) tasksCompleted = Math.max(0, tasksCompleted - 1);

    tx.set(statusRef, {
      done, text, updatedAt: serverTimestamp(), ...(done ? { completedAt: serverTimestamp() } : {})
    }, { merge: true });

    const jpEn = data.jpEnCorrect || 0;
    const enJp = data.enJpCorrect || 0;
    const score = jpEn + enJp + tasksCompleted * TASK_BONUS;

    tx.set(dailyRef, {
      date: dkey, displayName,
      jpEnCorrect: jpEn,
      enJpCorrect: enJp,
      tasksCompleted,
      score,
      updatedAt: serverTimestamp()
    }, { merge: true });

    tx.set(lbRef, {
      uid, displayName, jpEnCorrect: jpEn, enJpCorrect: enJp,
      tasksCompleted, score, updatedAt: serverTimestamp()
    }, { merge: true });
  });
}

/* ------------------------------
   Leaderboards
   - Course (overall) leaderboard = SUM of all dailyLeaderboard/{date}/users per uid
   - Weekly leaderboard           = SUM of dailyLeaderboard entries that fall within the current week
--------------------------------- */

function subscribeCourseLeaderboard() {
  if (!courseLbList) return;

  const cg = collectionGroup(db, 'users'); // 'dailyLeaderboard/{date}/users/{uid}'
  if (unsubOverallLB) unsubOverallLB();

  unsubOverallLB = onSnapshot(cg, (ss) => {
    const agg = new Map();
    ss.forEach(docSnap => {
      // Only include docs under dailyLeaderboard/{date}/users/{uid}
      const usersCol = docSnap.ref.parent;
      const dateDoc = usersCol ? usersCol.parent : null;
      if (!dateDoc || (dateDoc.parent && dateDoc.parent.id !== 'dailyLeaderboard')) return;

      const d = docSnap.data() || {};
      const uid = d.uid || docSnap.id;
      if (!agg.has(uid)) {
        agg.set(uid, {
          uid,
          displayName: d.displayName || 'Anonymous',
          jpEnCorrect: 0,
          enJpCorrect: 0,
          tasksCompleted: 0,
          score: 0
        });
      }
      const row = agg.get(uid);
      row.jpEnCorrect   += d.jpEnCorrect   || 0;
      row.enJpCorrect   += d.enJpCorrect   || 0;
      row.tasksCompleted+= d.tasksCompleted|| 0;
      row.score         += d.score         || 0;

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
          <span class="lb-part">Correct: <b>${(u.jpEnCorrect||0)+(u.enJpCorrect||0)}</b></span>
          <span class="lb-part">Tasks: <b>${u.tasksCompleted || 0}</b></span>
          <span class="lb-score">${u.score || 0} pts</span>
        </div>`;
      courseLbList.appendChild(li);
    });
  }, (err) => console.error('[course LB] snapshot error:', err));
}

// Utility: get ISO week start (Mon) and end (Sun) for a given date
function getWeekBounds(d = new Date()) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  // ISO week day: 1 (Mon) .. 7 (Sun); JS getUTCDay(): 0 (Sun) .. 6 (Sat)
  let day = date.getUTCDay();
  if (day === 0) day = 7; // treat Sunday as 7

  const start = new Date(date);
  start.setUTCDate(date.getUTCDate() - day + 1); // Monday
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6); // Sunday
  return { start, end };
}
function ymd(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function subscribeWeeklyLeaderboard() {
  if (!weeklyLbList) return;

  const { start, end } = getWeekBounds(new Date());
  const startKey = ymd(start);
  const endKey   = ymd(end);

  const cg = collectionGroup(db, 'users'); // dailyLeaderboard/{YYYY-MM-DD}/users/{uid}
  if (unsubWeeklyLB) unsubWeeklyLB();

  unsubWeeklyLB = onSnapshot(cg, (ss) => {
    const agg = new Map();
    ss.forEach(docSnap => {
      // Only include docs under dailyLeaderboard/{date}/users/{uid}
      const usersCol = docSnap.ref.parent;
      const dateDoc = usersCol ? usersCol.parent : null;
      if (!dateDoc || (dateDoc.parent && dateDoc.parent.id !== 'dailyLeaderboard')) return;
      const parentDateId = dateDoc.id; // 'YYYY-MM-DD'
 // 'YYYY-MM-DD'
      if (parentDateId < startKey || parentDateId > endKey) return; // outside this week

      const d = docSnap.data() || {};
      const uid = d.uid || docSnap.id;
      if (!agg.has(uid)) {
        agg.set(uid, {
          uid,
          displayName: d.displayName || 'Anonymous',
          jpEnCorrect: 0,
          enJpCorrect: 0,
          tasksCompleted: 0,
          score: 0
        });
      }
      const row = agg.get(uid);
      row.jpEnCorrect   += d.jpEnCorrect   || 0;
      row.enJpCorrect   += d.enJpCorrect   || 0;
      row.tasksCompleted+= d.tasksCompleted|| 0;
      row.score         += d.score         || 0;
      if (d.displayName) row.displayName = d.displayName;
    });

    const rows = [...agg.values()].sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 50);

    weeklyLbList.innerHTML = '';
    let rank = 1;
    rows.forEach(u => {
      const li = document.createElement('li');
      li.innerHTML = `
        <div class="lb-row">
          <span class="lb-rank">#${rank++}</span>
          <span class="lb-name">${u.displayName || 'Anonymous'}</span>
          <span class="lb-part">Correct: <b>${(u.jpEnCorrect||0)+(u.enJpCorrect||0)}</b></span>
          <span class="lb-part">Tasks: <b>${u.tasksCompleted || 0}</b></span>
          <span class="lb-score">${u.score || 0} pts</span>
        </div>`;
      weeklyLbList.appendChild(li);
    });
  }, (err) => console.error('[weekly LB] snapshot error:', err));
}

/* ------------------------------
   NEW — Commit a buffered session (single write burst)
--------------------------------- */

/**
 * Commit a buffered session to Firestore.
 * @param {{deckName:string, mode:string, correct:number, wrong:number, skipped:number, total:number, jpEnCorrect:number, enJpCorrect:number}} payload
 */
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

  // ensure displayName
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
    score: increment(jpEnCorrect + enJpCorrect) // +1 per correct answer
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

// --- Progress: fetch recent attempts for the signed-in user ---
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

// Expose sign out (optional if you want to add a sign-out button later)
window.__signOut = () => signOut(auth);


// ---------------- Attendance API ----------------
// Data model:
// attendance/{YYYY-MM-DD}/students/{uid} => { present: boolean, markedBy: uid, markedAt: serverTimestamp(), displayName }

/** List all students (users) */
window.__fb_listStudents = async function () {
  const qy = query(collection(db, 'users'), orderBy('displayName'));
  const snap = await getDocs(qy);
  const rows = [];
  snap.forEach(d => rows.push({ uid: d.id, ...(d.data() || {}) }));
  return rows;
};

/** Get attendance map for a given date key 'YYYY-MM-DD' */
window.__fb_getAttendance = async function (dateKey) {
  const colRef = collection(db, 'attendance', dateKey, 'students');
  const snap = await getDocs(colRef);
  const map = {};
  snap.forEach(d => map[d.id] = d.data());
  return map; // { uid: {present: true/false, displayName, markedBy, markedAt} }
};

/** Set attendance for a single student */
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

/** Bulk save attendance changes: records = [{uid, present, displayName}] */
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

// --- Student-only history: Date, Class No, Present/Absent ---
window.__fb_getMyAttendanceHistoryWithClass = async function(limitN = 180){
  const user = auth.currentUser;
  if (!user) return [];
  // Query only this student's docs within the collection group to avoid scanning everyone
  const cg = collectionGroup(db, 'students');
  let qy;
  try {
    qy = query(cg, where(documentId(), '==', user.uid));
  } catch (e) {
    // Fallback: fetch all and filter (older SDKs)
    const snapAll = await getDocs(cg);
    const all = [];
    snapAll.forEach(docSnap => {
      if (docSnap.id === user.uid) {
        const dateDoc = docSnap.ref.parent ? docSnap.ref.parent.parent : null;
        if (dateDoc && dateDoc.id) {
          const d = docSnap.data() || {};
          all.append({ date: dateDoc.id, present: !!d.present });
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