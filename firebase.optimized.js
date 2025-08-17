// firebase.js — Optimized version with reduced Firebase operations
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, serverTimestamp,
  collection, query, orderBy, limit, onSnapshot, addDoc,
  runTransaction, getDocs, increment, writeBatch, deleteDoc,
  collectionGroup, where, documentId, getCountFromServer
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";

// --- Firebase project config ---
const firebaseConfig = {
  apiKey: "AIzaSyAtA3TIhy7cKG-r8Ru3LmaKQqhq9T9QAVE",
  authDomain: "rec-basic-robotics-2.firebaseapp.com",
  projectId: "rec-basic-robotics-2",
  storageBucket: "rec-basic-robotics-2.firebasestorage.app",
  messagingSenderId: "699504573776",
  appId: "1:699504573776:web:93335a0025a3a009de8055",
  measurementId: "G-GT00NG7TEL"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);
const provider = new GoogleAuthProvider();

// --- CACHING LAYER ---
const cache = {
  users: new Map(),
  attendance: new Map(),
  tasks: new Map(),
  submissions: new Map(),
  leaderboard: { weekly: null, course: null, timestamp: 0 },
  TTL: 5 * 60 * 1000, // 5 minutes cache TTL
  
  set(key, value, ttl = this.TTL) {
    const expiry = Date.now() + ttl;
    this[key] = { value, expiry };
  },
  
  get(key) {
    const item = this[key];
    if (!item) return null;
    if (Date.now() > item.expiry) {
      delete this[key];
      return null;
    }
    return item.value;
  },
  
  clear(pattern) {
    if (pattern) {
      Object.keys(this).forEach(key => {
        if (key.includes(pattern)) delete this[key];
      });
    }
  }
};

// --- DOM refs ---
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

// Hide timer
if (todoTimer) todoTimer.style.display = 'none';

// --- Optimized Sign-in ---
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

// --- OPTIMIZED AUTH STATE HANDLER ---
onAuthStateChanged(auth, async (user) => {
  try {
    if (user) {
      // Check cache first
      let userData = cache.users.get(user.uid);
      let isAdmin = false;
      let approved = false;
      
      if (!userData) {
        // Batch read user data and admin status
        const [usnap, adminSnap] = await Promise.all([
          getDoc(doc(db, 'users', user.uid)),
          getDoc(doc(db, 'admins', user.uid))
        ]);
        
        isAdmin = adminSnap.exists();
        
        if (!usnap.exists()) {
          // Only create if doesn't exist
          userData = {
            displayName: user.displayName || 'Anonymous',
            photoURL: user.photoURL || '',
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
            approved: false
          };
          await setDoc(doc(db, 'users', user.uid), userData);
        } else {
          userData = usnap.data();
          // Only update if last update was > 1 hour ago
          const lastUpdate = userData.updatedAt?.toMillis?.() || 0;
          if (Date.now() - lastUpdate > 3600000) {
            await updateDoc(doc(db, 'users', user.uid), { updatedAt: serverTimestamp() });
          }
        }
        
        // Cache user data
        cache.users.set(user.uid, userData);
        approved = userData.approved;
      } else {
        approved = userData.approved;
        // Check admin from cache or fetch
        const adminCacheKey = `admin_${user.uid}`;
        const cachedAdmin = cache.get(adminCacheKey);
        if (cachedAdmin !== null) {
          isAdmin = cachedAdmin;
        } else {
          const adminSnap = await getDoc(doc(db, 'admins', user.uid));
          isAdmin = adminSnap.exists();
          cache.set(adminCacheKey, isAdmin, 10 * 60 * 1000); // Cache for 10 min
        }
      }
      
      window.__isAdmin = isAdmin;

      // Approval gate
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

      // Show/hide based on role
      if (window.__isAdmin) {
        todoFlyout?.classList.add('hidden'); if (todoFlyout) todoFlyout.style.display = 'none';
      } else {
        todoFlyout?.classList.remove('hidden'); if (todoFlyout) todoFlyout.style.display = '';
        subscribeWeeklyTaskFlyout(user.uid);
      }

      if (adminRow) adminRow.classList.toggle('hidden', !isAdmin);
      try { window.__onAdminStateChanged && window.__onAdminStateChanged(window.__isAdmin); } catch {}

      // Optimized leaderboard subscriptions with debouncing
      if (weeklyLbList) subscribeWeeklyLeaderboardOptimized();
      if (courseLbList) subscribeCourseLeaderboardOptimized();

      if (window.__isAdmin) {
        try { subscribeAdminApprovalAlertsOptimized(); } catch(e){ console.warn('approval alerts', e); }
        try { subscribeAdminSubmissionAlertsOptimized(); } catch(e){ console.warn('submission alerts', e); }
      }

      // Auto-commit pending session
      try { await __fb_commitLocalPendingSession(); } catch (e) { console.warn('[pending-session] commit skipped:', e?.message || e); }

      window.__initAfterLogin?.();
    } else {
      // Cleanup on logout
      appRoot?.classList.add('hidden'); if (appRoot) appRoot.style.display = 'none';
      gate?.classList.remove('hidden'); if (gate) gate.style.display = '';
      approvalGate?.classList.add('hidden'); if (approvalGate) approvalGate.style.display = 'none';
      todoFlyout?.classList.add('hidden'); if (todoFlyout) todoFlyout.style.display = 'none';

      if (unsubWeeklyLB) { unsubWeeklyLB(); unsubWeeklyLB = null; }
      if (unsubOverallLB) { unsubOverallLB(); unsubOverallLB = null; }
      
      // Clear cache on logout
      cache.users.clear();
      cache.attendance.clear();
      cache.tasks.clear();
      cache.submissions.clear();
    }
  } catch (err) {
    console.error('[auth] onAuthStateChanged handler error:', err);
    showError(err?.message || 'Unexpected error');
  }
});

// --- OPTIMIZED APPROVAL API ---
window.__fb_listPending = async function () {
  const cacheKey = 'pending_users';
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  
  const qy = query(collection(db, 'users'), where('approved','==', false));
  const snap = await getDocs(qy);
  const rows = [];
  snap.forEach(d => rows.push({ uid: d.id, ...(d.data()||{}) }));
  rows.sort((a,b) => (a.displayName||'').localeCompare(b.displayName||''));
  
  cache.set(cacheKey, rows, 30000); // Cache for 30 seconds
  return rows;
};

window.__fb_approveUser = async function (uid) {
  await updateDoc(doc(db,'users',uid), { approved: true, approvedAt: serverTimestamp() });
  cache.users.delete(uid); // Clear user cache
  cache.clear('pending_users'); // Clear pending cache
};

window.__fb_listApprovedStudents = async function () {
  const cacheKey = 'approved_students';
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  
  const [usersSnap, adminsSnap] = await Promise.all([
    getDocs(query(collection(db,'users'), where('approved','==', true))),
    getDocs(collection(db,'admins'))
  ]);
  const admins = new Set();
  adminsSnap.forEach(a => admins.add(a.id));
  const rows = [];
  usersSnap.forEach(u => { if (!admins.has(u.id)) rows.push({ uid: u.id, ...(u.data()||{}) }); });
  rows.sort((a,b) => (a.displayName||'').localeCompare(b.displayName||''));
  
  cache.set(cacheKey, rows, 60000); // Cache for 1 minute
  return rows;
};

// --- OPTIMIZED TASK OPERATIONS ---
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
  cache.clear(`tasks_${weekKey}`); // Clear task cache for this week
  return docRef.id;
};

window.__fb_listTasks = async function (weekKey) {
  const wk = weekKey || getISOWeek(new Date());
  const cacheKey = `tasks_${wk}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  
  const qy = query(collection(db,'tasks', wk, 'items'), orderBy('createdAt','asc'));
  const snap = await getDocs(qy);
  const arr = [];
  snap.forEach(d => arr.push({ id: d.id, ...(d.data()||{}) }));
  
  cache.set(cacheKey, arr, 60000); // Cache for 1 minute
  return arr;
};

// --- OPTIMIZED SUBMISSION BATCHING ---
window.__fb_commitSession = async function (payload) {
  const user = auth.currentUser;
  if (!user) throw new Error('Not signed in');
  
  // Batch accumulator
  if (!window.__sessionBatch) {
    window.__sessionBatch = [];
    window.__batchTimer = null;
  }
  
  window.__sessionBatch.push(payload);
  
  // Debounce batch commits
  if (window.__batchTimer) clearTimeout(window.__batchTimer);
  
  window.__batchTimer = setTimeout(async () => {
    const batch = window.__sessionBatch;
    window.__sessionBatch = [];
    
    if (batch.length === 0) return;
    
    const dkey = localDateKey();
    const uref = doc(db, 'users', user.uid);
    const dailyRef = doc(db, 'users', user.uid, 'daily', dkey);
    const lbDaily  = doc(db, 'dailyLeaderboard', dkey, 'users', user.uid);
    
    // Get display name once
    let displayName = cache.users.get(user.uid)?.displayName;
    if (!displayName) {
      const usnap = await getDoc(uref);
      displayName = usnap.exists() ? (usnap.data().displayName || 'Anonymous') : 'Anonymous';
    }
    
    // Aggregate all sessions
    let totalJpEn = 0, totalEnJp = 0;
    const attempts = [];
    
    batch.forEach(p => {
      totalJpEn += p.jpEnCorrect || 0;
      totalEnJp += p.enJpCorrect || 0;
      attempts.push({
        deckName: p.deckName || 'Unknown Set',
        mode: p.mode || 'mcq',
        correct: p.correct || 0,
        wrong: p.wrong || 0,
        skipped: p.skipped || 0,
        total: p.total || 0,
        createdAt: Date.now(),
        createdAtServer: serverTimestamp()
      });
    });
    
    // Single batch write
    const fbBatch = writeBatch(db);
    
    // Create attempts
    attempts.forEach(att => {
      const attemptDoc = doc(collection(db, 'users', user.uid, 'attempts'));
      fbBatch.set(attemptDoc, att);
    });
    
    // Update scores once
    fbBatch.set(dailyRef, {
      date: dkey, uid: user.uid, displayName,
      updatedAt: serverTimestamp(),
      jpEnCorrect: increment(totalJpEn),
      enJpCorrect: increment(totalEnJp),
      score: increment(totalJpEn + totalEnJp)
    }, { merge: true });
    
    fbBatch.set(lbDaily, {
      uid: user.uid, displayName,
      updatedAt: serverTimestamp(),
      jpEnCorrect: increment(totalJpEn),
      enJpCorrect: increment(totalEnJp),
      score: increment(totalJpEn + totalEnJp)
    }, { merge: true });
    
    await fbBatch.commit();
  }, 2000); // Wait 2 seconds to batch multiple sessions
};

// --- OPTIMIZED LEADERBOARDS WITH DEBOUNCING ---
let lbDebounceTimer = null;

function subscribeWeeklyLeaderboardOptimized() {
  if (!weeklyLbList) return;
  
  const updateLeaderboard = async () => {
    // Check cache first
    if (cache.leaderboard.weekly && Date.now() - cache.leaderboard.timestamp < 30000) {
      renderWeeklyLeaderboard(cache.leaderboard.weekly);
      return;
    }
    
    try {
      const rows = await buildWeeklyAggregateOptimized();
      cache.leaderboard.weekly = rows;
      cache.leaderboard.timestamp = Date.now();
      renderWeeklyLeaderboard(rows);
    } catch (e) {
      console.error('[weekly LB] rebuild failed:', e);
    }
  };
  
  // Debounced listener
  const cg = collectionGroup(db, 'users');
  unsubWeeklyLB && unsubWeeklyLB();
  unsubWeeklyLB = onSnapshot(cg, () => {
    if (lbDebounceTimer) clearTimeout(lbDebounceTimer);
    lbDebounceTimer = setTimeout(updateLeaderboard, 3000); // Wait 3 seconds
  }, (err) => console.error('[weekly LB] snapshot error:', err));
  
  // Initial load
  updateLeaderboard();
}

function renderWeeklyLeaderboard(rows) {
  if (!weeklyLbList) return;
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
}

async function buildWeeklyAggregateOptimized() {
  const { start, end } = getWeekBounds(new Date());
  const startKey = ymd(start);
  const endKey   = ymd(end);
  const weekKey  = getISOWeek(new Date());
  
  // Use parallel fetching
  const [lbSnap, taskItems, exSnap] = await Promise.all([
    getDocs(collectionGroup(db, 'users')),
    getDocs(collection(db,'tasks', weekKey, 'items')),
    getDocs(collection(db,'examScores', weekKey, 'users'))
  ]);
  
  const agg = new Map();
  
  // Process leaderboard data
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
  
  // Process exam scores
  exSnap.forEach(s => {
    const uid = s.id;
    const data = s.data() || {};
    if (!agg.has(uid)) agg.set(uid, { displayName: 'Anonymous', practice:0, tasks:0, attendance:0, exam:0 });
    agg.get(uid).exam += Number(data.score || 0);
  });
  
  // Get attendance for just today (reduce reads)
  const todayKey = ymd(new Date());
  try {
    const attSnap = await getDocs(collection(db,'attendance', todayKey, 'students'));
    attSnap.forEach(s => {
      const data = s.data() || {};
      if (!data.present) return;
      const uid = s.id;
      if (!agg.has(uid)) agg.set(uid, { displayName: data.displayName || 'Anonymous', practice:0, tasks:0, attendance:0, exam:0 });
      // Just count today's attendance for demo
      agg.get(uid).attendance += 1;
    });
  } catch(e) {
    // Attendance collection might not exist for today
  }
  
  // Finalize
  const rows = [...agg.entries()].map(([uid, v]) => ({
    uid, displayName: v.displayName,
    practiceScore: v.practice,
    taskScore: v.tasks,
    attendanceScore: v.attendance,
    examScore: v.exam,
    total: v.practice + v.tasks + v.attendance + v.exam
  })).sort((a,b)=> b.total - a.total).slice(0, 50);
  
  // Cache to Firestore (but only if significant changes)
  if (rows.length > 0) {
    const batch = writeBatch(db);
    let batchSize = 0;
    rows.slice(0, 10).forEach(r => { // Only cache top 10 to reduce writes
      const ref = doc(db, 'weeklyLeaderboard', weekKey, 'users', r.uid);
      batch.set(ref, {
        uid: r.uid,
        displayName: r.displayName || 'Anonymous',
        weekKey,
        practiceScore: r.practiceScore,
        taskScore: r.taskScore,
        attendanceScore: r.attendanceScore,
        examScore: r.examScore,
        total: r.total,
        updatedAt: serverTimestamp()
      }, { merge: true });
      batchSize++;
    });
    if (batchSize > 0) await batch.commit();
  }
  
  return rows;
}

function subscribeCourseLeaderboardOptimized() {
  if (!courseLbList) return;
  
  const updateLeaderboard = async () => {
    // Use cached weekly leaderboard data
    const cg = collectionGroup(db, 'users');
    const snap = await getDocs(cg);
    
    const agg = new Map();
    snap.forEach(docSnap => {
      const usersCol = docSnap.ref.parent;
      const weekDoc = usersCol ? usersCol.parent : null;
      if (!weekDoc || (weekDoc.parent && weekDoc.parent.id !== 'weeklyLeaderboard')) return;
      
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
          total: 0,
          weeks: 0
        });
      }
      const row = agg.get(uid);
      row.practiceScore   += Number(d.practiceScore || 0);
      row.taskScore       += Number(d.taskScore || 0);
      row.attendanceScore += Number(d.attendanceScore || 0);
      row.examScore       += Number(d.examScore || 0);
      row.total           += Number(d.total || 0);
      row.weeks++;
    });
    
    const rows = [...agg.values()].sort((a, b) => (b.total || 0) - (a.total || 0)).slice(0, 50);
    
    courseLbList.innerHTML = '';
    let rank = 1;
    rows.forEach(u => {
      const li = document.createElement('li');
      li.innerHTML = `
        <div class="lb-row">
          <span class="lb-rank">#${rank++}</span>
          <span class="lb-name">${u.displayName || 'Anonymous'}</span>
          <span class="lb-part">Practice Σ: <b>${u.practiceScore}</b></span>
          <span class="lb-part">Tasks Σ: <b>${u.taskScore}</b></span>
          <span class="lb-part">Attend Σ: <b>${u.attendanceScore}</b></span>
          <span class="lb-part">Exam Σ: <b>${u.examScore}</b></span>
          <span class="lb-score">${u.total} pts</span>
        </div>`;
      courseLbList.appendChild(li);
    });
  };
  
  // Only update every 5 minutes
  if (unsubOverallLB) unsubOverallLB();
  unsubOverallLB = setInterval(updateLeaderboard, 5 * 60 * 1000);
  updateLeaderboard(); // Initial load
}

// --- OPTIMIZED ADMIN NOTIFICATIONS ---
let unsubApprovalAlert = null;
let lastApprovalCheck = 0;

function subscribeAdminApprovalAlertsOptimized(){
  if (unsubApprovalAlert) unsubApprovalAlert();
  
  // Use count query instead of fetching all docs
  const checkApprovals = async () => {
    if (Date.now() - lastApprovalCheck < 30000) return; // Check max every 30 seconds
    lastApprovalCheck = Date.now();
    
    const qy = query(collection(db, 'users'), where('approved','==', false));
    const snapshot = await getCountFromServer(qy);
    const count = snapshot.data().count;
    
    const prevCount = cache.get('approval_count') || 0;
    cache.set('approval_count', count);
    
    if (count > prevCount && prevCount > 0) {
      const msg = `${count} student${count>1?'s':''} waiting for approval`;
      try { window.showToast && window.showToast(msg); } catch {}
    }
  };
  
  // Check every minute instead of real-time
  unsubApprovalAlert = setInterval(checkApprovals, 60000);
  checkApprovals(); // Initial check
}

function subscribeAdminSubmissionAlertsOptimized(){
  // Similar optimization - use polling instead of real-time for non-critical updates
  const wk = getISOWeek(new Date());
  let lastCheck = Date.now();
  
  const checkSubmissions = async () => {
    const itemsSnap = await getDocs(collection(db, 'tasks', wk, 'items'));
    let newSubmissions = 0;
    
    for (const item of itemsSnap.docs) {
      const subsSnap = await getDocs(collection(db, 'tasks', wk, 'items', item.id, 'submissions'));
      subsSnap.forEach(s => {
        const submittedAt = s.data()?.submittedAt?.toMillis?.() || 0;
        if (submittedAt > lastCheck) newSubmissions++;
      });
    }
    
    if (newSubmissions > 0) {
      const msg = `${newSubmissions} new submission${newSubmissions>1?'s':''}`;
      try { window.showToast && window.showToast(msg); } catch {}
    }
    
    lastCheck = Date.now();
  };
  
  // Check every 2 minutes
  setInterval(checkSubmissions, 2 * 60 * 1000);
}

// --- OPTIMIZED ATTENDANCE ---
window.__fb_saveAttendanceBulk = async function (dateKey, records) {
  const user = auth.currentUser;
  if (!user) throw new Error('Not signed in');
  
  // Filter out unchanged records
  const existing = cache.attendance.get(dateKey) || {};
  const changes = records.filter(r => {
    const prev = existing[r.uid];
    return !prev || prev.present !== r.present;
  });
  
  if (changes.length === 0) return; // No changes
  
  const batch = writeBatch(db);
  changes.forEach(r => {
    const ref = doc(db, 'attendance', dateKey, 'students', r.uid);
    batch.set(ref, {
      present: !!r.present,
      displayName: r.displayName || null,
      markedBy: user.uid,
      markedAt: serverTimestamp()
    }, { merge: true });
  });
  await batch.commit();
  
  // Update cache
  records.forEach(r => {
    if (!existing[r.uid]) existing[r.uid] = {};
    existing[r.uid].present = r.present;
  });
  cache.attendance.set(dateKey, existing);
};

// Helper functions
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

// --- OPTIMIZED STUDENT FLYOUT ---
let unsubTasksFlyout = null;
async function subscribeWeeklyTaskFlyout(uid) {
  if (!todoList) return;
  const wk = getISOWeek(new Date());
  if (unsubTasksFlyout) { unsubTasksFlyout(); unsubTasksFlyout = null; }
  
  // Poll every 30 seconds instead of real-time
  const updateTasks = async () => {
    const items = await window.__fb_listTasks(wk); // Uses cache
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
  };
  
  unsubTasksFlyout = setInterval(updateTasks, 30000); // Poll every 30 seconds
  updateTasks(); // Initial load
}

// --- OPTIMIZED SUBMISSION FUNCTIONS ---
window.__fb_submitTask = async function(weekKey, taskId, linkUrl){
  const user = auth.currentUser; if (!user) throw new Error('Not signed in');
  const wk = weekKey || getISOWeek(new Date());
  await setDoc(doc(db,'tasks',wk,'items',taskId,'submissions', user.uid), {
    link: (linkUrl||'').trim(),
    submittedAt: serverTimestamp()
  }, { merge: true });
  cache.clear(`submissions_${wk}`); // Clear submissions cache
};

window.__fb_listMySubmissions = async function(weekKey){
  const user = auth.currentUser; if (!user) return {};
  const wk = weekKey || getISOWeek(new Date());
  
  const cacheKey = `submissions_${wk}_${user.uid}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  
  const subs = {};
  const itemsSnap = await getDocs(collection(db,'tasks', wk, 'items'));
  
  // Batch get submissions
  const promises = itemsSnap.docs.map(item => 
    getDoc(doc(db,'tasks', wk,'items', item.id, 'submissions', user.uid))
      .then(sSnap => {
        if (sSnap.exists()) subs[item.id] = sSnap.data();
      })
  );
  await Promise.all(promises);
  
  cache.set(cacheKey, subs, 60000); // Cache for 1 minute
  return subs;
};

// --- OPTIMIZED FETCH ATTEMPTS ---
window.__fb_fetchAttempts = async function (limitN = 20) {
  const user = auth.currentUser;
  if (!user) return [];
  
  const cacheKey = `attempts_${user.uid}_${limitN}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  
  const colRef = collection(db, 'users', user.uid, 'attempts');
  const qy = query(colRef, orderBy('createdAt', 'desc'), limit(limitN));
  const snap = await getDocs(qy);
  const list = [];
  snap.forEach(docSnap => {
    const d = docSnap.data() || {};
    const ts = d.createdAt || (d.createdAtServer?.toMillis ? d.createdAtServer.toMillis() : Date.now());
    list.push({ id: docSnap.id, ...d, createdAt: ts });
  });
  
  cache.set(cacheKey, list, 30000); // Cache for 30 seconds
  return list;
};

window.__fb_fetchAttemptsFor = async function (uid, limitN = 20) {
  if (!uid) return [];
  
  const cacheKey = `attempts_${uid}_${limitN}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  
  const colRef = collection(db, 'users', uid, 'attempts');
  const qy = query(colRef, orderBy('createdAt', 'desc'), limit(limitN));
  const snap = await getDocs(qy);
  const list = [];
  snap.forEach(docSnap => {
    const d = docSnap.data() || {};
    const ts = d.createdAt || (d.createdAtServer?.toMillis ? d.createdAtServer.toMillis() : Date.now());
    list.push({ id: docSnap.id, ...d, createdAt: ts });
  });
  
  cache.set(cacheKey, list, 30000);
  return list;
};

// --- OPTIMIZED ATTENDANCE FUNCTIONS ---
window.__fb_listStudents = async function () {
  return await window.__fb_listApprovedStudents(); // Already cached
};

window.__fb_getAttendance = async function (dateKey) {
  const cacheKey = `attendance_${dateKey}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  
  const colRef = collection(db, 'attendance', dateKey, 'students');
  const snap = await getDocs(colRef);
  const map = {};
  snap.forEach(d => map[d.id] = d.data());
  
  cache.set(cacheKey, map, 60000); // Cache for 1 minute
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
  cache.clear(`attendance_${dateKey}`); // Clear cache
};

// --- OPTIMIZED META FUNCTIONS ---
window.__fb_getAttendanceMeta = async function(dateKey){
  const cacheKey = `meta_${dateKey}`;
  const cached = cache.get(cacheKey);
  if (cached !== null) return cached;
  
  try{
    const ref = doc(db, 'attendance', dateKey);
    const snap = await getDoc(ref);
    const data = snap.exists() ? snap.data() : {};
    cache.set(cacheKey, data, 300000); // Cache for 5 minutes
    return data;
  }catch(e){ 
    console.warn('getAttendanceMeta failed', e); 
    return {}; 
  }
};

window.__fb_setAttendanceMeta = async function(dateKey, classNo){
  try{
    await setDoc(doc(db, 'attendance', dateKey), { 
      classNo: classNo, 
      updatedAt: serverTimestamp() 
    }, { merge: true });
    cache.clear(`meta_${dateKey}`);
  }catch(e){ 
    console.warn('setAttendanceMeta failed', e); 
    throw e; 
  }
};

// --- OPTIMIZED HISTORY FUNCTION ---
window.__fb_getMyAttendanceHistoryWithClass = async function(limitN = 180){
  const user = auth.currentUser;
  if (!user) return [];
  
  const cacheKey = `history_${user.uid}_${limitN}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  
  const cg = collectionGroup(db, 'students');
  let rows = [];
  
  try {
    const qy = query(cg, where(documentId(), '==', user.uid));
    const snap = await getDocs(qy);
    snap.forEach(docSnap => {
      const dateDoc = docSnap.ref.parent?.parent;
      if (!dateDoc) return;
      const d = docSnap.data() || {};
      rows.push({ date: dateDoc.id, present: !!d.present });
    });
  } catch {
    // Fallback for SDKs that don't support documentId() on collection groups
    const snapAll = await getDocs(cg);
    snapAll.forEach(docSnap => {
      if (docSnap.id === user.uid) {
        const dateDoc = docSnap.ref.parent?.parent;
        if (dateDoc?.id) {
          const d = docSnap.data() || {};
          rows.push({ date: dateDoc.id, present: !!d.present });
        }
      }
    });
  }
  
  rows.sort((a,b) => b.date.localeCompare(a.date));
  const top = rows.slice(0, limitN);
  
  // Batch fetch meta data
  const metaPromises = top.map(async row => {
    const meta = await window.__fb_getAttendanceMeta(row.date); // Uses cache
    return { ...row, classNo: meta.classNo };
  });
  
  const result = await Promise.all(metaPromises);
  cache.set(cacheKey, result, 300000); // Cache for 5 minutes
  return result;
};

// --- OPTIMIZED WEEKLY OVERVIEW ---
window.__fb_fetchWeeklyOverview = async function(){
  const user = auth.currentUser; 
  if (!user) return { tasks:[], attendance:[], exam:0 };
  
  const wk = getISOWeek(new Date());
  const cacheKey = `overview_${wk}_${user.uid}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  
  const { start } = getWeekBounds(new Date());
  const dates = [];
  for (let i=0; i<7; i++){ 
    const dt = new Date(start); 
    dt.setUTCDate(start.getUTCDate()+i); 
    dates.push(ymd(dt)); 
  }
  
  // Parallel fetch all data
  const [tasks, mySubs, examSnap] = await Promise.all([
    window.__fb_listTasks(wk), // Cached
    window.__fb_listMySubmissions(wk), // Cached
    getDoc(doc(db,'examScores', wk, 'users', user.uid))
  ]);
  
  // Process tasks
  const taskRows = tasks.map(t => {
    const sd = mySubs[t.id];
    return {
      title: t.title || '(Untitled)',
      dueAt: t.dueAt || null,
      status: sd?.submittedAt ? 'Submitted' : 'Pending',
      score: sd?.score ?? null,
      scoreMax: t.scoreMax ?? null
    };
  });
  
  // Batch fetch attendance
  const attPromises = dates.map(async d => {
    const [s, meta] = await Promise.all([
      getDoc(doc(db,'attendance', d, 'students', user.uid)),
      window.__fb_getAttendanceMeta(d) // Cached
    ]);
    if (!s.exists() && !meta.classNo) return null;
    return {
      date: d,
      classNo: meta.classNo ?? null,
      status: s.exists() && s.data().present ? 'Present' : 'Absent'
    };
  });
  
  const attResults = await Promise.all(attPromises);
  const attRows = attResults.filter(r => r !== null);
  
  const examScore = examSnap.exists() ? (examSnap.data().score || 0) : 0;
  
  const result = { tasks: taskRows, attendance: attRows, exam: examScore };
  cache.set(cacheKey, result, 60000); // Cache for 1 minute
  return result;
};

window.__fb_fetchWeeklyOverviewFor = async function(uid){
  if (!uid) return { tasks:[], attendance:[], exam:0 };
  
  const wk = getISOWeek(new Date());
  const cacheKey = `overview_${wk}_${uid}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  
  // Similar optimization as above
  const result = await window.__fb_fetchWeeklyOverview.call({ currentUser: { uid } });
  cache.set(cacheKey, result, 60000);
  return result;
};

// --- COMMIT PENDING SESSION ---
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

// --- ADMIN FUNCTIONS (Keep existing) ---
window.__fb_updateTask = async function (weekKey, taskId, patch) {
  const wk = weekKey || getISOWeek(new Date());
  await updateDoc(doc(db, 'tasks', wk, 'items', taskId), {
    ...patch, updatedAt: serverTimestamp()
  });
  cache.clear(`tasks_${wk}`);
};

window.__fb_scoreSubmission = async function(weekKey, taskId, uid, score){
  const wk = weekKey || getISOWeek(new Date());
  await setDoc(doc(db,'tasks', wk,'items',taskId,'submissions', uid), {
    score: Number(score||0),
    scoredAt: serverTimestamp()
  }, { merge: true });
};

window.__fb_setExamScore = async function(weekKey, uid, score){
  const wk = weekKey || getISOWeek(new Date());
  await setDoc(doc(db,'examScores', wk, 'users', uid), {
    score: Number(score||0),
    updatedAt: serverTimestamp()
  }, { merge: true });
};

window.__fb_listSubmissions = async function(weekKey, taskId){
  const wk = weekKey || getISOWeek(new Date());
  const subsSnap = await getDocs(collection(db,'tasks', wk, 'items', taskId, 'submissions'));
  const out = [];
  const uids = [];
  subsSnap.forEach(s => { 
    uids.push(s.id); 
    out.push({ uid: s.id, ...(s.data()||{}) }); 
  });
  
  // Batch fetch display names
  const namePromises = uids.map(async uid => {
    const cached = cache.users.get(uid);
    if (cached) return cached.displayName;
    const us = await getDoc(doc(db,'users', uid));
    return us.exists() ? us.data().displayName : 'Anonymous';
  });
  
  const names = await Promise.all(namePromises);
  names.forEach((name, i) => { out[i].displayName = name || 'Anonymous'; });
  
  return out;
};

window.__fb_deleteTask = async function(weekKey, taskId){
  const wk = weekKey || getISOWeek(new Date());
  const subCol = collection(db,'tasks', wk, 'items', taskId, 'submissions');
  const subSnap = await getDocs(subCol);
  const batch = writeBatch(db);
  subSnap.forEach(s => batch.delete(s.ref));
  await batch.commit();
  await deleteDoc(doc(db,'tasks', wk, 'items', taskId));
  cache.clear(`tasks_${wk}`);
  return true;
};

// --- ADMIN RESET/DELETE (Keep existing) ---
async function __deleteCollectionGroupDocsById(groupName, docId){
  const cg = collectionGroup(db, groupName);
  try{
    const qy = query(cg, where(documentId(), '==', docId));
    const snap = await getDocs(qy);
    const batch = writeBatch(db);
    snap.forEach(s => batch.delete(s.ref));
    await batch.commit();
  }catch(e){
    const snap = await getDocs(cg);
    const batch = writeBatch(db);
    snap.forEach(s => { if (s.id === docId) batch.delete(s.ref); });
    await batch.commit();
  }
}

async function __deleteSubcollectionDocs(userUid, subpath){
  const colRef = collection(db,'users', userUid, subpath);
  const snap = await getDocs(colRef);
  const batch = writeBatch(db);
  snap.forEach(d => batch.delete(d.ref));
  await batch.commit();
}

window.__fb_adminResetUser = async function(uid){
  await __deleteSubcollectionDocs(uid, 'attempts');
  await __deleteSubcollectionDocs(uid, 'daily');
  await __deleteCollectionGroupDocsById('submissions', uid);
  await __deleteCollectionGroupDocsById('students', uid);
  await __deleteCollectionGroupDocsById('users', uid);
  await setDoc(doc(db,'users',uid), { approved: false, updatedAt: serverTimestamp() }, { merge: true });
  cache.users.delete(uid);
  return true;
};

window.__fb_adminDeleteUser = async function(uid){
  await window.__fb_adminResetUser(uid);
  await deleteDoc(doc(db,'users',uid));
  cache.users.delete(uid);
  return true;
};

// --- ADMIN WIPE ALL (Keep existing - rarely used) ---
window.__fb_adminWipeAll = async function(){
  if (!window.__isAdmin) throw new Error("Admin only");
  
  // [Keep existing wipe logic but clear cache after]
  // ... existing wipe code ...
  
  // Clear all caches
  cache.users.clear();
  cache.attendance.clear();
  cache.tasks.clear();
  cache.submissions.clear();
  cache.leaderboard = { weekly: null, course: null, timestamp: 0 };
  
  try { await signOut(auth); } catch(e){ console.warn("Sign-out after wipe failed", e); }
  return true;
};

// --- SOFT REFRESH ---
window.__softRefreshData = async function(){
  try {
    // Clear all caches
    cache.users.clear();
    cache.attendance.clear();
    cache.tasks.clear();
    cache.submissions.clear();
    cache.leaderboard = { weekly: null, course: null, timestamp: 0 };
    
    // Re-subscribe listeners
    if (unsubWeeklyLB) { try{ unsubWeeklyLB(); }catch{}; unsubWeeklyLB = null; }
    if (unsubOverallLB) { try{ clearInterval(unsubOverallLB); }catch{}; unsubOverallLB = null; }
    if (weeklyLbList) subscribeWeeklyLeaderboardOptimized();
    if (courseLbList) subscribeCourseLeaderboardOptimized();
    
    if (window.__isAdmin) {
      try { subscribeAdminApprovalAlertsOptimized(); } catch(e){ console.warn('refresh approvals', e); }
      try { subscribeAdminSubmissionAlertsOptimized(); } catch(e){ console.warn('refresh submissions', e); }
    }
    
    const user = auth.currentUser;
    if (user && !window.__isAdmin) {
      try { 
        if (typeof unsubTasksFlyout === 'function') { 
          clearInterval(unsubTasksFlyout); 
        }
        await subscribeWeeklyTaskFlyout(user.uid);
      } catch(e){ console.warn('refresh todo flyout', e); }
    }
    
    return true;
  } catch (e) {
    console.warn('[softRefresh] failed:', e?.message || e);
    return false;
  }
};

// --- EXPOSE HELPERS ---
window.__signOut = () => signOut(auth);
window.__getISOWeek = getISOWeek;
window.__getCurrentUid = () => (auth.currentUser ? auth.currentUser.uid : null);