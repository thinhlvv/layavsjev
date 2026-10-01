// Main - Flappy Bird AI Battle with shared map

document.addEventListener('DOMContentLoaded', () => {
  const canvasJev = document.getElementById('canvas-jev');
  const canvasLaya = document.getElementById('canvas-laya');
  const scoreJevEl = document.getElementById('score-jev');
  const scoreLayaEl = document.getElementById('score-laya');
  const statusJevEl = document.getElementById('status-jev');
  const statusLayaEl = document.getElementById('status-laya');
  const latJevEl = document.getElementById('latency-jev');
  const latLayaEl = document.getElementById('latency-laya');
  const btnRestart = document.getElementById('btn-restart');
  const btnPause = document.getElementById('btn-pause');
  const chkHeuristic = document.getElementById('chk-heuristic');

  // Shared pipe state - both games see the same map
  const sharedState = { pipes: [] };

  const W = 300, H = 450;
  const pipeWidth = 52;
  const pipeGap = 170;
  const pipeSpacing = 220;
  const pipeSpeed = 1.2;

  // Seeded RNG for deterministic pipe generation
  let seed = Date.now();
  function seededRandom() {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  }

  function generatePipe() {
    const gapY = 80 + seededRandom() * (H - pipeGap - 160);
    sharedState.pipes.push({ x: W, gapY });
  }

  // Create games
  const gameJev = new FlappyBird(canvasJev, 'jev', sharedState);
  const gameLaya = new FlappyBird(canvasLaya, 'laya', sharedState);

  // Create AIs, seeded with each backend's typical observed latency (jev:
  // real network/model round-trip, usually 300ms-1.9s; laya: local model,
  // usually <150ms) so the very first requests already project a sane
  // amount forward instead of assuming zero latency.
  const aiJev = new AIController('jev', 900);
  const aiLaya = new AIController('laya', 120);

  let paused = false;
  let frameCount = 0;

  function updateUI() {
    scoreJevEl.textContent = gameJev.score;
    scoreLayaEl.textContent = gameLaya.score;
    statusJevEl.textContent = gameJev.gameOver ? '💀 Dead' : '▶ Playing';
    statusJevEl.style.color = gameJev.gameOver ? '#e94560' : '#4ade80';
    statusLayaEl.textContent = gameLaya.gameOver ? '💀 Dead' : '▶ Playing';
    statusLayaEl.style.color = gameLaya.gameOver ? '#e94560' : '#4ade80';
    if (USE_LOCAL_HEURISTIC) {
      latJevEl.textContent = 'jev: local heuristic';
      latLayaEl.textContent = 'laya: local heuristic';
    } else {
      if (aiJev.latency) latJevEl.textContent = `jev: ${aiJev.latency}ms`;
      if (aiLaya.latency) latLayaEl.textContent = `laya: ${aiLaya.latency}ms`;
    }
  }

  // Neither backend self-regulates flap frequency (laya in particular will
  // answer "flap" on nearly every query). A fixed-tick cooldown isn't enough
  // to stop runaway climbing: a single flap takes ~25 physics ticks to decay
  // back to vy=0, so any cooldown shorter than that still lets a new flap
  // land mid-rise and compound upward indefinitely. Instead, only honor a
  // flap once the bird has stopped rising (vy >= 0) — physically identical
  // to a real player who can't flap again until they're already falling.
  // Keep a pending flap decision queued until the bird actually stops rising,
  // instead of discarding it the moment it's checked. Dropping it here meant
  // a valid decision (especially from jev, whose round-trip is slow enough
  // that the bird's rise/fall state has often moved on by the time it
  // arrives) was silently thrown away instead of applied on the next frame
  // it became actionable.
  function tryFlap(game, ai) {
    if (!ai.lastFlap) return;
    if (game.bird.vy >= 0) {
      ai.lastFlap = false;
      game.flap();
    }
  }

  async function gameLoop() {
    if (!paused) {
      frameCount++;
      const runPhysics = frameCount % PHYSICS_SLOWDOWN === 0;

      // Shared pipe generation
      const lastPipe = sharedState.pipes[sharedState.pipes.length - 1];
      if (!lastPipe || lastPipe.x < W - pipeSpacing) {
        generatePipe();
      }

      // AI decisions. Only issue a new request once per physics tick — state
      // doesn't change between ticks, so polling every animation frame would
      // just burn through the in-flight budget on identical questions. The
      // local emergency check still runs every frame regardless of whether a
      // decision request is in flight — the AI's own request only reaches
      // the server-side safety net at the *start* of a round-trip, which is
      // no help while that round-trip (up to ~3.8s for jev) is still pending
      // and the bird keeps falling in real time.
      if (!gameJev.gameOver) {
        if (runPhysics) aiJev.decide(gameJev);
        const forcedJev = localEmergencyOverride(gameJev);
        if (forcedJev === true) gameJev.flap();
        else if (forcedJev !== false) tryFlap(gameJev, aiJev);
      }
      if (!gameLaya.gameOver) {
        if (runPhysics) aiLaya.decide(gameLaya);
        const forcedLaya = localEmergencyOverride(gameLaya);
        if (forcedLaya === true) gameLaya.flap();
        else if (forcedLaya !== false) tryFlap(gameLaya, aiLaya);
      }

      if (runPhysics) {
        gameJev.update();
        gameLaya.update();
      }
    }

    gameJev.draw();
    gameLaya.draw();
    updateUI();

    requestAnimationFrame(gameLoop);
  }

  function restart() {
    seed = Date.now();
    sharedState.pipes = [];
    gameJev.init();
    gameLaya.init();
  }

  chkHeuristic.addEventListener('change', () => {
    USE_LOCAL_HEURISTIC = chkHeuristic.checked;
  });

  btnRestart.addEventListener('click', restart);
  btnPause.addEventListener('click', () => {
    paused = !paused;
    btnPause.textContent = paused ? 'Resume' : 'Pause';
  });
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space') { e.preventDefault(); restart(); }
    if (e.code === 'KeyP') { paused = !paused; btnPause.textContent = paused ? 'Resume' : 'Pause'; }
  });

  gameLoop();
});
