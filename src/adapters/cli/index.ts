#!/usr/bin/env node
import { basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { Command } from 'commander';
import type pg from 'pg';
import type PgBoss from 'pg-boss';
import { loadConfig } from '../../config';
import { createPool, pgDb } from '../db/postgres/index';
import { s3BlobStore } from '../storage/s3';
import { buildConverters } from '../normalize/index';
import { ollamaClassifier } from '../classify/ollama';
import { ollamaEmbedder } from '../classify/embed';
import { queueIngest, runWorker, startQueue } from '../queue/pgboss';
import { fakeChannel, fileAttachment } from '../chat/fake';
import { serveChannel } from '../chat/serve';
import { telegramChannel } from '../chat/telegram/index';
import type { Reply } from '../../core/channel/types';
import { inlineIngest } from '../../core/ingest';
import { systemClock, type Deps } from '../../core/ports';
import type { Actor, Lane } from '../../core/domain/types';
import type { Fact, FactType } from '../../core/index';
import { ok, type Result } from '../../core/result';
import {
  acceptProposal, archiveDomain, capture, classifyMemory, countReview, createDomain, createOwner, editDomain,
  fetchBlob, findDomain, list, listDomains, listIdentities, listOwners, listReview,
  mergeDomains, mintPairingCode, purge, reprocess, resolveActor, search, setHidden,
  answer, indexMemory, pendingIndex, proposeDomains, resolveMemoryId, show, unindexed, LANES,
  seedDomains, seedFactTypes, extractFacts, listFacts, listFactTypes, contextOf, renderValue, warningFor,
} from '../../core/index';
import { EXIT, exitCodeFor } from './exit';
import { renderAnswer, renderDetail, renderFailure, renderList, renderReview } from './format';

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
    // stdout is the value channel; everything else goes to stderr, confirmations
    // included. That way piping JSON into a parser never receives anything but data.
    console.error(json ? JSON.stringify(payload) : renderFailure(result));
  }
  process.exitCode = exitCodeFor(result);
}

/**
 * Waiting runs the lanes inline; otherwise they are queued. capture() cannot
 * tell: it receives an ingest port and that is all. It is the only thing that
 * changes when the caller is a chat channel and not a terminal.
 */
function buildDeps(pool: pg.Pool, cfg: ReturnType<typeof loadConfig>, boss: PgBoss | null): Deps {
  const db = pgDb(pool);
  const deps = {
    db,
    blobs: s3BlobStore(cfg.s3),
    clock: systemClock,
    converters: buildConverters(cfg.normalize),
    classifier: ollamaClassifier(cfg.classify),
    embedder: ollamaEmbedder(cfg.embed),
  } as Deps;
  deps.ingest = boss ? queueIngest(boss) : inlineIngest(() => deps);
  return deps;
}

/** All the plumbing of one invocation: config, pool, actor, render, clean close. */
async function run<T>(
  fn: (ctx: Ctx) => Promise<Result<T>>,
  render: (v: T) => string,
  opts: { enqueues?: boolean; wait?: boolean } = {},
): Promise<void> {
  let pool: pg.Pool | null = null;
  let boss: PgBoss | null = null;
  try {
    const cfg = loadConfig();
    pool = createPool(cfg.databaseUrl);
    // Only the commands that enqueue pay for starting the queue. Listing has no
    // business running the migrations of a queue it will not use.
    boss = opts.enqueues && !opts.wait ? await startQueue(cfg.databaseUrl) : null;
    const deps = buildDeps(pool, cfg, boss);
    const actor = await resolveActor(deps.db, globals().actor ?? cfg.ownerId);
    if (!actor.ok) return emit(actor, () => '');
    emit(await fn({ deps, actor: { ownerId: actor.value } }), render);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = EXIT.error;
  } finally {
    await boss?.stop({ wait: true }).catch(() => {});
    await pool?.end().catch(() => {});
  }
}

/** What the channel returned, in the terminal. A file is announced, not dumped. */
const renderReplies = (replies: Reply[]): string =>
  replies
    .map((r) =>
      r.kind === 'text'
        ? r.body
        : `[archivo: ${r.filename} · ${r.mediaType} · ${r.bytes.length} bytes]`,
    )
    .join('\n\n');

/**
 * Whether a bot process is alive on this machine.
 *
 * Reading the process table is crude, but it is the only thing that answers the
 * real question — is anyone listening? — without inventing a heartbeat table for
 * a single-person system.
 */
const serveActivo = (): boolean => {
  try {
    const ps = execFileSync('ps', ['-Ao', 'args'], { encoding: 'utf8' });
    // Exige `node …index.js serve` y no solo la cadena suelta: buscar el texto
    // a secas cuenta como un bot vivo cualquier `grep index.js serve` o el
    // very kill command that ended it — which is exactly how this check got it wrong
    // the first time.
    return ps.split('\n').some((l) => /(^|\/)node\s+\S*index\.js\s+serve(\s|$)/.test(l));
  } catch {
    // Without the process table there is no way to know, and claiming it is missing
    return true;
  }
};

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
        // Idempotent: seeds are filled in for an owner that already exists too. Without
        // this, a new fact type would only reach whoever starts from scratch, which is
        // exactly backwards.
        await seedDomains(db, existing[0]!.id);
        await seedFactTypes(db, existing[0]!.id);
        emit({ ok: true, value: existing[0]! }, (o) => `Ya existe el dueño ${o.id} (${o.label}). Semillas al día.`);
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
  .description('revisa config, base de datos, migraciones, bucket, dueño y carriles')
  .action(async () => {
    let pool: pg.Pool | null = null;
    // `required` separates broken from merely unconfigured. Without that distinction,
    // not having a speech service would paint the whole system red, and red would
    // stop meaning anything.
    const checks: { check: string; ok: boolean; detail: string; required: boolean }[] = [];
    try {
      const cfg = loadConfig();
      checks.push({ check: 'config', ok: true, detail: `bucket ${cfg.s3.bucket} @ ${cfg.s3.endpoint}`, required: true });
      pool = createPool(cfg.databaseUrl);
      const db = pgDb(pool);

      try {
        await db.query('select 1');
        checks.push({ check: 'postgres', ok: true, detail: 'conectado', required: true });
      } catch (e) {
        checks.push({ check: 'postgres', ok: false, detail: e instanceof Error ? e.message : String(e), required: true });
      }

      try {
        const { rows } = await db.query<{ name: string }>('select name from schema_migrations order by name');
        checks.push({
          check: 'migraciones',
          ok: rows.length > 0,
          detail: rows.length ? rows.map((r) => r.name).join(', ') : 'ninguna aplicada — corre npm run migrate',
          required: true,
        });
      } catch {
        checks.push({ check: 'migraciones', ok: false, detail: 'sin tabla schema_migrations — corre npm run migrate', required: true });
      }

      const blobs = s3BlobStore(cfg.s3);
      const healthy = await blobs.healthy();
      checks.push({ check: 'garage', ok: healthy, detail: healthy ? 'bucket accesible' : 'bucket inaccesible', required: true });

      try {
        const owners = await listOwners(db);
        checks.push({
          check: 'dueño',
          ok: owners.length === 1,
          detail: owners.length === 0 ? 'ninguno — corre dm init' : owners.map((o) => `${o.id} (${o.label})`).join(', '),
          required: true,
        });
      } catch {
        checks.push({ check: 'dueño', ok: false, detail: 'no se pudo consultar', required: true });
      }

      // The three lanes, one by one. A lane being down does not break the system —
      // what arrives is stored anyway — but it stops being searchable by content,
      // which is the whole point of reading files. It has to be visible.
      const converters = buildConverters(cfg.normalize);
      const lanes: [string, string][] = [
        ['carril doc', 'document'],
        ['carril foto', 'vision'],
        ['carril audio', 'audio'],
      ];
      for (const [label, key] of lanes) {
        const converter = converters[key as 'document' | 'vision' | 'audio'];
        if (!converter) {
          checks.push({ check: label, ok: false, detail: 'sin configurar', required: false });
          continue;
        }
        const state = await converter.available();
        checks.push({ check: label, ok: state.ok, detail: state.detail, required: false });
      }

      // The channel, if there is a token. No token is not broken: it is unconfigured.
      if (!cfg.telegram) {
        checks.push({ check: 'canal', ok: false, required: false, detail: 'sin TELEGRAM_BOT_TOKEN' });
      } else {
        const estado = await telegramChannel(cfg.telegram).healthy();
        const vinculados = await listIdentities(db).catch(() => []);
        checks.push({
          check: 'canal',
          ok: estado.ok,
          required: false,
          detail: estado.ok
            ? `${estado.detail} · ${vinculados.length} chat(s) vinculado(s)`
            : estado.detail,
        });
      }

      try {
        // Filtered by owner like every query in the system. Without this, the moment a
        // second person exists the health check would report their pending pile as
        // yours: the forgotten WHERE, in the command whose job is spotting problems.
        // en el comando cuyo trabajo es justamente detectar problemas.
        const who = await resolveActor(db, globals().actor ?? cfg.ownerId);
        if (!who.ok) {
          // With several owners and none named, counting would be inventing: filtering by
          // nobody yields zero, and a false zero reads as "everything is up to date".
          checks.push({ check: 'normalizar', ok: false, required: false,
            detail: 'hay más de un dueño: indica cuál con --actor para ver su pendiente' });
        } else {
          const { rows } = await db.query<{ pendientes: string; fallidas: string }>(
            `select count(*) filter (where blob_sha256 is not null and normalized_at is null)::text as pendientes,
                    count(*) filter (where normalization_error is not null)::text as fallidas
               from memories
              where owner_id = $1`,
            [who.value],
          );
          const { pendientes } = rows[0]!;
          const bandeja = await countReview(db, { ownerId: who.value });
          const idle = pendientes === '0' && bandeja.total === 0;
          // What a reprocess fixes is distinguished from what it does not: telling someone
          // to retry something that cannot improve teaches distrust of the advice.
          const consejo = bandeja.retryable > 0 ? ' — dm reprocess --failed' : ' — dm review';
          checks.push({
            check: 'normalizar',
            ok: idle,
            detail: idle
              ? 'nada pendiente'
              : `${pendientes} sin procesar, ${bandeja.total} por revisar` +
                (bandeja.total > 0 ? ` (${bandeja.retryable} retryable)` : '') +
                consejo,
            required: false,
          });

          // Its own row, and not a line of the previous one, because a missing category
          // was invisible for a whole phase: fifteen documents normalized, none
          // normalizados, ninguno clasificado, y `doctor` en verde. Un chequeo
          // categorized, and a green check. A check that ignores the next step gives
          const { rows: sin } = await db.query<{ n: string }>(
            `select count(*)::text as n from memories
              where owner_id = $1 and not hidden and domain_id is null
                and (normalized_text is not null or note is not null)`,
            [who.value],
          );
          const uncategorized = Number(sin[0]!.n);
          checks.push({
            check: 'clasificar',
            ok: uncategorized === 0,
            detail: uncategorized === 0
              ? 'todas categorizadas'
              : `${uncategorized} sin categoría — dm classify`,
            required: false,
          });
        }
      } catch {
        checks.push({ check: 'normalizar', ok: false, detail: 'no se pudo consultar — ¿falta migrar?', required: true });
      }
    } catch (e) {
      checks.push({ check: 'config', ok: false, detail: e instanceof Error ? e.message : String(e), required: true });
    } finally {
      await pool?.end().catch(() => {});
    }

    // The exit code only looks at what is required: a lane being off is visible but
    // does not turn the health check into something that always fails.
    const broken = checks.some((c) => c.required && !c.ok);
    emit({ ok: true, value: checks }, (cs) =>
      cs.map((c) => `${c.ok ? '✓' : c.required ? '✗' : '·'} ${c.check.padEnd(13)} ${c.detail}`).join('\n'));
    if (broken) process.exitCode = EXIT.error;
  });

// ---------------------------------------------------------------- captura

program
  .command('capture')
  .description('guarda un archivo, un texto o lo que venga por stdin')
  .argument('[path]', 'archivo a guardar, o "-" para leer stdin')
  .option('--text <texto>', 'texto suelto o pie del archivo')
  .option('--title <titulo>', 'título corto')
  .option('--occurred <fecha>', 'cuándo pasó el hecho (ej. 2026-03-14)')
  .option('--source <origen>', 'cli | telegram | manual', 'cli')
  .option('--wait', 'corre los carriles ahora y espera, en vez de encolar')
  .action(async (path: string | undefined, opts: Record<string, string | boolean>) => {
    const occurredAt = parseDate(opts.occurred as string | undefined);
    if (occurredAt === 'invalid') {
      emit({ ok: false, kind: 'invalid', message: `Fecha inválida: "${opts.occurred}".` }, () => '');
      return;
    }
    const wait = opts.wait === true;
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
          text: (opts.text as string) ?? null,
          filename,
          title: (opts.title as string) ?? null,
          occurredAt,
          source: (opts.source ?? 'cli') as never,
        }),
      (r) =>
        `guardado ✓ ${r.shortId}` +
        (r.sha256 ? `  ${r.mediaType}` : '') +
        (r.deduped ? '  (ya lo tenías: mismo archivo, memoria nueva)' : '') +
        (wait || !r.sha256 ? '' : '  · en cola para normalizar'),
      { enqueues: true, wait },
    );
  });

// ---------------------------------------------------------------- query

program
  .command('ls')
  .description('lista lo guardado, de lo más reciente a lo más viejo')
  .option('--limit <n>', 'cuántas shown', '20')
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
  .argument('<query>')
  .option('--limit <n>', 'cuántas shown', '20')
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
  .description('vuelve a shown una memoria oculta')
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

// ---------------------------------------------------------------- canal

program
  .command('pair')
  .description('acuña un código de un solo uso para vincular un chat a tu cuenta')
  .option('--bot <usuario>', 'usuario del bot, para imprimir el link directo')
  .action(async (opts: Record<string, string>) => {
    await run(
      async ({ deps, actor }) => mintPairingCode(deps.db, actor.ownerId, deps.clock.now()),
      (c) => {
        const minutos = Math.round((c.expiresAt.getTime() - Date.now()) / 60000);
        const bot = opts.bot?.replace(/^@/, '');
        // A code with nobody listening is a link that cannot work, and staying quiet
        // sends the person to inspect the code — which is fine — instead of the process
        // that is missing.
        const sinBot = !serveActivo()
          ? '\n\n⚠ No veo "dm serve" corriendo: el bot no va a contestar. Levántalo en otra terminal.'
          : '';
        // The link is the entire point: someone opens it and is inside. No account, no
        // password, nothing to install that they do not already have.
        const link = bot ? `\n\nhttps://t.me/${bot}?start=${c.code}` : '';
        return `código  ${c.code}   (vence en ${minutos} min, un solo uso)${link}${sinBot}`;
      },
    );
  });

program
  .command('identities')
  .description('lista los chats vinculados a tu cuenta')
  .action(async () => {
    await run(
      async ({ deps, actor }) => ({ ok: true as const, value: await listIdentities(deps.db, actor.ownerId) }),
      (ids) =>
        ids.length === 0
          ? 'Ningún chat vinculado. Corre "dm pair" para empezar.'
          : ids.map((i) => `${i.channel.padEnd(10)} ${i.externalUserId.padEnd(16)} ${i.displayName ?? ''}`).join('\n'),
    );
  });

program
  .command('chat')
  .description('conversa con el bot sin Telegram, por un canal en memoria')
  .argument('[mensaje]', 'lo que le dirías al bot')
  .option('--file <archivo>', 'adjuntar un archivo, como una foto en el chat')
  .option('--as <id>', 'hablar como otra identidad, para probar aislamiento')
  .action(async (mensaje: string | undefined, opts: Record<string, string>) => {
    let pool: pg.Pool | null = null;
    let boss: PgBoss | null = null;
    try {
      const cfg = loadConfig();
      pool = createPool(cfg.databaseUrl);
      boss = await startQueue(cfg.databaseUrl);
      const deps = buildDeps(pool, cfg, boss);

      // No button support, on purpose. This channel is what keeps degradation honest —
      // if only the real one existed, the button-free branch would never be exercised
      // by anyone.
      const channel = fakeChannel(opts.as ? { externalUserId: opts.as } : {});
      await serveChannel(channel, deps);

      const replies: Reply[] = opts.file
        ? await channel.send({ text: mensaje ?? null, attachment: await fileAttachment(opts.file) })
        : await channel.send({ text: mensaje ?? null });

      console.log(renderReplies(replies));
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exitCode = EXIT.error;
    } finally {
      await boss?.stop({ wait: true }).catch(() => {});
      await pool?.end().catch(() => {});
    }
  });

program
  .command('serve')
  .description('atiende el bot de Telegram; se queda escuchando')
  .action(async () => {
    let pool: pg.Pool | null = null;
    let boss: PgBoss | null = null;
    let handle: { stop(): Promise<void> } | null = null;
    try {
      const cfg = loadConfig();
      if (!cfg.telegram) {
        console.error('Falta TELEGRAM_BOT_TOKEN. Pídeselo a @BotFather y ponlo en .env.local.');
        process.exitCode = EXIT.error;
        return;
      }
      pool = createPool(cfg.databaseUrl);
      // Enqueues rather than running inline: if the acknowledgement waited for OCR it
      // would break the sub-second contract. That implies the worker has to be running,
      // which is why a search reply says what is still unread.
      boss = await startQueue(cfg.databaseUrl);
      const deps = buildDeps(pool, cfg, boss);

      const channel = telegramChannel(cfg.telegram);
      const quien = await channel.healthy();
      if (!quien.ok) {
        console.error(`No pude hablar con Telegram: ${quien.detail}`);
        process.exitCode = EXIT.error;
        return;
      }

      handle = await serveChannel(channel, deps, { onEvent: (l) => console.log(l) });
      console.error(`escuchando como ${quien.detail}. ctrl-c para salir.`);

      await new Promise<void>((resolve) => {
        const bye = () => { console.error('\ncerrando…'); resolve(); };
        process.once('SIGINT', bye);
        process.once('SIGTERM', bye);
      });
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exitCode = EXIT.error;
    } finally {
      await handle?.stop().catch(() => {});
      await boss?.stop({ wait: true }).catch(() => {});
      await pool?.end().catch(() => {});
    }
  });

// --------------------------------------------------------------- normalization

// ---------------------------------------------------------------- dominios

const domains = program.command('domains').description('tus categorías (§9)');

domains
  .command('list', { isDefault: true })
  .description('las activas, con cuántas memorias tiene cada una')
  .option('--all', 'incluir las archivadas')
  .action(async (opts: Record<string, boolean>) => {
    await run(
      async ({ deps, actor }) => ({
        ok: true as const,
        value: await listDomains(deps.db, actor, { includeArchived: opts.all === true }),
      }),
      (ds) =>
        ds.length === 0
          ? 'No hay dominios.'
          : ds.map((d) =>
              `${(d.active ? '' : '· ') + '/' + d.slug}`.padEnd(16) +
              `${String(d.count ?? 0).padStart(4)}  ${d.label}` +
              (d.active ? '' : '  [archivado]'),
            ).join('\n'),
    );
  });

domains
  .command('create')
  .description('crea una categoría nueva')
  .argument('<nombre>')
  .requiredOption('--desc <descripcion>', 'una línea; es lo que usa el clasificador')
  .option('--alias <a...>', 'otros nombres por los que la reconoces')
  .option('--yes', 'crear aunque se parezca a una existente')
  .action(async (nombre: string, opts: Record<string, unknown>) => {
    await run(
      ({ deps, actor }) =>
        createDomain(deps.db, actor, {
          label: nombre,
          description: String(opts.desc),
          aliases: (opts.alias as string[]) ?? [],
          confirm: opts.yes === true,
        }),
      (d) => `/${d.slug}  ${d.label}`,
    );
  });

domains
  .command('edit')
  .description('cambia nombre, descripción o alias; no toca las memorias')
  .argument('<dominio>')
  .option('--label <nombre>')
  .option('--desc <descripcion>')
  .option('--alias <a...>')
  .action(async (ref: string, opts: Record<string, unknown>) => {
    await run(
      ({ deps, actor }) =>
        editDomain(deps.db, actor, ref, {
          ...(opts.label ? { label: String(opts.label) } : {}),
          ...(opts.desc ? { description: String(opts.desc) } : {}),
          ...(opts.alias ? { aliases: opts.alias as string[] } : {}),
        }),
      (d) => `/${d.slug}  ${d.label} — ${d.description}`,
    );
  });

domains
  .command('archive')
  .description('deja de proponerse al clasificar; sus memorias siguen ahí')
  .argument('<dominio>')
  .action(async (ref: string) => {
    await run(({ deps, actor }) => archiveDomain(deps.db, actor, ref), (d) => `/${d.slug} archivado`);
  });

domains
  .command('propose')
  .description('busca categorías que te faltan entre lo que quedó sin clasificar')
  .option('--accept <palabra>', 'acepta una propuesta y mueve sus memorias')
  .option('--label <nombre>', 'nombre distinto al propuesto')
  .option('--desc <descripcion>', 'descripción distinta a la propuesta')
  .action(async (opts: Record<string, string>) => {
    await run(async ({ deps, actor }) => {
      const r = await proposeDomains(deps, actor);
      if (!r.ok) return r;

      if (!opts.accept) {
        return { ok: true as const, value: r.value.map((p) =>
          [
            `${p.memoryIds.length} cosas parecen "${p.label}" (/${p.slug})`,
            `   descripción sugerida: ${p.description}`,
            ...p.examples.map((e) => `   · ${e}`),
            `   aceptar: dm domains propose --accept ${p.slug}`,
          ].join('\n')) };
      }

      // Compared against the slug and not the word: a tag with spaces in it cannot be
      // typed as an argument.
      const buscado = String(opts.accept).toLowerCase();
      const elegida = r.value.find((p) => p.keyword === buscado || p.slug === buscado);
      if (!elegida) {
        return { ok: false as const, kind: 'not_found' as const,
                 message: `No hay una propuesta "${opts.accept}". Corre dm domains propose.` };
      }
      const done = await acceptProposal(deps, actor, {
        label: opts.label ?? elegida.label,
        description: opts.desc ?? elegida.description,
        memoryIds: elegida.memoryIds,
      });
      if (!done.ok) return done;
      return { ok: true as const, value: [`/${done.value.domain.slug}  ${done.value.moved} memoria(s) movidas`] };
    }, (ls) => (ls.length === 0 ? 'No veo categorías que te falten.' : ls.join('\n\n')));
  });

domains
  .command('merge')
  .description('mueve las memorias de una categoría a otra y archiva la primera')
  .argument('<desde>')
  .argument('<hacia>')
  .option('--yes', 'confirmar')
  .action(async (from: string, into: string, opts: Record<string, boolean>) => {
    await run(
      ({ deps, actor }) => mergeDomains(deps, actor, from, into, { confirm: opts.yes === true }),
      (r) => `${r.moved} memoria(s) de /${r.from.slug} → /${r.into.slug}; /${r.from.slug} archivado`,
    );
  });

program
  .command('in')
  .description('lista lo de una categoría, por fecha del hecho')
  .argument('<dominio>')
  .option('--limit <n>', 'cuántas shown', '20')
  .action(async (ref: string, opts: Record<string, string>) => {
    await run(async ({ deps, actor }) => {
      const d = await findDomain(deps.db, actor, ref);
      if (!d) return { ok: false as const, kind: 'not_found' as const, message: `No existe el dominio "${ref}".` };
      return list(deps, actor, { domainId: d.id, limit: Number(opts.limit) });
    }, renderList);
  });

program
  .command('classify')
  .description('pone dominio, título y fecha del hecho con el modelo local')
  .argument('[id]', 'una memoria; sin id, las que no tengan dominio')
  .option('--limit <n>', 'cuántas', '20')
  .action(async (id: string | undefined, opts: Record<string, string>) => {
    await run(async ({ deps, actor }) => {
      let ids: string[] = [];
      if (id) {
        const r = await resolveMemoryId(deps.db, actor, id);
        if (!r.ok) return r;
        ids = [r.value];
      } else {
        const { rows } = await deps.db.query<{ id: string }>(
          `select id from memories
            where owner_id = $1 and domain_id is null and not hidden
              and (normalized_text is not null or note is not null)
            order by captured_at desc limit $2`,
          [actor.ownerId, Number(opts.limit)],
        );
        ids = rows.map((r) => r.id);
      }

      const hechas: string[] = [];
      for (const memId of ids) {
        const r = await classifyMemory(deps, actor, memId);
        // One failure does not stop the batch: it is noted and the run continues. Dying
        // halfway would leave half the corpus classified and half not, silently.
        hechas.push(
          r.ok
            ? `✓ ${r.value.id.slice(0, 8)}  ${r.value.domain ?? '—'}  ${r.value.title}` +
              (r.value.occurredAt ? `  (${r.value.occurredAt})` : '') +
              `  ${r.value.confidence.toFixed(2)}`
            : `✗ ${memId.slice(0, 8)}  ${r.message}`,
        );
      }
      return { ok: true as const, value: hechas };
    }, (ls) => (ls.length === 0 ? 'Nada que clasificar.' : ls.join('\n')));
  });

program
  .command('ask')
  .description('pregunta en lenguaje natural; responde citando lo que guardaste')
  .argument('<pregunta>')
  .option('--in <categoria>', 'acotar a una categoría')
  .option('--from <date>')
  .option('--until <date>')
  .option('--solo-fuentes', 'sin redactar: solo los pasajes que respondieron')
  .action(async (pregunta: string, opts: Record<string, string | boolean>) => {
    await run(
      ({ deps, actor }) =>
        answer(deps, actor, {
          query: pregunta,
          domain: (opts.in as string) ?? null,
          from: opts.from ? new Date(String(opts.from)) : null,
          until: opts.until ? new Date(String(opts.until)) : null,
          synthesize: opts.soloFuentes !== true,
        }),
      renderAnswer,
    );
  });

program
  .command('index')
  .description('trocea y vectoriza lo que falte, para poder preguntar')
  .option('--limit <n>', 'cuántas', '200')
  .action(async (opts: Record<string, string>) => {
    await run(async ({ deps, actor }) => {
      const ids = await unindexed(deps, actor, Number(opts.limit));
      const lineas: string[] = [];
      for (const id of ids) {
        const r = await indexMemory(deps, actor, id);
        lineas.push(r.ok ? `✓ ${r.value.memoryId.slice(0, 8)}  ${r.value.chunks} trozos`
                         : `✗ ${id.slice(0, 8)}  ${r.message}`);
      }
      return { ok: true as const, value: lineas };
    }, (ls) => (ls.length === 0 ? 'Todo indexado.' : ls.join('\n')));
  });

program
  .command('review')
  .description('lo que quedó dudoso y qué hacer con cada cosa')
  .option('--limit <n>', 'cuántas shown', '20')
  .action(async (opts: Record<string, string>) => {
    await run(
      ({ deps, actor }) => listReview(deps, actor, { limit: Number(opts.limit) }),
      renderReview,
    );
  });

const facts = program
  .command('facts')
  .description('los datos duros extraídos de tus documentos (§4)');

facts
  .command('list', { isDefault: true })
  .description('lo vigente, con su cita')
  .option('--all', 'incluye lo superado')
  .action(async (opts: Record<string, boolean>) => {
    await run(
      async ({ deps, actor }): Promise<Result<Fact[]>> =>
        ok(await listFacts(deps.db, actor, { includeSuperseded: opts.all === true })),
      (fs) => (fs.length === 0
        ? 'Todavía no tengo datos duros. Manda una póliza o una cartola.'
        : fs.map((f) => {
            const campos = Object.entries(f.payload)
              .map(([k, v]) => `    ${k}: ${v}`).join('\n');
            const cuando = f.validFrom || f.validUntil
              ? `  ${f.validFrom?.toISOString().slice(0, 10) ?? '—'} → ${f.validUntil?.toISOString().slice(0, 10) ?? '—'}`
              : '';
            const sup = f.supersededBy ? '  ⚠ superado' : '';
            return `${f.shortId}  ${f.typeLabel}${cuando}${sup}\n${campos}`;
          }).join('\n\n')),
    );
  });

facts
  .command('types')
  .description('qué sabe extraer, y de qué categoría')
  .action(async () => {
    await run(
      async ({ deps, actor }): Promise<Result<FactType[]>> => ok(await listFactTypes(deps.db, actor)),
      (ts) => ts.map((t) =>
        `${t.slug}  (${t.kind})  ← ${t.domainSlug ?? 'cualquier categoría'}\n` +
        t.fields.map((f) => `    ${f.name}: ${f.label} [${f.kind}]  ~ ${f.aliases.join(', ')}`).join('\n'),
      ).join('\n\n'),
    );
  });

facts
  .command('extract')
  .description('vuelve a extraer de una memoria, o de todas las que apliquen')
  .argument('[id]', 'memoria; sin id, todas las clasificadas')
  .action(async (id: string | undefined) => {
    await run(async ({ deps, actor }): Promise<Result<string[]>> => {
      const linea = (o: { shortId: string; extracted: string[]; discarded: string[] }) => {
        const desc = o.discarded.length ? `  (sin respaldo: ${o.discarded.join(', ')})` : '';
        return `${o.extracted.length ? '✓' : '·'} ${o.shortId}  ${o.extracted.join(', ') || 'ningún tipo aplicó'}${desc}`;
      };

      if (id) {
        const resolved = await resolveMemoryId(deps.db, actor, id);
        if (!resolved.ok) return resolved;
        const out = await extractFacts(deps, actor, resolved.value);
        return out.ok ? ok([linea(out.value)]) : out;
      }

      // With no id: everything with a category and text. Idempotent — the uniqueness
      // constraint makes re-extraction replace rather than duplicate.
      const { rows } = await deps.db.query<{ id: string }>(
        `select m.id from memories m
          where m.owner_id = $1 and not m.hidden and m.domain_id is not null
            and (m.normalized_text is not null or m.note is not null)
          order by m.captured_at desc`,
        [actor.ownerId],
      );
      const lineas: string[] = [];
      for (const r of rows) {
        const out = await extractFacts(deps, actor, r.id);
        if (out.ok && out.value.extracted.length > 0) lineas.push(linea(out.value));
      }
      return ok(lineas);
    }, (v) => (v.length === 0 ? 'Nada que extraer.' : v.join('\n')));
  });

program
  .command('worker')
  .description('corre los carriles sobre lo que va llegando; se queda escuchando')
  .action(async () => {
    let pool: pg.Pool | null = null;
    let boss: PgBoss | null = null;
    try {
      const cfg = loadConfig();
      pool = createPool(cfg.databaseUrl);
      boss = await startQueue(cfg.databaseUrl, { supervise: true });
      const deps = buildDeps(pool, cfg, boss);
      const handle = await runWorker(boss, deps);
      console.error('escuchando. ctrl-c para salir.');

      // Finish what is in hand before dying: otherwise a memory is left half
      // normalized with its timestamp already written.
      await new Promise<void>((resolve) => {
        const bye = () => { console.error('\ncerrando…'); resolve(); };
        process.once('SIGINT', bye);
        process.once('SIGTERM', bye);
      });
      await handle.stop();
      boss = null;
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exitCode = EXIT.error;
    } finally {
      await boss?.stop({ wait: true }).catch(() => {});
      await pool?.end().catch(() => {});
    }
  });

program
  .command('reprocess')
  .description('vuelve a correr los carriles desde el original')
  .argument('[id]', 'una memoria concreta')
  .option('--failed', 'las que fallaron o quedaron a medias')
  .option('--pending', 'las que nunca pasaron por un carril')
  .option('--all', 'todas las que tienen archivo')
  .option('--lane <carril>', `acota a un carril: ${LANES.join(' | ')}`)
  .option('--limit <n>', 'tope de memorias', '100')
  .option('--wait', 'corre los carriles ahora y espera, en vez de encolar')
  .option('--yes', 'confirmar cuando son varias')
  .action(async (id: string | undefined, opts: Record<string, string | boolean>) => {
    const lane = (opts.lane as string | undefined) ?? null;
    if (lane && !LANES.includes(lane as Lane)) {
      emit({ ok: false, kind: 'invalid', message: `Carril inválido: "${lane}". Válidos: ${LANES.join(', ')}.` }, () => '');
      return;
    }
    const wait = opts.wait === true;
    await run(
      ({ deps, actor }) =>
        reprocess(deps, actor, {
          ref: id ?? null,
          failed: opts.failed === true,
          pending: opts.pending === true,
          all: opts.all === true,
          lane: lane as Lane | null,
          limit: Number(opts.limit),
          confirm: opts.yes === true,
        }),
      (r) =>
        r.queued === 0
          ? 'No hay nada que reprocesar.'
          : wait
            ? `reprocesadas ${r.queued}`
            : `en cola ${r.queued}  (corre dm worker si no lo tienes andando)`,
      { enqueues: true, wait },
    );
  });

program.parseAsync(process.argv);
