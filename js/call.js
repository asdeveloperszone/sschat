import { db } from './firebase-config.js';
import {
  ref, set, get, onValue, remove, push, update, off, onChildAdded
} from "https://www.gstatic.com/firebasejs/12.9.0/firebase-database.js";

// ─── ICE SERVER CONFIG ────────────────────────────────────────────────────────
const STUN_ONLY = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ]
};
let ICE_SERVERS = STUN_ONLY;

async function fetchIceServers() {
  try {
    // Fetch TURN credentials via our Railway backend — keeps the Metered API key
    // out of client-side source code where anyone could steal and abuse it.
    const res = await fetch(
      'https://aschatbackend-production.up.railway.app/api/ice-servers'
    );
    if (!res.ok) throw new Error('ICE fetch failed: ' + res.status);
    const servers = await res.json();
    if (!Array.isArray(servers) || servers.length === 0) throw new Error('Empty server list');
    ICE_SERVERS = {
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, ...servers]
    };
    console.log('[Call] ICE servers ready:', ICE_SERVERS.iceServers.length, 'servers (incl. TURN)');
  } catch (err) {
    console.warn('[Call] TURN fetch failed, falling back to STUN only:', err.message);
    ICE_SERVERS = STUN_ONLY;
  }
}

// ─── STATE ────────────────────────────────────────────────────────────────────
let peerConnection      = null;
let localStream         = null;
let callType            = null;   // 'voice' | 'video'
let callRole            = null;   // 'caller' | 'receiver'
let myID                = null;
let otherID             = null;
let otherName           = null;
let callTimerInterval   = null;
let callSeconds         = 0;
let onCallEndedCallback = null;
let isMuted             = false;
let isCamOff            = false;
let isSpeakerOn         = false;
let activeListeners     = [];
let incomingCallData    = null;

// FIX (ICE duplicate): track which ICE candidate keys we already added
// so onChildAdded never adds the same candidate twice
const addedIceKeys = new Set();

// FIX (double call-message): guard so endCall only saves one message
let callMessageSaved = false;

// FIX (listener leak): track event type alongside ref+cb so cleanupCallState
// can call off() with the correct event type ('value' vs 'child_added').
// Previously all listeners were unsubscribed with 'value', which silently
// failed to remove onChildAdded ICE listeners — causing memory leaks and
// ghost candidates being applied to future calls.
function addListener(listenerRef, cb, eventType = 'value') {
  activeListeners.push({ ref: listenerRef, cb, eventType });
}

// ─── INIT ─────────────────────────────────────────────────────────────────────
export function initCall(uid, oid, name, onEnd) {
  myID = uid; otherID = oid; otherName = name; onCallEndedCallback = onEnd;
  fetchIceServers();
  listenForIncomingCall();
}

// ─── PRESENCE ─────────────────────────────────────────────────────────────────
export function setOnline(uid) {
  import("https://www.gstatic.com/firebasejs/12.9.0/firebase-database.js")
    .then(({ onDisconnect }) => {
      const presRef = ref(db, 'presence/' + uid);
      set(presRef, 'online').catch(() => {});
      onDisconnect(presRef).set('offline').catch(() => {});
    }).catch(() => {});
}

// ─── LISTEN FOR INCOMING (chat page) ─────────────────────────────────────────
function listenForIncomingCall() {
  const callRef = ref(db, 'calls/' + myID);
  const sub = onValue(callRef, async (snap) => {
    if (!snap.exists()) {
      if (incomingCallData) { hideAllCallScreens(); incomingCallData = null; }
      return;
    }
    const data = snap.val();
    if (!data.callerID) return;
    if (data.callerID === myID) return;
    if (incomingCallData) return;

    if (data.status === 'declined' || data.status === 'ended' || data.status === 'missed') {
      if (peerConnection || localStream) {
        // FIX: only save if we haven't already
        if (!callMessageSaved) saveCallMessage(callSeconds > 0 ? 'ended' : 'missed');
        cleanupCallState();
        if (onCallEndedCallback) onCallEndedCallback();
      } else {
        hideAllCallScreens();
      }
      incomingCallData = null;
      return;
    }

    incomingCallData = data;
    showIncomingCallScreen(data);
  });
  addListener(callRef, sub, 'value');
}

// ─── START OUTGOING CALL ──────────────────────────────────────────────────────
export async function startCall(type) {
  callType = type; callRole = 'caller'; callMessageSaved = false;

  try {
    const [, stream] = await Promise.all([
      fetchIceServers(),
      navigator.mediaDevices.getUserMedia({ video: type === 'video', audio: true })
    ]);
    localStream = stream;

    showOutgoingCallScreen(type);

    const localVideoOut = document.getElementById('localVideoOut');
    if (localVideoOut && type === 'video') {
      localVideoOut.srcObject = localStream;
      localVideoOut.style.display = 'block';
    }

    createPeerConnection();

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    await set(ref(db, `calls/${otherID}`), {
      callerID:   myID,
      callerName: localStorage.getItem('aschat_name') || 'User',
      callType:   type,
      type:       type,
      status:     'ringing',
      offer:      { type: offer.type, sdp: offer.sdp },
      timestamp:  Date.now()
    });

    const answerRef = ref(db, `calls/${otherID}/answer`);
    const answerSub = onValue(answerRef, async (snap) => {
      if (snap.exists() && peerConnection && !peerConnection.currentRemoteDescription) {
        try {
          await peerConnection.setRemoteDescription(new RTCSessionDescription(snap.val()));
          showActiveCallScreen();
          startCallTimer();
        } catch (e) { console.error('Set remote description error:', e); }
      }
    });
    addListener(answerRef, answerSub, 'value');

    listenForIceCandidates(otherID, otherID);
    playRingtone();
    // callMessageSaved stays false — endCall will save the final 'ended'/'declined' message
  } catch (err) {
    console.error('Call Start Error:', err);
    handleCallError(err);
  }
}

// ─── ACCEPT CALL ──────────────────────────────────────────────────────────────
export async function acceptCall() {
  let callData = incomingCallData;
  if (!callData) {
    try {
      const snap = await get(ref(db, `calls/${myID}`));
      if (!snap.exists()) { console.warn('No incoming call data'); return; }
      callData = snap.val();
      incomingCallData = callData;
    } catch (e) { console.error('acceptCall fetch error:', e); return; }
  }

  callType = callData.callType || callData.type || 'voice';
  callRole = 'receiver';
  callMessageSaved = false;
  stopRingtone();

  try {
    const [, stream] = await Promise.all([
      fetchIceServers(),
      navigator.mediaDevices.getUserMedia({ video: callType === 'video', audio: true })
    ]);
    localStream = stream;

    createPeerConnection();
    await peerConnection.setRemoteDescription(new RTCSessionDescription(callData.offer));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);

    await update(ref(db, `calls/${myID}`), {
      answer: { type: answer.type, sdp: answer.sdp },
      status: 'accepted'
    });

    listenForIceCandidates(myID, callData.callerID);
    showActiveCallScreen();
    startCallTimer();
    incomingCallData = null;
  } catch (err) {
    console.error('Call Accept Error:', err);
    handleCallError(err);
  }
}

// ─── DECLINE CALL ─────────────────────────────────────────────────────────────
export async function declineCall() {
  stopRingtone();
  hideAllCallScreens();

  try {
    await update(ref(db, `calls/${myID}`), { status: 'declined' });
    const callData = incomingCallData || {};
    const chatKey  = [myID, otherID].sort().join('_');
    const isVideo  = (callData.callType || callData.type) === 'video';
    // FIX: Font Awesome icon classes instead of emoji characters stored in text
    await push(ref(db, 'messages/' + chatKey), {
      text:       isVideo ? 'Video call — Call declined' : 'Voice call — Call declined',
      msgType:    'call',
      callType:   callData.callType || callData.type || 'voice',
      callStatus: 'declined',
      senderID:   myID,
      receiverID: otherID,
      status:     'sent',
      timestamp:  Date.now()
    }).catch(() => {});
    setTimeout(() => remove(ref(db, `calls/${myID}`)).catch(() => {}), 1500);
  } catch (e) { console.error('Decline error:', e); }

  incomingCallData = null;
}

// ─── END ACTIVE CALL ──────────────────────────────────────────────────────────
export function endCall() {
  if (!callMessageSaved) {
    // If caller ends before answer: it's a missed call for the other party.
    // If receiver ends or connection drops after timer started: it's ended.
    // If receiver ends before timer: declined.
    let status;
    if (callSeconds > 0) {
      status = 'ended';
    } else if (callRole === 'caller') {
      // Caller hung up before receiver answered — missed for the other side
      status = 'missed';
    } else {
      status = 'declined';
    }
    saveCallMessage(status, status === 'ended' ? formatDuration(callSeconds) : null);
    callMessageSaved = true;
  }

  stopRingtone();
  if (otherID) update(ref(db, `calls/${otherID}`), { status: 'ended' }).catch(() => {});
  cleanupCallState();
  if (onCallEndedCallback) onCallEndedCallback();
}

// ─── ICE CANDIDATES ──────────────────────────────────────────────────────────
// FIX: switched from onValue → onChildAdded so each candidate is processed
// exactly once, preventing duplicate addIceCandidate() calls on every update.
function listenForIceCandidates(callPath, fromID) {
  const iceRef = ref(db, `calls/${callPath}/iceCandidates/${fromID}`);
  const sub = onChildAdded(iceRef, (childSnap) => {
    const key = childSnap.key;
    // FIX: deduplicate by key in case onChildAdded fires twice (e.g. reconnect)
    if (addedIceKeys.has(key) || !peerConnection) return;
    addedIceKeys.add(key);
    peerConnection.addIceCandidate(new RTCIceCandidate(childSnap.val())).catch(() => {});
  });
  // FIX: use 'child_added' event type so off() actually removes this listener
  addListener(iceRef, sub, 'child_added');
}

// ─── PEER CONNECTION ──────────────────────────────────────────────────────────
function createPeerConnection() {
  if (peerConnection) peerConnection.close();
  addedIceKeys.clear(); // FIX: reset per-call ICE dedup set
  peerConnection = new RTCPeerConnection(ICE_SERVERS);

  localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

  peerConnection.ontrack = (event) => {
    if (!event.streams[0]) return;
    if (callType === 'video') {
      const rv = document.getElementById('remoteVideo');
      if (rv) rv.srcObject = event.streams[0];
    } else {
      const ra = document.getElementById('remoteAudio');
      if (ra) { ra.srcObject = event.streams[0]; ra.play().catch(() => {}); }
    }
  };

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      const targetPath = callRole === 'caller' ? otherID : myID;
      push(ref(db, `calls/${targetPath}/iceCandidates/${myID}`), event.candidate.toJSON()).catch(() => {});
    }
  };

  peerConnection.oniceconnectionstatechange = () => {
    console.log('[Call] ICE state:', peerConnection.iceConnectionState);
  };

  peerConnection.onconnectionstatechange = () => {
    const state = peerConnection.connectionState;
    console.log('[Call] Connection state:', state);
    // FIX: only trigger endCall for unexpected drops — if callMessageSaved is
    // already true the user already ended the call manually, so skip to avoid
    // double cleanup / double call messages
    if (['disconnected', 'failed'].includes(state) && !callMessageSaved) endCall();
  };
}

// ─── CLEANUP ──────────────────────────────────────────────────────────────────
function cleanupCallState() {
  // FIX: use the stored eventType for each listener — 'value' listeners and
  // 'child_added' listeners need different off() calls or they won't unsubscribe
  activeListeners.forEach(l => off(l.ref, l.eventType || 'value', l.cb));
  activeListeners = [];
  addedIceKeys.clear();
  callMessageSaved = false;

  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  if (peerConnection) { peerConnection.close(); peerConnection = null; }

  clearInterval(callTimerInterval);
  callTimerInterval = null; callSeconds = 0;
  isMuted = false; isCamOff = false; isSpeakerOn = false;
  _currentFacingMode = 'user';

  if (_speakerSource) { try { _speakerSource.disconnect(); } catch(e){} _speakerSource = null; }
  if (_speakerAudioCtx) { _speakerAudioCtx.close().catch(()=>{}); _speakerAudioCtx = null; }

  if (myID)   remove(ref(db, `calls/${myID}`)).catch(() => {});
  if (otherID) setTimeout(() => remove(ref(db, `calls/${otherID}`)).catch(() => {}), 2000);

  hideAllCallScreens();

  const rv = document.getElementById('remoteVideo');
  const lv = document.getElementById('localVideo');
  const lo = document.getElementById('localVideoOut');
  const ra = document.getElementById('remoteAudio');
  if (rv) rv.srcObject = null;
  if (lv) lv.srcObject = null;
  if (lo) { lo.srcObject = null; lo.style.display = 'none'; }
  if (ra) { ra.srcObject = null; ra.pause(); }
}

// ─── CALL TIMER ───────────────────────────────────────────────────────────────
function startCallTimer() {
  if (callTimerInterval) return;
  callSeconds = 0;
  callTimerInterval = setInterval(() => {
    callSeconds++;
    const el = document.getElementById('callTimer');
    if (el) el.textContent = formatDuration(callSeconds);
  }, 1000);
}

function formatDuration(sec) {
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
}

// ─── UI SCREENS ───────────────────────────────────────────────────────────────
function hideAllCallScreens() {
  ['outgoingCallScreen', 'incomingCallScreen', 'activeCallScreen'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  stopRingtone();
}

function showOutgoingCallScreen(type) {
  hideAllCallScreens();
  const screen = document.getElementById('outgoingCallScreen');
  if (!screen) return;

  const nameEl = document.getElementById('outCallName');
  if (nameEl) nameEl.textContent = otherName || 'Unknown';

  const avatarEl = document.getElementById('outCallAvatar');
  if (avatarEl) {
    const contact = (JSON.parse(localStorage.getItem('aschat_contacts') || '{}'))[otherID];
    avatarEl.innerHTML = contact && contact.photo
      ? `<img src="${contact.photo}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" />`
      : (otherName || 'U').charAt(0).toUpperCase();
  }

  // FIX: Font Awesome icons instead of emoji
  const statusEl = document.getElementById('outCallStatus');
  if (statusEl) statusEl.innerHTML = type === 'video'
    ? '<i class="fa-solid fa-video" style="margin-right:6px;"></i>Video Calling...'
    : '<i class="fa-solid fa-phone" style="margin-right:6px;"></i>Voice Calling...';

  screen.style.display = 'flex';
}

function showIncomingCallScreen(data) {
  hideAllCallScreens();
  const screen = document.getElementById('incomingCallScreen');
  if (!screen) return;

  const contacts   = JSON.parse(localStorage.getItem('aschat_contacts') || '{}');
  const contact    = contacts[data.callerID];
  const callerName = contact ? contact.name : (data.callerName || 'Unknown');
  const isVideo    = (data.callType || data.type) === 'video';

  const nameEl = document.getElementById('inCallName');
  if (nameEl) nameEl.textContent = callerName;

  // FIX: Font Awesome icons instead of emoji
  const typeLabel = document.getElementById('inCallTypeLabel');
  if (typeLabel) typeLabel.innerHTML = isVideo
    ? '<i class="fa-solid fa-video" style="margin-right:6px;"></i>Incoming Video Call'
    : '<i class="fa-solid fa-phone" style="margin-right:6px;"></i>Incoming Voice Call';

  const avatarEl = document.getElementById('inCallAvatar');
  if (avatarEl) {
    avatarEl.innerHTML = contact && contact.photo
      ? `<img src="${contact.photo}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" />`
      : callerName.charAt(0).toUpperCase();
  }

  screen.style.display = 'flex';
  playRingtone();
}

function showActiveCallScreen() {
  hideAllCallScreens();
  const screen = document.getElementById('activeCallScreen');
  if (!screen) return;

  const nameEl = document.getElementById('activeCallName');
  if (nameEl) nameEl.textContent = otherName || 'Unknown';

  const avatarEl = document.getElementById('activeCallAvatar');
  if (avatarEl) {
    const contact = (JSON.parse(localStorage.getItem('aschat_contacts') || '{}'))[otherID];
    avatarEl.innerHTML = contact && contact.photo
      ? `<img src="${contact.photo}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" />`
      : (otherName || 'U').charAt(0).toUpperCase();
  }

  const camBtn    = document.getElementById('camBtn');
  const flipBtn   = document.getElementById('flipBtn');
  const remoteVid = document.getElementById('remoteVideo');
  const localVid  = document.getElementById('localVideo');

  if (camBtn)    camBtn.style.display    = callType === 'video' ? 'flex' : 'none';
  if (flipBtn)   flipBtn.style.display   = callType === 'video' ? 'flex' : 'none';
  if (remoteVid) remoteVid.style.display = callType === 'video' ? 'block' : 'none';
  if (localVid) {
    localVid.srcObject = localStream;
    localVid.style.display = callType === 'video' ? 'block' : 'none';
  }

  screen.style.display = 'flex';
}

// ─── TOGGLE MUTE ──────────────────────────────────────────────────────────────
export function toggleMute() {
  if (!localStream) return;
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
  const btn = document.getElementById('muteBtn');
  if (btn) btn.innerHTML = isMuted
    ? '<i class="fa-solid fa-microphone-slash"></i><span>Unmute</span>'
    : '<i class="fa-solid fa-microphone"></i><span>Mute</span>';
}

// ─── TOGGLE SPEAKER ───────────────────────────────────────────────────────────
let _speakerAudioCtx = null;
let _speakerSource   = null;

export function toggleSpeaker() {
  isSpeakerOn = !isSpeakerOn;
  const btn = document.getElementById('speakerBtn');
  if (btn) {
    btn.innerHTML = isSpeakerOn
      ? '<i class="fa-solid fa-volume-xmark"></i><span>Speaker</span>'
      : '<i class="fa-solid fa-volume-high"></i><span>Speaker</span>';
    btn.classList.toggle('active', isSpeakerOn);
  }

  const audioEl = callType === 'video'
    ? document.getElementById('remoteVideo')
    : document.getElementById('remoteAudio');
  if (!audioEl) return;

  // Try setSinkId first (desktop Chrome/Edge)
  if (audioEl.setSinkId) {
    audioEl.setSinkId(isSpeakerOn ? 'default' : '').catch(() => {});
    return;
  }

  // FIX: Web Audio API fallback — guard against double createMediaElementSource
  // which throws InvalidStateError when the same element is already attached
  try {
    if (isSpeakerOn) {
      if (!_speakerAudioCtx) {
        _speakerAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (_speakerAudioCtx.state === 'suspended') _speakerAudioCtx.resume();
      // FIX: only create source if we don't have one already
      if (!_speakerSource) {
        _speakerSource = _speakerAudioCtx.createMediaElementSource(audioEl);
      }
      _speakerSource.connect(_speakerAudioCtx.destination);
    } else {
      if (_speakerSource) {
        _speakerSource.disconnect();
        // Do NOT null _speakerSource — element is already captured; re-use on next toggle
      }
      // Reconnect to default output by re-assigning srcObject
      audioEl.srcObject = audioEl.srcObject;
    }
  } catch (e) {
    console.warn('[Call] Speaker toggle fallback failed:', e.message);
  }
}

// ─── TOGGLE CAMERA ────────────────────────────────────────────────────────────
export function toggleCamera() {
  if (!localStream || callType !== 'video') return;
  isCamOff = !isCamOff;
  localStream.getVideoTracks().forEach(t => t.enabled = !isCamOff);
  const btn = document.getElementById('camBtn');
  if (btn) btn.innerHTML = isCamOff
    ? '<i class="fa-solid fa-video-slash"></i><span>Camera</span>'
    : '<i class="fa-solid fa-video"></i><span>Camera</span>';
}

// ─── FLIP CAMERA ──────────────────────────────────────────────────────────────
let _currentFacingMode = 'user';

export async function flipCamera() {
  if (!localStream || callType !== 'video' || !peerConnection) return;
  _currentFacingMode = _currentFacingMode === 'user' ? 'environment' : 'user';

  try {
    localStream.getVideoTracks().forEach(t => t.stop());
    const newStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: _currentFacingMode }, audio: false
    });
    const newVideoTrack = newStream.getVideoTracks()[0];
    const sender = peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
    if (sender) await sender.replaceTrack(newVideoTrack);
    localStream.getVideoTracks().forEach(t => localStream.removeTrack(t));
    localStream.addTrack(newVideoTrack);
    const lv = document.getElementById('localVideo');
    if (lv) lv.srcObject = localStream;
    const btn = document.getElementById('flipBtn');
    if (btn) btn.classList.toggle('active', _currentFacingMode === 'environment');
  } catch (err) {
    console.warn('[Call] Camera flip failed:', err.message);
    _currentFacingMode = _currentFacingMode === 'user' ? 'environment' : 'user';
  }
}

// ─── RINGTONE ─────────────────────────────────────────────────────────────────
// FIX: Use Web Audio API generated tone (window._playRingtone) instead of a
// third-party <audio> src that may be blocked or unavailable.
function playRingtone() {
  if (window._playRingtone) {
    window._playRingtone();
  } else {
    // Fallback: try the <audio> element if the inline script hasn't run yet
    const ringtone = document.getElementById('ringtone');
    if (ringtone && ringtone.src) ringtone.play().catch(() => {});
  }
}
function stopRingtone() {
  if (window._stopRingtone) {
    window._stopRingtone();
  } else {
    const ringtone = document.getElementById('ringtone');
    if (ringtone) { ringtone.pause(); ringtone.currentTime = 0; }
  }
}

// ─── ERROR HANDLER ────────────────────────────────────────────────────────────
function handleCallError(err) {
  let msg = 'Call failed.';
  if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError')
    msg = 'Camera/microphone permission denied. Please allow access and try again.';
  else if (err.name === 'NotFoundError')
    msg = 'No camera or microphone found.';
  else if (err.name === 'NotReadableError')
    msg = 'Camera or microphone is already in use by another app.';
  alert(msg);
  cleanupCallState();
  if (onCallEndedCallback) onCallEndedCallback();
}

// ─── SAVE CALL MESSAGE ────────────────────────────────────────────────────────
async function saveCallMessage(status, duration = null) {
  if (!myID || !otherID) return;
  const chatKey  = [myID, otherID].sort().join('_');
  const isVideo  = callType === 'video';
  // FIX: plain text only — icon rendering is handled by chat.js renderMessage using FA
  const typeStr  = isVideo ? 'Video' : 'Voice';
  const statStr  = status === 'ended'    ? 'Call ended'
                 : status === 'declined' ? 'Call declined'
                 : status === 'missed'   ? 'Missed call'
                 : 'Call';
  const text     = `${typeStr} call — ${statStr}${duration && status === 'ended' ? ' (' + duration + ')' : ''}`;
  try {
    await push(ref(db, 'messages/' + chatKey), {
      text,
      msgType:    'call',
      callType:   callType || 'voice',
      callStatus: status,
      senderID:   myID,
      receiverID: otherID,
      timestamp:  Date.now(),
      status:     'sent'
    });
  } catch (e) {}
}
