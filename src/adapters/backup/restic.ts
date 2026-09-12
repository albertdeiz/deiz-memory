import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import type { Transport } from '../../core/ops/backup';

/**
 * restic and rclone, as subprocesses.
 *
 * This is transport and nothing else. It never decides WHAT travels — the core
 * already produced a directory holding exactly one owner's data (§14.3) — and it
 * never learns what is inside it. restic encrypts at origin, versions and
 * deduplicates; rclone is only how bytes reach a WebDAV or S3 destination.
 */

export interface ResticEnv {
  repository: string;
  passphrase: string;
  transport: Transport;
  transportConfig: Record<string, unknown>;
  /** The transport credential, when the transport needs one. */
  transportSecret: string | null;
}

export interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

const exec = (cmd: string, args: string[], env: NodeJS.ProcessEnv, onLine?: (s: string) => void): Promise<Run> =>
  new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    p.stderr.on('data', (d: Buffer) => {
      const s = d.toString();
      stderr += s;
      // restic reports progress on stderr. Passing it through is what keeps a
      // long first run from looking like a hang.
      if (onLine) for (const l of s.split('\n')) if (l.trim()) onLine(l);
    });
    p.on('error', reject);
    p.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });

/**
 * The rclone remote, built from the destination the owner configured.
 *
 * Declared through the environment and never through a config file: there is no
 * state to mount, to back up or to leak, and the credential reaches this process
 * and nothing else. The address comes from the database, which is where a
 * per-owner destination belongs; the credential comes from the environment,
 * which is where a secret belongs.
 */
export async function rcloneEnv(
  transport: Transport,
  config: Record<string, unknown>,
  secret: string | null,
): Promise<NodeJS.ProcessEnv> {
  if (transport !== 'webdav') return {};

  const out: NodeJS.ProcessEnv = {
    RCLONE_CONFIG_NC_TYPE: 'webdav',
    RCLONE_CONFIG_NC_VENDOR: 'nextcloud',
    RCLONE_CONFIG_NC_URL: String(config.url ?? ''),
    RCLONE_CONFIG_NC_USER: String(config.user ?? ''),
  };

  // rclone stores passwords obscured and refuses a plain one. Doing it here
  // instead of asking for `rclone obscure` by hand removes a manual step whose
  // only failure mode is a confusing auth error days later.
  if (secret) {
    const r = await exec('rclone', ['obscure', secret], { PATH: process.env.PATH });
    if (r.code !== 0) throw new Error(`rclone obscure falló: ${r.stderr.trim()}`);
    out.RCLONE_CONFIG_NC_PASS = r.stdout.trim();
  }
  return out;
}

/**
 * Which of the tools this needs are not installed.
 *
 * Without this the failure is `spawn rclone ENOENT`, which says nothing about
 * what to do. And it is a normal thing to hit: the binaries live in the backup
 * container, so a `dm` linked on the host reaches the database and the config
 * fine and then falls over on the one step that is not Node.
 */
export function missingTools(transport: Transport): string[] {
  const dirs = (process.env.PATH ?? '').split(':').filter(Boolean);
  const onPath = (bin: string): boolean =>
    dirs.some((d) => {
      try {
        accessSync(join(d, bin), constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  return ['restic', ...(transport === 'webdav' ? ['rclone'] : [])].filter((t) => !onPath(t));
}

/**
 * What a subprocess needs to reach the outside, and nothing else.
 *
 * Both cases of each name: Go reads the lowercase forms too, and which one is
 * set depends on who set it.
 */
function proxyVars(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'ALL_PROXY']) {
    for (const key of [name, name.toLowerCase()]) {
      const v = env[key];
      if (v) out[key] = v;
    }
  }
  return out;
}

/**
 * Uploads the readable copy with `rclone sync`.
 *
 * `sync` and not `copy`, unlike the blobs: the mirror is a projection of the
 * current state, so a memory you hid or purged has to disappear from it. That
 * is only safe BECAUSE it is derived — there is nothing here that does not come
 * from the database, so deleting the wrong thing costs one more run and never a
 * document. `--max-delete` still guards the case where the plan comes back empty
 * because something upstream broke.
 */
export async function rcloneSync(
  from: string,
  to: string,
  transport: Transport,
  config: Record<string, unknown>,
  secret: string | null,
  log: (s: string) => void,
  maxDelete = 100,
): Promise<void> {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME ?? '/tmp',
    ...proxyVars(),
    ...(await rcloneEnv(transport, config, secret)),
  };
  const r = await exec('rclone', [
    'sync', from, to,
    '--max-delete', String(maxDelete),
    '--transfers', '4',
    '--stats-one-line', '--stats', '10s',
  ], env, log);
  if (r.code !== 0) throw new Error(`no se pudo sincronizar: ${r.stderr.trim()}`);
}

export class Restic {
  private constructor(
    private readonly env: NodeJS.ProcessEnv,
    private readonly log: (s: string) => void,
  ) {}

  static async open(cfg: ResticEnv, log: (s: string) => void = () => {}): Promise<Restic> {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME ?? '/tmp',
      // The proxy variables have to survive the clean environment, and this is
      // not housekeeping: when the destination is reached over a userspace-mode
      // VPN, the proxy is the ONLY route out. Dropping them did not fail with
      // "no proxy" — restic dialled the tailnet address directly from a network
      // namespace with no route to it and hung until the timeout, which reads
      // exactly like a destination that is down.
      ...proxyVars(),
      ...(await rcloneEnv(cfg.transport, cfg.transportConfig, cfg.transportSecret)),
      RESTIC_REPOSITORY: cfg.repository,
      RESTIC_PASSWORD: cfg.passphrase,
    };
    return new Restic(env, log);
  }

  private run(args: string[], quiet = false): Promise<Run> {
    return exec('restic', args, this.env, quiet ? undefined : this.log);
  }

  /** Idempotent: an existing repository is left exactly as it is. */
  async ensureRepo(): Promise<void> {
    // Quiet: "repository does not exist" is this probe's SUCCESS case on a first
    // run, and printing it would teach you to ignore restic's real errors.
    const probe = await this.run(['cat', 'config'], true);
    if (probe.code === 0) return;
    const init = await this.run(['init']);
    if (init.code !== 0) throw new Error(`no se pudo crear el repositorio: ${init.stderr.trim()}`);
  }

  async backup(dir: string, tag: string): Promise<string> {
    const r = await this.run(['backup', dir, '--tag', tag, '--host', 'deiz-memory', '--json']);
    if (r.code !== 0) throw new Error(`el respaldo falló: ${r.stderr.trim()}`);
    // The summary line carries the snapshot id. Reading it from --json rather
    // than scraping prose means a restic release cannot quietly break it.
    for (const line of r.stdout.split('\n').reverse()) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line) as { message_type?: string; snapshot_id?: string };
          // Short id, which is what `snapshots` and `restore` accept and what a
        // person can retype. The long one is in the repository either way.
        if (o.message_type === 'summary' && o.snapshot_id) return o.snapshot_id.slice(0, 8);
      } catch {
        // Not every line is JSON; the summary is the one that matters.
      }
    }
    throw new Error('el respaldo terminó sin informar un snapshot');
  }

  async check(): Promise<void> {
    const r = await this.run(['check']);
    if (r.code !== 0) throw new Error(`el repositorio no está consistente: ${r.stderr.trim()}`);
  }

  async restore(snapshot: string, target: string): Promise<void> {
    const r = await this.run(['restore', snapshot, '--target', target]);
    if (r.code !== 0) throw new Error(`no se pudo restaurar: ${r.stderr.trim()}`);
  }

  async snapshots(): Promise<{ id: string; time: string; tags: string[] }[]> {
    const r = await this.run(['snapshots', '--json']);
    if (r.code !== 0) throw new Error(`no se pudieron listar los snapshots: ${r.stderr.trim()}`);
    const raw = JSON.parse(r.stdout || '[]') as { short_id?: string; id: string; time: string; tags?: string[] }[];
    return raw.map((s) => ({ id: s.short_id ?? s.id, time: s.time, tags: s.tags ?? [] }));
  }

  /** Retention plus a real prune: this is where a purge stops being in the past. */
  async forget(keep: { daily: number; weekly: number; monthly: number }): Promise<string> {
    const r = await this.run([
      'forget', '--prune',
      '--keep-daily', String(keep.daily),
      '--keep-weekly', String(keep.weekly),
      '--keep-monthly', String(keep.monthly),
    ]);
    if (r.code !== 0) throw new Error(`no se pudo podar: ${r.stderr.trim()}`);
    return r.stdout;
  }
}
