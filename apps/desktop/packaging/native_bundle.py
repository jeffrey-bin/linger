"""Checks of what build.mjs bundles for Native in dist/installer/native/.

With a bundled source package, the TeamHub binaries (teamhub-<target>/) and
the services with Node.js (runtime-<target>/) built from it must be there and
match their manifests and that package; scripts/build-teamhub.mjs and
scripts/build-native-runtime.mjs write them. Every package script runs these
before staging the app.
"""
import hashlib
import json
import os
import sys

DESKTOP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NATIVE = os.path.join(DESKTOP, "dist", "installer", "native")
SOURCE = os.path.join(DESKTOP, "dist", "installer", "source")
TEAMHUB_COMMANDS = ("teamhub", "migrate", "account")


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for chunk in iter(lambda: source.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def matches(path, item):
    return os.path.isfile(path) and os.path.getsize(path) == item["bytes"] and sha256(path) == item["sha256"]


def _manifest(directory, target, what):
    """The manifest in directory, checked against target and the bundled source."""
    path = os.path.join(directory, "manifest.json")
    if not os.path.exists(path):
        if os.path.isdir(SOURCE):
            sys.exit(f"dist/ bundles a source package but no {what} for {target}; "
                     "run build.mjs with LINGER_SOURCE_ARCHIVE_FILE again")
        return None
    with open(path) as file:
        manifest = json.load(file)
    if manifest.get("target") != target:
        sys.exit(f"{path} is for {manifest.get('target')}")
    archives = os.listdir(SOURCE) if os.path.isdir(SOURCE) else []
    if archives and manifest.get("sourceArchiveSha256") != sha256(os.path.join(SOURCE, archives[0])):
        sys.exit(f"{path} was built from another source package than {archives[0]}")
    return manifest


def check_teamhub(target, native=NATIVE):
    """Exits unless the TeamHub binaries match their manifest and the bundled source."""
    directory = os.path.join(native, f"teamhub-{target}")
    manifest = _manifest(directory, target, "TeamHub binaries")
    if manifest is None:
        return
    for command in TEAMHUB_COMMANDS:
        binary = manifest["binaries"][command]
        if not matches(os.path.join(directory, binary["file"]), binary):
            sys.exit(f"{directory}/{binary['file']} does not match its manifest")


def check_runtime(target, native=NATIVE):
    """Exits unless the bundled services and Node.js match their manifest and
    the bundled source; in the folder layout, every file of the services too."""
    directory = os.path.join(native, f"runtime-{target}")
    manifest = _manifest(directory, target, "Native runtime")
    if manifest is None:
        return
    folder = manifest.get("layout") == "directory"
    items = [manifest["directory" if folder else "archive"], manifest["node"]]
    if folder:
        runtime = os.path.dirname(manifest["directory"]["file"])
        with open(os.path.join(directory, manifest["directory"]["file"])) as file:
            files = json.load(file)["files"]
        items += [dict(item, file=f"{runtime}/{name}") for name, item in files.items()]
    for item in items:
        if not matches(os.path.join(directory, item["file"]), item):
            sys.exit(f"{directory}/{item['file']} does not match its manifest")


def _write_json(path, value, indent):
    with open(path + ".tmp", "w") as out:
        json.dump(value, out, indent=indent)
    os.replace(path + ".tmp", path)


def refresh(native, target):
    """Records the bytes signing changed (macOS) in the manifests of the copy
    in native/, so the desktop's checks of the copies it installs pass."""
    teamhub = os.path.join(native, f"teamhub-{target}")
    path = os.path.join(teamhub, "manifest.json")
    if os.path.exists(path):
        with open(path) as file:
            manifest = json.load(file)
        for binary in manifest["binaries"].values():
            binary["sha256"] = sha256(os.path.join(teamhub, binary["file"]))
            binary["bytes"] = os.path.getsize(os.path.join(teamhub, binary["file"]))
        _write_json(path, manifest, 2)
    runtime = os.path.join(native, f"runtime-{target}")
    path = os.path.join(runtime, "manifest.json")
    if not os.path.exists(path):
        return
    with open(path) as file:
        manifest = json.load(file)
    if manifest.get("layout") != "directory":
        return
    files_path = os.path.join(runtime, manifest["directory"]["file"])
    root = os.path.dirname(files_path)
    with open(files_path) as file:
        files = json.load(file)
    for name, item in files["files"].items():
        item["sha256"] = sha256(os.path.join(root, name))
        item["bytes"] = os.path.getsize(os.path.join(root, name))
    _write_json(files_path, files, 1)
    for key in ("directory", "node"):
        item = manifest[key]
        item["sha256"] = sha256(os.path.join(runtime, item["file"]))
        item["bytes"] = os.path.getsize(os.path.join(runtime, item["file"]))
    _write_json(path, manifest, 2)
