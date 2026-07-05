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
  APPS_SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbz7TvcC0eN5HRPRs6A9UMGfQuhi3FHLMy0WTm5EjjTsE1J4QWABfRnLolFzK-0TXu5-DQ/exec', // <-- paste your deployed Web App URL here
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
  uploadFile: (parentId, fileMeta) => DriveAPI._call('uploadFile', { parentId, fileMeta }),
  toggleFavorite: (id) => DriveAPI._call('toggleFavorite', { id }),
  ping: () => DriveAPI._call('ping'),
  getStorageInfo: () => DriveAPI._call('getStorageInfo'),

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
   APPS SCRIPT BACKEND — no browser-side login required. Every
   call is a plain POST to your deployed Web App URL; the script
   itself already has standing access to your Drive because it
   runs as "Execute as: Me". Mutates the shared ROOT/STATE tree
   just like the other backends so app.js needs no branching.
   ============================================================ */
const AppScriptBackend = {
  async _post(action, payload) {
    const res = await fetch(CONFIG.APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // avoids an Apps Script CORS preflight
      body: JSON.stringify({ action, payload }),
    });
    if (!res.ok) throw new Error(`Network error contacting Apps Script (${res.status})`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return data.result;
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
    const node = { id: data.id, type: 'folder', name: data.name, createdAt: new Date().toISOString(), seq: nextSeq(), children: [] };
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
      seq: nextSeq(),
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

async function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

const LiveBackend = {
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
    const node = { id: data.id, type: 'folder', name: data.name, createdAt: data.createdTime, seq: nextSeq(), children: [] };
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
      seq: nextSeq(),
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