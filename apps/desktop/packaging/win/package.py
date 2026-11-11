#!/usr/bin/env python3
"""Builds Linger-<version>-x64-setup.exe and Linger-<version>-x64.zip on Linux.

Inputs: the desktop bundle from `node build.mjs` (dist/, which includes the
teamhub CLI and, built with LINGER_DESKTOP_DAEMON_TARGETS=win32-x64, the Go
daemon) and the official Electron zip for win32-x64.
Tools: the `wintool` image from ./Dockerfile (NSIS, ImageMagick, resedit).

    docker build -t wintool packaging/win
    python3 packaging/win/package.py [--out DIR]

The setup program installs for the current user into
%LOCALAPPDATA%\\Programs\\Linger without administrator rights, adds a Start
menu shortcut and an entry under Installed apps. The zip holds the same
folder for running without installing.

Neither is Authenticode-signed yet, so SmartScreen asks the user to confirm
the first start. There is no self-update on Windows; a new setup program
replaces the installed version.

The Go daemon goes to resources/computer/. With a bundled source package, the
TeamHub binaries and the Native runtime build.mjs built from it must be there
and match their manifests and that package (../native_bundle.py).
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
DESKTOP = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.dirname(HERE))
from native_bundle import check_runtime, check_teamhub  # noqa: E402
DAEMON = os.path.join(DESKTOP, "dist", "computer", "win32-x64", "linger-computer-daemon.exe")


def run(*args, **kwargs):
    subprocess.run(args, check=True, **kwargs)


def wintool(workdir, *args):
    run("docker", "run", "--rm", "-u", f"{os.getuid()}:{os.getgid()}",
        "-v", f"{workdir}:/w", "-w", "/w", "wintool", *args)


def electron_zip(version, cache):
    os.makedirs(cache, exist_ok=True)
    path = os.path.join(cache, f"electron-v{version}-win32-x64.zip")
    if not os.path.exists(path):
        mirror = os.environ.get("ELECTRON_MIRROR", "https://github.com/electron/electron/releases/download/")
        url = f"{mirror}v{version}/electron-v{version}-win32-x64.zip"
        print(f"downloading {url}")
        with urllib.request.urlopen(url) as response, open(path + ".part", "wb") as out:
            shutil.copyfileobj(response, out)
        os.rename(path + ".part", path)
    return path


def write_icon(output):
    """The logo's Windows icon (apps/assets/logo/windows), 16 to 256 px."""
    shutil.copy(os.path.join(DESKTOP, "resources", "linger.ico"), output)


KEPT_LOCALES = {"en-US.pak", "zh-CN.pak"}


def stage_app(version, electron_version, workdir, cache):
    stage = os.path.join(workdir, "Linger")
    with zipfile.ZipFile(electron_zip(electron_version, cache)) as archive:
        archive.extractall(stage)
    resources = os.path.join(stage, "resources")
    # Electron treats an app with default_app.asar as unpackaged.
    default_app = os.path.join(resources, "default_app.asar")
    if os.path.exists(default_app):
        os.remove(default_app)
    for name in ("LICENSES.chromium.html", "version"):
        if os.path.exists(os.path.join(stage, name)):
            os.remove(os.path.join(stage, name))
    # The app speaks English and Chinese; Chromium falls back to en-US.
    locales = os.path.join(stage, "locales")
    for name in os.listdir(locales):
        if name not in KEPT_LOCALES:
            os.remove(os.path.join(locales, name))

    dist = os.path.join(DESKTOP, "dist")
    app_dir = os.path.join(resources, "app")
    shutil.copytree(dist, os.path.join(app_dir, "dist"),
                    ignore=shutil.ignore_patterns("*.map", "computer"))
    with open(os.path.join(app_dir, "package.json"), "w") as out:
        json.dump({"name": "linger-desktop", "productName": "Linger", "version": version,
                   "type": "module", "main": "dist/main/index.mjs"}, out, indent=2)
    computer = os.path.join(resources, "computer")
    os.makedirs(computer)
    shutil.copy2(DAEMON, computer)

    write_icon(os.path.join(resources, "linger.ico"))
    os.rename(os.path.join(stage, "electron.exe"), os.path.join(stage, "Linger.exe"))
    shutil.copy(os.path.join(HERE, "resources.mjs"), workdir)
    wintool(workdir, "node", "resources.mjs", "Linger/Linger.exe", "Linger/resources/linger.ico", version)
    return stage


def build_setup(workdir, version, output):
    shutil.copy(os.path.join(HERE, "installer.nsi"), workdir)
    wintool(workdir, "makensis", "-V2", f"-DVERSION={version}",
            f"-DNUMERIC_VERSION={version.split('-')[0]}", "-DSTAGE=Linger",
            "-DOUTPUT=Linger-setup.exe", "installer.nsi")
    shutil.move(os.path.join(workdir, "Linger-setup.exe"), output)


def build_zip(stage, output):
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for root, _, files in os.walk(stage):
            for name in sorted(files):
                path = os.path.join(root, name)
                archive.write(path, os.path.join("Linger", os.path.relpath(path, stage)))


def sha256(path):
    with open(path, "rb") as source:
        return hashlib.sha256(source.read()).hexdigest()


def report(path):
    print(f"{path} {os.path.getsize(path)} sha256={sha256(path)}")


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
        sys.exit("dist/ is missing the daemon for win32-x64; run "
                 "`LINGER_DESKTOP_DAEMON_TARGETS=win32-x64 node build.mjs` first")
    check_teamhub("win32-x64")
    check_runtime("win32-x64")
    os.makedirs(args.out, exist_ok=True)
    workdir = tempfile.mkdtemp(prefix="linger-win-")
    try:
        stage = stage_app(version, electron_version, workdir, args.cache)
        setup = os.path.join(args.out, f"Linger-{version}-x64-setup.exe")
        build_setup(workdir, version, setup)
        report(setup)
        archive = os.path.join(args.out, f"Linger-{version}-x64.zip")
        build_zip(stage, archive)
        report(archive)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


if __name__ == "__main__":
    main()
