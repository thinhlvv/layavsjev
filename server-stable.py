"""
Flappy Bird AI Battle - Unified Python Server
Serves static files, WebSocket for AI decisions (jev via TypeSafe SDK, laya via laya model).

Install: pip install -r requirements.txt
Run:     source venv/bin/activate && python3 server.py
"""

import contextlib
import json
import os
import threading
import time
from pathlib import Path

from flask import Flask, jsonify, send_from_directory
from flask_sock import Sock

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
PORT = 3001
BASE_DIR = Path(__file__).parent

app = Flask(__name__)
sock = Sock(app)

# ---------------------------------------------------------------------------
# TypeSafe SDK (jev)
# ---------------------------------------------------------------------------
jev_client = None
if os.environ.get("TYPESAFE_API_KEY"):
    try:
        from typesafe_sdk import TypeSafeClient, Choice
        jev_client = TypeSafeClient(model="jev-latest")
    except Exception as e:
        print(f"[jev] TypeSafe SDK init failed: {e}")

# ---------------------------------------------------------------------------
# Laya model (background load)
# ---------------------------------------------------------------------------
laya_agent = None
laya_status = "loading"


def _load_laya():
    global laya_agent, laya_status
    try:
        from laya import load
        print("[laya] Loading model in background...")
        # The root checkpoint is tuned for general English classification (intent,
        # NLI). "typed-decisions" is the checkpoint the package benchmarks for this
        # exact task shape (typed choice/score/noul decisions), and A/B testing
        # confirmed it distinguishes clear-cut opposite game states correctly where
        # the root checkpoint did not.
        laya_agent = load("convaiinnovations/laya", subfolder="typed-decisions")
        laya_status = "loaded"
        print("[laya] Model loaded")
    except Exception as e:
        laya_status = "fallback"
        print(f"[laya] Model unavailable: {e} — using heuristic fallback")


# Same input for jev and laya: the hover formula, computed client-side in
# ai.js getState() (it knows which pipe the bird's hitbox still overlaps).
# Kept to two fields: tested on 100 real game states (50 flap / 50 wait), laya
# said "flap" on 46 of 50 wait cases when given the full ~14-field state, and
# "wait" on all 50 flap cases given only the raw number (it can't read the
# sign). This zone label + number scored 100/100.
def hover_instructions(data):
    # The line's clearance comes from ai.js HOVER_CLEARANCE, so the text
    # can't drift from the line the formula actually uses.
    return (
        "Keep the bird riding on the floor line: its bottom edge must stay just above the line "
        f"({data['hoverClearance']}px above the gap bottom), never sinking below it. "
        "FLAP when floorZone is 'below_floor'. WAIT when floorZone is 'above_floor'."
    )


HOVER_CRITERIA = {"flap": "floorZone is below_floor", "wait": "floorZone is above_floor"}


def hover_state(data):
    return {
        "floorZone": "below_floor" if data["belowFloorNextTick"] else "above_floor",
        "pxBelowFloorNextTick": data["pxBelowFloorNextTick"],
    }


def emergency_override(bird_y, ground_y):
    """Hard safety net independent of model confidence.

    Both real models can be asked to consult their own judgment for
    borderline calls, but a genuine second-from-death situation shouldn't
    be left to a model whose confidence output is known to be miscalibrated
    (laya's checkpoint warns about this at load time) or just slow (jev's
    real network round-trip). Returns True/False to force the call, or None
    to defer to the model.
    """
    if ground_y is not None and bird_y > ground_y - 80:
        return True
    if bird_y < 50:
        return False
    return None


def decide_laya_heuristic(data):
    bird_y = data["birdY"]
    bird_vy = data["birdVY"]
    gravity = data.get("birdGravity", 0.3)
    gap_center = data["gapCenter"]
    gap_top = data.get("gapTop", gap_center - data.get("gapSize", 150) // 2)
    gap_bottom = data.get("gapBottom", gap_center + data.get("gapSize", 150) // 2)
    dist_to_pipe = data["distToPipe"]
    pipe_speed = data.get("pipeSpeed", 1.5)
    ground_y = data["groundY"]
    offset = bird_y - gap_center

    if bird_y > ground_y - 80:
        return True, 0.95
    if bird_y < 50:
        return False, 0.9

    frames_to_pipe = max(0, dist_to_pipe / pipe_speed) if dist_to_pipe > 0 else 0
    if 0 < frames_to_pipe < 80:
        sim_y, sim_vy = bird_y, bird_vy
        for _ in range(min(int(frames_to_pipe) + 1, 40)):
            sim_vy += gravity
            sim_y += sim_vy
        margin = 25
        if sim_y > gap_bottom - margin:
            return True, 0.9
        if sim_y < gap_top + margin:
            return False, 0.8

    if offset > 25:
        return True, 0.8
    if offset < -25:
        return False, 0.7
    return False, 0.5


def decide_laya_ai(data):
    override = emergency_override(data["birdY"], data.get("groundY"))
    if override is not None:
        return {"shouldFlap": override, "confidence": 1.0, "model": "laya-emergency"}

    if laya_agent is None:
        should_flap, conf = decide_laya_heuristic(data)
        return {"shouldFlap": should_flap, "confidence": conf, "model": laya_status}

    try:
        questions = {
            "flap": {"type": "choice", "instructions": hover_instructions(data), "criteria": HOVER_CRITERIA}
        }
        result = laya_agent.system_one(hover_state(data), questions)
        answer = result["answers"]["flap"]["choice"]
        probs = result["answers"]["flap"].get("probabilities", {})
        flap_prob = probs.get("flap", 0)
        wait_prob = probs.get("wait", 0)
        print(f"[laya] raw: answer={answer} flap={flap_prob:.4f} wait={wait_prob:.4f}", flush=True)

        should_flap = answer == "flap"

        return {
            "shouldFlap": should_flap,
            "confidence": round(flap_prob, 4),
            "flapProb": round(flap_prob, 4),
            "waitProb": round(wait_prob, 4),
            "model": "laya",
        }
    except Exception as e:
        print(f"[laya] ERROR: {e}", flush=True)
        should_flap, conf = decide_laya_heuristic(data)
        return {"shouldFlap": should_flap, "confidence": conf, "model": "laya-fallback", "error": str(e)}


# ---------------------------------------------------------------------------
# Jev decision via TypeSafe SDK
# ---------------------------------------------------------------------------
def decide_jev(state):
    override = emergency_override(state["birdY"], state.get("groundY"))
    if override is not None:
        return {"shouldFlap": override, "confidence": 1.0, "rawChoice": "flap" if override else "wait", "model": "jev-emergency"}

    if not jev_client:
        raise RuntimeError("TYPESAFE_API_KEY not set")

    from typesafe_sdk import Choice

    response = jev_client.system_one(
        state=hover_state(state),
        questions={"flap": Choice(instructions=hover_instructions(state), criteria=HOVER_CRITERIA)},
    )

    choice = response.choices["flap"]
    raw_choice = choice.choice
    confidence = choice.confidence

    should_flap = raw_choice == "flap"

    return {
        "shouldFlap": should_flap,
        "confidence": confidence,
        "rawChoice": raw_choice,
        "model": "jev",
    }


# ---------------------------------------------------------------------------
# HTTP routes
# ---------------------------------------------------------------------------
@app.route("/api/jev/health")
def jev_health():
    has_key = jev_client is not None
    return jsonify({"status": "ok" if has_key else "no-api-key", "model": "jev", "ready": has_key})


@app.route("/api/laya/health")
def laya_health():
    return jsonify({"loaded": laya_agent is not None, "mode": laya_status})


@app.route("/", defaults={"path": ""})
@app.route("/<path:path>")
def serve_static(path):
    if path == "":
        path = "index.html"
    file_path = BASE_DIR / path
    if file_path.is_file():
        return send_from_directory(BASE_DIR, path)
    return "Not found", 404


# ---------------------------------------------------------------------------
# WebSocket
# ---------------------------------------------------------------------------
DECIDERS = {"jev": decide_jev, "laya": decide_laya_ai}


@sock.route("/")
def ws_handler(ws):
    print("[ws] client connected", flush=True)
    # Each request runs on its own thread so laya (~85ms) never waits behind a
    # jev round-trip (~0.9s) on this shared connection, and jev's up-to-3
    # in-flight requests (AIController.maxInFlight) actually overlap instead
    # of queueing. Laya's calls stay one at a time: it's a local model whose
    # thread safety is unknown.
    ai_locks = {"jev": contextlib.nullcontext(), "laya": threading.Lock()}
    send_lock = threading.Lock()

    def send(payload):
        with send_lock:
            ws.send(json.dumps(payload))

    def handle(ai, state, req_id):
        try:
            with ai_locks[ai]:
                start = time.perf_counter()
                result = DECIDERS[ai](state)
                result["latency"] = round((time.perf_counter() - start) * 1000)
            result.update(ai=ai, type="decision", id=req_id)
            print(f"[{ai}] flap={result['shouldFlap']} conf={result['confidence']} {result['latency']}ms", flush=True)
            send(result)
        except Exception as e:
            print(f"[{ai}] error: {e}", flush=True)
            try:
                send({"type": "decision", "ai": ai, "id": req_id, "shouldFlap": False,
                      "confidence": 0, "model": f"{ai}-error", "error": str(e)})
            except Exception:
                pass

    try:
        while True:
            raw = ws.receive()
            if raw is None:
                break
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            if msg.get("type") == "decide":
                ai = msg["ai"]
                if ai not in DECIDERS:
                    send({"type": "decision", "ai": ai, "id": msg.get("id"),
                          "shouldFlap": False, "confidence": 0, "model": "unknown"})
                    continue
                threading.Thread(target=handle, args=(ai, msg["state"], msg.get("id")), daemon=True).start()
    except Exception as e:
        print(f"[ws] error: {e}", flush=True)
    print("[ws] client disconnected", flush=True)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    threading.Thread(target=_load_laya, daemon=True).start()
    has_key = bool(os.environ.get("TYPESAFE_API_KEY"))
    print(f"\n🐦 Flappy Bird AI Battle", flush=True)
    print(f"   Game:      http://localhost:{PORT}", flush=True)
    print(f"   Jev:       {'TypeSafe SDK connected' if has_key else 'Set TYPESAFE_API_KEY for real jev'}", flush=True)
    print(f"   Laya:      loading in background (port {PORT} unified)", flush=True)
    print(f"   WebSocket: ws://localhost:{PORT}", flush=True)
    print(f"\n   Press Space to restart, P to pause\n", flush=True)
    app.run(host="0.0.0.0", port=PORT, debug=False, threaded=True)
