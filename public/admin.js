const $ = (sel) => document.querySelector(sel);
const loginCard = $('#loginCard');
const adminPanel = $('#adminPanel');
const logoutBtn = $('#logoutBtn');
const decksBody = $('#decksBody');
const codesBody = $('#codesBody');
const deckSelect = $('#deckSelect');

async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: options.body instanceof FormData ? undefined : { 'Content-Type': 'application/json' },
    ...options
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request gagal');
  return data;
}

function setStatus(el, msg, type = '') {
  el.className = `status ${type}`;
  el.textContent = msg || '';
}

async function checkAuth() {
  try {
    await api('/api/admin/me');
    loginCard.classList.add('hidden');
    adminPanel.classList.remove('hidden');
    logoutBtn.classList.remove('hidden');
    await refreshAll();
  } catch {
    loginCard.classList.remove('hidden');
    adminPanel.classList.add('hidden');
    logoutBtn.classList.add('hidden');
  }
}

async function refreshAll() {
  const [decksRes, codesRes] = await Promise.all([
    api('/api/admin/decks'),
    api('/api/admin/codes')
  ]);
  renderDecks(decksRes.decks || []);
  renderCodes(codesRes.codes || []);
}

function renderDecks(decks) {
  decksBody.innerHTML = '';
  deckSelect.innerHTML = '';
  if (!decks.length) {
    decksBody.innerHTML = '<tr><td colspan="5" class="notice">Belum ada deck.</td></tr>';
    deckSelect.innerHTML = '<option value="">Upload deck dulu</option>';
    return;
  }
  for (const deck of decks) {
    const opt = document.createElement('option');
    opt.value = deck.id;
    opt.textContent = `${deck.title} (${deck.mode})`;
    deckSelect.appendChild(opt);

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><b>${escapeHtml(deck.title)}</b><br><span class="badge">${escapeHtml(deck.original_filename)}</span></td>
      <td>${deck.mode}</td>
      <td>${deck.mode === 'slides' ? deck.slide_count : '-'}</td>
      <td>${deck.created_at}</td>
      <td><button class="danger" data-delete-deck="${deck.id}">Delete</button></td>
    `;
    decksBody.appendChild(tr);
  }
}

function renderCodes(codes) {
  codesBody.innerHTML = '';
  if (!codes.length) {
    codesBody.innerHTML = '<tr><td colspan="5" class="notice">Belum ada kode akses.</td></tr>';
    return;
  }
  for (const code of codes) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><b style="font-size:18px;letter-spacing:.08em">${escapeHtml(code.code)}</b></td>
      <td>${escapeHtml(code.deck_title)}<br><span class="badge">${code.deck_mode}</span></td>
      <td>${code.used_devices}/${code.max_devices}</td>
      <td>${code.created_at}</td>
      <td class="row">
        <button class="secondary" data-reset-code="${code.id}">Reset Device</button>
        <button class="danger" data-delete-code="${code.id}">Delete</button>
      </td>
    `;
    codesBody.appendChild(tr);
  }
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>'"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const status = $('#loginStatus');
  setStatus(status, 'Memproses...');
  const fd = new FormData(e.target);
  try {
    await api('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ username: fd.get('username'), password: fd.get('password') })
    });
    setStatus(status, 'Login berhasil.', 'ok');
    await checkAuth();
  } catch (err) {
    setStatus(status, err.message, 'error');
  }
});

logoutBtn.addEventListener('click', async () => {
  await api('/api/admin/logout', { method: 'POST' }).catch(() => {});
  location.reload();
});

$('#uploadForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter;
  const status = $('#uploadStatus');
  btn.disabled = true;
  setStatus(status, 'Uploading dan memproses file. Untuk PPT besar bisa cukup lama...');
  try {
    const formData = new FormData(e.target);
    await api('/api/admin/decks', { method: 'POST', body: formData });
    e.target.reset();
    setStatus(status, 'Deck berhasil dibuat.', 'ok');
    await refreshAll();
  } catch (err) {
    setStatus(status, err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

$('#codeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const status = $('#codeStatus');
  const fd = new FormData(e.target);
  setStatus(status, 'Membuat kode...');
  try {
    const data = await api('/api/admin/codes', {
      method: 'POST',
      body: JSON.stringify({ deckId: fd.get('deckId'), maxDevices: fd.get('maxDevices') })
    });
    setStatus(status, `Kode berhasil dibuat: ${data.code}`, 'ok');
    await refreshAll();
  } catch (err) {
    setStatus(status, err.message, 'error');
  }
});

$('#refreshBtn').addEventListener('click', refreshAll);

document.addEventListener('click', async (e) => {
  const deleteDeck = e.target.dataset.deleteDeck;
  const deleteCode = e.target.dataset.deleteCode;
  const resetCode = e.target.dataset.resetCode;

  if (deleteDeck && confirm('Hapus deck ini beserta semua kode aksesnya?')) {
    await api(`/api/admin/decks/${deleteDeck}`, { method: 'DELETE' });
    await refreshAll();
  }
  if (deleteCode && confirm('Hapus kode akses ini?')) {
    await api(`/api/admin/codes/${deleteCode}`, { method: 'DELETE' });
    await refreshAll();
  }
  if (resetCode && confirm('Reset semua device untuk kode ini? Pembeli bisa login ulang dari device baru.')) {
    await api(`/api/admin/codes/${resetCode}/reset-devices`, { method: 'POST' });
    await refreshAll();
  }
});

checkAuth();
