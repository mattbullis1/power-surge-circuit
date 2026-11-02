/**
 * Minimal Chrome DevTools Protocol client.
 *
 * Used by tools/qa.mjs to drive a real browser without pulling in a
 * node_modules dependency. Talks to Chrome over its WebSocket debugging
 * endpoint using only Node built-ins.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

export function findBrowser() {
  const override = process.env.CHROME_PATH;
  if (override && fs.existsSync(override)) return override;
  for (const candidate of CHROME_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Fetches a DevTools HTTP endpoint as JSON.
 *
 * Chrome prints advisory lines such as "Using unsafe... " onto the same
 * endpoint when certain flags are used, so the payload is isolated by scanning
 * for the first JSON delimiter rather than trusting the whole body.
 */
function httpJson(url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        const trimmed = body.trim();
        const candidates = [trimmed];
        const objectStart = trimmed.indexOf('{');
        const arrayStart = trimmed.indexOf('[');
        const first = Math.min(
          objectStart < 0 ? Number.POSITIVE_INFINITY : objectStart,
          arrayStart < 0 ? Number.POSITIVE_INFINITY : arrayStart,
        );
        if (Number.isFinite(first) && first > 0) candidates.push(trimmed.slice(first));
        for (const candidate of candidates) {
          try {
            resolve(JSON.parse(candidate));
            return;
          } catch {
            // try the next candidate
          }
        }
        reject(new Error(`DevTools endpoint returned non-JSON: ${trimmed.slice(0, 120)}`));
      });
    });
    request.on('error', reject);
    request.setTimeout(5000, () => {
      request.destroy(new Error('Timed out waiting for the browser'));
    });
    request.end();
  });
}

async function waitForDevTools(port, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      return await httpJson(`http://127.0.0.1:${port}/json/version`);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 220));
    }
  }
  throw new Error(`Chrome DevTools endpoint never became ready: ${lastError?.message}`);
}

/** Small CDP session over a single page target. */
export class CdpSession {
  constructor(webSocketUrl) {
    this.webSocketUrl = webSocketUrl;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
  }

  static async connect(webSocketUrl) {
    const session = new CdpSession(webSocketUrl);
    await session._open();
    return session;
  }

  _open() {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.webSocketUrl);
      this.socket = socket;
      socket.addEventListener('open', () => resolve());
      socket.addEventListener('error', (event) => reject(new Error(`WebSocket error: ${event.message || 'unknown'}`)));
      socket.addEventListener('message', (event) => this._handleMessage(event.data));
      socket.addEventListener('close', () => {
        this.closed = true;
        for (const { reject: rejectPending } of this.pending.values()) {
          rejectPending(new Error('DevTools connection closed'));
        }
        this.pending.clear();
      });
    });
  }

  _handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    } catch {
      return;
    }
    if (message.id != null && this.pending.has(message.id)) {
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
      return;
    }
    if (message.method) {
      const handlers = this.listeners.get(message.method);
      if (handlers) for (const handler of handlers) handler(message.params);
    }
  }

  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error('DevTools connection closed'));
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(payload);
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`DevTools call timed out: ${method}`));
        }
      }, 30000);
    });
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(handler);
    return () => this.listeners.get(method)?.delete(handler);
  }

  /** Evaluates an expression in the page and returns its JSON value. */
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        `Page exception: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`,
      );
    }
    return result.result?.value;
  }

  close() {
    try {
      this.socket?.close();
    } catch {
      // ignore
    }
  }
}

export class BrowserHarness {
  constructor(options = {}) {
    this.browserPath = options.browserPath || findBrowser();
    this.port = options.port || 9333 + Math.floor(Math.random() * 400);
    this.process = null;
    this.profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'psc-chrome-'));
    this.targets = new Map();
  }

  async launch() {
    if (!this.browserPath) throw new Error('No Chrome or Edge binary found. Set CHROME_PATH.');
    const args = [
      '--headless=new',
      '--remote-debugging-port=' + this.port,
      '--user-data-dir=' + this.profileDir,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-translate',
      '--mute-audio',
      '--autoplay-policy=no-user-gesture-required',
      '--use-gl=swiftshader',
      '--enable-unsafe-swiftshader',
      '--hide-scrollbars',
      '--window-size=412,915',
      'about:blank',
    ];
    this.process = spawn(this.browserPath, args, { stdio: 'ignore', windowsHide: true });
    await waitForDevTools(this.port);
    return this;
  }

  async newPage(url) {
    // Chrome requires PUT for /json/new to prevent drive-by tab creation.
    let created;
    try {
      created = await httpJson(`http://127.0.0.1:${this.port}/json/new?${encodeURIComponent(url)}`, 'PUT');
    } catch {
      created = await httpJson(`http://127.0.0.1:${this.port}/json/new?${encodeURIComponent(url)}`);
    }
    const session = await CdpSession.connect(created.webSocketDebuggerUrl);
    await session.send('Runtime.enable');
    await session.send('Page.enable');
    await session.send('Log.enable');
    await session.send('Console.enable');
    this.targets.set(created.id, session);
    return { id: created.id, session };
  }

  async closePage(id) {
    const session = this.targets.get(id);
    if (session) {
      session.close();
      this.targets.delete(id);
    }
    try {
      await httpJson(`http://127.0.0.1:${this.port}/json/close/${id}`);
    } catch {
      // The page may already be gone.
    }
  }

  async close() {
    for (const session of this.targets.values()) session.close();
    this.targets.clear();
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    try {
      fs.rmSync(this.profileDir, { recursive: true, force: true });
    } catch {
      // Windows may still hold a handle; the temp dir will be cleaned later.
    }
  }
}

export { waitForDevTools, httpJson };
