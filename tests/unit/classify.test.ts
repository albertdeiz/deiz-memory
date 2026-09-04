import { describe, expect, it } from 'vitest';
import { buildPrompt, validate } from '../../src/core/classify/prompt';
import type { Domain } from '../../src/core/ops/domains';

const dominios: Domain[] = [
  { id: '1', slug: 'salud', label: 'Salud', description: 'Consultas, recetas y exámenes', aliases: [], active: true },
  { id: '2', slug: 'seguros', label: 'Seguros', description: 'Pólizas, coberturas y deducibles', aliases: [], active: true },
];

describe('el prompt se arma desde la tabla', () => {
  it('incluye las descripciones, que son lo que el modelo lee para decidir', () => {
    // §9: la descripción no es documentación, es el prompt. Si esto dejara de
    // pasar, crear un dominio no cambiaría nada del comportamiento.
    const { system } = buildPrompt({
      domains: dominios, text: 'algo', note: null, filename: null, capturedAt: new Date(),
    });
    expect(system).toContain('salud: Consultas, recetas y exámenes');
    expect(system).toContain('seguros: Pólizas, coberturas y deducibles');
  });

  it('no tiene ninguna categoría escrita a mano', () => {
    // El día que alguien meta una lista fija acá, agregar un dominio va a
    // requerir un deploy y §3.7 se cae.
    const { system } = buildPrompt({
      domains: [], text: 'algo', note: null, filename: null, capturedAt: new Date(),
    });
    for (const s of ['salud', 'seguros', 'vehiculo', 'documentos']) {
      expect(system).not.toContain(`- ${s}:`);
    }
  });

  it('recorta el contenido: no hace falta mandarle 80 mil caracteres', () => {
    const { user } = buildPrompt({
      domains: dominios, text: 'x'.repeat(50_000), note: null, filename: null, capturedAt: new Date(),
    });
    expect(user.length).toBeLessThan(6000);
    expect(user).toContain('recortado');
  });

  it('la nota de la persona va primero: vale más que el texto extraído', () => {
    const { user } = buildPrompt({
      domains: dominios, text: 'ruido de OCR', note: 'la póliza del auto',
      filename: null, capturedAt: new Date(),
    });
    expect(user.indexOf('la póliza del auto')).toBeLessThan(user.indexOf('ruido de OCR'));
  });
});

describe('validar lo que devolvió el modelo', () => {
  const ok = { domain: 'salud', title: 'Receta del doctor Pérez', occurredAt: '2026-03-14', confidence: 0.9, tags: ['receta'] };

  it('acepta una respuesta correcta', () => {
    expect(validate(ok, dominios)).toEqual(ok);
  });

  it('descarta un dominio que no existe, en vez de crearlo', () => {
    // Regla dura 2: no inventar. Un dominio alucinado se cae a null.
    const r = validate({ ...ok, domain: 'astrologia' }, dominios);
    expect(r?.domain).toBeNull();
    expect(r?.title).toBe(ok.title);
  });

  it('descarta una fecha del futuro', () => {
    const futuro = new Date(Date.now() + 400 * 86_400_000).toISOString().slice(0, 10);
    expect(validate({ ...ok, occurredAt: futuro }, dominios)?.occurredAt).toBeNull();
  });

  it('descarta una fecha con formato inventado', () => {
    for (const f of ['14 de marzo', '2026', 'ayer', '2026-13-45']) {
      expect(validate({ ...ok, occurredAt: f }, dominios)?.occurredAt).toBeNull();
    }
  });

  it('sin título no hay clasificación', () => {
    // El título es el punto entero: sin él, media biblioteca no tiene cómo
    // nombrarse. Una respuesta sin título no sirve de nada.
    expect(validate({ ...ok, title: '   ' }, dominios)).toBeNull();
    expect(validate({ ...ok, title: 42 }, dominios)).toBeNull();
  });

  it('normaliza las etiquetas, descarta las inútiles y corta en cinco', () => {
    const r = validate(
      { ...ok, tags: ['Receta', 'X', 'MÉDICO', 42, 'isapre', 'bono', 'reembolso', 'extra'] },
      dominios,
    );
    // 'X' se cae por corta y el 42 por no ser texto; el resto baja a minúsculas
    // y se corta en cinco.
    expect(r?.tags).toEqual(['receta', 'médico', 'isapre', 'bono', 'reembolso']);
  });

  it('una confianza fuera de rango cae a la mitad, no revienta', () => {
    expect(validate({ ...ok, confidence: 7 }, dominios)?.confidence).toBe(0.5);
    expect(validate({ ...ok, confidence: 'mucha' }, dominios)?.confidence).toBe(0.5);
  });

  it('basura completa se rechaza', () => {
    for (const b of [null, 'texto suelto', 42, []]) {
      expect(validate(b, dominios)).toBeNull();
    }
  });
});
