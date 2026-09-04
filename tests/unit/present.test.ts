import { describe, expect, it } from 'vitest';
import { present } from '../../src/adapters/chat/present';
import type { Capabilities, Reply } from '../../src/core/channel/types';
import type { Outcome } from '../../src/core/router/route';
import type { MemorySummary } from '../../src/core/domain/types';
import { ok } from '../../src/core/result';

const CAPS: Capabilities = {
  maxUploadBytes: 50 * 1024 * 1024,
  maxDownloadBytes: 20 * 1024 * 1024,
  supportsButtons: true,
  supportsRichFormatting: true,
  canInitiate: false,
};

const conBotones: Capabilities = { ...CAPS, supportsButtons: true };
const sinBotones: Capabilities = { ...CAPS, supportsButtons: false };

const item = (n: number): MemorySummary => ({
  id: `00000000-0000-0000-0000-00000000000${n}`,
  shortId: `id${n}`,
  title: `Póliza ${n}`,
  source: 'telegram',
  capturedAt: new Date('2026-03-14T12:00:00Z'),
  occurredAt: null,
  originalFilename: null,
  mediaType: 'application/pdf',
  sizeBytes: 1000,
  hidden: false,
  excerpt: null,
  domainId: null,
  domainLabel: null,
  tags: [],
});

type Resultados = Extract<Outcome, { kind: 'results' }>;

const resultados = (n: number, hasMore: boolean): Resultados => ({
  kind: 'results',
  query: 'poliza',
  items: Array.from({ length: n }, (_, i) => item(i + 1)),
  offset: 0,
  hasMore,
  pendientes: 0,
  offerSave: null,
  exhausted: false,
});

const actionsOf = (rs: Reply[]): string[] =>
  rs.flatMap((r) => (r.kind === 'text' ? (r.options ?? []).map((o) => o.action) : []));

/** The first text reply, already narrowed. A file reply has no body. */
const textReply = (rs: Reply[]) => {
  const r = rs.find((x) => x.kind === 'text');
  if (!r || r.kind !== 'text') throw new Error('no hubo respuesta de texto');
  return r;
};

const bodyOf = (rs: Reply[]): string =>
  rs.map((r) => (r.kind === 'text' ? r.body : '')).join('\n');

/**
 * El test que sostiene §7.1.
 *
 * If a channel without buttons offered less than one with them, "the core
 * degrades on its own" would be an intention written in a comment. Here both
 * forms are checked to offer exactly the same, and the button-free one to say in
 * the body what to type.
 */
describe('degradación · las mismas acciones con y sin botones', () => {
  it('una página de resultados ofrece lo mismo por los dos caminos', () => {
    const out = resultados(5, true);
    const conB = present(ok(out), conBotones);
    const sinB = present(ok(out), sinBotones);

    expect(actionsOf(conB)).toEqual(actionsOf(sinB));
    // Two actions per result: the data and the file.
    expect(actionsOf(conB)).toEqual([
      'view:1', 'open:1', 'view:2', 'open:2', 'view:3', 'open:3',
      'view:4', 'open:4', 'view:5', 'open:5', 'more',
    ]);
  });

  it('sin botones, el cuerpo dice qué escribir', () => {
    // Offering an action the person cannot see is worth nothing.
    const sinB = present(ok(resultados(2, true)), sinBotones);
    const body = bodyOf(sinB);
    expect(body).toContain('view:1');
    expect(body).toContain('more');
  });

  it('con botones, el cuerpo no se ensucia con la lista de comandos', () => {
    const conB = present(ok(resultados(2, true)), conBotones);
    expect(bodyOf(conB)).not.toContain('view:1');
  });

  it('sin resultados no se ofrece "más"', () => {
    const vacio: Outcome = { ...resultados(0, false), offerSave: 'garantia refrigerador' };
    for (const caps of [conBotones, sinBotones]) {
      expect(actionsOf(present(ok(vacio), caps))).toEqual(['save']);
    }
  });

  it('una confirmación ofrece sí y no por los dos caminos', () => {
    const necesitaConfirmar = {
      ok: false as const,
      kind: 'requires_confirmation' as const,
      message: 'Purgar borra esto para siempre.',
      affects: [{ kind: 'memory', id: 'abc', label: 'Póliza 2026' }],
    };
    const conB = present(necesitaConfirmar, conBotones);
    const sinB = present(necesitaConfirmar, sinBotones);

    expect(actionsOf(conB)).toEqual(['yes', 'no']);
    expect(actionsOf(sinB)).toEqual(['yes', 'no']);
    // And in both cases what is affected is named, not a blind yes.
    expect(bodyOf(conB)).toContain('Póliza 2026');
    expect(bodyOf(sinB)).toContain('Póliza 2026');
  });
});

describe('lo que dice el acuse', () => {
  it('un archivo avisa que se está leyendo; un texto no', () => {
    const base = { id: 'x', shortId: 'ab12cd34', deduped: false, mediaType: null, sizeBytes: null };
    const conArchivo = present(
      ok({ kind: 'saved', capture: { ...base, sha256: 'abc' }, queued: true }),
      conBotones,
    );
    const soloTexto = present(
      ok({ kind: 'saved', capture: { ...base, sha256: null }, queued: false }),
      conBotones,
    );
    expect(bodyOf(conArchivo)).toContain('Lo estoy leyendo');
    expect(bodyOf(soloTexto)).not.toContain('Lo estoy leyendo');
    expect(bodyOf(soloTexto)).toContain('ab12cd34');
  });
});

describe('honestidad del "no lo tengo"', () => {
  it('dice cuánto falta por leer cuando hay cosas en cola', () => {
    const conPendientes: Outcome = { ...resultados(0, false), pendientes: 2 };
    expect(bodyOf(present(ok(conPendientes), conBotones))).toMatch(/2 cosas.*por leer/);
  });

  it('no agrega ruido cuando no falta nada', () => {
    expect(bodyOf(present(ok(resultados(0, false)), conBotones))).toBe('No lo tengo.');
  });

  it('distingue el final de una lista de no tener el dato', () => {
    const exhausted: Outcome = { ...resultados(0, false), offset: 5, exhausted: true };
    expect(bodyOf(present(ok(exhausted), conBotones))).toBe('No hay más.');
  });
});

describe('cuando la respuesta se descartó a propósito', () => {
  const fuente = {
    memoryId: '00000000-0000-0000-0000-000000000001',
    shortId: 'a853a71c',
    title: 'Póliza auto',
    occurredAt: null,
    capturedAt: new Date('2026-09-03T12:00:00Z'),
    domainLabel: 'Seguros',
    mediaType: 'application/pdf',
    content: 'UF 3,0 por siniestro',
    seq: 0,
    via: 'text' as const,
    score: 1,
  };

  const rechazo = (reason: 'no_citation' | 'ungrounded'): Outcome => ({
    kind: 'answer',
    query: '¿cuál es mi deducible?',
    answer: { text: null, sources: [fuente], reason },
  });

  it('dice que no dio la cifra, en vez de listar y callarse', () => {
    // Listing documents and saying nothing lets you believe there was no answer.
    // The truth is otherwise: there was one and it was discarded for lack of backing.
    const r = textReply(present(ok(rechazo('ungrounded')), CAPS));
    expect(r.body).toMatch(/sin inventarla/i);
    expect(r.body).toContain('a853a71c');
  });

  it('y lo mismo cuando el problema fue la falta de cita', () => {
    const r = textReply(present(ok(rechazo('no_citation')), CAPS));
    expect(r.body).toMatch(/sin inventar/i);
  });

  it('nunca muestra la palabra null donde iba la respuesta', () => {
    for (const reason of ['no_citation', 'ungrounded'] as const) {
      const r = textReply(present(ok(rechazo(reason)), CAPS));
      expect(r.body).not.toMatch(/\bnull\b/);
    }
  });
});

describe('los dos botones de cada resultado', () => {
  it('los datos y el archivo van en la misma fila', () => {
    // Grouping is what avoids eleven stacked rows on a page of five.
    const [r] = present(ok(resultados(2, false)), conBotones);
    const opts = r?.kind === 'text' ? r.options ?? [] : [];
    expect(opts.filter((o) => o.group === 1).map((o) => o.action)).toEqual(['view:1', 'open:1']);
    expect(opts.filter((o) => o.group === 2).map((o) => o.action)).toEqual(['view:2', 'open:2']);
  });

  it('una nota suelta no ofrece "archivo": no tiene', () => {
    // A button that knows in advance it will fail is worse than no button.
    const soloTexto: Outcome = {
      ...resultados(1, false),
      items: [{ ...item(1), mediaType: null, sizeBytes: null }],
    };
    expect(actionsOf(present(ok(soloTexto), conBotones))).toEqual(['view:1']);
  });

  it('el original del detalle es el que estás mirando, no el primero de la lista', () => {
    // It encoded position 1, resolved against the list: opening the third and asking
    // for its original sent you the first one's file.
    const detalle: Outcome = {
      kind: 'detail',
      memory: {
        ...item(3), ownerId: 'o', status: 'classified', sha256: 'abc', note: null,
        normalizedText: 'x'.repeat(5000), lane: 'document', normalizedAt: new Date(),
        normalizationError: null, domainLabel: 'Seguros',
      },
    };
    expect(actionsOf(present(ok(detalle), conBotones))).toEqual(['original']);
  });

  it('el detalle muestra los datos, no el documento entero', () => {
    const detalle: Outcome = {
      kind: 'detail',
      memory: {
        ...item(3), ownerId: 'o', status: 'classified', sha256: 'abc', note: 'mi nota',
        normalizedText: 'z'.repeat(5000), lane: 'document', normalizedAt: new Date(),
        normalizationError: null, domainLabel: 'Seguros', excerpt: 'z'.repeat(120),
      },
    };
    const body = bodyOf(present(ok(detalle), conBotones));
    expect(body).toContain('Seguros');
    expect(body).toContain('mi nota');
    expect(body.length).toBeLessThan(600);
  });
});

describe('la nota se muestra una vez', () => {
  const conNota = (over: Partial<MemorySummary> & Record<string, unknown> = {}): Outcome => ({
    kind: 'detail',
    memory: {
      ...item(1), ownerId: 'o', status: 'classified', sha256: 'abc',
      note: 'póliza N°BP9344586, vigencia 29/07/2026',
      normalizedText: 'Póliza de Seguro de Vehículo · deducible UF 3,0',
      lane: 'document', normalizedAt: new Date(), normalizationError: null,
      domainLabel: 'Seguros',
      excerpt: 'póliza N°BP9344586, vigencia 29/07/2026',
      ...over,
    },
  });

  it('no la repite como asomo del documento', () => {
    // `excerpt` es `note ?? normalized_text`: con nota, el asomo ERA la nota.
    const body = bodyOf(present(ok(conNota()), conBotones));
    expect(body.split('BP9344586')).toHaveLength(2);
    // And what was extracted is visible, which is a different thing.
    expect(body).toContain('deducible UF 3,0');
  });

  it('una nota suelta sin título tampoco se lee dos veces', () => {
    // With no title the header falls back to the excerpt, which is also the note.
    const body = bodyOf(present(ok(conNota({
      title: null, originalFilename: null, mediaType: null, sha256: null, normalizedText: null,
    })), conBotones));
    expect(body.split('BP9344586')).toHaveLength(2);
  });
});

/**
 * Actions are a pattern, not a per-screen decision.
 *
 * Asking offered only `view` while searching offered `view` and `open`, because
 * each listing built its own buttons. It is not a different decision per screen:
 * it is the same one, and it belongs in one place.
 */
describe('todo listado ofrece las mismas acciones', () => {
  const conArchivo = { ...item(1), mediaType: 'application/pdf' };
  const conArchivo2 = { ...item(2), mediaType: 'application/pdf' };

  const listados: [string, Outcome][] = [
    ['results', { ...resultados(2, false), items: [conArchivo, conArchivo2] }],
    ['inDomain', {
      kind: 'inDomain',
      domain: { id: 'd', slug: 'salud', label: 'Salud', description: '', aliases: [], active: true },
      items: [conArchivo, conArchivo2],
    }],
    ['review', {
      kind: 'review',
      items: [conArchivo, conArchivo2].map((m) => ({
        ...m, lane: 'vision' as const, error: 'no se pudo leer', retryable: true, chars: 0,
      })),
    }],
    ['answer', {
      kind: 'answer',
      query: 'deducible',
      answer: {
        text: 'El deducible es de 3 UF [id1].',
        reason: null,
        sources: [conArchivo, conArchivo2].map((m, i) => ({
          memoryId: m.id, shortId: m.shortId, title: m.title,
          occurredAt: null, capturedAt: m.capturedAt, domainLabel: null,
          mediaType: m.mediaType, content: 'x', seq: i, via: 'text' as const, score: 1,
        })),
      },
    }],
  ];

  for (const [nombre, out] of listados) {
    it(`${nombre} ofrece datos y archivo por cada elemento`, () => {
      const acciones = actionsOf(present(ok(out), conBotones));
      expect(acciones, nombre).toEqual(
        expect.arrayContaining(['view:1', 'open:1', 'view:2', 'open:2']),
      );
    });

    it(`${nombre} numera el cuerpo igual que las acciones`, () => {
      // If the body said "1." and the action belonged to the second, you would open
      const body = bodyOf(present(ok(out), conBotones));
      expect(body, nombre).toMatch(/^1\. /m);
      expect(body, nombre).toMatch(/^2\. /m);
    });
  }
});

/**
 * Expired or superseded is said BEFORE the datum.
 *
 * Reading "UF 3" and only then "expired in 2024" is the failure mode this
 * prevents: the risk is not forgetting a datum, it is reading the old one
 * without noticing. Checked in both channels because prose lives in two files.
 */
describe('lo vencido se dice antes del dato', () => {
  const hit = (over: Record<string, unknown> = {}) => ({
    ref: {
      type: {
        id: 't', slug: 'poliza_auto', label: 'Póliza de auto', description: '',
        kind: 'state' as const, domainSlug: 'seguros', fields: [],
        identityField: 'patente', validFromField: null, validUntilField: null, active: true,
      },
      field: { name: 'deducible', kind: 'uf' as const, label: 'deducible', aliases: ['deducible'] },
    },
    fact: {
      id: 'f', memoryId: 'm', typeId: 't', typeSlug: 'poliza_auto', typeLabel: 'Póliza de auto',
      kind: 'state' as const, payload: { deducible: 3 }, identity: 'VHWD58',
      validFrom: new Date('2020-01-01'), validUntil: new Date('2021-01-01'),
      supersededBy: null, confidence: 1, shortId: 'a853a71c', memoryTitle: null,
    },
    value: 3,
    expired: true,
    superseded: false,
    ...over,
  });

  const respuesta = (hits: unknown[]): Outcome => ({
    kind: 'answer',
    query: 'deducible',
    answer: { text: null, sources: [], reason: null, facts: hits as never },
  });

  it('la advertencia precede al valor', () => {
    const body = bodyOf(present(ok(respuesta([hit()])), conBotones));
    expect(body.indexOf('vencido')).toBeGreaterThanOrEqual(0);
    expect(body.indexOf('vencido')).toBeLessThan(body.indexOf('UF 3'));
  });

  it('lo superado también se avisa', () => {
    const body = bodyOf(present(ok(respuesta([hit({ expired: false, superseded: true })])), conBotones));
    expect(body).toMatch(/superado/i);
  });

  it('dos vigentes se muestran los dos, sin elegir', () => {
    // Regla dura 3.
    const vivos = [hit({ expired: false }), hit({ expired: false })];
    const body = bodyOf(present(ok(respuesta(vivos)), conBotones));
    expect(body).toMatch(/No elijo por ti/);
  });

  it('un dato vigente no lleva advertencia', () => {
    const body = bodyOf(present(ok(respuesta([hit({ expired: false })])), conBotones));
    expect(body).not.toMatch(/vencido|superado/i);
    expect(body).toContain('UF 3');
  });
});

describe('un conflicto es el mismo dato dos veces, no dos cosas distintas', () => {
  const base = {
    ref: {
      type: {
        id: 't', slug: 'tarjeta_credito', label: 'Tarjeta', description: '',
        kind: 'period' as const, domainSlug: 'finanzas', fields: [],
        identityField: 'tarjeta', validFromField: null, validUntilField: null, active: true,
      },
      field: { name: 'monto_a_pagar', kind: 'money' as const, label: 'monto', aliases: [] },
    },
    expired: false,
    superseded: false,
  };
  const conIdentidad = (identity: string, value: number) => ({
    ...base,
    value,
    fact: {
      id: `f${identity}`, memoryId: `m${identity}`, typeId: 't', typeSlug: 'tarjeta_credito',
      typeLabel: 'Tarjeta', kind: 'period' as const, payload: {}, identity,
      validFrom: null, validUntil: null, supersededBy: null, confidence: 1,
      shortId: identity, memoryTitle: null,
    },
  });

  const body = (hits: unknown[]) => bodyOf(present(ok({
    kind: 'answer', query: 'x',
    answer: { text: null, sources: [], reason: null, facts: hits as never },
  } as Outcome), conBotones));

  it('dos tarjetas distintas NO son un conflicto', () => {
    // Warning about this teaches people to ignore the warning, and then it stops
    // working for the case that does matter.
    expect(body([conIdentidad('4005', 886568), conIdentidad('2527', 84665)]))
      .not.toMatch(/No elijo/);
  });

  it('el mismo dato de la misma instancia, dos veces, SÍ lo es', () => {
    expect(body([conIdentidad('4005', 886568), conIdentidad('4005', 999999)]))
      .toMatch(/No elijo/);
  });
});
