"use strict";
// UploadG Sync v0.5.1 (fixes: empty files / small-limit uploads, empty folders now sync)
// - Cloud mirrors your vault under the "Remote folder" (e.g. ObsidianSync/notes) with real folders/files.
// - Plugin metadata (index.json with original modified times + hashes) lives in a SEPARATE cloud folder:
//   <parent of remote folder>/<Plugin data folder>/<vault folder name>/index.json  e.g. ObsidianSync/_sync/notes/index.json
// - Folders are created explicitly and files are uploaded by folder ID (no path tricks).
// - Newer modified time wins in either direction; on a tie the LOCAL file wins.
// - Local files are NEVER deleted. Before a local file is overwritten by a cloud version, a copy is saved in
//   <vault>/.obsidian/plugins/uploadg-sync/backups/<date>/ (kept 14 days).
const { Plugin, PluginSettingTab, Setting, Notice, Modal, TFile, TFolder, requestUrl, normalizePath } = require("obsidian");

const BACKUP_DAYS = 14;
const PART_SIZE = 8 * 1024 * 1024;

const DEFAULTS = {
  token: "",
  apiBase: "https://uploadg.com/api/v1",
  remoteRoot: "", // e.g. ObsidianSync/notes
  remoteRootId: "", // optional folder ID override
  syncFolder: "_sync", // metadata folder name (sibling of the remote folder)
  downloadTemplate: "{api}/file-entries/download/{hash}",
  exclude: "",
  cloudIgnore: "blobs/\nmanifests/\nprobe/", // leftovers from old versions, ignored on both sides
  propagateDeletes: false,
};

const MIME = {
  md: "text/markdown", txt: "text/plain", json: "application/json", pdf: "application/pdf",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml",
  webp: "image/webp", mp3: "audio/mpeg", mp4: "video/mp4", html: "text/html", epub: "application/epub+zip",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (buf) => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (buf) => hex(await crypto.subtle.digest("SHA-256", buf));
const toAB = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
const extOf = (name) => { const i = name.lastIndexOf("."); return i > 0 ? name.slice(i + 1) : ""; };

module.exports = class UploadGSync extends Plugin {
  async onload() {
    const saved = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULTS, saved.settings);
    delete this.settings.autoSyncMinutes;
    if (!this.settings.remoteRoot) {
      const vid = (saved.settings && saved.settings.vaultId) || this.defaultVaultId();
      this.settings.remoteRoot = "ObsidianSync/" + vid;
    }
    // state v5: synced[path] = { hash, entryId }; chainIds caches folder IDs; root remembers which folder synced.
    this.state = saved.state && saved.state.v === 5 ? saved.state : { v: 5, synced: {}, hashCache: {}, chainIds: {}, root: "" };

    this.addSettingTab(new SettingsTab(this.app, this));
    this.addRibbonIcon("refresh-cw", "Sync with UploadG", () => this.syncAll());
    this.addCommand({ id: "sync", name: "Sync with UploadG", hotkeys: [{ modifiers: ["Mod", "Shift"], key: "U" }], callback: () => this.syncAll() });
    this.addCommand({ id: "preview", name: "Preview sync (changes nothing)", callback: () => this.syncAll(true) });
    this.addCommand({ id: "test", name: "Test connection and detect download URL", callback: () => this.test() });
  }

  defaultVaultId() {
    const n = (this.app.vault.getName() || "vault").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    return n || "vault";
  }

  saveAll() { return this.saveData({ settings: this.settings, state: this.state }); }
  rootSegments() { return this.settings.remoteRoot.split("/").map((s) => s.trim()).filter(Boolean); }
  metaSegments() {
    const segs = this.rootSegments();
    return segs.slice(0, -1).concat([this.settings.syncFolder || "_sync", segs[segs.length - 1]]);
  }

  // ---------- HTTP ----------

  authHeaders() { return { Authorization: "Bearer " + this.settings.token }; }

  multipart(fields, fileName, data, mime) {
    const boundary = "----ugsync" + Math.random().toString(16).slice(2);
    const enc = new TextEncoder();
    const parts = [];
    for (const [k, v] of Object.entries(fields)) {
      parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    }
    const safe = fileName.replace(/"/g, "_");
    parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safe}"\r\nContent-Type: ${mime}\r\n\r\n`));
    parts.push(new Uint8Array(data));
    parts.push(enc.encode(`\r\n--${boundary}--\r\n`));
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return { body: toAB(out), contentType: `multipart/form-data; boundary=${boundary}` };
  }

  async api(method, path, opts = {}) {
    let url = this.settings.apiBase + path;
    if (opts.query) url += "?" + new URLSearchParams(opts.query).toString();
    const req = { url, method, headers: Object.assign({ Accept: "application/json" }, this.authHeaders()), throw: false };
    if (opts.json !== undefined) { req.body = JSON.stringify(opts.json); req.contentType = "application/json"; }
    else if (opts.body) { req.body = opts.body; req.contentType = opts.contentType; }
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await requestUrl(req);
      if (res.status === 429) {
        const wait = Number(res.headers["retry-after"] || res.headers["Retry-After"]) || 5;
        await sleep(Math.min(wait, 60) * 1000);
        continue;
      }
      if (res.status >= 400) {
        let msg = "";
        try {
          const j = res.json;
          msg = j.message || "";
          if (j.errors && typeof j.errors === "object") msg += " " + JSON.stringify(j.errors);
        } catch (e) { /* not json */ }
        throw new Error(`${method} ${path} -> ${res.status} ${msg}`.trim());
      }
      return res;
    }
    throw new Error("Rate limited for too long, try again later");
  }

  fillTemplate(t, id, hash) {
    return t.split("{api}").join(this.settings.apiBase).split("{id}").join(String(id)).split("{hash}").join(String(hash));
  }

  async download(entry) {
    const url = this.fillTemplate(this.settings.downloadTemplate, entry.id, entry.hash);
    const res = await requestUrl({ url, headers: this.authHeaders(), throw: false });
    if (res.status !== 200) throw new Error(`Download failed (${res.status}) for ${entry.name}. Run "Test connection and detect download URL".`);
    return res.arrayBuffer;
  }

  // Only ever deletes CLOUD entries (the old copy being replaced). Trash first, then delete forever.
  async removeRemote(ids) {
    await this.api("POST", "/file-entries/delete", { json: { entryIds: ids, deleteForever: false } });
    for (let n = 0; n < 10; n++) {
      const r = await this.api("POST", "/file-entries/delete", { json: { entryIds: ids, deleteForever: true } });
      if (!(r.json && r.json.deletion && r.json.deletion.hasMore)) break;
    }
  }

  // ---------- Cloud folders ----------

  async listEntries(query) {
    const all = [];
    for (let page = 1; page <= 200; page++) {
      const res = await this.api("GET", "/drive/file-entries", { query: Object.assign({ perPage: "100", page: String(page) }, query) });
      all.push(...(res.json.data || []));
      if (!res.json.last_page || page >= res.json.last_page) break;
    }
    return all;
  }

  async createFolder(name, parentId) {
    if (name.length < 3) throw new Error(`Folder name "${name}" is too short: UploadG needs at least 3 characters. Rename it in your vault.`);
    const res = await this.api("POST", "/folders", { json: { name, parentId: parentId || null } });
    const f = res.json && res.json.folder;
    if (!f || !f.id) throw new Error(`UploadG did not return the new folder "${name}".`);
    return f.id;
  }

  // Finds (or, if create is true, creates) the folder chain segs[0]/segs[1]/... starting at the drive root.
  async ensureChain(segs, create) {
    const key = segs.join("/");
    if (this.state.chainIds[key]) return this.state.chainIds[key];
    const folders = new Map();
    for (const seg of new Set(segs)) {
      for (const e of await this.listEntries({ section: "search", query: seg })) {
        if (e.type === "folder" && e.name === seg) folders.set(e.id, e);
      }
    }
    const ok = (f, k) => {
      let cur = f;
      for (let i = k - 1; i >= 0; i--) {
        if (!cur || cur.name !== segs[i]) return false;
        if (i === 0) return !cur.parent_id;
        cur = folders.get(cur.parent_id);
      }
      return false;
    };
    let k = segs.length, found = null;
    for (; k >= 1; k--) {
      found = [...folders.values()].find((f) => ok(f, k));
      if (found) break;
    }
    if (k === segs.length) { this.state.chainIds[key] = found.id; return found.id; }
    if (!create) return null;
    let parentId = found ? found.id : null;
    for (let i = k; i < segs.length; i++) parentId = await this.createFolder(segs[i], parentId);
    this.state.chainIds[key] = parentId;
    await this.saveAll();
    return parentId;
  }

  async resolveRoot(create) {
    if (this.settings.remoteRootId) return this.settings.remoteRootId;
    if (!this.rootSegments().length) throw new Error("Set the remote folder in settings (e.g. ObsidianSync/notes).");
    return this.ensureChain(this.rootSegments(), create);
  }

  async listRemote(rootId) {
    const out = new Map();
    this.dirIds = new Map();
    const walk = async (folderId, prefix) => {
      for (const e of await this.listEntries({ section: "folder", folderId: String(folderId) })) {
        if (e.type === "folder") {
          this.dirIds.set(prefix + e.name, e.id);
          await walk(e.id, prefix + e.name + "/");
        } else out.set(prefix + e.name, e);
      }
    };
    await walk(rootId, "");
    return out;
  }

  // Makes sure the cloud sub-folders for a vault path exist and returns the folder ID for the file.
  async ensureDir(relPath) {
    let key = "", parent = this.rootId;
    for (const seg of relPath.split("/").slice(0, -1)) {
      key = key ? key + "/" + seg : seg;
      let id = this.dirIds.get(key);
      if (!id) { id = await this.createFolder(seg, parent); this.dirIds.set(key, id); }
      parent = id;
    }
    return parent;
  }

  // ---------- Uploads ----------

  // Original behaviour: plain upload up to the server-reported max size.
  simpleLimit() { return this.run.maxSize - 8192; }

  async uploadFile(name, data, parentId) {
    const ext = extOf(name).toLowerCase();
    const mime = MIME[ext] || "application/octet-stream";
    if (data.byteLength === 0 || data.byteLength <= this.simpleLimit()) {
      const fields = parentId ? { parentId: String(parentId) } : {};
      const { body, contentType } = this.multipart(fields, name, data, mime);
      try {
        return (await this.api("POST", "/uploads", { body, contentType })).json.fileEntry;
      } catch (e) {
        if (data.byteLength === 0) { const err = new Error("empty (0-byte) file refused by UploadG: " + e.message); err.emptyFile = true; throw err; }
        throw e;
      }
    }
    return this.uploadMultipart(name, ext, mime, data, parentId);
  }

  async uploadMultipart(name, ext, mime, data, parentId) {
    const c = (await this.api("POST", "/s3/multipart/create", {
      json: { filename: name, mime, size: data.byteLength, extension: ext || "bin", parentId: parentId || null },
    })).json;
    const session = { key: c.key, uploadId: c.uploadId, uploadToken: c.uploadToken };
    try {
      const count = Math.max(1, Math.ceil(data.byteLength / PART_SIZE)); // an empty file still needs one (empty) part
      const parts = [];
      for (let start = 1; start <= count; start += 100) {
        const nums = [];
        for (let n = start; n < start + 100 && n <= count; n++) nums.push(n);
        const signed = (await this.api("POST", "/s3/multipart/batch-sign-part-urls", { json: Object.assign({ partNumbers: nums }, session) })).json.urls;
        for (const { url, partNumber } of signed) {
          const put = await requestUrl({ url, method: "PUT", body: data.slice((partNumber - 1) * PART_SIZE, partNumber * PART_SIZE), throw: false });
          const etag = put.headers["etag"] || put.headers["ETag"];
          if (put.status >= 300 || !etag) throw new Error(`Part ${partNumber} failed (${put.status})`);
          parts.push({ PartNumber: partNumber, ETag: etag });
        }
      }
      parts.sort((a, b) => a.PartNumber - b.PartNumber);
      try {
        await this.api("POST", "/s3/multipart/complete", { json: Object.assign({ parts }, session) });
      } catch (e) { throw new Error(`${e.message} [file size ${data.byteLength} bytes, ${parts.length} part(s)]`); }
      const entry = await this.api("POST", "/s3/entries", {
        json: {
          clientName: name, clientExtension: ext || "bin", clientMime: mime, filename: name,
          key: session.key, uploadId: session.uploadId, uploadToken: session.uploadToken,
          size: data.byteLength, parentId: parentId || null,
        },
      });
      return entry.json.fileEntry;
    } catch (e) {
      try { await this.api("POST", "/s3/multipart/abort", { json: session }); } catch (e2) { /* ignore */ }
      throw e;
    }
  }

  // ---------- Local ----------

  skipped(path) {
    if (path === ".obsidian" || path.startsWith(".obsidian/")) return true;
    return (this.settings.exclude + "\n" + this.settings.cloudIgnore).split("\n").map((s) => s.trim()).filter(Boolean).some((p) => path.startsWith(p));
  }

  async scanLocal() {
    const out = new Map();
    for (const f of this.app.vault.getFiles()) {
      if (this.skipped(f.path)) continue;
      const c = this.state.hashCache[f.path];
      let hash;
      if (c && c.mtime === f.stat.mtime && c.size === f.stat.size) hash = c.hash;
      else {
        hash = await sha256(await this.app.vault.readBinary(f));
        this.state.hashCache[f.path] = { mtime: f.stat.mtime, size: f.stat.size, hash };
      }
      out.set(f.path, { file: f, hash, mtime: f.stat.mtime });
    }
    for (const p of Object.keys(this.state.hashCache)) if (!out.has(p)) delete this.state.hashCache[p];
    return out;
  }

  // Folders (including empty ones) that exist locally, minus skipped ones.
  scanLocalFolders() {
    const out = new Set();
    for (const f of this.app.vault.getAllLoadedFiles()) {
      if (!(f instanceof TFolder) || !f.path || f.path === "/") continue;
      if (this.skipped(f.path) || this.skipped(f.path + "/")) continue;
      out.add(f.path);
    }
    return out;
  }

  // Creates missing empty folders on both sides. Never deletes anything.
  async syncFolders(dry) {
    const localDirs = this.scanLocalFolders();
    const remoteDirs = new Set([...(this.dirIds ? this.dirIds.keys() : [])].filter((p) => !this.skipped(p) && !this.skipped(p + "/")));
    const byDepth = (a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b);
    for (const p of [...localDirs].sort(byDepth)) {
      if (remoteDirs.has(p)) continue;
      if (dry) { this.run.plan.push(["CREATE CLOUD FOLDER", p]); continue; }
      try {
        await this.ensureDir(p + "/x"); // creates every missing folder along the path
        await this.logLine("FOLDER (cloud) " + p);
        this.run.folders++;
      } catch (e) {
        this.run.failed++; this.run.errors.push([p + "/", e.message]);
        await this.logLine(`ERROR folder ${p}: ${e.message}`);
      }
    }
    for (const p of [...remoteDirs].sort(byDepth)) {
      if (localDirs.has(p) || this.app.vault.getAbstractFileByPath(p)) continue;
      if (dry) { this.run.plan.push(["CREATE LOCAL FOLDER", p]); continue; }
      try {
        await this.ensureLocalFolder(p + "/x");
        await this.logLine("FOLDER (local) " + p);
        this.run.folders++;
      } catch (e) {
        this.run.failed++; this.run.errors.push([p + "/", e.message]);
        await this.logLine(`ERROR local folder ${p}: ${e.message}`);
      }
    }
  }

  async ensureLocalFolder(filePath) {
    let cur = "";
    for (const p of filePath.split("/").slice(0, -1)) {
      cur = cur ? cur + "/" + p : p;
      if (!this.app.vault.getAbstractFileByPath(cur)) {
        try { await this.app.vault.createFolder(cur); } catch (e) { /* exists */ }
      }
    }
  }

  async writeLocal(path, data, mtime) {
    const opts = mtime && !isNaN(mtime) ? { mtime } : undefined;
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) await this.app.vault.modifyBinary(existing, data, opts);
    else {
      await this.ensureLocalFolder(path);
      await this.app.vault.createBinary(normalizePath(path), data, opts);
    }
  }

  async mkdirs(dir) {
    const adapter = this.app.vault.adapter;
    let cur = "";
    for (const p of dir.split("/")) {
      cur = cur ? cur + "/" + p : p;
      if (!(await adapter.exists(cur))) await adapter.mkdir(cur);
    }
  }

  async backupLocal(path, file) {
    const day = new Date().toISOString().slice(0, 10);
    const dest = normalizePath(`${this.manifest.dir}/backups/${day}/${path}`);
    await this.mkdirs(dest.split("/").slice(0, -1).join("/"));
    await this.app.vault.adapter.writeBinary(dest, await this.app.vault.readBinary(file));
    this.run.backedUp++;
  }

  async pruneBackups() {
    try {
      const adapter = this.app.vault.adapter;
      const root = normalizePath(`${this.manifest.dir}/backups`);
      if (!(await adapter.exists(root))) return;
      const cutoff = Date.now() - BACKUP_DAYS * 86400000;
      for (const folder of (await adapter.list(root)).folders) {
        const day = Date.parse(folder.split("/").pop());
        if (!isNaN(day) && day < cutoff) await adapter.rmdir(folder, true);
      }
    } catch (e) { console.warn("UploadG Sync: backup prune failed", e); }
  }

  async logLine(text) {
    try {
      const file = normalizePath(`${this.manifest.dir}/sync-log.txt`);
      const line = `${new Date().toISOString()}  ${text}\n`;
      const a = this.app.vault.adapter;
      if (await a.exists(file)) await a.append(file, line); else await a.write(file, line);
    } catch (e) { /* logging must never break a sync */ }
  }

  // ---------- Sync ----------

  async syncAll(dry = false) {
    if (this.running) { new Notice("UploadG: sync already running."); return; }
    if (!this.settings.token) { new Notice("UploadG: set your API token in the plugin settings first."); return; }
    this.running = true;
    const notice = new Notice(dry ? "UploadG preview: reading..." : "UploadG: preparing...", 0);
    try {
      const max = (await this.api("GET", "/uploads/server-max-file-size")).json.maxSize;
      this.run = { maxSize: max, up: 0, down: 0, del: 0, same: 0, failed: 0, folders: 0, emptySkipped: 0, backedUp: 0, indexDirty: false, dry, plan: [], errors: [] };
      if (!dry) {
        await this.pruneBackups();
        await this.logLine("--- sync started ---");
        const rk = this.settings.remoteRootId || this.settings.remoteRoot;
        if (this.state.root !== rk) { this.state.synced = {}; this.state.root = rk; } // new target: compare content again
      }

      notice.setMessage("UploadG: finding cloud folders...");
      this.rootId = await this.resolveRoot(!dry);
      this.metaId = await this.ensureChain(this.metaSegments(), false); // created lazily when the index is first saved
      this.dirIds = new Map();

      let remote = new Map();
      if (this.rootId) {
        notice.setMessage("UploadG: reading cloud folder...");
        try {
          remote = await this.listRemote(this.rootId);
        } catch (e) {
          this.state.chainIds = {}; // cached folder IDs may be stale
          await this.saveAll();
          throw new Error("Could not read the cloud folder (" + e.message + "). Folder IDs were reset, try again.");
        }
        for (const p of [...remote.keys()]) if (this.skipped(p)) remote.delete(p);
      }

      // Plugin metadata (original modified times + hashes) lives in its own cloud folder.
      let indexEntry = null;
      let index = { version: 1, files: {} };
      if (this.metaId) {
        indexEntry = (await this.listEntries({ section: "folder", folderId: String(this.metaId) })).find((e) => e.type !== "folder" && e.name === "index.json") || null;
        if (indexEntry) {
          index = JSON.parse(new TextDecoder().decode(await this.download(indexEntry)));
          if (!index.files) index.files = {};
        }
      }

      const local = await this.scanLocal();

      if (remote.size === 0 && Object.keys(this.state.synced).length > 5) {
        throw new Error("Cloud folder looks empty but this vault synced before. Aborting to avoid duplicates; check the Remote folder setting.");
      }

      const paths = new Set([...local.keys(), ...remote.keys()]);
      const total = paths.size;
      let i = 0;
      for (const path of paths) {
        i++;
        notice.setMessage(`UploadG: ${i}/${total}  ${path.split("/").pop()}`);
        try {
          await this.handle(path, local.get(path), remote.get(path), index);
        } catch (e) {
          this.run.failed++;
          this.run.errors.push([path, e.message]);
          await this.logLine(`ERROR ${path}: ${e.message}`);
          console.error("UploadG Sync:", path, e);
        }
        if (i % 10 === 0) await this.saveAll();
      }

      notice.setMessage("UploadG: syncing folders...");
      await this.syncFolders(dry);

      if (dry) {
        notice.hide();
        new ReportModal(this.app, "UploadG sync preview (nothing was changed)", this.run.plan.map(([a, p]) => `${a}: ${p}`),
          this.run.errors.map(([p, m]) => `${p}: ${m}`), this.run.same).open();
        return;
      }

      for (const p of Object.keys(index.files)) {
        if (!(remote.has(p) || (this.state.synced[p] && local.has(p)))) { delete index.files[p]; this.run.indexDirty = true; }
      }
      if (this.run.indexDirty) {
        notice.setMessage("UploadG: saving index...");
        try {
          index.updated = Date.now();
          if (!this.metaId) this.metaId = await this.ensureChain(this.metaSegments(), true);
          const old = indexEntry;
          if (old) await this.removeRemote([old.id]);
          await this.uploadFile("index.json", toAB(new TextEncoder().encode(JSON.stringify(index))), this.metaId);
        } catch (e) {
          this.run.errors.push(["(index.json)", e.message]);
          this.run.failed++;
          await this.logLine(`ERROR index.json: ${e.message}`);
        }
      }
      await this.saveAll();

      const r = this.run;
      notice.hide();
      new Notice(
        `UploadG: ${r.up} uploaded, ${r.down} downloaded, ${r.same} unchanged` +
        (r.folders ? `, ${r.folders} folders created` : "") +
        (r.emptySkipped ? `, ${r.emptySkipped} empty file(s) skipped (add some text to sync them)` : "") +
        (r.del ? `, ${r.del} removed from cloud` : "") +
        (r.backedUp ? `, ${r.backedUp} local backups made` : "") +
        (r.failed ? `, ${r.failed} FAILED` : ""), 8000);
      if (r.errors.length) new ReportModal(this.app, `${r.errors.length} item(s) failed`, [], r.errors.map(([p, m]) => `${p}: ${m}`), 0).open();
    } catch (e) {
      console.error("UploadG Sync:", e);
      notice.hide();
      new Notice("UploadG error: " + e.message, 12000);
      await this.logLine(`FATAL ${e.message}`);
    } finally {
      this.running = false;
    }
  }

  async handle(path, L, R, index) {
    const synced = this.state.synced;
    const st = synced[path];

    if (L && !R) return this.doUpload(path, L, null, index);

    if (!L && R) {
      // Missing locally. Never deletes local files; the cloud copy is restored unless deletes are propagated.
      if (this.settings.propagateDeletes && st && st.entryId === R.id) {
        if (this.run.dry) { this.run.plan.push(["CLOUD DELETE", path]); return; }
        await this.logLine(`CLOUD DELETE ${path}`);
        await this.removeRemote([R.id]);
        delete index.files[path]; delete synced[path];
        this.run.indexDirty = true; this.run.del++;
        return;
      }
      return this.doDownload(path, R, index, null, null);
    }

    if (st && st.hash === L.hash && st.entryId === R.id) { this.run.same++; return; }
    const localChanged = !st || st.hash !== L.hash;
    const remoteChanged = !st || st.entryId !== R.id;
    if (st && localChanged && !remoteChanged) return this.doUpload(path, L, R, index);
    if (st && remoteChanged && !localChanged) return this.doDownload(path, R, index, L, null);

    // Both changed (or no history): compare content, then modified times.
    let ix = index.files[path];
    if (!ix || ix.entryId !== R.id) ix = null;
    let preData = null;
    let remoteHash = ix && ix.hash;
    if (!remoteHash) {
      preData = await this.download(R);
      remoteHash = await sha256(preData);
    }
    if (remoteHash === L.hash) {
      if (this.run.dry) { this.run.same++; return; }
      synced[path] = { hash: L.hash, entryId: R.id };
      if (!ix) { index.files[path] = { mtime: L.mtime, hash: L.hash, size: L.file.stat.size, entryId: R.id }; this.run.indexDirty = true; }
      this.run.same++;
      return;
    }
    const remoteMtime = ix ? ix.mtime : Date.parse(R.updated_at) || 0;
    if (remoteMtime > L.mtime) return this.doDownload(path, R, index, L, preData);
    return this.doUpload(path, L, R, index);
  }

  async doUpload(path, L, R, index) {
    if (this.run.dry) { this.run.plan.push([R ? "UPLOAD (replaces cloud copy)" : "UPLOAD (new)", path]); return; }
    await this.logLine(`UPLOAD ${R ? "(replace)" : "(new)"} ${path}`);
    const data = await this.app.vault.readBinary(L.file);
    const parentId = await this.ensureDir(path); // create cloud folders first so a failure leaves the old copy alone
    if (R) {
      delete this.state.synced[path];
      await this.saveAll();
      await this.removeRemote([R.id]);
    }
    let entry;
    try {
      entry = await this.uploadFile(path.split("/").pop(), data, parentId);
    } catch (e) {
      if (e.emptyFile) {
        if (R) { this.run.errors.push([path, "cloud copy was removed but the file is now empty; UploadG cannot store empty files"]); this.run.failed++; return; }
        this.run.emptySkipped++;
        await this.logLine(`SKIP (empty file, UploadG refuses 0-byte uploads) ${path}`);
        return;
      }
      throw e;
    }
    this.state.synced[path] = { hash: L.hash, entryId: entry.id };
    index.files[path] = { mtime: L.mtime, hash: L.hash, size: L.file.stat.size, entryId: entry.id };
    this.run.indexDirty = true;
    this.run.up++;
  }

  async doDownload(path, R, index, L, preData) {
    if (this.run.dry) { this.run.plan.push([L ? "DOWNLOAD (overwrites local, backup kept)" : "DOWNLOAD (new local file)", path]); return; }
    const data = preData || (await this.download(R));
    if (L && data.byteLength === 0 && L.file.stat.size > 0) {
      throw new Error(`Cloud copy of ${path} is empty but the local file is not; refusing to overwrite.`);
    }
    await this.logLine(`DOWNLOAD ${L ? "(overwrite, backup)" : "(new)"} ${path}`);
    const hash = await sha256(data);
    let ix = index.files[path];
    if (ix && ix.entryId !== R.id) ix = null;
    if (ix && ix.hash && ix.hash !== hash) throw new Error(`Downloaded content of ${path} does not match the cloud index; skipped.`);
    const mtime = ix ? ix.mtime : Date.parse(R.updated_at) || Date.now();
    if (L) await this.backupLocal(path, L.file);
    await this.writeLocal(path, data, mtime);
    this.state.synced[path] = { hash, entryId: R.id };
    if (!ix) { index.files[path] = { mtime, hash, size: data.byteLength, entryId: R.id }; this.run.indexDirty = true; }
    this.run.down++;
  }

  // ---------- Test ----------

  async test() {
    if (!this.settings.token) { new Notice("Set your API token first."); return; }
    const notice = new Notice("UploadG: testing...", 0);
    try {
      await this.api("GET", "/user/space-usage");
      const max = (await this.api("GET", "/uploads/server-max-file-size")).json.maxSize;
      this.run = { maxSize: max };
      const rootId = await this.resolveRoot(true);
      const metaId = await this.ensureChain(this.metaSegments(), true);
      let msg = `Cloud folders ready (notes folder ID ${rootId}, data folder ID ${metaId}). Simple-upload limit ${Math.round(max / 1048576)} MB.`;

      const payload = "ugsync-probe-" + Date.now();
      const entry = await this.uploadFile(`probe-${Date.now()}.txt`, toAB(new TextEncoder().encode(payload)), metaId);
      const candidates = [
        this.settings.downloadTemplate,
        "{api}/file-entries/download/{hash}", "{api}/file-entries/{id}/download", "{api}/file-entries/{hash}",
        "{api}/uploads/{hash}", "{api}/drive/file-entries/{id}/download", "{api}/drive/file-entries/{id}",
        "https://uploadg.com/download/{hash}", "https://uploadg.com/file-entries/download/{hash}",
      ];
      let found = null;
      for (const t of candidates) {
        try {
          const r = await requestUrl({ url: this.fillTemplate(t, entry.id, entry.hash), headers: this.authHeaders(), throw: false });
          if (r.status === 200 && new TextDecoder().decode(r.arrayBuffer) === payload) { found = t; break; }
        } catch (e) { /* next */ }
      }
      await this.removeRemote([entry.id]);
      if (found) { this.settings.downloadTemplate = found; msg += " Download works."; }
      else msg += " Upload works but NO download URL matched. Copy the real one from your browser's Network tab into the settings.";
      await this.saveAll();
      new Notice("UploadG: " + msg, 12000);
    } catch (e) {
      new Notice("UploadG test failed: " + e.message, 15000);
    } finally {
      notice.hide();
    }
  }
};

class ReportModal extends Modal {
  constructor(app, title, lines, errors, same) { super(app); this.title = title; this.lines = lines; this.errors = errors; this.same = same; }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: this.title });
    const box = (items) => {
      const b = contentEl.createEl("div");
      b.style.maxHeight = "30vh"; b.style.overflow = "auto"; b.style.fontFamily = "var(--font-monospace)"; b.style.fontSize = "12px";
      b.style.userSelect = "text"; b.style.marginBottom = "12px";
      for (const t of items) b.createEl("div", { text: t });
    };
    if (this.lines.length || !this.errors.length) {
      contentEl.createEl("p", { text: `${this.lines.length} change(s) planned, ${this.same} unchanged` });
      box(this.lines.length ? this.lines : ["Nothing to do."]);
    }
    if (this.errors.length) {
      contentEl.createEl("p", { text: "Errors (you can select and copy this text):" });
      box(this.errors);
    }
  }
  onClose() { this.contentEl.empty(); }
}

class SettingsTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();
    containerEl.createEl("h2", { text: "UploadG Sync" });
    containerEl.createEl("p", { text: "Two-way sync by modified time (newer wins, tie = local wins). Never deletes local files. .obsidian is always skipped." });

    const text = (name, desc, key, password) =>
      new Setting(containerEl).setName(name).setDesc(desc).addText((t) => {
        if (password) t.inputEl.type = "password";
        t.setValue(String(s[key])).onChange(async (v) => {
          s[key] = v.trim();
          if (["remoteRoot", "remoteRootId", "syncFolder"].includes(key)) this.plugin.state.chainIds = {};
          await this.plugin.saveAll();
        });
      });

    text("API token", "uploadg.com/account-settings > Developers.", "token", true);
    text("Remote folder", "Where your vault is mirrored, e.g. ObsidianSync/notes. Created automatically if missing.", "remoteRoot");
    text("Plugin data folder", "Holds index.json, next to the remote folder: e.g. ObsidianSync/_sync/notes/index.json", "syncFolder");
    text("Remote folder ID (optional)", "Only if you want to point at one specific existing folder.", "remoteRootId");
    text("Download URL template", "{api}, {id}, {hash}. The 'Test connection' command fills this.", "downloadTemplate");
    new Setting(containerEl).setName("Delete from cloud when I delete locally")
      .setDesc("Off by default. Only affects the cloud copy; local files are never deleted by this plugin.")
      .addToggle((t) => t.setValue(s.propagateDeletes).onChange(async (v) => { s.propagateDeletes = v; await this.plugin.saveAll(); }));
    new Setting(containerEl).setName("Ignored folders (old blobs/manifests/probe)")
      .setDesc("Skipped on both sides. One prefix per line.")
      .addTextArea((t) => t.setValue(s.cloudIgnore).onChange(async (v) => { s.cloudIgnore = v; await this.plugin.saveAll(); }));
    new Setting(containerEl).setName("Extra excluded paths").setDesc("One vault path prefix per line, e.g. Templates/")
      .addTextArea((t) => t.setValue(s.exclude).onChange(async (v) => { s.exclude = v; await this.plugin.saveAll(); }));
  }
}
