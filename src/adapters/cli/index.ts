#!/usr/bin/env node
import { basename } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { Command } from 'commander';
import type pg from 'pg';
import { loadConfig } from '../../config.js';
import { createPool, pgDb } from '../db/postgres/index.js';
import { s3BlobStore } from '../storage/s3.js';
import { inlineIngest } from '../../core/ingest.js';
import { systemClock, type Deps } from '../../core/ports.js';
import type { Actor } from '../../core/domain/types.js';
import type { Result } from '../../core/result.js';
import {
  capture, createOwner, fetchBlob, list, listOwners, purge,
  resolveActor, search, setHidden, show,
} from '../../core/index.js';
import { EXIT, exitCodeFor } from './exit.js';
import { renderDetail, renderFailure, renderList } from './format.js';

const program = new Command();
program
  .name('dm')
  .description('deiz-memory · memoria personal accesible desde la terminal')
  .version('0.1.0')
  .option('--json', 'salida en JSON, para scripts y tests')
  .option('--actor <id>', 'dueño con el que operar');

interface Ctx {
  deps: Deps;
  actor: Actor;
}

const globals = () => program.opts<{ json?: boolean; actor?: string }>();

function emit<T>(result: Result<T>, render: (v: T) => string): void {
  const json = globals().json === true;
  if (result.ok) {
    console.log(json ? JSON.stringify(result.value) : render(result.value));
  } else {
    const payload = { error: { kind: result.kind, message: result.message, ...('affects' in result ? { affects: result.affects } : {}), ...('detail' in result ? { detail: result.detail } : {}) } };
    // stdout es el canal del valor; todo lo demás va a stderr, confirmaciones
    // incluidas. Así `dm --json ls | jq` nunca recibe algo que no sea el dato.
    console.error(json ? JSON.stringify(payload) : renderFailure(result));
  }
  process.exitCode = exitCodeFor(result);
}

function buildDeps(pool: pg.Pool): Deps {
  const db = pgDb(pool);
  const cfg = loadConfig();
  return { db, blobs: s3BlobStore(cfg.s3), clock: systemClock, ingest: inlineIngest(db) };
}

/** Toda la fontanería de una invocación: config, pool, actor, render y cierre limpio. */
async function run<T>(fn: (ctx: Ctx) => Promise<Result<T>>, render: (v: T) => string): Promise<void> {
  let pool: pg.Pool | null = null;
  try {
    const cfg = loadConfig();
    pool = createPool(cfg.databaseUrl);
    const deps = buildDeps(pool);
    const actor = await resolveActor(deps.db, globals().actor ?? cfg.ownerId);
    if (!actor.ok) return emit(actor, () => '');
    emit(await fn({ deps, actor: { ownerId: actor.value } }), render);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = EXIT.error;
  } finally {
    await pool?.end().catch(() => {});
  }
}

const readStdin = async (): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};

const parseDate = (s?: string): Date | null | 'invalid' => {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? 'invalid' : d;
};

// ---------------------------------------------------------------- init / doctor

program
  .command('init')
  .description('crea el dueño y verifica que el stack responde')
  .argument('[label]', 'nombre del dueño', 'yo')
  .action(async (label: string) => {
    let pool: pg.Pool | null = null;
    try {
      const cfg = loadConfig();
      pool = createPool(cfg.databaseUrl);
      const db = pgDb(pool);
      const existing = await listOwners(db);
      if (existing.length > 0) {
        emit({ ok: true, value: existing[0]! }, (o) => `Ya existe el dueño ${o.id} (${o.label}).`);
        return;
      }
      emit(await createOwner(db, label), (o) => `Dueño creado: ${o.id} (${o.label})`);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exitCode = EXIT.error;
    } finally {
      await pool?.end().catch(() => {});
    }
  });

program
  .command('doctor')
  .description('revisa config, base de datos, migraciones, bucket y dueño')
  .action(async () => {
    let pool: pg.Pool | null = null;
    const checks: { check: string; ok: boolean; detail: string }[] = [];
    try {
      const cfg = loadConfig();
      checks.push({ check: 'config', ok: true, detail: `bucket ${cfg.s3.bucket} @ ${cfg.s3.endpoint}` });
      pool = createPool(cfg.databaseUrl);
      const db = pgDb(pool);

      try {
        await db.query('select 1');
        checks.push({ check: 'postgres', ok: true, detail: 'conectado' });
      } catch (e) {
        checks.push({ check: 'postgres', ok: false, detail: e instanceof Error ? e.message : String(e) });
      }

      try {
        const { rows } = await db.query<{ name: string }>('select name from schema_migrations order by name');
        checks.push({
          check: 'migraciones',
          ok: rows.length > 0,
          detail: rows.length ? rows.map((r) => r.name).join(', ') : 'ninguna aplicada — corre npm run migrate',
        });
      } catch {
        checks.push({ check: 'migraciones', ok: false, detail: 'sin tabla schema_migrations — corre npm run migrate' });
      }

      const blobs = s3BlobStore(cfg.s3);
      const healthy = await blobs.healthy();
      checks.push({ check: 'garage', ok: healthy, detail: healthy ? 'bucket accesible' : 'bucket inaccesible' });

      try {
        const owners = await listOwners(db);
        checks.push({
          check: 'dueño',
          ok: owners.length === 1,
          detail: owners.length === 0 ? 'ninguno — corre dm init' : owners.map((o) => `${o.id} (${o.label})`).join(', '),
        });
      } catch {
        checks.push({ check: 'dueño', ok: false, detail: 'no se pudo consultar' });
      }
    } catch (e) {
      checks.push({ check: 'config', ok: false, detail: e instanceof Error ? e.message : String(e) });
    } finally {
      await pool?.end().catch(() => {});
    }

    const allOk = checks.every((c) => c.ok);
    emit({ ok: true, value: checks }, (cs) =>
      cs.map((c) => `${c.ok ? '✓' : '✗'} ${c.check.padEnd(12)} ${c.detail}`).join('\n'));
    if (!allOk) process.exitCode = EXIT.error;
  });

// ---------------------------------------------------------------- captura

program
  .command('capture')
  .description('guarda un archivo, un texto o lo que venga por stdin')
  .argument('[path]', 'archivo a guardar, o "-" para leer stdin')
  .option('--text <texto>', 'texto suelto o pie del archivo')
  .option('--title <titulo>', 'título corto')
  .option('--occurred <fecha>', 'cuándo pasó el hecho (ej. 2026-03-14)')
  .option('--source <origen>', 'cli | telegram | email | manual', 'cli')
  .action(async (path: string | undefined, opts: Record<string, string>) => {
    const occurredAt = parseDate(opts.occurred);
    if (occurredAt === 'invalid') {
      emit({ ok: false, kind: 'invalid', message: `Fecha inválida: "${opts.occurred}".` }, () => '');
      return;
    }
    let bytes: Buffer | null = null;
    let filename: string | null = null;
    if (path === '-') {
      bytes = await readStdin();
      filename = null;
    } else if (path) {
      try {
        bytes = await readFile(path);
        filename = basename(path);
      } catch {
        emit({ ok: false, kind: 'not_found', message: `No pude leer "${path}".` }, () => '');
        return;
      }
    }
    await run(
      ({ deps, actor }) =>
        capture(deps, actor, {
          bytes,
          text: opts.text ?? null,
          filename,
          title: opts.title ?? null,
          occurredAt,
          source: (opts.source ?? 'cli') as never,
        }),
      (r) =>
        `guardado ✓ ${r.shortId}` +
        (r.sha256 ? `  ${r.mediaType}` : '') +
        (r.deduped ? '  (ya lo tenías: mismo archivo, memoria nueva)' : ''),
    );
  });

// ---------------------------------------------------------------- consulta

program
  .command('ls')
  .description('lista lo guardado, de lo más reciente a lo más viejo')
  .option('--limit <n>', 'cuántas mostrar', '20')
  .option('--offset <n>', 'desde cuál empezar', '0')
  .option('--hidden', 'incluir las ocultas')
  .action(async (opts: Record<string, string | boolean>) => {
    await run(
      ({ deps, actor }) =>
        list(deps, actor, {
          limit: Number(opts.limit),
          offset: Number(opts.offset),
          includeHidden: opts.hidden === true,
        }),
      renderList,
    );
  });

program
  .command('search')
  .description('busca por texto: entiende comillas, OR y - para excluir')
  .argument('<consulta>')
  .option('--limit <n>', 'cuántas mostrar', '20')
  .option('--offset <n>', 'desde cuál empezar', '0')
  .option('--hidden', 'incluir las ocultas')
  .action(async (query: string, opts: Record<string, string | boolean>) => {
    await run(
      ({ deps, actor }) =>
        search(deps, actor, {
          query,
          limit: Number(opts.limit),
          offset: Number(opts.offset),
          includeHidden: opts.hidden === true,
        }),
      (items) => (items.length === 0 ? 'No lo tengo.' : renderList(items)),
    );
  });

program
  .command('show')
  .description('muestra una memoria; acepta un prefijo de id')
  .argument('<id>')
  .action(async (id: string) => {
    await run(({ deps, actor }) => show(deps, actor, id), renderDetail);
  });

program
  .command('open')
  .description('escribe a disco el archivo original de una memoria')
  .argument('<id>')
  .option('-o, --output <archivo>', 'dónde escribirlo')
  .action(async (id: string, opts: Record<string, string>) => {
    await run(async ({ deps, actor }) => {
      const res = await fetchBlob(deps, actor, id);
      if (!res.ok) return res;
      const out = opts.output ?? res.value.filename;
      await writeFile(out, res.value.bytes);
      return { ok: true as const, value: { path: out, bytes: res.value.bytes.length, sha256: res.value.sha256 } };
    }, (v) => `escrito ${v.path}  (${v.bytes} bytes)`);
  });

// ---------------------------------------------------------------- ciclo de vida

program
  .command('hide')
  .description('saca una memoria de los resultados, sin destruirla')
  .argument('<id>')
  .action(async (id: string) => {
    await run(({ deps, actor }) => setHidden(deps, actor, id, true), (r) => `${r.shortId} oculta`);
  });

program
  .command('unhide')
  .description('vuelve a mostrar una memoria oculta')
  .argument('<id>')
  .action(async (id: string) => {
    await run(({ deps, actor }) => setHidden(deps, actor, id, false), (r) => `${r.shortId} visible`);
  });

program
  .command('purge')
  .description('borra una memoria para siempre; queda registrado en la auditoría')
  .argument('<id>')
  .option('--yes', 'confirmar el borrado')
  .action(async (id: string, opts: Record<string, boolean>) => {
    await run(
      ({ deps, actor }) => purge(deps, actor, id, { confirm: opts.yes === true }),
      (r) => `${r.shortId} purgada${r.blobDeleted ? ' (y su archivo)' : ''}`,
    );
  });

program.parseAsync(process.argv);
