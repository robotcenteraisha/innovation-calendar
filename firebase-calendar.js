import {initializeApp} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {getAuth,signInAnonymously,onAuthStateChanged} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {getFirestore,collection,doc,onSnapshot,runTransaction} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
const ui=window.calendarUI,config=window.FIREBASE_CONFIG;
if(!config||!config.apiKey||config.apiKey.includes('PASTE_'))ui.toast('أكملي ملف firebase-config.js');
else{
 const app=initializeApp(config),auth=getAuth(app),db=getFirestore(app),rooms=['قاعة البرمجة','قاعة نماء','قاعة الابتكار'];
 const eventRef=id=>doc(db,'events',id),isRoom=e=>e&&rooms.includes(e.place);
 const days=e=>{if(!e||!e.date)return[];const end=e.endDate&&e.endDate>=e.date?e.endDate:e.date,out=[];let d=new Date(e.date+'T12:00:00'),last=new Date(end+'T12:00:00');for(let i=0;d<=last&&i<370;i++,d.setDate(d.getDate()+1)){if(!e.endDate||![5,6].includes(d.getDay()))out.push(d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'))}return out};
 const locks=e=>isRoom(e)?days(e).map(date=>({date,ref:doc(db,'roomLocks',date+'_'+rooms.indexOf(e.place))})):[];
 window.calendarCloud={
 async upsert(e,old){const uid=auth.currentUser?.uid;if(!uid)throw Error('لا يوجد اتصال');
 await runTransaction(db,async tx=>{
 const ref=eventRef(e.id),existing=await tx.get(ref);
 if(existing.exists()&&existing.data().ownerUid!==uid)throw Error('لا يمكن تعديل نشاط من جهاز آخر');
 if(old&&!existing.exists())throw Error('النشاط لم يعد موجودًا');
 const prev=existing.exists()?existing.data():null,newLocks=locks(e),oldLocks=locks(prev);
 const all=new Map([...newLocks,...oldLocks].map(x=>[x.ref.path,x]));
 const snapshots=new Map();for(const [path,item] of all)snapshots.set(path,await tx.get(item.ref));
 const conflicts=newLocks.filter(x=>{const snap=snapshots.get(x.ref.path);return snap.exists()&&snap.data().eventId!==e.id}).map(x=>x.date);
 if(conflicts.length)throw Error('القاعة «'+e.place+'» محجوزة مسبقًا في: '+conflicts.join('، '));
 const newPaths=new Set(newLocks.map(x=>x.ref.path));
 for(const item of oldLocks){const snap=snapshots.get(item.ref.path);if(!newPaths.has(item.ref.path)&&snap.exists()&&snap.data().eventId===e.id)tx.delete(item.ref)}
 for(const item of newLocks){const snap=snapshots.get(item.ref.path);if(!snap.exists())tx.set(item.ref,{eventId:e.id,ownerUid:uid})}
 tx.set(ref,{...e,ownerUid:uid});
 });},
 async remove(e){const uid=auth.currentUser?.uid;if(!uid)throw Error('لا يوجد اتصال');
 await runTransaction(db,async tx=>{const ref=eventRef(e.id),snap=await tx.get(ref);if(!snap.exists())return;
 if(snap.data().ownerUid!==uid)throw Error('لا يمكن حذف نشاط من جهاز آخر');
 const oldLocks=locks(snap.data()),lockSnaps=[];for(const item of oldLocks)lockSnaps.push(await tx.get(item.ref));
 oldLocks.forEach((item,i)=>{if(lockSnaps[i].exists()&&lockSnaps[i].data().eventId===e.id)tx.delete(item.ref)});tx.delete(ref);
 });}
 };
 onAuthStateChanged(auth,user=>{if(!user){ui.setUser(null);signInAnonymously(auth).catch(e=>ui.toast('تعذر الاتصال: '+e.message));return}ui.setUser(user.uid);onSnapshot(collection(db,'events'),snapshot=>ui.setEntries(snapshot.docs.map(d=>({id:d.id,...d.data()}))),e=>ui.toast('خطأ في تحميل الأنشطة: '+e.message));});
}
