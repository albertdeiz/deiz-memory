# deiz-memory

Memoria personal externa. Le mandas cualquier cosa y después le preguntas.

El diseño completo está en [CLAUDE.md](./CLAUDE.md); los flujos, en
[CASOS-DE-USO.md](./CASOS-DE-USO.md). Esto es lo que hace falta para correrlo.

**Estado: F0.** Captura y búsqueda full-text por CLI. Sin LLM, sin canales de
mensajería. Todo determinista y cubierto por tests.

## Arrancar

```bash
npm install
npm run up          # postgres + garage, y escribe las credenciales en .env
npm run migrate
npm run build
node dist/adapters/cli/index.js init "tu nombre"
```

`npm run up` deja el CLI listo. Para que `dm` quede en el PATH: `npm link`.

## Comandos

```
dm doctor                        config, base de datos, migraciones, bucket, dueño

dm capture <archivo>             guarda un archivo
dm capture --text "..."          guarda un texto suelto
dm capture -                     guarda lo que venga por stdin
    --title <t>  --occurred <fecha>  --source <origen>

dm ls [--limit N] [--offset N] [--hidden]
dm search "<consulta>"           comillas para frases, - para excluir
dm show <id>                     acepta prefijos, como git
dm open <id> [-o archivo]        escribe el original a disco

dm hide <id> · dm unhide <id>    saca de los resultados sin destruir
dm purge <id> --yes              borra de verdad; queda en la auditoría
```

Globales: `--json` (el dato por stdout, los fallos por stderr) y `--actor <id>`.

**Códigos de salida:** `0` ok · `1` error · `2` requiere confirmación ·
`3` no encontrado · `4` prohibido · `5` prefijo ambiguo.

## Qué busca y qué no, en F0

La búsqueda ignora tildes y aplica stemming español: `mecanico` encuentra
*mecánico*, `recetas` encuentra *recetó*. Cubre el título, el nombre del archivo y
el texto — incluido el contenido de los archivos de texto, que se leen tal cual.

## El nombre del archivo casi nunca significa algo

`IMG_20260114_093312.jpg`, `WhatsApp Document 2026-01-14 at 09.33.12.pdf`,
`scan0001.pdf`, `documento (3).pdf`. Lo ponen la cámara, el escáner o WhatsApp, y
tratarlos como si fueran el título de la memoria es peor que no mostrar nada.

Dos consecuencias, y ninguna es tirar el dato:

- **Al mostrar**, un nombre que no dice nada se reemplaza por lo que sí: el
  contenido, o un descriptor honesto — `(foto sin nombre)`, `(PDF sin nombre)`.
  Un nombre que sí dice algo (`poliza-auto-2026.pdf`) se conserva.
- **Al buscar**, el nombre sigue indexado —a veces recuerdas cómo se llamaba— pero
  con el peso más bajo del `tsvector`. Nunca le gana a una coincidencia en el
  contenido real.

El nombre original **siempre se guarda íntegro** y se ve en `dm show`. Esto solo
decide cómo se presenta, no qué se conserva.

El arreglo de fondo es el título generado de F2. F0 solo puede evitar que la basura
se presente como si fuera un título.

**El contenido de un PDF o una foto todavía no es buscable.** Eso son los carriles
de normalización de F1 (markitdown, visión, Whisper). El archivo se guarda íntegro
desde ya; lo que falta es leerlo.

## Tests

```bash
npm run test:up          # stack de pruebas, aislado del de desarrollo
npm test                 # las tres capas
npm run test:unit        # sin Docker
npm run test:integration # core contra Postgres y Garage reales
npm run test:cli         # levanta el binario como lo haría una persona
npm run test:down
```

## Estructura

```
src/core/         operaciones tipadas. No sabe que existe un CLI.
  ops/            capture · search · list · show · lifecycle
  ports.ts        BlobStore · Clock · Db · Ingest
src/adapters/     cli · db/postgres · storage/s3
migrations/       SQL plano, aplicado en orden
```

El core devuelve datos y nunca texto formateado; toda operación recibe un actor; y
las confirmaciones son datos, no diálogos — el core devuelve `requires_confirmation`
y quien llama decide cómo pedirla. Eso es lo que permite que mañana entren Telegram
o una API sin tocar nada de `core/`.
