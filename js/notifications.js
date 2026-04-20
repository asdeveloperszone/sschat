/**
 * notifications.js — ASChat push notifications via Web Push (no Firebase required)
 *
 * ARCHITECTURE:
 *
 *  Layer 1 — SW postMessage  (app open or backgrounded)
 *    Page posts events directly to sw.js → SW shows OS notification.
 *    Works when: tab is open but screen is off, or browser backgrounded.
 *
 *  Layer 2 — Web Push  (app fully closed)
 *    Frontend subscribes via PushManager → subscription stored on backend.
 *    When a message arrives, chat.js / chats.js calls sendPush() which
 *    hits the Railway backend → backend calls webpush.sendNotification() →
 *    OS wakes the service worker and shows the notification.
 *    Works when: browser closed, phone locked, PWA not running at all.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * ⚠️  BEFORE YOU DEPLOY: fill in the two constants below
 * ──────────────────────────────────────────────────────────────────────────────
 */

// ─── CONFIG — FILL THESE IN ───────────────────────────────────────────────────

/**
 * Your Railway backend URL (no trailing slash).
 * Get it from Railway dashboard after deploying aschat-push-backend.
 * Example: 'https://aschat-push-backend-production-xxxx.up.railway.app'
 */
const PUSH_SERVER_URL = 'https://aschatbackend-production.up.railway.app';

/**
 * ⚠️  SECURITY WARNING: This secret is visible to anyone who views your page source.
 * It provides only minimal protection against spam — not true security.
 *
 * RECOMMENDED APPROACH: Remove this client-side secret entirely and instead
 * authenticate push calls on your Railway backend using the Firebase ID token:
 *   1. On the client, get the token: const token = await auth.currentUser.getIdToken();
 *   2. Send it in the Authorization header: 'Authorization': 'Bearer ' + token
 *   3. On the Railway backend, verify it with Firebase Admin SDK before sending push.
 * This way no shared secret is needed in client code.
 *
 * If you keep the shared-secret approach, rotate this value in both places
 * and ensure your backend checks it on every /api/push request.
 */
const API_SECRET = 'bK6pxrf+7d/SYR2rmMpBNl0dTSd36V/oZLjffd3NC54=';

// ─── SUBSCRIPTION STATE ───────────────────────────────────────────────────────

let _currentSubscription = null;

// ─── PERMISSION + SUBSCRIPTION SETUP ─────────────────────────────────────────

export async function requestNotificationPermission() {
  if (!('Notification' in window)) return false;

  let granted = Notification.permission === 'granted';

  if (!granted && Notification.permission !== 'denied') {
    try {
      granted = (await Notification.requestPermission()) === 'granted';
    } catch (err) {
      console.warn('[Notif] Permission error:', err);
      return false;
    }
  }

  if (granted) await subscribeToPush();
  return granted;
}

export function notificationsGranted() {
  return 'Notification' in window && Notification.permission === 'granted';
}

export async function subscribeToPush() {
  const myID = localStorage.getItem('aschat_userID');
  if (!myID || myID === 'null') return;

  if (PUSH_SERVER_URL === 'YOUR_RAILWAY_URL_HERE') {
    console.warn('[Notif] PUSH_SERVER_URL not configured — background push disabled. See notifications.js.');
    return;
  }

  try {
    const keyRes = await fetch(`${PUSH_SERVER_URL}/api/vapid-public-key`);
    if (!keyRes.ok) throw new Error('Failed to fetch VAPID key: ' + keyRes.status);
    const { key: vapidPublicKey } = await keyRes.json();

    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();

    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly:      true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey)
      });
    }

    _currentSubscription = sub;

    const res = await fetch(`${PUSH_SERVER_URL}/api/subscribe`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ userID: myID, subscription: sub.toJSON() })
    });

    if (!res.ok) throw new Error('Backend subscribe failed: ' + res.status);
    console.log('[Notif] Web Push subscription registered OK');

  } catch (err) {
    console.warn('[Notif] Push subscription failed:', err.message);
  }
}

// Called on logout — unsubscribes this device
export async function unregisterFCMToken() {
  const myID = localStorage.getItem('aschat_userID');
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;

    if (myID && PUSH_SERVER_URL !== 'YOUR_RAILWAY_URL_HERE') {
      await fetch(`${PUSH_SERVER_URL}/api/unsubscribe`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ userID: myID, subscription: sub.toJSON() })
      }).catch(() => {});
    }

    await sub.unsubscribe();
    _currentSubscription = null;
    console.log('[Notif] Unsubscribed from push');
  } catch (err) {
    console.warn('[Notif] Unsubscribe failed:', err.message);
  }
}

// ─── SEND PUSH via backend (Layer 2 — closed app) ────────────────────────────

async function sendPush(payload) {
  if (PUSH_SERVER_URL === 'YOUR_RAILWAY_URL_HERE') return;
  try {
    await fetch(`${PUSH_SERVER_URL}/api/send`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-secret': API_SECRET },
      body:    JSON.stringify(payload)
    });
  } catch (err) {
    console.warn('[Notif] sendPush failed:', err.message);
  }
}

// ─── SW BRIDGE (Layer 1 — backgrounded/open tab) ─────────────────────────────

async function sendToSW(payload) {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    if (reg.active) reg.active.postMessage(payload);
  } catch (err) {
    console.warn('[Notif] SW postMessage failed:', err);
  }
}

// ─── VISIBILITY HELPERS ───────────────────────────────────────────────────────

export function isAppVisible() {
  return document.visibilityState === 'visible';
}

export function isViewingChat(otherID) {
  if (!isAppVisible()) return false;
  const p = new URLSearchParams(window.location.search);
  return window.location.pathname.includes('chat.html') &&
         p.get('id') === String(otherID);
}

// ─── PUBLIC TRIGGER FUNCTIONS ─────────────────────────────────────────────────
// Each fires BOTH layers:
//   sendToSW  → instant, no network, works when tab is backgrounded
//   sendPush  → calls backend → OS delivers even when app is fully closed

export function notifyMessage(senderName, senderID, text, senderPhoto, receiverID) {
  if (!notificationsGranted() || isViewingChat(senderID)) return;
  const base = { senderName, senderID, senderPhoto: senderPhoto || null, timestamp: Date.now() };
  sendToSW({ type: 'NOTIFY_MESSAGE', ...base, text: text || 'New message' });
  if (receiverID) sendPush({ ...base, type: 'message', text: text || 'New message', receiverID });
}

export function notifyPhoto(senderName, senderID, senderPhoto, receiverID) {
  if (!notificationsGranted() || isViewingChat(senderID)) return;
  const base = { senderName, senderID, senderPhoto: senderPhoto || null, timestamp: Date.now() };
  sendToSW({ type: 'NOTIFY_PHOTO', ...base, text: '📷 Photo' });
  if (receiverID) sendPush({ ...base, type: 'photo', receiverID });
}

export function notifyVoice(senderName, senderID, senderPhoto, receiverID) {
  if (!notificationsGranted() || isViewingChat(senderID)) return;
  const base = { senderName, senderID, senderPhoto: senderPhoto || null, timestamp: Date.now() };
  sendToSW({ type: 'NOTIFY_VOICE', ...base, text: '🎤 Voice message' });
  if (receiverID) sendPush({ ...base, type: 'voice', receiverID });
}

export function notifyIncomingCall(callerName, callerID, callType, callerPhoto, receiverID) {
  if (!notificationsGranted()) return;
  const base = { senderName: callerName, senderID: callerID, senderPhoto: callerPhoto || null, callType, timestamp: Date.now() };
  sendToSW({ type: 'NOTIFY_CALL', callerName, callerID, callType, callerPhoto: callerPhoto || null, timestamp: Date.now() });
  if (receiverID) sendPush({ ...base, type: 'call', receiverID });
}

export function dismissCallNotif(callerID) {
  sendToSW({ type: 'DISMISS_CALL', callerID });
}
export { dismissCallNotif as dismissCallNotification };

export function notifyMissedCall(callerName, callerID, callType, callerPhoto, receiverID) {
  if (!notificationsGranted()) return;
  const base = { senderName: callerName, senderID: callerID, senderPhoto: callerPhoto || null, callType, timestamp: Date.now() };
  sendToSW({ type: 'NOTIFY_MISSED_CALL', callerName, callerID, callType, callerPhoto: callerPhoto || null, timestamp: Date.now() });
  if (receiverID) sendPush({ ...base, type: 'missed_call', receiverID });
}

export function notifyReaction(senderName, senderID, emoji, senderPhoto, receiverID) {
  if (!notificationsGranted() || isViewingChat(senderID)) return;
  const base = { senderName, senderID, senderPhoto: senderPhoto || null, emoji, timestamp: Date.now() };
  sendToSW({ type: 'NOTIFY_REACTION', ...base });
  if (receiverID) sendPush({ ...base, type: 'reaction', receiverID });
}

export function clearChatNotifications(otherID) {
  sendToSW({ type: 'CLEAR_NOTIFICATIONS', otherID });
}

// ─── RE-ENGAGEMENT ────────────────────────────────────────────────────────────

export async function registerReengagementSync() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    if ('periodicSync' in reg) {
      const status = await navigator.permissions.query({ name: 'periodic-background-sync' });
      if (status.state === 'granted') {
        await reg.periodicSync.register('aschat-reengagement', { minInterval: 60 * 60 * 1000 });
      }
    }
    if ('sync' in reg) await reg.sync.register('aschat-reengagement');
  } catch (err) {
    console.warn('[Notif] Sync registration failed:', err.message);
  }
}

export function updateSWUnreadState(unreadCounts, contacts) {
  if (!('serviceWorker' in navigator)) return;
  const unreadChats = Object.entries(unreadCounts)
    .filter(([, count]) => count > 0)
    .map(([userID, count]) => {
      const contact = contacts[userID] || {};
      return { id: userID, name: contact.name || 'Someone', photo: contact.photo || null, count };
    });
  const totalUnread = unreadChats.reduce((sum, c) => sum + c.count, 0);
  sendToSW({ type: 'UPDATE_UNREAD_STATE', totalUnread, unreadChats, lastActiveAt: Date.now(), userName: localStorage.getItem('aschat_name') || '' });
}

export function signalUserActive() {
  sendToSW({ type: 'USER_ACTIVE' });
}

// Backwards compat alias (chats.js calls registerFCMToken)
export async function registerFCMToken() { await subscribeToPush(); }

// ─── UTILITY ─────────────────────────────────────────────────────────────────

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw     = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}
