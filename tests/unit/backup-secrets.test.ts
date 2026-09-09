import { describe, expect, it } from 'vitest';
import { envNamesFor, passphraseFor, transportSecretFor } from '../../src/adapters/backup/fs';

const A = '660e8532-f6ea-40e0-a056-8b1a7495359f';
const B = '11111111-2222-3333-4444-555555555555';

describe('los secretos se resuelven por dueño y solo del entorno', () => {
  it('prefiere el del dueño sobre el compartido', () => {
    expect(passphraseFor(A, {
      DM_BACKUP_PASSPHRASE: 'compartida',
      DM_BACKUP_PASSPHRASE_660E8532: 'la del dueño',
    })).toBe('la del dueño');
  });

  it('cae al compartido, que es lo correcto con un solo dueño', () => {
    // §14.3 los pide por dueño; pedirle a un sistema de una persona que escriba
    // un id para configurarse sería ceremonia.
    expect(passphraseFor(A, { DM_BACKUP_PASSPHRASE: 'compartida' })).toBe('compartida');
  });

  it('no confunde el id de un dueño con el de otro', () => {
    expect(passphraseFor(B, { DM_BACKUP_PASSPHRASE_660E8532: 'la del otro' })).toBeNull();
  });

  it('dos dueños con destinos distintos no se pisan', () => {
    const env = {
      DM_BACKUP_WEBDAV_PASS_660E8532: 'nextcloud de A',
      DM_BACKUP_WEBDAV_PASS_11111111: 'nextcloud de B',
    };
    expect(transportSecretFor('webdav', A, env)).toBe('nextcloud de A');
    expect(transportSecretFor('webdav', B, env)).toBe('nextcloud de B');
  });

  it('descifrar el archivo y abrir el destino son variables distintas', () => {
    // No es el mismo permiso: quien tiene la segunda ve un repositorio cifrado
    // y nada más.
    const env = { DM_BACKUP_PASSPHRASE: 'la que descifra', DM_BACKUP_WEBDAV_PASS: 'la que abre' };
    expect(passphraseFor(A, env)).toBe('la que descifra');
    expect(transportSecretFor('webdav', A, env)).toBe('la que abre');
  });

  it('un transporte que restic alcanza solo no pide credencial nuestra', () => {
    // B2, S3 y R2 usan las variables estándar de restic y pasan sin tocarse.
    expect(transportSecretFor('none', A, { DM_BACKUP_WEBDAV_PASS: 'x' })).toBeNull();
  });

  it('dice el nombre de la variable, porque "falta un secreto" no es accionable', () => {
    expect(envNamesFor('webdav', A)).toEqual([
      'DM_BACKUP_WEBDAV_PASS_660E8532',
      'DM_BACKUP_WEBDAV_PASS',
    ]);
  });
});

describe('vacío cuenta como ausente', () => {
  // El bug real: `??` cae con null y undefined pero NO con '', y una variable
  // declarada sin valor es el estado normal de un .env.local a medio llenar.
  // Sin esto, status informaba la passphrase como presente y restic la habría
  // aceptado: un respaldo cifrado con nada, reportado como configurado.
  it('una variable declarada sin valor es null', () => {
    expect(passphraseFor(A, { DM_BACKUP_PASSPHRASE: '' })).toBeNull();
  });

  it('solo espacios también es null', () => {
    expect(passphraseFor(A, { DM_BACKUP_PASSPHRASE: '   ' })).toBeNull();
  });

  it('una del dueño vacía no tapa la compartida que sí tiene valor', () => {
    expect(passphraseFor(A, {
      DM_BACKUP_PASSPHRASE_660E8532: '',
      DM_BACKUP_PASSPHRASE: 'la buena',
    })).toBe('la buena');
  });

  it('sin nada es null, no una cadena vacía', () => {
    expect(passphraseFor(A, {})).toBeNull();
  });
});
