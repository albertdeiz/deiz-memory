import { describe, expect, it } from 'vitest';
import {
  canonical, clamp, isPoor, lanesFor, MAX_NORMALIZED_CHARS, POOR_TEXT_CHARS,
} from '../../src/core/normalize/lanes.js';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

describe('lanesFor', () => {
  it('lee el texto plano sin herramientas', () => {
    expect(lanesFor('text/plain')).toEqual(['text']);
    expect(lanesFor('text/markdown')).toEqual(['text']);
  });

  it('manda el PDF a markitdown y deja la visión debajo', () => {
    // El caso que justifica toda la máquina: con capa de texto sale por A,
    // escaneado sale por B, y nadie tiene que decidirlo a mano.
    expect(lanesFor('application/pdf')).toEqual(['document', 'vision']);
  });

  it('manda las imágenes directo a visión, sin pasar por markitdown', () => {
    // markitdown sobre una foto da una descripción, no una transcripción.
    // Intentarlo primero sería gastar un proceso para no obtener nada.
    expect(lanesFor('image/jpeg')).toEqual(['vision']);
    expect(lanesFor('image/png')).toEqual(['vision']);
    expect(lanesFor('image/heic')).toEqual(['vision']);
  });

  it('manda el audio a whisper', () => {
    expect(lanesFor('audio/ogg')).toEqual(['audio']);
    expect(lanesFor('audio/mpeg')).toEqual(['audio']);
  });

  it('deja el texto crudo como red para html y csv', () => {
    // markitdown los lee mejor, pero si no está, siguen siendo texto: leerlos
    // crudo es peor que la conversión y muchísimo mejor que nada.
    expect(lanesFor('text/html')).toEqual(['document', 'text']);
    expect(lanesFor('text/csv')).toEqual(['document', 'text']);
  });

  it('los formatos de Office van solo por markitdown', () => {
    expect(lanesFor(DOCX)).toEqual(['document']);
  });

  it('no inventa un carril donde no lo hay', () => {
    // Un array vacío es una respuesta honesta: el blob se guarda igual y
    // nadie promete un texto que no va a existir.
    expect(lanesFor('video/mp4')).toEqual([]);
    expect(lanesFor('application/octet-stream')).toEqual([]);
    expect(lanesFor(null)).toEqual([]);
  });
});

describe('isPoor', () => {
  it('trata como pobre lo que devuelve un PDF sin capa de texto', () => {
    expect(isPoor('')).toBe(true);
    expect(isPoor(null)).toBe(true);
    expect(isPoor('   \n  ')).toBe(true);
    expect(isPoor('x'.repeat(POOR_TEXT_CHARS - 1))).toBe(true);
  });

  it('acepta un texto de verdad', () => {
    expect(isPoor('x'.repeat(POOR_TEXT_CHARS))).toBe(false);
  });
});

describe('clamp', () => {
  it('deja pasar lo que cabe', () => {
    const { text, truncated } = clamp('hola');
    expect(text).toBe('hola');
    expect(truncated).toBe(false);
  });

  it('recorta y lo dice en el propio texto', () => {
    // to_tsvector revienta pasado ~1MB: recortar acá es lo que evita que un
    // escaneo de 600 páginas tumbe el insert.
    const { text, truncated } = clamp('x'.repeat(MAX_NORMALIZED_CHARS + 10));
    expect(truncated).toBe(true);
    expect(text).toContain('recortado');
    expect(text.length).toBeLessThan(MAX_NORMALIZED_CHARS + 200);
  });
});

describe('canonical', () => {
  it('normaliza los caracteres de ancho completo que devuelve el OCR', () => {
    // Caso real, de un plano de edificio escaneado: el OCR devolvió U+FF29 en
    // vez de "I", el unaccent de Postgres no los toca, y el documento dejaba de
    // aparecer al buscar "inmobiliaria".
    expect(canonical('INMOBＩLＩＡRＩＡ')).toBe('INMOBILIARIA');
  });

  it('arregla las ligaduras, que fallan por el mismo motivo', () => {
    expect(canonical('oﬁcina')).toBe('oficina');
  });

  it('no toca el texto que ya está bien, tildes incluidas', () => {
    expect(canonical('Póliza de vehículo Ñuñoa')).toBe('Póliza de vehículo Ñuñoa');
  });
});
