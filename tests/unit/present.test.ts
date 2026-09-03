import { describe, expect, it } from 'vitest';
import { present } from '../../src/adapters/chat/present.js';
import type { Capabilities, Reply } from '../../src/core/channel/types.js';
import type { Outcome } from '../../src/core/router/route.js';
import type { MemorySummary } from '../../src/core/domain/types.js';
import { ok } from '../../src/core/result.js';

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

const resultados = (n: number, hayMas: boolean): Outcome => ({
  kind: 'resultados',
  consulta: 'poliza',
  items: Array.from({ length: n }, (_, i) => item(i + 1)),
  offset: 0,
  hayMas,
  pendientes: 0,
  ofreceGuardar: null,
  agotado: false,
});

const actionsOf = (rs: Reply[]): string[] =>
  rs.flatMap((r) => (r.kind === 'text' ? (r.options ?? []).map((o) => o.action) : []));

const bodyOf = (rs: Reply[]): string =>
  rs.map((r) => (r.kind === 'text' ? r.body : '')).join('\n');

/**
 * El test que sostiene §7.1.
 *
 * Si un canal sin botones ofreciera menos que uno con botones, "el core degrada
 * solo" sería una intención escrita en un comentario. Acá se comprueba que las
 * dos formas ofrecen exactamente lo mismo, y que la versión sin botones además
 * dice en el cuerpo qué escribir.
 */
describe('degradación · las mismas acciones con y sin botones', () => {
  it('una página de resultados ofrece lo mismo por los dos caminos', () => {
    const out = resultados(5, true);
    const conB = present(ok(out), conBotones);
    const sinB = present(ok(out), sinBotones);

    expect(actionsOf(conB)).toEqual(actionsOf(sinB));
    // Dos acciones por resultado: los datos y el archivo.
    expect(actionsOf(conB)).toEqual([
      'ver:1', 'abrir:1', 'ver:2', 'abrir:2', 'ver:3', 'abrir:3',
      'ver:4', 'abrir:4', 'ver:5', 'abrir:5', 'mas',
    ]);
  });

  it('sin botones, el cuerpo dice qué escribir', () => {
    // De nada sirve ofrecer una acción que la persona no puede ver.
    const sinB = present(ok(resultados(2, true)), sinBotones);
    const body = bodyOf(sinB);
    expect(body).toContain('ver:1');
    expect(body).toContain('mas');
  });

  it('con botones, el cuerpo no se ensucia con la lista de comandos', () => {
    const conB = present(ok(resultados(2, true)), conBotones);
    expect(bodyOf(conB)).not.toContain('ver:1');
  });

  it('sin resultados no se ofrece "más"', () => {
    const vacio: Outcome = { ...resultados(0, false), ofreceGuardar: 'garantia refrigerador' };
    for (const caps of [conBotones, sinBotones]) {
      expect(actionsOf(present(ok(vacio), caps))).toEqual(['guardar']);
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

    expect(actionsOf(conB)).toEqual(['si', 'no']);
    expect(actionsOf(sinB)).toEqual(['si', 'no']);
    // Y en los dos casos se nombra lo afectado, no se pide un sí a ciegas.
    expect(bodyOf(conB)).toContain('Póliza 2026');
    expect(bodyOf(sinB)).toContain('Póliza 2026');
  });
});

describe('lo que dice el acuse', () => {
  it('un archivo avisa que se está leyendo; un texto no', () => {
    const base = { id: 'x', shortId: 'ab12cd34', deduped: false, mediaType: null, sizeBytes: null };
    const conArchivo = present(
      ok({ kind: 'guardado', capture: { ...base, sha256: 'abc' }, enCola: true }),
      conBotones,
    );
    const soloTexto = present(
      ok({ kind: 'guardado', capture: { ...base, sha256: null }, enCola: false }),
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
    const agotado: Outcome = { ...resultados(0, false), offset: 5, agotado: true };
    expect(bodyOf(present(ok(agotado), conBotones))).toBe('No hay más.');
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
    content: 'UF 3,0 por siniestro',
    seq: 0,
    via: 'texto' as const,
    score: 1,
  };

  const rechazo = (reason: 'sin_cita' | 'sin_respaldo'): Outcome => ({
    kind: 'respuesta',
    consulta: '¿cuál es mi deducible?',
    answer: { text: null, sources: [fuente], reason },
  });

  it('dice que no dio la cifra, en vez de listar y callarse', () => {
    // Listar documentos sin decir nada deja creer que no había respuesta. La
    // verdad es otra: la había y se descartó por no tener respaldo.
    const [r] = present(ok(rechazo('sin_respaldo')), CAPS) as [Reply];
    expect(r.body).toMatch(/sin inventarla/i);
    expect(r.body).toContain('a853a71c');
  });

  it('y lo mismo cuando el problema fue la falta de cita', () => {
    const [r] = present(ok(rechazo('sin_cita')), CAPS) as [Reply];
    expect(r.body).toMatch(/sin inventar/i);
  });

  it('nunca muestra la palabra null donde iba la respuesta', () => {
    for (const reason of ['sin_cita', 'sin_respaldo'] as const) {
      const [r] = present(ok(rechazo(reason)), CAPS) as [Reply];
      expect(r.body).not.toMatch(/\bnull\b/);
    }
  });
});

describe('los dos botones de cada resultado', () => {
  it('los datos y el archivo van en la misma fila', () => {
    // `group` es lo que evita once filas apiladas en una página de cinco.
    const [r] = present(ok(resultados(2, false)), conBotones) as [Reply];
    const opts = r.kind === 'text' ? r.options ?? [] : [];
    expect(opts.filter((o) => o.group === 1).map((o) => o.action)).toEqual(['ver:1', 'abrir:1']);
    expect(opts.filter((o) => o.group === 2).map((o) => o.action)).toEqual(['ver:2', 'abrir:2']);
  });

  it('una nota suelta no ofrece "archivo": no tiene', () => {
    // Un botón que sabe de antemano que va a fallar es peor que no estar.
    const soloTexto: Outcome = {
      ...resultados(1, false),
      items: [{ ...item(1), mediaType: null, sizeBytes: null }],
    };
    expect(actionsOf(present(ok(soloTexto), conBotones))).toEqual(['ver:1']);
  });

  it('el original del detalle es el que estás mirando, no el primero de la lista', () => {
    // Codificaba `abrir:1`, que se resuelve contra la lista: abrir el tercero y
    // pedir su original te mandaba el archivo del primero.
    const detalle: Outcome = {
      kind: 'detalle',
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
      kind: 'detalle',
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
