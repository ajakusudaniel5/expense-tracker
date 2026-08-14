#!/usr/bin/env node
// Fetch the latest MTN MoMo statement PDF from Gmail over IMAP and extract its text.
//
// Usage:
//   cp config/imap.example.json config/imap.json   # then fill in your credentials
//   node fetch-momo.js                             # fetch + extract
//   node fetch-momo.js --no-download               # just extract text from PDFs already in downloads/
//   node fetch-momo.js --test-mime file.eml        # test MIME/PDF extraction on a local .eml (no network)
//
// Gmail requires an "app password" (Google Account > Security > 2-Step Verification >
// App passwords). Do NOT use your normal Gmail login password here.
//
// Outputs:
//   downloads/<name>.pdf      the statement PDF
//   downloads/<name>.txt      pdftotext output (paste this into the app's MTN import box)

const fs = require('fs');
const path = require('path');
const tls = require('tls');
const { execFileSync } = require('child_process');

const CONFIG_PATH = path.join(__dirname, 'config', 'imap.json');
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error('No config found. Create it from the template first:\n  cp config/imap.example.json config/imap.json');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

// ---------------------------------------------------------------------------
// Minimal IMAP client over TLS (no external dependencies)
// ---------------------------------------------------------------------------
function imapConnect(cfg) {
  const socket = tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host });
  socket.setEncoding('binary');

  let buffer = '';
  let tag = 1;
  const pending = new Map(); // tag -> { resolve, literal: string|null, wantLiteral: bool }

  function processBuffer() {
    while (true) {
      // Complete a literal currently being read
      const lit = [...pending.values()].find((p) => p.wantLiteral);
      if (lit) {
        if (buffer.length < lit.wantLiteral) return;
        lit.literal += buffer.slice(0, lit.wantLiteral);
        buffer = buffer.slice(lit.wantLiteral);
        lit.wantLiteral = null;
        continue;
      }
      const idx = buffer.indexOf('\r\n');
      if (idx === -1) return;
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);

      // End-of-line literal marker, e.g. `BODY[] {12345}` -> `{12345}`
      const lm = /\{(\d+)\}$/.exec(line);
      if (lm) {
        const p = [...pending.values()].find((x) => x.expectLiteral);
        if (p) {
          p.wantLiteral = Number(lm[1]);
          p.literal = '';
          p.expectLiteral = false;
        }
        continue;
      }

      // Tagged response: `A1 OK ...`
      const tm = /^([A-Z0-9]+) (.*)$/.exec(line);
      if (tm && pending.has(tm[1])) {
        const p = pending.get(tm[1]);
        pending.delete(tm[1]);
        p.resolve({ result: tm[2], literal: p.literal || '' });
        continue;
      }

      // Untagged responses we care about:
      //   * SEARCH 1 2 3
      //   * 3 FETCH (BODY[] {N}   <- literal marker already handled above
      if (/^\* SEARCH /.test(line)) {
        const p = [...pending.values()].find((x) => x.onSearch);
        if (p) { p.onSearch(line.replace(/^\* SEARCH /, '').trim()); }
        continue;
      }
      if (/^\* \d+ FETCH/.test(line)) {
        const p = [...pending.values()].find((x) => x.onFetch);
        if (p) { p.onFetch(); }
        continue;
      }
    }
  }

  socket.on('data', (chunk) => {
    buffer += chunk;
    processBuffer();
  });
  socket.on('error', (err) => {
    console.error('IMAP connection error:', err.message);
    process.exit(1);
  });

  function command(cmd, opts = {}) {
    const t = `A${tag++}`;
    const p = {
      resolve: null,
      literal: null,
      wantLiteral: null,
      expectLiteral: !!opts.expectLiteral,
      onSearch: opts.onSearch || null,
      onFetch: opts.onFetch || null,
    };
    socket.write(`${t} ${cmd}\r\n`);
    return new Promise((resolve) => {
      p.resolve = resolve;
      pending.set(t, p);
    });
  }

  return { command, socket };
}

async function run() {
  const argv = process.argv.slice(2);

  if (argv.includes('--test-mime')) {
    const eml = argv[argv.indexOf('--test-mime') + 1];
    if (!eml) {
      console.error('Usage: node fetch-momo.js --test-mime file.eml');
      process.exit(1);
    }
    const text = fs.readFileSync(eml, 'utf8');
    return handleMime(text);
  }

  if (argv.includes('--no-download')) {
    return extractExisting(DOWNLOAD_DIR);
  }

  const cfg = loadConfig();
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

  console.log(`Connecting to ${cfg.host}:${cfg.port} as ${cfg.user} ...`);
  const imap = imapConnect(cfg);
  await new Promise((r) => imap.socket.once('secureConnect', r));

  let r = await imap.command(`LOGIN "${cfg.user}" "${cfg.password}"`);
  if (!/OK/i.test(r.result)) {
    console.error('Login failed:', r.result);
    process.exit(1);
  }
  console.log('Logged in.');

  await imap.command(`SELECT "${cfg.folder}"`);

  const fromSearch = cfg.searchFrom ? `FROM "${cfg.searchFrom}"` : '';
  const subjSearch = cfg.searchSubject ? `SUBJECT "${cfg.searchSubject}"` : '';
  let seqNums = [];
  r = await imap.command(`SEARCH ${fromSearch} ${subjSearch}`.trim(), {
    onSearch: (s) => { seqNums = s.split(/\s+/).filter(Boolean); },
  });
  if (!seqNums.length) {
    console.log('No matching MTN statement emails found.');
    return;
  }
  const recent = seqNums.slice(-Number(cfg.maxMessages || 20));
  console.log(`Found ${seqNums.length} matching email(s); checking the most recent ${recent.length}.`);

  for (const seq of recent) {
    const res = await fetchFullBody(imap, seq);
    if (!res) continue;
    const pdf = findPdf(res);
    if (pdf) {
      const name = sanitize(pdf.filename) || `momo_statement_${seq}.pdf`;
      const pdfPath = path.join(DOWNLOAD_DIR, name);
      fs.writeFileSync(pdfPath, Buffer.from(pdf.data, 'base64'));
      console.log(`Saved PDF: ${pdfPath}`);
      const txtPath = pdfPath.replace(/\.pdf$/i, '.txt');
      extractText(pdfPath, txtPath);
      console.log('Done. Paste the .txt contents into the app\'s MTN import box (or it can be pasted directly).');
      return;
    }
  }
  console.log('No PDF attachment found in the most recent matching emails.');
}

function fetchFullBody(imap, seq) {
  return new Promise(async (resolve) => {
    const res = await imap.command(`FETCH ${seq} (BODY.PEEK[])`, {
      expectLiteral: true,
      onFetch: () => {},
    });
    resolve(res.literal || '');
  });
}

// ---------------------------------------------------------------------------
// MIME / PDF attachment extraction
// ---------------------------------------------------------------------------
function handleMime(text) {
  const pdf = findPdf(text);
  if (!pdf) {
    console.log('No PDF attachment found in the message.');
    return;
  }
  const name = sanitize(pdf.filename) || 'momo_statement.pdf';
  const pdfPath = path.join(DOWNLOAD_DIR, name);
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  fs.writeFileSync(pdfPath, Buffer.from(pdf.data, 'base64'));
  console.log(`Saved PDF: ${pdfPath}`);
  extractText(pdfPath, pdfPath.replace(/\.pdf$/i, '.txt'));
}

function findPdf(mimeText) {
  const parts = splitMime(mimeText);
  for (const p of parts) {
    const ct = p.headers['content-type'] || '';
    const cd = p.headers['content-disposition'] || '';
    if (/application\/pdf/i.test(ct) || /filename=.*\.pdf/i.test(ct + ' ' + cd)) {
      const fn = extractFilename(ct + ' ' + cd);
      const b64 = (p.body || '').replace(/\s+/g, '');
      if (b64) return { filename: fn || 'momo_statement.pdf', data: b64 };
    }
  }
  return null;
}

function splitMime(text) {
  const boundaryMatch = /boundary="?([^";\s]+)"?/i.exec(text);
  if (!boundaryMatch) {
    return [{ headers: parseHeaders(text), body: text }];
  }
  const boundary = '--' + boundaryMatch[1];
  const chunks = text.split(boundary).filter((c) => c && !/^\s*--\s*$/.test(c.trim()));
  const parts = [];
  for (const c of chunks) {
    const sep = c.indexOf('\r\n\r\n');
    if (sep === -1) continue;
    const headerText = c.slice(0, sep);
    const body = c.slice(sep + 4).trim();
    if (!body) continue;
    if (/Content-Type:\s*multipart/i.test(headerText)) {
      // nested multipart: recurse into it
      const nested = splitMime(headerText + '\r\n\r\n' + body);
      parts.push(...nested);
      continue;
    }
    parts.push({ headers: parseHeaders(headerText), body });
  }
  return parts;
}

function parseHeaders(text) {
  const headers = {};
  let lastKey = null;
  for (const line of text.split('\r\n')) {
    if (/^\s/.test(line) && lastKey) {
      headers[lastKey] += ' ' + line.trim();
      continue;
    }
    const m = /^([^:]+):\s*(.*)$/.exec(line);
    if (m) {
      lastKey = m[1].toLowerCase();
      headers[lastKey] = (headers[lastKey] || '') + m[2];
    }
  }
  return headers;
}

function extractFilename(header) {
  // RFC 2231 encoded, quoted, or bare filename
  const m = /filename\*?="?([^";]*)"?/i.exec(header);
  if (!m) return null;
  const raw = m[1];
  if (raw.includes("'")) {
    const seg = raw.split("'");
    if (seg.length >= 3) {
      try { return decodeURIComponent(seg[seg.length - 1]); } catch (_) { return seg[seg.length - 1]; }
    }
  }
  return raw;
}

function sanitize(name) {
  return String(name).replace(/[^\w.\-]+/g, '_');
}

function extractText(pdfPath, txtPath) {
  try {
    execFileSync('pdftotext', ['-layout', pdfPath, txtPath]);
    console.log(`Extracted text: ${txtPath}`);
  } catch (e) {
    console.error('pdftotext failed:', e.message);
  }
}

function extractExisting(dir) {
  const files = fs.readdirSync(dir).filter((f) => /\.pdf$/i.test(f));
  if (!files.length) {
    console.log('No PDFs in', dir);
    return;
  }
  for (const f of files) {
    extractText(path.join(dir, f), path.join(dir, f.replace(/\.pdf$/i, '.txt')));
  }
}

run().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});