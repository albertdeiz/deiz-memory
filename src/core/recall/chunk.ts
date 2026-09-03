/**
 * Partir un documento en trozos buscables.
 *
 * Por qué trozos y no el documento entero: una póliza de 80 mil caracteres
 * promediada en un solo vector no se parece a nada en particular. La pregunta
 * "¿cuál es mi deducible?" necesita acertarle al párrafo del deducible, y para
 * eso ese párrafo tiene que existir como cosa separada.
 *
 * Lógica pura, como el router de carriles: cómo se corta un documento es una
 * decisión del producto y se prueba sin base ni red.
 */

/** Ni tan corto que pierda el contexto, ni tan largo que diluya el vector. */
export const TARGET_CHARS = 900;

/**
 * Un poco de solape entre trozos consecutivos.
 *
 * Sin esto, un dato que cae justo en el corte queda partido en dos mitades y
 * ninguna de las dos se parece a la pregunta. Es barato y evita el modo de
 * falla más tonto del troceado.
 */
export const OVERLAP_CHARS = 150;

/** Debajo de esto un trozo no aporta nada y solo ensucia los resultados. */
const MIN_CHARS = 40;

export interface Chunk {
  seq: number;
  content: string;
}

/**
 * Corta por párrafos primero, y solo parte un párrafo si no cabe.
 *
 * Un documento ya viene con su propia estructura —markitdown preserva los
 * títulos y las tablas— y respetarla produce trozos que significan algo. Cortar
 * cada 900 caracteres a ciegas parte tablas por la mitad.
 */
export function chunkText(text: string): Chunk[] {
  const limpio = text.replace(/\r\n/g, '\n').trim();
  if (limpio.length === 0) return [];
  if (limpio.length <= TARGET_CHARS) return [{ seq: 0, content: limpio }];

  const parrafos = limpio.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
  const trozos: string[] = [];
  let actual = '';

  const empujar = () => {
    const t = actual.trim();
    if (t.length >= MIN_CHARS) trozos.push(t);
    else if (t.length > 0 && trozos.length > 0) trozos[trozos.length - 1] += `\n\n${t}`;
    actual = '';
  };

  for (const p of parrafos) {
    const parrafo = p.trim();

    // Un párrafo que por sí solo no cabe se parte duro, pero recién después de
    // haber intentado respetar la estructura.
    if (parrafo.length > TARGET_CHARS) {
      empujar();
      for (let i = 0; i < parrafo.length; i += TARGET_CHARS - OVERLAP_CHARS) {
        const pedazo = parrafo.slice(i, i + TARGET_CHARS).trim();
        if (pedazo.length >= MIN_CHARS) trozos.push(pedazo);
        if (i + TARGET_CHARS >= parrafo.length) break;
      }
      continue;
    }

    if (actual.length + parrafo.length + 2 > TARGET_CHARS) empujar();
    actual = actual ? `${actual}\n\n${parrafo}` : parrafo;
  }
  empujar();

  return trozos.map((content, seq) => ({ seq, content }));
}

/**
 * Lo que se manda a embeber.
 *
 * **Solo el trozo.** La tentación es anteponer el título y la nota a cada uno
 * para darle contexto, y sale mal: si los ochenta trozos de una póliza empiezan
 * con "póliza de auto BCI", los ochenta se parecen entre sí y ninguno destaca
 * al preguntar por el deducible. El contexto compartido no distingue nada — lo
 * que distingue es lo que cada trozo tiene de propio.
 *
 * El contexto igual llega, por el otro camino: el full-text sí indexa título y
 * nota a peso A, y la fusión de los dos caminos junta las dos señales.
 */
export function contextualize(chunk: string): string {
  return chunk;
}
