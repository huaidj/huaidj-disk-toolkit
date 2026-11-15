#!/usr/bin/env python3
"""Create a reviewed, private-data-free source/release staging directory.

This script never publishes, uploads, installs, formats disks, or deletes a
pre-existing destination. Python 3.11+ and Git are development requirements.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
UPSTREAM_URL = "https://github.com/pbatard/rufus.git"
PUBLIC_FILES = ("README.md", "README.zh-TW.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "config.example.json", "package.json", "package-lock.json", ".gitignore")
PUBLIC_DIRS = ("src", "tests", "docs", "scripts", "skills", ".github", "patches", "desktop", "installers")
EXCLUDED_PARTS = {".git", "node_modules", "work", "state", "runtime", "__pycache__", ".vs", "dist", "bin", "obj", "artifacts", "TestResults", ".idea"}
EXCLUDED_NAMES = {"config.json", "CONTROL.md", ".env", ".claude.json", "claude_desktop_config.json", "client-server-entry.json"}
TEXT_SUFFIXES = {".mjs", ".cjs", ".js", ".ts", ".ps1", ".py", ".md", ".txt", ".json", ".yaml", ".yml", ".toml", ".patch", ".cmd", ".bat", ".sh", ".props", ".targets", ".cs", ".csproj", ".manifest", ".resx", ".config", ".xml"}
PRIVATE_PATTERNS = (
    re.compile(r"\bDESKTOP-(?=[A-Z0-9]{0,6}[0-9])[A-Z0-9]{7}(?![A-Z0-9])"),
    re.compile(r"(?:sk-proj-|ghp_|github_pat_)[A-Za-z0-9_\-]{16,}"),
)
GENERIC_USER_PATH = re.compile(r"\b[A-Za-z]:[\\/]+Users[\\/]+([^\\/\s\"'<>]+)", re.IGNORECASE)
GENERIC_UNIX_HOME = re.compile(r"(?<![A-Za-z0-9:/])/(?:Users|home)/([A-Za-z0-9._-]+)(?:/|\b)")


def private_prefixes():
    prefixes = {ROOT.resolve(), Path.home().resolve()}
    # Infer the developer workspace container at runtime, without publishing
    # a personal drive, folder or account name in the scanner itself.
    if len(ROOT.parents) > 1:
        container = ROOT.parents[1]
        if len(str(container)) > len(container.anchor) + 4:
            prefixes.add(container)
    profile = os.environ.get("USERPROFILE")
    if profile:
        prefixes.add(Path(profile))
    return {form for prefix in prefixes for form in (str(prefix), str(prefix).replace("\\", "/")) if str(prefix) not in {"/", "\\"}}


def private_text_reason(text: str):
    normalized = re.sub(r"\\+", lambda _: "\\", text).lower()
    if any(prefix.lower() in normalized for prefix in private_prefixes()):
        return "developer-local path"
    machine = os.environ.get("COMPUTERNAME")
    if machine and len(machine) >= 4 and re.search(r"(?<![A-Za-z0-9_])" + re.escape(machine) + r"(?![A-Za-z0-9_])", text, re.IGNORECASE):
        return "runtime machine identifier"
    if any(pattern.search(text) for pattern in PRIVATE_PATTERNS):
        return "machine identifier or credential pattern"
    placeholders = {"public", "default", "all", "username", "user", "example", "sample", "test", "runner", "you"}
    for pattern in (GENERIC_USER_PATH, GENERIC_UNIX_HOME):
        for match in pattern.finditer(text):
            account = match.group(1)
            if not account.startswith(("$", "%", "{", "<")) and account.lower() not in placeholders:
                return "literal user-profile path"
    return None


def sha256(file: Path) -> str:
    h = hashlib.sha256()
    with file.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def run(*args: str, cwd: Path | None = None, env=None) -> str:
    result = subprocess.run(args, cwd=cwd, env=env, capture_output=True, text=True, encoding="utf-8", errors="replace", check=False)
    if result.returncode:
        raise RuntimeError(f"Command failed: {args[0]} (exit {result.returncode}): {result.stderr.strip()[:1000]}")
    return result.stdout.strip()


def is_excluded(relative: Path) -> bool:
    return bool(set(relative.parts) & EXCLUDED_PARTS) or relative.name in EXCLUDED_NAMES or relative.suffix.lower() in {".iso", ".img", ".exe", ".dll", ".pdb", ".zip", ".7z", ".log", ".bak", ".pyc", ".user", ".suo", ".cache"}


def copy_public_tree(source: Path, destination: Path):
    if not source.exists():
        return
    for item in sorted(source.rglob("*")):
        relative = item.relative_to(source)
        if is_excluded(relative):
            continue
        if item.is_symlink():
            raise RuntimeError(f"Refusing a symbolic link in public inputs: {item.relative_to(ROOT)}")
        if item.is_file():
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(item, target)


def export_git_tree(repository: Path, commit: str, destination: Path):
    # git archive honors export-ignore and would omit Rufus build scripts.
    # Export every tracked blob directly so all source/build inputs survive.
    tree = subprocess.check_output(["git", "ls-tree", "-rz", "--full-tree", commit], cwd=repository)
    records = [record for record in tree.split(b"\0") if record]
    process = subprocess.Popen(["git", "cat-file", "--batch"], cwd=repository, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        for record in records:
            metadata, name_bytes = record.split(b"\t", 1)
            mode, object_type, object_hash = metadata.split(b" ")
            name = name_bytes.decode("utf-8")
            relative = PurePosixPath(name)
            if relative.is_absolute() or ".." in relative.parts or ".git" in relative.parts or object_type != b"blob" or mode not in (b"100644", b"100755"):
                raise RuntimeError(f"Unsupported or unsafe entry in upstream source: {name}")
            process.stdin.write(object_hash + b"\n")
            process.stdin.flush()
            header = process.stdout.readline().split()
            if len(header) != 3 or header[0] != object_hash or header[1] != b"blob":
                raise RuntimeError("Unexpected upstream blob response")
            remaining = int(header[2])
            target = destination.joinpath(*relative.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open("wb") as output:
                while remaining:
                    block = process.stdout.read(min(remaining, 1024 * 1024))
                    if not block:
                        raise RuntimeError("Incomplete upstream source blob")
                    output.write(block)
                    remaining -= len(block)
            if process.stdout.read(1) != b"\n":
                raise RuntimeError("Invalid upstream source blob terminator")
            if os.name != "nt" and mode == b"100755":
                target.chmod(0o755)
        process.stdin.close()
        if process.wait(timeout=30):
            raise RuntimeError("Upstream source export failed")
    finally:
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=10)


def inventory(directory: Path):
    return [{"path": file.relative_to(directory).as_posix(), "size": file.stat().st_size, "sha256": sha256(file)} for file in sorted(directory.rglob("*")) if file.is_file()]


def inventory_hash(entries) -> str:
    return hashlib.sha256(json.dumps(entries, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def check_binary_privacy(binary: Path):
    content = binary.read_bytes().lower()
    for prefix in private_prefixes():
        for encoding in ("utf-8", "utf-16le"):
            if prefix.encode(encoding).lower() in content:
                raise RuntimeError("Native binary contains a developer-local path. Use a mapped clean build and reseal its identity before binary publication.")


def add_native_source(destination: Path, include_binary: bool):
    vendor = ROOT / "vendor" / "rufus"
    packaged_source = ROOT / "sources" / "rufus"
    patch = ROOT / "patches" / "native-adapter.patch"
    output_source = destination / "sources" / "rufus"
    output_source.mkdir(parents=True)
    if include_binary:
        binary = ROOT / "bin" / "rufus-huaidj.exe"
        if not binary.is_file():
            raise RuntimeError("Build bin/rufus-huaidj.exe before requesting a native binary package")
        check_binary_privacy(binary)
    if vendor.is_dir() and (vendor / ".git").exists():
        if not patch.is_file():
            raise RuntimeError("The final native-adapter.patch is required before public packaging")
        commit = run("git", "rev-parse", "HEAD", cwd=vendor)
        if not re.fullmatch(r"[a-f0-9]{40}", commit):
            raise RuntimeError("Invalid upstream commit")
        export_git_tree(vendor, commit, output_source)
        isolated = dict(os.environ)
        isolated.pop("GIT_DIR", None)
        isolated.pop("GIT_WORK_TREE", None)
        isolated["GIT_CEILING_DIRECTORIES"] = str(output_source.parent.resolve())
        run("git", "apply", "--check", str(patch), cwd=output_source, env=isolated)
        run("git", "apply", str(patch), cwd=output_source, env=isolated)

        # Check every public source/build input, including files added by the patch.
        upstream_files = run("git", "ls-tree", "-r", "--name-only", commit, cwd=vendor).splitlines()
        patch_files = [line.split("\t", 2)[-1] for line in run("git", "apply", "--numstat", str(patch), cwd=vendor).splitlines()]
        for relative in sorted(set(upstream_files + patch_files)):
            current = vendor / relative
            exported = output_source / relative
            different = current.is_file() != exported.is_file()
            if current.is_file() and exported.is_file() and sha256(current) != sha256(exported):
                # Git's text/eol filters can make a Windows working tree differ
                # bytewise from a source archive without changing its content.
                current_blob = run("git", "hash-object", f"--path={relative}", str(current), cwd=vendor)
                exported_blob = run("git", "hash-object", f"--path={relative}", str(exported), cwd=vendor)
                different = current_blob != exported_blob
            if different:
                raise RuntimeError(f"Native patch does not reproduce the current source: {relative}")
        untracked = run("git", "ls-files", "--others", "--exclude-standard", cwd=vendor).splitlines()
        for relative in untracked:
            if Path(relative).suffix.lower() in {".c", ".h", ".cpp", ".cc", ".rc", ".vcxproj", ".props", ".targets", ".am", ".in", ".sh", ".ps1"} and relative not in patch_files:
                raise RuntimeError(f"Unrecorded native source/build input: {relative}")
        entries = inventory(output_source)
        manifest = {"upstreamRepository": UPSTREAM_URL, "upstreamCommit": commit, "nativeLicense": "GPL-3.0-or-later", "patch": "patches/native-adapter.patch", "patchSha256": sha256(patch), "sourceDirectory": "sources/rufus", "sourceInventorySha256": inventory_hash(entries), "sourceFiles": entries, "reproducibility": "Complete source/build inputs identified; byte-identical compiler output is not claimed."}
    elif packaged_source.is_dir():
        existing = ROOT / "sources" / "native-source-manifest.json"
        if not existing.is_file():
            raise RuntimeError("A packaged native source tree requires its source manifest")
        manifest = json.loads(existing.read_text(encoding="utf-8-sig"))
        expected_paths = {entry["path"] for entry in manifest["sourceFiles"]}
        entries = []
        for entry in manifest["sourceFiles"]:
            relative = PurePosixPath(entry["path"])
            if relative.is_absolute() or ".." in relative.parts or ".git" in relative.parts:
                raise RuntimeError("Invalid packaged-source path in manifest")
            file = packaged_source.joinpath(*relative.parts)
            if file.is_symlink() or not file.is_file():
                raise RuntimeError("A packaged native source input is missing or is a symbolic link")
            entries.append({"path": entry["path"], "size": file.stat().st_size, "sha256": sha256(file)})
        if inventory_hash(entries) != manifest["sourceInventorySha256"]:
            raise RuntimeError("Packaged native source no longer matches its manifest")
        for file in packaged_source.rglob("*"):
            if file.is_file() and file.suffix.lower() in {".c", ".h", ".cpp", ".cc", ".rc", ".vcxproj", ".props", ".targets", ".am", ".in", ".sh", ".ps1"} and file.relative_to(packaged_source).as_posix() not in expected_paths:
                raise RuntimeError("An unrecorded source/build input was added to the packaged native tree")
        # Copy the recorded inputs only; a previous build may have generated
        # intermediate files and logs in the source tree.
        for entry in entries:
            relative = Path(entry["path"])
            target = output_source / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(packaged_source / relative, target)
    else:
        raise RuntimeError("No pinned native source checkout or verified packaged source is available")

    if include_binary:
        binary = ROOT / "bin" / "rufus-huaidj.exe"
        if not binary.is_file():
            raise RuntimeError("Build bin/rufus-huaidj.exe before requesting a native binary package")
        declared_path = ROOT / "patches" / "native-engine.json"
        if not declared_path.is_file():
            raise RuntimeError("A sealed native-engine.json is required for binary packaging")
        declared = json.loads(declared_path.read_text(encoding="utf-8-sig"))
        if declared["upstream"]["commit"] != manifest["upstreamCommit"] or declared["patch"]["sha256"].lower() != manifest["patchSha256"].lower() or declared["binary"]["sha256"].lower() != sha256(binary):
            raise RuntimeError("Native binary, patch and upstream source are not bound by the sealed build manifest")
        target = destination / "bin" / binary.name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(binary, target)
        manifest["binary"] = {"path": "bin/rufus-huaidj.exe", "sha256": sha256(binary), "size": binary.stat().st_size}
    else:
        manifest.pop("binary", None)
    (destination / "sources" / "native-source-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


def inspect_public_files(destination: Path):
    for file in destination.rglob("*"):
        if not file.is_file():
            continue
        relative = file.relative_to(destination)
        if ".git" in relative.parts or relative.name in EXCLUDED_NAMES:
            raise RuntimeError(f"Private metadata/configuration reached staging: {relative}")
        # Upstream source contains its own examples/resources, not developer data.
        if relative.parts[:2] == ("sources", "rufus"):
            continue
        if file.suffix.lower() in TEXT_SUFFIXES or file.name == "LICENSE":
            raw = file.read_bytes()
            text = raw.decode("utf-16" if raw.startswith((b"\xff\xfe", b"\xfe\xff")) else "utf-8-sig")
            reason = private_text_reason(text)
            if reason:
                raise RuntimeError(f"{reason.capitalize()} in {relative}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--destination", required=True, type=Path)
    parser.add_argument("--include-native-binary", action="store_true")
    parser.add_argument("--include-integrations", action="store_true", help="Include reviewed portable integration code; developer-local integrations will fail the privacy scan")
    args = parser.parse_args()
    destination = args.destination.resolve()
    if destination == ROOT or any(destination == ROOT / name or (ROOT / name) in destination.parents for name in PUBLIC_DIRS + ("bin", "vendor", "sources")):
        parser.error("Destination must not replace the checkout or a source directory")
    if destination.exists() and any(destination.iterdir()):
        parser.error("Destination is not empty; choose a new staging directory")
    destination.mkdir(parents=True, exist_ok=True)
    for name in PUBLIC_FILES:
        source = ROOT / name
        if not source.is_file():
            raise RuntimeError(f"Required public file is missing: {name}")
        shutil.copyfile(source, destination / name)
    for name in PUBLIC_DIRS:
        copy_public_tree(ROOT / name, destination / name)
    if args.include_integrations:
        copy_public_tree(ROOT / "integrations", destination / "integrations")
    copy_public_tree(ROOT / "bin", destination / "bin")
    (destination / ".gitattributes").write_text("# Preserve staged source/license bytes and manifest hashes across platforms.\n* -text\n", encoding="utf-8")
    inspect_public_files(destination)
    add_native_source(destination, args.include_native_binary)
    entries = inventory(destination)
    manifest = {"formatVersion": 1, "package": "huaidj-disk-toolkit", "containsNativeBinary": args.include_native_binary, "license": "GPL-3.0-or-later", "thirdPartyNotices": "THIRD_PARTY_NOTICES.md", "files": entries}
    (destination / "PUBLIC-MANIFEST.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"destination": str(destination), "files": len(entries) + 1, "nativeBinary": args.include_native_binary, "status": "staged-not-published"}))


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, ValueError) as error:
        raise SystemExit(f"Public package preparation stopped: {error}")
