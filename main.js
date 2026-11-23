"use strict";
const { Plugin, PluginSettingTab, Setting, Notice, Modal, TFile, TFolder, requestUrl, normalizePath } = require("obsidian");

const BACKUP_DAYS = 14;
const PART_SIZE = 8 * 1024 * 1024;

const DEFAULTS = {
  token: "",
  apiBase: "https://uploadg.com/api/v1",
  remoteRoot: "",
  remoteRootId: "",
  syncFolder: "_sync",
  downloadTemplate: "{api}/file-entries/download/{hash}",
  exclude: "",
  cloudIgnore: "blobs/\nmanifests/\nprobe/",
  trackDeletes: true,
  bakFolder: "bak",
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
    this.state = saved.state && saved.state.v === 5 ? saved.state : { v: 5, synced: {}, hashCache: {}, chainIds: {}, root: "" };

    if (!this.state.folders) this.state.folders = {};

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
        } catch (e) {}
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

  bakSegments() {
    const segs = this.rootSegments();
    return segs.slice(0, -1).concat([this.settings.bakFolder || "bak", segs[segs.length - 1]]);
  }
  async removeRemote(ids) {
    await this.api("POST", "/file-entries/delete", { json: { entryIds: ids, deleteForever: false } });
    for (let n = 0; n < 10; n++) {
      const r = await this.api("POST", "/file-entries/delete", { json: { entryIds: ids, deleteForever: true } });
      if (!(r.json && r.json.deletion && r.json.deletion.hasMore)) break;
    }
  }

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
    const c = (await this.api("POST