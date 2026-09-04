import { describe, expect, it } from 'vitest';
import { detectMediaType, extensionOf, looksLikeText } from '../../src/core/media';

const withMagic = (sig: number[], tail = 64): Buffer =>
  Buffer.concat([Buffer.from(sig), Buffer.alloc(tail, 0x41)]);

describe('detectMediaType', () => {
  it('reconoce PDF por magic bytes', () => {
    expect(detectMediaType(Buffer.from('%PDF-1.7\n...'), 'x.bin')).toBe('application/pdf');
  });

  it('reconoce JPEG y PNG', () => {
    expect(detectMediaType(withMagic([0xff, 0xd8, 0xff]))).toBe('image/jpeg');
    expect(detectMediaType(withMagic([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
  });

  it('los bytes le ganan al nombre: una foto renombrada a .pdf sigue siendo foto', () => {
    expect(detectMediaType(withMagic([0xff, 0xd8, 0xff]), 'factura.pdf')).toBe('image/jpeg');
  });

  it('distingue docx de zip usando la extensión, porque por dentro son lo mismo', () => {
    const zip = withMagic([0x50, 0x4b, 0x03, 0x04]);
    expect(detectMediaType(zip, 'carta.docx')).toContain('wordprocessingml');
    expect(detectMediaType(zip, 'cosas.zip')).toBe('application/zip');
    expect(detectMediaType(zip)).toBe('application/zip');
  });

  it('cae a text/plain con texto plano, incluidos acentos', () => {
    expect(detectMediaType(Buffer.from('receta médica del niño'))).toBe('text/plain');
  });

  it('cae a octet-stream con binario desconocido', () => {
    expect(detectMediaType(Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff]))).toBe('application/octet-stream');
  });

  it('usa la extensión cuando no hay magic bytes que sirvan', () => {
    expect(detectMediaType(Buffer.from('col1,col2\n1,2'), 'datos.csv')).toBe('text/csv');
  });
});

describe('looksLikeText', () => {
  it('rechaza lo que tiene bytes nulos', () => {
    expect(looksLikeText(Buffer.from([0x68, 0x00, 0x69]))).toBe(false);
  });
  it('acepta UTF-8 con tildes y eñes', () => {
    expect(looksLikeText(Buffer.from('mecánico, señor, año'))).toBe(true);
  });
});

describe('extensionOf', () => {
  it('normaliza a minúsculas y tolera la ausencia', () => {
    expect(extensionOf('Poliza.PDF')).toBe('pdf');
    expect(extensionOf('sin-extension')).toBe('');
    expect(extensionOf(null)).toBe('');
  });
});
