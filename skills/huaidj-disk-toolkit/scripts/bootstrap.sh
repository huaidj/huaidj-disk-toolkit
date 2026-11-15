#!/usr/bin/env bash
# HuaiDJ Disk Toolkit v0.1.0 audited bootstrap. GPL-3.0-or-later.
# macOS/Linux reference/query/Skill/stdio runtime only; physical disk adapters are Windows-only.
set -euo pipefail
umask 077
version=0.1.0
tag=v0.1.0
repository=yutianyu111602-glitch/huaidj-disk-toolkit
node_version=24.22.3
apply=false
runtime_only=false
flavor=Mcp
client=
skill_target=
install_root=${HUAIDJ_TOOLKIT_HOME:-${XDG_DATA_HOME:-${HOME:?HOME is required}/.local/share}/huaidj-disk-toolkit}
fail() { printf '[%s] %s\n' "$1" "$2" >&2; exit 1; }
while (($#)); do
  case "$1" in
    --apply) apply=true; shift ;;
    --runtime-only) runtime_only=true; shift ;;
    --install-root|--flavor|--client|--skill-target)
      (($# >= 2)) || fail INVALID_ARGUMENT 'A selected option requires a value.'
      case "$1" in --install-root) install_root=$2;; --flavor) flavor=$2;; --client) client=$2;; --skill-target) skill_target=$2;; esac
      shift 2 ;;
    *) fail INVALID_ARGUMENT 'Use --apply, --runtime-only, --install-root, --flavor, --client or --skill-target.' ;;
  esac
done
case "$flavor" in Skill|skill) flavor=Skill;; Mcp|mcp) flavor=Mcp;; *) fail INVALID_FLAVOR 'Select Skill or Mcp.';; esac
case "$client" in ''|codex|claude-code|claude-desktop|gemini|opencode|vscode) ;; *) fail INVALID_CLIENT 'Select exactly one supported client.';; esac
case "$(uname -s):$(uname -m)" in
  Darwin:arm64) platform=darwin-arm64; node_sha=ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd ;;
  Darwin:x86_64) platform=darwin-x64; node_sha=977614af0504c81045e7fd85596dbca0e5f951b96681516dadafedcca8c447f7 ;;
  Linux:aarch64|Linux:arm64) platform=linux-arm64; node_sha=261af2af250dfd7e9f25cf151d1b2713a0adf8f10a9ad116c4947f68627affe8 ;;
  Linux:x86_64) platform=linux-x64; node_sha=061ec3e3062115705b56b51fa9cc330ab50d34b6969387d4e4b1a50c6809acc2 ;;
  *) fail PLATFORM_UNSUPPORTED 'This bootstrap supports macOS/Linux x64 or arm64. On Windows run the bundled PowerShell installer.' ;;
esac
for tool in curl tar unzip awk; do command -v "$tool" >/dev/null || fail BOOTSTRAP_TOOL_REQUIRED "The standard system tool $tool is required; this script does not use sudo or change system packages."; done
if command -v sha256sum >/dev/null; then hash_file() { sha256sum "$1" | awk '{print tolower($1)}'; }
elif command -v shasum >/dev/null; then hash_file() { shasum -a 256 "$1" | awk '{print tolower($1)}'; }
else fail SHA256_TOOL_REQUIRED 'sha256sum or shasum is required.'; fi
[[ "$install_root" = /* && "$install_root" != / && "$install_root" != "$HOME" && "$install_root" != *$'\n'* ]] || fail INSTALL_ROOT_REQUIRED 'Choose an absolute application subdirectory.'
install_root=${install_root%/}
check_no_links() {
  local value=$1 current= part
  [[ "$value" = /* ]] || fail LOCAL_PATH_REQUIRED 'An absolute local path is required.'
  IFS=/ read -r -a components <<< "$value"
  for part in "${components[@]}"; do [[ -z "$part" ]] && continue; [[ "$part" != . && "$part" != .. ]] || fail INVALID_INSTALL_ROOT 'Dot path components are not accepted.'; current=$current/$part; [[ ! -L "$current" ]] || fail LINKED_INSTALL_ROOT 'Choose an ordinary path without symbolic-link ancestors.'; done
}
check_no_links "$install_root"
node_cmd=$(command -v node || true)
npm_cmd=$(command -v npm || true)
usable_node=false
if [[ -n "$node_cmd" && -x "$node_cmd" && -n "$npm_cmd" && -x "$npm_cmd" ]]; then
  actual_version=$("$node_cmd" --version 2>/dev/null || true)
  if [[ "$actual_version" =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
    major=${BASH_REMATCH[1]}; minor=${BASH_REMATCH[2]}
    if ((10#$major > 22 || (10#$major == 22 && 10#$minor >= 15))); then usable_node=true; fi
  fi
fi
manifest_url=https://github.com/$repository/releases/download/$tag/release-manifest.json
if [[ "$apply" = false && "$usable_node" = false ]]; then
  printf '{"status":"preview","version":"0.1.0","nodeDownloadRequired":true,"releaseManifestVerificationPending":true,"configurationApplied":false,"physicalDiskAdapter":"Windows-only","elevationRequested":false}\n'
  exit 0
fi
install_lock=
release_lock() { if [[ -n "$install_lock" && -f "$install_lock/owner" && "$(cat "$install_lock/owner")" = "$$" ]]; then rm -- "$install_lock/owner"; rmdir -- "$install_lock"; fi; }
if [[ "$apply" = true ]]; then
  mkdir -p "$install_root"
  install_lock=$install_root/.install-lock
  mkdir "$install_lock" 2>/dev/null || fail INSTALLER_BUSY 'Another installer owns this install root; existing files were preserved.'
  printf '%s\n' "$$" > "$install_lock/owner"
  trap release_lock EXIT
fi
# --disable prevents reading a user curlrc; no credentials, token lookup or remote script execution is used.
manifest=$(curl --disable --fail --show-error --silent --location "$manifest_url") || fail RELEASE_NOT_AVAILABLE 'The fixed manifest is not published or cannot be downloaded. Release download verification remains pending.'
if [[ "$usable_node" = false ]]; then
  [[ "$apply" = true ]] || fail NODE_REQUIRED 'Node.js 22.15 or newer is required.'
  node_file=node-v$node_version-$platform.tar.gz
  node_url=https://nodejs.org/dist/v$node_version/$node_file
  node_home=$install_root/runtimes/node-v$node_version-$platform
  if [[ -e "$node_home" ]]; then
    check_no_links "$node_home"
    [[ -f "$node_home/.node-sha256" && -x "$node_home/bin/node" && "$(hash_file "$node_home/bin/node")" = "$(cat "$node_home/.node-sha256")" ]] || fail NODE_RUNTIME_CONFLICT 'The existing portable Node runtime has no matching integrity receipt and was preserved.'
  else
    mkdir -p "$install_root/.staging" "$install_root/runtimes"
    stage=$(mktemp -d "$install_root/.staging/node.XXXXXXXX")
    sums=$(curl --disable --fail --show-error --silent --location "https://nodejs.org/dist/v$node_version/SHASUMS256.txt")
    official=$(printf '%s\n' "$sums" | awk -v wanted="$node_file" '{name=$2;sub(/^\*/,"",name);if(name==wanted)print tolower($1)}')
    [[ "$official" = "$node_sha" ]] || fail OFFICIAL_DIGEST_MISMATCH 'The official Node digest differs from the audited bootstrap pin.'
    curl --disable --fail --show-error --silent --location "$node_url" --output "$stage/node.tar.gz"
    [[ "$(hash_file "$stage/node.tar.gz")" = "$node_sha" ]] || fail CHECKSUM_MISMATCH 'Portable Node did not match its official digest and was not executed.'
    # Only the hash-pinned official Node archive is accepted by this pre-Node tar step.
    while IFS= read -r entry; do case "$entry" in /*|../*|*/../*|*/..) fail UNSAFE_ARCHIVE_PATH 'The official archive has an unsafe path.';; esac; done < <(tar -tzf "$stage/node.tar.gz")
    tar -xzf "$stage/node.tar.gz" -C "$stage"
    extracted=$stage/node-v$node_version-$platform
    [[ -x "$extracted/bin/node" && -f "$extracted/lib/node_modules/npm/bin/npm-cli.js" ]] || fail NODE_PACKAGE_INCOMPLETE 'The pinned portable Node package is incomplete.'
    hash_file "$extracted/bin/node" > "$extracted/.node-sha256"
    [[ ! -e "$node_home" ]] || fail NODE_RUNTIME_APPEARED 'A portable runtime appeared during preparation; neither version was overwritten.'
    mv "$extracted" "$node_home"
  fi
  node_cmd=$node_home/bin/node
  npm_cmd=$node_home/bin/npm
fi
"$node_cmd" --input-type=module - "$manifest" "$install_root" "$flavor" "$client" "$skill_target" "$runtime_only" "$apply" "$platform" "$node_sha" "$npm_cmd" <<'HUAIDJ_NODE_INSTALLER'
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
const [manifestText,root,flavor,client,skillTarget,runtimeOnly,apply,platform,nodePin,npmCommand]=process.argv.slice(2);
const failure=(code,message)=>{throw Object.assign(new Error(message),{code,managed:true});};
const hash=file=>{const info=fs.lstatSync(file);if(!info.isFile()||info.isSymbolicLink())failure('REGULAR_INSTALL_FILE_REQUIRED','Installation integrity checks require ordinary files.');return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');};
const repo='yutianyu111602-glitch/huaidj-disk-toolkit',tag='v0.1.0';
const isHash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/i.test(value);
// HUAIDJ_ZIP_POLICY_BEGIN
function inspectZip(buffer){
  const bad=message=>{throw Object.assign(new Error(message),{code:'UNSAFE_SOURCE_ARCHIVE'});};
  let end=-1;
  for(let p=buffer.length-22;p>=Math.max(0,buffer.length-65557);p--)if(buffer.readUInt32LE(p)===0x06054b50&&p+22+buffer.readUInt16LE(p+20)===buffer.length){end=p;break;}
  if(end<0)bad('The source ZIP has no valid central directory.');
  const count=buffer.readUInt16LE(end+10),offset=buffer.readUInt32LE(end+16),length=buffer.readUInt32LE(end+12);
  if(buffer.readUInt16LE(end+4)||buffer.readUInt16LE(end+6)||buffer.readUInt16LE(end+8)!==count||count===65535||count>100000||offset+length>end)bad('Multi-disk, ZIP64 or oversized source archives are unsupported.');
  const names=new Map();let p=offset,total=0;
  for(let i=0;i<count;i++){
    if(p+46>buffer.length||buffer.readUInt32LE(p)!==0x02014b50)bad('Invalid source ZIP entry.');
    const flags=buffer.readUInt16LE(p+8),method=buffer.readUInt16LE(p+10),compressed=buffer.readUInt32LE(p+20),size=buffer.readUInt32LE(p+24),n=buffer.readUInt16LE(p+28),extra=buffer.readUInt16LE(p+30),comment=buffer.readUInt16LE(p+32),attributes=buffer.readUInt32LE(p+38),local=buffer.readUInt32LE(p+42);
    if(p+46+n+extra+comment>offset+length||flags&1||![0,8].includes(method))bad('Encrypted or unsupported source ZIP entries are rejected.');
    const name=buffer.subarray(p+46,p+46+n).toString('utf8'),directory=name.endsWith('/'),parts=name.replace(/\/$/,'').split('/');
    if(local+30>offset||buffer.readUInt32LE(local)!==0x04034b50)bad('A source ZIP local header is invalid.');
    const localName=buffer.readUInt16LE(local+26),localExtra=buffer.readUInt16LE(local+28);
    if(local+30+localName+localExtra+compressed>offset||!buffer.subarray(local+30,local+30+localName).equals(buffer.subarray(p+46,p+46+n)))bad('Source ZIP local and central names do not match.');
    for(const [start,size] of [[p+46+n,extra],[local+30+localName,localExtra]])for(let q=start;q<start+size;){if(q+4>start+size)bad('A source ZIP extra field is truncated.');const id=buffer.readUInt16LE(q),length=buffer.readUInt16LE(q+2);if(q+4+length>start+size||[0x0001,0x7075].includes(id))bad('ZIP64 or alternate-name source entries are rejected.');q+=4+length;}
    if(!name||name.startsWith('/')||name.includes('\\')||name.includes(':')||/[\x00-\x1f]/.test(name)||parts.some(x=>!x||x==='.'||x==='..'))bad('A source ZIP path escapes its private staging root.');
    const mode=attributes>>>16&0xf000;
    if((mode&&mode!==0x8000&&mode!==0x4000)||(attributes&0x400))bad('Source archive links and special nodes are rejected.');
    const folded=parts.join('/').toLowerCase();
    if(names.has(folded)&&names.get(folded)!=='implicit')bad('Source archive paths collide.');
    if(names.get(folded)==='implicit'&&!directory)bad('A source archive file replaces a directory.');
    names.set(folded,directory?'directory':'file');
    for(let j=1;j<parts.length;j++){const parent=parts.slice(0,j).join('/').toLowerCase();if(names.get(parent)==='file')bad('A source file is used as a parent directory.');if(!names.has(parent))names.set(parent,'implicit');}
    total+=size;if(total>1610612736)bad('The expanded source archive exceeds its bounded limit.');p+=46+n+extra+comment;
  }
  if(p!==offset+length)bad('Source ZIP central directory size does not match its parsed entries.');
  return {entries:count,expandedBytes:total};
}
// HUAIDJ_ZIP_POLICY_END
function plainChain(filename){let current=path.parse(filename).root;for(const part of filename.slice(current.length).split(path.sep).filter(Boolean)){current=path.join(current,part);if(fs.existsSync(current)&&fs.lstatSync(current).isSymbolicLink())failure('LINKED_INSTALL_ROOT','A linked install path was preserved.');}}
function command(exe,args,cwd,{npm=false}={}){
  const env={...process.env};
  if(npm)for(const key of Object.keys(env))if(/^NPM_CONFIG_|^(NPM_TOKEN|NODE_AUTH_TOKEN|GITHUB_TOKEN|GH_TOKEN)$/i.test(key))delete env[key];
  env.PATH=path.dirname(process.execPath)+path.delimiter+(env.PATH??'');
  const result=spawnSync(exe,args,{cwd,env,encoding:'utf8',timeout:600000,maxBuffer:4*1024*1024});
  if(result.error||result.status!==0)failure('INSTALL_COMMAND_FAILED','A bounded dependency/setup command failed. Existing agent entries and retained staging were preserved.');
  return result.stdout;
}
function cliJson(args,cwd){try{return JSON.parse(command(process.execPath,args,cwd));}catch(error){if(error.code)throw error;failure('INVALID_SETUP_RESULT','Generic setup did not return a reviewable JSON result.');}}
try{
  const manifest=JSON.parse(manifestText);
  if(manifest.schemaVersion!==1||manifest.version!=='0.1.0'||manifest.tag!==tag||manifest.repository!==repo)failure('INVALID_RELEASE_MANIFEST','The manifest does not match this audited bootstrap release.');
  const assets=manifest.assets?.filter(x=>x.name==='source')??[];
  const expectedFile='huaidj-disk-toolkit-v0.1.0-source.zip';
  if(assets.length!==1||assets[0].file!==expectedFile||assets[0].url!==`https://github.com/${repo}/releases/download/${tag}/${expectedFile}`||assets[0].archiveRoot!=='.'||!isHash(assets[0].sha256))failure('INVALID_SOURCE_ASSET','The fixed flat source asset and SHA-256 are required.');
  const pin=manifest.dependencies?.node?.platforms?.[platform];
  if(manifest.dependencies?.node?.version!=='24.22.3'||pin?.sha256?.toLowerCase()!==nodePin||pin?.url!==`https://nodejs.org/dist/v24.22.3/node-v24.22.3-${platform}.tar.gz`)failure('DEPENDENCY_PIN_MISMATCH','Manifest Node pins differ from this audited bootstrap.');
  const asset=assets[0],versionRoot=path.join(root,'versions',tag,'portable-source'),app=path.join(versionRoot,'app'),receiptFile=path.join(versionRoot,'install-receipt.json');
  if(apply!=='true'){console.log(JSON.stringify({status:'preview',version:'0.1.0',platform,flavor,client,configurationApplied:false,physicalDiskAdapter:'Windows-only',systemPATHModified:false,elevationRequested:false}));process.exit(0);}
  plainChain(root);let reused=false;
  if(fs.existsSync(versionRoot)){
    plainChain(versionRoot);
    if(!fs.existsSync(receiptFile))failure('INCOMPLETE_RUNTIME','An existing version has no complete receipt and was preserved.');
    const receipt=JSON.parse(fs.readFileSync(receiptFile,'utf8'));
    if(receipt.schemaVersion!==1||receipt.status!=='complete'||receipt.packageSHA256.toLowerCase()!==asset.sha256.toLowerCase()||!Array.isArray(receipt.criticalFiles)||receipt.criticalFiles.length<3)failure('RUNTIME_CONFLICT','An existing runtime differs from this fixed source release.');
    for(const e of receipt.criticalFiles){if(!/^(src\/[^:]+|package(?:-lock)?\.json)$/.test(e.path)||e.path.split('/').some(s=>s==='..'||s==='.')||!isHash(e.sha256))failure('INVALID_RUNTIME_RECEIPT','The runtime receipt contains an unsafe integrity path.');const file=path.join(app,...e.path.split('/'));plainChain(file);if(hash(file)!==e.sha256)failure('RUNTIME_CHANGED','Installed runtime code changed and was preserved.');}
    reused=true;
  }else{
    fs.mkdirSync(path.join(root,'.staging'),{recursive:true});const stage=fs.mkdtempSync(path.join(root,'.staging','source.'));
    try{
      const zip=path.join(stage,'source.zip');command('curl',['--disable','--fail','--show-error','--silent','--location',asset.url,'--output',zip],stage);
      if(hash(zip)!==asset.sha256.toLowerCase())failure('CHECKSUM_MISMATCH','The source package digest is incorrect and was not extracted.');
      inspectZip(fs.readFileSync(zip));const stageApp=path.join(stage,'app');fs.mkdirSync(stageApp);command('unzip',['-q',zip,'-d',stageApp],stage);
      for(const rel of ['package.json','package-lock.json','src/cli.mjs','src/setup.mjs','skills/huaidj-disk-toolkit/SKILL.md','LICENSE'])if(!fs.statSync(path.join(stageApp,rel)).isFile())failure('INCOMPLETE_SOURCE_PACKAGE','The verified source archive lacks required toolkit files.');
      if(fs.existsSync(path.join(stageApp,'config.json')))failure('PRIVATE_CONFIG_IN_PACKAGE','A public source package must not include a private runtime configuration.');
      const pkg=JSON.parse(fs.readFileSync(path.join(stageApp,'package.json'),'utf8')),lock=JSON.parse(fs.readFileSync(path.join(stageApp,'package-lock.json'),'utf8'));
      if(pkg.version!=='0.1.0'||![2,3].includes(lock.lockfileVersion)||!lock.packages)failure('LOCKFILE_REQUIRED','A matching package and npm lockfile are required.');
      for(const e of Object.values(lock.packages))if(e.resolved&&(!e.resolved.startsWith('https://registry.npmjs.org/')||!/^sha(256|384|512)-[A-Za-z0-9+/=]+$/.test(e.integrity??'')))failure('UNTRUSTED_NPM_LOCK','Locked dependencies must use the public npm registry and integrity digests.');
      const userConfig=path.join(stage,'npm-user.npmrc'),globalConfig=path.join(stage,'npm-global.npmrc');fs.writeFileSync(userConfig,'');fs.writeFileSync(globalConfig,'');
      command(npmCommand,['ci','--ignore-scripts','--omit=dev','--no-audit','--no-fund','--registry','https://registry.npmjs.org','--userconfig',userConfig,'--globalconfig',globalConfig,'--cache',path.join(root,'cache','npm')],stageApp,{npm:true});
      const criticalFiles=[];function track(directory){for(const entry of fs.readdirSync(directory,{withFileTypes:true})){const file=path.join(directory,entry.name);if(entry.isSymbolicLink())failure('UNSAFE_RUNTIME_NODE','Runtime source links are not supported.');if(entry.isDirectory())track(file);else if(entry.isFile())criticalFiles.push({path:path.relative(stageApp,file).split(path.sep).join('/'),sha256:hash(file)});}}
      track(path.join(stageApp,'src'));for(const rel of ['package.json','package-lock.json'])criticalFiles.push({path:rel,sha256:hash(path.join(stageApp,rel))});
      fs.writeFileSync(path.join(stage,'install-receipt.json'),JSON.stringify({schemaVersion:1,status:'complete',packageSHA256:asset.sha256,nodePath:process.execPath,powershellPath:null,cliPath:path.join(app,'src','cli.mjs'),toolkitRoot:app,criticalFiles,createdUTC:new Date().toISOString()},null,2),{flag:'wx'});
      fs.mkdirSync(path.dirname(versionRoot),{recursive:true});plainChain(path.dirname(versionRoot));if(fs.existsSync(versionRoot))failure('RUNTIME_APPEARED','Another runtime appeared; no existing version was overwritten.');fs.renameSync(stage,versionRoot);
    }catch(error){fs.writeFileSync(path.join(stage,'incomplete.json'),JSON.stringify({status:'incomplete',preserved:true,errorCode:error.code??'INSTALL_FAILED'}));throw error;}
  }
  const cli=path.join(app,'src','cli.mjs');let configured={applied:false};
  if(runtimeOnly!=='true'&&((flavor==='Mcp'&&client)||(flavor==='Skill'&&skillTarget))){
    const args=flavor==='Mcp'?[cli,'setup-mcp','--client',client]:[cli,'setup-skill','--target',skillTarget];
    const preview=cliJson(args,app);configured=preview.changesNeeded===false?preview:cliJson([...args,'--apply'],app);
  }
  console.log(JSON.stringify({status:'ready',version:'0.1.0',platform,runtimeReused:reused,cliCommand:process.execPath,cliArgs:[cli],cliArgsPrefix:[cli],nodePath:process.execPath,powershellPath:null,cliPath:cli,toolkitRoot:app,configurationApplied:configured.applied===true,physicalDiskAdapter:'Windows-only',systemPATHModified:false,elevationRequested:false,osImagesDownloaded:false,copyPrompt:'Use this installed runtime for reference/query, Skill or stdio tools. Select one explicit agent for generic setup; preserve an existing working entry. Physical disk adapters require Windows.'},null,2));
}catch(error){console.error(JSON.stringify({status:'failed',code:/^[A-Z_]+$/.test(error.code??'')?error.code:'INSTALL_FAILED',message:error.managed||error.code==='UNSAFE_SOURCE_ARCHIVE'?error.message:'Installation did not complete; existing runtime, configuration and staged evidence were preserved.'}));process.exitCode=1;}
HUAIDJ_NODE_INSTALLER
