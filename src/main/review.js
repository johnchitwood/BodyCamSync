'use strict';
// The reviewer's layer on top of the machine transcript: names, speaker assignments, text edits,
// and a history of every change. The machine transcript itself is never modified.
const fs = require('fs');
const path = require('path');
const store = require('./store');

const empty = () => ({ version: 1, people: [], clusters: {}, lines: {}, log: [] });
const file = (id) => path.join(store.dir(id), 'review.json');

function load(id) {
  try {
    const r = JSON.parse(fs.readFileSync(file(id), 'utf8'));
    return Object.assign(empty(), r);
  } catch (_) { return empty(); }
}

function save(id, review) {
  const tmp = file(id) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(review));
  fs.renameSync(tmp, file(id));
  // keep a rolling safety copy so a bad edit session can always be recovered
  try { fs.copyFileSync(file(id), file(id) + '.bak'); } catch (_) { /* ignore */ }
  return true;
}

module.exports = { load, save };
