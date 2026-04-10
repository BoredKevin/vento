// ========================================
// VENTO — Landing Page Logic
// Turnstile-first flow: verify → start → callsign → chat
// ========================================

(function () {
  'use strict';

  // --- State ---
  let turnstileToken = null;
  let fingerprint = null;
  let verified = false;

  // --- DOM Elements ---
  const btnStart = document.getElementById('btn-start');
  const btnStartText = document.getElementById('btn-start-text');
  const btnContinue = document.getElementById('btn-continue');
  const rejoinForm = document.getElementById('rejoin-form');
  const rejoinInput = document.getElementById('rejoin-input');
  const btnRejoin = document.getElementById('btn-rejoin');
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const callsignEl = document.getElementById('callsign-value');
  const stepVerify = document.getElementById('step-verify');
  const stepCallsign = document.getElementById('step-callsign');
  const toast = document.getElementById('toast');

  // --- Initialize ---
  async function init() {
    // Check if user already has an active session
    const existingCallsign = localStorage.getItem('vento_callsign');
    if (existingCallsign) {
      // Verify the session is still active
      try {
        const res = await fetch(`/api/session/${encodeURIComponent(existingCallsign)}`);
        const data = await res.json();
        if (data.exists && !data.closed) {
          // Auto-navigate to chat
          sessionStorage.setItem('vento_callsign', existingCallsign);
          sessionStorage.setItem('vento_mode', 'rejoin');
          sessionStorage.setItem('vento_fingerprint', localStorage.getItem('vento_fingerprint') || '');
          window.location.href = '/chat.html';
          return;
        }
      } catch (e) { /* fall through to normal flow */ }
      // Session doesn't exist or is closed — clear
      localStorage.removeItem('vento_callsign');
    }

    await fetchStatus();
    await initFingerprint();
    initTurnstile();
    initCanvas();
    startStatusPolling();
  }

  // --- Fetch owner status ---
  async function fetchStatus() {
    try {
      const res = await fetch('/api/status');
      const data = await res.json();
      updateStatus(data.status);
    } catch (err) { /* ignore */ }
  }

  function updateStatus(status) {
    const isOnline = status === 'online';
    statusDot.className = `status-dot ${isOnline ? 'online' : 'offline'}`;
    statusText.textContent = `Kevin is ${isOnline ? 'online' : 'offline'}`;
  }

  function startStatusPolling() {
    setInterval(fetchStatus, 30000);
  }

  // --- Fingerprint ---
  async function initFingerprint() {
    // Prioritize existing saved fingerprint to ensure absolute persistence per browser
    const stored = localStorage.getItem('vento_fingerprint');
    if (stored) {
      fingerprint = stored;
      return;
    }

    try {
      const fp = await FingerprintJS.load();
      const result = await fp.get();
      fingerprint = result.visitorId;
      localStorage.setItem('vento_fingerprint', fingerprint);
    } catch (err) {
      console.error('Fingerprint failed:', err);
      fingerprint = 'unknown-' + Math.random().toString(36).slice(2);
      localStorage.setItem('vento_fingerprint', fingerprint);
    }
  }

  // --- Turnstile ---
  function initTurnstile() {
    if (typeof turnstile === 'undefined') {
      window.addEventListener('load', () => setTimeout(renderTurnstile, 500));
    } else {
      renderTurnstile();
    }
  }

  function renderTurnstile() {
    if (typeof turnstile === 'undefined') {
      // Fallback for development
      console.warn('Turnstile not available, auto-verifying');
      onTurnstileSuccess('dev-token');
      return;
    }

    turnstile.render('#turnstile-widget', {
      sitekey: '1x00000000000000000000AA',
      callback: onTurnstileSuccess,
      'error-callback': onTurnstileError,
      theme: 'dark',
      size: 'flexible',
    });
  }

  async function onTurnstileSuccess(token) {
    turnstileToken = token;
    try {
      const res = await fetch('/api/verify-turnstile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const data = await res.json();
      if (data.success) {
        verified = true;
        enableControls();
      } else {
        showToast('Verification failed. Please refresh.', 'error');
      }
    } catch (err) {
      showToast('Verification error.', 'error');
    }
  }

  function onTurnstileError() {
    showToast('Captcha error. Please refresh.', 'error');
  }

  function enableControls() {
    btnStart.disabled = false;
    btnStartText.textContent = 'Start Chatting';
    rejoinInput.disabled = false;
    btnRejoin.disabled = false;
    document.getElementById('turnstile-wrapper').style.display = 'none';
  }

  // --- Start Chat (server generates callsign) ---
  btnStart.addEventListener('click', async () => {
    if (!verified) return;

    btnStart.disabled = true;
    btnStartText.textContent = 'Starting...';

    try {
      const res = await fetch('/api/start-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fingerprint }),
      });
      const data = await res.json();

      if (!data.success) {
        showToast(data.error || 'Failed to start session.', 'error');
        btnStart.disabled = false;
        btnStartText.textContent = 'Start Chatting';
        return;
      }

      // Show callsign reveal
      const callsign = data.callsign;
      callsignEl.textContent = callsign;

      // Persist across refreshes
      localStorage.setItem('vento_callsign', callsign);
      sessionStorage.setItem('vento_callsign', callsign);
      sessionStorage.setItem('vento_mode', 'new');
      sessionStorage.setItem('vento_fingerprint', fingerprint);

      // Switch to step 2
      stepVerify.style.display = 'none';
      stepCallsign.style.display = 'block';

    } catch (err) {
      showToast('Failed to start session.', 'error');
      btnStart.disabled = false;
      btnStartText.textContent = 'Start Chatting';
    }
  });

  // --- Continue to Chat ---
  btnContinue.addEventListener('click', () => {
    window.location.href = '/chat.html';
  });

  // --- Rejoin ---
  rejoinForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!verified) return;

    const input = rejoinInput.value.trim();
    if (!input) return;

    try {
      const res = await fetch(`/api/session/${encodeURIComponent(input)}`);
      const data = await res.json();

      if (!data.exists) {
        showToast('Session not found. Check your callsign.', 'error');
        return;
      }
      if (data.closed) {
        showToast('This session has been closed.', 'error');
        return;
      }

      localStorage.setItem('vento_callsign', input);
      sessionStorage.setItem('vento_callsign', input);
      sessionStorage.setItem('vento_mode', 'rejoin');
      sessionStorage.setItem('vento_fingerprint', fingerprint);
      window.location.href = '/chat.html';
    } catch (err) {
      showToast('Failed to check session.', 'error');
    }
  });

  // --- Toast ---
  function showToast(message, type = 'error') {
    toast.textContent = message;
    toast.className = `toast ${type} show`;
    setTimeout(() => toast.classList.remove('show'), 3500);
  }

  // --- Canvas Background (Wind Particles) ---
  function initCanvas() {
    const canvas = document.getElementById('bg-canvas');
    const ctx = canvas.getContext('2d');
    let particles = [];

    function resize() {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    }

    function createParticles() {
      particles = [];
      const count = Math.floor((canvas.width * canvas.height) / 15000);
      for (let i = 0; i < count; i++) {
        particles.push({
          x: Math.random() * canvas.width,
          y: Math.random() * canvas.height,
          size: Math.random() * 2 + 0.5,
          speedX: Math.random() * 0.5 + 0.1,
          speedY: (Math.random() - 0.5) * 0.2,
          opacity: Math.random() * 0.4 + 0.1,
        });
      }
    }

    function draw() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      for (const p of particles) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(124, 58, 237, ${p.opacity})`;
        ctx.fill();
        p.x += p.speedX;
        p.y += p.speedY;
        if (p.x > canvas.width + 5) { p.x = -5; p.y = Math.random() * canvas.height; }
        if (p.y < -5 || p.y > canvas.height + 5) { p.y = Math.random() * canvas.height; }
      }

      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const dx = particles[i].x - particles[j].x;
          const dy = particles[i].y - particles[j].y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < 100) {
            ctx.beginPath();
            ctx.moveTo(particles[i].x, particles[i].y);
            ctx.lineTo(particles[j].x, particles[j].y);
            ctx.strokeStyle = `rgba(124, 58, 237, ${0.06 * (1 - dist / 100)})`;
            ctx.lineWidth = 0.5;
            ctx.stroke();
          }
        }
      }

      requestAnimationFrame(draw);
    }

    window.addEventListener('resize', () => { resize(); createParticles(); });
    resize();
    createParticles();
    draw();
  }

  // --- Boot ---
  init();
})();
