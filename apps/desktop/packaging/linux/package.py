#!/usr/bin/env python3
"""Builds Linger-<version>-linux-x64.tar.gz.

Inputs: the desktop bundle from `node build.mjs` (dist/, which includes the
teamhub CLI and, built with LINGER_DESKTOP_DAEMON_TARGETS=linux-x64, the Go
daemon) and the official Electron zip for linux-x64.

    python3 packaging/linux/package.py [--out DIR]

The archive holds one folder, Linger-<version>-linux-x64/, with the
`linger` executable at the top; it runs from wherever it is unpacked. The Go
daemon goes to resources/computer/. With a bundled source package, the
TeamHub binaries and the Native runtime build.mjs built from it must be there
and match their manifests and that package (../native_bundle.py). The
runtime and the bundled PostgreSQL need glibc 2.35 or newer (Ubuntu 22.04,
Debian 12); on an older system the desktop installs Native from the network.
"""
import argparse
import hashlib
import json
import os
import shutil
import sys
import tarfile
import tempfile
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
DESKTOP = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.dirname(HERE))
from native_bundle import check_runtime, check_teamhub  # noqa: E402

TARGET = "linux-x64"
DAEMON = os.path.join(DESKTOP, "dist", "computer", TARGET, "linger-computer-daemon")
# The app speaks English and Chinese; Chromium falls back to en-US.
KEPT_LOCALES = {"en-US.pak", "zh-CN.pak"}


def electron_zip(version, cache):
    os.makedirs(cache, exist_ok=True)
    path = os.path.join(cache, f"electron-v{version}-{TARGET}.zip")
    if not os.path.exists(path):
        mirror = os.environ.get("ELECTRON_MIRROR", "https://github.com/electron/electron/releases/download/")
        url = f"{mirror}v{version}/electron-v{version}-{TARGET}.zip"
        print(f"downloading {url}")
        with urllib.request.urlopen(url) as response, open(path + ".part", "wb") as out:
            shutil.copyfileobj(response, out)
        os.rename(path + ".part", path)
    return path


def stage_app(version, electron_version, root, cache):
    with zipfile.ZipFile(electron_zip(electron_version, cache)) as archive:
        for info in archive.infolist():
            path = archive.extract(info, root)
            mode = info.external_attr >> 16
            if mode:
                os.chmod(path, mode & 0o7777)
    resources = os.path.join(root, "resources")
    # Electron treats an app with default_app.asar as unpackaged.
    default_app = os.path.join(resources, "default_app.asar")
    if os.path.exists(default_app):
        os.remove(default_app)
    locales = os.path.join(root, "locales")
    for name in os.listdir(locales):
        if name not in KEPT_LOCALES:
            os.remove(os.path.join(locales, name))

    app_dir = os.path.join(resources, "app")
    shutil.copytree(os.path.join(DESKTOP, "dist"), os.path.join(app_dir, "dist"),
                    ignore=shutil.ignore_patterns("*.map", "computer"), symlinks=True)
    with open(os.path.join(app_dir, "package.json"), "w") as out:
        json.dump({"name": "linger-desktop", "productName": "Linger", "version": version,
                   "type": "module", "main": "dist/main/index.mjs"}, out, indent=2)
    computer = os.path.join(resources, "computer")
    os.makedirs(computer)
    shutil.copy2(DAEMON, computer)
    shutil.copy2(os.path.join(DESKTOP, "resources", "icon.png"), resources)
    os.rename(os.path.join(root, "electron"), os.path.join(root, "linger"))


def owned_by_root(info):
    info.uid = info.gid = 0
    info.uname = info.gname = "root"
    return info


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for chunk in iter(lambda: source.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=os.path.join(DESKTOP, "out"))
    parser.add_argument("--cache", default=os.path.expanduser("~/.cache/linger-desktop"))
    args = parser.parse_args()
    with open(os.path.join(DESKTOP, "package.json")) as source:
        package = json.load(source)
    version = package["version"]
    electron_version = package["devDependencies"]["electron"].lstrip("^~")
    if not os.path.exists(DAEMON):
        sys.exit(f"dist/ is missing the daemon for {TARGET}; run "
                 f"`LINGER_DESKTOP_DAEMON_TARGETS={TARGET} node build.mjs` first")
    check_teamhub(TARGET)
    check_runtime(TARGET)
    os.makedirs(args.out, exist_ok=True)
    name = f"Linger-{version}-{TARGET}"
    workdir = tempfile.mkdtemp(prefix="linger-linux-")
    try:
        root = os.path.join(workdir, name)
        stage_app(version, electron_version, root, args.cache)
        output = os.path.join(args.out, f"{name}.tar.gz")
        with tarfile.open(output, "w:gz") as archive:
            archive.add(root, arcname=name, filter=owned_by_root)
        print(f"{output} {os.path.getsize(output)} sha256={sha256(output)}")
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


if __name__ == "__main__":
    main()
