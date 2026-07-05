/* ============================================================
   MOCK DATA LAYER
   Simulates a Google Drive folder/file hierarchy entirely in
   memory so the UI is fully testable without any backend.
   Swap DriveAPI's internals (in api.js) to call the real
   Google Apps Script endpoint once deployed — see README.
   ============================================================ */

let __id = 0;
function nextId() { return 'n' + (++__id); }

function folder(name, children = []) {
  return { id: nextId(), type: 'folder', name, createdAt: randomDate(), children };
}
function file(name, sizeKB, ext, days = 5) {
  return {
    id: nextId(), type: 'file', name, ext,
    size: sizeKB * 1024,
    createdAt: randomDate(days),
    url: null // populated with a blob URL when user uploads a real file
  };
}
function randomDate(maxDaysAgo = 60) {
  const d = new Date();
  d.setDate(d.getDate() - Math.floor(Math.random() * maxDaysAgo));
  return d.toISOString();
}

const ROOT = folder('Home', [
  folder('Projects', [
    folder('Website', [
      folder('Images', [
        file('hero-banner.png', 820, 'png'),
        file('logo-final.svg', 42, 'svg'),
        file('team-photo.jpg', 1400, 'jpg'),
      ]),
      folder('CSS', [
        file('style.css', 18, 'css'),
        file('reset.css', 4, 'css'),
      ]),
      folder('JavaScript', [
        file('app.js', 26, 'js'),
        file('utils.js', 9, 'js'),
      ]),
    ]),
    folder('Office', [
      folder('Reports', [
        file('Q1-financial-report.pdf', 2300, 'pdf'),
        file('Q2-financial-report.pdf', 2100, 'pdf'),
      ]),
      folder('Documents', [
        file('meeting-notes.docx', 88, 'docx'),
        file('project-charter.docx', 145, 'docx'),
      ]),
    ]),
    folder('Personal', [
      folder('Photos', [
        file('vacation-2025.jpg', 3100, 'jpg'),
        file('birthday-party.jpg', 2650, 'jpg'),
      ]),
      folder('Videos', [
        file('family-trip.mp4', 45000, 'mp4'),
      ]),
    ]),
  ]),
  folder('Downloads', [
    file('setup-installer.zip', 15400, 'zip'),
    file('invoice-2026.pdf', 210, 'pdf'),
  ]),
  folder('Shared with me', []),
  file('budget-2026.xlsx', 62, 'xlsx'),
  file('presentation-final.pptx', 5400, 'pptx'),
  file('welcome-note.txt', 2, 'txt'),
]);

// Track favorites / trash / recent as id sets + lists (in-memory only)
const STATE = {
  favorites: new Set(),
  trash: [],       // { item, originalParentId }
  recentIds: [],   // most-recently-touched file ids, front = newest
};