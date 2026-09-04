import { describe, expect, it } from 'vitest';
import { encodeAction, parseAction } from '../../src/core/router/actions';
import { classify, contentWords } from '../../src/core/router/intent';
import type { Attachment, Incoming } from '../../src/core/channel/types';

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

const conLista = { ids: ['a', 'b', 'c'], hasConfirm: false, hasSave: false };

describe('acciones · el botón y el teclado son lo mismo', () => {
  it('el callback y la palabra escrita producen la misma acción', () => {
    // This is the piece the whole degradation rests on. If these two stopped
    // matching, a channel without buttons would go mute.
    expect(parseAction(encodeAction({ kind: 'more' }), true)).toEqual({ kind: 'more' });
    expect(parseAction('more', true)).toEqual({ kind: 'more' });
    expect(parseAction('MORE', true)).toEqual({ kind: 'more' });
  });

  it('acepta ver:3 del botón y 3 pelado del teclado', () => {
    expect(parseAction(encodeAction({ kind: 'view', n: 3 }), true)).toEqual({ kind: 'view', n: 3 });
    expect(parseAction('3', true)).toEqual({ kind: 'view', n: 3 });
  });

  it('un número pelado no es una acción si no hay lista en pantalla', () => {
    // Without this, someone capturing "3" would lose the datum — and losing is
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
    const i = classify(msg({ action: 'more', text: 'esto se ignora' }), conLista);
    expect(i).toEqual({ verb: 'action', action: { kind: 'more' } });
  });

  it('un comando gana sobre cualquier heurística', () => {
    // Not guessed, because you asked for it: if it finds nothing there is no
    // sentido ofrecerte guardar "deducible" como nota.
    expect(classify(msg({ text: '/search deducible' }), null))
      .toEqual({ verb: 'recall', query: 'deducible', guessed: false });
    expect(classify(msg({ text: '/pending' }), null)).toEqual({ verb: 'pending' });
    expect(classify(msg({ text: '/start 8MGVBPG9' }), null))
      .toEqual({ verb: 'pair', code: '8MGVBPG9' });
  });

  it('un archivo se guarda, y el texto que lo acompaña va de nota', () => {
    const a = attachment();
    const i = classify(msg({ attachment: a, text: 'la boleta del taller' }), null);
    expect(i).toEqual({ verb: 'capture', text: 'la boleta del taller', attachment: a });
  });

  it('"más" con un archivo adjunto es una captura, no una acción', () => {
    // El adjunto manda: si mandaste algo, quieres guardarlo.
    const a = attachment();
    const i = classify(msg({ attachment: a, text: 'more' }), conLista);
    expect(i.verb).toBe('capture');
  });

  it('texto libre se CONSULTA: en un chat, lo que escribes es una pregunta', () => {
    // Inverts the default toward capture, on purpose. Guessing with a heuristic
    // acertaba a medias y dejaba preguntas guardadas como memorias.
    for (const t of ['el mecánico es Juan +569 1234 5678', 'comprar pan', 'poliza del auto']) {
      expect(classify(msg({ text: t }), null).verb).toBe('recall');
    }
  });

  it('guardar un texto es explícito, con /capture', () => {
    expect(classify(msg({ text: '/capture el mecánico es Juan' }), null))
      .toEqual({ verb: 'capture', text: 'el mecánico es Juan', attachment: null });
  });

  it('un texto sin palabras con contenido igual query, no se pierde', () => {
    // A greeting leaves no content once stopwords are removed; falling into a dry
    // error would be worse than searching and offering to store it.
    const i = classify(msg({ text: 'hola' }), null);
    expect(i).toEqual({ verb: 'recall', query: 'hola', guessed: true });
  });
});

describe('los comandos son los del CLI, en inglés', () => {
  it('cada comando tiene el nombre de su equivalente en la terminal', () => {
    const casos: [string, string][] = [
      ['/help', 'help'],
      ['/search x', 'recall'],
      ['/ask x', 'recall'],
      ['/capture x', 'capture'],
      ['/pending', 'pending'],
      ['/review', 'review'],
      ['/domains', 'domains'],
      ['/propose', 'propose'],
      ['/create Salud: cosas', 'createDomain'],
      ['/describe salud: cosas', 'describeDomain'],
      ['/rename salud Salud2', 'renameDomain'],
      ['/archive salud', 'archiveDomain'],
      ['/merge a b', 'mergeDomains'],
    ];
    for (const [texto, verbo] of casos) {
      expect(classify(msg({ text: texto }), null).verb, texto).toBe(verbo);
    }
  });

  it('/ask responde y /search lista: la diferencia es guessed', () => {
    // The distinction: the datum with its citation, or the documents.
    expect(classify(msg({ text: '/ask deducible' }), null))
      .toEqual({ verb: 'recall', query: 'deducible', guessed: true });
    expect(classify(msg({ text: '/search deducible' }), null))
      .toEqual({ verb: 'recall', query: 'deducible', guessed: false });
  });

  it('los nombres en español ya no valen: un solo nombre por operación', () => {
    // It falls into the category path, which answers that it does not know it.
    // dos vocabularios es mantener dos, para siempre.
    expect(classify(msg({ text: '/buscar x' }), null).verb).toBe('inDomain');
    expect(classify(msg({ text: '/dominios' }), null).verb).toBe('inDomain');
    expect(parseAction('ver:2', true)).toBeNull();
    expect(parseAction('más', true)).toBeNull();
  });

  it('las acciones se emiten y se aceptan solo en inglés', () => {
    expect(encodeAction({ kind: 'view', n: 3 })).toBe('view:3');
    expect(encodeAction({ kind: 'open', n: 2 })).toBe('open:2');
    expect(encodeAction({ kind: 'hide', n: 1 })).toBe('hide:1');
    expect(encodeAction({ kind: 'more' })).toBe('more');
    expect(encodeAction({ kind: 'yes' })).toBe('yes');

    for (const [escrito, esperado] of [
      ['view:3', { kind: 'view', n: 3 }],
      ['open:2', { kind: 'open', n: 2 }],
      ['hide:1', { kind: 'hide', n: 1 }],
      ['more', { kind: 'more' }],
      ['MORE', { kind: 'more' }],
      ['yes', { kind: 'yes' }],
    ] as const) {
      expect(parseAction(escrito, true), escrito).toEqual(esperado);
    }
  });

  it('deja solo las palabras que sirven para buscar', () => {
    expect(contentWords('¿cuál es mi deducible?')).toBe('deducible');
    expect(contentWords('cuando vence la revision tecnica')).toBe('vence revision tecnica');
  });

  it('una pregunta llega a recordar con la query ya limpia', () => {
    expect(classify(msg({ text: '¿cuál es mi deducible?' }), null))
      .toEqual({ verb: 'recall', query: 'deducible', guessed: true });
  });
});
