#!/usr/bin/env node
import { basename } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { Command } from 'commander';
import type pg from 'pg';
import type PgBoss from 'pg-boss';
import { loadConfig } from '../../config.js';
import { createPool, pgDb } from '../db/postgres/index.js';
import { s3BlobStore } from '../storage/s3.js';
import { buildConverters } from '../normalize/index.js';
import { queueIngest, runWorker, startQueue } from '../queue/pgboss.js';
import { fakeChannel, fileAttachment } from '../chat/fake.js';
import { serveChannel } from '../chat/serve.js';
import { telegramChannel } from '../chat/telegram/index.js';
import type { Reply } from '../../core/channel/types.js';
import { inlineIngest } from '../../core/ingest.js';
import { systemClock, type Deps } from '../../core/ports.js';
import type { Actor, Lane } from '../../core/domain/types.js';
import type { Result } from '../../core/result.js';
import {
  capture, countReview, createOwner, fetchBlob, list, listIdentities, listOwners,
  listReview, mintPairingCode, purge, reprocess, resolveActor, search, setHidden,
  show, LANES,
} from '../../core/index.js';
import { EXIT, exitCodeFor } from './exit.js';
import { renderDetail, renderFailure, renderList, renderReview } from './format.js';

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

/**
 * `wait: true` corre los carriles acá mismo; `false` los encola. capture() no
 * distingue: recibe un Ingest y ya. Es lo único que hay que cambiar el día que
 * el que llame sea Telegram y no una terminal.
 */
function buildDeps(pool: pg.Pool, cfg: ReturnType<typeof loadConfig>, boss: PgBoss | null): Deps {
  const db = pgDb(pool);
  const deps = {
    db,
    blobs: s3BlobStore(cfg.s3),
    clock: systemClock,
    converters: buildConverters(cfg.normalize),
  } as Deps;
  deps.ingest = boss ? queueIngest(boss) : inlineIngest(() => deps);
  return deps;
}

/** Toda la fontanería de una invocación: config, pool, actor, render y cierre limpio. */
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
    // Solo los comandos que encolan pagan el arranque de pg-boss. `dm ls` no
    // tiene por qué correr las migraciones de una cola que no va a usar.
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

/** Lo que el canal devolvió, en la terminal. Un archivo se anuncia, no se vuelca. */
const renderReplies = (replies: Reply[]): string =>
  replies
    .map((r) =>
      r.kind === 'text'
        ? r.body
        : `[archivo: ${r.filename} · ${r.mediaType} · ${r.bytes.length} bytes]`,
    )
    .join('\n\n');

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
  .description('revisa config, base de datos, migraciones, bucket, dueño y carriles')
  .action(async () => {
    let pool: pg.Pool | null = null;
    // `required` separa lo roto de lo simplemente no configurado. Sin esa
    // distinción, no tener whisper instalado pintaría el sistema entero de rojo
    // y el rojo dejaría de significar nada.
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

      // Los tres carriles, uno por uno. Un carril caído no rompe el sistema
      // —lo que llega se guarda igual— pero deja de ser buscable por dentro,
      // que es justo lo que F1 vino a arreglar. Tiene que verse.
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

      // El canal, si hay token. Sin token no está roto: está sin configurar.
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
        // Filtrado por dueño como toda consulta del sistema (regla dura 9). Sin
        // esto, en cuanto exista una segunda persona `dm doctor` te reportaría
        // su pila de pendientes como si fuera tuya: el `WHERE` olvidado de §14,
        // en el comando cuyo trabajo es justamente detectar problemas.
        const who = await resolveActor(db, globals().actor ?? cfg.ownerId);
        if (!who.ok) {
          // Con varios dueños y sin decir cuál, contar sería inventar: filtrar
          // por nadie da cero, y un cero falso se lee como "está todo al día".
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
          // Se distingue lo que un reproceso arregla de lo que no: mandar a
          // reintentar algo que no puede mejorar enseña a desconfiar del consejo.
          const consejo = bandeja.reintentables > 0 ? ' — dm reprocess --failed' : ' — dm review';
          checks.push({
            check: 'normalizar',
            ok: idle,
            detail: idle
              ? 'nada pendiente'
              : `${pendientes} sin procesar, ${bandeja.total} por revisar` +
                (bandeja.total > 0 ? ` (${bandeja.reintentables} reintentables)` : '') +
                consejo,
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

    // El código de salida solo mira lo obligatorio: un carril apagado se ve,
    // pero no convierte a `dm doctor` en algo que siempre falla.
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
  .option('--source <origen>', 'cli | telegram | email | manual', 'cli')
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
        // El link es el punto entero de §10: tu mamá lo abre y está adentro. Sin
        // cuenta, sin contraseña, sin instalar nada que no tenga ya.
        const link = bot ? `\n\nhttps://t.me/${bot}?start=${c.code}` : '';
        return `código  ${c.code}   (vence en ${minutos} min, un solo uso)${link}`;
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

      // supportsButtons: false a propósito. Este canal es el que mantiene
      // honesta la degradación de §7.1 — si solo existiera Telegram, la rama
      // sin botones no la ejercitaría nunca nadie.
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
      // Encola, no corre inline: si el acuse esperara al OCR se rompería el
      // contrato de menos de un segundo (§7). Implica que el worker tiene que
      // estar corriendo, y por eso la respuesta de búsqueda dice qué falta leer.
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

// ---------------------------------------------------------------- normalización

program
  .command('review')
  .description('lo que quedó dudoso y qué hacer con cada cosa')
  .option('--limit <n>', 'cuántas mostrar', '20')
  .action(async (opts: Record<string, string>) => {
    await run(
      ({ deps, actor }) => listReview(deps, actor, { limit: Number(opts.limit) }),
      renderReview,
    );
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

      // Terminar de procesar lo que está en la mano antes de morir: si no, una
      // memoria queda a medio normalizar y con normalized_at ya escrito.
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
  .description('vuelve a correr los carriles desde el original (UC-15)')
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
