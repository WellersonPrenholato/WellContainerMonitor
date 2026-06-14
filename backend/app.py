"""API + WebSocket do Well Container Monitor.

Inicie com:

    .venv/bin/python app.py
"""

from __future__ import annotations

import logging
import os

from flask import Flask, jsonify, request
from flask_cors import CORS
from flask_socketio import SocketIO, emit

import docker_client

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
logger = logging.getLogger("WELL_CONTAINER_MONITOR")

UPDATE_INTERVAL_SECONDS = int(os.getenv("DASHBOARD_UPDATE_INTERVAL_SECONDS", "5"))
PORT = int(os.getenv("DASHBOARD_PORT", "5050"))

app = Flask(__name__)
CORS(app)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

_background_task_started = False
_terminal_sessions: dict[str, dict] = {}


@app.route("/api/summary", methods=["GET"])
def get_summary():
    try:
        containers = docker_client.list_containers(include_stats=True)
        return jsonify(docker_client.build_summary(containers)), 200
    except Exception as e:
        logger.exception("Erro ao montar resumo")
        return jsonify({"error": str(e)}), 500


@app.route("/api/containers", methods=["GET"])
def get_containers():
    try:
        containers = docker_client.list_containers(include_stats=True)
        return jsonify(containers), 200
    except Exception as e:
        logger.exception("Erro ao listar containers")
        return jsonify({"error": str(e)}), 500


@app.route("/api/containers/<container_id>", methods=["GET"])
def get_container(container_id: str):
    try:
        container = docker_client.get_container(container_id, include_stats=True)
        if container is None:
            return jsonify({"error": "Container não encontrado"}), 404
        return jsonify(container), 200
    except Exception as e:
        logger.exception("Erro ao obter container")
        return jsonify({"error": str(e)}), 500


@app.route("/api/containers/<container_id>/logs", methods=["GET"])
def get_container_logs(container_id: str):
    tail = request.args.get("tail", default=200, type=int)
    tail = max(1, min(tail, 2000))

    try:
        logs = docker_client.get_container_logs(container_id, tail=tail)
        if logs is None:
            return jsonify({"error": "Container não encontrado"}), 404
        return jsonify({"logs": logs}), 200
    except Exception as e:
        logger.exception("Erro ao obter logs do container")
        return jsonify({"error": str(e)}), 500


@app.route("/api/images", methods=["GET"])
def get_images():
    try:
        images = docker_client.list_images()
        return jsonify(images), 200
    except Exception as e:
        logger.exception("Erro ao listar imagens")
        return jsonify({"error": str(e)}), 500


@app.route("/api/images/<image_id>", methods=["DELETE"])
def delete_image(image_id: str):
    force = request.args.get("force", "false").lower() == "true"

    try:
        result = docker_client.delete_image(image_id, force=force)
    except Exception as e:
        logger.exception("Erro ao remover imagem")
        return jsonify({"error": str(e)}), 500

    if result.get("error") == "not_found":
        return jsonify({"error": "Imagem não encontrada"}), 404

    if result.get("error") == "in_use":
        return jsonify({"error": "in_use", "running_containers": result["running_containers"]}), 409

    logger.info("Imagem %s removida (force=%s)", image_id, force)
    return jsonify({"message": "Imagem removida com sucesso"}), 200


@app.route("/api/containers/<container_id>/actions/<action>", methods=["POST"])
def post_container_action(container_id: str, action: str):
    if action not in {"start", "stop", "restart", "pause", "unpause"}:
        return jsonify({"error": f"Ação inválida: {action}"}), 400

    try:
        sucesso = docker_client.container_action(container_id, action)
        if not sucesso:
            return jsonify({"error": "Container não encontrado"}), 404

        logger.info("Ação '%s' executada no container %s", action, container_id)
        return jsonify({"message": f"Ação '{action}' executada com sucesso"}), 200
    except Exception as e:
        logger.exception("Erro ao executar ação no container")
        return jsonify({"error": str(e)}), 500


def _broadcast_updates() -> None:
    while True:
        try:
            containers = docker_client.list_containers(include_stats=True)
            summary = docker_client.build_summary(containers)
            socketio.emit("containers_update", {"summary": summary, "containers": containers})
        except Exception:
            logger.exception("Erro ao transmitir atualização de containers")

        socketio.sleep(UPDATE_INTERVAL_SECONDS)


@socketio.on("connect")
def handle_connect():
    global _background_task_started
    logger.info("Cliente conectado via WebSocket")
    if not _background_task_started:
        _background_task_started = True
        socketio.start_background_task(_broadcast_updates)


def _read_terminal_output(sid: str, sock) -> None:
    raw_sock = getattr(sock, "_sock", sock)
    while True:
        try:
            data = raw_sock.recv(4096)
        except Exception:
            break
        if not data:
            break
        socketio.emit("terminal_output", {"data": data.decode("utf-8", errors="replace")}, room=sid)

    socketio.emit("terminal_closed", {}, room=sid)
    session = _terminal_sessions.pop(sid, None)
    if session:
        try:
            raw_sock.close()
        except Exception:
            pass


@socketio.on("terminal_start")
def handle_terminal_start(data):
    sid = request.sid
    container_id = (data or {}).get("container_id")

    _close_terminal_session(sid)

    try:
        exec_id, sock = docker_client.create_terminal_session(container_id)
    except ValueError as e:
        emit("terminal_error", {"error": str(e)})
        return
    except Exception as e:
        logger.exception("Erro ao abrir terminal")
        emit("terminal_error", {"error": str(e)})
        return

    _terminal_sessions[sid] = {"exec_id": exec_id, "sock": sock}
    socketio.start_background_task(_read_terminal_output, sid, sock)
    emit("terminal_ready", {})


@socketio.on("terminal_input")
def handle_terminal_input(data):
    sid = request.sid
    session = _terminal_sessions.get(sid)
    if not session:
        return

    raw_sock = getattr(session["sock"], "_sock", session["sock"])
    try:
        raw_sock.sendall((data or {}).get("data", "").encode("utf-8"))
    except Exception:
        logger.exception("Erro ao enviar dados ao terminal")


@socketio.on("terminal_resize")
def handle_terminal_resize(data):
    sid = request.sid
    session = _terminal_sessions.get(sid)
    if not session:
        return

    rows = (data or {}).get("rows")
    cols = (data or {}).get("cols")
    if rows and cols:
        docker_client.resize_terminal(session["exec_id"], rows, cols)


@socketio.on("terminal_stop")
def handle_terminal_stop():
    _close_terminal_session(request.sid)


@socketio.on("disconnect")
def handle_disconnect():
    _close_terminal_session(request.sid)


def _close_terminal_session(sid: str) -> None:
    session = _terminal_sessions.pop(sid, None)
    if not session:
        return
    raw_sock = getattr(session["sock"], "_sock", session["sock"])
    try:
        raw_sock.close()
    except Exception:
        pass


if __name__ == "__main__":
    logger.info("Iniciando Well Container Monitor na porta %s (intervalo: %ss)", PORT, UPDATE_INTERVAL_SECONDS)
    socketio.run(app, host="0.0.0.0", port=PORT, allow_unsafe_werkzeug=True)
