"""Camada de acesso ao Docker via docker-py.

Concentra toda a lógica de leitura de containers, estatísticas, portas,
health checks e logs, devolvendo apenas estruturas simples (dict/list)
prontas para serem serializadas em JSON pela API.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Optional

import docker
from docker.errors import NotFound

HOST_ADDRESS = os.getenv("DASHBOARD_HOST_ADDRESS", "192.168.1.54")

_client: Optional[docker.DockerClient] = None


def get_client() -> docker.DockerClient:
    global _client
    if _client is None:
        _client = docker.from_env()
    return _client


def _parse_docker_datetime(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    # Docker retorna timestamps no formato "2026-06-10T12:00:00.123456789Z"
    value = value.split(".")[0].rstrip("Z") + "+00:00" if "." in value else value
    if value.endswith("Z"):
        value = value[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def _format_uptime(started_at: Optional[datetime], status: str) -> str:
    if status != "running" or started_at is None:
        return "-"

    delta = datetime.now(timezone.utc) - started_at
    total_seconds = int(delta.total_seconds())
    if total_seconds < 0:
        total_seconds = 0

    days, remainder = divmod(total_seconds, 86400)
    hours, remainder = divmod(remainder, 3600)
    minutes, _ = divmod(remainder, 60)

    parts = []
    if days:
        parts.append(f"{days}d")
    if hours:
        parts.append(f"{hours}h")
    if minutes or not parts:
        parts.append(f"{minutes}m")

    return " ".join(parts)


def _build_ports(container) -> list[dict]:
    """Extrai o mapeamento porta-do-container -> porta-do-host com URL de acesso."""
    ports_data = container.attrs.get("NetworkSettings", {}).get("Ports") or {}
    resultado = []

    for container_port, bindings in ports_data.items():
        port_number, _, protocol = container_port.partition("/")
        protocol = protocol or "tcp"

        if not bindings:
            resultado.append(
                {
                    "container_port": port_number,
                    "protocol": protocol,
                    "host_ip": None,
                    "host_port": None,
                    "url": None,
                }
            )
            continue

        for binding in bindings:
            host_ip = binding.get("HostIp") or "0.0.0.0"
            host_port = binding.get("HostPort")

            url = None
            if host_port and protocol == "tcp":
                scheme = "https" if port_number in {"443", "8443"} else "http"
                url = f"{scheme}://{HOST_ADDRESS}:{host_port}"

            resultado.append(
                {
                    "container_port": port_number,
                    "protocol": protocol,
                    "host_ip": host_ip,
                    "host_port": host_port,
                    "url": url,
                }
            )

    return resultado


def _build_health(container) -> dict:
    state = container.attrs.get("State", {})
    health = state.get("Health")

    if not health:
        return {
            "status": "none",
            "failing_streak": 0,
            "last_check_at": None,
            "last_output": None,
        }

    log = health.get("Log") or []
    last_entry = log[-1] if log else None

    return {
        "status": health.get("Status", "none"),
        "failing_streak": health.get("FailingStreak", 0),
        "last_check_at": last_entry.get("End") if last_entry else None,
        "last_output": (last_entry.get("Output") or "").strip() if last_entry else None,
    }


def _to_int(value, default=0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _calculate_cpu_percent(stats: dict) -> float:
    try:
        cpu_delta = (
            stats["cpu_stats"]["cpu_usage"]["total_usage"]
            - stats["precpu_stats"]["cpu_usage"]["total_usage"]
        )
        system_delta = (
            stats["cpu_stats"]["system_cpu_usage"]
            - stats["precpu_stats"]["system_cpu_usage"]
        )
        online_cpus = stats["cpu_stats"].get("online_cpus") or len(
            stats["cpu_stats"]["cpu_usage"].get("percpu_usage") or [1]
        )

        if system_delta > 0 and cpu_delta > 0:
            return round((cpu_delta / system_delta) * online_cpus * 100, 2)
    except (KeyError, ZeroDivisionError, TypeError):
        pass

    return 0.0


def _calculate_memory(stats: dict) -> dict:
    memory_stats = stats.get("memory_stats", {})
    usage = memory_stats.get("usage", 0)
    limit = memory_stats.get("limit", 0)

    cache = (memory_stats.get("stats") or {}).get("cache", 0)
    usage_sem_cache = max(usage - cache, 0)

    percent = round((usage_sem_cache / limit) * 100, 2) if limit else 0.0

    return {
        "usage_bytes": usage_sem_cache,
        "limit_bytes": limit,
        "percent": percent,
    }


def _calculate_network(stats: dict) -> dict:
    networks = stats.get("networks") or {}
    rx_bytes = sum(net.get("rx_bytes", 0) for net in networks.values())
    tx_bytes = sum(net.get("tx_bytes", 0) for net in networks.values())
    return {"rx_bytes": rx_bytes, "tx_bytes": tx_bytes}


def _calculate_block_io(stats: dict) -> dict:
    entries = (stats.get("blkio_stats") or {}).get("io_service_bytes_recursive") or []
    read_bytes = sum(e.get("value", 0) for e in entries if e.get("op") == "Read")
    write_bytes = sum(e.get("value", 0) for e in entries if e.get("op") == "Write")
    return {"read_bytes": read_bytes, "write_bytes": write_bytes}


def get_container_stats(container) -> dict:
    """Coleta métricas de CPU/memória/rede/disco de um container em execução."""
    if container.status != "running":
        return {
            "cpu_percent": 0.0,
            "memory": {"usage_bytes": 0, "limit_bytes": 0, "percent": 0.0},
            "network": {"rx_bytes": 0, "tx_bytes": 0},
            "block_io": {"read_bytes": 0, "write_bytes": 0},
            "pids": 0,
        }

    try:
        stats = container.stats(stream=False)
    except (NotFound, Exception):
        return {
            "cpu_percent": 0.0,
            "memory": {"usage_bytes": 0, "limit_bytes": 0, "percent": 0.0},
            "network": {"rx_bytes": 0, "tx_bytes": 0},
            "block_io": {"read_bytes": 0, "write_bytes": 0},
            "pids": 0,
        }

    return {
        "cpu_percent": _calculate_cpu_percent(stats),
        "memory": _calculate_memory(stats),
        "network": _calculate_network(stats),
        "block_io": _calculate_block_io(stats),
        "pids": (stats.get("pids_stats") or {}).get("current", 0),
    }


def serialize_container(container, include_stats: bool = True) -> dict:
    container.reload()
    attrs = container.attrs
    state = attrs.get("State", {})

    created_at = _parse_docker_datetime(attrs.get("Created"))
    started_at = _parse_docker_datetime(state.get("StartedAt"))

    data = {
        "id": container.id,
        "short_id": container.short_id,
        "name": container.name,
        "image": container.image.tags[0] if container.image.tags else container.image.short_id,
        "status": container.status,
        "state": state.get("Status", container.status),
        "created_at": created_at.isoformat() if created_at else None,
        "started_at": started_at.isoformat() if started_at and started_at.year > 1 else None,
        "uptime": _format_uptime(started_at if started_at and started_at.year > 1 else None, container.status),
        "ports": _build_ports(container),
        "health": _build_health(container),
        "restart_count": attrs.get("RestartCount", 0),
    }

    if include_stats:
        data["stats"] = get_container_stats(container)

    return data


def list_containers(include_stats: bool = True) -> list[dict]:
    client = get_client()
    containers = client.containers.list(all=True)
    return [serialize_container(c, include_stats=include_stats) for c in containers]


def get_container(container_id: str, include_stats: bool = True) -> Optional[dict]:
    client = get_client()
    try:
        container = client.containers.get(container_id)
    except NotFound:
        return None
    return serialize_container(container, include_stats=include_stats)


def get_container_logs(container_id: str, tail: int = 200) -> Optional[str]:
    client = get_client()
    try:
        container = client.containers.get(container_id)
    except NotFound:
        return None

    raw = container.logs(tail=tail, timestamps=True)
    return raw.decode("utf-8", errors="replace")


def container_action(container_id: str, action: str) -> bool:
    client = get_client()
    try:
        container = client.containers.get(container_id)
    except NotFound:
        return False

    if action == "start":
        container.start()
    elif action == "stop":
        container.stop()
    elif action == "restart":
        container.restart()
    elif action == "pause":
        container.pause()
    elif action == "unpause":
        container.unpause()
    else:
        raise ValueError(f"Ação desconhecida: {action}")

    return True


def create_terminal_session(container_id: str):
    """Cria uma sessão de exec interativa (tty) dentro do container.

    Retorna (exec_id, socket) onde `socket` é o socket bruto retornado
    pela API do Docker, usado para leitura/escrita do terminal.
    """
    client = get_client()
    try:
        container = client.containers.get(container_id)
    except NotFound:
        raise ValueError("Container não encontrado")

    if container.status != "running":
        raise ValueError("Container não está em execução")

    exec_instance = client.api.exec_create(
        container.id,
        ["/bin/sh", "-c", "exec bash 2>/dev/null || exec sh"],
        stdin=True,
        tty=True,
        stdout=True,
        stderr=True,
    )
    sock = client.api.exec_start(exec_instance["Id"], socket=True, tty=True)
    return exec_instance["Id"], sock


def resize_terminal(exec_id: str, rows: int, cols: int) -> None:
    client = get_client()
    try:
        client.api.exec_resize(exec_id, height=rows, width=cols)
    except Exception:
        pass


def list_images() -> list[dict]:
    """Lista todas as imagens do servidor, indicando se estão em uso.

    Uma imagem é considerada "em uso" se existir qualquer container
    (em qualquer status) referenciando-a, independente do container
    estar em execução ou parado.
    """
    client = get_client()

    containers_by_image: dict[str, list[str]] = {}
    for container in client.containers.list(all=True):
        image_id = container.attrs.get("Image")
        containers_by_image.setdefault(image_id, []).append(container.name)

    resultado = []
    for image in client.images.list(all=True):
        used_by = containers_by_image.get(image.id, [])
        created_at = _parse_docker_datetime(image.attrs.get("Created"))

        resultado.append(
            {
                "id": image.id,
                "short_id": image.short_id.split(":")[-1],
                "tags": image.tags or ["<none>:<none>"],
                "size_bytes": image.attrs.get("Size", 0),
                "created_at": created_at.isoformat() if created_at else None,
                "in_use": bool(used_by),
                "used_by": used_by,
            }
        )

    resultado.sort(key=lambda img: (not img["in_use"], img["tags"][0]))
    return resultado


def delete_image(image_id: str, force: bool = False) -> dict:
    """Remove uma imagem do servidor.

    Se a imagem estiver em uso por containers em execução e `force` for
    falso, retorna `{"error": "in_use", "running_containers": [...]}` para
    que o chamador possa confirmar a finalização desses containers antes de
    tentar novamente com `force=True`.
    """
    client = get_client()

    try:
        image = client.images.get(image_id)
    except NotFound:
        return {"error": "not_found"}

    containers = client.containers.list(all=True)
    using = [c for c in containers if c.attrs.get("Image") == image.id]
    running = [c for c in using if c.status == "running"]

    if running and not force:
        return {"error": "in_use", "running_containers": [c.name for c in running]}

    for container in running:
        container.stop()

    client.images.remove(image.id, force=bool(using))
    return {"ok": True}


def build_summary(containers: list[dict]) -> dict:
    total = len(containers)
    running = sum(1 for c in containers if c["status"] == "running")
    stopped = total - running

    healthy = sum(1 for c in containers if c["health"]["status"] == "healthy")
    unhealthy = sum(1 for c in containers if c["health"]["status"] == "unhealthy")

    cpu_total = round(sum(c.get("stats", {}).get("cpu_percent", 0) for c in containers), 2)
    memory_usage_total = sum(c.get("stats", {}).get("memory", {}).get("usage_bytes", 0) for c in containers)
    memory_limit_total = sum(c.get("stats", {}).get("memory", {}).get("limit_bytes", 0) for c in containers)

    return {
        "total": total,
        "running": running,
        "stopped": stopped,
        "healthy": healthy,
        "unhealthy": unhealthy,
        "cpu_percent_total": cpu_total,
        "memory_usage_bytes_total": memory_usage_total,
        "memory_limit_bytes_total": memory_limit_total,
    }
