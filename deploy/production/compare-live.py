#!/usr/bin/env python3
"""Preflight for scripts/deploy-production.sh: would this deploy change anything
except the image?

Compares what `docker compose config` renders for each deployed service with
the container that is running now: environment, mounts, published ports,
command, runtime and restart policy. Prints differences with env values masked
(key names only) and exits 1 if there are any, so a deploy can never silently
change credentials, volumes or ports.

    compare-live.py <rendered-config.json> <service>=<container> [...]

Image-provided defaults (PATH, NODE_VERSION, ...) are ignored unless the compose
file sets them too. The image itself is expected to differ and is not compared.
"""
import json
import subprocess
import sys


def inspect(kind, name):
    out = subprocess.run(["docker", kind, "inspect", name], check=True,
                         capture_output=True, text=True).stdout
    return json.loads(out)[0]


def env_dict(pairs):
    d = {}
    for item in pairs or []:
        k, _, v = item.partition("=")
        d[k] = v
    return d


def rendered_env(svc):
    env = svc.get("environment") or {}
    if isinstance(env, list):
        env = env_dict(env)
    return {k: ("" if v is None else str(v)) for k, v in env.items()}


def rendered_mounts(svc, config):
    """(source, target) pairs; named volumes as Docker names them (<project>_<key>)."""
    project, volumes = config.get("name", ""), config.get("volumes") or {}
    out = set()
    for v in svc.get("volumes") or []:
        if isinstance(v, str):
            src, _, rest = v.partition(":")
            v = {"type": "bind" if src.startswith(("/", ".")) else "volume",
                 "source": src, "target": rest.split(":")[0]}
        src = v.get("source", "")
        if v.get("type") == "volume" and src:
            src = (volumes.get(src) or {}).get("name") or f"{project}_{src}"
        out.add((src, v["target"]))
    return out


def live_mounts(c, image):
    """Live (source, target) pairs, minus anonymous volumes the image itself declares."""
    declared = set((image["Config"].get("Volumes") or {}).keys())
    out = set()
    for m in c.get("Mounts") or []:
        if m["Type"] == "volume" and m["Destination"] in declared and len(m["Name"]) == 64:
            continue
        src = m["Name"] if m["Type"] == "volume" else m["Source"]
        out.add((src, m["Destination"]))
    return out


def rendered_ports(svc):
    out = set()
    for p in svc.get("ports") or []:
        out.add((str(p.get("published", "")), f'{p["target"]}/{p.get("protocol", "tcp")}'))
    return out


def live_ports(c):
    out = set()
    for target, binds in (c["HostConfig"].get("PortBindings") or {}).items():
        for b in binds or []:
            out.add((b.get("HostPort", ""), target))
    return out


def main():
    if len(sys.argv) < 3:
        print(__doc__, file=sys.stderr)
        return 2
    config = json.load(open(sys.argv[1]))
    project = config.get("name", "")
    problems = 0
    for pair in sys.argv[2:]:
        service, _, container = pair.partition("=")
        svc = config["services"][service]
        c = inspect("container", container)
        img = inspect("image", c["Image"])
        issues = []

        if svc.get("container_name") != container:
            issues.append(f"container_name {svc.get('container_name')!r} != {container!r}")
        live_project = (c["Config"].get("Labels") or {}).get("com.docker.compose.project")
        if live_project != project:
            issues.append(f"compose project {project!r} != live {live_project!r} (would create NEW volumes)")

        want = rendered_env(svc)
        have = env_dict(c["Config"].get("Env"))
        image_defaults = env_dict(img["Config"].get("Env"))
        for k in sorted(set(want) | set(have)):
            if k in want and k in have:
                if want[k] != have[k]:
                    issues.append(f"env {k}: value differs")
            elif k in want:
                issues.append(f"env {k}: new (not set on the live container)")
            elif image_defaults.get(k) != have[k]:
                issues.append(f"env {k}: set on the live container, missing from compose")

        wm, hm = rendered_mounts(svc, config), live_mounts(c, img)
        for m in sorted(wm - hm):
            issues.append(f"mount added   {m[0]} -> {m[1]}")
        for m in sorted(hm - wm):
            issues.append(f"mount removed {m[0]} -> {m[1]}")

        wp, hp = rendered_ports(svc), live_ports(c)
        for p in sorted(wp ^ hp):
            issues.append(f"port {'added' if p in wp else 'removed'} {p[0]} -> {p[1]}")

        if svc.get("command") is not None and list(svc["command"]) != list(c["Config"].get("Cmd") or []):
            issues.append("command differs")
        want_rt = svc.get("runtime") or "runc"
        if want_rt != c["HostConfig"].get("Runtime"):
            issues.append(f"runtime {want_rt!r} != live {c['HostConfig'].get('Runtime')!r}")
        want_rs = svc.get("restart") or "no"
        if want_rs != c["HostConfig"]["RestartPolicy"]["Name"]:
            issues.append(f"restart {want_rs!r} != live {c['HostConfig']['RestartPolicy']['Name']!r}")

        if issues:
            problems += len(issues)
            print(f"  ✖ {service} ({container}): {len(issues)} difference(s)")
            for i in issues:
                print(f"      - {i}")
        else:
            print(f"  ✔ {service} ({container}): same env ({len(want)} vars), mounts, ports, command, runtime, restart")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
