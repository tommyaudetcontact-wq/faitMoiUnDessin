// --- BANQUE LOCAL FALLBACK PAR CATEGORIE ---
const LOCAL_FALLBACK = {
  facile: ["CHAT", "SOLEIL", "MAISON", "POMME", "BALLON", "FLEUR", "AVION", "POISSON", "LIT", "ARBRE", "BANANE", "LUNE", "OISEAU", "GLACE", "PIZZA"],
  moyen: ["COURIR", "DANSER", "CUISINER", "SAUTER", "DORMIR", "CHANTER", "DESSINER", "NAGER", "CONDUIRE", "JOUER", "PEIGNER", "MANGER", "ECRIRE"],
  difficile: ["ASTRONAUTE", "SOUCOUPE VOLANTE", "LABYRINTHE", "PYRAMIDE", "MICROSCOPE", "CATHEDRALE", "EXCALIBUR", "METEORITE", "TRANSFORMER"]
};

// --- MACHINE À ÉTATS (STATE MACHINE) ---
const GAME_STATES = {
  LOBBY: 'LOBBY',
  WORD_SELECTION: 'WORD_SELECTION',
  DRAWING: 'DRAWING',
  PAUSED: 'PAUSED',
  ROUND_END: 'ROUND_END',
  GAME_OVER: 'GAME_OVER'
};

let gameState = GAME_STATES.LOBBY;
let previousStateBeforePause = GAME_STATES.LOBBY;

let usedWords = new Set();
let selectedDifficulty = "moyen";
let peer = null;
let connections = [];
let hostConn = null;
let isHost = false;
let myId = "";
let myName = "";
let roomCode = "";
let gameMode = "pvp";

let players = []; // { id, name, score, emoji, online, excluded }
let turnIndex = 0;
let currentRound = 1;
let maxRounds = 3;
let currentDrawerId = null;
let currentWord = "";
let currentWordChoices = []; 
let timerInterval = null;
let timeLeft = 60;
let previousLeaderboards = {};

// Historique des traits pour reconnexion
let currentStrokeHistory = []; 

let drawingGallery = [];
let galleryIndex = 0;
let galleryTimer = null;

let canvas, ctx, canvasTv, ctxTv;
let isDrawing = false;
let currentColor = '#000000';
let currentLineWidth = 3;

window.onload = () => {
  canvas = document.getElementById('paint-canvas');
  ctx = canvas.getContext('2d');
  
  canvasTv = document.getElementById('paint-canvas-tv');
  if (canvasTv) ctxTv = canvasTv.getContext('2d');

  const savedName = localStorage.getItem("sims2_draw_name");
  if (savedName) document.getElementById('player-name').value = savedName;

  const urlParams = new URLSearchParams(window.location.search);
  const urlCode = urlParams.get('code');
  if (urlCode) {
    document.getElementById('room-code-input').value = urlCode;
  }

  setupCanvasListeners();
};

function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(screenId).classList.add('active');
}

function toggleMenuDrawer() {
  document.getElementById('side-drawer').classList.toggle('open');
}

function saveProfile() {
  myName = document.getElementById('player-name').value.trim() || ("Sim_" + Math.floor(Math.random() * 1000));
  localStorage.setItem("sims2_draw_name", myName);
}

function triggerTvBanner(message) {
  const banner = document.getElementById('tv-banner');
  if (!banner) return;
  banner.innerText = message;
  banner.classList.add('show');
  setTimeout(() => { banner.classList.remove('show'); }, 4000);
}

async function fetchWordsFromAPI(difficulty) {
  try {
    if (difficulty === 'moyen') {
      const res = await fetch('https://trouve-mot.fr/api/categorie/15/3');
      if (res.ok) {
        const data = await res.json();
        return data.map(item => item.name.toUpperCase());
      }
    } else {
      const res = await fetch('https://trouve-mot.fr/api/random/3');
      if (res.ok) {
        const data = await res.json();
        return data.map(item => item.name.toUpperCase());
      }
    }
  } catch (e) {
    console.warn("Fallback local utilisé:", e);
  }
  const pool = LOCAL_FALLBACK[difficulty] || LOCAL_FALLBACK["facile"];
  return pool.filter(w => !usedWords.has(w)).sort(() => 0.5 - Math.random()).slice(0, 3);
}

function initPeer(customId = null, callback) {
  saveProfile();
  peer = customId ? new Peer(customId) : new Peer();

  peer.on('open', id => {
    myId = id;
    if (callback) callback(id);
  });

  peer.on('connection', conn => handleIncomingConnection(conn));
  peer.on('error', err => alert("Erreur réseau P2P: " + err.type));
}

function createRoom(mode) {
  gameMode = mode;
  selectedDifficulty = document.getElementById('difficulty-select').value;
  roomCode = Math.floor(1000 + Math.random() * 9000).toString();
  isHost = true;
  gameState = GAME_STATES.LOBBY;

  initPeer("sims2-draw-" + roomCode, () => {
    document.getElementById('display-room-code').innerText = roomCode;
    document.getElementById('display-difficulty').innerText = selectedDifficulty.toUpperCase();
    
    if (gameMode !== 'grand_ecran') {
      players.push({ id: myId, name: myName, score: 0, emoji: '', online: true, excluded: false });
      document.getElementById('btn-start-game').style.display = 'inline-block';
    } else {
      document.getElementById('app-window').classList.add('tv-fullscreen');
      document.getElementById('qr-container').style.display = 'block';
      document.getElementById('qrcode').innerHTML = "";
      
      const directUrl = `${window.location.origin}${window.location.pathname}?code=${roomCode}`;
      new QRCode(document.getElementById("qrcode"), { text: directUrl, width: 220, height: 220 });

      document.getElementById('qrcode-tv').innerHTML = "";
      new QRCode(document.getElementById("qrcode-tv"), { text: directUrl, width: 80, height: 80 });
      document.getElementById('tv-room-code-label').innerText = `Code: ${roomCode}`;
    }
    
    updateLobbyUI();
    showScreen('screen-lobby');
  });
}

function joinRoom() {
  const code = document.getElementById('room-code-input').value.trim();
  if (!code) return alert("Code requis !");
  roomCode = code;
  isHost = false;

  initPeer(null, () => {
    hostConn = peer.connect("sims2-draw-" + roomCode);
    hostConn.on('open', () => {
      document.getElementById('display-room-code').innerText = roomCode;
      showScreen('screen-lobby');
      hostConn.send({ type: 'JOIN', name: myName });
    });
    hostConn.on('data', data => handleDataClient(data));
  });
}

function handleIncomingConnection(conn) {
  connections.push(conn);

  conn.on('data', data => {
    if (!isHost) return;

    if (data.type === 'JOIN') {
      let existing = players.find(p => p.name.trim().toLowerCase() === data.name.trim().toLowerCase());
      
      if (existing && existing.excluded) {
        conn.send({ type: 'EXCLUDED_ERROR', message: "La partie continue sans vous pour ce match." });
        return;
      }

      if (existing) {
        const oldId = existing.id;
        existing.id = conn.peer;
        existing.online = true;

        if (oldId === currentDrawerId || existing.name === myName) {
          currentDrawerId = existing.id;
        }
        
        const drawer = players.find(p => p.id === currentDrawerId);

        conn.send({ 
          type: 'RECONNECT_SYNC', 
          state: { 
            players, currentRound, maxRounds, currentDrawerId, 
            drawerName: drawer ? drawer.name : existing.name,
            currentWord,
            wordChoices: currentWordChoices,
            selectedDifficulty, gameMode, timeLeft, 
            gameState: (gameState === GAME_STATES.PAUSED) ? previousStateBeforePause : gameState, 
            strokeHistory: currentStrokeHistory 
          } 
        });

        const offlineActive = players.filter(p => !p.online && !p.excluded).length;
        if (offlineActive === 0 && gameState === GAME_STATES.PAUSED) {
          resumeGameFromPause();
          
          if (previousStateBeforePause === GAME_STATES.WORD_SELECTION) {
            conn.send({ type: 'SELECT_WORD', words: currentWordChoices });
          }
          
          triggerTvBanner(`🟢 ${existing.name} est de retour ! Reprise !`);
        } else {
          triggerTvBanner(`🟢 ${existing.name} s'est reconnecté !`);
        }
      } else {
        if (gameState !== GAME_STATES.LOBBY) {
          conn.send({ type: 'EXCLUDED_ERROR', message: "Partie déjà commencée." });
          return;
        }
        players.push({ id: conn.peer, name: data.name, score: 0, emoji: '', online: true, excluded: false });
        triggerTvBanner(`👤 ${data.name} a rejoint le salon !`);
      }
      broadcastState();
    } else if (data.type === 'START_GAME_REQ') {
      startGame();
    } else if (data.type === 'TRIGGER_GALLERY_REQ') {
      startGalleryShow();
    } else if (data.type === 'WORD_CHOSEN') {
      // Ré-attribution automatique de l'ID dessinateur au joueur qui soumet le mot
      const senderPlayer = players.find(p => p.id === conn.peer || p.name === data.senderName);
      if (senderPlayer) {
        currentDrawerId = senderPlayer.id;
      }
      onWordChosen(data.word);
    } else if (data.type === 'REQUEST_REGEN_WORDS') {
      sendWordsToDrawer(conn.peer);
    } else if (data.type === 'EMOJI') {
      let p = players.find(p => p.id === conn.peer);
      if (p) {
        p.emoji = data.emoji;
        broadcastState();
        setTimeout(() => { p.emoji = ''; broadcastState(); }, 3000);
      }
    } else if (data.type === 'DRAW_LINE') {
      if (gameState === GAME_STATES.DRAWING) {
        currentStrokeHistory.push(data);
        broadcast('DRAW_LINE', data, conn.peer);
        drawNormalized(data.x0, data.y0, data.x1, data.y1, data.color, data.width);
      }
    } else if (data.type === 'CHAT') {
      broadcast('CHAT', { sender: data.sender, text: data.text });
      addChatMessage(data.sender, data.text);
    } else if (data.type === 'CLAIM_WINNER') {
      awardPointsAndEndTurn(data.winnerId);
    } else if (data.type === 'CLEAR') {
      currentStrokeHistory = [];
      clearCanvas(false);
      broadcast('CLEAR', {}, conn.peer);
    } else if (data.type === 'PAUSE_DECISION') {
      if (!data.shouldWait) {
        excludeDisconnectedPlayers();
      }
    }
  });

  conn.on('close', () => {
    if (!isHost) return;
    let disconnectedPlayer = players.find(p => p.id === conn.peer);
    if (disconnectedPlayer && !disconnectedPlayer.excluded) {
      disconnectedPlayer.online = false;
      
      if (gameState !== GAME_STATES.LOBBY && gameState !== GAME_STATES.GAME_OVER) {
        pauseGame(`⚠️ ${disconnectedPlayer.name} s'est déconnecté !`);
      }
      
      broadcastState();

      const activePlayers = players.filter(p => p.online && !p.excluded);
      if (activePlayers.length > 0 && gameState === GAME_STATES.PAUSED) {
        const leader = activePlayers[0];
        if (leader.id === myId) {
          showDisconnectModal(disconnectedPlayer.name);
        } else {
          const leaderConn = connections.find(c => c.peer === leader.id);
          if (leaderConn) leaderConn.send({ type: 'PLAYER_DISCONNECTED_ALERT', name: disconnectedPlayer.name });
        }
      }
    }
  });
}

function broadcast(type, payload, excludePeerId = null) {
  connections.forEach(conn => {
    if (conn.open && conn.peer !== excludePeerId) conn.send({ type, ...payload });
  });
}

function broadcastState() {
  if (!isHost) return;
  const state = { players, currentRound, maxRounds, currentDrawerId, selectedDifficulty, gameMode, gameState };
  broadcast('STATE', state);
  updateLobbyUI();
  updateGamePlayersUI();
}

function sendEmoji(emoji) {
  if (isHost) {
    let p = players.find(p => p.id === myId);
    if (p) {
      p.emoji = emoji;
      broadcastState();
      setTimeout(() => { p.emoji = ''; broadcastState(); }, 3000);
    }
  } else if (hostConn) {
    hostConn.send({ type: 'EMOJI', emoji });
  }
}

function handleDataClient(data) {
  if (data.type === 'EXCLUDED_ERROR') {
    alert(data.message);
    showScreen('screen-menu');
    return;
  }

  if (data.type === 'STATE') {
    players = data.players;
    currentRound = data.currentRound;
    currentDrawerId = data.currentDrawerId;
    selectedDifficulty = data.selectedDifficulty || "moyen";
    gameMode = data.gameMode || "pvp";
    gameState = data.gameState;

    const startBtn = document.getElementById('btn-start-game');
    const activePlayers = players.filter(p => p.online && !p.excluded);
    
    if (activePlayers.length > 0 && activePlayers[0].id === myId && gameState === GAME_STATES.LOBBY) {
      startBtn.style.display = 'inline-block';
    } else if (!isHost) {
      startBtn.style.display = 'none';
    }

    document.getElementById('display-difficulty').innerText = selectedDifficulty.toUpperCase();
    document.getElementById('game-round').innerText = `${currentRound}/${maxRounds}`;
    updateLobbyUI();
    updateGamePlayersUI();
  } else if (data.type === 'RECONNECT_SYNC') {
    players = data.state.players;
    currentRound = data.state.currentRound;
    currentDrawerId = data.state.currentDrawerId;
    gameMode = data.state.gameMode;
    timeLeft = data.state.timeLeft;
    gameState = data.state.gameState;
    currentWord = data.state.currentWord;
    currentWordChoices = data.state.wordChoices || [];
    
    showScreen('screen-game');
    setupTurnUI(data.state.drawerName, currentWord ? currentWord.length : 5);

    clearCanvas(false);
    if (data.state.strokeHistory) {
      data.state.strokeHistory.forEach(s => {
        drawNormalized(s.x0, s.y0, s.x1, s.y1, s.color, s.width);
      });
    }

    const isMeDrawer = (myId === currentDrawerId) || (data.state.drawerName === myName);
    if (isMeDrawer && gameState === GAME_STATES.WORD_SELECTION && currentWordChoices.length > 0) {
      setTimeout(() => {
        showWordModal(currentWordChoices);
      }, 100);
    }
  } else if (data.type === 'START_GAME') {
    showScreen('screen-game');
    if (gameMode === 'grand_ecran' && isHost) {
      document.getElementById('standard-game-layout').style.display = 'none';
      document.getElementById('tv-game-layout').style.display = 'grid';
      document.getElementById('btn-toggle-chat').style.display = 'none';
    }
  } else if (data.type === 'SELECT_WORD') {
    showWordModal(data.words);
  } else if (data.type === 'NEW_TURN') {
    currentDrawerId = data.drawerId;
    gameState = data.gameState || GAME_STATES.DRAWING;
    setupTurnUI(data.drawerName, data.wordLength);
    if (isHost) triggerTvBanner(`🎨 C'est au tour de ${data.drawerName} !`);
  } else if (data.type === 'DRAW_LINE') {
    drawNormalized(data.x0, data.y0, data.x1, data.y1, data.color, data.width);
  } else if (data.type === 'CLEAR') {
    clearCanvas(false);
  } else if (data.type === 'CHAT') {
    addChatMessage(data.sender, data.text, data.isCorrect);
  } else if (data.type === 'TIMER') {
    updateTimerUI(data.timeLeft);
  } else if (data.type === 'GAME_OVER') {
    showGameOverModal(data.scores);
  } else if (data.type === 'START_GALLERY') {
    drawingGallery = data.gallery;
    startGalleryShow();
  } else if (data.type === 'PLAYER_DISCONNECTED_ALERT') {
    showDisconnectModal(data.name);
  } else if (data.type === 'RESUME_GAME') {
    gameState = data.gameState;
    document.getElementById('disconnect-modal').classList.remove('active');
    
    const drawer = players.find(p => p.id === currentDrawerId);
    const drawerName = drawer ? drawer.name : "le dessinateur";
    
    setupTurnUI(drawerName, currentWord ? currentWord.length : 5);

    if (gameState === GAME_STATES.WORD_SELECTION) {
      document.getElementById('role-indicator').innerText = (myId === currentDrawerId || drawerName === myName) ? "À VOUS DE DESSINER !" : `Dessinateur : ${drawerName} (Choix du mot...)`;
      addChatMessage('SYSTEME', `▶️ Reprise ! ${drawerName} choisit son mot.`, false);
    } else {
      addChatMessage('SYSTEME', `▶️ Reprise de la partie ! C'est à ${drawerName} de dessiner !`, false);
    }
  }
}

function pauseGame(bannerMsg) {
  if (gameState === GAME_STATES.PAUSED) return;
  previousStateBeforePause = gameState;
  gameState = GAME_STATES.PAUSED;
  clearInterval(timerInterval);
  triggerTvBanner(bannerMsg);
}

function resumeGameFromPause() {
  gameState = previousStateBeforePause;
  document.getElementById('disconnect-modal').classList.remove('active');
  
  if (isHost) {
    broadcast('RESUME_GAME', { gameState });
    if (gameState === GAME_STATES.DRAWING) {
      startTimer(false); 
    } else if (gameState === GAME_STATES.WORD_SELECTION) {
      const conn = connections.find(c => c.peer === currentDrawerId);
      if (conn) conn.send({ type: 'SELECT_WORD', words: currentWordChoices });
      else if (currentDrawerId === myId || players.find(p => p.id === currentDrawerId)?.name === myName) {
        showWordModal(currentWordChoices);
      }
    }
  }
}

function excludeDisconnectedPlayers() {
  players.forEach(p => {
    if (!p.online) p.excluded = true;
  });
  
  const currentDrawer = players.find(p => p.id === currentDrawerId);
  if (currentDrawer && currentDrawer.excluded) {
    triggerTvBanner(`⏭️ Le dessinateur a été exclu. Passage au tour suivant...`);
    resumeGameFromPause();
    endTurn();
  } else {
    resumeGameFromPause();
  }
  broadcastState();
}

function showDisconnectModal(playerName) {
  document.getElementById('disconnect-modal-text').innerText = `${playerName} a perdu la connexion !`;
  document.getElementById('disconnect-modal').classList.add('active');
}

function decisionWaitPlayer(shouldWait) {
  document.getElementById('disconnect-modal').classList.remove('active');
  if (isHost) {
    if (!shouldWait) excludeDisconnectedPlayers();
  } else if (hostConn) {
    hostConn.send({ type: 'PAUSE_DECISION', shouldWait });
  }
}

function updateLobbyUI() {
  const list = document.getElementById('lobby-player-list');
  if (!list) return;
  list.innerHTML = '';
  players.filter(p => !p.excluded).forEach((p, index) => {
    const isLeader = (index === 0);
    const div = document.createElement('div');
    div.className = 'player-card';
    div.style.opacity = p.online ? '1' : '0.4';
    div.innerHTML = `<span>👤 <b>${p.name}</b> ${isLeader ? '<small style="color:var(--sims-yellow); font-weight:bold;">(Chef)</small>' : ''} ${!p.online ? '<small>(Hors-ligne)</small>' : ''}</span>${p.emoji ? `<span class="emoji-bubble">${p.emoji}</span>` : ''}`;
    list.appendChild(div);
  });
}

function updateGamePlayersUI() {
  const list = document.getElementById('game-player-list');
  const tvLeaderboard = document.getElementById('tv-player-leaderboard');
  const activePlayers = players.filter(p => !p.excluded);
  const sorted = [...activePlayers].sort((a,b) => b.score - a.score);

  sorted.forEach((p, rank) => {
    if (previousLeaderboards[p.name] !== undefined && previousLeaderboards[p.name] > rank) {
      if (isHost && rank === 0) triggerTvBanner(`🚀 ${p.name} prend la 1ère place !`);
    }
    previousLeaderboards[p.name] = rank;
  });

  if (list) {
    list.innerHTML = '';
    sorted.forEach((p, rank) => {
      const isDrawer = (p.id === currentDrawerId || p.name === myName && myId === currentDrawerId);
      const div = document.createElement('div');
      div.className = 'player-card' + (isDrawer ? ' is-drawer' : '');
      div.style.opacity = p.online ? '1' : '0.4';
      div.innerHTML = `<div><div>#${rank + 1} ${isDrawer ? '✏️' : '👤'} <b>${p.name}</b></div><small style="color:var(--sims-yellow);">${p.score} pts</small></div>${p.emoji ? `<span class="emoji-bubble">${p.emoji}</span>` : ''}`;
      list.appendChild(div);
      if (p.id === myId) document.getElementById('my-score').innerText = p.score;
    });
  }

  if (tvLeaderboard) {
    tvLeaderboard.innerHTML = '';
    sorted.forEach((p, rank) => {
      const isDrawer = (p.id === currentDrawerId);
      const div = document.createElement('div');
      div.className = 'player-card' + (isDrawer ? ' is-drawer' : '');
      div.style.opacity = p.online ? '1' : '0.4';
      div.innerHTML = `<div><div>#${rank + 1} ${isDrawer ? '✏️' : '👤'} <b>${p.name}</b></div><small style="color:var(--sims-yellow);">${p.score} pts</small></div>${p.emoji ? `<span class="emoji-bubble">${p.emoji}</span>` : ''}`;
      tvLeaderboard.appendChild(div);
    });
  }

  document.getElementById('game-round').innerText = `${currentRound}/${maxRounds}`;
}

function startGame() {
  if (!isHost) {
    hostConn.send({ type: 'START_GAME_REQ' });
    return;
  }
  const validPlayers = players.filter(p => p.online && !p.excluded);
  if (validPlayers.length === 0) return alert("Attendez au moins 1 joueur !");
  
  gameState = GAME_STATES.WORD_SELECTION;
  turnIndex = 0;
  currentRound = 1;
  drawingGallery = [];
  
  broadcast('START_GAME', {});
  showScreen('screen-game');

  if (gameMode === 'grand_ecran' && isHost) {
    document.getElementById('standard-game-layout').style.display = 'none';
    document.getElementById('tv-game-layout').style.display = 'grid';
    document.getElementById('btn-toggle-chat').style.display = 'none';
  }

  startTurn();
}

async function sendWordsToDrawer(targetPeerId) {
  gameState = GAME_STATES.WORD_SELECTION;
  const choices = await fetchWordsFromAPI(selectedDifficulty);
  currentWordChoices = choices;
  currentWord = ""; 

  if (targetPeerId === myId) {
    showWordModal(choices);
  } else {
    const conn = connections.find(c => c.peer === targetPeerId);
    if (conn) conn.send({ type: 'SELECT_WORD', words: choices });
  }
}

function startTurn() {
  clearCanvas(true);
  currentStrokeHistory = [];
  const activePlayers = players.filter(p => p.online && !p.excluded);
  if (activePlayers.length === 0) return;

  const drawer = activePlayers[turnIndex % activePlayers.length];
  currentDrawerId = drawer.id;

  sendWordsToDrawer(currentDrawerId);
  broadcastState();
}

function requestNewWords() {
  if (isHost) {
    sendWordsToDrawer(myId);
  } else if (hostConn) {
    hostConn.send({ type: 'REQUEST_REGEN_WORDS' });
  }
}

function onWordChosen(word) {
  document.getElementById('word-modal').classList.remove('active');
  currentWord = word;
  usedWords.add(word);

  if (!isHost) {
    hostConn.send({ type: 'WORD_CHOSEN', word, senderName: myName });
    return;
  }

  gameState = GAME_STATES.DRAWING;
  const drawer = players.find(p => p.id === currentDrawerId);
  const payload = {
    type: 'NEW_TURN',
    drawerId: currentDrawerId,
    drawerName: drawer ? drawer.name : myName,
    wordLength: word.length,
    gameState: GAME_STATES.DRAWING
  };

  broadcast('NEW_TURN', payload);
  handleDataClient(payload);
  startTimer(true);
}

function startTimer(resetTime = true) {
  clearInterval(timerInterval);
  if (resetTime) timeLeft = 60;
  updateTimerUI(timeLeft);

  timerInterval = setInterval(() => {
    if (gameState === GAME_STATES.PAUSED) return;

    timeLeft--;
    broadcast('TIMER', { timeLeft });
    updateTimerUI(timeLeft);

    if (timeLeft <= 0) {
      clearInterval(timerInterval);
      if (myId === currentDrawerId || isCurrentDrawer()) openWinnerSelectionModal(true);
    }
  }, 1000);
}

function updateTimerUI(seconds) {
  document.getElementById('timer-text').innerText = seconds;
  const circle = document.getElementById('timer-circle-progress');
  if (circle) circle.style.strokeDashoffset = 100 - (seconds / 60 * 100);
}

function openWinnerSelectionModal(isTimeOut = false) {
  const container = document.getElementById('winner-candidates');
  document.getElementById('winner-modal-title').innerText = isTimeOut ? "⏰ Temps Écoulé !" : "✨ Qui a deviné ?";
  container.innerHTML = '';

  players.filter(p => p.id !== currentDrawerId && p.name !== myName && p.online && !p.excluded).forEach(p => {
    const btn = document.createElement('button');
    btn.className = 'sims-btn sims-btn-green';
    btn.innerText = `🏆 ${p.name}`;
    btn.onclick = () => selectWinner(p.id);
    container.appendChild(btn);
  });

  const noneBtn = document.createElement('button');
  noneBtn.className = 'sims-btn sims-btn-pink';
  noneBtn.innerText = '❌ Personne / Aucun Gagnant';
  noneBtn.onclick = () => selectWinner(null);
  container.appendChild(noneBtn);

  document.getElementById('winner-modal').classList.add('active');
}

function selectWinner(winnerId) {
  document.getElementById('winner-modal').classList.remove('active');
  if (isHost) awardPointsAndEndTurn(winnerId);
  else if (hostConn) hostConn.send({ type: 'CLAIM_WINNER', winnerId });
}

function awardPointsAndEndTurn(winnerId) {
  clearInterval(timerInterval);
  gameState = GAME_STATES.ROUND_END;
  
  const drawer = players.find(p => p.id === currentDrawerId);
  const winner = players.find(p => p.id === winnerId);

  const activeCanvas = (gameMode === 'grand_ecran' && canvasTv) ? canvasTv : canvas;
  const drawingData = activeCanvas.toDataURL("image/png");

  drawingGallery.push({
    imageData: drawingData,
    drawerName: drawer ? drawer.name : "Anonyme",
    word: currentWord,
    winnerName: winner ? winner.name : "Personne"
  });

  if (winnerId) {
    const earned = Math.max(100, timeLeft * 10);
    if (winner) winner.score += earned;
    if (drawer) drawer.score += earned;

    const msg = `🎉 ${winner ? winner.name : 'Un joueur'} a deviné ! (+${earned} pts)`;
    broadcast('CHAT', { sender: 'SYSTEME', text: msg, isCorrect: true });
    addChatMessage('SYSTEME', msg, true);
  } else {
    const msg = `⌛ Fin du tour ! Le mot était : ${currentWord}`;
    broadcast('CHAT', { sender: 'SYSTEME', text: msg, isCorrect: false });
    addChatMessage('SYSTEME', msg, false);
  }

  broadcastState();
  setTimeout(endTurn, 3000);
}

function endTurn() {
  turnIndex++;
  const activePlayers = players.filter(p => p.online && !p.excluded);
  
  if (activePlayers.length > 0 && turnIndex % activePlayers.length === 0) {
    currentRound++;
  }

  if (currentRound > maxRounds) {
    gameState = GAME_STATES.GAME_OVER;
    const sorted = [...players].sort((a,b) => b.score - a.score);
    if (isHost) {
      broadcast('GAME_OVER', { scores: sorted });
    }
    showGameOverModal(sorted);
  } else {
    startTurn();
  }
}

function showGameOverModal(sortedPlayers) {
  const container = document.getElementById('final-scores-list');
  container.innerHTML = '';
  sortedPlayers.filter(p => !p.excluded).forEach((p, idx) => {
    const medal = idx === 0 ? '🥇' : (idx === 1 ? '🥈' : (idx === 2 ? '🥉' : '👤'));
    const div = document.createElement('div');
    div.className = 'player-card';
    div.innerHTML = `<span>${medal} <b>${p.name}</b></span> <b style="color:var(--sims-yellow);">${p.score} pts</b>`;
    container.appendChild(div);
  });
  document.getElementById('gameover-modal').classList.add('active');

  setTimeout(() => {
    startGalleryShow();
  }, 4000);
}

function triggerGalleryFromLeader() {
  if (isHost) {
    startGalleryShow();
  } else if (hostConn) {
    hostConn.send({ type: 'TRIGGER_GALLERY_REQ' });
    startGalleryShow();
  }
}

function startGalleryShow() {
  document.getElementById('gameover-modal').classList.remove('active');
  showScreen('screen-gallery');

  if (isHost) {
    broadcast('START_GALLERY', { gallery: drawingGallery });
  }

  galleryIndex = 0;
  if (drawingGallery.length === 0) return;

  renderGallerySlide();
  clearInterval(galleryTimer);
  galleryTimer = setInterval(() => {
    galleryIndex = (galleryIndex + 1) % drawingGallery.length;
    renderGallerySlide();
  }, 4000);
}

function renderGallerySlide() {
  const item = drawingGallery[galleryIndex];
  if (!item) return;

  const card = document.getElementById('gallery-card');
  card.style.animation = 'none';
  card.offsetHeight;
  card.style.animation = 'fadeIn 0.5s ease-in-out';

  document.getElementById('gallery-title').innerText = `🎨 "${item.word}"`;
  document.getElementById('gallery-author').innerText = `Dessiné par : ${item.drawerName}`;
  document.getElementById('gallery-img').src = item.imageData;
  document.getElementById('gallery-winner').innerText = `Deviné par : ${item.winnerName}`;
}

function setupTurnUI(drawerName, wordLength) {
  const drawerPlayer = players.find(p => p.id === currentDrawerId);
  const isDrawer = (myId === currentDrawerId) || (drawerName === myName) || (drawerPlayer && drawerPlayer.name === myName);
  
  document.getElementById('role-indicator').innerText = isDrawer ? `À VOUS DE DESSINER !` : `Dessinateur : ${drawerName}`;
  document.getElementById('drawing-tools').style.display = isDrawer ? 'flex' : 'none';
  document.getElementById('guess-input').disabled = isDrawer;
  updateGamePlayersUI();
}

function isCurrentDrawer() {
  const drawerPlayer = players.find(p => p.id === currentDrawerId);
  return (myId === currentDrawerId) || (drawerPlayer && drawerPlayer.name === myName);
}

function setupCanvasListeners() {
  let lastNormX = 0, lastNormY = 0;

  const getNormalizedPos = e => {
    const activeCanvas = (gameMode === 'grand_ecran' && isHost) ? canvasTv : canvas;
    const rect = activeCanvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return {
      x: Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (clientY - rect.top) / rect.height))
    };
  };

  const startDrawing = e => {
    if (!isCurrentDrawer() || gameState !== GAME_STATES.DRAWING) return;

    isDrawing = true;
    const pos = getNormalizedPos(e);
    lastNormX = pos.x; lastNormY = pos.y;
  };

  const draw = e => {
    if (!isDrawing || !isCurrentDrawer() || gameState !== GAME_STATES.DRAWING) return;
    const pos = getNormalizedPos(e);

    const strokeData = { type: 'DRAW_LINE', x0: lastNormX, y0: lastNormY, x1: pos.x, y1: pos.y, color: currentColor, width: currentLineWidth };
    
    if (isHost) {
      currentStrokeHistory.push(strokeData);
      broadcast('DRAW_LINE', strokeData);
    } else if (hostConn) {
      hostConn.send(strokeData);
    }

    drawNormalized(lastNormX, lastNormY, pos.x, pos.y, currentColor, currentLineWidth);

    lastNormX = pos.x; lastNormY = pos.y;
  };

  const stopDrawing = () => { isDrawing = false; };

  canvas.addEventListener('mousedown', startDrawing);
  canvas.addEventListener('mousemove', draw);
  canvas.addEventListener('mouseup', stopDrawing);

  canvas.addEventListener('touchstart', startDrawing);
  canvas.addEventListener('touchmove', draw);
  canvas.addEventListener('touchend', stopDrawing);
}

function drawNormalized(nx0, ny0, nx1, ny1, color, width) {
  const drawOnCtx = (c) => {
    c.beginPath();
    c.moveTo(nx0 * 600, ny0 * 600);
    c.lineTo(nx1 * 600, ny1 * 600);
    c.strokeStyle = color;
    c.lineWidth = width;
    c.lineCap = 'round';
    c.stroke();
    c.closePath();
  };

  drawOnCtx(ctx);
  if (ctxTv) drawOnCtx(ctxTv);
}

function clearCanvas(notify = true) {
  ctx.clearRect(0, 0, 600, 600);
  if (ctxTv) ctxTv.clearRect(0, 0, 600, 600);

  if (notify) {
    currentStrokeHistory = [];
    if (isHost) broadcast('CLEAR', {});
    else if (hostConn) hostConn.send({ type: 'CLEAR' });
  }
}

function setColor(color, el) {
  currentColor = color;
  document.querySelectorAll('.color-dot').forEach(d => d.classList.remove('active'));
  if(el) el.classList.add('active');
}

function setBrushSize(size) { currentLineWidth = size; }

function showWordModal(words) {
  const container = document.getElementById('word-options');
  container.innerHTML = '';
  words.forEach(w => {
    const btn = document.createElement('button');
    btn.className = 'sims-btn sims-btn-yellow';
    btn.innerText = w;
    btn.onclick = () => onWordChosen(w);
    container.appendChild(btn);
  });
  document.getElementById('word-modal').classList.add('active');
}

function sendGuess() {
  const input = document.getElementById('guess-input');
  const text = input.value.trim();
  if (!text || isCurrentDrawer()) return;

  if (isHost) {
    broadcast('CHAT', { sender: myName, text });
    addChatMessage(myName, text);
  } else if (hostConn) {
    hostConn.send({ type: 'CHAT', sender: myName, text });
  }
  input.value = '';
}

function addChatMessage(sender, text, isCorrect = false) {
  const boxes = [document.getElementById('chat-box'), document.getElementById('tv-chat-box')];
  boxes.forEach(box => {
    if (!box) return;
    const div = document.createElement('div');
    div.className = 'chat-msg' + (isCorrect ? ' correct' : (sender === 'SYSTEME' ? ' system' : ''));
    div.innerHTML = `<b>${sender}:</b> ${text}`;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
  });
}
