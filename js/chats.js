import { notifyMessage, notifyPhoto, notifyVoice, clearChatNotifications, unregisterFCMToken, updateSWUnreadState, signalUserActive, registerReengagementSync, requestNotificationPermission, registerFCMToken, isViewingChat } from './notifications.js';
import { auth, db } from './firebase-config.js';
import { getLocalMessages, saveTextMessage, getChatListCache, warmChatListCache, updateChatListCache } from './storage.js';
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-auth.js";
import { ref, get, onValue } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-database.js";

// FIX (XSS): Escape user-supplied strings before inserting into innerHTML.
function escapeHTML(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

let myID = null;

onAuthStateChanged(auth, async (user) => {
  if (!user) { window.location.href = 'auth.html'; return; }

  myID = localStorage.getItem('aschat_userID');

  // Warm the chat-list cache before first render so sort/preview is instant
  warmChatListCache();

  if (myID && myID !== 'null') {
    renderChatList();
  }

  initChatsOfflineDetection();

  if (!myID || myID === 'null') {
    await loadMyID(user);
  } else {
    const el = document.getElementById('myIDDisplay');
    if (el) el.textContent = myID + '@as';
  }

  if (user.photoURL && !localStorage.getItem('aschat_photo')) {
    localStorage.setItem('aschat_photo', user.photoURL);
  }

  signalUserActive();
  registerReengagementSync();

  // Re-request permission and refresh FCM token on every chats load.
  // This ensures returning users (who bypass auth.html) still get push notifications.
  if (Notification.permission === 'granted') {
    registerFCMToken(); // silently refresh token
  } else if (Notification.permission !== 'denied') {
    requestNotificationPermission(); // ask if not yet decided
  }

  // FIX: only listen to chats the user is already a contact of —
  // avoid downloading the entire users table.
  listenForKnownChats();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    signalUserActive();
    pushUnreadStateToSW();
  }
});

function pushUnreadStateToSW() {
  const unreadCounts = JSON.parse(localStorage.getItem('aschat_unread')   || '{}');
  const contacts     = JSON.parse(localStorage.getItem('aschat_contacts') || '{}');
  updateSWUnreadState(unreadCounts, contacts);
}

async function loadMyID(user) {
  try {
    const snapshot = await get(ref(db, 'userMap/' + user.uid));
    if (snapshot.exists()) {
      myID = snapshot.val();
      const userSnap = await get(ref(db, 'users/' + myID));
      if (userSnap.exists()) {
        localStorage.setItem('aschat_userID', myID);
        localStorage.setItem('aschat_name', userSnap.val().displayName);
        if (userSnap.val().photoURL) localStorage.setItem('aschat_photo', userSnap.val().photoURL);
      }
    }
  } catch (err) { console.error('Error loading ID:', err); }
  const el = document.getElementById('myIDDisplay');
  if (el) el.textContent = myID ? myID + '@as' : 'Error';
}

const subscribedChats    = new Set();

// Throttle: only fire one push notification per sender per 3 seconds.
// Prevents spamming the backend when B comes online and finds 5+ unread messages.
const _lastPushTime = {};
function _shouldPush(otherID) {
  const now = Date.now();
  if (!_lastPushTime[otherID] || now - _lastPushTime[otherID] > 3000) {
    _lastPushTime[otherID] = now;
    return true;
  }
  return false;
}

// FIX: Only subscribe to chats with existing contacts — not all users in the DB.
// New contacts are added via searchUser() and their chat is subscribed immediately.
function listenForKnownChats() {
  if (!myID) return;
  const contacts = JSON.parse(localStorage.getItem('aschat_contacts') || '{}');
  Object.values(contacts).forEach(contact => {
    const chatKey = getChatKey(myID, contact.userID);
    if (subscribedChats.has(chatKey)) return;
    subscribedChats.add(chatKey);
    listenToChatMessages(chatKey, contact.userID, contact.name, contact.photo || null);
  });

  // FEATURE: WhatsApp-style auto-chat creation.
  // Listen to messages/* for any chatKey that contains myID.
  // Firebase DB rules already restrict reads to chatKeys containing myID,
  // so onValue on messages/ will only surface chats the user is a party to.
  // When a message arrives from a sender B doesn't have as a contact yet,
  // we look up B's profile, save them as a contact, and show the chat.
  listenForIncomingFromStrangers();
}

// FEATURE (WhatsApp-style auto-chat): two complementary listeners so B always
// sees a chat from A the moment A sends the first message.
//
// Path 1 — inbox/myID  (FAST, O(1) read)
//   chat.js writes inbox/receiverID/senderID when any message is sent.
//   This is a tiny node — wakes up B instantly without scanning all messages.
//
// Path 2 — messages/ root  (RELIABLE fallback, catches old data on first login)
//   Firebase rules restrict the read to chatKeys containing myID, so only
//   this user's chats are returned — not the whole database.
function listenForIncomingFromStrangers() {
  if (!myID) return;

  // ── PATH 1: inbox listener (fires in real-time when A sends) ──────────────
  onValue(ref(db, 'inbox/' + myID), async (snapshot) => {
    if (!snapshot.exists()) return;
    const senderIDs = Object.keys(snapshot.val() || {});
    for (const senderID of senderIDs) {
      await _autoAddContact(senderID);
    }
  });

  // ── PATH 2: messages root scan (catches history on login / missed inbox) ──
  onValue(ref(db, 'messages'), async (snapshot) => {
    if (!snapshot.exists()) return;
    const newDiscoveries = [];

    snapshot.forEach(chatSnap => {
      const chatKey = chatSnap.key;
      if (!chatKey.includes(myID)) return;
      if (subscribedChats.has(chatKey)) return;

      const parts = chatKey.split('_');
      if (parts.length !== 2) return;
      const otherUserID = parts[0] === myID ? parts[1] : parts[0];

      const msgs = chatSnap.val();
      if (!msgs) return;
      const hasIncoming = Object.values(msgs).some(m => m.receiverID === myID);
      if (!hasIncoming) return;

      newDiscoveries.push(otherUserID);
    });

    for (const otherUserID of newDiscoveries) {
      await _autoAddContact(otherUserID);
    }
  });
}

// Helper: look up a user by ID, save as contact if new, subscribe + render.
async function _autoAddContact(otherUserID) {
  if (!otherUserID || otherUserID === myID) return;
  const contacts = JSON.parse(localStorage.getItem('aschat_contacts') || '{}');
  if (contacts[otherUserID] && subscribedChats.has(getChatKey(myID, otherUserID))) return;

  try {
    const snap = await get(ref(db, 'users/' + otherUserID));
    if (!snap.exists()) return;
    const userData = snap.val();
    const contact = {
      name:   userData.displayName || ('User ' + otherUserID),
      userID: otherUserID,
      photo:  userData.photoURL || null
    };
    const latest = JSON.parse(localStorage.getItem('aschat_contacts') || '{}');
    if (!latest[otherUserID]) {
      latest[otherUserID] = contact;
      localStorage.setItem('aschat_contacts', JSON.stringify(latest));
    }
    subscribeToNewContact(contact);
    renderChatList();
  } catch (err) {
    console.warn('[chats] Auto-add contact failed for', otherUserID, err.message);
  }
}

// Called after a new contact is added via searchUser so their chat is live immediately
function subscribeToNewContact(contact) {
  const chatKey = getChatKey(myID, contact.userID);
  if (subscribedChats.has(chatKey)) return;
  subscribedChats.add(chatKey);
  listenToChatMessages(chatKey, contact.userID, contact.name, contact.photo || null);
}

function listenToChatMessages(chatKey, otherID, otherName, otherPhoto) {
  // Record when this listener was attached — used to decide which messages
  // are "new since I came online" vs old history that should not notify.
  // We use a 30-second lookback so messages sent just before B opened the
  // app (while B was offline) still trigger a notification.
  const listenStartTime = Date.now() - 30_000;

  onValue(ref(db, 'messages/' + chatKey), (snapshot) => {
    if (!snapshot.exists()) return;

    const messages    = snapshot.val();
    const msgArray    = Object.entries(messages).map(([key, val]) => ({ id: key, ...val }));
    const relevant    = msgArray.filter(m => m.senderID === myID || m.receiverID === myID);
    if (relevant.length === 0) return;

    let contacts = JSON.parse(localStorage.getItem('aschat_contacts') || '{}');
    if (!contacts[otherID]) {
      contacts[otherID] = { name: otherName, userID: otherID, photo: otherPhoto };
      localStorage.setItem('aschat_contacts', JSON.stringify(contacts));
    } else {
      // Always update name and photo so profile changes propagate to contacts
      let changed = false;
      if (otherName && contacts[otherID].name !== otherName) {
        contacts[otherID].name = otherName; changed = true;
      }
      if (otherPhoto && contacts[otherID].photo !== otherPhoto) {
        contacts[otherID].photo = otherPhoto; changed = true;
      }
      if (changed) localStorage.setItem('aschat_contacts', JSON.stringify(contacts));
    }

    const unread = relevant.filter(m => m.receiverID === myID && m.status !== 'seen').length;
    let unreadCounts = JSON.parse(localStorage.getItem('aschat_unread') || '{}');
    unreadCounts[otherID] = unread;
    localStorage.setItem('aschat_unread', JSON.stringify(unreadCounts));

    let localMessages = getLocalMessages(chatKey);
    const localIDs    = new Set(localMessages.map(m => m.id));
    let changed       = false;

    relevant.forEach(msg => {
      if (!localIDs.has(msg.id)) {
        localMessages.push({
          id:        msg.id,
          text:      msg.text || null,
          // FIX: don't store raw base64 photo/audio in localStorage from chats.js —
          // only save a flag; the binary lives in IndexedDB via chat.js
          audio:     null,
          photo:     null,
          hasMedia:  msg.msgType === 'photo' || msg.msgType === 'audio',
          msgType:   msg.msgType || 'text',
          senderID:  msg.senderID,
          receiverID: msg.receiverID || null,
          status:    msg.status || 'sent',
          timestamp: msg.timestamp || Date.now(),
          type:      msg.senderID === myID ? 'sent' : 'received'
        });
        changed = true;

        // Notify if:
        // 1. Message is from the other person (not me)
        // 2. Not a call message
        // 3. Message timestamp is recent enough — covers:
        //    - Live messages (A sends while B is online)
        //    - Offline messages (A sent while B was away, B just came online)
        // 4. User is not currently viewing this chat
        const msgTime = msg.timestamp || 0;
        const isRecent = msgTime >= listenStartTime;
        if (isRecent && msg.senderID !== myID && msg.msgType !== 'call') {
          const photo = otherPhoto || null;
          if (!isViewingChat(otherID) && _shouldPush(otherID)) {
            if (msg.msgType === 'photo')      notifyPhoto(otherName, otherID, photo, myID);
            else if (msg.msgType === 'audio') notifyVoice(otherName, otherID, photo, myID);
            else                              notifyMessage(otherName, otherID, msg.text || '', photo, myID);
          }
        }
      }
    });

    if (changed) localMessages.forEach(m => saveTextMessage(chatKey, m));

    renderChatList();
  });
}

function renderChatList() {
  const contacts     = JSON.parse(localStorage.getItem('aschat_contacts') || '{}');
  const unreadCounts = JSON.parse(localStorage.getItem('aschat_unread')   || '{}');
  const chatsList    = document.getElementById('chatsList');
  const cache        = getChatListCache();

  updateSWUnreadState(unreadCounts, contacts);

  if (Object.keys(contacts).length === 0) {
    chatsList.innerHTML = '<p class="no-chats"><i class="fa-regular fa-comment-dots"></i><br/>No chats yet.<br/>Tap the edit icon above to start a conversation.</p>';
    return;
  }

  // Use cache for fast sort — fallback to 0 for contacts with no messages yet
  const sorted = Object.values(contacts).sort((a, b) => {
    const aTime = cache[getChatKey(myID, a.userID)]?.lastTimestamp || 0;
    const bTime = cache[getChatKey(myID, b.userID)]?.lastTimestamp || 0;
    return bTime - aTime;
  });

  chatsList.innerHTML = '';

  sorted.forEach(contact => {
    const chatKey  = getChatKey(myID, contact.userID);
    // Use cache for preview — only read full messages if cache misses
    const cached   = cache[chatKey];
    const lastMsg  = cached ? cached.lastMsg : null;
    const unread   = unreadCounts[contact.userID] || 0;

    // FIX (XSS): escape all user-supplied strings before injecting into innerHTML
    const safeName  = escapeHTML(contact.name);
    const safePhoto = contact.photo ? escapeHTML(contact.photo) : '';

    let lastMsgText = 'Tap to chat';
    if (lastMsg) {
      if (lastMsg.msgType === 'photo')      lastMsgText = '<i class="fa-solid fa-image" style="font-size:12px;margin-right:3px;"></i>Photo';
      else if (lastMsg.msgType === 'audio') lastMsgText = '<i class="fa-solid fa-microphone" style="font-size:12px;margin-right:3px;"></i>Voice message';
      else if (lastMsg.msgType === 'call')  lastMsgText = '<i class="fa-solid fa-phone" style="font-size:12px;margin-right:3px;"></i>' + escapeHTML(lastMsg.text || 'Call');
      else                                  lastMsgText = escapeHTML(lastMsg.text || 'Tap to chat');
    }

    const lastTime = lastMsg ? formatTime(lastMsg.timestamp) : '';
    const avatarHTML = safePhoto
      ? `<img src="${safePhoto}" class="chat-avatar-img" />`
      : `<div class="chat-avatar">${escapeHTML(contact.name.charAt(0).toUpperCase())}</div>`;

    const item = document.createElement('div');
    item.className = 'chat-item';
    item.innerHTML = `
      ${avatarHTML}
      <div class="chat-info">
        <h4>${safeName}</h4>
        <p class="${unread > 0 ? 'unread-preview' : ''}">${lastMsgText}</p>
      </div>
      <div class="chat-item-right">
        <span class="chat-time ${unread > 0 ? 'unread-time' : ''}">${lastTime}</span>
        ${unread > 0 ? `<span class="chat-unread">${unread}</span>` : ''}
      </div>`;
    item.onclick = () => {
      let uc = JSON.parse(localStorage.getItem('aschat_unread') || '{}');
      uc[contact.userID] = 0;
      localStorage.setItem('aschat_unread', JSON.stringify(uc));
      clearChatNotifications(contact.userID);
      window.location.href = `chat.html?id=${contact.userID}&name=${encodeURIComponent(contact.name)}`;
    };
    chatsList.appendChild(item);
  });
}

function formatTime(timestamp) {
  const d = new Date(timestamp), n = new Date();
  if (d.toDateString() === n.toDateString())
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { day: '2-digit', month: '2-digit' });
}

function getChatKey(id1, id2) { return [id1, id2].sort().join('_'); }

window.copyID = function () {
  const id = localStorage.getItem('aschat_userID');
  if (!id || id === 'null') { alert('ID not loaded yet.'); return; }
  navigator.clipboard.writeText(id + '@as').then(() => alert('Your ID copied!'));
};

window.showAddUser = function () { document.getElementById('addUserModal').style.display = 'flex'; };

window.hideAddUser = function () {
  document.getElementById('addUserModal').style.display = 'none';
  document.getElementById('searchID').value = '';
  document.getElementById('searchError').textContent = '';
};

window.searchUser = async function () {
  const raw      = document.getElementById('searchID').value.trim();
  const errorMsg = document.getElementById('searchError');

  // FIX: strip @as suffix if user pastes their full displayed ID
  const input = raw.replace(/@as$/i, '').trim();

  if (input.length !== 9 || isNaN(input)) { errorMsg.textContent = 'Please enter a valid 9-digit ID.'; return; }
  if (input === myID) { errorMsg.textContent = 'You cannot chat with yourself.'; return; }
  try {
    const snapshot = await get(ref(db, 'users/' + input));
    if (snapshot.exists()) {
      const userData = snapshot.val();
      let contacts = JSON.parse(localStorage.getItem('aschat_contacts') || '{}');
      contacts[input] = { name: userData.displayName, userID: input, photo: userData.photoURL || null };
      localStorage.setItem('aschat_contacts', JSON.stringify(contacts));

      // FIX: subscribe the new chat immediately so messages are live
      subscribeToNewContact(contacts[input]);

      // FIX: render chat list right away so the new contact appears even
      // if the user navigates back from chat.html without sending a message
      renderChatList();

      hideAddUser();
      window.location.href = `chat.html?id=${input}&name=${encodeURIComponent(userData.displayName)}`;
    } else {
      errorMsg.textContent = 'User not found. Check the ID and try again.';
    }
  } catch (err) { errorMsg.textContent = 'Something went wrong. Try again.'; }
};

function initChatsOfflineDetection() {
  updateChatsOfflineBar();
  window.addEventListener('online',  () => updateChatsOfflineBar());
  window.addEventListener('offline', () => updateChatsOfflineBar());
}

function updateChatsOfflineBar() {
  let bar = document.getElementById('chatsOfflineBar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'chatsOfflineBar'; bar.className = 'offline-bar';
    const banner = document.querySelector('.my-id-banner');
    if (banner && banner.nextSibling) banner.parentNode.insertBefore(bar, banner.nextSibling);
  }
  if (navigator.onLine) { bar.classList.remove('visible'); }
  else { bar.innerHTML = '<i class="fa-solid fa-wifi-slash"></i> You are offline — showing cached chats'; bar.classList.add('visible'); }
}

window.logoutUser = async function () {
  if (confirm('Are you sure you want to logout?')) {
    await unregisterFCMToken();
    await signOut(auth);
    localStorage.clear();
    window.location.href = 'auth.html';
  }
};
