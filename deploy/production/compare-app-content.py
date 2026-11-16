#!/usr/bin/env python3
"""Preflight for scripts/deploy-production.sh: does the new app image serve the
same files as the live one?

Lists /usr/share/nginx/html in both images (read from the images with `tar`;
the live container itself is not touched) and prints file count, total size,
video size, and the files that are missing or new. Vite's content hashes
(`index-AbC123xY.js`) are replaced by `#` so builds of different commits line up.

Exits 1 when the new image
  - contains a Git LFS pointer instead of a real file, or
  - lacks a video (mp4/webm/mpeg/mov) the live image has, unless that video is
    listed in EXPECTED_MISSING below.

    compare-app-content.py <new-image> <live-container>
"""
import collections
import re
import subprocess
import sys
import tarfile

ROOT = "/usr/share/nginx/html"
LFS_HEADER = b"version https://git-lfs.github.com/spec/v1"
VIDEO = re.compile(r"\.(mp4|webm|mpeg|mov)(\.(gz|br))?$", re.I)
HASH = re.compile(r"-[A-Za-z0-9_-]{8}(?=(\.[A-Za-z0-9]+)+$)")

# Live today, deliberately not in the repo: no page uses them. They were bundled only
# because components import every `assets/*.webm` with an eager import.meta.glob.
EXPECTED_MISSING = {
    "assets/crowd video-#.webm",
    "assets/stock-footage-security-camera-view-of-people-working-at-office-with-modern-design-and-sitting-at-the-tables-with-#.webm",
}


def listing(image):
    """{normalised path: [sizes]}, plus the paths that are LFS pointers."""
    proc = subprocess.Popen(["docker", "run", "--rm", "--network", "none", "--entrypoint", "tar",
                             image, "-cf", "-", "-C", ROOT, "."], stdout=subprocess.PIPE)
    files, pointers = collections.defaultdict(list), []
    with tarfile.open(fileobj=proc.stdout, mode="r|") as tar:
        for m in tar:
            if not m.isfile():
                continue
            path = m.name[2:] if m.name.startswith("./") else m.name
            if m.size < 1024:
                head = tar.extractfile(m).read(len(LFS_HEADER))
                if head == LFS_HEADER:
                    pointers.append(path)
            files[HASH.sub("-#", path)].append(m.size)
    if proc.wait() != 0:
        sys.exit(f"could not read {ROOT} from {image}")
    return files, pointers


def summary(files):
    sizes = [s for v in files.values() for s in v]
    video = sum(s for k, v in files.items() if VIDEO.search(k) for s in v)
    return f"{len(sizes)} files, {sum(sizes) / 1e6:.1f} MB (videos {video / 1e6:.1f} MB)"


def strip_compression(path):
    return re.sub(r"\.(gz|br)$", "", path)


def main():
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    new_image, live_container = sys.argv[1:]
    live_image = subprocess.run(["docker", "inspect", "-f", "{{.Image}}", live_container],
                                check=True, capture_output=True, text=True).stdout.strip()
    new, new_ptr = listing(new_image)
    live, _ = listing(live_image)

    print(f"    live {summary(live)}")
    print(f"    new  {summary(new)}")
    missing = sorted(k for k in live if len(new.get(k, [])) < len(live[k]))
    added = sorted(k for k in new if len(live.get(k, [])) < len(new[k]))
    problems = 0

    for p in new_ptr:
        print(f"  ✖ Git LFS pointer, not the real file: {p}")
        problems += 1
    for k in missing:
        if not VIDEO.search(k):
            continue
        if strip_compression(k) in EXPECTED_MISSING:
            print(f"    missing (expected, unused): {k}")
        else:
            print(f"  ✖ video missing from the new image: {k}")
            problems += 1
    other = [k for k in missing if not VIDEO.search(k)]
    if other:
        print(f"    {len(other)} other file(s) live but not in the new image:")
        for k in other[:40]:
            print(f"      - {k}")
        if len(other) > 40:
            print(f"      ... and {len(other) - 40} more")
    if added:
        print(f"    {len(added)} file(s) new in this image (first 10): {', '.join(added[:10])}")

    if problems:
        print(f"  ✖ app content: {problems} problem(s)")
        return 1
    print("  ✔ app content: no LFS pointers, every live video is present")
    return 0


if __name__ == "__main__":
    sys.exit(main())
