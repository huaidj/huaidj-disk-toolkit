import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, copyFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const run = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const powershell51 = process.env.WINDIR ? path.join(process.env.WINDIR, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : '';
// Keep fixture strings consistent with the installer's canonical Windows paths.
const baseFixture = path.join(await realpath(tmpdir()), `huaidj-installer-test-${randomUUID().slice(0, 8)}`);

const harness = String.raw`
$ErrorActionPreference='Stop'
. (Join-Path $Project 'scripts\install.ps1')
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
function Check($Condition,[string]$Message){if(-not $Condition){throw "fixture assertion: $Message"}}
function FixtureZip([string]$File,[hashtable]$Files,[string]$Extra=''){
 $zip=[IO.Compression.ZipFile]::Open($File,[IO.Compression.ZipArchiveMode]::Create)
 try{foreach($name in $Files.Keys){$entry=$zip.CreateEntry($name);$stream=$entry.Open();try{$bytes=[Text.Encoding]::UTF8.GetBytes([string]$Files[$name]);$stream.Write($bytes,0,$bytes.Length)}finally{$stream.Dispose()}}
 if($Extra){$entry=$zip.CreateEntry($Extra);$stream=$entry.Open();try{$bytes=[Text.Encoding]::UTF8.GetBytes('escape-fixture');$stream.Write($bytes,0,$bytes.Length)}finally{$stream.Dispose()}}}finally{$zip.Dispose()}
}
function TextSHA([string]$Text){$hash=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)))).Replace('-','').ToLowerInvariant()}finally{$hash.Dispose()}}
function NewFixture([string]$Name,[string]$Extra='',[string]$Omit=''){
 $base=Join-Path $Base $Name;[void][IO.Directory]::CreateDirectory($base)
 $package=Join-Path $base 'package.zip';$nodeZip=Join-Path $base 'node.zip';$psZip=Join-Path $base 'ps.zip'
 $files=@{
  'package.json'='{"name":"installer-fixture","version":"0.1.0","scripts":{"postinstall":"must-never-run"}}'
  'package-lock.json'='{"name":"installer-fixture","version":"0.1.0","lockfileVersion":3,"packages":{"":{"name":"installer-fixture","version":"0.1.0"}}}'
  'config.example.json'='{"powershell":"pwsh","imageRoots":["./images"],"imageAliases":{}}'
  'src/cli.mjs'='// offline fixture: never executed'
  'src/setup.mjs'='// offline fixture: never executed'
  'src/windows-backend.ps1'='# offline fixture: never executed'
  'bin/rufus-huaidj.exe'='not-an-executable-fixture'
  'app/HuaiDJ.Desktop.exe'='optional-desktop-fixture-never-executed'
  'sources/rufus/src/rufus.c'='/* source fixture */'
  'sources/rufus/src/huaidj_autopilot.c'='/* adapter fixture */'
  'sources/rufus/src/format.c'='/* recorded extra source fixture */'
  'patches/native-adapter.patch'='offline patch fixture'
  'skills/huaidj-disk-toolkit/SKILL.md'='# Fixture skill'
  'LICENSE'='GPL-3.0-or-later fixture'
 }
 $sourceFiles=@(foreach($key in @('src/rufus.c','src/huaidj_autopilot.c','src/format.c')){$value=$files['sources/rufus/'+$key];@{path=$key;size=[Text.Encoding]::UTF8.GetByteCount($value);sha256=(TextSHA $value)}})
 $files['sources/native-source-manifest.json']=@{upstreamRepository='https://github.com/pbatard/rufus.git';upstreamCommit=('a'*40);nativeLicense='GPL-3.0-or-later';sourceDirectory='sources/rufus';sourceInventorySha256=('b'*64);sourceFiles=$sourceFiles;patch='patches/native-adapter.patch';patchSha256=(TextSHA $files['patches/native-adapter.patch']);binary=@{path='bin/rufus-huaidj.exe';sha256=(TextSHA $files['bin/rufus-huaidj.exe'])}}|ConvertTo-Json -Depth 8
 if($Omit){$files.Remove($Omit)}
 FixtureZip $package $files $Extra
 FixtureZip $nodeZip @{'node-v24.22.3-win-x64/node.exe'='not-an-executable';'node-v24.22.3-win-x64/node_modules/npm/bin/npm-cli.js'='// never executed'}
 FixtureZip $psZip @{'pwsh.exe'='not-an-executable'}
 $manifest=[ordered]@{schemaVersion=1;version='0.1.0';tag='v0.1.0';repository='yutianyu111602-glitch/huaidj-disk-toolkit';assets=@(@{name='windows-x64';file='huaidj-disk-toolkit-v0.1.0-windows-x64.zip';url='https://github.com/yutianyu111602-glitch/huaidj-disk-toolkit/releases/download/v0.1.0/huaidj-disk-toolkit-v0.1.0-windows-x64.zip';sha256=(Get-HuaiDJSHA256 $package);archiveRoot='.'});dependencies=@{node=@{version='24.22.3';platforms=@{'windows-x64'=@{file='node-v24.22.3-win-x64.zip';url='https://nodejs.org/dist/v24.22.3/node-v24.22.3-win-x64.zip';sha256=(Get-HuaiDJSHA256 $nodeZip);checksumsUrl='https://nodejs.org/dist/v24.22.3/SHASUMS256.txt';archiveRoot='node-v24.22.3-win-x64';entry='node.exe'}}};powershell=@{version='7.6.6';platforms=@{'windows-x64'=@{file='PowerShell-7.6.6-win-x64.zip';url='https://github.com/PowerShell/PowerShell/releases/download/v7.6.6/PowerShell-7.6.6-win-x64.zip';sha256=(Get-HuaiDJSHA256 $psZip);checksumsUrl='https://github.com/PowerShell/PowerShell/releases/download/v7.6.6/hashes.sha256';archiveRoot='.';entry='pwsh.exe'}}}}}
 return @{base=$base;package=$package;nodeZip=$nodeZip;psZip=$psZip;manifest=$manifest;install=(Join-Path $base 'install root')}
}
$script:downloads=New-Object 'Collections.Generic.List[string]'
$script:commands=New-Object 'Collections.Generic.List[object]'
$download={param($Url,$Destination)
 $script:downloads.Add($Url)
 if($Url -eq $f.manifest.assets[0].url){[IO.File]::Copy($f.package,$Destination,$false)}
 elseif($Url -eq $f.manifest.dependencies.node.platforms.'windows-x64'.url){[IO.File]::Copy($f.nodeZip,$Destination,$false)}
 elseif($Url -eq $f.manifest.dependencies.powershell.platforms.'windows-x64'.url){[IO.File]::Copy($f.psZip,$Destination,$false)}
 else{throw 'unexpected offline download route'}
}
$text={param($Url)
 if($Url -eq $f.manifest.dependencies.node.platforms.'windows-x64'.checksumsUrl){return ($f.manifest.dependencies.node.platforms.'windows-x64'.sha256+'  node-v24.22.3-win-x64.zip')}
 if($Url -eq $f.manifest.dependencies.powershell.platforms.'windows-x64'.checksumsUrl){return ($f.manifest.dependencies.powershell.platforms.'windows-x64'.sha256+' *PowerShell-7.6.6-win-x64.zip')}
 throw 'unexpected offline text route'
}
$probe={return @{node=$null;powershell=$null}}
$runner={param($Exe,$Argv,$Cwd,$IsNpm)
 $script:commands.Add(@{exe=$Exe;argv=@($Argv);cwd=$Cwd;npm=$IsNpm})
 if($IsNpm){[void][IO.Directory]::CreateDirectory((Join-Path $Cwd 'node_modules'));return @{exitCode=0;stdout='';stderr=''}}
 if($Argv -contains '--apply'){return @{exitCode=0;stdout='{"status":"applied","applied":true}';stderr=''}}
 return @{exitCode=0;stdout='{"status":"ready","changesNeeded":true,"applied":false}';stderr=''}
}
function InstallFixture($Options){Invoke-HuaiDJInstaller -Options $Options -Manifest $f.manifest -DownloadProvider $download -TextProvider $text -RuntimeProbe $probe -CommandRunner $runner}
`;

async function psCase(name, body, { sourceRoot = projectRoot } = {}) {
  const directory = path.join(baseFixture, name);
  await mkdir(directory, { recursive: true });
  try { await writeFile(path.join(baseFixture, 'fixture-owner.json'), JSON.stringify({ schemaVersion: 1, owner: 'tests/installers.test.mjs', purpose: 'Owned offline installer fixtures', createdUTC: new Date().toISOString(), fixtureRoot: baseFixture }, null, 2) + '\n', { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const script = path.join(directory, 'test.ps1');
  const preamble = `$Project='${sourceRoot.replaceAll("'", "''")}';$Base='${directory.replaceAll("'", "''")}'\r\n`;
  await writeFile(script, preamble + harness + '\r\n' + body, 'utf8');
  const result = await run(powershell51, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true, timeout: 30000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' });
  return JSON.parse(result.stdout.trim());
}

test('PowerShell 5.1 parses the public installer and correctly decodes the official UTF-16 checksum format', { skip: process.platform !== 'win32' }, async () => {
  const result = await psCase('parse', String.raw`
$tokens=$null;$problems=$null;[void][Management.Automation.Language.Parser]::ParseFile((Join-Path $Project 'scripts\install.ps1'),[ref]$tokens,[ref]$problems)
Check ($problems.Count -eq 0) 'PS5.1 syntax'
$bytes=[Text.Encoding]::Unicode.GetPreamble()+[Text.Encoding]::Unicode.GetBytes(('a'*64)+' *PowerShell-7.6.6-win-x64.zip')
Assert-HuaiDJChecksumText (ConvertFrom-HuaiDJBytes $bytes) 'PowerShell-7.6.6-win-x64.zip' ('a'*64)
@{ok=$true;ps=$PSVersionTable.PSVersion.Major}|ConvertTo-Json
`);
  assert.deepEqual(result, { ok: true, ps: 5 });
});

test('offline default preview installs nothing and downloads no package or portable dependency', { skip: process.platform !== 'win32' }, async () => {
  const result = await psCase('preview', String.raw`
$f=NewFixture 'data';$result=InstallFixture @{InstallRoot=$f.install;Flavor='Mcp';Client='codex';Apply=$false}
Check (-not(Test-Path -LiteralPath $f.install)) 'preview root untouched'
Check ($script:downloads.Count -eq 0 -and $script:commands.Count -eq 0) 'preview no downloads or setup'
@{status=$result.status;node=$result.willDownloadNode;ps=$result.willDownloadPowerShell}|ConvertTo-Json
`);
  assert.deepEqual(result, { status: 'preview', node: true, ps: true });
});

test('install-root precedence is explicit option, neutral toolkit environment, then standard local user data', { skip: process.platform !== 'win32' }, async () => {
  const result = await psCase('root-selection', String.raw`
$f=NewFixture 'data';$env:HUAIDJ_TOOLKIT_HOME=Join-Path $f.base 'preferred';$env:LOCALAPPDATA=Join-Path $f.base 'local-data'
Check ((Resolve-HuaiDJInstallRoot $f.install) -eq $f.install) 'explicit root first'
Check ((Resolve-HuaiDJInstallRoot '') -eq $env:HUAIDJ_TOOLKIT_HOME) 'neutral environment second'
$env:HUAIDJ_TOOLKIT_HOME=''
Check ((Resolve-HuaiDJInstallRoot '') -eq (Join-Path $env:LOCALAPPDATA 'HuaiDJ\DiskToolkit')) 'standard user data fallback'
@{ok=$true}|ConvertTo-Json
`);
  assert.deepEqual(result, { ok: true });
});

test('deep source locations use independent short temporary fixtures while unsafe long install roots stay refused', { skip: process.platform !== 'win32' }, async () => {
  const deepSource = path.join(baseFixture, 'deep-source', 's'.repeat(96));
  await mkdir(path.join(deepSource, 'scripts'), { recursive: true });
  await copyFile(path.join(projectRoot, 'scripts', 'install.ps1'), path.join(deepSource, 'scripts', 'install.ps1'));
  assert.equal(deepSource.length > 140, true);
  const result = await psCase('deep', String.raw`
$f=NewFixture 'data'
Check ($Project.Length -gt 140 -and $f.install.Length -le 140) 'source path depth does not lengthen fake runtime root'
$result=InstallFixture @{InstallRoot=$f.install;Apply=$true;RuntimeOnly=$true}
Check ($result.status -eq 'ready') 'short independent runtime installs from deep source'
$unsafe=Join-Path ([IO.Path]::GetPathRoot($Base)) ('unsafe-'+('x'*150));$code=''
try{$null=Resolve-HuaiDJInstallRoot $unsafe}catch{$code=$_.Exception.Message}
Check ($code -match 'INSTALL_ROOT_TOO_BROAD') 'production long-root restriction remains active'
Check (-not(Test-Path -LiteralPath $unsafe)) 'unsafe long path was not created'
@{ok=$true}|ConvertTo-Json
`, { sourceRoot: deepSource });
  assert.deepEqual(result, { ok: true });
});

test('offline apply verifies package and official pins, installs fake fixtures only and targets exactly one generic setup client', { skip: process.platform !== 'win32' }, async () => {
  const result = await psCase('apply', String.raw`
$f=NewFixture 'data';$result=InstallFixture @{InstallRoot=$f.install;Flavor='Mcp';Client='codex';Apply=$true}
Check ($result.status -eq 'ready' -and $result.configurationApplied) 'ready setup'
Check ($script:downloads.Count -eq 3) 'one package and two missing dependencies'
Check ($script:commands.Count -eq 3) 'npm plus preview plus apply'
Check ($script:commands[0].argv -contains 'ci') 'lockfile ci'
Check ($script:commands[0].argv -contains '--ignore-scripts') 'lifecycle scripts disabled'
Check ($script:commands[1].argv[1] -eq 'setup-mcp' -and $script:commands[1].argv[3] -eq 'codex') 'only explicit client'
Check ($script:commands[2].argv -contains '--apply') 'generic setup apply'
$config=Get-Content -LiteralPath (Join-Path $f.install 'versions\v0.1.0\windows-x64\app\config.json') -Raw|ConvertFrom-Json
Check ($config.powershell -eq (Join-Path $f.install 'versions\v0.1.0\windows-x64\runtimes\powershell\pwsh.exe')) 'portable powershell persistent path'
$receipt=Get-Content -LiteralPath (Join-Path $f.install 'versions\v0.1.0\windows-x64\install-receipt.json') -Raw|ConvertFrom-Json
Check ($receipt.nodePath -eq $result.nodePath -and $receipt.powershellPath -eq $result.powershellPath -and $receipt.cliPath -eq $result.cliPath -and $receipt.toolkitRoot -eq $result.toolkitRoot) 'GUI receipt discovery matches ready output'
Check ($result.cliPath -eq (Join-Path $result.toolkitRoot 'src\cli.mjs')) 'core path remains independent of optional desktop binaries'
@{ok=$true;commands=$script:commands.Count;cli=$result.cliArgs.Count}|ConvertTo-Json
`);
  assert.deepEqual(result, { ok: true, commands: 3, cli: 1 });
});

test('Skill RuntimeOnly works from a standalone copied script and never registers MCP or an external skill folder', { skip: process.platform !== 'win32' }, async () => {
  const result = await psCase('skill', String.raw`
$f=NewFixture 'data';$result=InstallFixture @{InstallRoot=$f.install;Flavor='Skill';Client='claude-code';SkillTarget=(Join-Path $f.base 'external\huaidj-disk-toolkit');RuntimeOnly=$true;Apply=$true}
Check ($script:commands.Count -eq 1 -and -not $result.configurationApplied) 'runtime-only no registration'
Check (-not(Test-Path -LiteralPath (Join-Path $f.base 'external'))) 'external skill untouched'
@{ok=$true;commands=$script:commands.Count}|ConvertTo-Json
`);
  assert.deepEqual(result, { ok: true, commands: 1 });
});

test('canonical packaged corresponding source is mandatory and partial source packages stop before dependency execution', { skip: process.platform !== 'win32' }, async () => {
  const result = await psCase('source-layout', String.raw`
foreach($missing in @('sources/native-source-manifest.json','sources/rufus/src/huaidj_autopilot.c','sources/rufus/src/format.c')){
 $f=NewFixture ('missing-'+[IO.Path]::GetFileName($missing)) -Omit $missing;$code=''
 $commandCount=$script:commands.Count;$downloadCount=$script:downloads.Count
 try{$null=InstallFixture @{InstallRoot=$f.install;Apply=$true;RuntimeOnly=$true}}catch{$code=$_.Exception.Message}
 Check ($code -match 'INCOMPLETE_TOOLKIT_PACKAGE') 'missing or partial canonical source rejected'
 Check ($script:commands.Count -eq $commandCount -and $script:downloads.Count -eq $downloadCount+1) 'only package downloaded, no dependencies or commands'
 Check (-not(Test-Path -LiteralPath (Join-Path $f.install 'versions\v0.1.0\windows-x64'))) 'no completed runtime'
}
@{ok=$true}|ConvertTo-Json
`);
  assert.deepEqual(result, { ok: true });
});

test('Skill with an explicit target invokes only setup-skill without requiring an MCP client', { skip: process.platform !== 'win32' }, async () => {
  const result = await psCase('skill-target', String.raw`
$f=NewFixture 'data';$target=Join-Path $f.base 'selected-skill'
$result=InstallFixture @{InstallRoot=$f.install;Flavor='Skill';SkillTarget=$target;Apply=$true}
Check ($script:commands.Count -eq 3) 'npm plus skill preview and apply'
Check ($script:commands[1].argv[1] -eq 'setup-skill' -and $script:commands[1].argv[2] -eq '--target' -and $script:commands[1].argv[3] -eq $target) 'only explicit skill target'
Check ($result.configurationApplied) 'skill setup applied'
@{ok=$true}|ConvertTo-Json
`);
  assert.deepEqual(result, { ok: true });
});

test('a corrupt package is retained as incomplete evidence and never extracted or executed', { skip: process.platform !== 'win32' }, async () => {
  const result = await psCase('bad-hash', String.raw`
$f=NewFixture 'data';[IO.File]::AppendAllText($f.package,'tamper');$code=''
try{$null=InstallFixture @{InstallRoot=$f.install;Apply=$true}}catch{$code=$_.Exception.Message}
Check ($code -match 'CHECKSUM_MISMATCH') 'hash blocked'
Check ($script:commands.Count -eq 0) 'no execution'
Check (-not(Test-Path -LiteralPath (Join-Path $f.install 'versions\v0.1.0\windows-x64'))) 'no completed runtime'
Check (@(Get-ChildItem -LiteralPath (Join-Path $f.install '.staging') -Recurse -Filter incomplete.json).Count -eq 1) 'incomplete evidence retained'
@{ok=$true}|ConvertTo-Json
`);
  assert.deepEqual(result, { ok: true });
});

test('checked zip extraction rejects traversal, duplicate case and symlink entries before writing archive files', { skip: process.platform !== 'win32' }, async () => {
  const result = await psCase('zip-paths', String.raw`
$f=NewFixture 'traversal' '../escape.txt';$code=''
try{$null=InstallFixture @{InstallRoot=$f.install;Apply=$true}}catch{$code=$_.Exception.Message};Check ($code -match 'UNSAFE_ARCHIVE_PATH') 'traversal blocked'
Check (-not(Test-Path -LiteralPath (Join-Path $f.install 'escape.txt'))) 'no escaped write'
$duplicate=Join-Path $Base 'duplicate.zip';$zip=[IO.Compression.ZipFile]::Open($duplicate,[IO.Compression.ZipArchiveMode]::Create);$null=$zip.CreateEntry('A.txt');$null=$zip.CreateEntry('a.TXT');$zip.Dispose()
$code='';try{Expand-HuaiDJCheckedZip $duplicate (Join-Path $Base 'duplicate-out')}catch{$code=$_.Exception.Message};Check ($code -match 'DUPLICATE_ARCHIVE_PATH') 'case collision blocked'
$linkZip=Join-Path $Base 'link.zip';$zip=[IO.Compression.ZipFile]::Open($linkZip,[IO.Compression.ZipArchiveMode]::Create);$entry=$zip.CreateEntry('link');$entry.ExternalAttributes=-1577123840;$zip.Dispose()
$code='';try{Expand-HuaiDJCheckedZip $linkZip (Join-Path $Base 'link-out')}catch{$code=$_.Exception.Message};Check ($code -match 'ARCHIVE_LINK_FORBIDDEN') 'symlink blocked'
@{ok=$true}|ConvertTo-Json
`);
  assert.deepEqual(result, { ok: true });
});

test('official checksum disagreement and arbitrary dependency endpoints fail closed before dependency execution', { skip: process.platform !== 'win32' }, async () => {
  const result = await psCase('pins', String.raw`
$f=NewFixture 'checksum';$badText={param($Url)return ('0'*64)+'  node-v24.22.3-win-x64.zip'};$code=''
try{$null=Invoke-HuaiDJInstaller -Options @{InstallRoot=$f.install;Apply=$true} -Manifest $f.manifest -DownloadProvider $download -TextProvider $badText -RuntimeProbe $probe -CommandRunner $runner}catch{$code=$_.Exception.Message}
Check ($code -match 'OFFICIAL_DIGEST_MISMATCH') 'official mismatch blocked';Check ($script:commands.Count -eq 0) 'no dep execution'
$f=NewFixture 'endpoint';$f.manifest.dependencies.node.platforms.'windows-x64'.url='https://invalid.example/node.zip';$code=''
try{$null=InstallFixture @{InstallRoot=$f.install;Apply=$true}}catch{$code=$_.Exception.Message};Check ($code -match 'UNTRUSTED_DEPENDENCY_SOURCE') 'endpoint blocked'
@{ok=$true}|ConvertTo-Json
`);
  assert.deepEqual(result, { ok: true });
});

test('repeating the same release reuses its runtime, preserves custom config and rejects edited runtime code', { skip: process.platform !== 'win32' }, async () => {
  const result = await psCase('reuse', String.raw`
$f=NewFixture 'data';$null=InstallFixture @{InstallRoot=$f.install;Apply=$true;RuntimeOnly=$true}
$configFile=Join-Path $f.install 'versions\v0.1.0\windows-x64\app\config.json';[IO.File]::WriteAllText($configFile,'{"custom":"preserve-me","powershell":"custom-host"}')
$result=InstallFixture @{InstallRoot=$f.install;Apply=$true;RuntimeOnly=$true}
Check ($result.runtimeReused -and $script:downloads.Count -eq 3 -and $script:commands.Count -eq 1) 'reuse no redownload or npm'
Check ((Get-Content -LiteralPath $configFile -Raw) -match 'preserve-me') 'config preserved'
[IO.File]::AppendAllText((Join-Path $f.install 'versions\v0.1.0\windows-x64\app\src\cli.mjs'),'tampered')
$code='';try{$null=InstallFixture @{InstallRoot=$f.install;Apply=$true;RuntimeOnly=$true}}catch{$code=$_.Exception.Message};Check ($code -match 'CHECKSUM_MISMATCH') 'changed runtime preserved and blocked'
@{ok=$true}|ConvertTo-Json
`);
  assert.deepEqual(result, { ok: true });
});

test('an existing install-root lock refuses concurrent installation before any package download', { skip: process.platform !== 'win32' }, async () => {
  const result = await psCase('busy', String.raw`
$f=NewFixture 'data';[void][IO.Directory]::CreateDirectory($f.install)
$guard=New-Object IO.FileStream((Join-Path $f.install '.install.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
$code='';try{try{$null=InstallFixture @{InstallRoot=$f.install;Apply=$true}}catch{$code=$_.Exception.Message}}finally{$guard.Dispose()}
Check ($code -match 'INSTALLER_BUSY' -and $script:downloads.Count -eq 0) 'parallel installer blocked'
@{ok=$true}|ConvertTo-Json
`);
  assert.deepEqual(result, { ok: true });
});

test('UTF-8 receipts preserve non-ASCII local install paths during reuse', { skip: process.platform !== 'win32' }, async () => {
  const result = await psCase('unicode', String.raw`
$f=NewFixture 'data';$f.install=Join-Path $f.base ('install-'+[char]0x5B89+[char]0x88DD)
$null=InstallFixture @{InstallRoot=$f.install;Apply=$true;RuntimeOnly=$true}
$result=InstallFixture @{InstallRoot=$f.install;Apply=$true;RuntimeOnly=$true}
Check ($result.runtimeReused -and $script:downloads.Count -eq 3 -and $result.cliCommand.Contains([char]0x5B89)) 'unicode path reused intact'
@{ok=$true}|ConvertTo-Json
`);
  assert.deepEqual(result, { ok: true });
});

test('native argument quoting and npm child environment isolation work without a shell or real token', { skip: process.platform !== 'win32' }, async () => {
  const result = await psCase('argv', String.raw`
$env:NPM_TOKEN='fixture-only';$env:NODE_AUTH_TOKEN='fixture-only';$node=(Get-Command node.exe -CommandType Application|Select-Object -First 1).Source
$program='console.log(JSON.stringify({args:process.argv.slice(1),npm:Object.hasOwn(process.env,"NPM_TOKEN"),auth:Object.hasOwn(process.env,"NODE_AUTH_TOKEN")}))'
$reply=Invoke-HuaiDJCommand -FilePath $node -Arguments @('-e',$program,'path with spaces\','quote"inside') -WorkingDirectory $Base -NpmIsolated
$result=$reply.stdout|ConvertFrom-Json
Check ($result.args[0] -ceq 'path with spaces\' -and $result.args[1] -ceq 'quote"inside') 'exact argv'
Check (-not $result.npm -and -not $result.auth) 'tokens absent in npm child'
@{ok=$true}|ConvertTo-Json
`);
  assert.deepEqual(result, { ok: true });
});

test('published bootstrap sources contain no eager remote script execution, admin installer or latest release selector', async () => {
  const script = await readFile(path.join(projectRoot, 'scripts', 'install.ps1'), 'utf8');
  assert.doesNotMatch(script, /Invoke-Expression|\birm\b|\bRunAs\b|Set-ExecutionPolicy|setx\s|releases\/latest/i);
  assert.match(script, /--ignore-scripts/);
  assert.match(script, /release-manifest\.json/);
});

function zipPolicyFixture(name, { localName = name, mode = 0x81a4, size = 1 } = {}) {
  const centralName = Buffer.from(name), localNameBytes = Buffer.from(localName);
  const header = Buffer.alloc(30 + localNameBytes.length);
  header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
  header.writeUInt32LE(1, 18); header.writeUInt32LE(size, 22); header.writeUInt16LE(localNameBytes.length, 26); localNameBytes.copy(header, 30);
  const data = Buffer.from('x'), central = Buffer.alloc(46 + centralName.length);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8);
  central.writeUInt32LE(1, 20); central.writeUInt32LE(size, 24); central.writeUInt16LE(centralName.length, 28);
  central.writeUInt32LE((mode * 65536) >>> 0, 38); centralName.copy(central, 46);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(header.length + data.length, 16);
  return Buffer.concat([header, data, central, end]);
}

test('the self-contained Unix ZIP policy accepts a regular fixture and rejects traversal, links, local-name mismatch and expansion bombs', async () => {
  const shell = await readFile(path.join(projectRoot, 'scripts', 'bootstrap.sh'), 'utf8');
  const source = shell.match(/\/\/ HUAIDJ_ZIP_POLICY_BEGIN\r?\n([\s\S]*?)\/\/ HUAIDJ_ZIP_POLICY_END/)?.[1];
  assert.ok(source, 'audited inline ZIP policy is available');
  const context = { Buffer }; vm.createContext(context); vm.runInContext(source + '\nthis.policy=inspectZip;', context);
  const policy = context.policy;
  assert.equal(policy(zipPolicyFixture('src/cli.mjs')).entries, 1);
  for (const fixture of [zipPolicyFixture('../escape'), zipPolicyFixture('link', { mode: 0xa1ff }), zipPolicyFixture('safe', { localName: '../escape' }), zipPolicyFixture('bomb', { size: 1700000000 })])
    assert.throws(() => policy(fixture), error => error.code === 'UNSAFE_SOURCE_ARCHIVE');
  assert.doesNotMatch(shell, /releases\/latest|\bcurl[^\n]*\|\s*(sh|bash)|\beval\b/);
  const pins = JSON.parse(await readFile(path.join(projectRoot, 'installers', 'dependencies.json'), 'utf8'));
  for (const platform of ['darwin-arm64','darwin-x64','linux-arm64','linux-x64']) assert.ok(shell.includes(pins.node.platforms[platform].sha256));
});
