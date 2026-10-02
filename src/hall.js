// Hall of Thumbs: the best thumbnail from recent games whose host opted in.
//
// Entries live in memory and are mirrored to HALL_DIR (default ./data/hall)
// so they survive a restart on hosts with a persistent disk. Images are
// written as files rather than kept as data URLs so the landing page can
// load them like normal images.

const fs = require('fs');
const path = require('path');

const HALL_DIR = process.env.HALL_DIR || path.join(__dirname, '..', 'data', 'hall');
const INDEX_FILE = path.join(HALL_DIR, 'index.json');
const MAX_ENTRIES = 12;

let entries = [];

function load() {
  try {
    entries = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    if (!Array.isArray(entries)) entries = [];
  } catch {
    entries = [];
  }
}

function save() {
  try {
    fs.mkdirSync(HALL_DIR, { recursive: true });
    fs.writeFileSync(INDEX_FILE, JSON.stringify(entries));
  } catch (e) {
    console.error('Hall of Thumbs: could not save index', e.message);
  }
}

// entry: { png (data URL), title, creator, writer, artist }
function add(entry) {
  const match = /^data:image\/(png|jpeg);base64,(.+)$/.exec(entry.png || '');
  if (!match) return;
  const ext = match[1] === 'png' ? 'png' : 'jpg';
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const file = `${id}.${ext}`;
  try {
    fs.mkdirSync(HALL_DIR, { recursive: true });
    fs.writeFileSync(path.join(HALL_DIR, file), Buffer.from(match[2], 'base64'));
  } catch (e) {
    console.error('Hall of Thumbs: could not save image', e.message);
    return;
  }
  entries.unshift({
    id,
    file,
    title: entry.title,
    creator: entry.creator,
    writer: entry.writer,
    artist: entry.artist,
    at: Date.now()
  });
  for (const old of entries.splice(MAX_ENTRIES)) {
    try { fs.unlinkSync(path.join(HALL_DIR, old.file)); } catch {}
  }
  save();
}

function list() {
  return entries.map((e) => ({
    image: `/hall-images/${e.file}`,
    title: e.title,
    creator: e.creator,
    writer: e.writer,
    artist: e.artist,
    at: e.at
  }));
}

load();

module.exports = { add, list, HALL_DIR };
