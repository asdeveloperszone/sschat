import { notifyReaction, notifyMessage, notifyPhoto, notifyVoice, clearChatNotifications, signalUserActive } from './notifications.js';
import { auth, db } from './firebase-config.js';
import {
  saveTextMessage, saveMedia, getMedia, deleteMedia,
  getLocalMessages, setLocalMessages, updateLocalMessageStatus,
  enqueueMessage, getQueue, removeFromQueue,
  updateChatListCache
} from './storage.js';
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-auth.js";
import { ref, push, onChildAdded, get, update, onValue, remove } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-database.js";
import {
  initCall,
  startCall as _startCall,
  acceptCall as _acceptCall,
  declineCall as _declineCall,
  endCall as _endCall,
  toggleMute as _toggleMute,
  toggleSpeaker as _toggleSpeaker,
  toggleCamera as _toggleCamera,
  flipCamera as _flipCamera,
  setOnline
} from './call.js';

const params = new URLSearchParams(window.location.search);
const otherID = params.get('id');
const otherName = params.get('name') || 'Unknown';

// BUG FIX: guard against missing required URL params — redirect instead of crashing
if (!otherID) { window.location.href = 'chats.html'; throw new Error('Missing chat id'); }

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
let myUID = null;
let chatKey = null;
let renderedIDs = new Set();
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let isCancellingRecording = false; // FIX: cancel flag for onstop race
let activeMessageID = null;
let activeMessageSenderID = null;
let replyTo = null;
let isOnline = navigator.onLine;
let forwardMessageData = null;
let analyserNode = null;
let animationFrameID = null;
const messageDataStore = {};
const speeds = [1, 1.5, 2];
const audioPlayers = {};
const audioSpeeds = {};
let waveformData = [];
let waveformBars = [];

// FIX (media duplicate): timestamps of in-flight media pushes.
// onChildAdded skips messages whose timestamp is in this set and senderID===myID.
const pendingPushTimestamps = new Set();

onAuthStateChanged(auth, async (user) => {
  if (!user) { window.location.href = 'auth.html'; return; }

  myUID = user.uid;
  myID = localStorage.getItem('aschat_userID');

  if (!myID || myID === 'null') {
    try {
      const snapshot = await get(ref(db, 'userMap/' + myUID));
      if (snapshot.exists()) {
        myID = snapshot.val();
        localStorage.setItem('aschat_userID', myID);
      } else {
        window.location.href = 'auth.html'; return;
      }
    } catch (err) {
      window.location.href = 'auth.html'; return;
    }
  }

  chatKey = getChatKey(myID, otherID);
  await setupHeader();
  loadMessagesFromLocal();
  syncFromFirebase();
  listenForNewMessages();
  markMessagesAsSeen();
  listenToTyping();
  setupTypingEmitter();
  initOfflineDetection();
  listenToStatusUpdates();
  listenToPresence();
  clearChatNotifications(otherID);
  signalUserActive();

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      signalUserActive();
      // BUG FIX: when user returns to the chat (e.g. switches tabs or unlocks
      // phone), re-run markMessagesAsSeen so any messages received while the
      // tab was hidden get marked seen and the unread badge in chats.js clears.
      markMessagesAsSeen();
    }
  });

  setOnline(myID);
  initCall(myID, otherID, otherName, () => {});

  const autoCallParam = new URLSearchParams(window.location.search).get('autocall');
  if (autoCallParam === 'accept') setTimeout(() => _acceptCall(), 2000);
});

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function getChatKey(id1, id2) { return [id1, id2].sort().join('_'); }

function formatTime(ts) {
  const d = new Date(ts), n = new Date();
  if (d.toDateString() === n.toDateString())
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { day: '2-digit', month: '2-digit' });
}

function getTicks(status) {
  if (status === 'sending') return `<span class="msg-ticks sending"><i class="fa-solid fa-clock"></i></span>`;
  if (status === 'seen')    return `<span class="msg-ticks seen">✓✓</span>`;
  if (status === 'delivered') return `<span class="msg-ticks delivered">✓✓</span>`;
  return `<span class="msg-ticks">✓</span>`;
}

function scrollToBottom() {
  const c = document.getElementById('messagesContainer');
  if (c) c.scrollTop = c.scrollHeight;
}

// ─── HEADER ──────────────────────────────────────────────────────────────────

async function setupHeader() {
  document.getElementById('chatName').textContent = otherName;
  const avatar = document.getElementById('chatAvatar');
  const contacts = JSON.parse(localStorage.getItem('aschat_contacts') || '{}');
  const contact = contacts[otherID];

  if (contact && contact.photo) {
    avatar.innerHTML = `<img src="${contact.photo}" class="chat-avatar-small-img" />`;
  } else {
    avatar.textContent = otherName.charAt(0).toUpperCase();
    try {
      const snap = await get(ref(db, 'users/' + otherID));
      if (snap.exists() && snap.val().photoURL) {
        avatar.innerHTML = `<img src="${snap.val().photoURL}" class="chat-avatar-small-img" />`;
        if (contact) {
          contact.photo = snap.val().photoURL;
          localStorage.setItem('aschat_contacts', JSON.stringify(contacts));
        }
      }
    } catch (err) { console.error('Avatar error:', err); }
  }
}

// ─── PRESENCE ────────────────────────────────────────────────────────────────

function listenToPresence() {
  onValue(ref(db, 'presence/' + otherID), (snap) => {
    const el = document.getElementById('chatStatus');
    if (!el) return;
    if (snap.exists() && snap.val() === 'online') {
      el.textContent = 'online'; el.style.color = '#22C55E';
    } else {
      el.textContent = 'offline'; el.style.color = 'var(--text-muted)';
    }
  });
}

// ─── CALL PROXIES ────────────────────────────────────────────────────────────

window.openOtherProfile = function () {
  const back = encodeURIComponent('chat.html?id=' + otherID + '&name=' + encodeURIComponent(otherName));
  window.location.href = `other-profile.html?id=${otherID}&back=${back}`;
};
window.startCall   = (t) => _startCall(t);
window.acceptCall  = ()  => _acceptCall();
window.declineCall = ()  => _declineCall();
window.endCall     = ()  => _endCall();
window.toggleMute  = ()  => _toggleMute();
window.toggleSpeaker = () => _toggleSpeaker();
window.toggleCamera  = () => _toggleCamera();
window.flipCamera    = () => _flipCamera();

// ─── LOAD FROM LOCAL ─────────────────────────────────────────────────────────

async function loadMessagesFromLocal() {
  const deleted  = JSON.parse(localStorage.getItem('deleted_forme_' + chatKey) || '[]');
  const messages = getLocalMessages(chatKey);

  for (const msg of messages) {
    if (deleted.includes(msg.id) || renderedIDs.has(msg.id)) continue;
    if (msg.hasMedia) {
      const media = await getMedia(msg.id);
      if (media) {
        if (msg.msgType === 'photo') msg.photo = media.data;
        if (msg.msgType === 'audio') msg.audio = media.data;
      }
    }
    renderedIDs.add(msg.id);
    renderMessage(msg);
  }
  scrollToBottom();
}

// ─── SYNC FROM FIREBASE ──────────────────────────────────────────────────────

async function syncFromFirebase() {
  try {
    const snapshot = await get(ref(db, 'messages/' + chatKey));
    if (!snapshot.exists()) return;

    const data    = snapshot.val();
    const deleted = JSON.parse(localStorage.getItem('deleted_forme_' + chatKey) || '[]');
    const localIDs = new Set(getLocalMessages(chatKey).map(m => m.id));

    const allMessages = Object.entries(data).map(([key, val]) => ({
      id: key,
      text: val.text || null,
      photo: null, audio: null,
      _rawPhoto: val.photo || null,
      _rawAudio: val.audio || null,
      msgType: val.msgType || 'text',
      senderID: val.senderID,
      receiverID: val.receiverID || null,  // FIX: preserve receiverID
      status: val.status || 'sent',
      reactions: val.reactions || {},
      replyTo: val.replyTo || null,
      forwarded: val.forwarded || false,
      waveform: val.waveform || null,
      callType: val.callType || null,
      callStatus: val.callStatus || null,
      timestamp: val.timestamp || Date.now(),
      type: val.senderID === myID ? 'sent' : 'received'
    }));

    allMessages.sort((a, b) => a.timestamp - b.timestamp);

    for (const msg of allMessages) {
      if (deleted.includes(msg.id)) continue;

      if (!localIDs.has(msg.id)) {
        if (msg.msgType === 'photo' && msg._rawPhoto) await saveMedia(msg.id, msg._rawPhoto, 'photo');
        if (msg.msgType === 'audio' && msg._rawAudio) await saveMedia(msg.id, msg._rawAudio, 'audio');
        const msgForLocal = { ...msg };
        delete msgForLocal._rawPhoto;
        delete msgForLocal._rawAudio;
        saveTextMessage(chatKey, msgForLocal);
      }

      msg._rawPhoto = null; msg._rawAudio = null;

      if (!renderedIDs.has(msg.id)) {
        if (msg.msgType === 'photo' || msg.msgType === 'audio') {
          const cached = await getMedia(msg.id);
          if (cached) {
            if (msg.msgType === 'photo') msg.photo = cached.data;
            if (msg.msgType === 'audio') msg.audio = cached.data;
          }
        }
        renderedIDs.add(msg.id);
        renderMessage(msg);
        msg.photo = null; msg.audio = null;
      }
    }

    // FIX: update chat list cache with the latest message after full sync
    if (allMessages.length > 0) {
      const lastMsg = allMessages[allMessages.length - 1];
      updateChatListCache(chatKey, lastMsg);
    }

    scrollToBottom();
  } catch (err) { console.error('Sync error:', err); }
}

// ─── LISTEN FOR NEW MESSAGES ─────────────────────────────────────────────────

function listenForNewMessages() {
  const messagesRef  = ref(db, 'messages/' + chatKey);
  const listenFromTime = Date.now();

  onChildAdded(messagesRef, async (snapshot) => {
    const msg   = snapshot.val();
    const msgID = snapshot.key;
    if (!msg) return;

    const deleted = JSON.parse(localStorage.getItem('deleted_forme_' + chatKey) || '[]');
    if (renderedIDs.has(msgID) || deleted.includes(msgID)) return;

    // FIX: skip old messages — syncFromFirebase handles those
    if (msg.timestamp && msg.timestamp < listenFromTime) return;

    // FIX (media duplicate): skip our own in-flight pushes —
    // sendPhoto/stopRecording will render them after push() resolves
    if (msg.senderID === myID && pendingPushTimestamps.has(msg.timestamp)) return;

    const newMsg = {
      id: msgID,
      text: msg.text || null,
      audio: msg.audio || null,
      photo: msg.photo || null,
      msgType: msg.msgType || 'text',
      senderID: msg.senderID,
      receiverID: msg.receiverID || null,
      status: msg.status || 'sent',
      reactions: msg.reactions || {},
      replyTo: msg.replyTo || null,
      forwarded: msg.forwarded || false,
      waveform: msg.waveform || null,
      callType: msg.callType || null,
      callStatus: msg.callStatus || null,
      timestamp: msg.timestamp || Date.now(),
      type: msg.senderID === myID ? 'sent' : 'received'
    };

    renderedIDs.add(msgID);

    if (newMsg.type === 'received' && newMsg.msgType !== 'call') {
      // BUG FIX: if the user is actively viewing the chat, mark as SEEN right away.
      // Old code always set 'delivered' — so messages showed as unread even while
      // the user was reading them, and coming back to the chats list showed badge.
      if (document.visibilityState === 'visible') {
        try {
          await update(ref(db, 'messages/' + chatKey + '/' + msgID), { status: 'seen' });
          newMsg.status = 'seen';
          // Clear unread count immediately so chats list shows 0
          let unread = JSON.parse(localStorage.getItem('aschat_unread') || '{}');
          unread[otherID] = 0;
          localStorage.setItem('aschat_unread', JSON.stringify(unread));
        } catch (err) { console.error('Seen status error:', err); }
      } else {
        try {
          await update(ref(db, 'messages/' + chatKey + '/' + msgID), { status: 'delivered' });
          newMsg.status = 'delivered';
        } catch (err) { console.error('Deliver status error:', err); }
      }
    }

    saveMessageToLocal(newMsg);
    // FIX: keep chat-list cache in sync so chats.js preview is up-to-date
    updateChatListCache(chatKey, newMsg);
    renderMessage(newMsg);
    scrollToBottom();

    if (newMsg.type === 'received' && newMsg.msgType !== 'call' && document.visibilityState !== 'visible') {
      const contacts = JSON.parse(localStorage.getItem('aschat_contacts') || '{}');
      const photo = contacts[otherID] ? contacts[otherID].photo : null;
      // Pass myID as receiverID so backend knows which subscription to push to
      if (newMsg.msgType === 'photo')      notifyPhoto(otherName, otherID, photo, myID);
      else if (newMsg.msgType === 'audio') notifyVoice(otherName, otherID, photo, myID);
      else                                 notifyMessage(otherName, otherID, newMsg.text || '', photo, myID);
    }
  });
}

// ─── MARK AS SEEN ────────────────────────────────────────────────────────────

// BUG FIX: markMessagesAsSeen used to run only once on page load.
// Now it also accepts an optional single msgID to mark one message seen
// immediately when it arrives while the chat is open and visible.
async function markMessagesAsSeen(singleMsgID = null) {
  try {
    if (singleMsgID) {
      // Fast path: mark a single just-arrived message seen immediately
      await update(ref(db, 'messages/' + chatKey + '/' + singleMsgID), { status: 'seen' });
      updateLocalMessageStatus(chatKey, singleMsgID, 'seen');
    } else {
      // Full path: scan all messages on page open
      const snapshot = await get(ref(db, 'messages/' + chatKey));
      if (!snapshot.exists()) return;
      const data = snapshot.val();
      const updates = {};
      let hasUpdates = false;
      Object.entries(data).forEach(([key, val]) => {
        if (val.receiverID === myID && val.status !== 'seen') {
          updates[key + '/status'] = 'seen';
          hasUpdates = true;
        }
      });
      if (hasUpdates) await update(ref(db, 'messages/' + chatKey), updates);
      // Also update local storage statuses to 'seen'
      const msgs = getLocalMessages(chatKey);
      let changed = false;
      msgs.forEach(m => {
        if (m.receiverID === myID && m.status !== 'seen') {
          m.status = 'seen';
          changed = true;
        }
      });
      if (changed) setLocalMessages(chatKey, msgs);
    }
    // Always clear unread count for this contact
    let unread = JSON.parse(localStorage.getItem('aschat_unread') || '{}');
    unread[otherID] = 0;
    localStorage.setItem('aschat_unread', JSON.stringify(unread));
  } catch (err) { console.error('Mark seen error:', err); }
}

// ─── STATUS UPDATES ──────────────────────────────────────────────────────────

function listenToStatusUpdates() {
  const notifiedReactions = new Set();

  onValue(ref(db, 'messages/' + chatKey), (snapshot) => {
    if (!snapshot.exists()) return;
    const rawData = snapshot.val();
    const data = {};
    Object.entries(rawData).forEach(([key, val]) => {
      data[key] = {
        senderID: val.senderID, receiverID: val.receiverID,
        status: val.status, reactions: val.reactions || {},
        msgType: val.msgType, text: val.text || null,
        callType: val.callType || null, callStatus: val.callStatus || null,
        timestamp: val.timestamp, replyTo: val.replyTo || null,
        forwarded: val.forwarded || false, waveform: val.waveform || null,
      };
    });
    const deleted = JSON.parse(localStorage.getItem('deleted_forme_' + chatKey) || '[]');

    document.querySelectorAll('[data-id]').forEach(el => {
      const msgID = el.getAttribute('data-id');

      if (!data[msgID]) {
        // FIX: use consistent helper instead of raw localStorage
        let msgs = getLocalMessages(chatKey);
        msgs = msgs.filter(m => m.id !== msgID);
        setLocalMessages(chatKey, msgs);
        renderedIDs.delete(msgID);
        el.remove();
        return;
      }
      if (deleted.includes(msgID)) return;
      const val = data[msgID];

      if (val.senderID === myID) {
        const tickEl = el.querySelector('.msg-ticks');
        if (tickEl) {
          if (val.status === 'seen')      { tickEl.className = 'msg-ticks seen';      tickEl.innerHTML = '✓✓'; }
          else if (val.status === 'delivered') { tickEl.className = 'msg-ticks delivered'; tickEl.innerHTML = '✓✓'; }
          else                            { tickEl.className = 'msg-ticks';           tickEl.innerHTML = '✓'; }
        }
        // FIX: persist status changes to localStorage so they survive page reloads
        updateLocalMessageStatus(chatKey, msgID, val.status);
        if (val.reactions) {
          Object.entries(val.reactions).forEach(([reactorID, emoji]) => {
            if (reactorID === myID) return;
            const rKey = `${msgID}_${reactorID}_${emoji}`;
            if (!notifiedReactions.has(rKey)) {
              notifiedReactions.add(rKey);
              const contacts = JSON.parse(localStorage.getItem('aschat_contacts') || '{}');
              const c = contacts[reactorID];
              notifyReaction(c ? c.name : otherName, reactorID, emoji, c ? c.photo : null, myID);
            }
          });
        }
      }

      const reactionsEl = el.querySelector('.msg-reactions');
      if (reactionsEl) reactionsEl.innerHTML = buildReactionsHTML(val.reactions || {});
    });
  });
}

// ─── REACTIONS ───────────────────────────────────────────────────────────────

function buildReactionsHTML(reactions) {
  if (!reactions || Object.keys(reactions).length === 0) return '';
  const counts = {};
  let myReaction = null;
  Object.entries(reactions).forEach(([uid, emoji]) => {
    counts[emoji] = (counts[emoji] || 0) + 1;
    if (uid === myID) myReaction = emoji;
  });
  return Object.entries(counts).map(([emoji, count]) =>
    `<span class="msg-reaction-badge ${myReaction === emoji ? 'mine' : ''}">
      ${emoji}<span class="count">${count > 1 ? count : ''}</span>
    </span>`
  ).join('');
}

// ─── REPLY PREVIEW ───────────────────────────────────────────────────────────

function buildReplyHTML(replyTo) {
  if (!replyTo) return '';
  const senderLabel = escapeHTML(replyTo.senderID === myID ? 'You' : otherName);
  let preview = '';
  if (replyTo.msgType === 'photo')      preview = '<i class="fa-solid fa-image" style="font-size:11px;"></i> Photo';
  else if (replyTo.msgType === 'audio') preview = '<i class="fa-solid fa-microphone" style="font-size:11px;"></i> Voice message';
  else                                  preview = escapeHTML(replyTo.text || '');
  return `<div class="reply-preview"><strong>${senderLabel}</strong> ${preview}</div>`;
}

// ─── WAVEFORM ────────────────────────────────────────────────────────────────

function buildWaveformHTML(data) {
  const NUM_BARS = 50;
  if (!data || data.length === 0) {
    // Realistic-looking fake waveform — not flat, envelope in the middle
    data = Array.from({ length: NUM_BARS }, (_, i) => {
      const envelope = Math.sin((i / NUM_BARS) * Math.PI) * 0.35;
      return Math.min(1, 0.12 + Math.random() * 0.55 + envelope);
    });
  }
  const sampled = sampleWaveform(data, NUM_BARS);
  return sampled.map((v, i) => {
    const h = Math.max(3, Math.round(v * 32));
    return `<div class="waveform-bar" data-index="${i}" style="height:${h}px;"></div>`;
  }).join('');
}

function sampleWaveform(data, maxPoints) {
  if (data.length <= maxPoints) {
    // Upsample: repeat/interpolate values to fill maxPoints
    if (data.length === 0) return data;
    return Array.from({ length: maxPoints }, (_, i) =>
      data[Math.min(data.length - 1, Math.floor((i / maxPoints) * data.length))]
    );
  }
  const step = data.length / maxPoints;
  return Array.from({ length: maxPoints }, (_, i) => data[Math.floor(i * step)]);
}

// ─── VOICE CARD ──────────────────────────────────────────────────────────────

function renderVoiceCard(msg) {
  return `
    <div class="voice-card" id="voice_${msg.id}">
      <div class="voice-controls">
        <button class="voice-play-btn" id="playBtn_${msg.id}" onclick="togglePlay('${msg.id}')">
          <i class="fa-solid fa-play"></i>
        </button>
        <div class="waveform-container" id="waveform_${msg.id}" onclick="seekWaveform('${msg.id}', event)">${buildWaveformHTML(msg.waveform || null)}</div>
      </div>
      <div class="voice-bottom-row">
        <span class="voice-duration" id="dur_${msg.id}">0:00</span>
        <button class="voice-speed-btn" id="speed_${msg.id}" onclick="cycleSpeed('${msg.id}')">1x</button>
      </div>
      <audio id="audio_${msg.id}" src="${msg.audio}" style="display:none;"
        onloadedmetadata="initVoiceDuration('${msg.id}')"></audio>
    </div>`;
}

// Show real duration once audio metadata loads (before first play)
window.initVoiceDuration = function (msgID) {
  const audio = document.getElementById('audio_' + msgID);
  const dur   = document.getElementById('dur_' + msgID);
  if (!audio || !dur) return;
  if (audio.duration && isFinite(audio.duration)) {
    const t = audio.duration;
    dur.textContent = `${Math.floor(t / 60)}:${Math.floor(t % 60).toString().padStart(2, '0')}`;
  }
};

window.togglePlay = function (msgID) {
  const audio = document.getElementById('audio_' + msgID);
  const btn   = document.getElementById('playBtn_' + msgID);
  if (!audio) return;
  if (audio.paused) {
    // Pause all other active players
    Object.keys(audioPlayers).forEach(id => {
      if (id !== msgID) {
        audioPlayers[id].pause();
        const b = document.getElementById('playBtn_' + id);
        if (b) b.innerHTML = '<i class="fa-solid fa-play"></i>';
        // Remove active-bar class from paused waveform
        const wc = document.getElementById('waveform_' + id);
        if (wc) wc.querySelectorAll('.waveform-bar').forEach(b => b.classList.remove('active-bar'));
      }
    });
    audio.play().catch(err => console.error('Audio play error:', err));
    btn.innerHTML = '<i class="fa-solid fa-pause"></i>';
    audioPlayers[msgID] = audio;
    audio.ontimeupdate = () => updateWaveformProgress(msgID, audio);
    audio.onended = () => {
      btn.innerHTML = '<i class="fa-solid fa-play"></i>';
      resetWaveform(msgID);
    };
  } else {
    audio.pause();
    btn.innerHTML = '<i class="fa-solid fa-play"></i>';
    // Remove active-bar highlight when paused
    const wc = document.getElementById('waveform_' + msgID);
    if (wc) wc.querySelectorAll('.waveform-bar').forEach(b => b.classList.remove('active-bar'));
  }
};

// Click on waveform to seek
window.seekWaveform = function (msgID, event) {
  const audio     = document.getElementById('audio_' + msgID);
  const container = document.getElementById('waveform_' + msgID);
  if (!audio || !container || !audio.duration) return;
  const rect  = container.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  audio.currentTime = ratio * audio.duration;
  updateWaveformProgress(msgID, audio);
};

function updateWaveformProgress(msgID, audio) {
  const dur = document.getElementById('dur_' + msgID);
  if (dur) {
    const t = audio.currentTime;
    dur.textContent = `${Math.floor(t / 60)}:${Math.floor(t % 60).toString().padStart(2, '0')}`;
  }
  const container = document.getElementById('waveform_' + msgID);
  if (!container || !audio.duration) return;
  const bars = container.querySelectorAll('.waveform-bar');
  const progress  = audio.currentTime / audio.duration;
  const playedCount = Math.floor(progress * bars.length);
  // The bar right at the playhead gets active-bar (the "head" indicator)
  bars.forEach((bar, i) => {
    bar.classList.toggle('played', i < playedCount);
    bar.classList.toggle('active-bar', i === playedCount);
  });
}

function resetWaveform(msgID) {
  const c = document.getElementById('waveform_' + msgID);
  if (c) c.querySelectorAll('.waveform-bar').forEach(b => {
    b.classList.remove('played');
    b.classList.remove('active-bar');
  });
  // Restore total duration in the timer (not 0:00)
  const audio = document.getElementById('audio_' + msgID);
  const d     = document.getElementById('dur_' + msgID);
  if (d && audio && audio.duration && isFinite(audio.duration)) {
    const t = audio.duration;
    d.textContent = `${Math.floor(t / 60)}:${Math.floor(t % 60).toString().padStart(2, '0')}`;
  } else if (d) {
    d.textContent = '0:00';
  }
}

window.cycleSpeed = function (msgID) {
  const audio = document.getElementById('audio_' + msgID);
  const btn   = document.getElementById('speed_' + msgID);
  if (!audio || !btn) return;
  const nextIdx = ((audioSpeeds[msgID] || 0) + 1) % speeds.length;
  audioSpeeds[msgID] = nextIdx;
  audio.playbackRate = speeds[nextIdx];
  btn.textContent = speeds[nextIdx] + 'x';
};

// ─── SENDING PLACEHOLDER ─────────────────────────────────────────────────────

function renderSendingPlaceholder(type, tempID) {
  const container = document.getElementById('messagesContainer');
  const wrapper = document.createElement('div');
  wrapper.className = 'message-wrapper sent';
  wrapper.setAttribute('data-temp-id', tempID);
  const bubble = document.createElement('div');
  bubble.className = 'message sent';

  if (type === 'photo') {
    bubble.innerHTML = `
      <div class="sending-placeholder photo-placeholder">
        <div class="sending-spinner"></div><span>Sending photo...</span>
      </div>
      <div class="msg-meta"><span class="msg-time">${formatTime(Date.now())}</span>${getTicks('sending')}</div>`;
  } else if (type === 'audio') {
    // Generate a realistic-looking fake waveform for the sending state (50 bars)
    const fakeBars = Array.from({ length: 50 }, (_, i) => {
      const envelope = Math.sin((i / 50) * Math.PI) * 0.35;
      const h = Math.max(3, Math.round((0.12 + Math.random() * 0.5 + envelope) * 32));
      return `<div class="waveform-bar sending-wave-bar" style="height:${h}px;"></div>`;
    }).join('');
    bubble.innerHTML = `
      <div class="voice-card">
        <div class="voice-controls">
          <button class="voice-play-btn" disabled style="opacity:0.4;"><i class="fa-solid fa-play"></i></button>
          <div class="waveform-container sending-waveform">${fakeBars}</div>
        </div>
        <div class="voice-bottom-row">
          <span class="voice-duration" style="display:flex;align-items:center;gap:6px;">
            <span class="sending-spinner" style="width:12px;height:12px;border-width:2px;"></span>Sending...
          </span>
        </div>
      </div>
      <div class="msg-meta"><span class="msg-time">${formatTime(Date.now())}</span>${getTicks('sending')}</div>`;
  }

  wrapper.appendChild(bubble);
  container.appendChild(wrapper);
  scrollToBottom();
}

function removeSendingPlaceholder(tempID) {
  const el = document.querySelector(`[data-temp-id="${tempID}"]`);
  if (el) el.remove();
}

// ─── BOTTOM SHEET ─────────────────────────────────────────────────────────────

window.openBottomSheet = function (msgID) {
  const msg = messageDataStore[msgID];
  if (!msg) return;
  activeMessageID = msgID;
  activeMessageSenderID = msg.senderID;

  const spans = document.getElementById('reactionPicker').querySelectorAll('span');
  spans.forEach(s => s.classList.remove('selected'));
  get(ref(db, 'messages/' + chatKey + '/' + msgID + '/reactions/' + myID)).then(snap => {
    if (snap.exists()) spans.forEach(s => { if (s.textContent.trim() === snap.val()) s.classList.add('selected'); });
  });

  const actions = document.getElementById('sheetActions');
  actions.innerHTML = '';

  if (msg.msgType !== 'call') {
    const replyBtn = document.createElement('button');
    replyBtn.className = 'sheet-btn';
    replyBtn.innerHTML = `<i class="fa-solid fa-reply"></i> Reply`;
    replyBtn.onclick = () => startReply(msg);
    actions.appendChild(replyBtn);

    const fwdBtn = document.createElement('button');
    fwdBtn.className = 'sheet-btn';
    fwdBtn.innerHTML = `<i class="fa-solid fa-share"></i> Forward`;
    // FIX: pass msgID so forward loads media fresh from IndexedDB
    fwdBtn.onclick = () => startForward(msgID);
    actions.appendChild(fwdBtn);
  }

  const delMe = document.createElement('button');
  delMe.className = 'sheet-btn danger';
  delMe.innerHTML = `<i class="fa-solid fa-trash"></i> Delete for me`;
  delMe.onclick = () => deleteForMe(msgID);
  actions.appendChild(delMe);

  if (msg.senderID === myID) {
    const delAll = document.createElement('button');
    delAll.className = 'sheet-btn danger';
    delAll.innerHTML = `<i class="fa-solid fa-trash-can"></i> Delete for everyone`;
    delAll.onclick = () => deleteForEveryone(msgID);
    actions.appendChild(delAll);
  }

  document.getElementById('bottomSheet').style.display = 'flex';
};

window.closeBottomSheet = function () {
  document.getElementById('bottomSheet').style.display = 'none';
  activeMessageID = null; activeMessageSenderID = null;
};

window.closeSheet = function (e) {
  if (e.target === document.getElementById('bottomSheet')) closeBottomSheet();
};

window.reactToMessage = async function (emoji) {
  if (!activeMessageID) return;
  try {
    const rRef = ref(db, 'messages/' + chatKey + '/' + activeMessageID + '/reactions/' + myID);
    const snap = await get(rRef);
    if (snap.exists() && snap.val() === emoji) await remove(rRef);
    else await update(ref(db, 'messages/' + chatKey + '/' + activeMessageID + '/reactions'), { [myID]: emoji });
  } catch (err) { console.error('Reaction error:', err); }
  closeBottomSheet();
};

// ─── REPLY ───────────────────────────────────────────────────────────────────

function startReply(msg) {
  replyTo = { msgID: msg.id, senderID: msg.senderID, text: msg.text, msgType: msg.msgType };
  const label = msg.senderID === myID ? 'You' : otherName;
  let preview = '';
  if (msg.msgType === 'photo')      preview = '<i class="fa-solid fa-image" style="font-size:11px;"></i> Photo';
  else if (msg.msgType === 'audio') preview = '<i class="fa-solid fa-microphone" style="font-size:11px;"></i> Voice message';
  else                              preview = escapeHTML(msg.text || '');
  document.getElementById('replyBarName').textContent = label;
  document.getElementById('replyBarText').innerHTML = preview;
  document.getElementById('replyBar').classList.add('active');
  document.getElementById('messageInput').focus();
  closeBottomSheet();
}

window.cancelReply = function () {
  replyTo = null;
  document.getElementById('replyBar').classList.remove('active');
};

// ─── FORWARD ─────────────────────────────────────────────────────────────────

// FIX: store msgID to reload media fresh from IndexedDB at send time
function startForward(msgID) {
  const base = messageDataStore[msgID];
  if (!base) return;
  forwardMessageData = { ...base, _msgID: msgID };

  const contacts = JSON.parse(localStorage.getItem('aschat_contacts') || '{}');
  const list = document.getElementById('forwardContactsList');
  list.innerHTML = '';
  const others = Object.values(contacts).filter(c => c.userID !== otherID);

  if (others.length === 0) {
    list.innerHTML = '<p style="color:#aaa;text-align:center;font-size:13px;padding:20px 0;">No other contacts.</p>';
  } else {
    others.forEach(contact => {
      const item = document.createElement('div');
      item.className = 'forward-contact';
      // FIX (XSS): escape contact name and photo src
      const safePhoto = contact.photo ? escapeHTML(contact.photo) : '';
      const safeName  = escapeHTML(contact.name);
      const avatarHTML = safePhoto
        ? `<img src="${safePhoto}" style="width:40px;height:40px;border-radius:50%;object-fit:cover;" />`
        : `<div class="forward-avatar">${escapeHTML(contact.name.charAt(0).toUpperCase())}</div>`;
      item.innerHTML = `${avatarHTML}<span class="forward-contact-name">${safeName}</span>`;
      item.onclick = () => forwardToContact(contact);
      list.appendChild(item);
    });
  }
  closeBottomSheet();
  document.getElementById('forwardModal').style.display = 'flex';
}

window.closeForwardModal = function () {
  document.getElementById('forwardModal').style.display = 'none';
  forwardMessageData = null;
};

async function forwardToContact(contact) {
  if (!forwardMessageData) return;
  const fwdChatKey = getChatKey(myID, contact.userID);
  try {
    const payload = {
      msgType: forwardMessageData.msgType,
      senderID: myID,
      receiverID: contact.userID,
      status: 'sent',
      timestamp: Date.now(),
      forwarded: true
    };

    // FIX: reload media from IndexedDB — in-memory copies are nulled after render
    if (forwardMessageData.msgType === 'photo') {
      const cached = await getMedia(forwardMessageData._msgID);
      payload.photo = cached ? cached.data : null;
    } else if (forwardMessageData.msgType === 'audio') {
      const cached = await getMedia(forwardMessageData._msgID);
      payload.audio = cached ? cached.data : null;
      payload.waveform = forwardMessageData.waveform || null;
    } else {
      payload.text = forwardMessageData.text;
    }

    const newRef = await push(ref(db, 'messages/' + fwdChatKey), payload);
    // FIX: use saveTextMessage (strips binary, enforces 500-msg cap)
    saveTextMessage(fwdChatKey, { ...payload, id: newRef.key, type: 'sent' });

    let contacts2 = JSON.parse(localStorage.getItem('aschat_contacts') || '{}');
    if (!contacts2[contact.userID]) {
      contacts2[contact.userID] = { name: contact.name, userID: contact.userID, photo: contact.photo || null };
      localStorage.setItem('aschat_contacts', JSON.stringify(contacts2));
    }
    closeForwardModal();
    alert(`Message forwarded to ${contact.name}!`);
  } catch (err) {
    console.error('Forward error:', err);
    alert('Failed to forward message.');
  }
}

// ─── DELETE ──────────────────────────────────────────────────────────────────

async function deleteForMe(msgID) {
  let deleted = JSON.parse(localStorage.getItem('deleted_forme_' + chatKey) || '[]');
  if (!deleted.includes(msgID)) {
    deleted.push(msgID);
    localStorage.setItem('deleted_forme_' + chatKey, JSON.stringify(deleted));
  }
  // FIX: both delete paths now use getLocalMessages/setLocalMessages consistently
  let msgs = getLocalMessages(chatKey);
  msgs = msgs.filter(m => m.id !== msgID);
  setLocalMessages(chatKey, msgs);
  await deleteMedia(msgID);
  renderedIDs.delete(msgID);
  const el = document.querySelector(`[data-id="${msgID}"]`);
  if (el) el.remove();
  closeBottomSheet();
}

async function deleteForEveryone(msgID) {
  try {
    await remove(ref(db, 'messages/' + chatKey + '/' + msgID));
    // FIX: consistent helper + also delete from IndexedDB
    let msgs = getLocalMessages(chatKey);
    msgs = msgs.filter(m => m.id !== msgID);
    setLocalMessages(chatKey, msgs);
    await deleteMedia(msgID);
    renderedIDs.delete(msgID);
    const el = document.querySelector(`[data-id="${msgID}"]`);
    if (el) el.remove();
  } catch (err) { console.error('Delete everyone error:', err); }
  closeBottomSheet();
}

// ─── SEND TEXT ───────────────────────────────────────────────────────────────

window.sendMessage = async function () {
  const input = document.getElementById('messageInput');
  const text  = input.value.trim();
  if (!text) return;
  input.value = '';

  const payload = { text, msgType: 'text', senderID: myID, receiverID: otherID, status: 'sent', timestamp: Date.now() };
  if (replyTo) { payload.replyTo = replyTo; cancelReply(); }

  const tempID = 'pending_' + Date.now();
  const optimisticMsg = { ...payload, id: tempID, type: 'sent', status: 'sending' };
  renderedIDs.add(tempID);
  renderMessage(optimisticMsg);
  scrollToBottom();

  if (!isOnline) { enqueueMessage(chatKey, payload); saveMessageToLocal(optimisticMsg); return; }

  try {
    const newRef = await push(ref(db, 'messages/' + chatKey), payload);
    const realID = newRef.key;
    renderedIDs.add(realID);
    const tempEl = document.querySelector('[data-id="' + tempID + '"]');
    if (tempEl) {
      tempEl.setAttribute('data-id', realID);
      const ticks = tempEl.querySelector('.msg-ticks');
      if (ticks) ticks.outerHTML = '<span class="msg-ticks">✓</span>';
    }
    renderedIDs.delete(tempID);
    // BUG FIX: remove the optimistic temp entry from localStorage before saving the real one
    // — otherwise on next page load the temp-ID ghost message re-renders alongside the real one
    let storedMsgs = getLocalMessages(chatKey);
    storedMsgs = storedMsgs.filter(m => m.id !== tempID);
    setLocalMessages(chatKey, storedMsgs);
    const savedMsg = { ...payload, id: realID, type: 'sent' };
    saveMessageToLocal(savedMsg);
    // FIX: update chat list cache so chats.js shows the message immediately
    updateChatListCache(chatKey, savedMsg);

    // FEATURE (WhatsApp-style): write a small inbox ping so the receiver's
    // chats.js listenForIncomingFromStrangers() is woken up even if they have
    // never chatted with us before. The inbox entry contains just enough info
    // for the receiver to look up our profile and show the chat.
    // inbox/receiverID/senderID  →  { senderID, timestamp }
    try {
      await update(ref(db, 'inbox/' + otherID), {
        [myID]: { senderID: myID, timestamp: Date.now() }
      });
    } catch (e) { /* inbox write is best-effort; don't fail the send */ }

  } catch (err) {
    console.error('Send error:', err);
    const el = document.querySelector('[data-id="' + tempID + '"]');
    if (el) el.classList.add('msg-failed');
  }
};

// ─── SEND PHOTO ──────────────────────────────────────────────────────────────

window.sendPhoto = async function (event) {
  const file = event.target.files[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { alert('Photo too large. Max 5MB.'); return; }

  const tempID = 'temp_' + Date.now();
  renderSendingPlaceholder('photo', tempID);

  const reader = new FileReader();
  reader.onload = async function (e) {
    const base64 = e.target.result;
    const sentAt = Date.now();

    const payload = {
      photo: base64, msgType: 'photo',
      senderID: myID, receiverID: otherID,
      status: 'sent', timestamp: sentAt
    };
    if (replyTo) { payload.replyTo = replyTo; cancelReply(); }

    // FIX (media duplicate): mark this timestamp as in-flight
    pendingPushTimestamps.add(sentAt);
    try {
      const newRef = await push(ref(db, 'messages/' + chatKey), payload);
      const realID = newRef.key;
      // Register real ID to block any concurrent onChildAdded that slipped through
      renderedIDs.add(realID);
      pendingPushTimestamps.delete(sentAt);
      const msg = { ...payload, id: realID, type: 'sent' };
      saveMessageToLocal(msg);
      removeSendingPlaceholder(tempID);
      renderMessage(msg);
      scrollToBottom();
      // FEATURE (WhatsApp-style): inbox ping so receiver auto-discovers this chat
      try { await update(ref(db, 'inbox/' + otherID), { [myID]: { senderID: myID, timestamp: Date.now() } }); } catch (e) {}
    } catch (err) {
      pendingPushTimestamps.delete(sentAt);
      removeSendingPlaceholder(tempID);
      console.error('Photo send error:', err);
      alert('Failed to send photo.');
    }
  };
  reader.readAsDataURL(file);
  event.target.value = '';
};

// ─── VOICE RECORDING ─────────────────────────────────────────────────────────

window.startRecording = async function (e) {
  e.preventDefault();
  if (isRecording) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtx.createMediaStreamSource(stream);
    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize = 256;          // more resolution
    analyserNode.smoothingTimeConstant = 0.6;
    source.connect(analyserNode);

    mediaRecorder = new MediaRecorder(stream);
    audioChunks = [];
    waveformData = [];
    isRecording = true;
    isCancellingRecording = false;

    const btn = document.getElementById('voiceBtn');
    btn.classList.add('recording');
    btn.innerHTML = '<i class="fa-solid fa-stop"></i>';

    const recWave = document.getElementById('recordingWaveform');
    recWave.classList.add('active');
    recWave.innerHTML = '';
    waveformBars = [];
    const BAR_COUNT = 40;
    for (let i = 0; i < BAR_COUNT; i++) {
      const bar = document.createElement('div');
      bar.className = 'recording-bar';
      recWave.appendChild(bar);
      waveformBars.push(bar);
    }
    document.getElementById('messageInput').style.display = 'none';

    const dataArray = new Uint8Array(analyserNode.frequencyBinCount);
    // Sample every ~80ms so we don't over-sample waveformData
    let lastSample = 0;
    function animateBars(timestamp) {
      if (!isRecording) return;
      analyserNode.getByteFrequencyData(dataArray);
      // Use lower half of spectrum (voice frequencies)
      const half = Math.floor(dataArray.length / 2);
      const slice = dataArray.slice(0, half);
      const avg = slice.reduce((a, b) => a + b, 0) / half;
      const normalized = Math.min(1, avg / 180);   // 180 = comfortable ceiling for voice

      // Push a sample for waveform storage ~every 80ms
      if (timestamp - lastSample > 80) {
        waveformData.push(normalized);
        lastSample = timestamp;
      }

      // Scroll waveformBars: each bar shows a past sample (rightmost = latest)
      waveformBars.forEach((bar, i) => {
        const offset = waveformData.length - BAR_COUNT + i;
        const val = (offset >= 0 && waveformData[offset] !== undefined)
          ? waveformData[offset]
          : 0.04;
        const jitter = (Math.random() - 0.5) * 0.04;  // tiny jitter for life
        bar.style.height = Math.max(3, Math.round((val + jitter) * 32)) + 'px';
      });

      animationFrameID = requestAnimationFrame(animateBars);
    }
    animationFrameID = requestAnimationFrame(animateBars);

    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };
    mediaRecorder.start();
  } catch (err) {
    console.error('Recording error:', err);
    alert('Microphone access denied.');
  }
};

window.stopRecording = async function (e) {
  e.preventDefault();
  if (!isRecording || !mediaRecorder) return;
  isRecording = false;
  isCancellingRecording = false;
  cancelAnimationFrame(animationFrameID);

  const btn = document.getElementById('voiceBtn');
  btn.classList.remove('recording');
  btn.innerHTML = '<i class="fa-solid fa-microphone"></i>';
  document.getElementById('recordingWaveform').classList.remove('active');
  document.getElementById('messageInput').style.display = '';

  const capturedWaveform = [...waveformData];
  const tempID = 'temp_' + Date.now();
  renderSendingPlaceholder('audio', tempID);

  mediaRecorder.stop();

  mediaRecorder.onstop = async () => {
    // FIX: if cancelled, discard — checked AFTER stop() to handle the race
    if (isCancellingRecording) {
      removeSendingPlaceholder(tempID);
      mediaRecorder.stream.getTracks().forEach(t => t.stop());
      return;
    }
    if (audioChunks.length === 0) {
      removeSendingPlaceholder(tempID);
      mediaRecorder.stream.getTracks().forEach(t => t.stop());
      return;
    }
    const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
    if (audioBlob.size < 1000) {
      removeSendingPlaceholder(tempID);
      mediaRecorder.stream.getTracks().forEach(t => t.stop());
      return;
    }

    const reader = new FileReader();
    reader.onload = async function (e) {
      const base64 = e.target.result;
      // FIX: sample to 50 bars to match buildWaveformHTML's NUM_BARS
      const sampled = sampleWaveform(capturedWaveform, 50);
      const sentAt  = Date.now();

      const payload = {
        audio: base64, msgType: 'audio',
        senderID: myID,
        receiverID: otherID,   // BUG FIX: always set receiverID on voice messages
        status: 'sent', waveform: sampled, timestamp: sentAt
      };
      if (replyTo) { payload.replyTo = replyTo; cancelReply(); }

      // FIX (media duplicate): mark in-flight
      pendingPushTimestamps.add(sentAt);
      try {
        const newRef = await push(ref(db, 'messages/' + chatKey), payload);
        const realID = newRef.key;
        renderedIDs.add(realID);
        pendingPushTimestamps.delete(sentAt);
        const msg = { ...payload, id: realID, type: 'sent' };
        // Save media separately; saveTextMessage will strip the inline audio blob
        await saveMedia(realID, base64, 'audio');
        saveTextMessage(chatKey, msg);
        updateChatListCache(chatKey, msg);
        removeSendingPlaceholder(tempID);
        // For rendering pass the audio data in
        renderMessage(msg);
        scrollToBottom();
      } catch (err) {
        pendingPushTimestamps.delete(sentAt);
        removeSendingPlaceholder(tempID);
        console.error('Voice send error:', err);
        alert('Failed to send voice message.');
      }
    };
    reader.readAsDataURL(audioBlob);
    mediaRecorder.stream.getTracks().forEach(t => t.stop());
  };
};

window.cancelRecording = function () {
  if (!isRecording || !mediaRecorder) return;
  isRecording = false;
  // FIX: set flag BEFORE stop() — onstop checks it and discards the blob
  isCancellingRecording = true;
  cancelAnimationFrame(animationFrameID);
  audioChunks = [];

  const btn = document.getElementById('voiceBtn');
  btn.classList.remove('recording');
  btn.innerHTML = '<i class="fa-solid fa-microphone"></i>';
  document.getElementById('recordingWaveform').classList.remove('active');
  document.getElementById('messageInput').style.display = '';

  mediaRecorder.stop();
  // onstop will see isCancellingRecording===true and discard
};

// ─── SAVE TO LOCAL ───────────────────────────────────────────────────────────

async function saveMessageToLocal(msg) {
  if (msg.msgType === 'photo' && msg.photo) await saveMedia(msg.id, msg.photo, 'photo');
  if (msg.msgType === 'audio' && msg.audio) await saveMedia(msg.id, msg.audio, 'audio');
  saveTextMessage(chatKey, msg);
}

// ─── RENDER MESSAGE ──────────────────────────────────────────────────────────

function renderMessage(msg) {
  const container = document.getElementById('messagesContainer');
  if (!container) return;

  // BUG FIX: store a media-safe snapshot (without the large base64 blobs) so
  // the messageDataStore doesn't grow unboundedly and media is always reloaded
  // fresh from IndexedDB by forwardToContact / openBottomSheet when needed.
  messageDataStore[msg.id] = {
    id:         msg.id,
    msgType:    msg.msgType,
    text:       msg.text || null,
    senderID:   msg.senderID,
    receiverID: msg.receiverID || null,
    status:     msg.status,
    reactions:  msg.reactions || {},
    replyTo:    msg.replyTo || null,
    forwarded:  msg.forwarded || false,
    waveform:   msg.waveform || null,
    callType:   msg.callType || null,
    callStatus: msg.callStatus || null,
    timestamp:  msg.timestamp,
    type:       msg.type,
  };
  renderDateSeparatorIfNeeded(msg.timestamp, container);

  const wrapper = document.createElement('div');
  wrapper.className = `message-wrapper ${msg.type === 'sent' ? 'sent' : 'received'}`;
  wrapper.setAttribute('data-id', msg.id);

  const isSent = msg.type === 'sent';
  const ticksHTML     = isSent ? getTicks(msg.status || 'sent') : '';
  const reactionsHTML = buildReactionsHTML(msg.reactions || {});
  const replyHTML     = msg.replyTo ? buildReplyHTML(msg.replyTo) : '';

  // FIX: Font Awesome icon for "Forwarded" label
  const forwardedHTML = msg.forwarded
    ? `<div class="msg-forwarded-label"><i class="fa-solid fa-share"></i> Forwarded</div>`
    : '';

  let msgContent = '';
  if (msg.msgType === 'photo' && msg.photo) {
    msgContent = `<img src="${msg.photo}" class="msg-photo" onclick="openPhoto(this.src)" />`;
  } else if (msg.msgType === 'audio' && msg.audio) {
    msgContent = renderVoiceCard(msg);
  } else if (msg.msgType === 'call') {
    // FIX: Font Awesome icons — no emoji characters
    const isMissed   = msg.callStatus === 'missed';
    const isDeclined = msg.callStatus === 'declined';
    const isVideo    = msg.callType === 'video';
    const isBad      = isMissed || isDeclined;
    const iconClass  = isVideo ? 'fa-video' : 'fa-phone';
    const color      = isBad  ? '#e53935'  : '#128C7E';
    let statusLabel  = msg.callStatus === 'ended' ? 'Call ended'
                     : isMissed   ? 'Missed call'
                     : isDeclined ? 'Call declined'
                     : 'Call';
    const typeLabel  = isVideo ? 'Video' : 'Voice';
    msgContent = `
      <div class="call-msg-bubble ${isBad ? 'missed' : ''}">
        <i class="fa-solid ${iconClass}" style="color:${color};font-size:15px;"></i>
        <span>${typeLabel} call &mdash; ${statusLabel}</span>
      </div>`;
  } else {
    msgContent = `<div>${escapeHTML(msg.text || '')}</div>`;
  }

  const bubble = document.createElement('div');
  bubble.className = `message ${isSent ? 'sent' : 'received'}`;
  bubble.innerHTML = `
    ${forwardedHTML}${replyHTML}${msgContent}
    <div class="msg-meta"><span class="msg-time">${formatTime(msg.timestamp)}</span>${ticksHTML}</div>
    <div class="msg-reactions">${reactionsHTML}</div>`;

  const actionBtn = document.createElement('button');
  actionBtn.className = 'msg-action-btn';
  actionBtn.innerHTML = '<i class="fa-solid fa-ellipsis-vertical"></i>';
  actionBtn.addEventListener('click', (e) => { e.stopPropagation(); openBottomSheet(msg.id); });

  wrapper.appendChild(bubble);
  wrapper.appendChild(actionBtn);
  container.appendChild(wrapper);
}

// ─── PHOTO VIEWER ────────────────────────────────────────────────────────────

window.openPhoto = function (src) {
  const modal = document.getElementById('photoModal');
  const img   = document.getElementById('photoModalImg');
  if (modal && img) { img.src = src; modal.style.display = 'flex'; }
};
window.closePhoto = function () {
  const modal = document.getElementById('photoModal');
  const img   = document.getElementById('photoModalImg');
  if (modal && img) { modal.style.display = 'none'; img.src = ''; }
};

// ─── TYPING ──────────────────────────────────────────────────────────────────

let typingTimeout    = null;
let isTypingEmitted  = false;

function setupTypingEmitter() {
  const input = document.getElementById('messageInput');
  if (!input) return;
  window.addEventListener('beforeunload', () => {
    update(ref(db, 'typing/' + chatKey + '/' + myID), { typing: false }).catch(() => {});
  });
  input.addEventListener('input', () => {
    if (!isTypingEmitted) {
      isTypingEmitted = true;
      update(ref(db, 'typing/' + chatKey + '/' + myID), { typing: true }).catch(() => {});
    }
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
      isTypingEmitted = false;
      update(ref(db, 'typing/' + chatKey + '/' + myID), { typing: false }).catch(() => {});
    }, 2000);
  });
}

function listenToTyping() {
  onValue(ref(db, 'typing/' + chatKey + '/' + otherID), (snapshot) => {
    const container = document.getElementById('messagesContainer');
    if (!container) return;
    let indicator = document.getElementById('typingIndicator');
    if (snapshot.exists() && snapshot.val().typing === true) {
      if (!indicator) {
        indicator = document.createElement('div');
        indicator.id = 'typingIndicator';
        indicator.className = 'typing-indicator';
        indicator.innerHTML = `<div class="typing-bubble">
          <div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>
        </div>`;
        container.appendChild(indicator);
        scrollToBottom();
      }
    } else {
      if (indicator) indicator.remove();
    }
  });
}

// ─── OFFLINE ─────────────────────────────────────────────────────────────────

function initOfflineDetection() {
  updateOfflineBar();
  window.addEventListener('online',  () => { isOnline = true;  updateOfflineBar(); flushMessageQueue(); syncFromFirebase(); });
  window.addEventListener('offline', () => { isOnline = false; updateOfflineBar(); });
}

function updateOfflineBar() {
  let bar = document.getElementById('offlineBar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'offlineBar'; bar.className = 'offline-bar';
    const hdr = document.getElementById('chatHeader');
    if (hdr && hdr.nextSibling) hdr.parentNode.insertBefore(bar, hdr.nextSibling);
    else document.body.prepend(bar);
  }
  if (isOnline) { bar.classList.remove('visible'); }
  else { bar.innerHTML = '<i class="fa-solid fa-wifi-slash"></i> You are offline — showing cached messages'; bar.classList.add('visible'); }
}

async function flushMessageQueue() {
  const queue = getQueue();
  if (!queue.length) return;
  for (const item of queue) {
    try {
      const newRef = await push(ref(db, 'messages/' + item.chatKey), item.payload);
      removeFromQueue(item.queuedAt);
      if (item.chatKey === chatKey) {
        const msg = { ...item.payload, id: newRef.key, type: 'sent' };
        const pendingEls = document.querySelectorAll('[data-id^="pending_"]');
        for (const el of pendingEls) {
          const elMsg = messageDataStore[el.dataset.id];
          if (elMsg && elMsg.text === item.payload.text && Math.abs(elMsg.timestamp - item.payload.timestamp) < 5000) {
            renderedIDs.delete(el.dataset.id); el.remove(); break;
          }
        }
        renderedIDs.add(msg.id);
        renderMessage(msg);
        saveMessageToLocal(msg);
        scrollToBottom();
      }
    } catch (err) { console.error('Queue flush error:', err); }
  }
}

// ─── DATE SEPARATOR ──────────────────────────────────────────────────────────

let lastRenderedDate = null;

function getDateLabel(ts) {
  const d = new Date(ts), n = new Date(), y = new Date();
  y.setDate(n.getDate() - 1);
  if (d.toDateString() === n.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' });
}

function renderDateSeparatorIfNeeded(ts, container) {
  const label = getDateLabel(ts);
  if (label !== lastRenderedDate) {
    lastRenderedDate = label;
    const sep = document.createElement('div');
    sep.className = 'date-separator';
    sep.innerHTML = `<span>${label}</span>`;
    container.appendChild(sep);
  }
}
