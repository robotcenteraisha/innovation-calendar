
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';

import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';

import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  collection,
  doc,
  onSnapshot,
  runTransaction
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

const ui = window.calendarUI;
const config = window.FIREBASE_CONFIG;

if (!config || !config.apiKey || config.apiKey.includes('PASTE_')) {
  ui.toast('يرجى التحقق من إعدادات Firebase');
  ui.setUser(null);
} else {
  const app = initializeApp(config);
  const auth = getAuth(app);

  // تفعيل التخزين المحلي عند توفره في المتصفح.
  // في المتصفحات غير المدعومة نستخدم التخزين في الذاكرة.
  let db;

  try {
    db = initializeFirestore(app, {
      localCache: persistentLocalCache({
        tabManager: persistentMultipleTabManager()
      })
    });
  } catch (error) {
    console.warn('تعذر تفعيل التخزين المحلي:', error);
    db = initializeFirestore(app, {});
  }

  const rooms = [
    'قاعة البرمجة',
    'قاعة نماء',
    'قاعة الابتكار'
  ];

  const eventRef = id => doc(db, 'events', id);

  const lockRef = event => doc(
    db,
    'roomLocks',
    event.date + '_' + rooms.indexOf(event.place)
  );

  const isRoom = event =>
    !!event && rooms.includes(event.place);

  let unsubscribeEvents = null;
  let retryTimer = null;
  let retryCount = 0;
  let signedInUid = '';
  let hasReceivedSnapshot = false;

  function updateNotice(message) {
    const notice = document.getElementById('cloudNotice');
    if (notice) notice.textContent = message;
  }

  function updateStatus(message) {
    const status = document.getElementById('authStatus');
    if (status) status.textContent = message;
  }

  function clearRetry() {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  function scheduleRetry() {
    if (retryTimer || !auth.currentUser) return;

    const delay = Math.min(
      30000,
      2000 * Math.pow(2, Math.min(retryCount, 4))
    );

    retryCount++;

    retryTimer = setTimeout(() => {
      retryTimer = null;

      if (auth.currentUser && navigator.onLine) {
        startListening();
      } else {
        scheduleRetry();
      }
    }, delay);
  }

  function startListening() {
    if (!auth.currentUser) return;

    clearRetry();

    if (unsubscribeEvents) {
      unsubscribeEvents();
      unsubscribeEvents = null;
    }

    updateStatus('جاري المزامنة...');
    updateNotice('جاري تحميل أحدث الأنشطة من Firebase...');

    unsubscribeEvents = onSnapshot(
      collection(db, 'events'),

      { includeMetadataChanges: true },

      snapshot => {
        hasReceivedSnapshot = true;

        const items = snapshot.docs.map(item => ({
          id: item.id,
          ...item.data()
        }));

        ui.setEntries(items);

        if (snapshot.metadata.fromCache) {
          updateStatus('بيانات محفوظة مؤقتًا');

          updateNotice(
            'يتم عرض البيانات المحفوظة على هذا الجهاز. ' +
            'جاري التحقق من أحدث التعديلات...'
          );
        } else {
          retryCount = 0;
          clearRetry();

          updateStatus('متصل ومحدّث');

          updateNotice(
            'التقويم مشترك ومحدّث. ' +
            'تظهر الأنشطة على جميع الأجهزة المتصلة.'
          );
        }
      },

      error => {
        console.error('Firestore error:', error);

        updateStatus('تعذر تحديث البيانات');

        updateNotice(
          'تعذر تحميل أحدث الأنشطة. ' +
          'سيحاول الموقع إعادة الاتصال تلقائيًا.'
        );

        if (
          error.code === 'permission-denied' ||
          error.code === 'failed-precondition' ||
          error.code === 'invalid-argument'
        ) {
          ui.toast('يرجى مراجعة إعدادات Firestore: ' + error.message);
          return;
        }

        scheduleRetry();
      }
    );
  }

  // الحفاظ على وظائف الحفظ والحذف وحجوزات القاعات.
  window.calendarCloud = {

    async upsert(event, oldEvent) {
      const uid = auth.currentUser?.uid;

      if (!uid) {
        throw Error('لا يوجد اتصال بالمستخدم');
      }

      await runTransaction(db, async transaction => {
        const ref = eventRef(event.id);
        const existing = await transaction.get(ref);

        if (
          existing.exists() &&
          existing.data().ownerUid !== uid
        ) {
          throw Error('لا يمكن تعديل نشاط من جهاز آخر');
        }

        if (oldEvent && !existing.exists()) {
          throw Error('النشاط لم يعد موجودًا');
        }

        const previous = existing.exists()
          ? existing.data()
          : null;

        const newLock = isRoom(event)
          ? lockRef(event)
          : null;

        const oldLock = isRoom(previous)
          ? lockRef(previous)
          : null;

        const newLockSnapshot = newLock
          ? await transaction.get(newLock)
          : null;

        const oldLockSnapshot =
          oldLock &&
          (!newLock || oldLock.path !== newLock.path)
            ? await transaction.get(oldLock)
            : null;

        if (
          newLockSnapshot?.exists() &&
          newLockSnapshot.data().eventId !== event.id
        ) {
          throw Error('القاعة محجوزة بالفعل في هذا اليوم');
        }

        if (
          oldLock &&
          (!newLock || oldLock.path !== newLock.path) &&
          oldLockSnapshot?.data().eventId === event.id
        ) {
          transaction.delete(oldLock);
        }

        if (newLock && !newLockSnapshot.exists()) {
          transaction.set(newLock, {
            eventId: event.id,
            ownerUid: uid
          });
        }

        transaction.set(ref, {
          ...event,
          ownerUid: uid
        });
      });
    },

    async remove(event) {
      const uid = auth.currentUser?.uid;

      if (!uid) {
        throw Error('لا يوجد اتصال بالمستخدم');
      }

      await runTransaction(db, async transaction => {
        const ref = eventRef(event.id);
        const snapshot = await transaction.get(ref);

        if (!snapshot.exists()) return;

        if (snapshot.data().ownerUid !== uid) {
          throw Error('لا يمكن حذف نشاط من جهاز آخر');
        }

        const previous = snapshot.data();

        const lock = isRoom(previous)
          ? lockRef(previous)
          : null;

        const lockSnapshot = lock
          ? await transaction.get(lock)
          : null;

        if (
          lockSnapshot?.exists() &&
          lockSnapshot.data().eventId === event.id
        ) {
          transaction.delete(lock);
        }

        transaction.delete(ref);
      });
    }
  };

  // تسجيل الدخول المجهول تلقائيًا دون حساب للموظف.
  onAuthStateChanged(auth, async user => {
    if (!user) {
      signedInUid = '';
      hasReceivedSnapshot = false;
      clearRetry();

      if (unsubscribeEvents) {
        unsubscribeEvents();
        unsubscribeEvents = null;
      }

      ui.setUser(null);
      updateStatus('جاري الاتصال...');
      updateNotice('جاري الاتصال بالتقويم المشترك...');

      try {
        await signInAnonymously(auth);
      } catch (error) {
        console.error('Authentication error:', error);

        updateStatus('تعذر الاتصال');

        updateNotice(
          'تعذر تسجيل الاتصال بـ Firebase. ' +
          'يرجى التحقق من الإنترنت وإعدادات المشروع.'
        );

        ui.toast('تعذر الاتصال: ' + error.message);
      }

      return;
    }

    if (signedInUid === user.uid && unsubscribeEvents) {
      return;
    }

    signedInUid = user.uid;

    ui.setUser(user.uid);
    startListening();
  });

  // إعادة المحاولة عند عودة الإنترنت.
  window.addEventListener('online', () => {
    if (!auth.currentUser) {
      signInAnonymously(auth).catch(error => {
        console.error('Reconnect error:', error);
      });
      return;
    }

    if (!unsubscribeEvents) {
      startListening();
    }
  });

  window.addEventListener('offline', () => {
    updateStatus('غير متصل بالإنترنت');

    updateNotice(
      'الاتصال بالإنترنت غير متوفر. ' +
      'قد تظهر بيانات محفوظة من زيارة سابقة.'
    );
  });
}
