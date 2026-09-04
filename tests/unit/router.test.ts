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
    // Esta es la pieza que sostiene toda la degradación de §7.1. Si estas dos
    // dejaran de coincidir, un canal sin botones quedaría mudo.
    expect(parseAction(encodeAction({ kind: 'mas' }), true)).toEqual({ kind: 'mas' });
    expect(parseAction('more', true)).toEqual({ kind: 'mas' });
    expect(parseAction('MORE', true)).toEqual({ kind: 'mas' });
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
    const i = classify(msg({ action: 'more', text: 'esto se ignora' }), conLista);
    expect(i).toEqual({ verb: 'accion', action: { kind: 'mas' } });
  });

  it('un comando gana sobre cualquier heurística', () => {
    // `adivinado: false` porque lo pediste tú: si no encuentra nada, no tiene
    // sentido ofrecerte guardar "deducible" como nota.
    expect(classify(msg({ text: '/search deducible' }), null))
      .toEqual({ verb: 'recordar', query: 'deducible', adivinado: false });
    expect(classify(msg({ text: '/pending' }), null)).toEqual({ verb: 'pendientes' });
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
    const i = classify(msg({ attachment: a, text: 'more' }), conLista);
    expect(i.verb).toBe('capturar');
  });

  it('texto libre se CONSULTA: en un chat, lo que escribes es una pregunta', () => {
    // Invierte §5 para el chat, a propósito. Adivinar con una heurística
    // acertaba a medias y dejaba preguntas guardadas como memorias.
    for (const t of ['el mecánico es Juan +569 1234 5678', 'comprar pan', 'poliza del auto']) {
      expect(classify(msg({ text: t }), null).verb).toBe('recordar');
    }
  });

  it('guardar un texto es explícito, con /capture', () => {
    expect(classify(msg({ text: '/capture el mecánico es Juan' }), null))
      .toEqual({ verb: 'capturar', text: 'el mecánico es Juan', attachment: null });
  });

  it('un texto sin palabras con contenido igual consulta, no se pierde', () => {
    // "hola" no deja contenido tras quitar las vacías; caer en un error seco
    // sería peor que buscar y ofrecer guardarlo.
    const i = classify(msg({ text: 'hola' }), null);
    expect(i).toEqual({ verb: 'recordar', query: 'hola', adivinado: true });
  });
});

describe('los comandos son los del CLI, en inglés', () => {
  it('cada comando tiene el nombre de su equivalente en la terminal', () => {
    const casos: [string, string][] = [
      ['/help', 'ayuda'],
      ['/search x', 'recordar'],
      ['/ask x', 'recordar'],
      ['/capture x', 'capturar'],
      ['/pending', 'pendientes'],
      ['/review', 'revisar'],
      ['/domains', 'dominios'],
      ['/propose', 'proponer'],
      ['/create Salud: cosas', 'crearDominio'],
      ['/describe salud: cosas', 'describirDominio'],
      ['/rename salud Salud2', 'renombrarDominio'],
      ['/archive salud', 'archivarDominio'],
      ['/merge a b', 'fusionarDominios'],
    ];
    for (const [texto, verbo] of casos) {
      expect(classify(msg({ text: texto }), null).verb, texto).toBe(verbo);
    }
  });

  it('/ask responde y /search lista: la diferencia es adivinado', () => {
    // Es la distinción de §6: el dato con su cita, o los documentos.
    expect(classify(msg({ text: '/ask deducible' }), null))
      .toEqual({ verb: 'recordar', query: 'deducible', adivinado: true });
    expect(classify(msg({ text: '/search deducible' }), null))
      .toEqual({ verb: 'recordar', query: 'deducible', adivinado: false });
  });

  it('los nombres en español ya no valen: un solo nombre por operación', () => {
    // Cae al camino de /<categoría>, que responde que no la conoce. Mantener
    // dos vocabularios es mantener dos, para siempre.
    expect(classify(msg({ text: '/buscar x' }), null).verb).toBe('enDominio');
    expect(classify(msg({ text: '/dominios' }), null).verb).toBe('enDominio');
    expect(parseAction('ver:2', true)).toBeNull();
    expect(parseAction('más', true)).toBeNull();
  });

  it('las acciones se emiten y se aceptan solo en inglés', () => {
    expect(encodeAction({ kind: 'ver', n: 3 })).toBe('view:3');
    expect(encodeAction({ kind: 'abrir', n: 2 })).toBe('open:2');
    expect(encodeAction({ kind: 'ocultar', n: 1 })).toBe('hide:1');
    expect(encodeAction({ kind: 'mas' })).toBe('more');
    expect(encodeAction({ kind: 'si' })).toBe('yes');

    for (const [escrito, esperado] of [
      ['view:3', { kind: 'ver', n: 3 }],
      ['open:2', { kind: 'abrir', n: 2 }],
      ['hide:1', { kind: 'ocultar', n: 1 }],
      ['more', { kind: 'mas' }],
      ['MORE', { kind: 'mas' }],
      ['yes', { kind: 'si' }],
    ] as const) {
      expect(parseAction(escrito, true), escrito).toEqual(esperado);
    }
  });

  it('deja solo las palabras que sirven para buscar', () => {
    expect(contentWords('¿cuál es mi deducible?')).toBe('deducible');
    expect(contentWords('cuando vence la revision tecnica')).toBe('vence revision tecnica');
  });

  it('una pregunta llega a recordar con la consulta ya limpia', () => {
    expect(classify(msg({ text: '¿cuál es mi deducible?' }), null))
      .toEqual({ verb: 'recordar', query: 'deducible', adivinado: true });
  });
});
