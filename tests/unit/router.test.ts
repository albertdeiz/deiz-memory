import { describe, expect, it } from 'vitest';
import { encodeAction, parseAction } from '../../src/core/router/actions.js';
import { classify, contentWords, looksLikeQuestion } from '../../src/core/router/intent.js';
import type { Attachment, Incoming } from '../../src/core/channel/types.js';

const attachment = (over: Partial<Attachment> = {}): Attachment => ({
  filename: 'boleta.jpg',
  declaredMediaType: 'image/jpeg',
  sizeBytes: 1234,
  fetch: async () => Buffer.from('x'),
  ...over,
});

const msg = (over: Partial<Incoming> = {}): Incoming => ({
  conversation: { channel: 'fake', chatId: '1' },
  externalUserId: '4471',
  displayName: null,
  receivedAt: new Date('2026-03-14T12:00:00Z'),
  text: null,
  attachment: null,
  action: null,
  ...over,
});

const conLista = { ids: ['a', 'b', 'c'], hasConfirm: false };

describe('acciones · el botón y el teclado son lo mismo', () => {
  it('el callback y la palabra escrita producen la misma acción', () => {
    // Esta es la pieza que sostiene toda la degradación de §7.1. Si estas dos
    // dejaran de coincidir, un canal sin botones quedaría mudo.
    expect(parseAction(encodeAction({ kind: 'mas' }), true)).toEqual({ kind: 'mas' });
    expect(parseAction('más', true)).toEqual({ kind: 'mas' });
    expect(parseAction('MAS', true)).toEqual({ kind: 'mas' });
  });

  it('acepta ver:3 del botón y 3 pelado del teclado', () => {
    expect(parseAction(encodeAction({ kind: 'ver', n: 3 }), true)).toEqual({ kind: 'ver', n: 3 });
    expect(parseAction('3', true)).toEqual({ kind: 'ver', n: 3 });
  });

  it('un número pelado no es una acción si no hay lista en pantalla', () => {
    // Sin esto, alguien capturando "3" perdería el dato — y §5 dice que perder
    // es lo caro.
    expect(parseAction('3', false)).toBeNull();
  });

  it('no confunde texto cualquiera con una acción', () => {
    expect(parseAction('la póliza del auto', true)).toBeNull();
    expect(parseAction('', true)).toBeNull();
    expect(parseAction(null, true)).toBeNull();
  });
});

describe('clasificar · el orden es la regla', () => {
  it('un botón presionado se obedece, no se interpreta', () => {
    const i = classify(msg({ action: 'mas', text: 'esto se ignora' }), conLista);
    expect(i).toEqual({ verb: 'accion', action: { kind: 'mas' } });
  });

  it('un comando gana sobre cualquier heurística', () => {
    // `adivinado: false` porque lo pediste tú: si no encuentra nada, no tiene
    // sentido ofrecerte guardar "deducible" como nota.
    expect(classify(msg({ text: '/buscar deducible' }), null))
      .toEqual({ verb: 'recordar', query: 'deducible', adivinado: false });
    expect(classify(msg({ text: '/pendientes' }), null)).toEqual({ verb: 'pendientes' });
    expect(classify(msg({ text: '/start 8MGVBPG9' }), null))
      .toEqual({ verb: 'parear', code: '8MGVBPG9' });
  });

  it('un archivo se guarda, y el texto que lo acompaña va de nota', () => {
    const a = attachment();
    const i = classify(msg({ attachment: a, text: 'la boleta del taller' }), null);
    expect(i).toEqual({ verb: 'capturar', text: 'la boleta del taller', attachment: a });
  });

  it('"más" con un archivo adjunto es una captura, no una acción', () => {
    // El adjunto manda: si mandaste algo, quieres guardarlo.
    const a = attachment();
    const i = classify(msg({ attachment: a, text: 'más' }), conLista);
    expect(i.verb).toBe('capturar');
  });

  it('texto libre se guarda — la ambigüedad cae hacia capturar (§5)', () => {
    for (const t of ['el mecánico es Juan +569 1234 5678', 'comprar pan', 'Zañartu 1111']) {
      expect(classify(msg({ text: t }), null).verb).toBe('capturar');
    }
  });
});

describe('la desviación de §5, acotada a preguntas', () => {
  it('reconoce una pregunta y la manda a buscar', () => {
    expect(looksLikeQuestion('¿cuál es mi deducible?')).toBe(true);
    expect(looksLikeQuestion('cuando vence la revision tecnica')).toBe(true);
    expect(looksLikeQuestion('busca la póliza del auto')).toBe(true);
  });

  it('no toma por pregunta algo que solo quieres guardar', () => {
    expect(looksLikeQuestion('el mecánico es Juan')).toBe(false);
    expect(looksLikeQuestion('Zañartu 1111 Ñuñoa')).toBe(false);
    // Empieza con palabra de pregunta pero no queda contenido: no es búsqueda.
    expect(looksLikeQuestion('que')).toBe(false);
  });

  it('deja solo las palabras que sirven para buscar', () => {
    expect(contentWords('¿cuál es mi deducible?')).toBe('deducible');
    expect(contentWords('cuando vence la revision tecnica')).toBe('vence revision tecnica');
  });

  it('una pregunta va a recordar, con la consulta ya limpia', () => {
    // `adivinado: true`: la heurística decidió que era pregunta, así que si no
    // hay resultados hay que ofrecer guardarlo (§5, no perder nada).
    expect(classify(msg({ text: '¿cuál es mi deducible?' }), null))
      .toEqual({ verb: 'recordar', query: 'deducible', adivinado: true });
  });
});
