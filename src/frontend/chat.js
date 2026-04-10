// ========================================
// VENTO — Chat Client Logic
// ========================================

(function () {
  'use strict';

  // --- State ---
  const callsign = sessionStorage.getItem('vento_callsign');
  const mode = sessionStorage.getItem('vento_mode');
  const fingerprint = sessionStorage.getItem('vento_fingerprint');

  if (!callsign) {
    window.location.href = '/';
    return;
  }

  // --- DOM Elements ---
  const messagesContainer = document.getElementById('chat-messages');
  const chatInput = document.getElementById('chat-input');
  const btnSend = document.getElementById('btn-send');
  const btnEnd = document.getElementById('btn-end-session');
  const callsignEl = document.getElementById('chat-callsign');
  const statusDot = document.getElementById('chat-status-dot');
  const statusText = document.getElementById('chat-status-text');
  const typingIndicator = document.getElementById('typing-indicator');
  const connectionBar = document.getElementById('connection-bar');
  const toast = document.getElementById('toast');

  callsignEl.textContent = callsign;

  // --- Socket.IO Connection ---
  const socket = io({
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionAttempts: 20,
  });

  // --- Connection Events ---
  socket.on('connect', () => {
    connectionBar.classList.remove('show');
    btnSend.disabled = false;

    if (mode === 'rejoin') {
      socket.emit('rejoin-session', { callsign, fingerprint });
    } else {
      socket.emit('start-session', { callsign, fingerprint });
    }

    // Update mode so reconnections use rejoin
    sessionStorage.setItem('vento_mode', 'rejoin');
  });

  socket.on('disconnect', () => {
    connectionBar.textContent = 'Connection lost. Reconnecting...';
    connectionBar.className = 'connection-bar show';
    btnSend.disabled = true;
  });

  socket.on('reconnecting', () => {
    connectionBar.textContent = 'Reconnecting...';
    connectionBar.className = 'connection-bar show reconnecting';
  });

  // --- Session Events ---
  socket.on('session-started', (data) => {
    updateStatus(data.status);
    addSystemMessage('Session started. You are anonymous.');
  });

  socket.on('session-rejoined', (data) => {
    updateStatus(data.status);

    // Load message history
    if (data.messages && data.messages.length > 0) {
      // Clear existing messages except the system welcome
      const systemMsg = messagesContainer.querySelector('.message.system');
      messagesContainer.innerHTML = '';
      if (systemMsg) messagesContainer.appendChild(systemMsg);

      for (const msg of data.messages) {
        addMessage(msg.sender, msg.content, msg.timestamp, false);
      }
    }

    addSystemMessage('Reconnected to session.');
  });

  socket.on('session-closed', (data) => {
    addSystemMessage(data.reason || 'Session closed.');
    btnSend.disabled = true;
    chatInput.disabled = true;
    chatInput.placeholder = 'Session ended';
  });

  // --- Messages ---
  socket.on('message', (data) => {
    addMessage(data.sender, data.content, data.timestamp, true);
    hideTyping();
  });

  socket.on('error-msg', (data) => {
    showToast(data.message, 'error');
  });

  // --- Owner Status ---
  socket.on('owner-status', (data) => {
    updateStatus(data.status);
  });

  // --- Typing ---
  let typingTimeout = null;

  socket.on('owner-typing', () => {
    showTyping();
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(hideTyping, 3000);
  });

  // Emit typing when the user types
  let lastTypingEmit = 0;
  chatInput.addEventListener('input', () => {
    const now = Date.now();
    if (now - lastTypingEmit > 2000) {
      socket.emit('typing');
      lastTypingEmit = now;
    }

    // Auto-resize textarea
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';

    // Enable/disable send button
    btnSend.disabled = !chatInput.value.trim();
  });

  // --- Send Message ---
  function sendMessage() {
    const content = chatInput.value.trim();
    if (!content) return;

    socket.emit('send-message', { content });
    chatInput.value = '';
    chatInput.style.height = 'auto';
    btnSend.disabled = true;
  }

  btnSend.addEventListener('click', sendMessage);

  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // --- End Session ---
  btnEnd.addEventListener('click', () => {
    if (confirm('End this session? You can rejoin later using your callsign.')) {
      socket.emit('end-session');
      sessionStorage.removeItem('vento_callsign');
      sessionStorage.removeItem('vento_mode');
      localStorage.removeItem('vento_callsign');
      window.location.href = '/';
    }
  });

  // --- UI Helpers ---
  function addMessage(sender, content, timestamp, animate = true) {
    const msgEl = document.createElement('div');
    msgEl.className = `message ${sender}`;
    if (!animate) msgEl.style.animation = 'none';

    const time = timestamp ? new Date(timestamp) : new Date();
    const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    msgEl.innerHTML = `
      <div class="message-sender">${sender === 'kevin' ? 'Kevin' : 'You'}</div>
      <div class="message-content">${escapeHtml(content)}</div>
      <div class="message-time">${timeStr}</div>
    `;

    messagesContainer.appendChild(msgEl);
    scrollToBottom();

    // Play notification sound for incoming messages
    if (sender === 'kevin' && animate) {
      playNotificationSound();
    }
  }

  function addSystemMessage(text) {
    const msgEl = document.createElement('div');
    msgEl.className = 'message system';
    msgEl.innerHTML = `<span class="message-content">${escapeHtml(text)}</span>`;
    messagesContainer.appendChild(msgEl);
    scrollToBottom();
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    });
  }

  function updateStatus(status) {
    const isOnline = status === 'online';
    statusDot.className = `status-dot ${isOnline ? 'online' : 'offline'}`;
    statusText.textContent = `Kevin is ${isOnline ? 'online' : 'offline'}`;
  }

  function showTyping() {
    typingIndicator.classList.add('show');
    scrollToBottom();
  }

  function hideTyping() {
    typingIndicator.classList.remove('show');
  }

  function showToast(message, type = 'error') {
    toast.textContent = message;
    toast.className = `toast ${type} show`;
    setTimeout(() => toast.classList.remove('show'), 3500);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // --- Notification Sound (subtle) ---
  function playNotificationSound() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.type = 'sine';
      osc.frequency.setValueAtTime(800, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(600, ctx.currentTime + 0.15);

      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);

      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.3);
    } catch (e) { /* Audio not available */ }
  }

  // --- Canvas Background (subtle in chat) ---
  (function initCanvas() {
    const canvas = document.getElementById('bg-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let particles = [];

    function resize() {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    }

    function createParticles() {
      particles = [];
      const count = Math.floor((canvas.width * canvas.height) / 30000); // fewer in chat
      for (let i = 0; i < count; i++) {
        particles.push({
          x: Math.random() * canvas.width,
          y: Math.random() * canvas.height,
          size: Math.random() * 1.5 + 0.3,
          speedX: Math.random() * 0.3 + 0.05,
          speedY: (Math.random() - 0.5) * 0.1,
          opacity: Math.random() * 0.2 + 0.05,
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
      requestAnimationFrame(draw);
    }

    window.addEventListener('resize', () => { resize(); createParticles(); });
    resize();
    createParticles();
    draw();
  })();
})();
