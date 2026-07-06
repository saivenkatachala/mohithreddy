/* ============================================================
   DRIVE API ABSTRACTION LAYER
   ------------------------------------------------------------
   CONFIG.MODE = 'mock'      -> everything lives in browser memory
                                (js/mock-data.js). Nothing touches
                                a real Google Drive. Default mode —
                                works with zero setup.

   CONFIG.MODE = 'live'      -> talks DIRECTLY to the Google Drive
                                REST API v3 from the browser, using
                                an OAuth access token obtained via
                                Google Identity Services. Requires
                                the visitor to click "Connect Google
                                Drive" and approve access — and to
                                do it again once the token expires
                                (~1 hour) if the browser can't
                                silently refresh it.

   CONFIG.MODE = 'appscript' -> no login prompt at all. Calls a
                                Google Apps Script Web App (see
                                google-app-script/Code.gs) that you
                                deploy once under your own Google
                                account with "Execute as: Me". The
                                script always runs with YOUR Drive
                                access no matter who calls the URL,
                                so visitors never see a Google
                                sign-in screen. Set
                                CONFIG.APPS_SCRIPT_URL below to your
                                deployment's /exec URL and set
                                CONFIG.APPS_SCRIPT_ROOT_FOLDER_ID to
                                the Drive folder you want to expose
                                (must match ROOT_FOLDER_ID in
                                Code.gs). Trade-off: since there's
                                no per-visitor auth, this relies on
                                login.html's password gate (or your
                                own added protection) to keep
                                strangers out — see README.md.
   ============================================================ */

const CONFIG = {
  MODE: 'appscript', // this project is wired for Apps Script (no-login) mode by default
  DRIVE_ROOT_FOLDER_ID: 'root', // unused in appscript mode, kept for the optional OAuth path (see README "Option B")
  APPS_SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbzhHgGC_60wDovw7-eNpY15IljQ90n_HJuGCCiqyixGOfy3mOQ4fa3G4ytAxFyuy6b3HQ/exec', // <-- paste your deployed Web App URL here
};

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

const DriveAPI = {
  async _call(action, payload) {
    if (CONFIG.MODE === 'appscript' && CONFIG.APPS_SCRIPT_URL.includes('PASTE_YOUR_DEPLOYMENT_ID')) {
      return MockBackend[action](payload); // not deployed yet — demo data instead of a broken app
    }
    if (CONFIG.MODE === 'mock') return MockBackend[action](payload);
    if (CONFIG.MODE === 'appscript') return AppScriptBackend[action](payload);
    return LiveBackend[action](payload);
  },

  getTree: () => DriveAPI._call('getTree'),
  createFolder: (parentId, name) => DriveAPI._call('createFolder', { parentId, name }),
  renameNode: (id, name) => DriveAPI._call('renameNode', { id, name }),
  deleteNode: (id) => DriveAPI._call('deleteNode', { id }),
  restoreNode: (id) => DriveAPI._call('restoreNode', { id }),
  permanentlyDelete: (id) => DriveAPI._call('permanentlyDelete', { id }),
  moveNode: (id, newParentId) => DriveAPI._call('moveNode', { id, newParentId }),
  copyNode: (id, targetParentId) => DriveAPI._call('copyNode', { id, targetParentId }),
  uploadFile: (parentId, fileMeta) => DriveAPI._call('uploadFile', { parentId, fileMeta }),
  toggleFavorite: (id) => DriveAPI._call('toggleFavorite', { id }),
  ping: () => DriveAPI._call('ping'),
  getStorageInfo: () => DriveAPI._call('getStorageInfo'),
  logout: () => DriveAPI._call('logout'),

  /** Lazily resolves a usable blob: URL for a file's content (preview/download).
   *  Mock files already carry a blob URL from upload. Live/appscript files
   *  need their bytes fetched with credentials — a plain <img src="..."> can't
   *  attach the Authorization header 'live' mode needs, and 'appscript' mode
   *  needs a dedicated action since Apps Script has no direct binary-serving
   *  endpoint reachable from a public fetch(). */
  async ensureFileUrl(item) {
    if (item.type !== 'file' || item.url) return item.url;
    const notDeployedYet = CONFIG.MODE === 'appscript' && CONFIG.APPS_SCRIPT_URL.includes('PASTE_YOUR_DEPLOYMENT_ID');
    if (CONFIG.MODE === 'mock' || notDeployedYet) return null;
    if (CONFIG.MODE === 'appscript') {
      const { base64Data, mimeType } = await AppScriptBackend.getFileContent({ id: item.id });
      const blob = base64ToBlob(base64Data, mimeType);
      item.url = URL.createObjectURL(blob);
      return item.url;
    }
    const res = await authFetch(`${DRIVE_API}/files/${item.id}?alt=media`);
    const blob = await res.blob();
    item.url = URL.createObjectURL(blob);
    return item.url;
  },
};

function base64ToBlob(base64, mimeType) {
  const byteChars = atob(base64);
  const byteNumbers = new Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
  return new Blob([new Uint8Array(byteNumbers)], { type: mimeType || 'application/octet-stream' });
}

/* ============================================================
   APPS SCRIPT BACKEND — every call is a plain POST to your
   deployed Web App URL. The script runs as "Execute as: Me", so
   it has standing access to your Drive/Sheet/Gmail regardless of
   caller — which is exactly why every action except login/reset/
   ping requires a valid session token (see SESSION_TOKEN_KEY
   below). The token is issued by Code.gs on successful login and
   attached to every subsequent request automatically here, so
   app.js and login.html don't need to think about it.
   ============================================================ */
const SESSION_TOKEN_KEY = 'fe_session_token';

// Error messages Code.gs throws for a missing/expired/invalid token —
// used to detect an auth failure and bounce back to the login page
// instead of showing a confusing raw error in the middle of the app.
const AUTH_FAILURE_MESSAGES = ['Not authenticated. Please sign in again.', 'Session expired. Please sign in again.'];

function handleAuthFailure() {
  try {
    sessionStorage.removeItem('fe_session');
    sessionStorage.removeItem(SESSION_TOKEN_KEY);
  } catch (e) { /* sessionStorage unavailable — nothing to clean up */ }
  if (typeof window !== 'undefined' && !/login\.html/.test(window.location.pathname)) {
    window.location.href = 'login.html';
  }
}

const AppScriptBackend = {
  async _post(action, payload) {
    let token = null;
    try { token = sessionStorage.getItem(SESSION_TOKEN_KEY); } catch (e) { /* no sessionStorage */ }
    const body = token ? Object.assign({}, payload, { token }) : payload;

    const res = await fetch(CONFIG.APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // avoids an Apps Script CORS preflight
      body: JSON.stringify({ action, payload: body }),
    });
    if (!res.ok) throw new Error(`Network error contacting Apps Script (${res.status})`);
    const data = await res.json();
    if (data.error) {
      if (AUTH_FAILURE_MESSAGES.includes(data.error)) handleAuthFailure();
      throw new Error(data.error);
    }
    // A successful login response carries a fresh session token — persist it
    // here so every caller (login.html, DriveAPI, etc.) benefits automatically.
    if (action === 'login' && data.result && data.result.token) {
      try { sessionStorage.setItem(SESSION_TOKEN_KEY, data.result.token); } catch (e) { /* no sessionStorage */ }
    }
    return data.result;
  },

  async logout() {
    try {
      await AppScriptBackend._post('logout', {});
    } finally {
      try {
        sessionStorage.removeItem('fe_session');
        sessionStorage.removeItem(SESSION_TOKEN_KEY);
      } catch (e) { /* no sessionStorage */ }
    }
    return true;
  },

  async getTree() {
    const node = await AppScriptBackend._post('getTree', {});
    ROOT.id = node.id;
    ROOT.name = node.name;
    ROOT.createdAt = node.createdAt;
    ROOT.children = node.children;
    (function collectStars(n) {
      if (n.starred) STATE.favorites.add(n.id);
      (n.children || []).forEach(collectStars);
    })(node);
    return ROOT;
  },

  async createFolder({ parentId, name }) {
    const data = await AppScriptBackend._post('createFolder', { parentId, name });
    const node = { id: data.id, type: 'folder', name: data.name, createdAt: new Date().toISOString(), children: [] };
    const parent = findNode(parentId);
    if (parent) parent.children.push(node);
    return node;
  },

  async renameNode({ id, name }) {
    await AppScriptBackend._post('renameNode', { id, name });
    const node = findNode(id);
    if (node) node.name = name;
    return node;
  },

  async deleteNode({ id }) {
    await AppScriptBackend._post('deleteNode', { id });
    const { parent, node, index } = findWithParent(id);
    if (node) {
      parent.children.splice(index, 1);
      STATE.trash.push({ item: node, originalParentId: parent.id });
    }
    return true;
  },

  async restoreNode({ id }) {
    await AppScriptBackend._post('restoreNode', { id });
    const idx = STATE.trash.findIndex(t => t.item.id === id);
    if (idx !== -1) {
      const entry = STATE.trash[idx];
      const parent = findNode(entry.originalParentId) || ROOT;
      parent.children.push(entry.item);
      STATE.trash.splice(idx, 1);
    }
    return true;
  },

  async permanentlyDelete({ id }) {
    await AppScriptBackend._post('permanentlyDelete', { id });
    const idx = STATE.trash.findIndex(t => t.item.id === id);
    if (idx !== -1) STATE.trash.splice(idx, 1);
    return true;
  },

  async moveNode({ id, newParentId }) {
    await AppScriptBackend._post('moveNode', { id, newParentId });
    const { parent, node, index } = findWithParent(id);
    const target = findNode(newParentId);
    if (node && parent && target) {
      parent.children.splice(index, 1);
      target.children.push(node);
    }
    return true;
  },

  async copyNode({ id, targetParentId }) {
    const node = await AppScriptBackend._post('copyNode', { id, targetParentId });
    const target = findNode(targetParentId);
    if (target) target.children.push(node);
    STATE.recentIds.unshift(node.id);
    return node;
  },

  async uploadFile({ parentId, fileMeta }) {
    const base64Data = await fileToBase64(fileMeta.rawFile);
    const data = await AppScriptBackend._post('uploadFile', {
      parentId,
      fileMeta: { name: fileMeta.name, mimeType: fileMeta.rawFile.type, base64Data },
    });
    const parent = findNode(parentId);
    const node = {
      id: data.id, type: 'file', name: data.name,
      ext: fileMeta.ext, size: Number(data.size) || fileMeta.size,
      createdAt: new Date().toISOString(),
      url: fileMeta.url, // local blob preview already available immediately
    };
    if (parent) parent.children.push(node);
    STATE.recentIds.unshift(node.id);
    return node;
  },

  async toggleFavorite({ id }) {
    const nowStarred = !STATE.favorites.has(id);
    await AppScriptBackend._post('toggleFavorite', { id });
    if (nowStarred) STATE.favorites.add(id); else STATE.favorites.delete(id);
    return nowStarred;
  },

  async getFileContent({ id }) {
    return AppScriptBackend._post('getFileContent', { id });
  },

  async ping() {
    return AppScriptBackend._post('ping', {});
  },

  async getStorageInfo() {
    return AppScriptBackend._post('getStorageInfo', {});
  },
};

/* ============================================================
   MOCK BACKEND — unchanged in-memory simulation

   ============================================================ */
const MockBackend = {
  logout: () => { try { sessionStorage.removeItem('fe_session'); sessionStorage.removeItem(SESSION_TOKEN_KEY); } catch (e) {} return Promise.resolve(true); },
  getTree: () => Promise.resolve(ROOT),

  createFolder: ({ parentId, name }) => {
    const parent = findNode(parentId);
    if (!parent) return Promise.reject('Parent not found');
    const f = folder(name);
    parent.children.push(f);
    return Promise.resolve(f);
  },

  renameNode: ({ id, name }) => {
    const node = findNode(id);
    if (!node) return Promise.reject('Not found');
    node.name = name;
    return Promise.resolve(node);
  },

  deleteNode: ({ id }) => {
    const { parent, node, index } = findWithParent(id);
    if (!node) return Promise.reject('Not found');
    parent.children.splice(index, 1);
    STATE.trash.push({ item: node, originalParentId: parent.id });
    return Promise.resolve(true);
  },

  restoreNode: ({ id }) => {
    const idx = STATE.trash.findIndex(t => t.item.id === id);
    if (idx === -1) return Promise.reject('Not in trash');
    const entry = STATE.trash[idx];
    const parent = findNode(entry.originalParentId) || ROOT;
    parent.children.push(entry.item);
    STATE.trash.splice(idx, 1);
    return Promise.resolve(true);
  },

  permanentlyDelete: ({ id }) => {
    const idx = STATE.trash.findIndex(t => t.item.id === id);
    if (idx !== -1) STATE.trash.splice(idx, 1);
    return Promise.resolve(true);
  },

  moveNode: ({ id, newParentId }) => {
    const { parent, node, index } = findWithParent(id);
    const target = findNode(newParentId);
    if (!node || !target || target.type !== 'folder') return Promise.reject('Invalid move');
    if (id === newParentId) return Promise.reject('Cannot move into itself');
    parent.children.splice(index, 1);
    target.children.push(node);
    return Promise.resolve(true);
  },

  copyNode: ({ id, targetParentId }) => {
    const source = findNode(id);
    const target = findNode(targetParentId);
    if (!source || !target || target.type !== 'folder') return Promise.reject('Invalid copy');
    const clone = deepCloneWithNewIds(source);
    target.children.push(clone);
    STATE.recentIds.unshift(clone.id);
    return Promise.resolve(clone);
  },

  uploadFile: ({ parentId, fileMeta }) => {
    const parent = findNode(parentId);
    if (!parent) return Promise.reject('Parent not found');
    const f = file(fileMeta.name, Math.round(fileMeta.size / 1024), fileMeta.ext);
    f.url = fileMeta.url;
    parent.children.push(f);
    STATE.recentIds.unshift(f.id);
    return Promise.resolve(f);
  },

  toggleFavorite: ({ id }) => {
    if (STATE.favorites.has(id)) STATE.favorites.delete(id);
    else STATE.favorites.add(id);
    return Promise.resolve(STATE.favorites.has(id));
  },

  ping: () => Promise.resolve({ ok: true, rootFolderName: ROOT.name, rootFolderId: ROOT.id, demo: true }),

  getStorageInfo: () => {
    const usage = collectAll(ROOT).filter(n => n.type === 'file').reduce((sum, f) => sum + (f.size || 0), 0);
    return Promise.resolve({ available: true, usage, limit: 15 * 1024 * 1024 * 1024, demo: true }); // 15GB, the free Drive tier
  },
};

/* ============================================================
   LIVE BACKEND — real Google Drive via REST API v3, called
   directly from the browser with an OAuth access token.
   Mutates the same in-memory ROOT/STATE structures as the mock
   backend after each successful Drive call, so every rendering
   function in app.js works unchanged regardless of mode.
   ============================================================ */

async function authFetch(url, options = {}) {
  await GoogleAuth.requestAccessToken({ silent: true });
  const res = await fetch(url, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${GoogleAuth.accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Drive API error (${res.status}): ${text || res.statusText}`);
  }
  return res;
}

async function fetchDriveNode(id, knownMeta) {
  let name, createdAt;
  if (knownMeta) {
    name = knownMeta.name;
    createdAt = knownMeta.createdAt;
  } else {
    const res = await authFetch(`${DRIVE_API}/files/${id}?fields=id,name,createdTime`);
    const meta = await res.json();
    name = meta.name;
    createdAt = meta.createdTime || new Date().toISOString();
  }

  const q = encodeURIComponent(`'${id}' in parents and trashed = false`);
  const listRes = await authFetch(`${DRIVE_API}/files?q=${q}&fields=files(id,name,mimeType,size,createdTime,starred)&pageSize=1000`);
  const listData = await listRes.json();

  const children = [];
  for (const f of listData.files || []) {
    if (f.starred) STATE.favorites.add(f.id);
    if (f.mimeType === FOLDER_MIME) {
      children.push(await fetchDriveNode(f.id, { name: f.name, createdAt: f.createdTime }));
    } else {
      children.push({
        id: f.id,
        type: 'file',
        name: f.name,
        ext: (f.name.split('.').pop() || '').toLowerCase(),
        size: Number(f.size) || 0,
        createdAt: f.createdTime,
        mimeType: f.mimeType,
        url: null, // resolved lazily via DriveAPI.ensureFileUrl()
      });
    }
  }
  return { id, type: 'folder', name, createdAt, children };
}

/** Recursively duplicates a Drive file or folder into targetParentId via
 *  the Drive API v3. files.copy only duplicates a folder's own metadata
 *  (not its contents), so folders are handled by creating a new folder
 *  and copying each child into it one by one. */
async function copyDriveNode(id, targetParentId) {
  const metaRes = await authFetch(`${DRIVE_API}/files/${id}?fields=id,name,mimeType`);
  const meta = await metaRes.json();

  if (meta.mimeType === FOLDER_MIME) {
    const createdRes = await authFetch(`${DRIVE_API}/files?fields=id,name,createdTime`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: meta.name, mimeType: FOLDER_MIME, parents: [targetParentId] }),
    });
    const created = await createdRes.json();
    const node = { id: created.id, type: 'folder', name: created.name, createdAt: created.createdTime, children: [] };

    const q = encodeURIComponent(`'${id}' in parents and trashed = false`);
    const listRes = await authFetch(`${DRIVE_API}/files?q=${q}&fields=files(id)&pageSize=1000`);
    const listData = await listRes.json();
    for (const child of listData.files || []) {
      node.children.push(await copyDriveNode(child.id, created.id));
    }
    return node;
  }

  const copyRes = await authFetch(`${DRIVE_API}/files/${id}/copy?fields=id,name,createdTime,size`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parents: [targetParentId] }),
  });
  const copy = await copyRes.json();
  return {
    id: copy.id,
    type: 'file',
    name: copy.name,
    ext: (copy.name.split('.').pop() || '').toLowerCase(),
    size: Number(copy.size) || 0,
    createdAt: copy.createdTime,
    url: null,
  };
}

async function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

const LiveBackend = {
  logout: () => { try { sessionStorage.removeItem('fe_session'); sessionStorage.removeItem(SESSION_TOKEN_KEY); } catch (e) {} return Promise.resolve(true); },
  async getTree() {
    const node = await fetchDriveNode(CONFIG.DRIVE_ROOT_FOLDER_ID);
    ROOT.id = node.id;
    ROOT.name = node.name;
    ROOT.createdAt = node.createdAt;
    ROOT.children = node.children;
    return ROOT;
  },

  async createFolder({ parentId, name }) {
    const res = await authFetch(`${DRIVE_API}/files?fields=id,name,createdTime`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
    });
    const data = await res.json();
    const node = { id: data.id, type: 'folder', name: data.name, createdAt: data.createdTime, children: [] };
    const parent = findNode(parentId);
    if (parent) parent.children.push(node);
    return node;
  },

  async renameNode({ id, name }) {
    await authFetch(`${DRIVE_API}/files/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const node = findNode(id);
    if (node) node.name = name;
    return node;
  },

  async deleteNode({ id }) {
    await authFetch(`${DRIVE_API}/files/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trashed: true }),
    });
    const { parent, node, index } = findWithParent(id);
    if (node) {
      parent.children.splice(index, 1);
      STATE.trash.push({ item: node, originalParentId: parent.id });
    }
    return true;
  },

  async restoreNode({ id }) {
    await authFetch(`${DRIVE_API}/files/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trashed: false }),
    });
    const idx = STATE.trash.findIndex(t => t.item.id === id);
    if (idx !== -1) {
      const entry = STATE.trash[idx];
      const parent = findNode(entry.originalParentId) || ROOT;
      parent.children.push(entry.item);
      STATE.trash.splice(idx, 1);
    }
    return true;
  },

  async permanentlyDelete({ id }) {
    await authFetch(`${DRIVE_API}/files/${id}`, { method: 'DELETE' });
    const idx = STATE.trash.findIndex(t => t.item.id === id);
    if (idx !== -1) STATE.trash.splice(idx, 1);
    return true;
  },

  async moveNode({ id, newParentId }) {
    const metaRes = await authFetch(`${DRIVE_API}/files/${id}?fields=parents`);
    const meta = await metaRes.json();
    const oldParents = (meta.parents || []).join(',');
    await authFetch(`${DRIVE_API}/files/${id}?addParents=${newParentId}&removeParents=${oldParents}&fields=id,parents`, {
      method: 'PATCH',
    });
    const { parent, node, index } = findWithParent(id);
    const target = findNode(newParentId);
    if (node && parent && target) {
      parent.children.splice(index, 1);
      target.children.push(node);
    }
    return true;
  },

  async copyNode({ id, targetParentId }) {
    const node = await copyDriveNode(id, targetParentId);
    const target = findNode(targetParentId);
    if (target) target.children.push(node);
    return node;
  },

  async uploadFile({ parentId, fileMeta }) {
    // fileMeta.rawFile is the actual browser File object (see app.js handleFiles).
    const rawFile = fileMeta.rawFile;
    const base64Data = await fileToBase64(rawFile);
    const boundary = 'fileexplorer-boundary-' + Date.now();
    const metadata = { name: fileMeta.name, parents: [parentId] };
    const body =
      `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: ${rawFile.type || 'application/octet-stream'}\r\n` +
      `Content-Transfer-Encoding: base64\r\n\r\n` +
      `${base64Data}\r\n` +
      `--${boundary}--`;

    const res = await authFetch(`${DRIVE_UPLOAD_API}?uploadType=multipart&fields=id,name,size,createdTime`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
    const data = await res.json();
    const parent = findNode(parentId);
    const node = {
      id: data.id, type: 'file', name: data.name,
      ext: fileMeta.ext, size: Number(data.size) || rawFile.size,
      createdAt: data.createdTime || new Date().toISOString(),
      url: fileMeta.url, // local blob preview already available immediately
    };
    if (parent) parent.children.push(node);
    STATE.recentIds.unshift(node.id);
    return node;
  },

  async toggleFavorite({ id }) {
    const nowStarred = !STATE.favorites.has(id);
    await authFetch(`${DRIVE_API}/files/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ starred: nowStarred }),
    });
    if (nowStarred) STATE.favorites.add(id); else STATE.favorites.delete(id);
    return nowStarred;
  },
};

/* ---- Tree helpers (operate on the in-memory ROOT, shared by both backends) ---- */
function findNode(id, node = ROOT) {
  if (node.id === id) return node;
  if (node.children) {
    for (const c of node.children) {
      const found = findNode(id, c);
      if (found) return found;
    }
  }
  return null;
}

function findWithParent(id, node = ROOT, parent = null) {
  if (node.id === id) return { parent, node, index: parent ? parent.children.indexOf(node) : -1 };
  if (node.children) {
    for (const c of node.children) {
      const res = findWithParent(id, c, node);
      if (res.node) return res;
    }
  }
  return { parent: null, node: null, index: -1 };
}

function getPathNodes(id, node = ROOT, trail = []) {
  const newTrail = [...trail, node];
  if (node.id === id) return newTrail;
  if (node.children) {
    for (const c of node.children) {
      const res = getPathNodes(id, c, newTrail);
      if (res) return res;
    }
  }
  return null;
}

function collectAll(node = ROOT, out = []) {
  out.push(node);
  if (node.children) node.children.forEach(c => collectAll(c, out));
  return out;
}

/** Deep-clones a node (and, for folders, its whole subtree) with brand
 *  new ids and createdAt timestamps — used by MockBackend.copyNode so a
 *  "Copy" behaves like a real duplicate, not a second reference to the
 *  same node. */
function deepCloneWithNewIds(node) {
  const clone = {
    id: nextId(),
    type: node.type,
    name: node.name,
    createdAt: new Date().toISOString(),
  };
  if (node.type === 'folder') {
    clone.children = (node.children || []).map(deepCloneWithNewIds);
  } else {
    clone.ext = node.ext;
    clone.size = node.size;
    clone.url = node.url; // mock files just reuse the same local blob URL/preview
  }
  return clone;
}