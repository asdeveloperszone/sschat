import { notifyIncomingCall, notifyMissedCall, dismissCallNotification } from './notifications.js';
import { db, auth } from './firebase-config.js';
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-auth.js";
import {
  ref, get, onValue, update, remove, push
} from "https://www.gstatic.com/firebasejs/12.9.0/firebase-database.js";

let myID          = null;
let activeCallData = null;
let ringtone      = null;
let missedTimer   = null;

onAuthStateChanged(auth, async (user) => {
  if (!user) return;

  myID = localStorage.getItem('aschat_userID');
  if (!myID || myID === 'null') {
    const snap = await get(ref(db, 'userMap/' + user.uid));
    if (snap.exists()) {
      myID = snap.val();
      localStorage.setItem('aschat_userID', myID);
    }
  }
  if (!myID) return;
  listenForIncomingCall();
});

function listenForIncomingCall() {
  onValue(ref(db, 'calls/' + myID), (snap) => {
    if (!snap.exists()) {
      if (activeCallData) hidePopup();
      return;
    }
    const data = snap.val();
    if (data.status === 'missed' || data.status === 'ended' || data.status === 'declined') {
      if (activeCallData) hidePopup();
      return;
    }
    if ((data.status === 'ringing' || !data.status) && !activeCallData) {
      activeCallData = data;
      showPopup(data);
    }
  });
}

function showPopup(data) {
  const contacts   = JSON.parse(localStorage.getItem('aschat_contacts') || '{}');
  const contact    = contacts[data.callerID];
  const callerName = contact ? contact.name : (data.callerName || 'Unknown');
  const callerPhoto = contact ? contact.photo : null;
  const isVideo    = data.callType === 'video' || data.type === 'video';

  const avatarHTML = callerPhoto
    ? `<img src="${callerPhoto}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" />`
    : `<span style="font-size:26px;font-weight:700;color:#fff;">${callerName.charAt(0).toUpperCase()}</span>`;

  const popup = document.createElement('div');
  popup.id = 'globalCallPopup';
  // FIX: Font Awesome icons instead of emoji in popup label
  popup.innerHTML = `
    <div class="gc-popup-inner">
      <div class="gc-left">
        <div class="gc-avatar">${avatarHTML}</div>
        <div class="gc-info">
          <div class="gc-label">
            <i class="fa-solid ${isVideo ? 'fa-video' : 'fa-phone'}" style="margin-right:5px;"></i>
            ${isVideo ? 'Incoming Video Call' : 'Incoming Voice Call'}
          </div>
          <div class="gc-name">${callerName}</div>
        </div>
      </div>
      <div class="gc-actions">
        <button class="gc-btn gc-decline" id="gcDeclineBtn" onclick="window._gcDecline()">
          <i class="fa-solid fa-phone-slash"></i>
        </button>
        <button class="gc-btn gc-accept" id="gcAcceptBtn" onclick="window._gcAccept()">
          <i class="fa-solid fa-phone"></i>
        </button>
      </div>
    </div>`;

  document.body.appendChild(popup);
  requestAnimationFrame(() => popup.classList.add('gc-visible'));

  playRingtone();
  notifyIncomingCall(callerName, data.callerID, data.callType, callerPhoto, myID);

  missedTimer = setTimeout(async () => {
    hidePopup();
    // FIX: write 'missed' status to Firebase so the caller's onValue listener
    // in call.js fires and they see "Missed call" in their chat + call screen
    try {
      await update(ref(db, 'calls/' + myID), { status: 'missed' });
      const chatKey = [myID, data.callerID].sort().join('_');
      const isVideo = data.callType === 'video';
      await push(ref(db, 'messages/' + chatKey), {
        text:       isVideo ? 'Video call — Missed call' : 'Voice call — Missed call',
        msgType:    'call',
        callType:   data.callType || 'voice',
        callStatus: 'missed',
        senderID:   myID,
        receiverID: data.callerID,
        status:     'sent',
        timestamp:  Date.now()
      }).catch(() => {});
      setTimeout(() => remove(ref(db, 'calls/' + myID)).catch(() => {}), 1500);
    } catch (e) {}
    notifyMissedCall(callerName, data.callerID, data.callType, callerPhoto, myID);
  }, 30000);

  window._gcAccept  = acceptCall;
  window._gcDecline = declineCall;
}

function hidePopup() {
  clearTimeout(missedTimer);
  stopRingtone();
  if (activeCallData) dismissCallNotification(activeCallData.callerID);
  activeCallData = null;
  const popup = document.getElementById('globalCallPopup');
  if (!popup) return;
  popup.classList.remove('gc-visible');
  popup.classList.add('gc-hiding');
  setTimeout(() => popup.remove(), 400);
}

async function acceptCall() {
  if (!activeCallData) return;
  const callerID   = activeCallData.callerID;
  const callType   = activeCallData.callType || activeCallData.type || 'voice';
  const contacts   = JSON.parse(localStorage.getItem('aschat_contacts') || '{}');
  const contact    = contacts[callerID];
  const callerName = contact ? contact.name : (activeCallData.callerName || 'User');
  hidePopup();
  window.location.href = `chat.html?id=${callerID}&name=${encodeURIComponent(callerName)}&autocall=accept&calltype=${callType}`;
}

async function declineCall() {
  if (!activeCallData) return;
  const data = activeCallData;
  hidePopup();

  try {
    await update(ref(db, 'calls/' + myID), { status: 'declined' });

    const chatKey = [myID, data.callerID].sort().join('_');
    const isVideo = data.callType === 'video';
    // FIX: plain text only — icon is handled by chat.js renderMessage with FA icons
    await push(ref(db, 'messages/' + chatKey), {
      text:       isVideo ? 'Video call — Call declined' : 'Voice call — Call declined',
      msgType:    'call',
      callType:   data.callType || 'voice',
      callStatus: 'declined',
      senderID:   myID,
      receiverID: data.callerID,
      status:     'sent',
      timestamp:  Date.now()
    }).catch(() => {});

    setTimeout(async () => {
      await remove(ref(db, 'calls/' + myID)).catch(() => {});
      if (data.callID) await remove(ref(db, 'calls/' + data.callID)).catch(() => {});
    }, 1500);
  } catch (e) { console.error('Decline error:', e); }
}

// ─── RINGTONE ─────────────────────────────────────────────────────────────────
// FIX: Removed soundjay.com external dependency — use Web Audio API generated
// dual-tone ring directly (same 440+480 Hz pattern as chat.html).
let _audioCtx  = null;
let _ringNodes = [];

function playRingtone() {
  stopRingtone();
  _playTone();
}

function _playTone() {
  try {
    _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    let _ringing = true;

    const playBurst = () => {
      if (!_audioCtx || !_ringing) return;
      const gain = _audioCtx.createGain();
      gain.gain.setValueAtTime(0.18, _audioCtx.currentTime);
      gain.connect(_audioCtx.destination);

      [440, 480].forEach(freq => {
        const osc = _audioCtx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = freq;
        osc.connect(gain);
        osc.start(_audioCtx.currentTime);
        osc.stop(_audioCtx.currentTime + 2);
        _ringNodes.push(osc);
      });
      _ringNodes.push(gain);
    };

    playBurst();
    // Ring 2s on, 4s off
    const id = setInterval(() => {
      if (!_audioCtx || !_ringing) { clearInterval(id); return; }
      playBurst();
    }, 6000);
    _ringNodes.push({ stop: () => { _ringing = false; clearInterval(id); } });
  } catch (e) {}
}

function stopRingtone() {
  if (ringtone) { ringtone.pause(); ringtone.currentTime = 0; ringtone = null; }
  _ringNodes.forEach(n => { try { n.stop && n.stop(); n.disconnect && n.disconnect(); } catch (e) {} });
  _ringNodes = [];
  if (_audioCtx) { _audioCtx.close().catch(() => {}); _audioCtx = null; }
}

// Handle SW "Decline" action from OS call notification
navigator.serviceWorker.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'DECLINE_CALL_FROM_NOTIFICATION') {
    if (activeCallData && activeCallData.callerID === event.data.callerID) declineCall();
  }
});
