import { describe, expect, it } from 'vitest';
import { meaningfulName } from '../../src/core/filenames.js';

describe('meaningfulName', () => {
  it('descarta lo que pone la cámara', () => {
    for (const n of [
      'IMG_20260114_093312.jpg', 'IMG-20260114-WA0001.jpg', 'DSC_0042.JPG',
      'PXL_20260114_093312123.jpg', 'DSCN1234.jpg', 'GOPR0135.MP4',
    ]) expect(meaningfulName(n)).toBeNull();
  });

  it('descarta lo que pone WhatsApp', () => {
    for (const n of [
      'WhatsApp Image 2026-01-14 at 09.33.12.jpeg',
      'WhatsApp Audio 2026-01-14 at 09.33.12.ogg',
      'WhatsApp Document 2026-01-14.pdf',
    ]) expect(meaningfulName(n)).toBeNull();
  });

  it('descarta lo que ponen el escáner, el navegador y el sistema', () => {
    for (const n of [
      'scan0001.pdf', 'Scanned_20260114.pdf', 'Screenshot 2026-01-14 093312.png',
      'Captura de pantalla 2026-01-14.png', 'download.pdf', 'download (3).pdf',
      'documento.pdf', 'documento (2).pdf', 'Untitled.pdf', 'sin titulo.docx',
      'image.png', 'archivo (1).pdf',
    ]) expect(meaningfulName(n)).toBeNull();
  });

  it('descarta timestamps, epochs y hashes', () => {
    for (const n of [
      '1706123456789.pdf', '20260114093312.jpg', '2026-01-14.pdf',
      'a3f19b8c4d2e7f01.bin', '____.pdf',
    ]) expect(meaningfulName(n)).toBeNull();
  });

  it('conserva los nombres que sí dicen algo, normalizados', () => {
    expect(meaningfulName('poliza-auto-2026.pdf')).toBe('poliza auto 2026');
    expect(meaningfulName('Receta_Dr_Perez.pdf')).toBe('Receta Dr Perez');
    expect(meaningfulName('examen sangre marzo.pdf')).toBe('examen sangre marzo');
    expect(meaningfulName('contrato arriendo.docx')).toBe('contrato arriendo');
  });

  it('limpia el prefijo de copia en vez de descartar el nombre entero', () => {
    expect(meaningfulName('Copia de poliza-auto.pdf')).toBe('poliza auto');
    expect(meaningfulName('Copy of contrato.pdf')).toBe('contrato');
  });

  it('tolera la ausencia de nombre', () => {
    expect(meaningfulName(null)).toBeNull();
    expect(meaningfulName('')).toBeNull();
    expect(meaningfulName('   ')).toBeNull();
  });
});
