/**
 * pwa.js — Install prompt handler & Service Worker Registration
 * Must be loaded in <head> so beforeinstallprompt is captured before body parses.
 * Uses window._pwaPrompt so it's accessible from any inline script.
 *
 * FIX: Creates a floating install button dynamically so it works on every page,
 * not just chats.html where #installAppBtn exists in markup.
 * FIX: Added service worker registration for /sschat/ subdirectory
 */

window._pwaPrompt = null;

// ========== SERVICE WORKER REGISTRATION ==========
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    // Register service worker with correct scope for GitHub Pages subdirectory
    navigator.serviceWorker.register('/sschat/sw.js', { scope: '/sschat/' })
      .then(registration => {
        console.log('✅ Service Worker registered with scope:', registration.scope);
        
        // Check for updates
        registration.addEventListener('updatefound', () => {
          const newWorker = registration.installing;
          console.log('🔄 Service Worker update found!');
          
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              console.log('📦 Update available - please refresh');
              // Optional: Show update notification to user
              const updateNotification = document.createElement('div');
              updateNotification.innerHTML = `
                <div style="position:fixed; bottom:20px; left:50%; transform:translateX(-50%); 
                            background:#4F46E5; color:white; padding:12px 20px; border-radius:12px; 
                            z-index:10000; box-shadow:0 4px 12px rgba(0,0,0,0.3); cursor:pointer;">
                  New version available! Click to update 🔄
                </div>
              `;
              updateNotification.onclick = () => window.location.reload();
              document.body.appendChild(updateNotification);
              setTimeout(() => updateNotification.remove(), 5000);
            }
          });
        });
      })
      .catch(error => {
        console.error('❌ Service Worker registration failed:', error);
      });
      
    // Handle controller changes (when SW updates)
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      console.log('🔄 Service Worker controller changed, reloading...');
      window.location.reload();
    });
  });
}

// ========== PWA INSTALL PROMPT ==========
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  window._pwaPrompt = e;
  // Delay until DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _ensureInstallBtn);
  } else {
    _ensureInstallBtn();
  }
  showInstallButton();
});

window.addEventListener('appinstalled', () => {
  console.log('✅ ASChat installed successfully!');
  window._pwaPrompt = null;
  hideInstallButton();
  
  // Optional: Show thank you message
  if (document.readyState === 'complete') {
    setTimeout(() => {
      const thanks = document.createElement('div');
      thanks.innerHTML = `
        <div style="position:fixed; bottom:20px; left:50%; transform:translateX(-50%); 
                    background:#10B981; color:white; padding:12px 20px; border-radius:12px; 
                    z-index:10000; box-shadow:0 4px 12px rgba(0,0,0,0.3);">
          ✅ ASChat installed! Check your home screen 🎉
        </div>
      `;
      document.body.appendChild(thanks);
      setTimeout(() => thanks.remove(), 3000);
    }, 500);
  }
});

function _ensureInstallBtn() {
  // If the page already has a dedicated #installAppBtn in the header, use it.
  if (document.getElementById('installAppBtn')) return;

  // Otherwise inject a floating install button (used on pages without a header button)
  const existing = document.getElementById('_pwaFloatBtn');
  if (existing) return;

  const btn = document.createElement('button');
  btn.id = '_pwaFloatBtn';
  btn.title = 'Install App';
  btn.setAttribute('aria-label', 'Install ASChat as an app');
  btn.onclick = installApp;
  btn.innerHTML = '<i class="fa-solid fa-download"></i><span>Install App</span>';
  btn.style.cssText = [
    'position:fixed',
    'bottom:80px',
    'right:16px',
    'z-index:9999',
    'display:none',
    'align-items:center',
    'gap:6px',
    'padding:10px 16px',
    'background:linear-gradient(135deg,#4F46E5,#7C3AED)',
    'color:#fff',
    'border:none',
    'border-radius:24px',
    'font-size:14px',
    'font-weight:600',
    'cursor:pointer',
    'box-shadow:0 4px 16px rgba(79,70,229,0.45)',
    'transition:transform .15s,box-shadow .15s',
  ].join(';');
  btn.addEventListener('mouseover',  () => { btn.style.transform = 'scale(1.04)'; });
  btn.addEventListener('mouseout',   () => { btn.style.transform = 'scale(1)'; });
  document.body.appendChild(btn);
}

function showInstallButton() {
  // Named #installAppBtn in header (chats.html)
  const headerBtn = document.getElementById('installAppBtn');
  if (headerBtn) {
    headerBtn.style.display = 'flex';
    headerBtn.classList.add('install-btn-pop');
    return;
  }
  // Floating fallback
  const floatBtn = document.getElementById('_pwaFloatBtn');
  if (floatBtn) floatBtn.style.display = 'flex';
}

function hideInstallButton() {
  const headerBtn = document.getElementById('installAppBtn');
  if (headerBtn) headerBtn.style.display = 'none';
  const floatBtn = document.getElementById('_pwaFloatBtn');
  if (floatBtn) floatBtn.style.display = 'none';
}

window.installApp = async function () {
  if (!window._pwaPrompt) return;
  window._pwaPrompt.prompt();
  const { outcome } = await window._pwaPrompt.userChoice;
  window._pwaPrompt = null;
  if (outcome === 'accepted') hideInstallButton();
};

// ========== HELPER FUNCTIONS FOR OTHER SCRIPTS ==========
// These functions help sync state with service worker

window.pwaAPI = {
  // Update unread state in service worker
  updateUnreadState: (totalUnread, unreadChats, userName) => {
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({
        type: 'UPDATE_UNREAD_STATE',
        totalUnread: totalUnread,
        unreadChats: unreadChats,
        userName: userName,
        lastActiveAt: Date.now()
      });
    }
  },
  
  // Notify service worker that user is active
  notifyUserActive: () => {
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({
        type: 'USER_ACTIVE'
      });
    }
  },
  
  // Check if app is running as installed PWA
  isInstalled: () => {
    return window.matchMedia('(display-mode: standalone)').matches || 
           window.navigator.standalone === true;
  },
  
  // Clear notifications for a specific chat
  clearChatNotifications: (otherID) => {
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({
        type: 'CLEAR_NOTIFICATIONS',
        otherID: otherID
      });
    }
  }
};

// Listen for messages from service worker
if (navigator.serviceWorker) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    console.log('📨 Message from service worker:', event.data);
    
    // Handle call decline from notification
    if (event.data.type === 'DECLINE_CALL_FROM_NOTIFICATION') {
      // Dispatch custom event for other scripts to handle
      window.dispatchEvent(new CustomEvent('sw-call-decline', { 
        detail: { callerID: event.data.callerID } 
      }));
    }
  });
}

// Log when running as installed PWA
if (window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true) {
  console.log('🎯 ASChat running as installed PWA');
  document.body.classList.add('pwa-installed-mode');
                         }
