// firebase.js — optimized for fewer reads/writes/listeners (Spark-safe)

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-auth.js";
import {
  getFirestore, doc, getDoc as _getDoc, setDoc as _setDoc, updateDoc as _updateDoc, serverTimestamp,
  collection, query, orderBy, limit, onSnapshot as _onSnapshot, addDoc as _addDoc,
  runTransaction as _runTransaction, getDocs as _getDocs, increment, writeBatch as _writeBatch, deleteDoc as _deleteDoc,
  collectionGroup, where, documentId
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";

/* ============ Bootstrap ============ */
const app = initializeApp({
  apiKey: "AIzaSyAtA3TIhy7cKG-r8Ru3LmaKQqhq9T9QAVE",
  authDomain: "rec-basic-robotics-2.firebaseapp.com",
  projectId: "rec-basic-robotics-2",
  storageBucket: "rec-basic-robotics-2.firebasestorage.app",
  messagingSenderId: "699504573776",
  appId: "1:699504573776:web:93335a0025a3a009de8055",
  measurementId: "G-GT00NG7TEL"
});
const auth = getAuth(app);
const db   = getFirestore(app);
const provider = new GoogleAuthProvider();

/* ============ Read/Write/Listener Meter ============ */
/* Counts are approximate (client-side), but very useful while tuning */
const __io = {
  reads: 0, writes: 0, listeners: 0,
  lastLog: 0,
  sectionTallies: {},                 // {sectionId: {reads,writes,listeners}}
  _bump(kind, section = window.__activeSection || "global"){
    if (!this.sectionTallies[section]) this.sectionTallies[section] = {reads:0,writes:0,listeners:0};
    this[kind]++; this.sectionTallies[section][kind]++;
    if ((this.reads + this.writes) - this.lastLog >= 10) {
      this.lastLog = this.reads + this.writes;
      console.log(`[IO] reads=${this.reads} writes=${this.writes} listeners=${this.listeners}`, this.sectionTallies);
    }
  }
};

// Proxies that increment the counters (only used within THIS file)
const getDoc = async (...args) => { __io._bump('reads'); return _getDoc(...args); };
const getDocs = async (...args) => { __io._bump('reads'); return _getDocs(...args); };
const setDoc = async (...args) => { __io._bump('writes'); return _setDoc(...args); };
const addDoc = async (...args) => { __io._bump('writes'); return _addDoc(...args); };
const updateDoc = async (...args) => { __io._bump('writes'); return _updateDoc(...args); };
const deleteDoc = async (...args) => { __io._bump('writes'); return _deleteDoc(...args); };
const writeBatch = (...args) => { return _writeBatch(...args); };
const runTransaction = async (...args) => { /* complex; count on commit end */ return _runTransaction(...args); };
const onSnapshot = (ref, ...rest) => {
  __io._bump('listeners');
  return _onSnapshot(ref, ...rest);
};

// Dev helpers
window.__fb_ioStats = (cmd="print") => {
  if (cmd === "reset"){ __io.reads=__io.writes=__io.listeners=__io.lastLog=0; __io.sectionTallies={}; console.log("[IO] counters reset"); return; }
  return { reads: __io.reads, writes: __io.writes, listeners: __io.listeners, sections: __io.sectionTallies };
};
/* ============ End meter ============ */

/* ============ DOM refs (guarded) ============ */
const gate         = document.getElementById('auth-gate');
const appRoot      = document.getElementById('app-root');
const authBtn      = document.getElementById('auth-btn');
const authErr      = document.getElementById('auth-error');
const approvalGate = document.getElementById('approval-gate');

const todoFlyout = document.getElementById('todo-flyout');
const todoList   = document.getElementById('todo-list');
const adminRow   = document.getElementById('admin-row');

const courseLbList = document.getElementById('course-leaderboard-list');
const weeklyLbList = document.getElementById('weekly-leaderboard-list');

/* ============ Small utils ============ */
const showError = (msg) => { if (authErr) { authErr.textContent = msg; authErr.style.display = 'block'; } };
const hideError = () => { if (authErr) authErr.style.display = 'none'; };

function getISOWeek(d=new Date()){
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay()||7));
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(),0,1));
  const weekNo = Math.ceil((((date - yearStart) / 86400000) + 1)/7);
  const y = date.getUTCFullYear();
  return `${y}-W${String(weekNo).padStart(2,'0')}`;
}
const _wk = (wkKey) => wkKey || getISOWeek();

/* ============ Auth UI ============ */
authBtn?.addEventListener('click', async () => {
  try { hideError(); await signInWithPopup(auth, provider); }
  catch (e) { console.warn('[auth] popup failed:', e?.code, e?.message); showError(e?.message || 'Sign-in failed'); }
});

/* ============ Listener registry (prevent duplicates) ============ */
const live = {
  weeklyTasksFlyout: null,
  adminApprovals: null,
  adminTaskItems: null,
  perTaskSubs: {},              // taskId -> unsubscribe
};

/* ============ Throttles & caches ============ */
const TOUCH_THROTTLE_MS = 24*60*60*1000; // 24h for updatedAt
const lastTouchKey = 'lastUserTouch';
const submissionCache = new Map(); // key: `${wk}:${taskId}:${uid}` -> {data, ts}

/* ============ Auth state ============ */
onAuthStateChanged(auth, async (user) => {
  try {
    if (!user) {
      // Signed out → hide app & stop listeners
      appRoot?.classList.add('hidden'); if (appRoot) appRoot.style.display='none';
      gate?.classList.remove('hidden'); if (gate) gate.style.display='';
      approvalGate?.classList.add('hidden'); if (approvalGate) approvalGate.style.display='none';
      todoFlyout?.classList.add('hidden'); if (todoFlyout) todoFlyout.style.display='none';
      stopAllAdminAlerts();
      stopWeeklyTasksFlyout();
      return;
    }

    // Ensure base profile; throttle updatedAt to <= 1/day
    const uref = doc(db, 'users', user.uid);
    const usnap = await getDoc(uref);
    if (!usnap.exists()){
      await setDoc(uref, {
        displayName: user.displayName || 'Anonymous',
        photoURL: user.photoURL || '',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        approved: false
      });
    } else {
      const lastTouch = Number(localStorage.getItem(lastTouchKey)||'0');
      if (Date.now() - lastTouch > TOUCH_THROTTLE_MS) {
        await updateDoc(uref, { updatedAt: serverTimestamp() });
        localStorage.setItem(lastTouchKey, String(Date.now()));
      }
    }

    // Admin?
    let isAdmin = false;
    try { const a = await getDoc(doc(db,'admins', user.uid)); isAdmin = a.exists(); } catch {}
    window.__isAdmin = !!isAdmin;

    // Approved?
    const fresh = await getDoc(uref);
    const approved = !!(fresh.exists() && fresh.data().approved);

    if (!isAdmin && !approved){
      gate?.classList.add('hidden'); if (gate) gate.style.display='none';
      appRoot?.classList.add('hidden'); if (appRoot) appRoot.style.display='none';
      approvalGate?.classList.remove('hidden'); if (approvalGate) approvalGate.style.display='grid';
      return;
    }

    // Show app
    approvalGate?.classList.add('hidden'); if (approvalGate) approvalGate.style.display='none';
    gate?.classList.add('hidden'); if (gate) gate.style.display='none';
    appRoot?.classList.remove('hidden'); if (appRoot) appRoot.style.display='block';

    // Weekly Tasks flyout only for students, on-demand & single listener
    if (!isAdmin) startWeeklyTasksFlyout(user.uid); else stopWeeklyTasksFlyout();

    // Defer admin alerts to section visibility (script.js will call start/stop)
    // Defer leaderboards to on-demand fetch (script.js will call fetch + optional slow poll)

    // Commit any pending practice from previous session once
    try { await __fb_commitLocalPendingSession(); } catch(e) { console.warn('[pending-session] commit skipped:', e?.message||e); }

    window.__initAfterLogin?.();
  } catch (err) {
    console.error('[auth] onAuthStateChanged error:', err);
    showError(err?.message || 'Unexpected error');
  }
});

/* ============ Student: Weekly Tasks Flyout (scoped) ============ */
function stopWeeklyTasksFlyout(){
  if (live.weeklyTasksFlyout){ try { live.weeklyTasksFlyout(); } catch{} live.weeklyTasksFlyout=null; }
}
function startWeeklyTasksFlyout(uid){
  if (!todoFlyout || !todoList) return;
  stopWeeklyTasksFlyout();
  const wk = getISOWeek(new Date());
  // one listener for items; then shallow per-item submission reads with tiny cache
  live.weeklyTasksFlyout = onSnapshot(collection(db,'tasks', wk,'items'), async (ss) => {
    const items = ss.docs.map(d => ({ id:d.id, ...(d.data()||{}) }));
    // Determine which submissions we actually need to (re)read
    const needs = [];
    for (const it of items){
      const key = `${wk}:${it.id}:${uid}`;
      if (!submissionCache.has(key)) needs.push({ it, key });
    }
    // read only missing submissions
    for (const {it,key} of needs){
      const sRef = doc(db,'tasks', wk, 'items', it.id, 'submissions', uid);
      const sSnap = await getDoc(sRef);
      submissionCache.set(key, sSnap.exists() ? sSnap.data() : null);
    }

    // render
    todoList.innerHTML = '';
    if (!items.length){
      const li = document.createElement('li');
      li.className='todo-empty'; li.textContent='No weekly tasks assigned yet.'; todoList.appendChild(li);
      return;
    }
    for (const it of items){
      const li = document.createElement('li'); li.className='todo-item';
      const title = document.createElement('span'); title.textContent = it.title || '(Untitled task)';
      const due = document.createElement('span'); due.style.marginLeft='auto'; due.className='muted';
      due.textContent = it.dueAt ? new Date(it.dueAt).toLocaleString() : 'No due';
      const badge = document.createElement('span'); badge.className='muted'; badge.style.marginLeft='8px';
      const sub = submissionCache.get(`${wk}:${it.id}:${uid}`);
      badge.textContent = sub?.submittedAt ? 'Submitted' : 'Pending';
      li.append(title,due,badge);
      li.onclick = () => { window.showSection && window.showSection('tasks-section'); };
      todoList.appendChild(li);
    }
  });
}

/* ============ Admin alerts (lazy; script.js will start/stop) ============ */
function stopAllAdminAlerts(){
  if (live.adminApprovals){ try{ live.adminApprovals(); }catch{} live.adminApprovals=null; }
  if (live.adminTaskItems){ try{ live.adminTaskItems(); }catch{} live.adminTaskItems=null; }
  for (const k of Object.keys(live.perTaskSubs)){ try{ live.perTaskSubs[k](); }catch{} delete live.perTaskSubs[k]; }
}
function startAdminApprovalAlerts(){
  if (live.adminApprovals) return;
  let prevCount = null;
  const qy = query(collection(db,'users'), where('approved','==', false));
  live.adminApprovals = onSnapshot(qy, (ss) => {
    const count = ss.size;
    if (prevCount === null){ prevCount = count; return; } // ignore first
    if (count > prevCount){ const msg = `${count} student${count>1?'s':''} waiting for approval`; try{ window.showToast && window.showToast(msg); }catch{} }
    prevCount = count;
  }, (err)=>console.warn('[approval alerts]', err));
}
function startAdminSubmissionAlerts(){
  if (live.adminTaskItems) return;
  const wk = getISOWeek(new Date());
  const itemsRef = collection(db, 'tasks', wk, 'items');
  live.adminTaskItems = onSnapshot(itemsRef, (itemsSnap) => {
    // For each task, attach ONE submissions listener
    itemsSnap.forEach(itemDoc => {
      const taskId = itemDoc.id;
      if (live.perTaskSubs[taskId]) return;
      let firstLoad = true;
      const subsRef = collection(db,'tasks', wk, 'items', taskId, 'submissions');
      live.perTaskSubs[taskId] = onSnapshot(subsRef, (subsSnap) => {
        subsSnap.docChanges().forEach(ch => {
          if (ch.type !== 'added') return;
          if (firstLoad) return;
          const d = ch.doc.data()||{};
          const who = d.displayName || ch.doc.id;
          const title = (itemDoc.data()||{}).title || '(Untitled task)';
          const msg = `New submission: ${who} → ${title}`;
          try { window.showToast && window.showToast(msg); } catch {}
        });
        firstLoad = false;
      }, (err)=>console.warn('[submission alerts]', err));
    });
    // Cleanup missing tasks
    const liveIds = new Set(itemsSnap.docs.map(d=>d.id));
    Object.keys(live.perTaskSubs).forEach(tid => {
      if (!liveIds.has(tid)){ try{ live.perTaskSubs[tid](); }catch{} delete live.perTaskSubs[tid]; }
    });
  }, (err)=>console.warn('[task items alert]', err));
}

// expose start/stop for script.js
window.__startAdminApprovalAlerts = startAdminApprovalAlerts;
window.__stopAdminApprovalAlerts  = () => { if (live.adminApprovals){ try{ live.adminApprovals(); }catch{} live.adminApprovals=null; } };
window.__startAdminSubmissionAlerts = startAdminSubmissionAlerts;
window.__stopAdminSubmissionAlerts  = () => {
  if (live.adminTaskItems){ try{ live.adminTaskItems(); }catch{} live.adminTaskItems=null; }
  for (const k of Object.keys(live.perTaskSubs)){ try{ live.perTaskSubs[k](); }catch{} delete live.perTaskSubs[k]; }
};

/* ============ Leaderboards (on-demand) ============ */
// Weekly LB (current week, top 50)
window.__fb_fetchWeeklyLeaderboard = async (weekKey) => {
  const wk = _wk(weekKey);
  // weeklyLeaderboard/{wk}/users/{uid}
  const qy = query(collection(db,'weeklyLeaderboard', wk, 'users'), orderBy('total','desc'), limit(50));
  const snap = await getDocs(qy);
  const rows = [];
  snap.forEach(d => rows.push({ uid: d.id, ...(d.data()||{}) }));
  return rows;
};

// Course LB = sum of all weekly docs per uid
window.__fb_fetchCourseLeaderboard = async () => {
  // get groups then aggregate client-side (one query instead of live CG subscription)
  const cg = query(collectionGroup(db,'users'));
  const snap = await getDocs(cg);
  const agg = new Map();
  snap.forEach(docSnap => {
    const usersCol = docSnap.ref.parent;
    const weekDoc  = usersCol ? usersCol.parent : null;
    if (!weekDoc || (weekDoc.parent && weekDoc.parent.id !== 'weeklyLeaderboard')) return;
    const d = docSnap.data()||{};
    const uid = d.uid || docSnap.id;
    if (!agg.has(uid)){
      agg.set(uid, { uid, displayName: d.displayName || 'Anonymous', practiceScore:0, taskScore:0, attendanceScore:0, examScore:0, total:0, weeks:0 });
    }
    const row = agg.get(uid);
    row.practiceScore   += +d.practiceScore || 0;
    row.taskScore       += +d.taskScore || 0;
    row.attendanceScore += +d.attendanceScore || 0;
    row.examScore       += +d.examScore || 0;
    row.total           += +d.total || 0;
    row.weeks++;
    if (d.displayName) row.displayName = d.displayName;
  });
  return [...agg.values()].sort((a,b)=>(b.total||0)-(a.total||0)).slice(0,50);
};

/* ============ Admin: approvals, students list ============ */
window.__fb_listPending = async function () {
  const qy = query(collection(db, 'users'), where('approved','==', false));
  const snap = await getDocs(qy);
  const rows = [];
  snap.forEach(d => rows.push({ uid: d.id, ...(d.data()||{}) }));
  rows.sort((a,b) => (a.displayName||'').localeCompare(b.displayName||''));
  return rows;
};
window.__fb_approveUser = async function (uid) {
  await updateDoc(doc(db,'users',uid), { approved: true, approvedAt: serverTimestamp() });
};
window.__fb_listApprovedStudents = async function () {
  const [usersSnap, adminsSnap] = await Promise.all([
    getDocs(query(collection(db,'users'), where('approved','==', true))),
    getDocs(collection(db,'admins'))
  ]);
  const admins = new Set(); adminsSnap.forEach(a => admins.add(a.id));
  const rows = [];
  usersSnap.forEach(u => { if (!admins.has(u.id)) rows.push({ uid: u.id, ...(u.data()||{}) }); });
  rows.sort((a,b) => (a.displayName||'').localeCompare(b.displayName||''));
  return rows;
};

/* ============ Tasks & Submissions ============ */
window.__fb_createTask = async function (data) {
  const user = auth.currentUser; if (!user) throw new Error('Not signed in');
  const wk = getISOWeek(new Date());
  const col = collection(db,'tasks', wk, 'items');
  const ref = await addDoc(col, {
    title: data.title || '',
    description: data.description || '',
    dueAt: data.dueAt || null,
    link: data.link || '',
    scoreMax: Number(data.scoreMax || 0),
    createdBy: user.uid,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
  return ref.id;
};
window.__fb_updateTask = async function (weekKey, taskId, patch) {
  await updateDoc(doc(db,'tasks', _wk(weekKey), 'items', taskId), { ...patch, updatedAt: serverTimestamp() });
};
window.__fb_listTasks = async function (weekKey) {
  const qy = query(collection(db,'tasks', _wk(weekKey), 'items'), orderBy('createdAt','asc'));
  const snap = await getDocs(qy);
  const arr = []; snap.forEach(d => arr.push({ id: d.id, ...(d.data()||{}) }));
  return arr;
};
window.__fb_submitTask = async function (weekKey, taskId, linkUrl) {
  const user = auth.currentUser; if (!user) throw new Error('Not signed in');
  await setDoc(doc(db,'tasks', _wk(weekKey), 'items', taskId, 'submissions', user.uid), {
    link: (linkUrl||'').trim(),
    submittedAt: serverTimestamp()
  }, { merge: true });
};
window.__fb_listMySubmissions = async function (weekKey) {
  const user = auth.currentUser; if (!user) return {};
  const wk = _wk(weekKey);
  const subs = {};
  const itemsSnap = await getDocs(collection(db,'tasks', wk, 'items'));
  for (const item of itemsSnap.docs) {
    const key = `${wk}:${item.id}:${user.uid}`;
    let data = submissionCache.get(key);
    if (data === undefined){ // not cached
      const sRef = doc(db,'tasks', wk,'items', item.id, 'submissions', user.uid);
      const sSnap = await getDoc(sRef);
      data = sSnap.exists() ? sSnap.data() : null;
      submissionCache.set(key, data);
    }
    if (data) subs[item.id] = data;
  }
  return subs;
};

// Admin: list submissions (batch user lookups)
window.__fb_listSubmissions = async function(weekKey, taskId){
  const wk = _wk(weekKey);
  const subsSnap = await getDocs(collection(db,'tasks', wk, 'items', taskId, 'submissions'));
  const out = [], uids = [];
  subsSnap.forEach(s => { uids.push(s.id); out.push({ uid: s.id, ...(s.data()||{}) }); });
  // batch user reads in chunks of 10
  for (let i=0; i<uids.length; i+=10){
    const chunk = uids.slice(i,i+10);
    const qy = query(collection(db,'users'), where(documentId(),'in', chunk));
    const us = await getDocs(qy);
    const nameMap = new Map(); us.forEach(d=>nameMap.set(d.id, (d.data()||{}).displayName || 'Anonymous'));
    for (let j=0; j<out.length; j++){ if (chunk.includes(out[j].uid)) out[j].displayName = nameMap.get(out[j].uid) || out[j].displayName || 'Anonymous'; }
  }
  return out;
};

// Delete a task and all its submissions (batch)
window.__fb_deleteTask = async function(weekKey, taskId){
  const wk = _wk(weekKey);
  const subCol = collection(db,'tasks', wk, 'items', taskId, 'submissions');
  const subSnap = await getDocs(subCol);
  const batch = writeBatch(db);
  subSnap.forEach(s => batch.delete(s.ref));
  await batch.commit();
  await deleteDoc(doc(db,'tasks', wk, 'items', taskId));
  return true;
};

/* ============ Attempts / Progress commits (throttled) ============ */
let lastCommitAt = 0;
const MIN_COMMIT_INTERVAL_MS = 60 * 1000; // 60s
const MIN_SIZE_THRESHOLD = 10;

window.__fb_commitSession = async function(payload){
  // enforce throttle
  const now = Date.now();
  const tooSoon = (now - lastCommitAt) < MIN_COMMIT_INTERVAL_MS && (payload?.total||0) < MIN_SIZE_THRESHOLD;
  if (tooSoon) return { skipped: true, reason: 'throttled' };

  const user = auth.currentUser; if (!user) throw new Error('Not signed in');
  const wk = getISOWeek(new Date());
  // 1) save attempt
  const attemptsCol = collection(db, 'users', user.uid, 'attempts');
  await addDoc(attemptsCol, {
    ...payload,
    createdAt: serverTimestamp()
  });
  // 2) denormalize to weekly leaderboard (cheap client-side aggregation)
  const wref = doc(db, 'weeklyLeaderboard', wk, 'users', user.uid);
  await _runTransaction(db, async (tx) => {
    const snap = await tx.get(wref);
    const prev = snap.exists() ? (snap.data()||{}) : {};
    const next = {
      uid: user.uid,
      displayName: (await getDoc(doc(db,'users', user.uid))).data()?.displayName || 'Anonymous',
      practiceScore: Number(prev.practiceScore||0) + Number(payload?.correct||0),
      taskScore: Number(prev.taskScore||0),         // unchanged here
      attendanceScore: Number(prev.attendanceScore||0),
      examScore: Number(prev.examScore||0),
      total: Number(prev.total||0) + Number(payload?.correct||0)
    };
    tx.set(wref, next, { merge: true });
  });
  lastCommitAt = Date.now();
  return { ok: true };
};

// Called on next login to flush pending local payload (if any)
window.__fb_commitLocalPendingSession = async function(){
  const raw = localStorage.getItem('pendingSession');
  if (!raw) return;
  const payload = JSON.parse(raw);
  if (!payload || !payload.total) { localStorage.removeItem('pendingSession'); return; }
  try { await window.__fb_commitSession(payload); }
  finally { localStorage.removeItem('pendingSession'); }
};

/* ============ Attempts fetch (for Progress) ============ */
window.__fb_fetchAttempts = async function (limitN = 50){
  const user = auth.currentUser; if (!user) return [];
  const qy = query(collection(db,'users', user.uid, 'attempts'), orderBy('createdAt','desc'), limit(limitN));
  const snap = await getDocs(qy);
  const out = [];
  snap.forEach(d => out.push({ id:d.id, ...(d.data()||{}), createdAt: d.data()?.createdAt?.toMillis?.() ? d.data().createdAt.toMillis() : Date.now() }));
  return out;
};
window.__fb_fetchAttemptsFor = async function(uid, limitN=10){
  const qy = query(collection(db,'users', uid, 'attempts'), orderBy('createdAt','desc'), limit(limitN));
  const snap = await getDocs(qy);
  const out = []; snap.forEach(d=>out.push({ id:d.id, ...(d.data()||{}), createdAt: d.data()?.createdAt?.toMillis?.() ? d.data().createdAt.toMillis() : Date.now() }));
  return out;
};

/* ============ Attendance helpers ============ */
// (unchanged public API; ensure you batch writes where you already do in script.js)

/* ============ Sign out passthrough ============ */
window.__signOut = async () => { try { await signOut(auth); } catch(e){ console.warn('[signout]', e); } };

/* ============ Section mount/unmount hooks (for IO tallies) ============ */
window.__fb__sectionWillMount = (sectionId) => { window.__activeSection = sectionId; };
window.__fb__sectionWillUnmount = (sectionId) => { /* no-op, counts already bucketed */ };
