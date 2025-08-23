// =========================================================
// Basic Robotics – firebase.js (CDN, modular v10)
// Roles:
// - Auth gating + approval/admin checks
// - Cost-aware reads (manual fetches; scoped listeners only on visible sections)
// - Debounced session commits
// - Batched deletes for Reset DB
// - Read/Write/Delete meter increments -> window.__meter_*
// - Exposes adapters to script.js via window.__bindFirebaseAdapters
// =========================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, addDoc, collection,
  getDocs, query, where, orderBy, limit, writeBatch, serverTimestamp,
  onSnapshot
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";

// -------------------------
// Config (public by design)
// -------------------------
const firebaseConfig = {
  // TODO: keep your existing config here (keys are safe client-side)
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "xxxxxxxxxxxx",
  appId: "1:xxxxxxxxxxxx:web:xxxxxxxxxxxxxxxx"
};

// -------------------------
// Init
// -------------------------
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const provider = new GoogleAuthProvider();

// -------------------------
// Helpers
// -------------------------
const $ = (id) => document.getElementById(id);
const UI = window.__UI || { onAuth() {}, onRoleChange() {}, onApprovalChange() {} };

function isoDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
function isoWeek(d = new Date()) {
  // ISO week key YYYY-Www
  const tmp = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  // Thursday in current week decides the year.
  tmp.setUTCDate(tmp.getUTCDate() + 4 - (tmp.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((tmp - yearStart) / 86400000) + 1) / 7);
  const y = tmp.getUTCFullYear();
  return `${y}-W${String(weekNo).padStart(2, "0")}`;
}
const TODAY_KEY = () => isoDate(new Date());
const WEEK_KEY = () => isoWeek(new Date());

// Work-safe wrappers to count reads/writes/deletes
async function countedGetDoc(ref) {
  const snap = await getDoc(ref);
  window.__meter_read?.(1);
  return snap;
}
async function countedGetDocs(q) {
  const snap = await getDocs(q);
  // Approximate each doc as 1 read; add 1 for query metadata
  window.__meter_read?.(snap.size + 1);
  return snap;
}
async function countedSetDoc(ref, data, opts) {
  await setDoc(ref, data, opts);
  window.__meter_write?.(1);
}
async function countedUpdateDoc(ref, data) {
  await updateDoc(ref, data);
  window.__meter_write?.(1);
}
async function countedAddDoc(colRef, data) {
  const res = await addDoc(colRef, data);
  window.__meter_write?.(1);
  return res;
}

// Debounce utility for session commits
function debounce(fn, ms = 800) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// Safe onSnapshot with teardown tracking
const live = {
  weeklyLeaderboard: null,
};
function stopLive(key) {
  try { live[key]?.(); } catch {}
  live[key] = null;
}

// -------------------------
// Auth + Gate + Profiles
// -------------------------
async function ensureUserProfile(user) {
  const uref = doc(db, "users", user.uid);
  const snap = await countedGetDoc(uref);
  if (!snap.exists()) {
    await countedSetDoc(uref, {
      uid: user.uid,
      displayName: user.displayName || "",
      email: user.email || "",
      photoURL: user.photoURL || "",
      isAdmin: false,
      approved: false,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
  } else {
    // Light update if needed (don’t spam writes)
    const data = snap.data() || {};
    const shouldUpdate =
      (data.displayName !== user.displayName) ||
      (data.email !== user.email) ||
      (data.photoURL !== user.photoURL);
    if (shouldUpdate) {
      await countedUpdateDoc(uref, {
        displayName: user.displayName || "",
        email: user.email || "",
        photoURL: user.photoURL || "",
        updatedAt: serverTimestamp()
      });
    }
  }
  const again = await countedGetDoc(uref);
  return again.data();
}

async function signIn() {
  await signInWithPopup(auth, provider);
}
async function signOutNow() {
  await signOut(auth);
}

// Observe auth and drive gates
onAuthStateChanged(auth, async (user) => {
  try {
    if (!user) {
      UI.onAuth({ user: null, isAdmin: false, approved: false });
      return;
    }
    const profile = await ensureUserProfile(user);
    const isAdmin = !!profile.isAdmin;
    const approved = isAdmin || !!profile.approved;

    UI.onAuth({ user, isAdmin, approved });
    UI.onRoleChange?.({ isAdmin });
    UI.onApprovalChange?.({ approved });

    // Toggle admin/ student UI blocks here as a safety (index already hides)
    document.querySelectorAll('.admin-only').forEach(el => {
      el.classList.toggle('hidden', !isAdmin);
    });

  } catch (e) {
    console.error('[auth]', e);
    UI.onAuth({ user: null, isAdmin: false, approved: false });
  }
});

// -------------------------
// Section visibility hooks
// (script.js calls these; we attach/detach listeners accordingly)
// -------------------------
async function onSectionEnter(id) {
  if (id === 'weekly-leaderboard-section') {
    attachWeeklyLeaderboard();
  }
}
async function onSectionExit(id) {
  if (id === 'weekly-leaderboard-section') {
    stopLive('weeklyLeaderboard');
  }
}

// -------------------------
// Practice session commit (debounced)
// Writes to users/{uid}/attempts and aggregates:
//
// - users/{uid}/attempts/{auto}
// - overallLeaderboard/users/{uid}: { name, score }
//   (score += correct - wrong, floor at 0)
// You can tailor aggregates to your exact schema.
// -------------------------
const commitSession = debounce(async function commitSessionDebounced(payload) {
  const user = auth.currentUser;
  if (!user) return;

  const { deckName, mode, correct = 0, wrong = 0, skipped = 0, total = 0 } = payload || {};
  if (total <= 0) return;

  // attempt doc
  const attemptsCol = collection(db, "users", user.uid, "attempts");
  await countedAddDoc(attemptsCol, {
    deckName: deckName || 'Unknown',
    mode: mode || 'practice',
    correct, wrong, skipped, total,
    createdAt: serverTimestamp()
  });

  // aggregate "overall" course points (simple formula)
  const points = Math.max(0, Number(correct) - Number(wrong));
  const lbDoc = doc(db, "overallLeaderboard", "users", user.uid);
  const snap = await countedGetDoc(lbDoc);
  const name = user.displayName || (user.email || '').split('@')[0] || 'Student';

  if (snap.exists()) {
    const prev = Number(snap.data()?.score || 0);
    await countedUpdateDoc(lbDoc, {
      name,
      score: Math.max(0, prev + points),
      updatedAt: serverTimestamp()
    });
  } else {
    await countedSetDoc(lbDoc, {
      name,
      score: points,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
  }
}, 800);

// -------------------------
// Tasks (current ISO week)
// Collections:
// - weeklyTasks/{WEEK_KEY}/tasks/{taskId} : {title, desc, link, due, max}
// - weeklyTasks/{WEEK_KEY}/completions/{uid} : { [taskId]: true }
// -------------------------
async function fetchWeekTasksStudent() {
  const user = auth.currentUser;
  if (!user) return [];
  const wk = WEEK_KEY();

  const tasksQ = collection(db, "weeklyTasks", wk, "tasks");
  const tSnap = await countedGetDocs(query(tasksQ, orderBy("title")));

  const compDoc = doc(db, "weeklyTasks", wk, "completions", user.uid);
  const cSnap = await countedGetDoc(compDoc);
  const doneMap = cSnap.exists() ? (cSnap.data() || {}) : {};

  const list = [];
  tSnap.forEach(d => {
    const data = d.data() || {};
    list.push({
      id: d.id,
      title: data.title || '',
      desc: data.desc || '',
      link: data.link || '',
      due: data.due || null,
      max: Number(data.max || 0),
      done: !!doneMap[d.id]
    });
  });
  return list;
}

async function toggleTaskCompletion(taskId, checked) {
  const user = auth.currentUser;
  if (!user) throw new Error('Not signed in');
  const wk = WEEK_KEY();

  const compRef = doc(db, "weeklyTasks", wk, "completions", user.uid);
  const snap = await countedGetDoc(compRef);
  const cur = snap.exists() ? (snap.data() || {}) : {};
  if (checked) cur[taskId] = true;
  else delete cur[taskId];

  if (snap.exists()) {
    await countedUpdateDoc(compRef, cur);
  } else {
    await countedSetDoc(compRef, cur);
  }
}

async function fetchWeekTasksAdmin() {
  const wk = WEEK_KEY();
  const tasksQ = collection(db, "weeklyTasks", wk, "tasks");
  const tSnap = await countedGetDocs(query(tasksQ, orderBy("title")));
  const items = [];
  tSnap.forEach(d => {
    const x = d.data() || {};
    items.push({ id: d.id, ...x });
  });
  return items;
}

async function createTask(task) {
  // input validated by UI
  const wk = WEEK_KEY();
  const ref = collection(db, "weeklyTasks", wk, "tasks");
  await countedAddDoc(ref, {
    title: task.title || '',
    desc: task.desc || '',
    link: task.link || '',
    due: task.due || null,
    max: Number(task.max || 0),
    createdAt: serverTimestamp()
  });
}

async function deleteTask(taskId) {
  // batch delete task + remove from all completion docs (best-effort)
  const wk = WEEK_KEY();
  const taskRef = doc(db, "weeklyTasks", wk, "tasks", taskId);

  // delete task doc
  const batch = writeBatch(db);
  batch.delete(taskRef);
  window.__meter_delete?.(1);

  // Clean-up completions (bounded pass)
  const compCol = collection(db, "weeklyTasks", wk, "completions");
  const compSnap = await countedGetDocs(compCol);
  compSnap.forEach(d => {
    const data = d.data() || {};
    if (data[taskId]) {
      const newMap = { ...data };
      delete newMap[taskId];
      batch.set(d.ref, newMap);
      window.__meter_write?.(1);
    }
  });
  await batch.commit();
}

// -------------------------
// Progress Aggregates
// users/{uid} contains running totals OR compute ad-hoc.
// Below we implement ad-hoc fetch with small footprint.
// -------------------------
async function _sumFieldFromAttempts(uid, field) {
  // minimal read: latest N attempts; adjust if needed
  const colRef = collection(db, "users", uid, "attempts");
  const qy = query(colRef, orderBy("createdAt", "desc"), limit(50));
  const snap = await countedGetDocs(qy);
  let s = 0;
  snap.forEach(d => {
    const x = d.data() || {};
    s += Number(x[field] || 0);
  });
  return s;
}
async function fetchStudentProgress() {
  const user = auth.currentUser;
  if (!user) return {};
  // Practice: sum correct across last 50
  const practice = await _sumFieldFromAttempts(user.uid, "correct");
  // Tasks: count completed this week
  const wk = WEEK_KEY();
  const compDoc = doc(db, "weeklyTasks", wk, "completions", user.uid);
  const csnap = await countedGetDoc(compDoc);
  const tasks = csnap.exists() ? Object.keys(csnap.data() || {}).length : 0;
  // Attendance: count total presents
  const attCol = collection(db, "attendance_by_user", user.uid, "days");
  const asnap = await countedGetDocs(attCol);
  let attendance = 0;
  asnap.forEach(d => { if (d.data()?.present) attendance++; });
  // Exam: placeholder 0 (unless you store elsewhere)
  return { practice, tasks, attendance, exam: 0 };
}

async function fetchAllApprovedStudents() {
  const qy = query(collection(db, "users"), where("approved", "==", true));
  const snap = await countedGetDocs(qy);
  const list = [];
  snap.forEach(d => {
    const x = d.data() || {};
    if (!x.isAdmin) {
      list.push({ uid: x.uid || d.id, displayName: x.displayName || '', email: x.email || '' });
    }
  });
  return list;
}

async function fetchAdminStudentProgress(uid) {
  const practice = await _sumFieldFromAttempts(uid, "correct");
  // Weekly tasks for that student
  const wk = WEEK_KEY();
  const compDoc = doc(db, "weeklyTasks", wk, "completions", uid);
  const csnap = await countedGetDoc(compDoc);
  const tasks = csnap.exists() ? Object.keys(csnap.data() || {}).length : 0;
  // Attendance (total presents)
  const attCol = collection(db, "attendance_by_user", uid, "days");
  const asnap = await countedGetDocs(attCol);
  let attendance = 0;
  asnap.forEach(d => { if (d.data()?.present) attendance++; });
  return { practice, tasks, attendance, exam: 0 };
}

// -------------------------
// Leaderboards
// Course (on-demand): overallLeaderboard/users/*
// Weekly (live, while visible): weeklyLeaderboard/{WEEK_KEY}/users/*
// -------------------------
async function fetchCourseLeaderboard() {
  const colRef = collection(db, "overallLeaderboard", "users");
  const snap = await countedGetDocs(query(colRef, orderBy("score", "desc"), limit(50)));
  const list = [];
  snap.forEach(d => {
    const x = d.data() || {};
    list.push({ id: d.id, name: x.name || 'Student', score: Number(x.score || 0) });
  });
  return list;
}

function attachWeeklyLeaderboard() {
  stopLive('weeklyLeaderboard');
  const wk = WEEK_KEY();
  const colRef = collection(db, "weeklyLeaderboard", wk, "users");
  // Subscriptions can be expensive; only attach while visible
  live.weeklyLeaderboard = onSnapshot(query(colRef, orderBy('score', 'desc'), limit(50)), (snap) => {
    window.__meter_read?.(snap.size + 1); // rough count
    const rows = [];
    snap.forEach(d => {
      const x = d.data() || {};
      rows.push({ id: d.id, name: x.name || 'Student', score: Number(x.score || 0) });
    });
    _adapterEvents.weeklyLBUpdate?.(rows);
  }, (err) => console.warn('[weeklyLB]', err));
}

// -------------------------
// Submissions (Admin)
// submissions/{taskId}/users/{uid} : { link, score }
// -------------------------
async function fetchTasksForSelect() {
  const wk = WEEK_KEY();
  const snap = await countedGetDocs(collection(db, "weeklyTasks", wk, "tasks"));
  const list = [];
  snap.forEach(d => {
    const x = d.data() || {};
    list.push({ id: d.id, title: x.title || '', max: Number(x.max || 0) });
  });
  return list.sort((a, b) => a.title.localeCompare(b.title));
}

async function fetchSubmissionsForTask(taskId) {
  const colRef = collection(db, "submissions", taskId, "users");
  const snap = await countedGetDocs(colRef);
  const list = [];
  snap.forEach(d => {
    const x = d.data() || {};
    list.push({ uid: d.id, name: x.name || '', link: x.link || '', score: Number(x.score || 0) });
  });
  return list;
}

async function scoreSubmission(taskId, uid, score) {
  const ref = doc(db, "submissions", taskId, "users", uid);
  await countedSetDoc(ref, {
    score: Number(score || 0),
    updatedAt: serverTimestamp()
  }, { merge: true });
}

// -------------------------
// Attendance
// Admin load/save:
//   - attendance/{DATE}/students/{uid} : { present, displayName, classNo }
// Student history (fast reads):
//   - mirror to attendance_by_user/{uid}/days/{DATE} : { present, classNo }
// -------------------------
async function loadAttendanceAdmin(dateKey) {
  const colRef = collection(db, "attendance", dateKey, "students");
  const snap = await countedGetDocs(colRef);
  const rows = [];
  snap.forEach(d => {
    const x = d.data() || {};
    rows.push({ uid: d.id, name: x.displayName || '', present: !!x.present });
  });
  // If empty, prefill with approved students list
  if (rows.length === 0) {
    const approved = await fetchAllApprovedStudents();
    return approved.map(s => ({ uid: s.uid, name: s.displayName || s.uid, present: false }));
  }
  return rows;
}

async function saveAttendanceAdmin(dateKey, classNo, rows) {
  const batch = writeBatch(db);
  let writes = 0;

  // Write each student to attendance/{DATE}/students/{uid}
  for (const r of rows) {
    const ref = doc(db, "attendance", dateKey, "students", r.uid);
    batch.set(ref, {
      present: !!r.present,
      displayName: r.name || '',
      classNo: classNo || '',
      updatedAt: serverTimestamp()
    }, { merge: true });
    writes++;
  }

  // Mirror to attendance_by_user for quick per-user reads
  for (const r of rows) {
    const ref2 = doc(db, "attendance_by_user", r.uid, "days", dateKey);
    batch.set(ref2, {
      date: dateKey,
      present: !!r.present,
      classNo: classNo || '',
      updatedAt: serverTimestamp()
    }, { merge: true });
    writes++;
  }

  await batch.commit();
  window.__meter_write?.(writes);
  return { writes };
}

async function loadAttendanceHistoryAdmin(dateKey) {
  const colRef = collection(db, "attendance", dateKey, "students");
  const snap = await countedGetDocs(colRef);
  const rows = [];
  snap.forEach(d => {
    const x = d.data() || {};
    rows.push({ uid: d.id, name: x.displayName || '', present: !!x.present });
  });
  return rows;
}

async function fetchStudentAttendance(uidOrMe) {
  const user = auth.currentUser;
  const uid = (uidOrMe === 'me' ? user?.uid : uidOrMe) || user?.uid;
  if (!uid) return [];
  const colRef = collection(db, "attendance_by_user", uid, "days");
  const snap = await countedGetDocs(colRef);
  const rows = [];
  snap.forEach(d => {
    const x = d.data() || {};
    rows.push({ date: x.date || d.id, classNo: x.classNo || '', present: !!x.present });
  });
  // Sort descending by date
  rows.sort((a, b) => (a.date < b.date ? 1 : -1));
  return rows;
}

// -------------------------
// Approvals (Admin)
// users where approved == false & isAdmin == false
// -------------------------
async function fetchApprovals() {
  const qy = query(collection(db, "users"), where("approved", "==", false));
  const snap = await countedGetDocs(qy);
  const items = [];
  snap.forEach(d => {
    const x = d.data() || {};
    if (!x.isAdmin) items.push({ uid: x.uid || d.id, displayName: x.displayName || '', email: x.email || '' });
  });
  return items;
}

async function approveUser(uid) {
  const ref = doc(db, "users", uid);
  await countedUpdateDoc(ref, { approved: true, updatedAt: serverTimestamp() });
}

// -------------------------
// Manage Students (Admin)
// - Reset: clears attempts, leaderboard rows, weekly completions, mirrors, and sets approved=false
// - Delete: removes user doc plus related
// -------------------------
async function fetchStudentsForManage() {
  const qy = query(collection(db, "users"), where("isAdmin", "==", false));
  const snap = await countedGetDocs(qy);
  const list = [];
  snap.forEach(d => {
    const x = d.data() || {};
    list.push({ uid: x.uid || d.id, displayName: x.displayName || '', email: x.email || '' });
  });
  return list;
}

async function resetStudent(uid) {
  let writes = 0, deletes = 0;

  // Delete attempts subcollection
  deletes += await deleteCollection(`users/${uid}/attempts`);

  // Clear overall leaderboard entry
  const lbRef = doc(db, "overallLeaderboard", "users", uid);
  const lbsnap = await countedGetDoc(lbRef);
  if (lbsnap.exists()) {
    const batch = writeBatch(db);
    batch.set(lbRef, { score: 0, name: lbsnap.data()?.name || 'Student', updatedAt: serverTimestamp() }, { merge: true });
    await batch.commit();
    window.__meter_write?.(1);
    writes += 1;
  }

  // Clear weekly completions current week
  const wk = WEEK_KEY();
  const compRef = doc(db, "weeklyTasks", wk, "completions", uid);
  const csnap = await countedGetDoc(compRef);
  if (csnap.exists()) {
    const batch = writeBatch(db);
    batch.delete(compRef); // remove whole map
    await batch.commit();
    window.__meter_delete?.(1);
    deletes += 1;
  }

  // Clear attendance mirror
  deletes += await deleteCollection(`attendance_by_user/${uid}/days`);

  // Set approved=false on profile
  await countedUpdateDoc(doc(db, "users", uid), { approved: false, updatedAt: serverTimestamp() });

  return { writes, deletes };
}

async function deleteStudent(uid) {
  let writes = 0, deletes = 0;

  // Delete attempts
  deletes += await deleteCollection(`users/${uid}/attempts`);
  // Delete attendance mirror
  deletes += await deleteCollection(`attendance_by_user/${uid}/days`);
  // Remove from leaderboard
  const lbRef = doc(db, "overallLeaderboard", "users", uid);
  const batch = writeBatch(db);
  batch.delete(lbRef); deletes++;
  // Delete user doc
  const uref = doc(db, "users", uid);
  batch.delete(uref); deletes++;
  await batch.commit();
  window.__meter_delete?.(2);

  return { writes, deletes };
}

// Generic batched delete (depth-1 collection path)
async function deleteCollection(path, batchSize = 300) {
  const parts = path.split('/').filter(Boolean);
  let colRef;
  if (parts.length % 2 === 1) {
    // collection path
    colRef = collection(db, ...parts);
  } else {
    // invalid
    return 0;
  }
  let total = 0;
  while (true) {
    const snap = await countedGetDocs(query(colRef, limit(batchSize)));
    if (snap.empty) break;
    const batch = writeBatch(db);
    let count = 0;
    snap.forEach(d => { batch.delete(d.ref); count++; });
    if (count > 0) {
      await batch.commit();
      window.__meter_delete?.(count);
      total += count;
    }
    if (count < batchSize) break;
  }
  return total;
}

// -------------------------
// Admin: Reset Database (danger)
// Deletes selected high-volume collections and resets all non-admin users.
// -------------------------
async function resetDatabase() {
  let writes = 0, deletes = 0;

  // 1) Clear leaderboards (overall + weekly current week)
  deletes += await deleteCollection("overallLeaderboard/users");
  deletes += await deleteCollection(`weeklyLeaderboard/${WEEK_KEY()}/users`);

  // 2) Clear weekly tasks + completions (current week)
  deletes += await deleteCollection(`weeklyTasks/${WEEK_KEY()}/tasks`);
  deletes += await deleteCollection(`weeklyTasks/${WEEK_KEY()}/completions`);

  // 3) Clear submissions (all tasks) - optional heavy; here only current week tasks subtree if used
  // If you want full purge: iterate all submissions/*/users/*
  // (Left conservative for cost)

  // 4) Clear attendance (today only to avoid huge deletes)
  deletes += await deleteCollection(`attendance/${TODAY_KEY()}/students`);

  // 5) Reset all non-admin users: approved=false, wipe mirrors/attempts
  const usersSnap = await countedGetDocs(query(collection(db, "users")));
  const nonAdmins = [];
  usersSnap.forEach(d => { const x = d.data() || {}; if (!x.isAdmin) nonAdmins.push({ id: d.id }); });

  for (const u of nonAdmins) {
    const res1 = await resetStudent(u.id);
    writes += res1.writes; deletes += res1.deletes;
  }

  return { writes, deletes };
}

// -------------------------
// Adapter events (internal)
// -------------------------
const _adapterEvents = {
  weeklyLBUpdate: null, // set by subscribeWeeklyLeaderboard
};

// -------------------------
// Adapters exposed to UI (script.js)
// -------------------------
const adapters = {
  // Auth
  signIn,
  signOut: signOutNow,

  // Lifecycle hooks from router
  onSectionEnter,
  onSectionExit,

  // Practice/session
  commitSession,

  // Tasks
  fetchWeekTasksStudent,
  toggleTaskCompletion,

  // Admin tasks
  fetchWeekTasksAdmin,
  createTask,
  deleteTask,

  // Progress
  fetchStudentProgress,
  fetchAllApprovedStudents,
  fetchAdminStudentProgress,

  // Leaderboards
  fetchCourseLeaderboard,
  subscribeWeeklyLeaderboard(cb) {
    _adapterEvents.weeklyLBUpdate = cb;
    attachWeeklyLeaderboard();
    return {
      unsubscribe() {
        _adapterEvents.weeklyLBUpdate = null;
        stopLive('weeklyLeaderboard');
      }
    };
  },

  // Submissions (admin)
  fetchTasksForSelect,
  fetchSubmissionsForTask,
  scoreSubmission,

  // Attendance
  fetchStudentAttendance,
  loadAttendanceAdmin,
  saveAttendanceAdmin,
  loadAttendanceHistoryAdmin,

  // Approvals/admin
  fetchApprovals,
  approveUser,

  // Manage students
  fetchStudentsForManage,
  resetStudent,
  deleteStudent,

  // Reset DB
  resetDatabase
};

// Bind adapters for script.js
window.__bindFirebaseAdapters?.(adapters);

// End: nothing else to export
