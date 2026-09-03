# deiz-memory

Memoria personal externa. Le mandas cualquier cosa y después le preguntas.

El diseño completo está en [CLAUDE.md](./CLAUDE.md); los flujos, en
[CASOS-DE-USO.md](./CASOS-DE-USO.md). Esto es lo que hace falta para correrlo.

**Estado: F3.** Captura, normalización por carriles, búsqueda full-text, y un
**canal de chat**: Telegram, o un canal en memoria para probar sin token.
Lo que mandas se lee por dentro: documentos con markitdown, fotos y escaneos con
OCR, notas de voz con Whisper. Los tres carriles son **servicios en contenedores
propios**, así que el mismo `docker compose up` levanta esto en tu máquina, en un
VPS o en una Raspberry Pi.

## Arrancar

```bash
npm install
npm run up          # levanta todo el stack y escribe las credenciales en .env
npm run migrate
npm run build
node dist/adapters/cli/index.js init "tu nombre"
npm run worker      # en otra terminal: procesa lo que va llegando
```

La primera vez tarda: se construyen dos imágenes y Whisper baja su modelo.

`npm run up` deja el CLI listo. Para que `dm` quede en el PATH: `npm link`.

`dm doctor` te dice qué carriles están vivos y cuáles no. Ninguno es obligatorio:
lo que llegue se guarda igual, solo que sin carril no es buscable por dentro.

## Comandos

```
dm doctor                        config, base de datos, bucket, dueño y carriles

dm capture <archivo>             guarda un archivo
dm capture --text "..."          guarda un texto suelto
dm capture -                     guarda lo que venga por stdin
    --title <t>  --occurred <fecha>  --source <origen>
    --wait       normaliza ahora en vez de encolar

dm worker                        corre los carriles sobre lo que va llegando
dm reprocess <id>                vuelve a leerlo desde el original
dm reprocess --failed            los que fallaron o quedaron a medias
    --pending  --all  --lane <carril>  --limit <n>  --wait  --yes

dm pair [--bot <usuario>]        código de un solo uso para vincular un chat
dm identities                    qué chats están vinculados
dm serve                         atiende el bot de Telegram
dm chat "<mensaje>" [--file f]   conversa sin Telegram, por un canal en memoria

dm review                        lo que quedó dudoso, y qué hacer con cada cosa

dm domains                       tus categorías, con cuántas tiene cada una
dm domains create <n> --desc ""  crea una; la descripción ES el prompt
dm domains edit|archive|merge    renombrar · sacar de circulación · fusionar
dm in <categoría>                lo de esa categoría, por fecha del hecho
dm classify [id]                 dominio, título y fecha del hecho, con IA local
dm domains propose               categorías que te faltan, deducidas de tus datos
    --accept <slug> [--label --desc]

dm ask "<pregunta>"              responde citando lo que guardaste
    --in <categoría>  --desde <fecha>  --hasta <fecha>  --solo-fuentes
dm index                         trocea y vectoriza lo que falte

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

## El canal

```bash
# .env.local
TELEGRAM_BOT_TOKEN=...        # te lo da @BotFather en dos minutos
```

Después `dm pair --bot tubot` imprime un link, lo abres, y estás adentro. Sin
cuenta, sin contraseña, sin instalar nada que no tengas ya — que es el argumento
entero de §10.

**Nadie entra sin ese código.** Un mensaje de un id desconocido recibe una línea
y nada más: no se guarda, ni siquiera para revisarlo después. El `user_id` de un
canal de chat no es falsificable, así que no hay nada que verificar — y archivar
lo que manda un extraño bajo tu dueño sería peor que descartarlo.

### El canal falso no es solo para tests

`dm chat` conversa con el mismo router, por un canal en memoria que declara
**`supportsButtons: false`**. Sirve para probar sin token, pero sobre todo es el
**segundo canal**: si el único fuera Telegram, la rama degradada de §7.1 no la
ejercitaría nadie y "el core no asume el canal" sería una intención escrita en
un comentario. Así, cada corrida de los tests la comprueba.

```bash
dm chat "¿cuál es mi deducible?"
dm chat "más"
dm chat --file boleta.jpg "la del taller"
```

### Qué hace el chat y qué se queda en la terminal

Una **pregunta** se responde con cita; una **búsqueda** (`/buscar`) lista. El
clasificador de intención decide cuál es, y respeta lo explícito.

```
/buscar <algo>   lista lo que coincide, de a cinco
/dominios        tus categorías · /<categoría> para ver una
/proponer        categorías que te faltan
/revisar         lo que quedó dudoso
/pendientes      qué falta por leer
ver:N · abrir:N  el detalle, o el archivo original
ocultar:N        sacar de resultados, sin borrar
```

Lo que **no** está en el chat es deliberado:

- **`purge`** — irreversible. Vive en la terminal, con confirmación y auditoría.
  El chat solo oculta.
- **`classify`, `index`, `reprocess`, `worker`, `serve`** — mantención, no
  conversación.
- **crear y fusionar categorías** — §9 las quiere en el chat y todavía no están;
  por ahora `dm domains`.

### El bot nunca te escribe primero

§2 no admite matices, así que no hay ningún "ya está lista tu foto". Capturar
responde en menos de un segundo y el texto tarda, y eso se resuelve por el otro
lado: **cuando buscas y no hay nada, el bot distingue "no lo tengo" de "todavía
no lo he leído"**.

No es cortesía. Una búsqueda que dice "no lo tengo" mientras un OCR corre está
mintiendo, y la tasa de "no lo tengo" honestos es la métrica estrella de §15.

**Dos cosas de Telegram que conviene saber.** Un bot **no puede bajar archivos
de más de 20 MB** y no hay forma de esquivarlo; si te topas con eso, se
self-hostea `tdlib/telegram-bot-api` y se apunta `TELEGRAM_API_ROOT` ahí. Y los
chats de bot **no son E2E**: Telegram puede leer lo que le mandes (§14 ya lo
asume).

## El clasificador es local

Dominio, título corto y fecha del hecho los pone un modelo que corre en el mismo
compose (Ollama, `qwen2.5:3b`). Nada sale del host y no cuesta por documento.

**Es la decisión opuesta a la del carril de visión, y a propósito.** Clasificar
es elegir entre ocho categorías y escribir un título de cinco palabras: un
modelo chico rinde bien. Leer un número de póliza no: ahí los modelos chicos
fallan justo en los dígitos, y por eso el OCR clásico se quedó con ese carril.

El prompt **se arma en runtime desde la tabla `domains`** — no hay una lista de
categorías escrita en el código, en ningún lado. Por eso la `description` de un
dominio no es documentación: es literalmente lo que el modelo lee para decidir.

**Y eso se nota.** En la primera pasada sobre 170 documentos, 73 quedaron sin
dominio — entre ellos el manual de la alarma del depto, con 0,95 de confianza.
No era un fallo del modelo: la descripción de *Hogar* hablaba de garantías,
técnicos y gastos comunes, y un manual de alarma no está ahí. Ampliar la
descripción —**editar datos, sin tocar código ni desplegar**— lo movió a `hogar`
con 0,9.

Si una categoría te queda vacía o se llena de cosas raras, el arreglo casi
siempre es `dm domains edit <slug> --desc "..."` y volver a clasificar.

### Las categorías que te faltan las encuentra solo

No tienes que anticipar tus propias categorías: hoy no sabes qué vas a guardar
en dos años. `dm domains propose` mira lo que quedó sin clasificar y busca
racimos entre las etiquetas que el clasificador ya puso.

```
11 cosas parecen "Webdox" (/webdox)
   descripción sugerida: webdox: corporativo, wallpaper, marca, fondo
   · Wallpaper Webdox 04
   · Banner de LinkedIn — rebrand Webdox
   aceptar: dm domains propose --accept webdox
```

**Propone, nunca crea solo.** Que proponer y aceptar sean dos comandos distintos
es la regla escrita en la forma del código: proponer no escribe nada. Y puedes
cambiar el nombre y la descripción antes de aceptar —`--label`, `--desc`—
porque esa descripción va a ser el prompt del clasificador.

Usa las etiquetas que ya existen en vez de preguntarle otra vez al modelo: si
diez documentos coinciden en "webdox", ese acuerdo es mejor señal que una
segunda opinión. Descarta las palabras que ya cubre un dominio activo, para no
proponerte lo que ya tienes.

Lo que devuelve se valida contra la realidad antes de guardarlo: un dominio que
no existe se descarta en vez de crearse, y una fecha del futuro o con formato
inventado se cae a null. Regla dura 2: no inventar.

**Lo que tú pusiste gana.** Si escribiste un título o una fecha al capturar, el
clasificador no los toca — rellena huecos, no corrige decisiones. Y si queda con
poca confianza, la memoria pasa a la bandeja de `dm review`.

```bash
DM_CLASSIFY_URL=http://localhost:11434/v1   # cualquier API compatible con OpenAI
DM_CLASSIFY_MODEL=qwen2.5:3b
```

En Docker sobre macOS esto corre en CPU (~12 s por documento). Si quieres que
vuele en tu Mac, Ollama nativo usa Metal: apunta `DM_CLASSIFY_URL` al host.

## Preguntar

```
$ dm ask "¿cuál es el deducible de mi seguro de auto?"
El deducible es de 5 UF por siniestro [e6843426].

fuentes:
  e6843426  2026-03-01 · Seguros  Póliza de automóvil 4471-2026
      …Deducible: 5 UF por siniestro. Asistencia en ruta 24/7…
```

**La cita no es decorativa: es la regla dura 1.** Ningún dato factual se muestra
sin memoria de respaldo, y eso se verifica **en código** — si el modelo responde
sin citar, se le pide una vez más y, si insiste, se descarta la prosa y se
muestran los pasajes crudos. Que el prompt lo pida no garantiza que obedezca.

Las citas se resuelven a ids abribles con `dm show`. Un `[1]` no sirve de nada
media hora después.

### Cómo busca

Filtro estructurado primero —dominio y ventana de fechas—, y sobre ese
subconjunto los dos caminos de §6:

- **full-text** sobre los trozos: preciso para lo que se escribe igual, un RUT,
  una patente, un número de póliza
- **semejanza** con vectores locales (`nomic-embed-text`, 768d): rescata las
  preguntas escritas con otras palabras que el documento

Se fusionan normalizando cada lista contra su propio máximo, porque `ts_rank` y
la similitud coseno viven en escalas distintas. Un trozo que aparece en las dos
sube: que dos métodos independientes coincidan es la mejor señal que hay.

**Una pregunta no se busca con AND.** `/buscar poliza auto` pide las dos cosas;
"¿cuál es el deducible de mi seguro de auto?" no — el párrafo que responde dice
"deducible" y no dice "auto". Medido sobre una póliza real: cero resultados con
AND, ocho con la palabra sola. Preguntar hace OR y deja que el ranking ordene.

**Se indexa por trozos, no por documento.** Una póliza de 80 mil caracteres
promediada en un vector no se parece a nada en particular. Y cada trozo se
embebe **solo**, sin anteponerle el título: si los ochenta empiezan con "póliza
de auto BCI", los ochenta se parecen entre sí y ninguno destaca.

Todo local: los vectores y la redacción salen de Ollama en el mismo compose.
Sin embedder el sistema degrada a full-text en vez de fallar.

## Los tres carriles

markitdown convierte PDF, docx, xlsx, html y csv a Markdown **preservando la
estructura**: una tabla de coberturas sigue pareciendo una tabla. Es barato,
determinista y reproducible, así que se intenta siempre primero.

Pero **markitdown no hace OCR**, y eso es lo que da forma a todo el diseño. Un PDF
escaneado devuelve vacío; una foto devuelve, como mucho, una *descripción* — y una
descripción no sirve para encontrar el monto de una boleta. Por eso no hay una
llamada de normalización: hay carriles, y una regla de caída entre ellos.

| Entrada | Carril | Servicio |
|---|---|---|
| txt, md | `text` | se lee tal cual, sin salir del proceso |
| PDF con capa de texto, docx, xlsx, pptx, html, csv | `document` | `documents` · markitdown |
| PDF escaneado (menos de ~100 caracteres de texto) | `vision` | `ocr` · RapidOCR |
| foto de receta, boleta, carnet, patente | `vision` | `ocr` · RapidOCR |
| foto HEIC (el default del iPhone) | `vision` | se convierte a JPEG y va al OCR |
| nota de voz | `audio` | `whisper` |

El carril que se usó queda en la fila (`dm show` lo muestra), que es lo que
permite reprocesar después sin adivinar qué pasó.

### Por qué OCR y no un modelo de visión

Para documentos **impresos** —boletas, pólizas, carnets— el OCR clásico no es un
premio de consuelo: gana. Los modelos multimodales chicos leen bien el texto
corrido y se equivocan justo donde no hay que equivocarse, en cadenas que no se
pueden adivinar por contexto: un número de póliza, un RUT, un monto. Y ese es
exactamente el dato que uno viene a buscar. Un modelo que inventa un dígito con
seguridad viola la regla dura 2 de frente.

Encima, el OCR cumple algo que la nube no puede: **es reproducible**. El mismo
blob da el mismo texto hoy y en dos años. No cuesta nada por foto y no sale del
host.

**HEIC se convierte antes de leer.** Es el formato por defecto del iPhone y no
lo acepta ni el OCR ni la API de visión, así que el sidecar lo pasa a JPEG. **El
original no se toca** (§3.6): el blob sigue siendo el HEIC y solo cambia lo que
se le entrega al motor, así que el día que algo lo lea nativo se reprocesa y se
gana calidad sin haber perdido nada.

**Lo que el OCR no puede hacer**, y por lo que el carril sigue siendo
intercambiable: manuscrito, y describir una foto sin texto. A la foto de un
choque el OCR no le encuentra nada; un modelo multimodal al menos dice qué se ve.
Si guardas mucho de eso, cambia el backend.

### Cambiar de motor sin tocar código

El carril de visión es una variable de entorno:

```bash
DM_VISION_BACKEND=ocr        # RapidOCR local (por defecto)
DM_VISION_BACKEND=anthropic  # Claude — el único que recibe el PDF entero
DM_VISION_BACKEND=openai     # cualquier API compatible: Ollama, llama.cpp,
                             # vLLM, LM Studio, OpenAI, o LiteLLM de pasarela
DM_VISION_BACKEND=none       # apagado, y dm doctor lo dice
```

Los tres implementan el mismo puerto y comparten el mismo prompt (`prompt.ts`):
el proveedor es intercambiable, lo que se le pide no. Whisper es igual — habla
`POST /v1/audio/transcriptions`, así que cambiar de motor es cambiar `DM_SPEECH_URL`.

**Un detalle que no es obvio:** el formato de chat de OpenAI —el que hablan
Ollama, llama.cpp y vLLM— solo acepta imágenes, no PDF. Anthropic sí acepta el
PDF entero. Para que un backend local funcione igual, el sidecar de documentos
rasteriza las páginas con pypdfium. Por eso `documents` hace dos cosas.

**Un carril caído no rompe nada.** El archivo se guarda igual, el error queda
anotado en la memoria, y `dm reprocess --failed` lo retoma cuando arregles lo que
faltaba. El original nunca se toca, así que todo lo derivado se puede volver a
generar: es la razón por la que se puede mejorar el prompt sin miedo.

## Tu nota y lo transcrito no se mezclan

Lo que escribes tú vive en `note`. Lo que se extrae del archivo vive en
`normalized_text`. Nunca en el mismo campo, y no es un detalle de esquema: si
fueran uno solo, la primera transcripción se comería lo que escribiste al mandar
la foto, y eso no se regenera desde ningún lado.

`dm show` los muestra por separado y etiquetados. Los dos se buscan igual.

De ahí salen dos reglas que el código sostiene con tests:

- **La migración 003 rescata todas las notas de F0**, incluidas las de memorias
  con archivo — en F0 ese campo era la nota, porque el contenido del archivo solo
  se leía para blobs `text/*`.
- **Reprocesar nunca deja las cosas peor.** Si un carril falla, o devuelve menos
  de lo que ya había, no se toca el texto anterior ni su procedencia. Si pudiera
  empeorar, nadie reprocesaría su histórico — y ahí "todo lo derivado es
  regenerable" deja de ser una red.

## Qué busca y qué no

La búsqueda ignora tildes y aplica stemming español: `mecanico` encuentra
*mecánico*, `recetas` encuentra *recetó*. Cubre el título, tu nota, el texto
extraído del archivo y el nombre del archivo.

### El stemming a veces trae un primo lejano

El mismo mecanismo que hace que `recetas` encuentre *recetó* corta las palabras
hasta su raíz, y esa raíz a veces la comparten palabras que no tienen nada que
ver. Caso real de este corpus:

| Palabra | Raíz |
|---|---|
| `deducible` (lo que buscas) | `deduc` |
| `deducida`, `deducir` (lo que hay en un poder notarial) | `deduc` |

Buscar el deducible del seguro trae también un mandato judicial, porque en
español jurídico chileno **"deducir una acción" es presentar una demanda**. El
stemmer corta terminaciones; no sabe de sentidos.

No es un bug que convenga arreglar bajando el stemming: perderías mucho más de
lo que ganas. Si molesta, las comillas piden la palabra exacta:

```bash
dm search '"deducible"'          # sin stemming, frase literal
```

El arreglo de fondo llega con **F2**: un poder notarial no cae en el dominio
*seguros*, así que filtrar por dominio deja fuera al primo sin tocar la búsqueda.

### Lo que quedó dudoso: `dm review`

Cuando un carril no puede o sale con poca confianza, la memoria se guarda igual
y la duda queda anotada. Eso es §3.4: la captura nunca se bloquea con preguntas.
Para verlas:

```
dm review          # y en el chat: /revisar
```

Cada línea dice **qué hacer**, no solo qué pasó — una bandeja que enumera
problemas sin salida te deja igual que abriendo `psql`:

```
3f842110  2026-08-30 03:34  Foto IMG_0840  · sin texto
          el carril "vision" falló: la API no acepta image/heic como imagen…
          reintentar NO sirve: necesita otro carril o convertir el archivo
```

**La distinción importa.** `dm reprocess --failed` arregla lo transitorio —un
servicio apagado, la API limitando el ritmo—. Para un HEIC que ningún carril
sabe leer es un botón que no hace nada, y ofrecerlo igual enseña a desconfiar
del consejo. Lo declara quien falla, no una regex sobre el mensaje: los adapters
lanzan un error marcado como permanente cuando saben que reintentar no cambiaría
nada. Todo lo demás se asume transitorio — equivocarse hacia "reintenta" cuesta
una corrida, hacia "no insistas" esconde una memoria para siempre.

Lo que falló queda en `status = needs_review`. Antes se quedaba con el estado
anterior, así que una memoria sin una sola letra extraída podía figurar como
`normalized`.

### Si algo no aparece, puede que aún no lo haya leído

Buscar solo alcanza el contenido de un archivo **después** de que un carril lo
procesó, y eso lo hace `dm worker`. Sin el worker corriendo, lo que capturas se
guarda entero pero es invisible por dentro.

No hay que adivinarlo. `dm show` lo dice —*carril: todavía sin normalizar*—, el
bot lo agrega a cualquier búsqueda —*(falta 1 cosa por leer)*—, y `dm doctor` lo
cuenta. Es a propósito: una búsqueda que responde "no lo tengo" mientras un OCR
corre está mintiendo.

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

**El contenido de un PDF o una foto ya es buscable**, apenas el worker lo procesa.
Hasta entonces `dm show` lo dice: *todavía sin normalizar*.

## Configurar

`npm run up` levanta los cinco servicios y escribe las URLs en `.env`. Con eso
los tres carriles andan sin configurar nada más.

**`npm run up` reescribe `.env` entero cada vez.** Tus llaves de proveedores van
en **`.env.local`**, que está gitignoreado, se carga primero y gana:

```bash
# .env.local
ANTHROPIC_API_KEY=sk-ant-...        # solo si usas DM_VISION_BACKEND=anthropic
DM_SPEECH_MODEL_NAME=small          # tiny | base | small | medium | large-v3
```

**El modelo de Whisper importa más que el motor.** En español `base` da 18.4% de
WER y `small` 9.7%. Con 18% se destrozan justo los nombres propios y los números
—o sea lo único que uno guarda—, así que el compose usa `small` y no el `base`
que trae la imagen por defecto. Medido acá, dictando un teléfono de ocho dígitos:
`tiny` se comió uno, `small` los transcribió todos.

Los servicios publican en `127.0.0.1`, no en `0.0.0.0`: procesan documentos
médicos y financieros y no tienen por qué ser alcanzables desde fuera del host
(§14). Por eso mismo Whisper corre con la autenticación desactivada; si prefieres
llave igual, pon `DM_SPEECH_API_KEY` en `.env.local` y la reciben los dos lados.

Después, `dm doctor`: los obligatorios salen con `✓` o `✗`, y los carriles con
`·` cuando no están disponibles. Solo lo obligatorio decide el código de salida —
un carril apagado no es un sistema roto.

## Tests

```bash
npm test                 # las tres capas
npm run test:unit        # sin Docker
npm run test:integration # core contra Postgres, Garage y los servicios reales
npm run test:cli         # levanta el binario, y el worker, como una persona
```

**No hay stack de pruebas aparte.** Los tests usan los mismos contenedores que
levanta `npm run up`; lo único que se aísla es lo que destruyen: la base
`deiz_memory_test` y el bucket `deiz-memory-test`, ambos sobre el mismo Postgres
y el mismo Garage. Duplicar los cinco servicios significaba bajar dos veces el
modelo de Whisper para ejercitar el mismo código.

Ese aislamiento no es cosmético: `reset()` hace `truncate memories, blobs, owners
cascade` en cada test. Apuntado a tu base, borra todo lo que has guardado — por
eso vive en `tests/helpers/env.ts` y no en una variable suelta.

## Estructura

```
src/core/         operaciones tipadas. No sabe que existe un CLI.
  ops/            capture · search · list · show · lifecycle · reprocess
  normalize/      lanes.ts (el router, lógica pura) · run.ts
  ports.ts        BlobStore · Clock · Db · Ingest · Converter
src/core/channel/ el puerto del canal: capacidades declaradas (§7.1)
src/core/router/  los verbos de §5. intent y actions son puros
src/adapters/     cli · db/postgres · storage/s3 · normalize · queue · chat
services/         los carriles, como contenedores
  documents/      markitdown + rasterizado de PDF
  ocr/            RapidOCR
migrations/       SQL plano, aplicado en orden
```

Los tres carriles entran por **un solo puerto con tres ranuras** (`Converter`).
Cuál se intenta y cuándo se cae al siguiente es del core y se prueba sin Docker,
sin red y sin gastar tokens; que markitdown sepa leer un docx es problema de
markitdown, y se prueba aparte contra archivos reales.

El core devuelve datos y nunca texto formateado; toda operación recibe un actor; y
las confirmaciones son datos, no diálogos — el core devuelve `requires_confirmation`
y quien llama decide cómo pedirla. Eso es lo que permite que mañana entren Telegram
o una API sin tocar nada de `core/`.
