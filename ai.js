// AI integration - WebSocket-based, no REST fallback

let ws = null;
let wsReady = false;
// Keyed by request id: several requests per AI can be in flight, and a single
// slot per AI let each new request overwrite the previous one's callback, so
// answers were applied to the wrong request or dropped.
const pendingCallbacks = new Map();
let nextRequestId = 0;

function connectWS() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}`);

  ws.onopen = () => { wsReady = true; console.log('[ws] connected'); };
  ws.onclose = () => {
    wsReady = false;
    console.log('[ws] disconnected');
    for (const cb of pendingCallbacks.values()) cb({ shouldFlap: false, confidence: 0, model: 'offline' });
    pendingCallbacks.clear();
    setTimeout(connectWS, 1000);
  };
  ws.onerror = () => { wsReady = false; };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'decision') {
      const cb = pendingCallbacks.get(msg.id);
      if (cb) {
        pendingCallbacks.delete(msg.id);
        cb(msg);
      }
    }
  };
}
connectWS();

function decideWS(ai, state) {
  return new Promise((resolve) => {
    if (!wsReady || ws.readyState !== WebSocket.OPEN) {
      resolve({ shouldFlap: false, confidence: 0, model: `${ai}-offline` });
      return;
    }
    const id = ++nextRequestId;
    pendingCallbacks.set(id, resolve);
    ws.send(JSON.stringify({ type: 'decide', ai, state, id }));
  });
}

// Physics only advances every PHYSICS_SLOWDOWN animation frames (~16.67ms
// each), so decisions get real wall-clock time to land before gravity
// outpaces them. main.js reuses this same constant for its physics gate —
// defined once here since ai.js needs it for latency projection too.
const PHYSICS_SLOWDOWN = 3;
const MS_PER_PHYSICS_TICK = PHYSICS_SLOWDOWN * (1000 / 60);

// Project the bird forward as if it free-falls (no flap) for `latencyMs` of
// wall-clock time. Used to compensate for the AI's own round-trip: a slow
// decision (jev has been observed up to ~3.8s, one 12.6s outlier) is being
// asked about a game state that will be stale by the time it arrives, so we
// hand it the state as it will actually look when the decision lands
// instead of the state at the moment of asking.
function projectForward(bird, pipeDist, pipeSpeed, latencyMs) {
  const ticks = Math.max(0, Math.round(latencyMs / MS_PER_PHYSICS_TICK));
  let y = bird.y, vy = bird.vy;
  for (let i = 0; i < ticks; i++) {
    vy += bird.gravity;
    y += vy;
  }
  const dist = Math.max(1, pipeDist - pipeSpeed * ticks);
  return { y, vy, dist };
}

// Hover formula: flap whenever the next tick would drop the bird's BOTTOM EDGE
// below a line HOVER_CLEARANCE px above the gap bottom. A flap (vy=-5, gravity
// 0.2) rises ~62px, so the bird's body (26px tall) sweeps ~88px of the 170px
// gap; 40px clearance centers that sweep. Safe range in simulation: 0–75
// (80+ lets the top of the bob hit the upper pipe). Also sent to the server,
// which quotes it in the models' instructions — change it only here.
// The line tracks the pipe the bird's hitbox (34px wide) still overlaps, not
// getNextPipe(): switching to the next gap as soon as the bird's center clears
// a pipe let it drop into the old pipe's lower half.
const HOVER_CLEARANCE = 45;

function hoverLineY(game, ticksAhead) {
  const bird = game.bird, shift = game.pipeSpeed * ticksAhead;
  const pipe = game.shared.pipes.find(p => p.x - shift + game.pipeWidth > bird.x - bird.w / 2);
  return pipe ? pipe.gapY + game.pipeGap - HOVER_CLEARANCE : null;
}

function nextBottomY(bird, y, vy) {
  return y + vy + bird.gravity + bird.h / 2;
}

function getState(game, latencyEstimateMs = 0) {
  const bird = game.bird;
  const pipe = game.getNextPipe();
  if (!pipe) return null;

  const gapCenter = pipe.gapY + game.pipeGap / 2;
  const gapTop = pipe.gapY;
  const gapBottom = pipe.gapY + game.pipeGap;
  const nextPipe = game.shared.pipes.length > 1 ? game.shared.pipes[1] : null;

  const proj = projectForward(bird, pipe.x - bird.x, game.pipeSpeed, latencyEstimateMs);
  const projRelativeY = proj.y - gapCenter;
  const lineY = hoverLineY(game, Math.round(latencyEstimateMs / MS_PER_PHYSICS_TICK));
  const bottomY = nextBottomY(bird, proj.y, proj.vy);

  return {
    pxBelowFloorNextTick: Math.round(bottomY - lineY),
    belowFloorNextTick: bottomY > lineY,
    hoverClearance: HOVER_CLEARANCE,
    birdX: Math.round(bird.x),
    birdY: Math.round(proj.y),
    birdVY: Math.round(proj.vy * 100) / 100,
    birdGravity: bird.gravity,
    gapTop: Math.round(gapTop),
    gapBottom: Math.round(gapBottom),
    gapCenter: Math.round(gapCenter),
    gapSize: game.pipeGap,
    distToPipe: Math.round(proj.dist),
    relativeY: Math.round(projRelativeY),
    aboveGap: proj.y < gapCenter,
    belowGap: proj.y > gapCenter,
    inGap: proj.y > gapTop && proj.y < gapBottom,
    nearGround: proj.y > game.groundY - 150,
    nearCeiling: proj.y < 80,
    groundY: game.groundY,
    canvasH: game.H,
    pipeSpeed: game.pipeSpeed,
    nextPipeDist: nextPipe ? Math.round(nextPipe.x - bird.x - game.pipeSpeed * Math.round(latencyEstimateMs / MS_PER_PHYSICS_TICK)) : null,
    nextGapCenter: nextPipe ? Math.round(nextPipe.gapY + game.pipeGap / 2) : null,
    score: game.score,
    projectedAheadMs: Math.round(latencyEstimateMs)
  };
}

// Flag to bypass the WebSocket/AI round-trip entirely and drive both birds
// off a deterministic local calculation instead. Toggled live from the
// checkbox wired up in main.js. Kept as a plain top-level `let` (not
// `window.X`) to match the sharing pattern already used for
// PHYSICS_SLOWDOWN: classic <script> tags loaded in the same page share one
// top-level lexical scope, so main.js can read and flip this directly.
let USE_LOCAL_HEURISTIC = false;

function localHeuristic(game) {
  const bird = game.bird;
  const lineY = hoverLineY(game, 0);
  if (lineY === null) return false;
  return nextBottomY(bird, bird.y, bird.vy) > lineY;
}

// Mirrors the server's `emergency_override`: a hard safety net independent
// of model confidence for genuine near-death positions. Exposed here so
// main.js can poll it every frame — the server-side version only runs at
// the start of a new decision request, which is no help while a request is
// still in flight (jev round-trips have been observed up to ~3.8s, with one
// 12.6s outlier) and the bird free-falls the whole time. Returns true/false
// to force the call, or null to defer to the AI's own in-flight decision.
function localEmergencyOverride(game) {
  const bird = game.bird;
  if (bird.y > game.groundY - 80) return true;
  if (bird.y < 50) return false;
  return null;
}

class AIController {
  constructor(name, seedLatencyMs) {
    this.name = name;
    this.latency = 0;
    // Seeded so the very first requests already carry a sane latency
    // projection; corrected by a running average of real observed latency
    // after that (0.3 weight on each new sample).
    this.avgLatency = seedLatencyMs;
    this.lastFlap = false;
    this.inFlight = 0;
    // Previously a new request only went out once the last one resolved, so
    // a single slow jev round-trip (up to ~3.8s observed) meant the whole
    // game ran on one decision every few seconds. Allow a few requests in
    // flight at once instead, so a fresh state reaches the AI every physics
    // tick regardless of how long any one answer takes to come back.
    this.maxInFlight = 3;
    this.seq = 0;
    this.latestAppliedSeq = 0;
    this.tick = 0;
    this.held = null;
  }

  decide(game) {
    if (game.gameOver) {
      this.lastFlap = false;
      return;
    }
    if (USE_LOCAL_HEURISTIC) {
      this.lastFlap = localHeuristic(game);
      this.latency = 0;
      return;
    }

    this.tick++;
    if (this.held && this.held.at <= this.tick) {
      this.lastFlap = this.held.flap;
      this.held = null;
    }

    if (this.inFlight >= this.maxInFlight) return;

    const state = getState(game, this.avgLatency);
    if (!state) return;

    // The question was about the bird as projected avgLatency ahead, so the
    // answer is for that tick. Applying an early answer on arrival flapped
    // the bird before it reached the line, pushing its bob up into the top
    // pipe; in simulation, holding answers until their tick survived
    // 1.1s ± 0.8s of round-trip jitter with no deaths.
    const targetTick = this.tick + Math.round(this.avgLatency / MS_PER_PHYSICS_TICK);
    const mySeq = ++this.seq;
    const sentAt = performance.now();
    this.inFlight++;
    decideWS(this.name, state).then(data => {
      this.inFlight--;
      if (typeof data.latency === 'number') {
        // Full round trip, not the server's processing time: queueing and
        // network time are part of how stale the answer is.
        this.latency = Math.round(performance.now() - sentAt);
        this.avgLatency = this.avgLatency * 0.7 + this.latency * 0.3;
      }
      // With several requests in flight, an older one can resolve after a
      // newer one already has. Only apply a response if it's the freshest
      // one issued so far, so a late answer to a stale question can't
      // overwrite a decision made from more current state.
      if (mySeq > this.latestAppliedSeq) {
        this.latestAppliedSeq = mySeq;
        if (targetTick <= this.tick) {
          this.held = null;
          this.lastFlap = data.shouldFlap;
        } else {
          this.held = { flap: data.shouldFlap, at: targetTick };
        }
      }
    }).catch(() => {
      this.inFlight--;
    });
  }
}
