/**
 * generator.js
 * Reads a Snapchat message_logger.db in-browser via sql.js (WebAssembly SQLite),
 * decodes all conversations and messages (including replies), then generates a
 * self-contained snapchat_viewer.html for download.
 *
 * Single view style: Web
 */

// ─── Drag & drop ─────────────────────────────────────────────────────────────

const dropzone = document.getElementById('dropzone');

dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('drag-over'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
dropzone.addEventListener('drop', e => {
  e.preventDefault();
  dropzone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});

// ─── UI helpers ───────────────────────────────────────────────────────────────

function setProgress(pct, label) {
  document.getElementById('progressFill').style.width = pct + '%';
  document.getElementById('progressPct').textContent = pct + '%';
  if (label) document.getElementById('progressLabel').textContent = label;
}

function log(msg, type = '') {
  const area = document.getElementById('logArea');
  const now = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const line = document.createElement('div');
  line.className = 'log-line' + (type ? ' ' + type : '');
  line.innerHTML = `<span class="ts">${now}</span><span class="msg">${msg}</span>`;
  area.appendChild(line);
  area.scrollTop = area.scrollHeight;
}

// Surface anything that would otherwise fail silently (blocked CDN request,
// unexpected DB shape, etc.) so "nothing happens" always shows a reason.
window.addEventListener('error', (e) => {
  showProgress();
  log('Unexpected error: ' + (e.error?.message || e.message || 'unknown error'), 'err');
});
window.addEventListener('unhandledrejection', (e) => {
  showProgress();
  log('Unexpected error: ' + (e.reason?.message || e.reason || 'unknown error'), 'err');
});

function showProgress() {
  document.getElementById('progressCard').classList.add('visible');
  document.getElementById('dropzone').style.display = 'none';
}

function showResult(stats, htmlBlob, filename) {
  document.getElementById('progressCard').classList.remove('visible');
  document.getElementById('resultCard').classList.add('visible');
  document.getElementById('resultSub').textContent = filename;
  document.getElementById('statsGrid').innerHTML = [
    [stats.convos,                    'conversations'],
    [stats.messages.toLocaleString(), 'messages'],
    [stats.people,                    'people'],
    [stats.groups,                    'group chats'],
    [stats.textMsgs.toLocaleString(), 'text msgs'],
    [stats.replies.toLocaleString(),  'replies'],
    [stats.owner || '—',              'owner'],
  ].map(([v, l]) => `<div class="stat-cell"><div class="stat-cell-val">${v}</div><div class="stat-cell-label">${l}</div></div>`).join('');

  const url = URL.createObjectURL(htmlBlob);
  document.getElementById('downloadBtn').onclick = () => {
    const a = document.createElement('a');
    a.href = url;
    a.download = 'snapchat_viewer.html';
    a.click();
  };
}

function reset() {
  document.getElementById('resultCard').classList.remove('visible');
  document.getElementById('progressCard').classList.remove('visible');
  document.getElementById('dropzone').style.display = '';
  document.getElementById('logArea').innerHTML = '';
  document.getElementById('progressFill').style.width = '0%';
  document.getElementById('progressPct').textContent = '0%';
  document.getElementById('fileInput').value = '';
}

// ─── Protobuf varint decoder ──────────────────────────────────────────────────

function readVarint(bytes, pos) {
  // Use multiplication instead of `|=`/`<<` beyond bit 28: JS bitwise ops are
  // 32-bit signed, so shifting further silently wraps/corrupts large values
  // (e.g. big mMessageId fields), which broke reply resolution on some rows.
  let result = 0, shift = 0;
  while (pos < bytes.length) {
    const b = bytes[pos++];
    if (shift < 28) {
      result |= (b & 0x7F) << shift;
    } else {
      result += (b & 0x7F) * Math.pow(2, shift);
    }
    if (!(b & 0x80)) break;
    shift += 7;
  }
  return [result, pos];
}

/**
 * Decode Snapchat's protobuf-encoded mContent → UTF-8 text.
 * Structure: field2 (length-delimited) → field1 (string) → text
 */
function extractText(mContentArray) {
  if (!mContentArray || !mContentArray.length) return '';
  const bs = new Uint8Array(mContentArray.map(b => b & 0xFF));
  let i = 0;
  while (i < bs.length) {
    const tagByte = bs[i++];
    const fieldNum = tagByte >> 3;
    const wireType = tagByte & 0x7;
    if (wireType === 2) {
      let length, chunk;
      [length, i] = readVarint(bs, i);
      chunk = bs.slice(i, i + length);
      i += length;
      if (fieldNum === 2) {
        let j = 0;
        while (j < chunk.length) {
          const innerTag = chunk[j++];
          const innerField = innerTag >> 3;
          const innerWire = innerTag & 0x7;
          if (innerWire === 2) {
            let innerLen, innerChunk;
            [innerLen, j] = readVarint(chunk, j);
            innerChunk = chunk.slice(j, j + innerLen);
            j += innerLen;
            if (innerField === 1) {
              try { return new TextDecoder('utf-8').decode(innerChunk); } catch (_) { return ''; }
            }
          } else if (innerWire === 0) { let _v; [_v, j] = readVarint(chunk, j); }
          else if (innerWire === 5) { j += 4; }
          else if (innerWire === 1) { j += 8; }
          else break;
        }
      }
    } else if (wireType === 0) { let _v; [_v, i] = readVarint(bs, i); }
    else if (wireType === 5) { i += 4; }
    else if (wireType === 1) { i += 8; }
    else break;
  }
  return '';
}

/** Convert Snapchat's signed-byte UUID array to a standard UUID string.
 *  Returns null for malformed/truncated input rather than a garbage UUID. */
function bytesToUUID(mIdArray) {
  if (!mIdArray || mIdArray.length !== 16) return null;
  const bs = new Uint8Array(mIdArray.map(b => b & 0xFF));
  const h = Array.from(bs).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;
}

// ─── Main processing pipeline ─────────────────────────────────────────────────

async function handleFile(file) {
  if (!file) return;
  showProgress();
  log(`Loaded: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`);
  setProgress(5, 'Loading sql.js…');

  let SQL;
  try {
    SQL = await initSqlJs({ locateFile: f => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/${f}` });
    log('sql.js (WebAssembly SQLite) ready', 'ok');
  } catch (e) {
    log('Failed to load sql.js: ' + e.message, 'err');
    return;
  }

  setProgress(15, 'Reading database…');

  let db;
  try {
    const buffer = await file.arrayBuffer();
    db = new SQL.Database(new Uint8Array(buffer));
    log('Database opened', 'ok');
  } catch (e) {
    log('Failed to open database: ' + e.message, 'err');
    return;
  }

  setProgress(20, 'Checking schema…');

  let tables;
  try {
    tables = db.exec("SELECT name FROM sqlite_master WHERE type='table'")[0].values.flat();
    log(`Tables: ${tables.join(', ')}`);
  } catch (e) {
    log('Could not read tables — is this a message_logger.db?', 'err');
    return;
  }

  if (!tables.includes('messages')) {
    log('No "messages" table found. Wrong database?', 'err');
    return;
  }

  setProgress(25, 'Reading conversations…');

  const totalCount = db.exec('SELECT COUNT(*) FROM messages')[0].values[0][0];
  log(`Found ${totalCount.toLocaleString()} messages`);

  const convoResult = db.exec(`
    SELECT conversation_id, MAX(group_title) AS gt, COUNT(*) AS n,
           MIN(send_timestamp) AS f, MAX(send_timestamp) AS l,
           GROUP_CONCAT(DISTINCT username) AS p
    FROM messages GROUP BY conversation_id ORDER BY n DESC
  `);

  const convoMeta = {};
  if (convoResult.length) {
    for (const row of convoResult[0].values) {
      const [cid, gt, n, f, l, p] = row;
      convoMeta[cid] = { gt, n, f, l, p };
    }
  }

  const numConvos = Object.keys(convoMeta).length;
  log(`Found ${numConvos} conversations`);

  setProgress(30, 'Extracting messages…');

  const msgResult = db.exec(
    'SELECT conversation_id, username, send_timestamp, message_data FROM messages ORDER BY send_timestamp ASC'
  );

  const rawRows = msgResult.length ? msgResult[0].values : [];
  const total = rawRows.length;

  // ── Pass 0: parse each row's message_data JSON exactly once and reuse it in
  // both later passes (previously parsed twice per row, which doubled the
  // JSON.parse cost across the whole log). Failures are counted, not silent.
  const parsedRows = new Array(total);
  let parseErrors = 0;
  for (let idx = 0; idx < total; idx++) {
    const rawData = rawRows[idx][3];
    try {
      parsedRows[idx] = JSON.parse(typeof rawData === 'string' ? rawData : new TextDecoder().decode(rawData));
    } catch (e) {
      parsedRows[idx] = null;
      parseErrors++;
    }
  }
  log(
    `Parsed ${(total - parseErrors).toLocaleString()} / ${total.toLocaleString()} rows` +
    (parseErrors ? `, ${parseErrors.toLocaleString()} failed to parse` : ''),
    parseErrors ? 'err' : 'ok'
  );
  setProgress(38, 'Building reply index…');
  await new Promise(r => setTimeout(r, 0));

  // ── Pass 1: build lookup index (conv_id, seq_id) → {u, x, k} for reply resolution
  const lookup = new Map();

  for (let idx = 0; idx < total; idx++) {
    const parsed = parsedRows[idx];
    if (!parsed) continue;
    const [cid, username] = rawRows[idx];
    try {
      const seqId = parsed.mDescriptor?.mMessageId;
      if (seqId == null) continue;
      const content = parsed.mMessageContent || {};
      const ctype = content.mContentType || 'UNKNOWN';
      const text = ctype === 'CHAT' ? extractText(content.mContent) : '';
      lookup.set(`${cid}:${seqId}`, { u: username, x: text, k: ctype });
    } catch (_) {}
  }

  log(`Lookup index: ${lookup.size.toLocaleString()} entries`);
  setProgress(45, 'Processing messages…');
  await new Promise(r => setTimeout(r, 0));

  // ── Pass 2: build message objects with reply info
  const msgByConvo = {};
  let processed = 0, textExtracted = 0, replyCount = 0;

  for (let idx = 0; idx < total; idx++) {
    const row = rawRows[idx];
    const [cid, username, ts] = row;
    const parsed = parsedRows[idx];
    let ctype = 'UNKNOWN', text = '', replyInfo = null;

    try {
      if (!parsed) throw new Error('unparsed row');
      const content = parsed.mMessageContent || {};
      ctype = content.mContentType || 'UNKNOWN';

      if (ctype === 'CHAT') {
        text = extractText(content.mContent);
        if (text) textExtracted++;
      }

      // Resolve reply / quoted message
      const quoted = content.mQuotedMessage;
      if (quoted) {
        const qc = quoted.mContent || {};
        const qType = qc.mContentType || 'UNKNOWN';
        const qText = qType === 'CHAT' ? extractText(qc.mContent) : '';
        let qSender = null;

        const qConvIdBytes = qc.mConversationId?.mId;
        const qMsgId = qc.mMessageId;
        if (qConvIdBytes && qMsgId != null) {
          try {
            const qConvUUID = bytesToUUID(qConvIdBytes);
            const orig = lookup.get(`${qConvUUID}:${qMsgId}`);
            if (orig) {
              qSender = orig.u;
              if (!qText && orig.k === 'CHAT') text = orig.x; // fallback
            }
          } catch (_) {}
        }

        if (qType !== 'UNKNOWN' || qText || qSender) {
          replyInfo = { k: qType, x: qText || '', u: qSender };
          replyCount++;
        }
      }
    } catch (_) {}

    if (!msgByConvo[cid]) msgByConvo[cid] = [];
    const msgObj = { u: username, t: ts, k: ctype, x: text };
    if (replyInfo) msgObj.r = replyInfo;
    msgByConvo[cid].push(msgObj);

    processed++;
    if (processed % 5000 === 0) {
      const pct = 45 + Math.floor((processed / total) * 40);
      setProgress(pct, `Processing… ${processed.toLocaleString()} / ${total.toLocaleString()}`);
      await new Promise(r => setTimeout(r, 0));
    }
  }

  log(`Text extracted: ${textExtracted.toLocaleString()}`, 'ok');
  log(`Replies resolved: ${replyCount.toLocaleString()}`, 'ok');
  setProgress(86, 'Assembling conversations…');
  await new Promise(r => setTimeout(r, 0));

  // Detect owner (most messages sent)
  const ownerCounts = {};
  for (const msgs of Object.values(msgByConvo))
    for (const m of msgs) ownerCounts[m.u] = (ownerCounts[m.u] || 0) + 1;
  const owner = Object.entries(ownerCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  log(`Owner: ${owner}`, 'ok');

  const slimConvos = [];
  for (const [cid, meta] of Object.entries(convoMeta)) {
    const { gt, n, f, l, p } = meta;
    const isGroup = gt !== cid;
    const displayName = isGroup ? gt : (p ? p.split(',')[0] : cid.slice(0, 8));
    slimConvos.push({
      id: cid, name: displayName, g: isGroup, n, f, l,
      p: p ? [...new Set(p.split(','))] : [],
      m: msgByConvo[cid] || []
    });
  }

  const stats = {
    convos: numConvos, messages: processed, people: Object.keys(ownerCounts).length,
    groups: slimConvos.filter(c => c.g).length, textMsgs: textExtracted,
    replies: replyCount, owner
  };

  setProgress(92, 'Generating HTML viewer…');
  await new Promise(r => setTimeout(r, 0));

  const html = buildViewerHTML(owner, slimConvos, stats);
  log(`HTML: ${(html.length / 1024 / 1024).toFixed(2)} MB`, 'ok');
  setProgress(100, 'Done!');
  await new Promise(r => setTimeout(r, 300));

  db.close(); // free the WASM-backed SQLite memory now that we're done reading it
  showResult(stats, new Blob([html], { type: 'text/html;charset=utf-8' }), file.name);
}

// ─── Viewer HTML builder ──────────────────────────────────────────────────────

function buildViewerHTML(owner, convos, stats) {
  const convosJson = JSON.stringify(convos, null, 0);

  const dateRange = (() => {
    let mn = Infinity, mx = -Infinity;
    for (const c of convos) { if (c.f < mn) mn = c.f; if (c.l > mx) mx = c.l; }
    const fmt = ts => new Date(ts).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
    return mn === Infinity ? '—' : `${fmt(mn)} – ${fmt(mx)}`;
  })();

  const CSS = `
:root{--bg:#0f0f0f;--surface:#1a1a1a;--surface2:#222;--border:#2a2a2a;--border2:#333;--y:#FFFC00;--yd:rgba(255,252,0,0.12);--yg:rgba(255,252,0,0.05);--text:#dedede;--t2:#aaa;--t3:#666;--snap:#aaa8ff;--stick:#ff9f78;--media:#78d9ff;}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'DM Sans',sans-serif;background:var(--bg);color:var(--text);height:100vh;overflow:hidden;display:flex;flex-direction:column;transition:background .2s}
.topbar{display:flex;align-items:center;gap:12px;padding:0 16px;height:52px;background:var(--surface);border-bottom:1px solid var(--border);flex-shrink:0}
.logo{display:flex;align-items:center;gap:7px;font-family:'DM Mono',monospace;font-size:12px;font-weight:500;letter-spacing:.05em;flex-shrink:0}
.ghost{width:24px;height:24px;background:var(--y);border-radius:50% 50% 50% 50%/60% 60% 40% 40%;position:relative;flex-shrink:0}
.ghost::after{content:'';position:absolute;bottom:-3px;left:50%;transform:translateX(-50%);width:9px;height:5px;background:var(--y);clip-path:polygon(0 0,50% 100%,100% 0)}
.badge{font-family:'DM Mono',monospace;font-size:10px;color:var(--y);background:var(--yd);border:1px solid rgba(255,252,0,.2);padding:2px 7px;border-radius:20px;letter-spacing:.04em;flex-shrink:0}
.sw{position:relative;width:160px}
.sw input{width:100%;background:var(--surface2);border:1px solid var(--border);border-radius:7px;color:var(--text);font-family:'DM Sans',sans-serif;font-size:11px;padding:5px 9px 5px 24px;outline:none;transition:border-color .15s}
.sw input::placeholder{color:var(--t3)}.sw input:focus{border-color:var(--border2)}
.si{position:absolute;left:7px;top:50%;transform:translateY(-50%);color:var(--t3);font-size:11px;pointer-events:none}
.search-results{display:none;position:absolute;top:100%;right:0;margin-top:6px;width:360px;max-width:80vw;max-height:360px;overflow-y:auto;background:var(--surface2);border:1px solid var(--border2);border-radius:10px;box-shadow:0 12px 32px rgba(0,0,0,.5);z-index:30}
.search-results.open{display:block}
.sr-item{display:flex;align-items:center;gap:8px;padding:9px 11px;border-bottom:1px solid var(--border);cursor:pointer}
.sr-item:last-child{border-bottom:none}
.sr-item:hover{background:var(--yg)}
.sr-meta{flex:1;min-width:0}
.sr-sender{font-size:11px;font-weight:700;color:var(--text)}
.sr-date{font-family:'DM Mono',monospace;font-size:9px;color:var(--t3);margin-left:7px}
.sr-snippet{font-size:11px;color:var(--t2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
.sr-snippet mark{background:var(--yd);color:var(--y);padding:0 1px;border-radius:2px}
.sr-jump{flex-shrink:0;background:var(--y);color:#111;border:none;border-radius:6px;padding:6px 10px;font-family:'DM Mono',monospace;font-size:9px;font-weight:700;cursor:pointer;white-space:nowrap;letter-spacing:.02em}
.sr-jump:hover{opacity:.85}
.tbstats{margin-left:auto;display:flex;gap:16px;font-family:'DM Mono',monospace;font-size:10px;color:var(--t3);flex-shrink:0}
.sv{color:var(--t2)}
.main{display:flex;flex:1;overflow:hidden}
.sidebar{width:272px;flex-shrink:0;background:var(--surface);border-right:1px solid var(--border);display:flex;flex-direction:column;overflow:hidden}
.sh{padding:8px 12px 7px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;flex-shrink:0}
.stitle{font-family:'DM Mono',monospace;font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:var(--t3)}
.fbtns{display:flex;gap:3px}
.fb{font-size:10px;font-family:'DM Mono',monospace;padding:2px 6px;border-radius:4px;border:1px solid var(--border);background:transparent;color:var(--t3);cursor:pointer;transition:all .1s}
.fb.active,.fb:hover{background:var(--yd);color:var(--y);border-color:rgba(255,252,0,.25)}
.clist{flex:1;overflow-y:auto;scrollbar-width:thin;scrollbar-color:var(--border2) transparent}
.ci{display:flex;align-items:center;gap:9px;padding:8px 12px;cursor:pointer;border-bottom:1px solid var(--border);transition:background .1s}
.ci:hover{background:var(--yg)}.ci.active{background:var(--yd);border-left:2px solid var(--y)}
.ca{width:32px;height:32px;border-radius:50%;background:var(--surface2);border:1px solid var(--border2);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;flex-shrink:0;color:var(--t2);font-family:'DM Mono',monospace}
.ci.active .ca{background:var(--y);color:#000;border-color:transparent}.ci.gc .ca{border-radius:7px}
.cm{flex:1;min-width:0}.cn{font-size:12px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cs{font-family:'DM Mono',monospace;font-size:9px;color:var(--t3);margin-top:1px}
.cbadge{font-family:'DM Mono',monospace;font-size:9px;padding:1px 5px;border-radius:10px;background:var(--surface2);color:var(--t3);flex-shrink:0}
.cpanel{flex:1;display:flex;flex-direction:column;overflow:hidden}
.ch{padding:0 16px;height:48px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px;flex-shrink:0;background:var(--surface)}
.cname{font-size:14px;font-weight:600}
.csub{font-family:'DM Mono',monospace;font-size:10px;color:var(--t3);margin-left:auto;display:flex;gap:14px}
.msgs{flex:1;overflow-y:auto;padding:12px 16px;scrollbar-width:thin;scrollbar-color:var(--border2) transparent;display:flex;flex-direction:column;gap:1px}
.dsep{display:flex;align-items:center;gap:10px;margin:12px 0 7px;font-family:'DM Mono',monospace;font-size:10px;color:var(--t3);letter-spacing:.05em}
.dsep::before,.dsep::after{content:'';flex:1;height:1px;background:var(--border)}
.empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px}
.eg{width:50px;height:50px;background:var(--surface2);border-radius:50% 50% 50% 50%/60% 60% 40% 40%;opacity:.3;position:relative}
.eg::after{content:'';position:absolute;bottom:-5px;left:50%;transform:translateX(-50%);width:20px;height:10px;background:var(--surface2);clip-path:polygon(0 0,50% 100%,100% 0)}
.el{font-family:'DM Mono',monospace;font-size:11px;color:var(--t3)}
.sp{width:210px;flex-shrink:0;background:var(--surface);border-left:1px solid var(--border);overflow-y:auto;scrollbar-width:thin;scrollbar-color:var(--border2) transparent}
.ss{padding:10px 12px;border-bottom:1px solid var(--border)}
.sstitle{font-family:'DM Mono',monospace;font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:var(--t3);margin-bottom:8px}
.sr{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:5px;font-size:11px}
.sl{color:var(--t2)}.sn{font-family:'DM Mono',monospace;font-size:11px;color:var(--y)}
.pr{display:flex;align-items:center;gap:6px;margin-bottom:5px}
.pd{width:5px;height:5px;border-radius:50%;background:var(--y);flex-shrink:0}
.pn{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--t2);font-family:'DM Mono',monospace;font-size:9px}
.pc{font-family:'DM Mono',monospace;font-size:9px;color:var(--t3)}
.mbr{display:flex;flex-direction:column;gap:4px;margin-top:3px}
.mbi{display:flex;align-items:center;gap:5px;font-family:'DM Mono',monospace;font-size:9px;color:var(--t3)}
.mbl{width:34px;text-align:right}.mbt{flex:1;height:3px;background:var(--border);border-radius:2px;overflow:hidden}
.mbf{height:100%;background:var(--y);border-radius:2px;transition:width .5s ease}
::-webkit-scrollbar{width:3px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:var(--border2);border-radius:2px}

/* ── MESSAGE ROWS (Web style — the only view style) ── */
.mr{display:flex;flex-direction:column;align-items:flex-start;gap:2px;padding:3px 0}
.mav{display:none}
.mc{display:flex;flex-direction:column;gap:1px;max-width:82%;align-items:flex-start}
.msender{font-size:11px;font-weight:700;font-family:'DM Sans',sans-serif;padding:0;margin-bottom:3px;color:var(--send-col,#aaa);letter-spacing:.01em}
.bub{border-radius:0;border:none;border-left:3px solid var(--send-col,#555);padding:7px 11px;background:rgba(255,255,255,0.04);color:var(--text);font-size:13px;font-weight:400;line-height:1.45;word-break:break-word;transition:background .3s,box-shadow .3s}
.mr.hl .bub{background:var(--yd);box-shadow:0 0 0 1px var(--y) inset}
.bub.snap,.bub.stick,.bub.med{background:rgba(255,255,255,0.04);border-left:3px solid var(--send-col,#555);color:var(--t2);font-family:'DM Mono',monospace;font-size:11px;font-style:normal;border-top:none;border-right:none;border-bottom:none}
.bub.stat{background:transparent;color:var(--t3);font-family:'DM Mono',monospace;font-size:10px;font-style:italic;padding:3px 0;border:none}
.mtime{padding:0;font-size:9px;color:var(--t3);margin-top:2px}

/* ── REPLY PREVIEW ── */
.reply-preview{display:flex;flex-direction:column;gap:1px;background:rgba(255,255,255,0.03);border-left:3px solid var(--rp-col,var(--t3));border-radius:0;padding:4px 9px;margin-bottom:5px;font-size:11px;max-width:100%}
.reply-sender{font-family:'DM Mono',monospace;font-size:9px;font-weight:600;color:var(--rp-col,var(--t2));letter-spacing:.03em;margin-bottom:1px}
.reply-text{color:var(--t2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:260px;font-size:11px;line-height:1.3}

/* ── MOBILE BACK/STATS BUTTONS (hidden on desktop) ── */
.backBtn{display:none;background:transparent;border:none;color:var(--text);font-size:20px;line-height:1;padding:2px 8px 2px 0;cursor:pointer;flex-shrink:0}
.statsBtn{display:none;margin-left:auto;background:transparent;border:1px solid var(--border2);border-radius:6px;color:var(--t2);font-family:'DM Mono',monospace;font-size:10px;padding:5px 9px;cursor:pointer;flex-shrink:0}
.spClose{display:none;padding:10px 12px;font-family:'DM Mono',monospace;font-size:11px;color:var(--t2);cursor:pointer;border-bottom:1px solid var(--border);text-align:right}
.scrim{display:none;position:fixed;top:52px;left:0;right:0;bottom:0;background:rgba(0,0,0,.45);z-index:5}

/* ── MOBILE LAYOUT ── */
@media (max-width:760px){
  .topbar{gap:8px;padding:0 10px}
  .tbstats{display:none}
  .csub{display:none}
  .sw{width:auto;flex:1;min-width:0}
  .search-results{left:0;right:0;width:auto;max-width:none}
  .main{position:relative}
  .sidebar{position:fixed;top:52px;left:0;right:0;bottom:0;width:100%;z-index:5;transform:translateX(0);transition:transform .22s ease}
  body.chat-open .sidebar{transform:translateX(-100%)}
  .cpanel{width:100%}
  .sp{position:fixed;top:52px;right:0;bottom:0;width:84%;max-width:320px;z-index:7;transform:translateX(100%);transition:transform .22s ease;box-shadow:-8px 0 28px rgba(0,0,0,.45)}
  body.stats-open .sp{transform:translateX(0)}
  body.stats-open .scrim{display:block}
  .spClose{display:block}
  .backBtn{display:inline-block}
  .statsBtn{display:inline-block}
  .clist,.msgs,.sp{-webkit-overflow-scrolling:touch}
  .mc{max-width:88%}
  .ci{padding:10px 14px}
}
`;

  const JS_LOGIC = `
const _cc={};let _ci=0;
function uCol(u){if(!_cc[u]){_cc[u]=PALETTE[_ci%PALETTE.length];_ci++;}return _cc[u];}
let ai=null,fm='all',cm=[],vsItems=[],vsFirst=-1,vsLast=-1,vsRAF=null;
let matches=[],hlIdx=-1,hlTO=null;
const fmD=t=>new Date(t).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'});
const fmT=t=>new Date(t).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
const fmDT=t=>new Date(t).toLocaleDateString('en-GB',{day:'2-digit',month:'short'})+' · '+fmT(t);
const fmDS=t=>new Date(t).toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
const ini=n=>n?n.slice(0,2).toUpperCase():'??';
const esc=s=>s?(s+'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'):'';
const ROW_H=44,OVERSCAN=14;

function buildRL(msgs){const list=[];let ld=null,lu=null;for(const m of msgs){const ds=new Date(m.t).toDateString();if(ds!==ld){list.push({type:'sep',label:fmDS(m.t)});ld=ds;lu=null;}const isStat=m.k.startsWith('STATUS_');const own=m.u===OWN;const show=m.u!==lu&&!isStat;if(!isStat)lu=m.u;list.push({type:'msg',m,own,show,isStat});}return list;}

function bClass(k){if(k==='SNAP')return'snap';if(k==='STICKER')return'stick';if(k==='EXTERNAL_MEDIA')return'med';if(k.startsWith('STATUS_')||k==='NOTE')return'stat';return'';}
function bText(m){if(m.k==='CHAT')return esc(m.x)||'<em style="color:var(--t3)">[empty]</em>';const map={SNAP:'📸 snap',STICKER:'🎨 sticker',EXTERNAL_MEDIA:'🎬 media',NOTE:'🎤 note',SHARE:'🔗 share',STATUS_SAVE_TO_CAMERA_ROLL:'⬇ saved to camera roll',STATUS_CONVERSATION_CAPTURE_SCREENSHOT:'📷 screenshot',STATUS_CONVERSATION_CAPTURE_RECORD:'⏺ screen recorded',STATUS_CALL_MISSED_AUDIO:'📞 missed call',STATUS_CALL_MISSED_VIDEO:'📹 missed video call',STATUS_STICKER_CUTOUT:'✂️ sticker cutout',STATUS_SNAP_REMIX_CAPTURE:'🔄 snap remix'};return map[m.k]||esc(m.k.toLowerCase().replace(/_/g,' '));}

function replyHTML(r,ownCol){
  if(!r||(!r.x&&r.k==='UNKNOWN'))return'';
  const rCol=r.u?uCol(r.u):ownCol;
  const rLabel=r.u?esc(r.u):'';
  let rTxt='';
  if(r.k==='CHAT'&&r.x)rTxt=esc(r.x.slice(0,80))+(r.x.length>80?'…':'');
  else if(r.k==='SNAP')rTxt='📸 snap';
  else if(r.k==='STICKER')rTxt='🎨 sticker';
  else if(r.k==='EXTERNAL_MEDIA')rTxt='🎬 media';
  else if(r.k&&r.k!=='UNKNOWN')rTxt=esc(r.k.toLowerCase().replace(/_/g,' '));
  if(!rTxt&&!rLabel)return'';
  return \`<div class="reply-preview" style="--rp-col:\${rCol}"><div class="reply-sender">\${rLabel}</div><div class="reply-text">\${rTxt||'📎 attachment'}</div></div>\`;
}
function rowHTML(item,idx){
  if(item.type==='sep')return \`<div class="dsep">\${esc(item.label)}</div>\`;
  const{m,own,show,isStat}=item;
  if(isStat)return \`<div class="mr"><div style="width:100%;text-align:center"><span class="bub stat">\${bText(m)}</span><div class="mtime" style="text-align:center">\${fmDT(m.t)}</div></div></div>\`;
  const col=uCol(m.u);
  const cs=\`--send-col:\${col};\`;
  let sh='';
  if(show){sh=\`<div class="msender" style="\${cs}">\${own?'Me':esc(m.u)}</div>\`;}
  const rp=m.r?replyHTML(m.r,col):'';
  const hl=(idx===hlIdx)?' hl':'';
  return \`<div class="mr\${own?' own':''}\${hl}" style="\${cs}"><div class="mav">\${own?'◎':ini(m.u)}</div><div class="mc">\${sh}\${rp}<div class="bub \${bClass(m.k)}" style="\${cs}">\${bText(m)}</div><div class="mtime">\${fmDT(m.t)}</div></div></div>\`;
}

function vsRender(stb){const el=document.getElementById('msgs');if(!vsItems.length){el.innerHTML='<div class="empty"><div class="eg"></div><div class="el">no messages</div></div>';return;}const vH=el.clientHeight||600;const tot=vsItems.length*ROW_H;const st2=stb?tot:el.scrollTop;const fv=Math.max(0,Math.floor(st2/ROW_H)-OVERSCAN);const lv=Math.min(vsItems.length,Math.ceil((st2+vH)/ROW_H)+OVERSCAN);if(!stb&&vsFirst===fv&&vsLast===lv)return;vsFirst=fv;vsLast=lv;const tp=fv*ROW_H,bp=Math.max(0,(vsItems.length-lv)*ROW_H);let h=\`<div style="height:\${tp}px;flex-shrink:0"></div>\`;for(let i=fv;i<lv;i++)h+=rowHTML(vsItems[i],i);h+=\`<div style="height:\${bp}px;flex-shrink:0"></div>\`;el.innerHTML=h;if(stb)el.scrollTop=el.scrollHeight;}
function vsOnScroll(){if(vsRAF)return;vsRAF=requestAnimationFrame(()=>{vsRAF=null;vsRender(false);});}
function vsMount(items,stb){const el=document.getElementById('msgs');vsItems=items;vsFirst=-1;vsLast=-1;el.removeEventListener('scroll',vsOnScroll);el.addEventListener('scroll',vsOnScroll,{passive:true});vsRender(stb!==false);}

function rList(f='all'){const cl=document.getElementById('cl');cl.innerHTML='';D.forEach((c,i)=>{if(f==='dm'&&c.g)return;if(f==='gc'&&!c.g)return;const el=document.createElement('div');el.className='ci'+(c.g?' gc':'')+(i===ai?' active':'');el.dataset.i=i;el.onclick=()=>openC(i);const nm=c.name.length>28?c.name.slice(0,26)+'…':c.name;const mc=c.n>=1000?(c.n/1000).toFixed(1)+'k':c.n;el.innerHTML=\`<div class="ca">\${ini(c.name)}</div><div class="cm"><div class="cn">\${esc(nm)}</div><div class="cs">\${fmD(c.l)}\${c.g?' · group':''}</div></div><div class="cbadge">\${mc}</div>\`;cl.appendChild(el);});}
function filt(m,b){fm=m;document.querySelectorAll('.fb').forEach(x=>x.classList.remove('active'));b.classList.add('active');rList(m);}
function openC(i){
  ai=i;const c=D[i];
  document.querySelectorAll('.ci').forEach(el=>el.classList.toggle('active',parseInt(el.dataset.i)===i));
  document.getElementById('ch').innerHTML=\`<button class="backBtn" onclick="document.body.classList.remove('chat-open')" aria-label="Back to conversations">‹</button><div class="cname">\${esc(c.name)}</div>\${c.g?\`<div style="font-size:10px;color:var(--t3);font-family:'DM Mono',monospace">\${c.p.length} members</div>\`:''}<div class="csub"><span>\${fmD(c.f)} – \${fmD(c.l)}</span><span>\${c.n.toLocaleString()} msgs</span></div><button class="statsBtn" onclick="document.body.classList.add('stats-open')" aria-label="View stats">ⓘ Stats</button>\`;
  cm=c.m;
  matches=[];hlIdx=-1;clearTimeout(hlTO);
  const qs=document.getElementById('qs');if(qs)qs.value='';
  renderResults();
  vsMount(buildRL(cm),true);
  uStats(c);
  document.body.classList.add('chat-open');
}

function uStats(c){const m=c.m;document.getElementById('st').textContent=m.length.toLocaleString();document.getElementById('sxt').textContent=m.filter(x=>x.k==='CHAT'&&x.x).length.toLocaleString();document.getElementById('sn2').textContent=m.filter(x=>x.k==='SNAP').length.toLocaleString();document.getElementById('sp2').textContent=new Set(m.map(x=>x.u)).size;document.getElementById('sd').textContent=fmD(c.f)+' – '+fmD(c.l);const sc={};m.forEach(x=>{sc[x.u]=(sc[x.u]||0)+1;});const s2=Object.entries(sc).sort((a,b)=>b[1]-a[1]).slice(0,8);document.getElementById('ss2').innerHTML=s2.map(([n,ct])=>\`<div class="pr"><div class="pd" style="\${n===OWN?'':'background:var(--t3)'}"></div><div class="pn">\${esc(n)}</div><div class="pc">\${ct.toLocaleString()}</div></div>\`).join('');const tc={};m.forEach(x=>{const t=x.k.startsWith('STATUS_')?'status':x.k.toLowerCase();tc[t]=(tc[t]||0)+1;});const ts2=Object.entries(tc).sort((a,b)=>b[1]-a[1]).slice(0,6);const mx=ts2[0]?.[1]||1;document.getElementById('stypes').innerHTML=ts2.map(([t,ct])=>\`<div class="mbi"><div class="mbl">\${t.slice(0,5)}</div><div class="mbt"><div class="mbf" style="width:\${(ct/mx*100).toFixed(0)}%"></div></div><div style="width:32px;text-align:right">\${ct.toLocaleString()}</div></div>\`).join('');const mc={};m.forEach(x=>{const k=new Date(x.t).toISOString().slice(0,7);mc[k]=(mc[k]||0)+1;});const mo=Object.entries(mc).sort((a,b)=>a[0]<b[0]?-1:1).slice(-12);const mm=Math.max(...mo.map(x=>x[1]));document.getElementById('smonths').innerHTML=mo.map(([k,ct])=>\`<div class="mbi"><div class="mbl">\${k.slice(2)}</div><div class="mbt"><div class="mbf" style="width:\${(ct/mm*100).toFixed(0)}%"></div></div><div style="width:32px;text-align:right">\${ct}</div></div>\`).join('');}

function buildSnippet(text,ql){
  if(!text)return '<em style="color:var(--t3)">[no text]</em>';
  const lower=text.toLowerCase();
  const pos=lower.indexOf(ql);
  if(pos<0){const t=text.length>70?text.slice(0,70)+'…':text;return esc(t);}
  const start=Math.max(0,pos-25),end=Math.min(text.length,pos+ql.length+35);
  const snip=text.slice(start,end);
  const snipLower=snip.toLowerCase();
  const mpos=snipLower.indexOf(ql);
  let html;
  if(mpos>=0)html=esc(snip.slice(0,mpos))+'<mark>'+esc(snip.slice(mpos,mpos+ql.length))+'</mark>'+esc(snip.slice(mpos+ql.length));
  else html=esc(snip);
  return (start>0?'…':'')+html+(end<text.length?'…':'');
}
function renderResults(){
  const panel=document.getElementById('searchResults');
  if(!panel)return;
  if(!matches.length){panel.classList.remove('open');panel.innerHTML='';return;}
  panel.innerHTML=matches.map(mt=>\`<div class="sr-item" onmousedown="event.preventDefault()" onclick="jumpToIdx(\${mt.idx})"><div class="sr-meta"><span class="sr-sender">\${esc(mt.u)}</span><span class="sr-date">\${esc(mt.date)}</span><div class="sr-snippet">\${mt.snippet}</div></div><button class="sr-jump" onmousedown="event.preventDefault()" onclick="event.stopPropagation();jumpToIdx(\${mt.idx})">Jump →</button></div>\`).join('');
  panel.classList.add('open');
}
function jumpToIdx(idx){
  hlIdx=idx;
  const el=document.getElementById('msgs');
  const vH=el.clientHeight||600;
  el.scrollTop=Math.max(0,idx*ROW_H-vH/2+ROW_H/2);
  vsFirst=-1;vsLast=-1;vsRender(false);
  clearTimeout(hlTO);
  hlTO=setTimeout(()=>{hlIdx=-1;vsFirst=-1;vsLast=-1;vsRender(false);},1800);
  const panel=document.getElementById('searchResults');
  if(panel)panel.classList.remove('open');
}
let st3=null;
function search(q){
  clearTimeout(st3);
  st3=setTimeout(()=>{
    if(ai===null||!q.trim()){matches=[];renderResults();return;}
    const ql=q.toLowerCase();
    matches=[];
    vsItems.forEach((it,i)=>{
      if(it.type!=='msg')return;
      const textHit=it.m.x&&it.m.x.toLowerCase().includes(ql);
      const userHit=it.m.u.toLowerCase().includes(ql);
      if(textHit||userHit)matches.push({idx:i,u:it.m.u,date:fmDT(it.m.t),snippet:buildSnippet(it.m.x,ql)});
    });
    renderResults();
  },200);
}
function openResults(){if(matches.length)document.getElementById('searchResults').classList.add('open');}
function closeResultsSoon(){setTimeout(()=>{const p=document.getElementById('searchResults');if(p)p.classList.remove('open');},150);}


rList('all');if(D.length>0)openC(0);

`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Snapchat Logs — ${escHtml(owner)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Mono:ital,wght@0,300;0,400;0,500;1,300&family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;1,9..40,300&display=swap" rel="stylesheet">
<style>${CSS}</style>
</head>
<body>
<div class="topbar">
  <div class="logo"><div class="ghost"></div>Snapchat Logs</div>
  <span class="badge">${escHtml(owner)}</span>
  <div class="sw"><span class="si">⌕</span><input type="text" id="qs" placeholder="Search messages…" oninput="search(this.value)" onfocus="openResults()" onblur="closeResultsSoon()" onkeydown="if(event.key==='Enter'){event.preventDefault();if(matches.length)jumpToIdx(matches[0].idx);}else if(event.key==='Escape'){this.blur();}"><div class="search-results" id="searchResults"></div></div>
  <div class="tbstats">
    <span><span class="sv">${stats.convos}</span> convos</span>
    <span><span class="sv">${stats.messages.toLocaleString()}</span> messages</span>
    <span><span class="sv">${stats.people}</span> people</span>
    <span><span class="sv">${dateRange}</span></span>
  </div>
</div>
<div class="main">
  <div class="sidebar">
    <div class="sh">
      <span class="stitle">Conversations</span>
      <div class="fbtns">
        <button class="fb active" onclick="filt('all',this)">All</button>
        <button class="fb" onclick="filt('dm',this)">DMs</button>
        <button class="fb" onclick="filt('gc',this)">Groups</button>
      </div>
    </div>
    <div class="clist" id="cl"></div>
  </div>
  <div class="cpanel">
    <div class="ch" id="ch"><span style="color:var(--t3);font-family:'DM Mono',monospace;font-size:11px">← select a conversation</span></div>
    <div class="msgs" id="msgs"><div class="empty"><div class="eg"></div><div class="el">no conversation selected</div></div></div>
  </div>
  <div class="sp">
    <div class="spClose" onclick="document.body.classList.remove('stats-open')">✕ Close</div>
    <div class="ss"><div class="sstitle">Overview</div>
      <div class="sr"><span class="sl">Total msgs</span><span class="sn" id="st">—</span></div>
      <div class="sr"><span class="sl">Text msgs</span><span class="sn" id="sxt">—</span></div>
      <div class="sr"><span class="sl">Snaps</span><span class="sn" id="sn2">—</span></div>
      <div class="sr"><span class="sl">Participants</span><span class="sn" id="sp2">—</span></div>
      <div class="sr"><span class="sl">Date range</span><span class="sn" id="sd" style="font-size:8px">—</span></div>
    </div>
    <div class="ss"><div class="sstitle">Top Senders</div><div id="ss2"></div></div>
    <div class="ss"><div class="sstitle">Message Types</div><div class="mbr" id="stypes"></div></div>
    <div class="ss"><div class="sstitle">Activity by Month</div><div class="mbr" id="smonths"></div></div>
  </div>
  <div class="scrim" id="scrim" onclick="document.body.classList.remove('stats-open')"></div>
</div>
<script>
const OWN=${JSON.stringify(owner)};
const PALETTE=['#F23C57','#0EADFF','#33C58D','#FF9500','#AF52DE','#FF2D55','#5AC8FA','#4CD964','#FFCC00','#FF6B6B'];
const D=${convosJson};
${JS_LOGIC}
<\/script>
</body>
</html>`;
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function escHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
