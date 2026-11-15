#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Build fixed-version public release assets; never upload or publish them."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
APP_NAME = "HuaiDJ.DiskToolkit"
APP_REQUIRED = (APP_NAME + ".exe", APP_NAME + ".dll", APP_NAME + ".deps.json", APP_NAME + ".runtimeconfig.json", "coreclr.dll", "hostfxr.dll", "hostpolicy.dll", "System.Private.CoreLib.dll", "System.Windows.Forms.dll")
APP_EXCLUDED_PARTS = {"obj", "bin", "artifacts", "state", "work", "node_modules", ".git", "__pycache__"}
APP_EXCLUDED_SUFFIXES = {".pdb", ".log", ".bak", ".cache", ".tmp", ".user", ".suo", ".pyc"}


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def sha256(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def load_public_helper(root: Path):
    spec = importlib.util.spec_from_file_location("huaidj_public_package", root / "scripts" / "prepare-public.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def ensure_empty_destination(path: Path) -> Path:
    if path.is_symlink() or (hasattr(path, "is_junction") and path.is_junction()):
        raise ValueError("The release destination must not be a link or junction")
    resolved = path.resolve()
    if resolved.exists() and (not resolved.is_dir() or any(resolved.iterdir())):
        raise ValueError("Release destination is not empty; use a new directory")
    resolved.mkdir(parents=True, exist_ok=True)
    return resolved


def fixed_release(root: Path):
    schema = read_json(root / "installers" / "release-manifest.schema.json")
    props = schema["properties"]
    version, tag, repository = (props[key]["const"] for key in ("version", "tag", "repository"))
    if read_json(root / "package.json")["version"] != version or tag != "v" + version:
        raise ValueError("Package version and the sealed installer release contract differ")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        raise ValueError("Invalid repository in the sealed release contract")
    dependencies = read_json(root / "installers" / "dependencies.json")
    for family in ("node", "powershell"):
        for platform in dependencies[family]["platforms"].values():
            if not re.fullmatch(r"[0-9a-fA-F]{64}", platform["sha256"]):
                raise ValueError("A sealed dependency hash is invalid")
    return version, tag, repository, {key: dependencies[key] for key in ("node", "powershell")}


def check_pe(path: Path, *, managed=False):
    data = path.read_bytes()
    if len(data) < 512 or data[:2] != b"MZ":
        raise ValueError(f"A compiled PE file is required: {path.name}")
    offset = struct.unpack_from("<I", data, 0x3C)[0]
    if offset + 24 > len(data) or data[offset:offset + 4] != b"PE\0\0":
        raise ValueError(f"Invalid PE header: {path.name}")
    machine = struct.unpack_from("<H", data, offset + 4)[0]
    if machine not in ({0x14C, 0x8664} if managed else {0x8664}):
        raise ValueError(f"The desktop package must target Windows x64: {path.name}")
    if managed:
        magic = struct.unpack_from("<H", data, offset + 24)[0]
        directories = offset + 24 + (112 if magic == 0x20B else 96 if magic == 0x10B else 0)
        if directories == offset + 24 or directories + 15 * 8 > len(data) or not all(struct.unpack_from("<II", data, directories + 14 * 8)):
            raise ValueError(f"The owned managed desktop assembly is missing a CLR header: {path.name}")


def license_kind(path: Path):
    name = re.sub(r"[^a-z]", "", path.name.lower())
    if name.startswith("license") or name.startswith("licence") or name in {"dotnetruntimemittxt", "windowsdesktopruntimemittxt"}:
        return "license"
    if "thirdparty" in name and "notice" in name:
        return "third-party-notices"
    return None


def validate_app_folder(folder: Path, extra_licenses=(), privacy=None):
    if folder.is_symlink() or (hasattr(folder, "is_junction") and folder.is_junction()):
        raise ValueError("The desktop publish folder must not be a link or junction")
    folder = folder.resolve()
    if not folder.is_dir():
        raise ValueError("Desktop publish folder does not exist")
    missing = [name for name in APP_REQUIRED if not (folder / name).is_file()]
    if missing:
        raise ValueError("A self-contained desktop publish is required; missing: " + ", ".join(missing))
    if any((folder / name).stat().st_size < 512 for name in APP_REQUIRED if name.endswith((".exe", ".dll"))):
        raise ValueError("A desktop/runtime executable is empty or a placeholder")
    runtime = read_json(folder / (APP_NAME + ".runtimeconfig.json"))["runtimeOptions"]
    frameworks = runtime.get("includedFrameworks", [])
    names = {framework.get("name") for framework in frameworks}
    if runtime.get("framework") or runtime.get("frameworks") or not {"Microsoft.NETCore.App", "Microsoft.WindowsDesktop.App"}.issubset(names):
        raise ValueError("Framework-dependent desktop output cannot be packaged as directly runnable")
    deps = read_json(folder / (APP_NAME + ".deps.json"))
    if not deps.get("runtimeTarget", {}).get("name", "").endswith("/win-x64"):
        raise ValueError("The desktop dependency graph does not target win-x64")
    check_pe(folder / (APP_NAME + ".exe"))
    check_pe(folder / (APP_NAME + ".dll"), managed=True)
    for host in ("coreclr.dll", "hostfxr.dll", "hostpolicy.dll"):
        check_pe(folder / host)
    if privacy:
        privacy.check_binary_privacy(folder / (APP_NAME + ".exe"))
        privacy.check_binary_privacy(folder / (APP_NAME + ".dll"))
    licenses = [path for path in folder.rglob("*") if path.is_file() and license_kind(path)] + [Path(path) for path in extra_licenses]
    if any(not path.is_file() or path.stat().st_size == 0 for path in licenses):
        raise ValueError("A supplied desktop/runtime license file is missing or empty")
    kinds = {license_kind(path) for path in licenses}
    if not {"license", "third-party-notices"}.issubset(kinds):
        raise ValueError("Desktop runtime LICENSE and third-party notices must accompany the self-contained files; supply --app-license-file if the publish output omits them")
    return {"selfContained": True, "runtimeIdentifier": "win-x64", "executable": APP_NAME + ".exe", "managedAssembly": APP_NAME + ".dll", "executableSha256": sha256(folder / (APP_NAME + ".exe")), "managedAssemblySha256": sha256(folder / (APP_NAME + ".dll")), "includedFrameworks": frameworks, "guiAcceptance": "NOT_RUN", "licenses": licenses}


def copy_app(folder: Path, target: Path, extra_licenses=()):
    target.mkdir(parents=True)
    for file in sorted(folder.rglob("*")):
        relative = file.relative_to(folder)
        if set(relative.parts) & APP_EXCLUDED_PARTS or file.suffix.lower() in APP_EXCLUDED_SUFFIXES:
            continue
        if file.is_symlink() or (hasattr(file, "is_junction") and file.is_junction()):
            raise ValueError("Links are not allowed inside the desktop publish folder")
        if file.is_file():
            output = target / relative
            output.parent.mkdir(parents=True, exist_ok=True)
            digest = sha256(file)
            shutil.copyfile(file, output)
            if sha256(output) != digest or sha256(file) != digest:
                raise ValueError("A desktop publish file changed during copying")
    for file in extra_licenses:
        file = Path(file)
        output = target / "licenses" / file.name
        output.parent.mkdir(parents=True, exist_ok=True)
        if output.exists() and sha256(output) != sha256(file):
            raise ValueError("Desktop license filenames conflict")
        if not output.exists():
            shutil.copyfile(file, output)


def validate_native_identity(root: Path, source_stage: Path, privacy):
    declared = read_json(source_stage / "patches" / "native-engine.json")
    source = read_json(source_stage / "sources" / "native-source-manifest.json")
    binary = root / "bin" / "rufus-huaidj.exe"
    if not binary.is_file() or sha256(binary) != declared["binary"]["sha256"].lower():
        raise ValueError("The installed native binary does not match the sealed source-stage build manifest")
    if source["upstreamCommit"] != declared["upstream"]["commit"] or source["patchSha256"].lower() != declared["patch"]["sha256"].lower() or sha256(source_stage / "patches" / "native-adapter.patch") != source["patchSha256"].lower():
        raise ValueError("Native binary, patch and Corresponding Source are not the same sealed revision")
    privacy.check_binary_privacy(binary)
    return binary, {"path": "bin/rufus-huaidj.exe", "sha256": sha256(binary), "size": binary.stat().st_size}


def create_zip(directory: Path, output: Path, prefix="", normalized_utc=None):
    stamp = normalized_utc or datetime.now(timezone.utc)
    with zipfile.ZipFile(output, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as archive:
        for file in sorted(directory.rglob("*")):
            if file.is_symlink() or (hasattr(file, "is_junction") and file.is_junction()):
                raise ValueError("A release archive cannot contain links")
            if file.is_file():
                relative = file.relative_to(directory).as_posix()
                name = prefix.rstrip("/") + "/" + relative if prefix else relative
                info = zipfile.ZipInfo(name, stamp.timetuple()[:6])
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = ((0o100755 if file.suffix == ".sh" else 0o100644) << 16)
                with file.open("rb") as source, archive.open(info, "w") as output_stream:
                    shutil.copyfileobj(source, output_stream, 1024 * 1024)


def create_skill_stage(source: Path, target: Path, privacy):
    target.mkdir(parents=True)
    for name in ("SKILL.md", "LICENSE"):
        file = source / name
        if not file.is_file():
            raise ValueError(f"The standalone skill is missing {name}")
        shutil.copyfile(file, target / name)
    for name in ("references", "scripts", "agents"):
        privacy.copy_public_tree(source / name, target / name)
    privacy.inspect_public_files(target)


def asset_record(name: str, file: Path, repository: str, tag: str, archive_root="."):
    return {"name": name, "file": file.name, "url": f"https://github.com/{repository}/releases/download/{tag}/{file.name}", "sha256": sha256(file), "archiveRoot": archive_root}


def refresh_public_manifest(stage: Path, privacy, *, native_binary: bool, desktop=None):
    entries = [entry for entry in privacy.inventory(stage) if entry["path"] != "PUBLIC-MANIFEST.json"]
    manifest = {"formatVersion": 1, "package": "huaidj-disk-toolkit", "containsNativeBinary": native_binary, "containsSelfContainedDesktop": desktop is not None, "license": "GPL-3.0-or-later", "thirdPartyNotices": "THIRD_PARTY_NOTICES.md", "files": entries}
    if desktop:
        manifest["desktop"] = {key: value for key, value in desktop.items() if key != "licenses"}
    (stage / "PUBLIC-MANIFEST.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


def build_release(root: Path, destination: Path, *, source_only=False, app_folder=None, app_license_files=()):
    created = datetime.now(timezone.utc)
    normalized_utc = created.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    version, tag, repository, dependencies = fixed_release(root)
    if source_only and app_folder:
        raise ValueError("--source-only and --app-folder must not be combined")
    if not source_only and app_folder is None:
        raise ValueError("A final desktop release requires --app-folder; use --source-only while desktop output is pending")
    # Reject bad desktop outputs before preparing or writing a release tree.
    privacy = load_public_helper(root)
    desktop = validate_app_folder(Path(app_folder), app_license_files, privacy) if app_folder else None
    resolved_destination = destination.resolve()
    if resolved_destination == root.resolve() or any(resolved_destination == root / name or (root / name) in resolved_destination.parents for name in privacy.PUBLIC_DIRS + ("bin", "vendor", "sources")):
        raise ValueError("Release destination must not be inside a source directory")
    if app_folder and (resolved_destination == Path(app_folder).resolve() or Path(app_folder).resolve() in resolved_destination.parents):
        raise ValueError("Release destination must not be inside the desktop publish folder")
    destination = ensure_empty_destination(destination)
    staging = destination / "staging"
    staging.mkdir()
    source_stage = staging / "source"
    prepared = subprocess.run([sys.executable, str(root / "scripts" / "prepare-public.py"), "--destination", str(source_stage)], capture_output=True, text=True, check=False)
    if prepared.returncode:
        raise ValueError("Source staging failed: " + (prepared.stderr.strip() or prepared.stdout.strip()))
    for name in ("README.md", "README.zh-TW.md", "docs/CONNECT.md", "desktop/HuaiDJ.DiskToolkit.Desktop.csproj", "installers/dependencies.json", "sources/rufus/rufus.sln", "sources/rufus/.vs/rufus.vcxproj", "sources/rufus/LICENSE.txt"):
        if not (source_stage / name).is_file():
            raise ValueError("A required public source/documentation/build file is missing: " + name)
    assets = []
    source_zip = destination / f"huaidj-disk-toolkit-{tag}-source.zip"
    create_zip(source_stage, source_zip, normalized_utc=created)
    assets.append(asset_record("source", source_zip, repository, tag))

    if not source_only:
        binary, identity = validate_native_identity(root, source_stage, privacy)
        windows_stage = staging / "windows-x64"
        shutil.copytree(source_stage, windows_stage)
        (windows_stage / "bin").mkdir(exist_ok=True)
        shutil.copyfile(binary, windows_stage / identity["path"])
        if sha256(windows_stage / identity["path"]) != identity["sha256"]:
            raise ValueError("Native binary copy did not retain its verified hash")
        native_source = read_json(windows_stage / "sources" / "native-source-manifest.json")
        native_source["binary"] = identity
        (windows_stage / "sources" / "native-source-manifest.json").write_text(json.dumps(native_source, indent=2) + "\n", encoding="utf-8")
        copy_app(Path(app_folder).resolve(), windows_stage / "app", app_license_files)
        if sha256(windows_stage / "app" / desktop["executable"]) != desktop["executableSha256"] or sha256(windows_stage / "app" / desktop["managedAssembly"]) != desktop["managedAssemblySha256"]:
            raise ValueError("The desktop executable/assembly changed after validation")
        privacy.inspect_public_files(windows_stage)
        refresh_public_manifest(windows_stage, privacy, native_binary=True, desktop=desktop)
        windows_zip = destination / f"huaidj-disk-toolkit-{tag}-windows-x64.zip"
        create_zip(windows_stage, windows_zip, normalized_utc=created)
        assets.append(asset_record("windows-x64", windows_zip, repository, tag))

    skill_stage = staging / "skill"
    create_skill_stage(source_stage / "skills" / "huaidj-disk-toolkit", skill_stage, privacy)
    for skill_name, installer_name in (("bootstrap.ps1", "install.ps1"), ("bootstrap.sh", "bootstrap.sh")):
        skill_bootstrap = skill_stage / "scripts" / skill_name
        canonical = source_stage / "scripts" / installer_name
        if not skill_bootstrap.is_file() or sha256(skill_bootstrap) != sha256(canonical):
            raise ValueError("The standalone Skill bootstrap differs from the sealed installer snapshot")
    skill_zip = destination / f"huaidj-disk-toolkit-{tag}-skill.zip"
    create_zip(skill_stage, skill_zip, prefix="huaidj-disk-toolkit", normalized_utc=created)
    assets.append(asset_record("skill", skill_zip, repository, tag, "huaidj-disk-toolkit"))
    for name, source_name, output_name in (("install-ps1", "install.ps1", "install.ps1"), ("bootstrap-sh", "bootstrap.sh", "bootstrap.sh")):
        source = source_stage / "scripts" / source_name
        if not source.is_file():
            raise ValueError("A sealed standalone installer is missing from the source staging tree")
        target = destination / output_name
        shutil.copyfile(source, target)
        assets.append(asset_record(name, target, repository, tag))
    manifest = {"schemaVersion": 1, "version": version, "tag": tag, "repository": repository, "createdUTC": normalized_utc, "normalizedUTC": normalized_utc, "zipTimestampBasis": "Actual builder UTC creation time, rounded by ZIP timestamp precision; source local modification times are not embedded.", "assets": assets, "dependencies": dependencies}
    if desktop:
        manifest["desktop"] = {key: value for key, value in desktop.items() if key != "licenses"}
    manifest_name = "release-manifest.preview.json" if source_only else "release-manifest.json"
    manifest_path = destination / manifest_name
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    checksum_files = [destination / asset["file"] for asset in assets] + [manifest_path]
    with (destination / "SHA256SUMS").open("x", encoding="utf-8", newline="\n") as output:
        for file in sorted(checksum_files):
            output.write(f"{sha256(file)}  {file.name}\n")
    summary = {"status": "preview-not-for-publication" if source_only else "candidate-built-not-published", "version": version, "tag": tag, "repository": repository, "normalizedUTC": normalized_utc, "assets": [asset["file"] for asset in assets], "manifest": manifest_name, "selfContainedDesktop": desktop is not None, "guiAcceptance": "NOT_RUN", "nativeEngineExecuted": False, "publication": "NOT_RUN"}
    (destination / "BUILD-RESULT.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--destination", required=True, type=Path)
    parser.add_argument("--source-only", action="store_true", help="Create source/Skill preview assets only; no final Windows manifest")
    parser.add_argument("--app-folder", type=Path, help="Final Windows x64 self-contained desktop publish folder")
    parser.add_argument("--app-license-file", action="append", default=[], type=Path, help="Additional exact runtime LICENSE/ThirdPartyNotices files to retain with the desktop")
    args = parser.parse_args()
    print(json.dumps(build_release(ROOT, args.destination, source_only=args.source_only, app_folder=args.app_folder, app_license_files=args.app_license_file)))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.SubprocessError) as error:
        raise SystemExit(f"Release preparation stopped: {error}")
