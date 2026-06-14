import json
import os
import re
import subprocess
import time
from typing import Dict, List, Optional

OUT_DIR = "/textfile_collector"
OUT_FILE = os.path.join(OUT_DIR, "docker_services.prom")
TMP_FILE = os.path.join(OUT_DIR, "docker_services.prom.tmp")
INTERVAL_SECONDS = 15

UNIT_FACTORS = {
    "": 1,
    "B": 1,
    "kB": 1000,
    "MB": 1000**2,
    "GB": 1000**3,
    "TB": 1000**4,
    "KiB": 1024,
    "MiB": 1024**2,
    "GiB": 1024**3,
    "TiB": 1024**4,
}


def run_docker(args: List[str]) -> str:
    cmd = ["docker", *args]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        return ""
    return proc.stdout.strip()


def escape_label(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def to_float_number(value: str) -> float:
    clean = value.replace("%", "").replace(",", ".").strip()
    if clean in {"", "--", "N/A"}:
        return 0.0
    try:
        return float(clean)
    except ValueError:
        return 0.0


def to_bytes(value: str) -> int:
    clean = value.replace(" ", "")
    if clean in {"", "N/A", "--"}:
        return 0

    match = re.match(r"^([0-9]+(?:\.[0-9]+)?)([A-Za-z]*)$", clean)
    if not match:
        return 0

    number = float(match.group(1))
    unit = match.group(2)
    factor = UNIT_FACTORS.get(unit, 1)
    return int(number * factor)


def inspect_container(container_id: str) -> Dict[str, str]:
    raw = run_docker(["inspect", container_id])
    if not raw:
        return {
            "status": "unknown",
            "health": "unknown",
            "restarts": "0",
        }

    try:
        data = json.loads(raw)[0]
    except (json.JSONDecodeError, IndexError, KeyError):
        return {
            "status": "unknown",
            "health": "unknown",
            "restarts": "0",
        }

    state = data.get("State", {})
    health_obj = state.get("Health") or {}
    health = health_obj.get("Status", "none")

    return {
        "status": str(state.get("Status", "unknown")),
        "health": str(health),
        "restarts": str(data.get("RestartCount", 0)),
    }


def list_containers() -> List[Dict[str, str]]:
    raw = run_docker(["ps", "-a", "--format", "{{.ID}};{{.Names}};{{.Image}}"])
    if not raw:
        return []

    result = []
    for line in raw.splitlines():
        parts = line.split(";", 2)
        if len(parts) != 3:
            continue
        cid, name, image = parts
        result.append({"id": cid, "name": name, "image": image})
    return result


def list_stats() -> List[Dict[str, str]]:
    raw = run_docker(["stats", "--no-stream", "--format", "{{.Name}};{{.CPUPerc}};{{.MemUsage}};{{.MemPerc}};{{.PIDs}}"])
    if not raw:
        return []

    result = []
    for line in raw.splitlines():
        parts = line.split(";", 4)
        if len(parts) != 5:
            continue
        name, cpu, mem_usage, mem_perc, pids = parts
        result.append(
            {
                "name": name,
                "cpu": cpu,
                "mem_usage": mem_usage,
                "mem_perc": mem_perc,
                "pids": pids,
            }
        )
    return result


def write_metrics() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)

    containers = list_containers()
    stats = list_stats()

    inspection: Dict[str, Dict[str, str]] = {}
    lines: List[str] = [
        "# HELP docker_service_up Docker service status (1 running, 0 otherwise).",
        "# TYPE docker_service_up gauge",
        "# HELP docker_service_restarts_total Total restart count for a Docker service.",
        "# TYPE docker_service_restarts_total gauge",
        "# HELP docker_service_ok Docker service operational status (1 running and healthy/no-healthcheck, 0 otherwise).",
        "# TYPE docker_service_ok gauge",
        "# HELP docker_service_cpu_percent Current CPU percent per Docker service.",
        "# TYPE docker_service_cpu_percent gauge",
        "# HELP docker_service_memory_percent Current memory percent per Docker service.",
        "# TYPE docker_service_memory_percent gauge",
        "# HELP docker_service_memory_usage_bytes Current memory usage in bytes per Docker service.",
        "# TYPE docker_service_memory_usage_bytes gauge",
        "# HELP docker_service_memory_limit_bytes Current memory limit in bytes per Docker service.",
        "# TYPE docker_service_memory_limit_bytes gauge",
        "# HELP docker_service_pids Current process count per Docker service.",
        "# TYPE docker_service_pids gauge",
    ]

    for container in containers:
        info = inspect_container(container["id"])
        inspection[container["name"]] = info

        status = info["status"]
        health = info["health"]
        restarts = info["restarts"]

        up = 1 if status == "running" else 0
        health_ok = 1 if health in {"healthy", "none", "unknown"} else 0
        ok = 1 if up == 1 and health_ok == 1 else 0

        service = escape_label(container["name"])
        image = escape_label(container["image"])
        status_esc = escape_label(status)
        health_esc = escape_label(health)

        lines.append(f'docker_service_up{{service="{service}",image="{image}",status="{status_esc}"}} {up}')
        lines.append(
            f'docker_service_ok{{service="{service}",image="{image}",status="{status_esc}",health="{health_esc}"}} {ok}'
        )
        lines.append(f'docker_service_restarts_total{{service="{service}"}} {restarts}')

        if status != "running":
            lines.append(f'docker_service_cpu_percent{{service="{service}",status="{status_esc}",health="{health_esc}"}} 0')
            lines.append(f'docker_service_memory_percent{{service="{service}",status="{status_esc}",health="{health_esc}"}} 0')
            lines.append(
                f'docker_service_memory_usage_bytes{{service="{service}",status="{status_esc}",health="{health_esc}"}} 0'
            )
            lines.append(
                f'docker_service_memory_limit_bytes{{service="{service}",status="{status_esc}",health="{health_esc}"}} 0'
            )
            lines.append(f'docker_service_pids{{service="{service}",status="{status_esc}",health="{health_esc}"}} 0')

    for stat in stats:
        name = stat["name"]
        info = inspection.get(name)
        if not info:
            info = inspect_container(name)

        status = info["status"]
        health = info["health"]

        mem_usage_parts = stat["mem_usage"].split(" / ", 1)
        mem_usage_raw = mem_usage_parts[0] if mem_usage_parts else "0"
        mem_limit_raw = mem_usage_parts[1] if len(mem_usage_parts) > 1 else "0"

        cpu = to_float_number(stat["cpu"])
        mem_perc = to_float_number(stat["mem_perc"])
        pids = to_float_number(stat["pids"])
        mem_usage_bytes = to_bytes(mem_usage_raw)
        mem_limit_bytes = to_bytes(mem_limit_raw)

        service = escape_label(name)
        status_esc = escape_label(status)
        health_esc = escape_label(health)

        lines.append(f'docker_service_cpu_percent{{service="{service}",status="{status_esc}",health="{health_esc}"}} {cpu}')
        lines.append(f'docker_service_memory_percent{{service="{service}",status="{status_esc}",health="{health_esc}"}} {mem_perc}')
        lines.append(
            f'docker_service_memory_usage_bytes{{service="{service}",status="{status_esc}",health="{health_esc}"}} {mem_usage_bytes}'
        )
        lines.append(
            f'docker_service_memory_limit_bytes{{service="{service}",status="{status_esc}",health="{health_esc}"}} {mem_limit_bytes}'
        )
        lines.append(f'docker_service_pids{{service="{service}",status="{status_esc}",health="{health_esc}"}} {pids}')

    with open(TMP_FILE, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")

    os.replace(TMP_FILE, OUT_FILE)


def main() -> None:
    while True:
        try:
            write_metrics()
        except Exception:
            # exporter keeps running and writes next cycle
            pass
        time.sleep(INTERVAL_SECONDS)


if __name__ == "__main__":
    main()
