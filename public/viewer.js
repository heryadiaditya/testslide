const $ = (sel) => document.querySelector(sel);
let deck = null;
let current = 0;

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'dev-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function getDeviceId() {
  let id = localStorage.getItem('ppt_secure_device_id');
  if (!id) {
    id = uuid();
    localStorage.setItem('ppt_secure_device_id', id);
  }
  return id;
}

async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request gagal');
  return data;
}

function setStatus(msg, type = '') {
  const el = $('#accessStatus');
  el.className = `status ${type}`;
  el.textContent = msg || '';
}

async function loadDeck() {
  const data = await api('/api/view/deck');
  deck = data.deck;
  $('#deckTitle').textContent = deck.title;
  $('#loginView').classList.add('hidden');
  $('#stageView').classList.remove('hidden');
  renderWatermark(deck.watermark || 'SECURE');

  if (deck.mode === 'video') {
    $('#slideControls').classList.add('hidden');
    $('#slideImg').classList.add('hidden');
    const video = $('#videoPlayer');
    video.classList.remove('hidden');
    video.src = deck.videoUrl;
    video.setAttribute('draggable', 'false');
    return;
  }

  $('#videoPlayer').classList.add('hidden');
  $('#slideImg').classList.remove('hidden');
  $('#slideControls').classList.remove('hidden');
  current = 0;
  showSlide(0);
}

function showSlide(index) {
  if (!deck?.slides?.length) return;
  current = Math.max(0, Math.min(index, deck.slides.length - 1));
  const img = $('#slideImg');
  img.src = deck.slides[current].url;
  $('#counter').textContent = `${current + 1}/${deck.slides.length}`;
  $('#prevBtn').disabled = current === 0;
  $('#nextBtn').disabled = current === deck.slides.length - 1;
}

function renderWatermark(text) {
  const wm = $('#watermark');
  const device = getDeviceId().slice(0, 8).toUpperCase();
  wm.innerHTML = '';
  for (let i = 0; i < 36; i++) {
    const span = document.createElement('span');
    span.textContent = `${text} · ${device}`;
    wm.appendChild(span);
  }
}

$('#accessForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter;
  btn.disabled = true;
  setStatus('Memeriksa kode...');
  const fd = new FormData(e.target);
  try {
    await api('/api/access/verify', {
      method: 'POST',
      body: JSON.stringify({ code: fd.get('code'), deviceId: getDeviceId() })
    });
    setStatus('Kode valid.', 'ok');
    await loadDeck();
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

$('#prevBtn').addEventListener('click', () => showSlide(current - 1));
$('#nextBtn').addEventListener('click', () => showSlide(current + 1));
$('#fullscreenBtn').addEventListener('click', async () => {
  const stage = $('#stage');
  if (!document.fullscreenElement) await stage.requestFullscreen().catch(() => {});
  else await document.exitFullscreen().catch(() => {});
});
$('#logoutAccessBtn').addEventListener('click', async () => {
  await api('/api/access/logout', { method: 'POST' }).catch(() => {});
  location.reload();
});

document.addEventListener('keydown', (e) => {
  const key = e.key.toLowerCase();

  // Kurangi aksi umum untuk copy/save/print/source.
  if ((e.ctrlKey || e.metaKey) && ['s', 'p', 'u', 'c', 'x', 'a'].includes(key)) {
    e.preventDefault();
    return false;
  }
  if (key === 'printscreen') {
    e.preventDefault();
    return false;
  }
  if (key === 'arrowright' || key === 'pagedown' || key === ' ') {
    if (deck?.mode === 'slides') {
      e.preventDefault();
      showSlide(current + 1);
    }
  }
  if (key === 'arrowleft' || key === 'pageup') {
    if (deck?.mode === 'slides') {
      e.preventDefault();
      showSlide(current - 1);
    }
  }
  if (key === 'f') $('#fullscreenBtn').click();
});

for (const eventName of ['contextmenu', 'copy', 'cut', 'paste', 'dragstart', 'selectstart']) {
  document.addEventListener(eventName, (e) => e.preventDefault());
}

window.addEventListener('beforeprint', () => {
  document.body.innerHTML = '';
});

loadDeck().catch(() => {});
