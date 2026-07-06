/* ============================================================
   FILE EXPLORER — APP LOGIC
   ============================================================ */

// ---------- Auth guard ----------
if (sessionStorage.getItem('fe_session') !== 'active') {
  window.location.href = 'login.html';
}

// ---------- App state ----------
const appState = {
  currentFolderId: null,      // active folder in "My Files"
  currentView: 'files',       // files | recent | favorites | trash
  viewMode: 'grid',           // grid | list
  sortKey: 'date',          // name | date | size | type — 'date' asc keeps newest items at the bottom, in creation order
  sortDir: 'asc',
  searchQuery: '',
  contextTargetId: null,
  draggedId: null,
  clipboard: null,            // { mode: 'copy' | 'cut', id, name } — set by Copy/Cut, consumed by Paste
  busyDepth: 0,               // >0 while a mutating action is in flight — blocks duplicate clicks
};

/** Runs fn() while showing the global "busy" state (progress bar +
 *  disabled/dimmed cards, rows, and buttons) so a second click during
 *  an in-flight action can't fire a duplicate operation. If something
 *  is already in flight, the new attempt is politely rejected instead
 *  of queued or run in parallel. Wrap this at the OUTERMOST click/submit
 *  handler for every mutating action — never inside a shared helper
 *  that might also be called from another wrapped handler, or the
 *  nested call would be rejected as "already busy".
 */
async function withBusyLock(fn) {
  if (appState.busyDepth > 0) {
    showToast('info', 'Please wait', 'Another action is still in progress.');
    return;
  }
  appState.busyDepth++;
  document.body.classList.add('action-busy');
  const bar = document.getElementById('globalProgressBar');
  if (bar) bar.style.display = 'block';
  try {
    return await fn();
  } finally {
    appState.busyDepth = Math.max(0, appState.busyDepth - 1);
    if (appState.busyDepth === 0) {
      document.body.classList.remove('action-busy');
      if (bar) bar.style.display = 'none';
    }
  }
}

const EXT_ICON = {
  png: ['fa-file-image', 'icon-image'], jpg: ['fa-file-image', 'icon-image'], jpeg: ['fa-file-image', 'icon-image'],
  gif: ['fa-file-image', 'icon-image'], svg: ['fa-file-image', 'icon-image'], webp: ['fa-file-image', 'icon-image'],
  pdf: ['fa-file-pdf', 'icon-pdf'],
  doc: ['fa-file-word', 'icon-doc'], docx: ['fa-file-word', 'icon-doc'],
  xls: ['fa-file-excel', 'icon-sheet'], xlsx: ['fa-file-excel', 'icon-sheet'], csv: ['fa-file-csv', 'icon-sheet'],
  ppt: ['fa-file-powerpoint', 'icon-ppt'], pptx: ['fa-file-powerpoint', 'icon-ppt'],
  zip: ['fa-file-zipper', 'icon-zip'], rar: ['fa-file-zipper', 'icon-zip'],
  mp4: ['fa-file-video', 'icon-video'], mov: ['fa-file-video', 'icon-video'], avi: ['fa-file-video', 'icon-video'],
  mp3: ['fa-file-audio', 'icon-audio'], wav: ['fa-file-audio', 'icon-audio'],
  txt: ['fa-file-lines', 'icon-generic'], css: ['fa-file-code', 'icon-generic'], js: ['fa-file-code', 'icon-generic'],
};
function iconFor(node) {
  if (node.type === 'folder') return ['fa-folder', 'icon-folder'];
  return EXT_ICON[node.ext] || ['fa-file', 'icon-generic'];
}

// ---------- Utilities ----------
function formatSize(bytes) {
  if (bytes === 0 || bytes === undefined) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0, val = bytes;
  while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
  return `${val.toFixed(val < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}
function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
function escapeHtml(str) {
  return str.replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}
function debounce(fn, ms) {
  let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ---------- Toasts ----------
function showToast(type, title, msg) {
  const stack = document.getElementById('toastStack');
  const icons = { success: 'fa-circle-check', error: 'fa-circle-exclamation', info: 'fa-circle-info' };
  const el = document.createElement('div');
  el.className = 'app-toast' + (type !== 'success' ? ` toast-${type}` : '');
  el.innerHTML = `
    <i class="fa-solid ${icons[type] || icons.success}" style="color:${type === 'error' ? 'var(--color-danger)' : type === 'info' ? 'var(--color-secondary)' : 'var(--color-accent)'}"></i>
    <div><div class="toast-title">${escapeHtml(title)}</div>${msg ? `<div class="toast-msg">${escapeHtml(msg)}</div>` : ''}</div>
  `;
  stack.appendChild(el);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 250);
  }, 3400);
}

// ---------- Highlight newly created/uploaded items ----------
function highlightNewItem(id) {
  requestAnimationFrame(() => {
    const el = document.querySelector(`.file-card[data-id="${id}"], tr[data-id="${id}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    el.classList.add('just-created');
    setTimeout(() => el.classList.remove('just-created'), 1600);
  });
}

// ---------- Init ----------
document.addEventListener('DOMContentLoaded', async () => {
  const email = sessionStorage.getItem('fe_user_email') || 'user@example.com';
  document.getElementById('userEmailLabel').textContent = email;
  document.getElementById('userAvatarInitial').textContent = email[0].toUpperCase();

  await DriveAPI.getTree(); // fetches your real Drive tree via Apps Script once deployed; demo data until then
  appState.currentFolderId = ROOT.id;
  applySavedPreferences();

  renderSidebarTree();
  renderBreadcrumb();
  renderContent();
  wireGlobalEvents();
  if (CONFIG.MODE === 'appscript' && CONFIG.APPS_SCRIPT_URL.includes('PASTE_YOUR_DEPLOYMENT_ID')) {
    showToast('info', 'Demo data', 'Deploy Code.gs and set APPS_SCRIPT_URL in js/api.js to connect your real Drive — see README.');
  }

  if (sessionStorage.getItem('fe_login_toast')) {
    showToast('success', 'Login successful', `Welcome back, ${email}`);
    sessionStorage.removeItem('fe_login_toast');
  }
});

// ============================================================
// SIDEBAR — nav items + folder tree
// ============================================================
function renderSidebarTree() {
  const container = document.getElementById('folderTree');
  container.innerHTML = '';
  container.appendChild(buildTreeNode(ROOT, true));
}

function buildTreeNode(node, isRoot = false) {
  const wrap = document.createElement('div');
  wrap.className = 'tree-node';

  const row = document.createElement('div');
  row.className = 'tree-row' + (node.id === appState.currentFolderId && appState.currentView === 'files' ? ' active' : '');
  row.dataset.id = node.id;
  const hasChildren = node.children && node.children.some(c => c.type === 'folder');
  const [iconClass, iconColor] = iconFor(node);

  row.innerHTML = `
    <span class="tree-caret ${hasChildren ? '' : 'leaf'}"><i class="fa-solid fa-chevron-right"></i></span>
    <i class="fa-solid ${iconClass} tree-folder-icon"></i>
    <span class="tree-label">${escapeHtml(node.name)}</span>
  `;

  row.addEventListener('click', (e) => {
    e.stopPropagation();
    openFolder(node.id);
  });

  // Drag & drop target (move files/folders into this tree folder)
  row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('active'); });
  row.addEventListener('dragleave', () => { if (node.id !== appState.currentFolderId) row.classList.remove('active'); });
  row.addEventListener('drop', async (e) => {
    e.preventDefault(); row.classList.remove('active');
    await withBusyLock(() => handleDropMove(appState.draggedId, node.id));
  });

  row.addEventListener('contextmenu', (e) => {
    e.preventDefault(); e.stopPropagation();
    openContextMenu(e.clientX, e.clientY, node);
  });

  wrap.appendChild(row);

  const childWrap = document.createElement('div');
  childWrap.className = 'tree-children' + (isRoot ? ' open' : '');
  const folders = (node.children || []).filter(c => c.type === 'folder');
  folders.forEach(c => childWrap.appendChild(buildTreeNode(c)));
  wrap.appendChild(childWrap);

  if (hasChildren) {
    const caret = row.querySelector('.tree-caret');
    if (isRoot) caret.classList.add('open');
    caret.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = childWrap.classList.toggle('open');
      caret.classList.toggle('open', open);
    });
  }

  return wrap;
}

function openFolder(id) {
  appState.currentFolderId = id;
  appState.currentView = 'files';
  document.getElementById('searchInput').value = '';
  appState.searchQuery = '';
  setActiveNavItem('nav-files');
  renderSidebarTree();
  renderBreadcrumb();
  renderContent();
}

function setActiveNavItem(id) {
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
}

// ============================================================
// BREADCRUMB
// ============================================================
function renderBreadcrumb() {
  const bar = document.getElementById('breadcrumbBar');
  bar.innerHTML = '';

  if (appState.currentView !== 'files') {
    const labels = { recent: 'Recent', favorites: 'Favorites', trash: 'Trash', settings: 'Settings' };
    bar.innerHTML = `<span class="breadcrumb-item current"><i class="fa-solid fa-house me-1"></i>${labels[appState.currentView]}</span>`;
    return;
  }

  const trail = getPathNodes(appState.currentFolderId) || [ROOT];
  trail.forEach((node, i) => {
    const isLast = i === trail.length - 1;
    const span = document.createElement('span');
    span.className = 'breadcrumb-item' + (isLast ? ' current' : '');
    span.innerHTML = i === 0 ? `<i class="fa-solid fa-house me-1"></i>${escapeHtml(node.name)}` : escapeHtml(node.name);
    if (!isLast) span.addEventListener('click', () => openFolder(node.id));
    bar.appendChild(span);
    if (!isLast) {
      const sep = document.createElement('span');
      sep.className = 'breadcrumb-sep';
      sep.innerHTML = '<i class="fa-solid fa-chevron-right"></i>';
      bar.appendChild(sep);
    }
  });
}

// ============================================================
// CONTENT RENDERING (grid / list)
// ============================================================
function getViewItems() {
  if (appState.searchQuery.trim()) {
    return searchTree(appState.searchQuery.trim().toLowerCase());
  }
  if (appState.currentView === 'recent') {
    return STATE.recentIds.map(id => findNode(id)).filter(Boolean);
  }
  if (appState.currentView === 'favorites') {
    return [...STATE.favorites].map(id => findNode(id)).filter(Boolean);
  }
  if (appState.currentView === 'trash') {
    return STATE.trash.map(t => t.item);
  }
  const folder = findNode(appState.currentFolderId) || ROOT;
  return folder.children || [];
}

function searchTree(query) {
  const all = collectAll(ROOT).filter(n => n.id !== ROOT.id);
  return all.filter(n => n.name.toLowerCase().includes(query));
}

function sortItems(items) {
  const dir = appState.sortDir === 'asc' ? 1 : -1;
  const arr = [...items];
  arr.sort((a, b) => {
    // folders first always, except when explicitly sorting by type
    if (appState.sortKey !== 'type' && a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    switch (appState.sortKey) {
      case 'name': return a.name.localeCompare(b.name) * dir;
      case 'date': return (new Date(a.createdAt) - new Date(b.createdAt)) * dir;
      case 'size': return ((a.size || 0) - (b.size || 0)) * dir;
      case 'type': {
        const ta = a.type === 'folder' ? 'folder' : (a.ext || '');
        const tb = b.type === 'folder' ? 'folder' : (b.ext || '');
        return ta.localeCompare(tb) * dir;
      }
      default: return 0;
    }
  });
  return arr;
}

function renderContent() {
  const toolbar = document.querySelector('.toolbar');
  const settingsEl = document.getElementById('settingsView');

  if (appState.currentView === 'settings') {
    toolbar.style.display = 'none';
    document.getElementById('gridView').style.display = 'none';
    document.getElementById('listViewWrap').style.display = 'none';
    document.getElementById('emptyState').style.display = 'none';
    settingsEl.style.display = 'block';
    renderSettingsView();
    return;
  }
  settingsEl.style.display = 'none';
  toolbar.style.display = 'flex';

  // Upload / New folder don't make sense inside Trash
  const isTrash = appState.currentView === 'trash';
  document.getElementById('uploadFileBtn').style.display = isTrash ? 'none' : '';
  document.getElementById('newFolderBtn').style.display = isTrash ? 'none' : '';

  const pasteBtn = document.getElementById('pasteBtn');
  const canPasteInCurrentView = appState.clipboard && appState.currentView === 'files';
  pasteBtn.style.display = canPasteInCurrentView ? '' : 'none';
  if (canPasteInCurrentView) {
    pasteBtn.innerHTML = `<i class="fa-solid fa-paste"></i> Paste "${escapeHtml(appState.clipboard.name)}"`;
  }

  const items = sortItems(getViewItems());
  const gridEl = document.getElementById('gridView');
  const listBody = document.getElementById('listViewBody');
  const emptyEl = document.getElementById('emptyState');

  gridEl.innerHTML = '';
  listBody.innerHTML = '';

  document.getElementById('itemCountLabel').textContent = `${items.length} item${items.length !== 1 ? 's' : ''}`;

  if (items.length === 0) {
    emptyEl.style.display = 'block';
    gridEl.style.display = 'none';
    document.getElementById('listViewWrap').style.display = 'none';
    const msgs = {
      files: ['fa-folder-open', 'This folder is empty', 'Upload a file or create a new folder to get started.'],
      recent: ['fa-clock-rotate-left', 'No recent files yet', 'Files you upload or open will show up here.'],
      favorites: ['fa-star', 'No favorites yet', 'Star files or folders to find them quickly.'],
      trash: ['fa-trash', 'Trash is empty', 'Deleted items will appear here.'],
    };
    const key = appState.searchQuery.trim() ? 'search' : appState.currentView;
    const [icon, title, sub] = msgs[key] || ['fa-magnifying-glass', 'No results found', 'Try a different search term.'];
    emptyEl.innerHTML = `<i class="fa-solid ${icon}"></i><div class="fw-semibold text-dark mb-1">${title}</div><div>${sub}</div>`;
    return;
  }
  emptyEl.style.display = 'none';

  if (appState.viewMode === 'grid') {
    gridEl.style.display = 'grid';
    document.getElementById('listViewWrap').style.display = 'none';
    items.forEach(item => gridEl.appendChild(buildFileCard(item)));
  } else {
    gridEl.style.display = 'none';
    document.getElementById('listViewWrap').style.display = 'block';
    items.forEach(item => listBody.appendChild(buildFileRow(item)));
  }
}

function buildFileCard(item) {
  const [iconClass, iconColor] = iconFor(item);
  const card = document.createElement('div');
  card.className = 'file-card';
  card.draggable = appState.currentView === 'files';
  card.dataset.id = item.id;
  if (appState.clipboard && appState.clipboard.mode === 'cut' && appState.clipboard.id === item.id) {
    card.classList.add('clipboard-cut');
  }

  const isFav = STATE.favorites.has(item.id);
  card.innerHTML = `
    <div class="card-actions">
      <button class="icon-btn card-menu-btn" style="width:26px;height:26px;">
        <i class="fa-solid fa-ellipsis-vertical" style="font-size:0.8rem;"></i>
      </button>
    </div>
    <div class="card-icon"><i class="fa-solid ${iconClass} ${iconColor}"></i></div>
    <div class="card-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)} ${isFav ? '<i class="fa-solid fa-star text-warning" style="font-size:0.7rem;"></i>' : ''}</div>
    <div class="card-meta">${item.type === 'folder' ? `${(item.children || []).length} items` : formatSize(item.size)} · ${formatDate(item.createdAt)}</div>
  `;

  card.querySelector('.card-menu-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    openContextMenu(rect.right - 190, rect.bottom + 4, item);
  });

  card.addEventListener('dblclick', () => activateItem(item));
  card.addEventListener('click', (e) => { if (!e.target.closest('.dropdown')) selectCard(card); });
  card.addEventListener('contextmenu', (e) => { e.preventDefault(); openContextMenu(e.clientX, e.clientY, item); });

  // Drag source
  card.addEventListener('dragstart', (e) => {
    appState.draggedId = item.id;
    e.dataTransfer.effectAllowed = 'move';
  });
  // Drag target (folders only)
  if (item.type === 'folder') {
    card.addEventListener('dragover', (e) => { e.preventDefault(); card.classList.add('drag-over'); });
    card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
    card.addEventListener('drop', async (e) => {
      e.preventDefault(); card.classList.remove('drag-over');
      await withBusyLock(() => handleDropMove(appState.draggedId, item.id));
    });
  }

  return card;
}

function buildFileRow(item) {
  const [iconClass, iconColor] = iconFor(item);
  const tr = document.createElement('tr');
  tr.dataset.id = item.id;
  tr.draggable = appState.currentView === 'files';
  if (appState.clipboard && appState.clipboard.mode === 'cut' && appState.clipboard.id === item.id) {
    tr.classList.add('clipboard-cut');
  }
  const isFav = STATE.favorites.has(item.id);

  tr.innerHTML = `
    <td class="file-name-cell"><i class="fa-solid ${iconClass} ${iconColor}"></i> ${escapeHtml(item.name)} ${isFav ? '<i class="fa-solid fa-star text-warning" style="font-size:0.7rem;"></i>' : ''}</td>
    <td>${formatDate(item.createdAt)}</td>
    <td>${item.type === 'folder' ? '—' : formatSize(item.size)}</td>
    <td>${item.type === 'folder' ? 'Folder' : (item.ext || '').toUpperCase()}</td>
    <td>
      <button class="icon-btn row-menu-btn" style="width:30px;height:30px;">
        <i class="fa-solid fa-ellipsis-vertical" style="font-size:0.85rem;"></i>
      </button>
    </td>
  `;
  tr.querySelector('.row-menu-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    openContextMenu(rect.right - 190, rect.bottom + 4, item);
  });

  tr.addEventListener('dblclick', () => activateItem(item));
  tr.addEventListener('contextmenu', (e) => { e.preventDefault(); openContextMenu(e.clientX, e.clientY, item); });
  tr.addEventListener('dragstart', (e) => { appState.draggedId = item.id; e.dataTransfer.effectAllowed = 'move'; });
  if (item.type === 'folder') {
    tr.addEventListener('dragover', (e) => e.preventDefault());
    tr.addEventListener('drop', async (e) => { e.preventDefault(); await withBusyLock(() => handleDropMove(appState.draggedId, item.id)); });
  }

  return tr;
}

function selectCard(card) {
  document.querySelectorAll('.file-card').forEach(c => c.style.outline = '');
  card.style.outline = `2px solid var(--color-secondary)`;
}

function activateItem(item) {
  if (item.type === 'folder' && appState.currentView === 'files') {
    openFolder(item.id);
  } else if (item.type === 'file') {
    openPreview(item);
  }
}

function actionsFor(item) {
  if (appState.currentView === 'trash') {
    return [
      { key: 'restore', icon: 'fa-rotate-left', label: 'Restore' },
      { key: 'delete-forever', icon: 'fa-trash', label: 'Delete forever', danger: true },
    ];
  }
  const canPasteHere = item.type === 'folder'
    && appState.clipboard
    && appState.clipboard.id !== item.id
    && !isDescendantOf(appState.clipboard.id, item.id);

  if (item.type === 'folder') {
    return [
      { key: 'open', icon: 'fa-folder-open', label: 'Open' },
      { key: 'new-folder', icon: 'fa-folder-plus', label: 'New folder inside' },
      { key: 'upload', icon: 'fa-upload', label: 'Upload file here' },
      ...(canPasteHere ? [{ key: 'paste-into', icon: 'fa-paste', label: `Paste "${appState.clipboard.name}" here` }] : []),
      'divider',
      { key: 'copy', icon: 'fa-copy', label: 'Copy' },
      { key: 'cut', icon: 'fa-scissors', label: 'Cut' },
      { key: 'rename', icon: 'fa-pen', label: 'Rename' },
      { key: 'favorite', icon: 'fa-star', label: STATE.favorites.has(item.id) ? 'Unfavorite' : 'Add to favorites' },
      { key: 'properties', icon: 'fa-circle-info', label: 'Properties' },
      'divider',
      { key: 'delete', icon: 'fa-trash', label: 'Delete', danger: true },
    ];
  }
  return [
    { key: 'view', icon: 'fa-eye', label: 'View' },
    { key: 'download', icon: 'fa-download', label: 'Download' },
    'divider',
    { key: 'copy', icon: 'fa-copy', label: 'Copy' },
    { key: 'cut', icon: 'fa-scissors', label: 'Cut' },
    { key: 'rename', icon: 'fa-pen', label: 'Rename' },
    { key: 'share', icon: 'fa-share-nodes', label: 'Share' },
    { key: 'favorite', icon: 'fa-star', label: STATE.favorites.has(item.id) ? 'Unfavorite' : 'Add to favorites' },
    { key: 'properties', icon: 'fa-circle-info', label: 'Properties' },
    'divider',
    { key: 'delete', icon: 'fa-trash', label: 'Delete', danger: true },
  ];
}

/** True if nodeId is anywhere inside ancestorId's subtree (or is ancestorId
 *  itself) — used to block cutting a folder into its own descendant. */
function isDescendantOf(ancestorId, nodeId) {
  const ancestor = findNode(ancestorId);
  if (!ancestor || ancestor.type !== 'folder') return false;
  let found = false;
  (function walk(n) {
    if (found) return;
    if (n.id === nodeId) { found = true; return; }
    (n.children || []).forEach(walk);
  })(ancestor);
  return found;
}

async function handleAction(action, item) {
  switch (action) {
    case 'open': openFolder(item.id); break;
    case 'view': openPreview(item); break;
    case 'new-folder': openCreateFolderModal(item.id); break;
    case 'upload': triggerUpload(item.id); break;
    case 'rename': openRenameModal(item); break;
    case 'download': downloadFile(item); break;
    case 'share': openShareModal(item); break;
    case 'properties': openPropertiesModal(item); break;
    case 'favorite': {
      await DriveAPI.toggleFavorite(item.id);
      showToast('success', STATE.favorites.has(item.id) ? 'Added to favorites' : 'Removed from favorites', item.name);
      renderContent();
      break;
    }
    case 'delete': {
      await DriveAPI.deleteNode(item.id);
      showToast('success', item.type === 'folder' ? 'Folder deleted' : 'File deleted', `"${item.name}" moved to Trash`);
      renderSidebarTree(); renderContent();
      break;
    }
    case 'restore': {
      await DriveAPI.restoreNode(item.id);
      showToast('success', 'Restored', `"${item.name}" restored`);
      renderSidebarTree(); renderContent();
      break;
    }
    case 'delete-forever': {
      await DriveAPI.permanentlyDelete(item.id);
      showToast('success', 'Permanently deleted', item.name);
      renderContent();
      break;
    }
    case 'copy': {
      appState.clipboard = { mode: 'copy', id: item.id, name: item.name };
      showToast('info', 'Copied', `"${item.name}" copied — choose Paste to place it.`);
      renderContent();
      break;
    }
    case 'cut': {
      appState.clipboard = { mode: 'cut', id: item.id, name: item.name };
      showToast('info', 'Cut', `"${item.name}" cut — choose Paste to move it.`);
      renderContent();
      break;
    }
    case 'paste-into': {
      await pasteClipboard(item.id);
      break;
    }
  }
}

/** Pastes whatever is in appState.clipboard into targetFolderId — a
 *  copy (via DriveAPI.copyNode) or a move (via the existing
 *  DriveAPI.moveNode) depending on how it got there. */
async function pasteClipboard(targetFolderId) {
  const clip = appState.clipboard;
  if (!clip) return;

  if (clip.id === targetFolderId) {
    showToast('error', "Can't paste here", 'Choose a different destination folder.');
    return;
  }
  if (isDescendantOf(clip.id, targetFolderId)) {
    showToast('error', "Can't paste here", "A folder can't be moved or copied into its own subfolder.");
    return;
  }

  try {
    if (clip.mode === 'cut') {
      await DriveAPI.moveNode(clip.id, targetFolderId);
      showToast('success', 'Moved', `"${clip.name}" moved successfully`);
      appState.clipboard = null;
      renderSidebarTree(); renderContent();
      highlightNewItem(clip.id);
    } else {
      const node = await DriveAPI.copyNode(clip.id, targetFolderId);
      showToast('success', 'Copied', `"${clip.name}" copied successfully`);
      appState.clipboard = null;
      renderSidebarTree(); renderContent();
      if (node) highlightNewItem(node.id);
    }
  } catch (err) {
    showToast('error', clip.mode === 'cut' ? 'Move failed' : 'Copy failed', String(err.message || err));
  }
}

async function handleDropMove(draggedId, targetFolderId) {
  if (!draggedId || draggedId === targetFolderId) return;
  try {
    await DriveAPI.moveNode(draggedId, targetFolderId);
    const node = findNode(draggedId);
    showToast('success', 'Moved', `"${node ? node.name : ''}" moved successfully`);
    renderSidebarTree(); renderContent();
  } catch (err) {
    showToast('error', 'Move failed', String(err));
  }
  appState.draggedId = null;
}

// ============================================================
// CONTEXT MENU (right click)
// ============================================================
function openContextMenu(x, y, item) {
  appState.contextTargetId = item.id;
  const menu = document.getElementById('contextMenu');
  const actions = actionsFor(item);
  menu.innerHTML = actions.map(a =>
    a === 'divider'
      ? `<div class="context-menu-divider"></div>`
      : `<div class="context-menu-item ${a.danger ? 'danger' : ''}" data-action="${a.key}"><i class="fa-solid ${a.icon}"></i>${a.label}</div>`
  ).join('');
  menu.querySelectorAll('[data-action]').forEach(el => {
    el.addEventListener('click', () => {
      closeContextMenu();
      withBusyLock(() => handleAction(el.dataset.action, item));
    });
  });

  menu.style.left = '-9999px';
  menu.style.top = '-9999px';
  menu.classList.add('show');
  const menuHeight = menu.offsetHeight;
  menu.style.left = Math.max(8, Math.min(x, window.innerWidth - 210)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, window.innerHeight - menuHeight - 20)) + 'px';
}
function closeContextMenu() {
  document.getElementById('contextMenu').classList.remove('show');
}

/** Right-clicking empty grid/list space (not an item) offers just Paste,
 *  when there's something in the clipboard to paste. */
function openEmptyAreaContextMenu(x, y) {
  if (!appState.clipboard) return;
  const menu = document.getElementById('contextMenu');
  menu.innerHTML = `<div class="context-menu-item" data-action="paste-empty"><i class="fa-solid fa-paste"></i>Paste "${escapeHtml(appState.clipboard.name)}"</div>`;
  menu.querySelector('[data-action="paste-empty"]').addEventListener('click', () => {
    closeContextMenu();
    withBusyLock(() => pasteClipboard(appState.currentFolderId));
  });

  menu.style.left = '-9999px';
  menu.style.top = '-9999px';
  menu.classList.add('show');
  const menuHeight = menu.offsetHeight;
  menu.style.left = Math.max(8, Math.min(x, window.innerWidth - 210)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, window.innerHeight - menuHeight - 20)) + 'px';
}

// ============================================================
// MODALS: create folder / rename / properties / share / preview
// ============================================================
let modalTargetParentId = null;

function openCreateFolderModal(parentId) {
  modalTargetParentId = parentId ?? appState.currentFolderId;
  document.getElementById('newFolderNameInput').value = '';
  bootstrap.Modal.getOrCreateInstance(document.getElementById('createFolderModal')).show();
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('createFolderForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('newFolderNameInput').value.trim();
    if (!name) return;

    await withBusyLock(async () => {
      const btn = document.getElementById('createFolderSubmitBtn');
      const btnText = document.getElementById('createFolderBtnText');
      const spinner = document.getElementById('createFolderSpinner');
      const input = document.getElementById('newFolderNameInput');

      btn.disabled = true;
      input.disabled = true;
      btnText.textContent = 'Creating...';
      spinner.style.display = 'inline-block';

      const startedAt = Date.now();
      let node;
      try {
        node = await DriveAPI.createFolder(modalTargetParentId, name);
      } catch (err) {
        showToast('error', "Couldn't create folder", String(err.message || err));
        btn.disabled = false;
        input.disabled = false;
        btnText.textContent = 'Create';
        spinner.style.display = 'none';
        return;
      }

      // Keep the "Creating..." state visible for a beat so the animation reads
      // even on the instant mock backend — a real network call will just add to this.
      const elapsed = Date.now() - startedAt;
      if (elapsed < 500) await new Promise(r => setTimeout(r, 500 - elapsed));

      bootstrap.Modal.getInstance(document.getElementById('createFolderModal')).hide();
      showToast('success', 'Folder created', `"${name}" was created`);
      renderSidebarTree(); renderContent();
      highlightNewItem(node.id);

      btn.disabled = false;
      input.disabled = false;
      btnText.textContent = 'Create';
      spinner.style.display = 'none';
    });
  });

  document.getElementById('renameForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('renameInput').value.trim();
    if (!name || !renameTargetId) return;

    await withBusyLock(async () => {
      const btn = document.getElementById('renameSubmitBtn');
      const btnText = document.getElementById('renameBtnText');
      const spinner = document.getElementById('renameSpinner');
      const input = document.getElementById('renameInput');

      btn.disabled = true;
      input.disabled = true;
      btnText.textContent = 'Saving...';
      spinner.style.display = 'inline-block';

      try {
        await DriveAPI.renameNode(renameTargetId, name);
        bootstrap.Modal.getInstance(document.getElementById('renameModal')).hide();
        showToast('success', 'Renamed', `Renamed to "${name}"`);
        renderSidebarTree(); renderContent(); renderBreadcrumb();
      } catch (err) {
        showToast('error', "Couldn't rename", String(err.message || err));
      } finally {
        btn.disabled = false;
        input.disabled = false;
        btnText.textContent = 'Save';
        spinner.style.display = 'none';
      }
    });
  });
});

let renameTargetId = null;
function openRenameModal(item) {
  renameTargetId = item.id;
  const input = document.getElementById('renameInput');
  input.value = item.name;
  document.getElementById('renameModalLabel').textContent = `Rename ${item.type === 'folder' ? 'folder' : 'file'}`;
  bootstrap.Modal.getOrCreateInstance(document.getElementById('renameModal')).show();
  setTimeout(() => { input.focus(); input.select(); }, 300);
}

function openPropertiesModal(item) {
  const body = document.getElementById('propertiesBody');
  const [iconClass, iconColor] = iconFor(item);
  body.innerHTML = `
    <div class="text-center mb-3"><i class="fa-solid ${iconClass} ${iconColor}" style="font-size:2.6rem;"></i></div>
    <table class="table table-sm">
      <tr><th style="width:130px;">Name</th><td>${escapeHtml(item.name)}</td></tr>
      <tr><th>Type</th><td>${item.type === 'folder' ? 'Folder' : (item.ext || 'File').toUpperCase()}</td></tr>
      ${item.type === 'file' ? `<tr><th>Size</th><td>${formatSize(item.size)}</td></tr>` : `<tr><th>Contents</th><td>${(item.children || []).length} items</td></tr>`}
      <tr><th>Created</th><td>${formatDate(item.createdAt)}</td></tr>
      <tr><th>Location</th><td>${(getPathNodes(item.id) || []).map(n => n.name).join(' / ')}</td></tr>
    </table>
  `;
  bootstrap.Modal.getOrCreateInstance(document.getElementById('propertiesModal')).show();
}

function openShareModal(item) {
  const link = `https://drive.example.com/share/${item.id}`;
  document.getElementById('shareLinkInput').value = link;
  document.getElementById('shareModalLabel').textContent = `Share "${item.name}"`;
  bootstrap.Modal.getOrCreateInstance(document.getElementById('shareModal')).show();
}
function copyShareLink() {
  const input = document.getElementById('shareLinkInput');
  input.select();
  navigator.clipboard?.writeText(input.value);
  showToast('info', 'Link copied', 'Share link copied to clipboard');
}

async function openPreview(item) {
  const body = document.getElementById('previewBody');
  document.getElementById('previewModalLabel').textContent = item.name;
  body.innerHTML = `<div class="preview-fallback"><i class="fa-solid fa-spinner fa-spin"></i>Loading preview…</div>`;
  document.getElementById('previewDownloadBtn').onclick = () => downloadFile(item);
  bootstrap.Modal.getOrCreateInstance(document.getElementById('previewModal')).show();

  let url;
  try {
    url = await DriveAPI.ensureFileUrl(item);
  } catch (err) {
    body.innerHTML = `<div class="preview-fallback"><i class="fa-solid fa-triangle-exclamation"></i>Couldn't load preview.<br><span class="text-white-50" style="font-size:0.8rem;">${escapeHtml(String(err.message || err))}</span></div>`;
    return;
  }

  let html = '';
  if (item.ext && ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(item.ext) && url) {
    html = `<img src="${url}" alt="${escapeHtml(item.name)}">`;
  } else if (item.ext === 'pdf' && url) {
    html = `<iframe src="${url}"></iframe>`;
  } else if (['mp4', 'mov', 'avi', 'webm'].includes(item.ext) && url) {
    html = `<video src="${url}" controls></video>`;
  } else if (['mp3', 'wav'].includes(item.ext) && url) {
    html = `<div class="preview-fallback"><i class="fa-solid fa-music"></i>${escapeHtml(item.name)}<br><audio src="${url}" controls class="mt-3"></audio></div>`;
  } else {
    const [iconClass] = iconFor(item);
    html = `<div class="preview-fallback"><i class="fa-solid ${iconClass}"></i>Preview not available for this file type.<br><span class="text-white-50" style="font-size:0.8rem;">Download the file to view it.</span></div>`;
  }
  body.innerHTML = html;

  if (!STATE.recentIds.includes(item.id)) STATE.recentIds.unshift(item.id);
}

async function downloadFile(item) {
  let url = item.url;
  try {
    url = await DriveAPI.ensureFileUrl(item);
  } catch (err) {
    showToast('error', 'Download failed', String(err.message || err));
    return;
  }
  if (url) {
    const a = document.createElement('a');
    a.href = url; a.download = item.name;
    document.body.appendChild(a); a.click(); a.remove();
  }
  showToast('info', 'Download started', item.name);
}

// ============================================================
// UPLOAD (file input + drag & drop) with simulated progress
// ============================================================
function triggerUpload(parentId) {
  modalTargetParentId = parentId ?? appState.currentFolderId;
  document.getElementById('fileInput').click();
}

function handleFiles(fileList) {
  const parentId = modalTargetParentId ?? appState.currentFolderId;
  const panel = document.getElementById('uploadPanel');
  const list = document.getElementById('uploadList');
  panel.style.display = 'block';

  [...fileList].forEach(f => {
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    const row = document.createElement('div');
    row.className = 'upload-item';
    row.innerHTML = `
      <div class="upload-item-name"><span>${escapeHtml(f.name)}</span><span class="pct">0%</span></div>
      <div class="upload-progress-track"><div class="upload-progress-fill"></div></div>
    `;
    list.appendChild(row);
    const fill = row.querySelector('.upload-progress-fill');
    const pct = row.querySelector('.pct');

    let progress = 0;
    const url = URL.createObjectURL(f);
    const timer = setInterval(async () => {
      progress += Math.random() * 25 + 10;
      if (progress >= 100) {
        progress = 100;
        clearInterval(timer);
        fill.style.width = '100%'; pct.textContent = '100%';
        const node = await DriveAPI.uploadFile(parentId, { name: f.name, size: f.size, ext, url, rawFile: f });
        showToast('success', 'File uploaded', f.name);
        renderContent();
        if (node) highlightNewItem(node.id);
        setTimeout(() => {
          row.remove();
          if (!list.children.length) panel.style.display = 'none';
        }, 900);
      } else {
        fill.style.width = progress + '%'; pct.textContent = Math.round(progress) + '%';
      }
    }, 220);
  });
}

// ============================================================
// SEARCH / SORT / VIEW TOGGLE
// ============================================================
function wireGlobalEvents() {
  document.getElementById('searchInput').addEventListener('input', debounce((e) => {
    appState.searchQuery = e.target.value;
    renderBreadcrumbForSearch();
    renderContent();
  }, 180));

  document.querySelectorAll('[data-sort]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      const key = el.dataset.sort;
      if (appState.sortKey === key) appState.sortDir = appState.sortDir === 'asc' ? 'desc' : 'asc';
      else { appState.sortKey = key; appState.sortDir = 'asc'; }
      document.getElementById('sortLabel').textContent = `Sort: ${key[0].toUpperCase() + key.slice(1)} (${appState.sortDir === 'asc' ? '↑' : '↓'})`;
      renderContent();
    });
  });

  document.getElementById('gridBtn').addEventListener('click', () => setViewMode('grid'));
  document.getElementById('listBtn').addEventListener('click', () => setViewMode('list'));
  document.querySelectorAll('.file-table th[data-colsort]').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.colsort;
      if (appState.sortKey === key) appState.sortDir = appState.sortDir === 'asc' ? 'desc' : 'asc';
      else { appState.sortKey = key; appState.sortDir = 'asc'; }
      renderContent();
    });
  });

  document.getElementById('fileInput').addEventListener('change', (e) => {
    if (e.target.files.length) handleFiles(e.target.files);
    e.target.value = '';
  });

  document.getElementById('uploadFileBtn').addEventListener('click', () => triggerUpload(appState.currentFolderId));
  document.getElementById('newFolderBtn').addEventListener('click', () => openCreateFolderModal(appState.currentFolderId));
  document.getElementById('pasteBtn').addEventListener('click', () => withBusyLock(() => pasteClipboard(appState.currentFolderId)));

  // Right-click on empty grid/list space (not on an item) offers Paste
  document.getElementById('gridView').addEventListener('contextmenu', (e) => {
    if (e.target.closest('.file-card') || !appState.clipboard || appState.currentView !== 'files') return;
    e.preventDefault();
    openEmptyAreaContextMenu(e.clientX, e.clientY);
  });
  document.getElementById('listViewWrap').addEventListener('contextmenu', (e) => {
    if (e.target.closest('tr') || !appState.clipboard || appState.currentView !== 'files') return;
    e.preventDefault();
    openEmptyAreaContextMenu(e.clientX, e.clientY);
  });

  // Sidebar nav items
  document.getElementById('nav-files').addEventListener('click', () => openFolder(ROOT.id));
  document.getElementById('nav-recent').addEventListener('click', () => switchView('recent', 'nav-recent'));
  document.getElementById('nav-favorites').addEventListener('click', () => switchView('favorites', 'nav-favorites'));
  document.getElementById('nav-trash').addEventListener('click', () => switchView('trash', 'nav-trash'));
  document.getElementById('nav-dashboard').addEventListener('click', () => openFolder(ROOT.id));
  document.getElementById('nav-settings').addEventListener('click', () => switchView('settings', 'nav-settings'));

  // Global drag & drop overlay for uploads anywhere in content area
  const contentArea = document.getElementById('contentArea');
  let dragCounter = 0;
  const overlay = document.getElementById('dropzoneOverlay');
  ['dragenter'].forEach(evt => window.addEventListener(evt, (e) => {
    if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) {
      dragCounter++;
      overlay.classList.add('active');
    }
  }));
  window.addEventListener('dragleave', (e) => {
    dragCounter--;
    if (dragCounter <= 0) { dragCounter = 0; overlay.classList.remove('active'); }
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragCounter = 0;
    overlay.classList.remove('active');
    if (e.dataTransfer.files.length) {
      modalTargetParentId = appState.currentFolderId;
      handleFiles(e.dataTransfer.files);
    }
  });

  // Sidebar collapse (desktop) & mobile drawer
  document.getElementById('sidebarCollapseBtn').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('collapsed');
    document.getElementById('mainCol').classList.toggle('sidebar-collapsed');
  });
  document.getElementById('mobileMenuBtn').addEventListener('click', () => {
    document.getElementById('sidebar').classList.add('mobile-open');
    document.getElementById('sidebarBackdrop').classList.add('show');
  });
  document.getElementById('sidebarBackdrop').addEventListener('click', closeMobileSidebar);

  document.getElementById('logoutBtn').addEventListener('click', async () => {
    try { await DriveAPI.logout(); } catch (e) { /* best-effort — clear local state regardless */ }
    sessionStorage.removeItem('fe_session');
    sessionStorage.removeItem('fe_user_email');
    window.location.href = 'login.html';
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.context-menu')) closeContextMenu();
  });
  window.addEventListener('scroll', closeContextMenu, true);
}

function closeMobileSidebar() {
  document.getElementById('sidebar').classList.remove('mobile-open');
  document.getElementById('sidebarBackdrop').classList.remove('show');
}

function switchView(view, navId) {
  appState.currentView = view;
  document.getElementById('searchInput').value = '';
  appState.searchQuery = '';
  setActiveNavItem(navId);
  renderSidebarTree();
  renderBreadcrumb();
  renderContent();
  closeMobileSidebar();
}

function renderBreadcrumbForSearch() {
  if (!appState.searchQuery.trim()) { renderBreadcrumb(); return; }
  const bar = document.getElementById('breadcrumbBar');
  bar.innerHTML = `<span class="breadcrumb-item current"><i class="fa-solid fa-magnifying-glass me-1"></i>Search results for "${escapeHtml(appState.searchQuery)}"</span>`;
}

function setViewMode(mode) {
  appState.viewMode = mode;
  document.getElementById('gridBtn').classList.toggle('active', mode === 'grid');
  document.getElementById('listBtn').classList.toggle('active', mode === 'list');
  renderContent();
}

// ============================================================
// SETTINGS
// ============================================================
const SETTINGS_KEY = 'fe_settings';

function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; }
  catch { return {}; }
}
function saveSettings(patch) {
  const updated = { ...loadSettings(), ...patch };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(updated));
  return updated;
}
function applySavedPreferences() {
  const s = loadSettings();
  if (s.defaultView === 'list' || s.defaultView === 'grid') appState.viewMode = s.defaultView;
  if (s.defaultSortKey) appState.sortKey = s.defaultSortKey;
  document.getElementById('gridBtn').classList.toggle('active', appState.viewMode === 'grid');
  document.getElementById('listBtn').classList.toggle('active', appState.viewMode === 'list');
  const key = appState.sortKey;
  document.getElementById('sortLabel').textContent = `Sort: ${key[0].toUpperCase() + key.slice(1)} (${appState.sortDir === 'asc' ? '↑' : '↓'})`;
}

function renderSettingsView() {
  const el = document.getElementById('settingsView');
  const email = sessionStorage.getItem('fe_user_email') || 'user@example.com';
  const trashCount = STATE.trash.length;

  el.innerHTML = `
    <div class="settings-grid">
      <section class="settings-card">
        <h6 class="settings-card-title"><i class="fa-solid fa-user me-2"></i>Account</h6>
        <div class="settings-account-row">
          <div class="user-avatar" style="width:44px;height:44px;font-size:1rem;">${escapeHtml(email[0].toUpperCase())}</div>
          <div>
            <div class="fw-semibold">${escapeHtml(email)}</div>
            <div class="text-muted" style="font-size:0.78rem;">Signed in</div>
          </div>
          <button class="btn-outline-soft ms-auto" id="settingsLogoutBtn"><i class="fa-solid fa-arrow-right-from-bracket me-1"></i>Sign out</button>
        </div>
      </section>

      <section class="settings-card">
        <h6 class="settings-card-title"><i class="fa-solid fa-sliders me-2"></i>Preferences</h6>
        <div class="settings-row" style="border-top:none;padding-top:0;">
          <div>
            <div class="fw-semibold" style="font-size:0.85rem;">Default view</div>
            <div class="text-muted" style="font-size:0.76rem;">Layout used when you open the app</div>
          </div>
          <div class="view-toggle" id="settingsViewToggle">
            <button data-mode="grid" class="${appState.viewMode === 'grid' ? 'active' : ''}"><i class="fa-solid fa-table-cells-large"></i></button>
            <button data-mode="list" class="${appState.viewMode === 'list' ? 'active' : ''}"><i class="fa-solid fa-list"></i></button>
          </div>
        </div>
        <div class="settings-row">
          <div>
            <div class="fw-semibold" style="font-size:0.85rem;">Default sort</div>
            <div class="text-muted" style="font-size:0.76rem;">How files are ordered by default</div>
          </div>
          <select class="form-select form-select-sm" id="settingsSortSelect" style="width:auto;">
            <option value="name" ${appState.sortKey === 'name' ? 'selected' : ''}>Name</option>
            <option value="date" ${appState.sortKey === 'date' ? 'selected' : ''}>Upload date</option>
            <option value="size" ${appState.sortKey === 'size' ? 'selected' : ''}>File size</option>
            <option value="type" ${appState.sortKey === 'type' ? 'selected' : ''}>File type</option>
          </select>
        </div>
      </section>

      <section class="settings-card">
        <h6 class="settings-card-title"><i class="fa-solid fa-database me-2"></i>Storage</h6>
        <div id="settingsStorageBody" class="text-muted" style="font-size:0.82rem;">Loading storage usage…</div>
      </section>

      <section class="settings-card settings-danger">
        <h6 class="settings-card-title text-danger"><i class="fa-solid fa-triangle-exclamation me-2"></i>Danger zone</h6>
        <div class="settings-row" style="border-top:none;padding-top:0;">
          <div>
            <div class="fw-semibold" style="font-size:0.85rem;">Empty trash</div>
            <div class="text-muted" style="font-size:0.76rem;">${trashCount} item${trashCount !== 1 ? 's' : ''} in Trash — this can't be undone</div>
          </div>
          <button class="btn btn-outline-danger btn-sm" id="settingsEmptyTrashBtn" ${trashCount === 0 ? 'disabled' : ''}>Empty trash</button>
        </div>
      </section>
    </div>
  `;

  el.querySelectorAll('#settingsViewToggle button').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      saveSettings({ defaultView: mode });
      el.querySelectorAll('#settingsViewToggle button').forEach(b => b.classList.toggle('active', b === btn));
      showToast('success', 'Preference saved', `Default view set to ${mode}`);
    });
  });

  el.querySelector('#settingsSortSelect').addEventListener('change', (e) => {
    saveSettings({ defaultSortKey: e.target.value });
    showToast('success', 'Preference saved', `Default sort set to ${e.target.options[e.target.selectedIndex].text}`);
  });

  el.querySelector('#settingsLogoutBtn').addEventListener('click', () => {
    document.getElementById('logoutBtn').click();
  });

  el.querySelector('#settingsEmptyTrashBtn').addEventListener('click', () => withBusyLock(() => emptyTrash()));

  DriveAPI.getStorageInfo().then(info => {
    const body = document.getElementById('settingsStorageBody');
    if (!body) return;
    if (!info || info.available === false || !info.limit) {
      body.textContent = 'Storage info unavailable. (Enable the Drive API advanced service in Apps Script to show real usage.)';
      return;
    }
    const pct = Math.min(100, (info.usage / info.limit) * 100);
    body.innerHTML = `
      <div class="d-flex justify-content-between mb-1">
        <span>${formatSize(info.usage)} used</span>
        <span>${formatSize(info.limit)} total</span>
      </div>
      <div class="storage-bar-track"><div class="storage-bar-fill" style="width:${pct}%;"></div></div>
    `;
  }).catch(() => {
    const body = document.getElementById('settingsStorageBody');
    if (body) body.textContent = 'Storage info unavailable.';
  });
}

async function emptyTrash() {
  if (!STATE.trash.length) return;
  const ids = STATE.trash.map(t => t.item.id);
  for (const id of ids) {
    await DriveAPI.permanentlyDelete(id);
  }
  showToast('success', 'Trash emptied', `${ids.length} item${ids.length !== 1 ? 's' : ''} permanently deleted`);
  renderContent();
}