/**
 * generator.js
 * Reads a message_logger.db in-browser via sql.js (WebAssembly SQLite),
 * extracts all conversations and messages, then generates a self-contained
 * snapchat_viewer.html file for download.
 */

// ─── Drag & drop ────────────────────────────────────────────────────────────

const dropzone = document.getElementById('dropzone');

dropzone.addEventListener('dragover', e => {
  e.preventDefault();
  dropzone.classList.add('drag-over');
});

dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));

dropzone.addEventListener('drop', e => {
  e.preventDefault();
  dropzone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});

// ─── UI helpers ─────────────────────────────────────────────────────────────

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

function showProgress() {
  document.getElementById('progressCard').classList.add('visible');
  document.getElementById('dropzone').style.display = 'none';
}

function showResult(stats, htmlBlob, filename) {
  document.getElementById('progressCard').classList.remove('visible');
  document.getElementById('resultCard').classList.add('visible');

  document.getElementById('resultSub').textContent = filename;

  document.getElementById('statsGrid').innerHTML = [
    [stats.convos, 'conversations'],
    [stats.messages.toLocaleString(), 'messages'],
    [stats.people, 'people'],
    [stats.groups, 'group chats'],
    [stats.textMsgs.toLocaleString(), 'text msgs'],
    [stats.owner || '—', 'owner'],
  ].map(([v, l]) => `
    <div class="stat-cell">
      <div class="stat-cell-val">${v}</div>
      <div class="stat-cell-label">${l}</div>
    </div>
  `).join('');

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

// ─── Protobuf varint decoder ─────────────────────────────────────────────────

function readVarint(bytes, pos) {
  let result = 0, shift = 0;
  while (pos < bytes.length) {
    const b = bytes[pos++];
    result |= (b & 0x7F) << shift;
    if (!(b & 0x80)) break;
    shift += 7;
  }
  return [result, pos];
}

/**
 * Extracts the chat text from a Snapchat protobuf-encoded mContent field.
 * Structure: field2 (length-delimited) → field1 (string) → UTF-8 text
 */
function extractText(mContentArray) {
  if (!mContentArray || !mContentArray.length) return '';

  // mContent is stored as a JSON array of signed bytes — convert to Uint8Array
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
        // Parse inner message looking for field 1 (the text string)
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
              try {
                return new TextDecoder('utf-8').decode(innerChunk);
              } catch (_) {
                return '';
              }
            }
          } else if (innerWire === 0) {
            let _v;
            [_v, j] = readVarint(chunk, j);
          } else if (innerWire === 5) {
            j += 4;
          } else if (innerWire === 1) {
            j += 8;
          } else {
            break;
          }
        }
      }
    } else if (wireType === 0) {
      let _v;
      [_v, i] = readVarint(bs, i);
    } else if (wireType === 5) {
      i += 4;
    } else if (wireType === 1) {
      i += 8;
    } else {
      break;
    }
  }
  return '';
}

// ─── Main processing pipeline ────────────────────────────────────────────────

async function handleFile(file) {
  if (!file) return;
  showProgress();
  log(`Loaded: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`);
  setProgress(5, 'Loading sql.js…');

  let SQL;
  try {
    SQL = await initSqlJs({
      locateFile: file => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/${file}`
    });
    log('sql.js (WebAssembly SQLite) ready', 'ok');
  } catch (e) {
    log('Failed to load sql.js: ' + e.message, 'err');
    return;
  }

  setProgress(15, 'Reading database file…');

  let db;
  try {
    const buffer = await file.arrayBuffer();
    db = new SQL.Database(new Uint8Array(buffer));
    log('Database opened successfully', 'ok');
  } catch (e) {
    log('Failed to open database: ' + e.message, 'err');
    return;
  }

  setProgress(20, 'Checking schema…');

  // Verify it looks like a message_logger db
  let tables;
  try {
    tables = db.exec("SELECT name FROM sqlite_master WHERE type='table'")[0].values.flat();
    log(`Tables found: ${tables.join(', ')}`);
  } catch (e) {
    log('Could not read tables — is this a message_logger.db?', 'err');
    return;
  }

  if (!tables.includes('messages')) {
    log('No "messages" table found. Wrong database file?', 'err');
    return;
  }

  setProgress(25, 'Reading conversations…');

  // Get total message count
  const totalCount = db.exec('SELECT COUNT(*) FROM messages')[0].values[0][0];
  log(`Found ${totalCount.toLocaleString()} messages`);

  // Get conversation metadata
  const convoResult = db.exec(`
    SELECT conversation_id,
           MAX(group_title)           AS gt,
           COUNT(*)                   AS n,
           MIN(send_timestamp)        AS f,
           MAX(send_timestamp)        AS l,
           GROUP_CONCAT(DISTINCT username) AS p
    FROM messages
    GROUP BY conversation_id
    ORDER BY n DESC
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

  // Read all messages in one shot
  const msgResult = db.exec(
    'SELECT conversation_id, username, send_timestamp, message_data FROM messages ORDER BY send_timestamp ASC'
  );

  const msgByConvo = {};
  let processed = 0;
  let textExtracted = 0;

  if (msgResult.length) {
    const rows = msgResult[0].values;
    const total = rows.length;

    for (const row of rows) {
      const [cid, username, ts, rawData] = row;

      let ctype = 'UNKNOWN', text = '';
      try {
        const parsed = JSON.parse(new TextDecoder().decode(
          rawData instanceof Uint8Array ? rawData : new TextEncoder().encode(rawData)
        ));
        const content = parsed.mMessageContent || {};
        ctype = content.mContentType || 'UNKNOWN';

        if (ctype === 'CHAT') {
          const mc = content.mContent;
          text = mc ? extractText(mc) : '';
          if (text) textExtracted++;
        }
      } catch (_) { /* skip malformed */ }

      if (!msgByConvo[cid]) msgByConvo[cid] = [];
      msgByConvo[cid].push({ u: username, t: ts, k: ctype, x: text });

      processed++;
      if (processed % 5000 === 0) {
        const pct = 30 + Math.floor((processed / total) * 55);
        setProgress(pct, `Processing messages… ${processed.toLocaleString()} / ${total.toLocaleString()}`);
        // Yield to browser so the UI updates
        await new Promise(r => setTimeout(r, 0));
      }
    }
  }

  log(`Extracted text from ${textExtracted.toLocaleString()} chat messages`, 'ok');
  setProgress(86, 'Assembling conversations…');

  // Detect owner (most messages sent)
  const ownerCounts = {};
  for (const msgs of Object.values(msgByConvo)) {
    for (const m of msgs) {
      ownerCounts[m.u] = (ownerCounts[m.u] || 0) + 1;
    }
  }
  const owner = Object.entries(ownerCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  log(`Detected owner: ${owner}`, 'ok');

  // Build slim conversation array
  const slimConvos = [];
  for (const [cid, meta] of Object.entries(convoMeta)) {
    const { gt, n, f, l, p } = meta;
    const isGroup = gt !== cid;
    const displayName = isGroup ? gt : (p ? p.split(',')[0] : cid.slice(0, 8));
    const participants = p ? [...new Set(p.split(','))] : [];

    slimConvos.push({
      id: cid,
      name: displayName,
      g: isGroup,
      n,
      f,
      l,
      p: participants,
      m: msgByConvo[cid] || []
    });
  }

  const stats = {
    convos: numConvos,
    messages: processed,
    people: Object.keys(ownerCounts).length,
    groups: slimConvos.filter(c => c.g).length,
    textMsgs: textExtracted,
    owner
  };

  setProgress(92, 'Generating HTML viewer…');
  await new Promise(r => setTimeout(r, 0));

  const html = buildViewerHTML(owner, slimConvos, stats);
  log(`HTML generated: ${(html.length / 1024 / 1024).toFixed(2)} MB`, 'ok');

  setProgress(100, 'Done!');
  await new Promise(r => setTimeout(r, 300));

  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  showResult(stats, blob, file.name);
}

// ─── HTML viewer template ─────────────────────────────────────────────────────

function buildViewerHTML(owner, convos, stats) {
  const convosJson = JSON.stringify(convos, null, 0);

  const dateRange = (() => {
    let min = Infinity, max = -Infinity;
    for (const c of convos) {
      if (c.f < min) min = c.f;
      if (c.l > max) max = c.l;
    }
    const fmt = ts => new Date(ts).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
    return min === Infinity ? '—' : `${fmt(min)} – ${fmt(max)}`;
  })();

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Snapchat Logs — ${escHtml(owner)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Mono:ital,wght@0,300;0,400;0,500;1,300&family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;1,9..40,300&display=swap" rel="stylesheet">
<style>
:root{--bg:#0a0a0c;--surface:#111115;--surface2:#1a1a20;--border:#252530;--border2:#32323e;--y:#FFFC00;--yd:rgba(255,252,0,0.12);--yg:rgba(255,252,0,0.05);--text:#e8e8f0;--t2:#8888a0;--t3:#55556a;--snap:#aaa8ff;--stick:#ff9f78;--media:#78d9ff;}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'DM Sans',sans-serif;background:var(--bg);color:var(--text);height:100vh;overflow:hidden;display:flex;flex-direction:column}
.topbar{display:flex;align-items:center;gap:14px;padding:0 20px;height:56px;background:var(--surface);border-bottom:1px solid var(--border);flex-shrink:0}
.logo{display:flex;align-items:center;gap:8px;font-family:'DM Mono',monospace;font-size:13px;font-weight:500;letter-spacing:.05em}
.ghost{width:26px;height:26px;background:var(--y);border-radius:50% 50% 50% 50%/60% 60% 40% 40%;position:relative;flex-shrink:0}
.ghost::after{content:'';position:absolute;bottom:-3px;left:50%;transform:translateX(-50%);width:10px;height:6px;background:var(--y);clip-path:polygon(0 0,50% 100%,100% 0)}
.badge{font-family:'DM Mono',monospace;font-size:11px;color:var(--y);background:var(--yd);border:1px solid rgba(255,252,0,.2);padding:3px 8px;border-radius:20px;letter-spacing:.05em}
.tbstats{margin-left:auto;display:flex;gap:20px;font-family:'DM Mono',monospace;font-size:11px;color:var(--t3)}
.sv{color:var(--t2)}
.sw{position:relative;width:180px}
.sw input{width:100%;background:var(--surface2);border:1px solid var(--border);border-radius:8px;color:var(--text);font-family:'DM Sans',sans-serif;font-size:12px;padding:6px 10px 6px 26px;outline:none;transition:border-color .15s}
.sw input::placeholder{color:var(--t3)}
.sw input:focus{border-color:var(--border2)}
.si{position:absolute;left:8px;top:50%;transform:translateY(-50%);color:var(--t3);font-size:12px;pointer-events:none}
.main{display:flex;flex:1;overflow:hidden}
.sidebar{width:280px;flex-shrink:0;background:var(--surface);border-right:1px solid var(--border);display:flex;flex-direction:column;overflow:hidden}
.sh{padding:10px 14px 8px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;flex-shrink:0}
.stitle{font-family:'DM Mono',monospace;font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:var(--t3)}
.fbtns{display:flex;gap:4px}
.fb{font-size:10px;font-family:'DM Mono',monospace;padding:2px 7px;border-radius:4px;border:1px solid var(--border);background:transparent;color:var(--t3);cursor:pointer;transition:all .1s}
.fb.active,.fb:hover{background:var(--yd);color:var(--y);border-color:rgba(255,252,0,.25)}
.clist{flex:1;overflow-y:auto;scrollbar-width:thin;scrollbar-color:var(--border2) transparent}
.ci{display:flex;align-items:center;gap:10px;padding:9px 14px;cursor:pointer;border-bottom:1px solid var(--border);transition:background .1s}
.ci:hover{background:var(--yg)}
.ci.active{background:var(--yd);border-left:2px solid var(--y)}
.ca{width:34px;height:34px;border-radius:50%;background:var(--surface2);border:1px solid var(--border2);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;flex-shrink:0;color:var(--t2);font-family:'DM Mono',monospace}
.ci.active .ca{background:var(--y);color:#000;border-color:transparent}
.ci.gc .ca{border-radius:8px}
.cm{flex:1;min-width:0}
.cn{font-size:12px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cs{font-family:'DM Mono',monospace;font-size:10px;color:var(--t3);margin-top:1px}
.cbadge{font-family:'DM Mono',monospace;font-size:9px;padding:1px 5px;border-radius:10px;background:var(--surface2);color:var(--t3);flex-shrink:0}
.cpanel{flex:1;display:flex;flex-direction:column;overflow:hidden}
.ch{padding:0 20px;height:50px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px;flex-shrink:0;background:var(--surface)}
.cname{font-size:14px;font-weight:600}
.csub{font-family:'DM Mono',monospace;font-size:11px;color:var(--t3);margin-left:auto;display:flex;gap:16px}
.msgs{flex:1;overflow-y:auto;padding:16px 20px;scrollbar-width:thin;scrollbar-color:var(--border2) transparent;display:flex;flex-direction:column;gap:2px}
.dsep{display:flex;align-items:center;gap:10px;margin:14px 0 8px;font-family:'DM Mono',monospace;font-size:10px;color:var(--t3);letter-spacing:.05em}
.dsep::before,.dsep::after{content:'';flex:1;height:1px;background:var(--border)}
.mr{display:flex;gap:8px;align-items:flex-end;padding:1px 0}
.mr.own{flex-direction:row-reverse}
.mav{width:22px;height:22px;border-radius:50%;background:var(--surface2);border:1px solid var(--border2);display:flex;align-items:center;justify-content:center;font-size:8px;font-family:'DM Mono',monospace;color:var(--t3);flex-shrink:0;align-self:flex-end}
.mr.own .mav{background:var(--y);color:#000;border-color:transparent}
.mc{display:flex;flex-direction:column;gap:1px;max-width:65%}
.mr.own .mc{align-items:flex-end}
.msender{font-family:'DM Mono',monospace;font-size:9px;color:var(--t3);margin-bottom:2px;padding:0 4px}
.bub{padding:7px 11px;border-radius:16px;font-size:13px;line-height:1.45;word-break:break-word}
.mr:not(.own) .bub{background:var(--surface2);color:var(--text);border-bottom-left-radius:4px}
.mr.own .bub{background:var(--y);color:#111;border-bottom-right-radius:4px;font-weight:500}
.bub.snap{background:rgba(170,168,255,.1);border:1px solid rgba(170,168,255,.2);color:var(--snap);font-family:'DM Mono',monospace;font-size:11px;font-style:italic}
.mr.own .bub.snap{background:rgba(170,168,255,.2);border:1px solid rgba(170,168,255,.3)}
.bub.stick{background:rgba(255,159,120,.08);border:1px solid rgba(255,159,120,.2);color:var(--stick);font-family:'DM Mono',monospace;font-size:11px}
.bub.med{background:rgba(120,217,255,.08);border:1px solid rgba(120,217,255,.2);color:var(--media);font-family:'DM Mono',monospace;font-size:11px}
.bub.stat{background:transparent;color:var(--t3);font-family:'DM Mono',monospace;font-size:10px;font-style:italic;padding:4px 8px}
.mtime{font-family:'DM Mono',monospace;font-size:9px;color:var(--t3);padding:0 4px;margin-top:1px}
.empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px}
.eg{width:60px;height:60px;background:var(--surface2);border-radius:50% 50% 50% 50%/60% 60% 40% 40%;opacity:.3;position:relative}
.eg::after{content:'';position:absolute;bottom:-6px;left:50%;transform:translateX(-50%);width:24px;height:12px;background:var(--surface2);clip-path:polygon(0 0,50% 100%,100% 0)}
.el{font-family:'DM Mono',monospace;font-size:12px;color:var(--t3)}
.sp{width:220px;flex-shrink:0;background:var(--surface);border-left:1px solid var(--border);overflow-y:auto;scrollbar-width:thin;scrollbar-color:var(--border2) transparent}
.ss{padding:12px 14px;border-bottom:1px solid var(--border)}
.sstitle{font-family:'DM Mono',monospace;font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:var(--t3);margin-bottom:10px}
.sr{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px;font-size:12px}
.sl{color:var(--t2)}
.sn{font-family:'DM Mono',monospace;font-size:12px;color:var(--y)}
.pr{display:flex;align-items:center;gap:7px;margin-bottom:6px}
.pd{width:6px;height:6px;border-radius:50%;background:var(--y);flex-shrink:0}
.pn{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--t2);font-family:'DM Mono',monospace;font-size:10px}
.pc{font-family:'DM Mono',monospace;font-size:10px;color:var(--t3)}
.mbr{display:flex;flex-direction:column;gap:5px;margin-top:4px}
.mbi{display:flex;align-items:center;gap:6px;font-family:'DM Mono',monospace;font-size:10px;color:var(--t3)}
.mbl{width:38px;text-align:right}
.mbt{flex:1;height:4px;background:var(--border);border-radius:2px;overflow:hidden}
.mbf{height:100%;background:var(--y);border-radius:2px;transition:width .5s ease}
::-webkit-scrollbar{width:4px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:var(--border2);border-radius:2px}
</style>
</head>
<body>
<div class="topbar">
  <div class="logo"><div class="ghost"></div>Snapchat Logs</div>
  <span class="badge">${escHtml(owner)}</span>
  <div class="sw"><span class="si">⌕</span><input type="text" id="qs" placeholder="Search messages…" oninput="search(this.value)"></div>
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
    <div class="ch" id="ch"><span style="color:var(--t3);font-family:'DM Mono',monospace;font-size:12px">← select a conversation</span></div>
    <div class="msgs" id="msgs"><div class="empty"><div class="eg"></div><div class="el">no conversation selected</div></div></div>
  </div>
  <div class="sp">
    <div class="ss"><div class="sstitle">Overview</div>
      <div class="sr"><span class="sl">Total msgs</span><span class="sn" id="st">—</span></div>
      <div class="sr"><span class="sl">Text msgs</span><span class="sn" id="sxt">—</span></div>
      <div class="sr"><span class="sl">Snaps</span><span class="sn" id="sn2">—</span></div>
      <div class="sr"><span class="sl">Participants</span><span class="sn" id="sp2">—</span></div>
      <div class="sr"><span class="sl">Date range</span><span class="sn" id="sd" style="font-size:9px">—</span></div>
    </div>
    <div class="ss"><div class="sstitle">Top Senders</div><div id="ss2"></div></div>
    <div class="ss"><div class="sstitle">Message Types</div><div class="mbr" id="stypes"></div></div>
    <div class="ss"><div class="sstitle">Activity by Month</div><div class="mbr" id="smonths"></div></div>
  </div>
</div>
<script>
const OW=${JSON.stringify(owner)};
const D=${convosJson};
let ai=null,fm='all',cm=[],vsItems=[],vsFirst=-1,vsLast=-1,vsRAF=null;
const fmD=t=>new Date(t).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'});
const fmT=t=>new Date(t).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
const fmDS=t=>new Date(t).toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
const ini=n=>n?n.slice(0,2).toUpperCase():'??';
const esc=s=>s?(s+'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'):'';
const ROW_H=42,OVERSCAN=15;
function buildRL(msgs){const list=[];let ld=null,lu=null;for(const m of msgs){const ds=new Date(m.t).toDateString();if(ds!==ld){list.push({type:'sep',label:fmDS(m.t)});ld=ds;lu=null;}const isStat=m.k.startsWith('STATUS_');const own=m.u===OW;const show=!own&&m.u!==lu&&!isStat;if(!isStat)lu=m.u;list.push({type:'msg',m,own,show,isStat});}return list;}
function bClass(k){if(k==='SNAP')return'snap';if(k==='STICKER')return'stick';if(k==='EXTERNAL_MEDIA')return'med';if(k.startsWith('STATUS_')||k==='NOTE')return'stat';return'';}
function bText(m){if(m.k==='CHAT')return esc(m.x)||'<em style="color:var(--t3)">[empty]</em>';const map={SNAP:'📸 snap',STICKER:'🎨 sticker',EXTERNAL_MEDIA:'🎬 media',NOTE:'🎤 note',SHARE:'🔗 share',STATUS_SAVE_TO_CAMERA_ROLL:'⬇ saved to camera roll',STATUS_CONVERSATION_CAPTURE_SCREENSHOT:'📷 screenshot',STATUS_CONVERSATION_CAPTURE_RECORD:'⏺ screen recorded',STATUS_CALL_MISSED_AUDIO:'📞 missed call',STATUS_CALL_MISSED_VIDEO:'📹 missed video call',STATUS_STICKER_CUTOUT:'✂️ sticker cutout',STATUS_SNAP_REMIX_CAPTURE:'🔄 snap remix'};return map[m.k]||esc(m.k.toLowerCase().replace(/_/g,' '));}
function rowHTML(item){if(item.type==='sep')return \`<div class="dsep">\${esc(item.label)}</div>\`;const{m,own,show,isStat}=item;if(isStat)return \`<div class="mr"><div style="width:100%;text-align:center"><span class="bub stat">\${bText(m)}</span><div class="mtime" style="text-align:center">\${fmT(m.t)}</div></div></div>\`;return \`<div class="mr\${own?' own':''}">\`+\`<div class="mav">\${own?'◎':ini(m.u)}</div>\`+\`<div class="mc">\`+(show?\`<div class="msender">\${esc(m.u)}</div>\`:'')+\`<div class="bub \${bClass(m.k)}">\${bText(m)}</div><div class="mtime">\${fmT(m.t)}</div></div></div>\`;}
function vsRender(scrollToBottom){const el=document.getElementById('msgs');if(!vsItems.length){el.innerHTML='<div class="empty"><div class="eg"></div><div class="el">no messages</div></div>';return;}const viewH=el.clientHeight||600;const totalEst=vsItems.length*ROW_H;const st=scrollToBottom?totalEst:el.scrollTop;const fv=Math.max(0,Math.floor(st/ROW_H)-OVERSCAN);const lv=Math.min(vsItems.length,Math.ceil((st+viewH)/ROW_H)+OVERSCAN);if(!scrollToBottom&&vsFirst===fv&&vsLast===lv)return;vsFirst=fv;vsLast=lv;const tp=fv*ROW_H;const bp=Math.max(0,(vsItems.length-lv)*ROW_H);let h=\`<div style="height:\${tp}px;flex-shrink:0"></div>\`;for(let i=fv;i<lv;i++)h+=rowHTML(vsItems[i]);h+=\`<div style="height:\${bp}px;flex-shrink:0"></div>\`;el.innerHTML=h;if(scrollToBottom)el.scrollTop=el.scrollHeight;}
function vsOnScroll(){if(vsRAF)return;vsRAF=requestAnimationFrame(()=>{vsRAF=null;vsRender(false);});}
function vsMount(items,stb){const el=document.getElementById('msgs');vsItems=items;vsFirst=-1;vsLast=-1;el.removeEventListener('scroll',vsOnScroll);el.addEventListener('scroll',vsOnScroll,{passive:true});vsRender(stb!==false);}
function rList(f='all'){const cl=document.getElementById('cl');cl.innerHTML='';D.forEach((c,i)=>{if(f==='dm'&&c.g)return;if(f==='gc'&&!c.g)return;const el=document.createElement('div');el.className='ci'+(c.g?' gc':'')+(i===ai?' active':'');el.dataset.i=i;el.onclick=()=>openC(i);const nm=c.name.length>28?c.name.slice(0,26)+'…':c.name;const mc=c.n>=1000?(c.n/1000).toFixed(1)+'k':c.n;el.innerHTML=\`<div class="ca">\${ini(c.name)}</div><div class="cm"><div class="cn">\${esc(nm)}</div><div class="cs">\${fmD(c.l)}\${c.g?' · group':''}</div></div><div class="cbadge">\${mc}</div>\`;cl.appendChild(el);});}
function filt(m,b){fm=m;document.querySelectorAll('.fb').forEach(x=>x.classList.remove('active'));b.classList.add('active');rList(m);}
function openC(i){ai=i;const c=D[i];document.querySelectorAll('.ci').forEach(el=>el.classList.toggle('active',parseInt(el.dataset.i)===i));document.getElementById('ch').innerHTML=\`<div class="cname">\${esc(c.name)}</div>\${c.g?\`<div style="font-size:11px;color:var(--t3);font-family:'DM Mono',monospace">\${c.p.length} members</div>\`:''}<div class="csub"><span>\${fmD(c.f)} – \${fmD(c.l)}</span><span>\${c.n.toLocaleString()} msgs</span></div>\`;cm=c.m;vsMount(buildRL(cm),true);uStats(c);}
function uStats(c){const m=c.m;document.getElementById('st').textContent=m.length.toLocaleString();document.getElementById('sxt').textContent=m.filter(x=>x.k==='CHAT'&&x.x).length.toLocaleString();document.getElementById('sn2').textContent=m.filter(x=>x.k==='SNAP').length.toLocaleString();document.getElementById('sp2').textContent=new Set(m.map(x=>x.u)).size;document.getElementById('sd').textContent=fmD(c.f)+' – '+fmD(c.l);const sc={};m.forEach(x=>{sc[x.u]=(sc[x.u]||0)+1;});const s2=Object.entries(sc).sort((a,b)=>b[1]-a[1]).slice(0,8);document.getElementById('ss2').innerHTML=s2.map(([n,ct])=>\`<div class="pr"><div class="pd" style="\${n===OW?'':'background:var(--t3)'}"></div><div class="pn">\${esc(n)}</div><div class="pc">\${ct.toLocaleString()}</div></div>\`).join('');const tc={};m.forEach(x=>{const t=x.k.startsWith('STATUS_')?'status':x.k.toLowerCase();tc[t]=(tc[t]||0)+1;});const ts2=Object.entries(tc).sort((a,b)=>b[1]-a[1]).slice(0,6);const mx=ts2[0]?.[1]||1;document.getElementById('stypes').innerHTML=ts2.map(([t,ct])=>\`<div class="mbi"><div class="mbl">\${t.slice(0,5)}</div><div class="mbt"><div class="mbf" style="width:\${(ct/mx*100).toFixed(0)}%"></div></div><div style="width:36px;text-align:right">\${ct.toLocaleString()}</div></div>\`).join('');const mc={};m.forEach(x=>{const k=new Date(x.t).toISOString().slice(0,7);mc[k]=(mc[k]||0)+1;});const mo=Object.entries(mc).sort((a,b)=>a[0]<b[0]?-1:1).slice(-12);const mm=Math.max(...mo.map(x=>x[1]));document.getElementById('smonths').innerHTML=mo.map(([k,ct])=>\`<div class="mbi"><div class="mbl">\${k.slice(2)}</div><div class="mbt"><div class="mbf" style="width:\${(ct/mm*100).toFixed(0)}%"></div></div><div style="width:36px;text-align:right">\${ct}</div></div>\`).join('');}
let st2=null;function search(q){clearTimeout(st2);st2=setTimeout(()=>{if(!q.trim()||ai===null){if(ai!==null)vsMount(buildRL(cm),true);return;}const ql=q.toLowerCase();const f=cm.filter(m=>(m.x&&m.x.toLowerCase().includes(ql))||m.u.toLowerCase().includes(ql));vsMount(buildRL(f),true);const ch=document.getElementById('ch');const ex=ch.querySelector('.csub');if(ex){const prev=ex.querySelector('.mc');if(prev)prev.remove();const sp=document.createElement('span');sp.style.color='var(--y)';sp.textContent=f.length+' matches';ex.appendChild(sp);}},200);}
rList('all');if(D.length>0)openC(0);
<\/script>
</body>
</html>`;
}

// ─── Utility ─────────────────────────────────────────────────────────────────

function escHtml(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
