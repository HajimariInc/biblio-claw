/**
 * Container Runner v2
 * Spawns agent containers with session folder + agent group folder mounts.
 * The container runs the v2 agent-runner which polls the session DB.
 *
 * Runtime-agnostic: the actual spawn is delegated to a
 * `ContainerRuntimeProvider` (Docker locally, K8s Job on GKE) selected via the
 * `CONTAINER_PROVIDER` env var. This file builds a runtime-neutral
 * `AgentSpawnSpec` (mounts, env, command, OneCLI raw args) and hands it off.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { getContainerRuntimeProvider } from './adapters/container/index.js';
import type { AgentHandle, AgentSpawnSpec } from './adapters/container/index.js';
import { subPathOf } from './adapters/container/mounts.js';
import { getSecretProvider } from './adapters/secret/index.js';
import { CONTAINER_IMAGE, CONTAINER_IMAGE_BASE, DATA_DIR, GROUPS_DIR, TIMEZONE } from './config.js';
import { materializeContainerJson } from './container-config.js';
import { getContainerConfig } from './db/container-configs.js';
import { updateContainerConfigScalars, updateContainerConfigJson } from './db/container-configs.js';
import { composeGroupClaudeMd } from './claude-md-compose.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getDb, hasTable } from './db/connection.js';
import { initGroupFilesystem } from './group-init.js';
import { stopTypingRefresh } from './modules/typing/index.js';
import { log } from './log.js';
import { validateAdditionalMounts } from './modules/mount-security/index.js';
import { resolveEquippedBiblios } from './biblio/equip.js';
// Provider host-side config barrel — each provider that needs host-side
// container setup self-registers on import.
import './providers/index.js';
import {
  getProviderContainerConfig,
  type ProviderContainerContribution,
  type VolumeMount,
} from './providers/provider-container-registry.js';
import {
  heartbeatPath,
  markContainerRunning,
  markContainerStopped,
  sessionDir,
  writeSessionRouting,
} from './session-manager.js';
import type { AgentGroup, Session } from './types.js';

/** Active containers tracked by session ID. */
const activeContainers = new Map<string, { handle: AgentHandle; agentGroupId: string }>();

/**
 * In-flight wake promises, keyed by session id. Deduplicates concurrent
 * `wakeContainer` calls while the first spawn is still mid-setup (async
 * buildContainerArgs, OneCLI gateway apply, etc.) — otherwise a second
 * wake in that window passes the `activeContainers.has` check and spawns
 * a duplicate container against the same session directory, producing
 * racy double-replies.
 */
const wakePromises = new Map<string, Promise<boolean>>();

export function getActiveContainerCount(): number {
  return activeContainers.size;
}

export function isContainerRunning(sessionId: string): boolean {
  return activeContainers.has(sessionId);
}

/**
 * Wake up a container for a session. If already running or mid-spawn, no-op
 * (the in-flight wake promise is reused).
 *
 * The container runs the v2 agent-runner which polls the session DB.
 *
 * Contract: never throws. Returns `true` on successful spawn, `false` on
 * transient spawn failure (e.g. OneCLI gateway unreachable). Callers don't
 * need to wrap — the inbound row stays pending and host-sweep retries on
 * its next tick. Callers that care (e.g. the router's typing indicator)
 * can branch on the boolean.
 */
export function wakeContainer(session: Session): Promise<boolean> {
  if (activeContainers.has(session.id)) {
    log.debug('Container already running', { sessionId: session.id });
    return Promise.resolve(true);
  }
  const existing = wakePromises.get(session.id);
  if (existing) {
    log.debug('Container wake already in-flight — joining existing promise', { sessionId: session.id });
    return existing;
  }
  const promise = spawnContainer(session)
    .then(() => true)
    .catch((err) => {
      log.warn('wakeContainer failed — host-sweep will retry', { sessionId: session.id, err });
      return false;
    })
    .finally(() => {
      wakePromises.delete(session.id);
    });
  wakePromises.set(session.id, promise);
  return promise;
}

async function spawnContainer(session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    log.error('Agent group not found', { agentGroupId: session.agent_group_id });
    return;
  }

  // Refresh the destination map and default reply routing so any admin
  // changes take effect on wake. Destinations come from the agent-to-agent
  // module — skip when the module isn't installed (table absent).
  if (hasTable(getDb(), 'agent_destinations')) {
    const { writeDestinations } = await import('./modules/agent-to-agent/write-destinations.js');
    writeDestinations(agentGroup.id, session.id);
  }
  writeSessionRouting(agentGroup.id, session.id);

  // Materialize container.json from DB — writes fresh file and returns
  // the config object, threaded through provider resolution, buildMounts,
  // and buildContainerSpec so we don't re-read.
  const containerConfig = materializeContainerJson(agentGroup.id);

  // Resolve the effective provider + any host-side contribution it declares
  // (extra mounts, env passthrough). Computed once and threaded through both
  // buildMounts and buildContainerSpec so side effects (mkdir, etc.) fire once.
  const { provider, contribution } = resolveProviderContribution(session, agentGroup, containerConfig);

  const mounts = await buildMounts(agentGroup, session, containerConfig, contribution);
  const containerName = `nanoclaw-v2-${agentGroup.folder}-${Date.now()}`;
  // OneCLI agent identifier is always the agent group id — stable across
  // sessions and reversible via getAgentGroup() for approval routing.
  const agentIdentifier = agentGroup.id;
  const spec = await buildContainerSpec(
    mounts,
    containerName,
    agentGroup,
    session,
    containerConfig,
    provider,
    contribution,
    agentIdentifier,
  );

  log.info('Spawning container', { sessionId: session.id, agentGroup: agentGroup.name, containerName });

  // Clear any orphan heartbeat from a previous container instance — the
  // sweep's ceiling check treats a missing file as "fresh spawn, give grace"
  // (host-sweep.ts line 87). Without this, the stale mtime can trigger an
  // immediate kill before the new container touches the file itself.
  fs.rmSync(heartbeatPath(agentGroup.id, session.id), { force: true });

  const runtime = getContainerRuntimeProvider();
  const handle = await runtime.spawn(spec);

  activeContainers.set(session.id, { handle, agentGroupId: agentGroup.id });
  markContainerRunning(session.id);

  // No host-side idle timeout. Stale/stuck detection is driven by the host
  // sweep reading heartbeat mtime + processing_ack claim age + container_state
  // (see src/host-sweep.ts). This avoids killing long-running legitimate work
  // on a wall-clock timer.

  // waitForExit() is contracted never to reject, but the .then() body itself
  // (markContainerStopped, stopTypingRefresh) could throw on DB lock or
  // similar — without a .catch(), Node turns that into an unhandledRejection
  // and the cleanup silently skips, leaving zombie entries in activeContainers.
  handle
    .waitForExit()
    .then((info) => {
      activeContainers.delete(session.id);
      markContainerStopped(session.id);
      stopTypingRefresh(session.id);
      log.info('Container exited', {
        sessionId: session.id,
        code: info.code,
        reason: info.reason,
        handleId: handle.id,
      });
    })
    .catch((err) => {
      // Last-resort: drop the activeContainers entry so the next wake doesn't
      // skip spawn due to a stuck zombie, then surface the failure.
      activeContainers.delete(session.id);
      log.error('Container exit handler failed', {
        sessionId: session.id,
        handleId: handle.id,
        err,
      });
    });
}

/** Kill a container for a session. */
export function killContainer(sessionId: string, reason: string, onExit?: () => void): void {
  const entry = activeContainers.get(sessionId);
  if (!entry) return;

  log.info('Killing container', { sessionId, reason, handleId: entry.handle.id });
  if (onExit) {
    entry.handle.waitForExit().finally(onExit);
  }
  entry.handle.kill().catch((err) => {
    log.warn('Container kill failed', { sessionId, err });
  });
}

/**
 * Resolve the provider name for a session:
 *
 *   sessions.agent_provider
 *     → container_configs.provider
 *     → 'claude'
 *
 * Pure so the precedence can be unit-tested without a DB or filesystem.
 */
export function resolveProviderName(
  sessionProvider: string | null | undefined,
  containerConfigProvider: string | null | undefined,
): string {
  return (sessionProvider || containerConfigProvider || 'claude').toLowerCase();
}

function resolveProviderContribution(
  session: Session,
  agentGroup: AgentGroup,
  containerConfig: import('./container-config.js').ContainerConfig,
): { provider: string; contribution: ProviderContainerContribution } {
  const provider = resolveProviderName(session.agent_provider, containerConfig.provider);
  const fn = getProviderContainerConfig(provider);
  const contribution = fn
    ? fn({
        sessionDir: sessionDir(agentGroup.id, session.id),
        agentGroupId: agentGroup.id,
        hostEnv: process.env,
      })
    : {};
  return { provider, contribution };
}

async function buildMounts(
  agentGroup: AgentGroup,
  session: Session,
  containerConfig: import('./container-config.js').ContainerConfig,
  providerContribution: ProviderContainerContribution,
): Promise<VolumeMount[]> {
  const projectRoot = process.cwd();

  // Per-group filesystem state lives forever after first creation. Init is
  // idempotent: it only writes paths that don't already exist, so this call
  // is a no-op for groups that have spawned before.
  initGroupFilesystem(agentGroup);

  // Sync skill symlinks based on container.json selection before mounting.
  const claudeDir = path.join(DATA_DIR, 'v2-sessions', agentGroup.id, '.claude-shared');
  syncSkillSymlinks(claudeDir, containerConfig);

  // Compose CLAUDE.md fresh every spawn from the shared base, enabled skill
  // fragments, and MCP server instructions. See `claude-md-compose.ts`.
  composeGroupClaudeMd(agentGroup);

  const mounts: VolumeMount[] = [];
  const sessDir = sessionDir(agentGroup.id, session.id);
  const groupDir = path.resolve(GROUPS_DIR, agentGroup.folder);

  // K8sJobProvider maps every `/data` path to a `subPath` under the shared
  // orchestrator PVC (= GKE Autopilot disallows write-mode hostPath, so the
  // hostPath model from Phase 1 can't survive Warden admission). Compute the
  // subPath here so DockerProvider (which ignores the field) and
  // K8sJobProvider (which honours it) both consume the same mount list.
  //
  // On GKE, `DATA_DIR=/data` and `GROUPS_DIR=/data/groups` are set via env on
  // the orchestrator StatefulSet so every data mount falls inside DATA_DIR.
  // If a deployment forgets to override these (e.g. GROUPS_DIR left at the
  // local default `<cwd>/groups`), `subPathOf` returns undefined for the
  // group / .claude / global mounts and `expectInDataDir` below surfaces
  // that as a warn — otherwise the K8s provider would silently skip every
  // affected mount and the agent would come up with /workspace/agent empty.
  //
  // image-layer paths (`<cwd>/container/...`) are intentionally left
  // subPath-less — they live in the agent image, not the PVC, and never
  // call `expectInDataDir`.
  const expectInDataDir = (hostPath: string, label: string): string | undefined => {
    const rel = subPathOf(hostPath, DATA_DIR);
    if (rel === undefined) {
      log.warn('mount hostPath is outside DATA_DIR — K8s will skip this mount', {
        label,
        hostPath,
        DATA_DIR,
        agentGroup: agentGroup.id,
      });
    }
    return rel;
  };

  // Session folder at /workspace (contains inbound.db, outbound.db, outbox/, .claude/)
  mounts.push({
    hostPath: sessDir,
    subPath: expectInDataDir(sessDir, 'session-dir'),
    containerPath: '/workspace',
    readonly: false,
  });

  // Agent group folder at /workspace/agent (RW for working files + CLAUDE.local.md)
  mounts.push({
    hostPath: groupDir,
    subPath: expectInDataDir(groupDir, 'group-dir'),
    containerPath: '/workspace/agent',
    readonly: false,
  });

  // container.json — nested RO mount on top of RW group dir so the agent
  // can read its config but cannot modify it.
  const containerJsonPath = path.join(groupDir, 'container.json');
  if (fs.existsSync(containerJsonPath)) {
    mounts.push({
      hostPath: containerJsonPath,
      subPath: expectInDataDir(containerJsonPath, 'container-json'),
      containerPath: '/workspace/agent/container.json',
      readonly: true,
    });
  }

  // Composer-managed CLAUDE.md artifacts — nested RO mounts. These are
  // regenerated from the shared base + fragments on every spawn; any
  // agent-side writes would be clobbered, so enforce read-only. Only
  // CLAUDE.local.md (per-group memory) remains RW via the group-dir mount.
  // `.claude-shared.md` is a symlink whose target (`/app/CLAUDE.md`) is
  // already RO-mounted, so writes through it fail regardless — no need for
  // a nested mount there.
  const composedClaudeMd = path.join(groupDir, 'CLAUDE.md');
  if (fs.existsSync(composedClaudeMd)) {
    mounts.push({
      hostPath: composedClaudeMd,
      subPath: expectInDataDir(composedClaudeMd, 'composed-claude-md'),
      containerPath: '/workspace/agent/CLAUDE.md',
      readonly: true,
    });
  }
  const fragmentsDir = path.join(groupDir, '.claude-fragments');
  if (fs.existsSync(fragmentsDir)) {
    mounts.push({
      hostPath: fragmentsDir,
      subPath: expectInDataDir(fragmentsDir, 'claude-fragments'),
      containerPath: '/workspace/agent/.claude-fragments',
      readonly: true,
    });
  }

  // Global memory directory — always read-only.
  const globalDir = path.join(GROUPS_DIR, 'global');
  if (fs.existsSync(globalDir)) {
    mounts.push({
      hostPath: globalDir,
      subPath: expectInDataDir(globalDir, 'global-memory'),
      containerPath: '/workspace/global',
      readonly: true,
    });
  }

  // Shared CLAUDE.md — read-only, imported by the composed entry point via
  // the `.claude-shared.md` symlink inside the group dir. image-layer path,
  // so it gets no subPath (K8s reads it from the agent image's `/app/CLAUDE.md`).
  const sharedClaudeMd = path.join(process.cwd(), 'container', 'CLAUDE.md');
  if (fs.existsSync(sharedClaudeMd)) {
    mounts.push({ hostPath: sharedClaudeMd, containerPath: '/app/CLAUDE.md', readonly: true });
  }

  // Per-group .claude-shared at /home/node/.claude (Claude state, settings,
  // skill symlinks)
  mounts.push({
    hostPath: claudeDir,
    subPath: expectInDataDir(claudeDir, 'claude-shared'),
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  // Shared agent-runner source — read-only, same code for all groups.
  const agentRunnerSrc = path.join(projectRoot, 'container', 'agent-runner', 'src');
  mounts.push({ hostPath: agentRunnerSrc, containerPath: '/app/src', readonly: true });

  // Shared skills — read-only, symlinks in .claude-shared/skills/ point here.
  const skillsSrc = path.join(projectRoot, 'container', 'skills');
  if (fs.existsSync(skillsSrc)) {
    mounts.push({ hostPath: skillsSrc, containerPath: '/app/skills', readonly: true });
  }

  // Additional mounts from container config — typically point at agent-group
  // workspace overrides; on K8s they're projected onto the shared PVC iff the
  // hostPath happens to be inside DATA_DIR. We don't warn here because users
  // legitimately use additionalMounts for paths outside DATA_DIR on Docker
  // (where the field is honored as a literal bind mount).
  if (containerConfig.additionalMounts && containerConfig.additionalMounts.length > 0) {
    const validated = validateAdditionalMounts(containerConfig.additionalMounts, agentGroup.name);
    for (const m of validated) {
      mounts.push({ ...m, subPath: subPathOf(m.hostPath, DATA_DIR) });
    }
  }

  // Provider-contributed mounts (e.g. opencode-xdg) — same policy as
  // additionalMounts above. Honour any subPath the provider supplied; fall
  // back to deriving one from DATA_DIR for paths that happen to live there.
  if (providerContribution.mounts) {
    for (const m of providerContribution.mounts) {
      mounts.push({ ...m, subPath: m.subPath ?? subPathOf(m.hostPath, DATA_DIR) });
    }
  }

  // M3 装備機構: buildMounts の fs 副作用 (initGroupFilesystem 等) と分離するため
  // export 関数に委譲。テスト時の mock コストを最小化する。
  await appendEquippedBiblioMounts(mounts, session, DATA_DIR);

  return mounts;
}

/**
 * 装備済み biblio を `VolumeMount[]` 末尾に append する (per-biblio subPath, readonly)。
 *
 * `dataDir` は `resolveEquippedBiblios` の `equipmentRoot` と `subPathOf` の両方に
 * 渡される単一の真実の入口で、const 束縛された `DATA_DIR` を test で上書きする
 * フックを兼ねる。Docker は subPath を無視して bind mount、K8s は PVC subPath
 * volumeMount として projection することで両 runtime が同一抽象 spec を共有する。
 *
 * Phase 2 では `resolveEquippedBiblios` 側を DB lookup に置換するだけで signature 不変。
 */
export async function appendEquippedBiblioMounts(
  mounts: VolumeMount[],
  session: Session,
  dataDir: string,
): Promise<void> {
  const equipmentRoot = path.join(dataDir, 'biblio-equipped');
  const equipped = await resolveEquippedBiblios(session, { equipmentRoot });
  for (const b of equipped) {
    mounts.push({
      hostPath: b.sourcePath,
      subPath: subPathOf(b.sourcePath, dataDir),
      containerPath: b.mountPath,
      readonly: true,
    });
  }
}

/**
 * Sync skill symlinks in .claude-shared/skills/ to match the container.json
 * selection. Each symlink points to a container path (/app/skills/<name>)
 * so it's dangling on the host but valid inside the container.
 */
function syncSkillSymlinks(claudeDir: string, containerConfig: import('./container-config.js').ContainerConfig): void {
  const skillsDir = path.join(claudeDir, 'skills');
  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true });
  }

  // Determine desired skill set
  const projectRoot = process.cwd();
  const sharedSkillsDir = path.join(projectRoot, 'container', 'skills');
  let desired: string[];
  if (containerConfig.skills === 'all') {
    // Recompute from shared dir — newly-added upstream skills appear automatically
    desired = fs.existsSync(sharedSkillsDir)
      ? fs.readdirSync(sharedSkillsDir).filter((e) => {
          try {
            return fs.statSync(path.join(sharedSkillsDir, e)).isDirectory();
          } catch {
            return false;
          }
        })
      : [];
  } else {
    desired = containerConfig.skills;
  }

  const desiredSet = new Set(desired);

  // Remove symlinks not in the desired set
  for (const entry of fs.readdirSync(skillsDir)) {
    const entryPath = path.join(skillsDir, entry);
    let isSymlink = false;
    try {
      isSymlink = fs.lstatSync(entryPath).isSymbolicLink();
    } catch {
      continue;
    }
    if (isSymlink && !desiredSet.has(entry)) {
      fs.unlinkSync(entryPath);
    }
  }

  // Create symlinks for desired skills (container path targets)
  for (const skill of desired) {
    const linkPath = path.join(skillsDir, skill);
    let exists = false;
    try {
      fs.lstatSync(linkPath);
      exists = true;
    } catch {
      /* missing */
    }
    if (!exists) {
      fs.symlinkSync(`/app/skills/${skill}`, linkPath);
    }
  }
}

async function buildContainerSpec(
  mounts: VolumeMount[],
  containerName: string,
  agentGroup: AgentGroup,
  session: Session,
  containerConfig: import('./container-config.js').ContainerConfig,
  _provider: string,
  providerContribution: ProviderContainerContribution,
  agentIdentifier: string,
): Promise<AgentSpawnSpec> {
  // Base env — only vars read by code we don't own. Everything NanoClaw-
  // specific is in container.json (read by runner at startup).
  const env: { name: string; value: string }[] = [{ name: 'TZ', value: TIMEZONE }];

  // Provider-contributed env vars (e.g. XDG_DATA_HOME, OPENCODE_*, NO_PROXY).
  if (providerContribution.env) {
    for (const [key, value] of Object.entries(providerContribution.env)) {
      env.push({ name: key, value });
    }
  }

  // OneCLI gateway — injects HTTPS_PROXY + certs so container API calls
  // are routed through the agent vault for credential injection. Treated as
  // a transient hard failure: if we can't wire the gateway, we don't spawn.
  // The caller (router or host-sweep) catches the throw, leaves the inbound
  // message pending, and the next sweep tick retries.
  //
  // We pass a dedicated `onecliArgs` array (not the spec env list) because
  // applyContainerSecrets() mutates it with Docker CLI flags (`-e`, `-v`,
  // optional `--add-host`). The Provider translates that raw blob into its
  // native shape (Docker concats them; K8sJobProvider parses to env / volumes
  // / hostAliases). Keeping it raw means the OneCLI SDK contract stays the
  // single source of truth.
  const onecliArgs: string[] = [];
  const secret = getSecretProvider();
  await secret.ensureAgent({ name: agentGroup.name, identifier: agentIdentifier });
  const onecliApplied = await secret.applyContainerSecrets(onecliArgs, {
    addHostMapping: false,
    agent: agentIdentifier,
  });
  if (!onecliApplied) {
    throw new Error('OneCLI gateway not applied — refusing to spawn container without credentials');
  }
  log.info('OneCLI gateway applied', { containerName });

  // User mapping — Docker maps to `--user`, K8sJobProvider ignores this in
  // favor of the image-default user (Autopilot restricts arbitrary UIDs).
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  const runAsUser = hostUid != null && hostUid !== 0 && hostUid !== 1000 ? { uid: hostUid, gid: hostGid } : null;

  // Use per-agent-group image if one has been built, otherwise base image
  const imageTag = containerConfig.imageTag || CONTAINER_IMAGE;

  return {
    agentGroupId: agentGroup.id,
    agentGroupName: agentGroup.name,
    agentGroupFolder: agentGroup.folder,
    sessionId: session.id,
    image: imageTag,
    mounts,
    env,
    onecliApplyArgs: onecliArgs,
    // M3 Phase 2: spawn-time biblio install を bun の前に挟む。`/app/install-biblios.sh`
    // は image 内 wrapper (= /workspace/biblios/*/ を loop して `claude plugin
    // marketplace add → install --scope user → enable`)。装備 0 件なら早期 exit で
    // no-op。`exec` で bun が PID 1 (= tini child) になり、SIGTERM grace shutdown が
    // 既存挙動と同じく動く。
    command: ['-c', '/app/install-biblios.sh && exec bun run /app/src/index.ts'],
    containerName,
    runAsUser,
    agentIdentifier,
  };
}

/** Build a per-agent-group Docker image with custom packages. */
export async function buildAgentGroupImage(agentGroupId: string): Promise<void> {
  // `docker build` below only exists on the Docker runtime. On K8s the
  // orchestrator pod has no docker binary, so an install_packages self-mod
  // would crash here with ENOENT. Fail loud and early instead — image rebuild
  // (and thus install_packages) is not supported under the K8s provider yet.
  const runtime = getContainerRuntimeProvider();
  if (runtime.name !== 'docker') {
    throw new Error(
      `buildAgentGroupImage requires the Docker runtime (current: ${runtime.name}). ` +
        'install_packages self-mod is not supported under the K8s provider.',
    );
  }

  const agentGroup = getAgentGroup(agentGroupId);
  if (!agentGroup) throw new Error('Agent group not found');

  const configRow = getContainerConfig(agentGroup.id);
  if (!configRow) throw new Error('Container config not found');
  const aptPackages = JSON.parse(configRow.packages_apt) as string[];
  const npmPackages = JSON.parse(configRow.packages_npm) as string[];
  if (aptPackages.length === 0 && npmPackages.length === 0) {
    throw new Error('No packages to install. Use install_packages first.');
  }

  let dockerfile = `FROM ${CONTAINER_IMAGE}\nUSER root\n`;
  if (aptPackages.length > 0) {
    dockerfile += `RUN apt-get update && apt-get install -y ${aptPackages.join(' ')} && rm -rf /var/lib/apt/lists/*\n`;
  }
  if (npmPackages.length > 0) {
    // pnpm skips build scripts unless packages are allowlisted. Append each
    // to /root/.npmrc (base image sets it up for agent-browser) so packages
    // with postinstall — e.g. playwright, puppeteer, native addons — don't
    // install silently broken.
    const allowlist = npmPackages.map((p) => `echo 'only-built-dependencies[]=${p}' >> /root/.npmrc`).join(' && ');
    dockerfile += `RUN ${allowlist} && pnpm install -g ${npmPackages.join(' ')}\n`;
  }
  dockerfile += 'USER node\n';

  const imageTag = `${CONTAINER_IMAGE_BASE}:${agentGroupId}`;

  log.info('Building per-agent-group image', { agentGroupId, imageTag, apt: aptPackages, npm: npmPackages });

  // Write Dockerfile to temp file and build
  const tmpDockerfile = path.join(DATA_DIR, `Dockerfile.${agentGroupId}`);
  fs.writeFileSync(tmpDockerfile, dockerfile);
  try {
    execSync(`docker build -t ${imageTag} -f ${tmpDockerfile} .`, {
      cwd: DATA_DIR,
      stdio: 'pipe',
      timeout: 900_000,
    });
  } finally {
    fs.unlinkSync(tmpDockerfile);
  }

  updateContainerConfigScalars(agentGroup.id, { image_tag: imageTag });

  log.info('Per-agent-group image built', { agentGroupId, imageTag });
}
