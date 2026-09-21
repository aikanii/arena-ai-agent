'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function homeDir() {
  return path.join(os.homedir(), '.arena-agent');
}

function projectSlug(root) {
  const hash = crypto.createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 10);
  const name = path.basename(path.resolve(root)).replace(/[^a-zA-Z0-9._-]/g, '_');
  return `${name}-${hash}`;
}

class SessionStore {
  constructor(root) {
    this.root = path.resolve(root);
    this.dir = path.join(homeDir(), 'projects', projectSlug(root), 'sessions');
  }

  ensure() {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  newSession({ model, mode }) {
    this.ensure();
    const now = new Date();
    const id =
      now.toISOString().replace(/[-:T]/g, '').slice(0, 14).replace(/^(\d{8})(\d{6})$/, '$1-$2') +
      '-' +
      crypto.randomBytes(2).toString('hex');
    return {
      id,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      cwd: this.root,
      model,
      mode,
      messages: [],
      plan: null,
      usage: { promptTokens: 0, completionTokens: 0, turns: 0 },
    };
  }

  fileFor(id) {
    return path.join(this.dir, `${id}.json`);
  }

  save(session) {
    try {
      this.ensure();
      session.updatedAt = new Date().toISOString();
      const tmp = this.fileFor(session.id) + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(session, null, 1));
      fs.renameSync(tmp, this.fileFor(session.id));
    } catch {
      /* best effort */
    }
  }

  load(id) {
    try {
      return JSON.parse(fs.readFileSync(this.fileFor(id), 'utf8'));
    } catch {
      return null;
    }
  }

  list() {
    try {
      this.ensure();
      const items = [];
      for (const f of fs.readdirSync(this.dir)) {
        if (!f.endsWith('.json')) continue;
        try {
          const s = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8'));
          const firstUser = (s.messages || []).find((m) => m.role === 'user' && typeof m.content === 'string');
          items.push({
            id: s.id,
            updatedAt: s.updatedAt,
            messageCount: (s.messages || []).length,
            firstUser: firstUser ? String(firstUser.content).slice(0, 70) : '(no user message)',
          });
        } catch {
          /* skip corrupt */
        }
      }
      items.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
      return items;
    } catch {
      return [];
    }
  }

  latest() {
    const all = this.list();
    return all.length ? this.load(all[0].id) : null;
  }
}

module.exports = { SessionStore, homeDir, projectSlug };
