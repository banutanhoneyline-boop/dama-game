/* ═══════════════════════════════════════════
   DAMA — WebRTC Multiplayer + Game Engine
   dama.js
═══════════════════════════════════════════ */

/* ─── WEBRTC STATE ─── */
let pc = null;       // RTCPeerConnection
let dc = null;       // RTCDataChannel
let myRole = null;   // 'host' | 'join' | 'local'

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

/* ─── Create Peer Connection ─── */
function makePC() {
  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  pc.onicegatheringstatechange = () => {
    // used in waitICE()
  };

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    const badgeId = myRole === 'host' ? 'host-status' : 'join-status';
    if (s === 'connected') {
      setStatus(badgeId, 'connected', '🟢 Connected');
      setTimeout(() => startGame(), 400);
    } else if (s === 'failed') {
      setStatus(badgeId, 'error', '❌ Failed');
    } else {
      setStatus(badgeId, 'waiting', '⌛ Waiting…');
    }
  };

  pc.ondatachannel = e => {
    dc = e.channel;
    setupDC();
  };
}

function setupDC() {
  dc.onopen    = () => addLog('sys', 'Connection established!');
  dc.onmessage = e => handleRemote(JSON.parse(e.data));
  dc.onclose   = () => addLog('sys', 'Connection closed.');
}

function sendRemote(obj) {
  if (dc && dc.readyState === 'open') dc.send(JSON.stringify(obj));
}

/* ─── HOST FLOW ─── */
async function startHost() {
  myRole = 'host';
  show('host-screen');
  makePC();

  dc = pc.createDataChannel('dama');
  setupDC();

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  await waitICE();
  document.getElementById('host-offer').value = btoa(JSON.stringify(pc.localDescription));
}

async function hostAcceptAnswer() {
  const raw = document.getElementById('host-answer').value.trim();
  if (!raw) { alert('Paste the answer code first.'); return; }
  try {
    const ans = JSON.parse(atob(raw));
    await pc.setRemoteDescription(ans);
  } catch (e) {
    alert('Invalid answer code.');
  }
}

/* ─── JOIN FLOW ─── */
function startJoin() {
  myRole = 'join';
  show('join-screen');
}

async function joinMakeAnswer() {
  const raw = document.getElementById('join-offer').value.trim();
  if (!raw) { alert('Paste the offer code first.'); return; }
  makePC();
  try {
    const offer = JSON.parse(atob(raw));
    await pc.setRemoteDescription(offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitICE();
    document.getElementById('join-answer').value = btoa(JSON.stringify(pc.localDescription));
  } catch (e) {
    alert('Invalid offer code: ' + e.message);
  }
}

/* ─── LOCAL FLOW ─── */
function startLocal() {
  myRole = 'local';
  startGame();
}

/* ─── HELPERS ─── */
function waitICE() {
  return new Promise(res => {
    if (pc.iceGatheringState === 'complete') return res();
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === 'complete') res();
    };
    setTimeout(res, 4000); // fallback timeout
  });
}

function setStatus(id, type, text) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = 'status-badge badge-' + type;
  el.textContent = text;
}

function copyText(id) {
  const el = document.getElementById(id);
  el.select();
  document.execCommand('copy');
  alert('Copied!');
}

function goLobby() {
  location.reload();
}

function show(id) {
  ['lobby-screen', 'host-screen', 'join-screen', 'game-screen'].forEach(s => {
    document.getElementById(s).classList.toggle('hidden', s !== id);
  });
}

/* ═══════════════════════════════════════════
   DAMA GAME ENGINE
═══════════════════════════════════════════ */

const EMPTY = null;

let board = [];           // 8×8 array: {player, king} | null
let currentTurn = 1;      // 1 = Red (P1), 2 = White (P2)
let selectedCell = null;  // {r, c}
let validMoves = [];      // [{r, c, moves:[{r,c}]}]
let mustCapture = [];     // [{r, c, caps:[{er,ec,lr,lc}]}]
let p1Captured = 0;
let p2Captured = 0;
let gameOver = false;
let isRemote = false;     // true when playing over network
let myPlayer = 1;         // which player this client controls (network mode)

/* ─── START / RESET ─── */
function startGame() {
  isRemote = myRole !== 'local';
  myPlayer = (myRole === 'join') ? 2 : 1;

  document.getElementById('p1-name').textContent = isRemote
    ? (myPlayer === 1 ? 'You (Red)'   : 'P1 (Red)')
    : 'Player 1';
  document.getElementById('p2-name').textContent = isRemote
    ? (myPlayer === 2 ? 'You (White)' : 'P2 (White)')
    : 'Player 2';

  show('game-screen');
  resetGame();
}

function resetGame() {
  // Build empty 8×8 board
  board = Array.from({ length: 8 }, () => Array(8).fill(EMPTY));

  // Player 2 (White) on top rows 0–2 — dark squares only
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 8; c++)
      if ((r + c) % 2 === 1) board[r][c] = { player: 2, king: false };

  // Player 1 (Red) on bottom rows 5–7 — dark squares only
  for (let r = 5; r < 8; r++)
    for (let c = 0; c < 8; c++)
      if ((r + c) % 2 === 1) board[r][c] = { player: 1, king: false };

  currentTurn   = 1;
  selectedCell  = null;
  validMoves    = [];
  mustCapture   = [];
  p1Captured    = 0;
  p2Captured    = 0;
  gameOver      = false;

  document.getElementById('win-overlay').classList.add('hidden');
  updateAllCaptures();
  render();
  calcMoves();
  updateUI();
}

/* ─── MOVE CALCULATION ─── */
function calcMoves() {
  mustCapture = [];
  validMoves  = [];

  // Look for mandatory captures first
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if (board[r][c]?.player === currentTurn) {
        const caps = getCaptures(r, c);
        if (caps.length) mustCapture.push({ r, c, caps });
      }
    }
  }

  // If no captures, find simple moves
  if (mustCapture.length === 0) {
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        if (board[r][c]?.player === currentTurn) {
          const moves = getSimpleMoves(r, c);
          if (moves.length) validMoves.push({ r, c, moves });
        }
      }
    }
  }
}

function getSimpleMoves(r, c) {
  const p = board[r][c];
  if (!p) return [];
  const moves = [];

  if (p.king) {
    // Kings slide diagonally in all 4 directions until blocked
    for (const dr of [-1, 1]) {
      for (const dc of [-1, 1]) {
        let nr = r + dr, nc = c + dc;
        while (nr >= 0 && nr < 8 && nc >= 0 && nc < 8 && board[nr][nc] === EMPTY) {
          moves.push({ r: nr, c: nc });
          nr += dr; nc += dc;
        }
      }
    }
  } else {
    // Normal piece: one step diagonally forward
    const dr = p.player === 1 ? -1 : 1;
    for (const dc of [-1, 1]) {
      const nr = r + dr, nc = c + dc;
      if (nr >= 0 && nr < 8 && nc >= 0 && nc < 8 && board[nr][nc] === EMPTY)
        moves.push({ r: nr, c: nc });
    }
  }
  return moves;
}

function getCaptures(r, c, visited = []) {
  const p = board[r][c];
  if (!p) return [];
  const caps = [];
  const dirRows = p.king ? [-1, 1] : (p.player === 1 ? [-1] : [1]);

  for (const dr of dirRows) {
    for (const dc of [-1, 1]) {
      if (p.king) {
        // King: slide until hitting an enemy, then jump to all empty squares beyond
        let nr = r + dr, nc = c + dc;
        while (nr >= 0 && nr < 8 && nc >= 0 && nc < 8 && board[nr][nc] === EMPTY) {
          nr += dr; nc += dc;
        }
        if (
          nr >= 0 && nr < 8 && nc >= 0 && nc < 8 &&
          board[nr][nc]?.player && board[nr][nc].player !== p.player
        ) {
          const key = `${nr},${nc}`;
          if (!visited.includes(key)) {
            let lr = nr + dr, lc = nc + dc;
            while (lr >= 0 && lr < 8 && lc >= 0 && lc < 8 && board[lr][lc] === EMPTY) {
              caps.push({ er: nr, ec: nc, lr, lc });
              lr += dr; lc += dc;
            }
          }
        }
      } else {
        // Normal piece: jump exactly 2 squares
        const er = r + dr, ec = c + dc, lr = r + 2 * dr, lc = c + 2 * dc;
        if (
          er >= 0 && er < 8 && ec >= 0 && ec < 8 &&
          lr >= 0 && lr < 8 && lc >= 0 && lc < 8 &&
          board[er][ec]?.player && board[er][ec].player !== p.player &&
          board[lr][lc] === EMPTY
        ) {
          const key = `${er},${ec}`;
          if (!visited.includes(key)) caps.push({ er, ec, lr, lc });
        }
      }
    }
  }
  return caps;
}

/* ─── USER INTERACTION ─── */
function onCellClick(r, c) {
  if (gameOver) return;
  if (isRemote && currentTurn !== myPlayer) return;

  const piece = board[r][c];

  // Clicking own piece → select it
  if (piece?.player === currentTurn) {
    const hasCaps  = mustCapture.find(x => x.r === r && x.c === c);
    const hasMoves = validMoves.find(x => x.r === r && x.c === c);
    if (!hasCaps && mustCapture.length > 0) return; // must capture something
    if (!hasCaps && !hasMoves) return;
    selectedCell = { r, c };
    render();
    return;
  }

  // Clicking a destination square
  if (selectedCell) {
    const { r: sr, c: sc } = selectedCell;

    // Try capture
    const capData = mustCapture.find(x => x.r === sr && x.c === sc);
    if (capData) {
      const cap = capData.caps.find(x => x.lr === r && x.lc === c);
      if (cap) { doCapture(sr, sc, cap); return; }
    }

    // Try simple move
    const moveData = validMoves.find(x => x.r === sr && x.c === sc);
    if (moveData) {
      const mv = moveData.moves.find(x => x.r === r && x.c === c);
      if (mv) { doMove(sr, sc, r, c); return; }
    }

    // Deselect
    selectedCell = null;
    render();
  }
}

/* ─── EXECUTE MOVES ─── */
function doMove(fr, fc, tr, tc, remote = false) {
  const piece   = board[fr][fc];
  board[tr][tc] = piece;
  board[fr][fc] = EMPTY;
  promoteCheck(tr, tc);
  if (!remote && isRemote) sendRemote({ type: 'move', fr, fc, tr, tc });
  addLog(null, `P${piece.player}  ${fr},${fc} → ${tr},${tc}`);
  selectedCell = null;
  endTurn();
}

function doCapture(fr, fc, cap, remote = false) {
  const { er, ec, lr, lc } = cap;
  const piece   = board[fr][fc];
  board[lr][lc] = piece;
  board[fr][fc] = EMPTY;
  board[er][ec] = EMPTY;

  if (piece.player === 1) p1Captured++; else p2Captured++;
  promoteCheck(lr, lc);
  if (!remote && isRemote) sendRemote({ type: 'capture', fr, fc, er, ec, lr, lc });
  addLog(null, `P${piece.player} captured at ${er},${ec}`);
  selectedCell = null;

  // Check for multi-jump
  const moreCaps = getCaptures(lr, lc, [`${er},${ec}`]);
  if (moreCaps.length) {
    mustCapture  = [{ r: lr, c: lc, caps: moreCaps }];
    validMoves   = [];
    selectedCell = { r: lr, c: lc };
    updateAllCaptures(); render(); updateUI();
    return;
  }
  endTurn();
}

function promoteCheck(r, c) {
  const p = board[r][c];
  if (!p) return;
  if (p.player === 1 && r === 0) p.king = true;
  if (p.player === 2 && r === 7) p.king = true;
}

function endTurn() {
  currentTurn = currentTurn === 1 ? 2 : 1;
  updateAllCaptures();
  render();
  calcMoves();
  updateUI();
  checkWin();
}

/* ─── WIN CONDITION ─── */
function checkWin() {
  let p1 = 0, p2 = 0;
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++) {
      if (board[r][c]?.player === 1) p1++;
      if (board[r][c]?.player === 2) p2++;
    }

  const noMoves = mustCapture.length === 0 && validMoves.length === 0;
  if (p1 === 0 || (noMoves && currentTurn === 1)) showWin(2);
  else if (p2 === 0 || (noMoves && currentTurn === 2)) showWin(1);
}

function showWin(player) {
  gameOver = true;
  document.getElementById('win-text').textContent = `Player ${player} Wins! 🏆`;
  document.getElementById('win-sub').textContent  =
    player === 1 ? 'Red dominates the board!' : 'White takes the crown!';
  document.getElementById('win-overlay').classList.remove('hidden');
  if (isRemote) sendRemote({ type: 'win', player });
}

/* ─── REMOTE MESSAGE HANDLER ─── */
function handleRemote(msg) {
  if (msg.type === 'move')    doMove(msg.fr, msg.fc, msg.tr, msg.tc, true);
  if (msg.type === 'capture') doCapture(msg.fr, msg.fc, { er: msg.er, ec: msg.ec, lr: msg.lr, lc: msg.lc }, true);
  if (msg.type === 'reset')   resetGame();
  if (msg.type === 'win')     showWin(msg.player);
}

/* ─── RENDER ─── */
function render() {
  const boardEl = document.getElementById('board');
  boardEl.innerHTML = '';

  const selCaptures = selectedCell
    ? (mustCapture.find(x => x.r === selectedCell.r && x.c === selectedCell.c)?.caps || [])
    : [];
  const selMoves = selectedCell
    ? (validMoves.find(x => x.r === selectedCell.r && x.c === selectedCell.c)?.moves || [])
    : [];
  const selectableKeys = mustCapture.length
    ? mustCapture.map(x => `${x.r},${x.c}`)
    : validMoves.map(x => `${x.r},${x.c}`);

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const cell   = document.createElement('div');
      const isDark = (r + c) % 2 === 1;
      cell.className = 'cell ' + (isDark ? 'dark' : 'light');

      const isSel  = selectedCell?.r === r && selectedCell?.c === c;
      const isHint = isDark && (
        selCaptures.some(x => x.lr === r && x.lc === c) ||
        selMoves.some(x => x.r === r && x.c === c)
      );
      const isSelectable = isDark &&
        selectableKeys.includes(`${r},${c}`) &&
        (!isRemote || currentTurn === myPlayer);

      if (isSel)          cell.classList.add('selected');
      if (isHint)         cell.classList.add('move-hint');
      if (isSelectable)   cell.classList.add('selectable');
      if (isDark)         cell.addEventListener('click', () => onCellClick(r, c));

      const piece = board[r][c];
      if (piece) {
        const el = document.createElement('div');
        el.className = `piece p${piece.player}${piece.king ? ' king' : ''}${isSel ? ' selected' : ''}`;
        el.addEventListener('click', e => { e.stopPropagation(); onCellClick(r, c); });
        cell.appendChild(el);
      }

      boardEl.appendChild(cell);
    }
  }
}

/* ─── UI UPDATES ─── */
function updateUI() {
  let p1 = 0, p2 = 0;
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++) {
      if (board[r][c]?.player === 1) p1++;
      if (board[r][c]?.player === 2) p2++;
    }
  document.getElementById('p1-count').textContent = p1 + ' pieces';
  document.getElementById('p2-count').textContent = p2 + ' pieces';
  document.getElementById('p1-card').classList.toggle('active', currentTurn === 1);
  document.getElementById('p2-card').classList.toggle('active', currentTurn === 2);
}

function updateAllCaptures() {
  document.getElementById('p1-caps').innerHTML =
    Array(p1Captured).fill(`<div class="cap-dot p2"></div>`).join('');
  document.getElementById('p2-caps').innerHTML =
    Array(p2Captured).fill(`<div class="cap-dot p1"></div>`).join('');
}

/* ─── LOG ─── */
function addLog(type, text) {
  const el = document.getElementById('log');
  if (!el) return;
  const entry = document.createElement('div');
  entry.className = 'log-entry' + (type === 'sys' ? ' sys' : '');
  entry.textContent = text;
  el.appendChild(entry);
  el.scrollTop = el.scrollHeight;
}

/* ─── RESET CONFIRM ─── */
function confirmReset() {
  if (!confirm('Start a new game?')) return;
  if (isRemote) sendRemote({ type: 'reset' });
  resetGame();
}