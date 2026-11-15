"""Offline release-contract tests; tiny owned fixtures, no media operations."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import struct
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


builder = load("release_builder", ROOT / "scripts/build-release.py")
privacy = load("release_privacy", ROOT / "scripts/prepare-public.py")


def pe(managed=False):
    data = bytearray(512)
    data[:2] = b"MZ"
    struct.pack_into("<I", data, 0x3C, 0x80)
    data[0x80:0x84] = b"PE\0\0"
    struct.pack_into("<H", data, 0x84, 0x8664)
    struct.pack_into("<H", data, 0x80 + 24, 0x20B)
    if managed:
        struct.pack_into("<II", data, 0x80 + 24 + 112 + 14 * 8, 0x1000, 72)
    return data


class ReleaseBuilderTests(unittest.TestCase):
    def setUp(self):
        base = ROOT / "work" / "release-builder-test-fixtures"
        base.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(prefix="owned-", dir=base)
        self.path = Path(self.temporary.name)

        def cleanup():
            if self.path.resolve().parent != base.resolve():
                raise RuntimeError("Refusing cleanup outside the owned fixture root")
            self.temporary.cleanup()

        self.addCleanup(cleanup)

    def app(self, *, self_contained=True, licenses=True):
        folder = self.path / "desktop"
        folder.mkdir()
        for name in builder.APP_REQUIRED:
            if name.endswith((".exe", ".dll")):
                (folder / name).write_bytes(pe(name == builder.APP_NAME + ".dll"))
        runtime = {"includedFrameworks": [{"name": "Microsoft.NETCore.App", "version": "10.0.0"}, {"name": "Microsoft.WindowsDesktop.App", "version": "10.0.0"}]} if self_contained else {"frameworks": [{"name": "Microsoft.WindowsDesktop.App", "version": "10.0.0"}]}
        (folder / (builder.APP_NAME + ".runtimeconfig.json")).write_text(json.dumps({"runtimeOptions": runtime}))
        (folder / (builder.APP_NAME + ".deps.json")).write_text(json.dumps({"runtimeTarget": {"name": ".NETCoreApp,Version=v10.0/win-x64"}}))
        if licenses:
            (folder / "LICENSE.txt").write_text("Synthetic runtime license fixture")
            (folder / "ThirdPartyNotices.txt").write_text("Synthetic runtime notices fixture")
        return folder

    def test_flat_zip_retains_hidden_metadata(self):
        stage = self.path / "source"
        (stage / ".github/workflows").mkdir(parents=True)
        (stage / ".github/workflows/check.yml").write_text("name: fixture\n")
        (stage / ".gitignore").write_text("state/\n")
        archive = self.path / "source.zip"
        builder.create_zip(stage, archive)
        with zipfile.ZipFile(archive) as result:
            self.assertEqual(set(result.namelist()), {".gitignore", ".github/workflows/check.yml"})

    def test_zip_timestamp_uses_actual_utc_builder_instant(self):
        stage = self.path / "utc-source"
        stage.mkdir()
        source = stage / "file.txt"
        source.write_text("fixture")
        os.utime(source, (946684800, 946684800))
        actual_utc = builder.datetime.now(builder.timezone.utc)
        archive = self.path / "utc.zip"
        builder.create_zip(stage, archive, normalized_utc=actual_utc)
        expected = list(actual_utc.timetuple()[:6])
        expected[5] -= expected[5] % 2
        with zipfile.ZipFile(archive) as result:
            self.assertEqual(result.getinfo("file.txt").date_time, tuple(expected))

    def test_skill_zip_has_one_skill_root_and_no_core(self):
        source = self.path / "skill-input"
        (source / "scripts").mkdir(parents=True)
        (source / "src").mkdir()
        (source / "node_modules").mkdir()
        for name in ("SKILL.md", "LICENSE"):
            (source / name).write_text("fixture")
        (source / "scripts/bootstrap.sh").write_text("#!/bin/sh\n")
        (source / "src/private.mjs").write_text("excluded")
        (source / "node_modules/module.js").write_text("excluded")
        stage = self.path / "skill-stage"
        builder.create_skill_stage(source, stage, privacy)
        archive = self.path / "skill.zip"
        builder.create_zip(stage, archive, "huaidj-disk-toolkit")
        with zipfile.ZipFile(archive) as result:
            self.assertEqual(set(result.namelist()), {"huaidj-disk-toolkit/SKILL.md", "huaidj-disk-toolkit/LICENSE", "huaidj-disk-toolkit/scripts/bootstrap.sh"})

    def test_framework_dependent_desktop_is_refused(self):
        with self.assertRaisesRegex(ValueError, "Framework-dependent"):
            builder.validate_app_folder(self.app(self_contained=False))

    def test_placeholder_desktop_binary_is_refused(self):
        app = self.app()
        (app / (builder.APP_NAME + ".exe")).write_text("placeholder")
        with self.assertRaisesRegex(ValueError, "placeholder"):
            builder.validate_app_folder(app)

    def test_runtime_licenses_are_required(self):
        with self.assertRaisesRegex(ValueError, "LICENSE"):
            builder.validate_app_folder(self.app(licenses=False))

    def test_explicit_dotnet_runtime_notice_names_are_accepted(self):
        app = self.app(licenses=False)
        licenses = app / "licenses"
        licenses.mkdir()
        for name in ("DOTNET-RUNTIME-MIT.txt", "WINDOWS-DESKTOP-RUNTIME-MIT.txt", "DOTNET-THIRD-PARTY-NOTICES.txt"):
            (licenses / name).write_text("Synthetic runtime notice fixture")
        self.assertTrue(builder.validate_app_folder(app)["selfContained"])

    def test_self_contained_metadata_and_filtered_copy(self):
        app = self.app()
        (app / "debug.pdb").write_text("exclude")
        (app / "debug.log").write_text("exclude")
        result = builder.validate_app_folder(app)
        self.assertTrue(result["selfContained"])
        target = self.path / "app-copy"
        builder.copy_app(app, target)
        self.assertFalse((target / "debug.pdb").exists())
        self.assertFalse((target / "debug.log").exists())
        self.assertTrue((target / "coreclr.dll").is_file())
        self.assertTrue((target / "ThirdPartyNotices.txt").is_file())

    def test_existing_destination_is_never_overwritten(self):
        destination = self.path / "existing"
        destination.mkdir()
        file = destination / "user.txt"
        file.write_bytes(b"preserve-me")
        digest = hashlib.sha256(file.read_bytes()).hexdigest()
        with self.assertRaisesRegex(ValueError, "not empty"):
            builder.ensure_empty_destination(destination)
        self.assertEqual(hashlib.sha256(file.read_bytes()).hexdigest(), digest)

    def test_native_binary_hash_must_match_manifest(self):
        root = self.path / "core"
        (root / "bin").mkdir(parents=True)
        (root / "patches").mkdir()
        (root / "sources").mkdir()
        (root / "bin/rufus-huaidj.exe").write_bytes(b"old-native")
        (root / "patches/native-engine.json").write_text(json.dumps({"binary": {"sha256": "0" * 64}}))
        (root / "sources/native-source-manifest.json").write_text("{}")
        with self.assertRaisesRegex(ValueError, "does not match"):
            builder.validate_native_identity(root, root, privacy)

    def test_runtime_private_prefix_and_generic_user_path_are_refused(self):
        self.assertIsNotNone(privacy.private_text_reason(json.dumps(str(ROOT))))
        generic = "Q:" + "\\Users\\" + "private-account" + "\\Documents\\example.txt"
        self.assertEqual(privacy.private_text_reason(generic), "literal user-profile path")
        self.assertIsNone(privacy.private_text_reason("Use the HOME environment variable and a project-relative image alias."))

    def test_installer_asset_contract_uses_array_compatible_record(self):
        file = self.path / "asset.zip"
        file.write_bytes(b"fixture")
        result = builder.asset_record("source", file, "owner/tool", "v0.1.0")
        self.assertEqual(set(result), {"name", "file", "url", "sha256", "archiveRoot"})
        self.assertEqual(result["archiveRoot"], ".")
        self.assertEqual(result["url"], "https://github.com/owner/tool/releases/download/v0.1.0/asset.zip")
        self.assertEqual(result["sha256"], hashlib.sha256(b"fixture").hexdigest())


if __name__ == "__main__":
    unittest.main()
