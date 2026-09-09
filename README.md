# deiz-memory

Memoria personal externa. Le mandas un archivo y después le preguntas.

El diseño está en [CLAUDE.md](./CLAUDE.md). Esto es lo que hace falta para correrlo.

**Estado.** Captura, normalización por tres carriles, búsqueda full-text y semántica,
clasificación con IA local, preguntas en lenguaje natural con cita verificada, y **datos
tipados** para los campos que no toleran un ranking. Todo por Telegram o por terminal.
373 tests.

El sistema se vació el 3 de septiembre de 2026 para poblarlo desde cero; si vienes de
antes, hay que **volver a vincular el chat** con `dm pair`.

Lo único pendiente es el **backup cifrado off-site**, y es el único riesgo irreversible:
los blobs viven en un solo host y un blob perdido no se reprocesa desde nada.

## Arrancar

```bash
npm run up
```

Eso es todo. Levanta la infraestructura, acuña las credenciales del storage,
aplica el esquema y deja corriendo el worker y el bot — **todo en contenedores**.
Termina imprimiendo el diagnóstico.

La primera vez tarda: se construyen tres imágenes, Whisper baja su modelo y
Ollama los suyos.

```bash
npm run logs                    # qué está haciendo el worker y el bot
npm run dm -- doctor            # cualquier comando, dentro de un contenedor
npm run dm -- ask "..."
npm run down                    # bajar todo
```

**Nada corre en el host.** Ni Node, ni los carriles, ni el modelo: la única
dependencia para usarlo es Docker. `npm` solo hace falta para desarrollar.

Si prefieres el binario en tu PATH para el día a día, `npm install && npm run
build && npm link` te deja `dm` apuntando al mismo stack por localhost.

## Comandos

**Uno solo por operación, en inglés.** Los del chat son los del CLI.

### Chat

```
/capture <texto>     guarda eso como memoria    (un archivo se guarda solo)
/ask <pregunta>      responde citando la fuente
/search <algo>       lista lo que coincide, de a cinco
/pending             qué falta por leer
/review              lo que quedó dudoso
/domains             tus categorías · /<slug> para ver una
/facts               los datos duros, con su vigencia
/create <n>: <desc>  crea una; la descripción ES el prompt
/describe <n>: <d>   ·  /rename <n> <nuevo>  ·  /archive <n>  ·  /merge <a> <b>
/propose             categorías que te faltan
/help

view:N  los datos   ·  open:N  el archivo  ·  hide:N  sacar de resultados
more    siguiente   ·  save    guardar lo que buscaste  ·  yes / no

view:<id>  las tres numeradas aceptan también el id, como `dm show a3f2`
```

El separador es `:` porque tanto el nombre como la descripción llevan espacios.

### Terminal

```
dm doctor                        config, base, bucket, dueño y carriles

dm capture <archivo>             guarda un archivo
dm capture --text "..." | -      un texto suelto, o lo que venga por stdin
    --title <t>  --occurred <fecha>  --source <origen>  --wait

dm worker                        corre los carriles sobre lo que va llegando
dm reprocess <id>                vuelve a leerlo desde el original
    --failed  --pending  --all  --lane <carril>  --limit <n>  --wait  --yes

dm pair [--bot <usuario>]        código de un solo uso para vincular un chat
dm identities                    qué chats están vinculados
dm serve                         atiende el bot de Telegram
dm chat "<mensaje>" [--file f]   conversa sin Telegram, por un canal en memoria

dm review                        lo que quedó dudoso, y qué hacer con cada cosa

dm domains                       tus categorías, con cuántas tiene cada una
dm domains create <n> --desc ""  ·  edit  ·  archive  ·  merge  ·  propose
dm facts [--all]                 lo extraído; --all incluye lo superado
dm facts types                   qué sabe extraer, y de qué categoría
dm facts extract [id]            vuelve a extraer
dm in <categoría>                lo de esa categoría, por fecha del hecho
dm classify [id]                 dominio, título y fecha del hecho, con IA local

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

Globales: `--json` y `--actor <id>`. **Salidas:** `0` ok · `1` error · `2` requiere
confirmación · `3` no encontrado · `4` prohibido · `5` prefijo ambiguo.

## El canal

```bash
# .env.local
TELEGRAM_BOT_TOKEN=123456:ABC...
```

`dm serve` atiende. `dm pair --bot <usuario>` imprime un link de un solo uso que vence
en 15 minutos; quien lo abre queda vinculado. Un id desconocido recibe una línea seca y
después silencio: nunca se guarda contenido de un extraño.

### El canal falso no es solo para tests

`dm chat "<mensaje>"` habla por un canal en memoria que declara
`supportsButtons: false`. Existió **antes** que el de Telegram, y por eso las
capacidades se declaran en vez de asumirse: con un solo canal no hay forma de saber si
lo que escribiste vale para el segundo.

Cada corrida de los tests del CLI ejercita la rama degradada de punta a punta.

### Guardar es explícito; escribir es preguntar

Mandas un archivo y se guarda. Escribes texto suelto y se consulta. Para guardar un
texto, `/capture`.

Esto invierte §5 a propósito: lo que uno escribe en una conversación es casi siempre
algo que le está preguntando a alguien. Antes se adivinaba con una heurística
(*¿empieza con «cuál»?*), acertaba a medias, y dejaba preguntas guardadas como memorias
que después hay que ocultar a mano. No se pierde nada: si la consulta no encuentra nada,
la respuesta ofrece guardar ese texto tal cual, a un toque.

### Dos botones por resultado, en todo listado

`datos` y `archivo`, en la misma fila. **En todos:** resultados de búsqueda, categoría,
bandeja de revisión y las fuentes de una respuesta. Que cada pantalla armara sus propios
botones es lo que hizo que preguntar ofreciera solo `datos` mientras buscar ofrecía los
dos — no es una decisión distinta por pantalla, es la misma escrita una vez. Bajar un documento era antes dos toques y una
pantalla intermedia — abrir el detalle solo para poder pedir el original. Un resultado
sin archivo (una nota tuya) no ofrece el segundo: un botón que sabe de antemano que va a
fallar es peor que no estar.

`view:N` muestra **los datos** —categoría, fecha del hecho, tipo, tamaño, tu nota y un
asomo de lo leído—, no la transcripción entera.

**El número es de la última lista que viste.** No salió gratis: `/documentos`
numeraba sus resultados y ofrecía los botones sin registrar esos ids, así que `view:2`
abría el segundo de la *búsqueda anterior*. Numerar y registrar vivían en archivos
distintos; ahora el registro cuelga de la forma del `Outcome`, en un solo lugar.

**El botón no usa el número: lleva el id.** En un chat el historial queda ahí y se puede
tocar. Si subes tres días después y aprietas el botón de una lista vieja, un índice
relativo se resolvería contra la lista de *ahora* — y no falla, abre otro documento, que
es la peor forma de fallar. Con el id adentro ese botón sigue siendo correcto para
siempre. El número se queda para lo escrito, porque nadie teclea ocho hex en un teléfono;
las dos formas son el mismo verbo con distinto direccionamiento, no dos vocabularios.

### El bot nunca te escribe primero

No hay ningún "ya está lista tu foto". Capturar responde en menos de un segundo y el
texto tarda, y eso se resuelve por el otro lado: **cuando buscas y no hay nada, el bot
distingue "no lo tengo" de "todavía no lo he leído"**. Una búsqueda que dice "no lo
tengo" mientras un OCR corre está mintiendo.

Lo sostiene el tipo: `Turn.reply()` deja de servir cuando el handler retorna, así que el
bot no *tiene cómo* iniciar conversación.

**Dos cosas de Telegram.** Un bot **no puede bajar archivos de más de 20 MB** y no hay
forma de esquivarlo; si te topas con eso, se self-hostea `tdlib/telegram-bot-api` y se
apunta `TELEGRAM_API_ROOT` ahí. Y los chats de bot **no son E2E**.

## El clasificador es local

Dominio, título corto y fecha del hecho los pone un modelo que corre en el mismo compose
(Ollama, `qwen2.5:3b`). Nada sale del host y no cuesta por documento.

**Corre solo, como parte de guardar.** No hay comando que correr; `dm classify` existe
para rehacer una clasificación a propósito. Durante toda una fase no fue así: el
clasificador funcionaba pero solo lo llamaba `dm classify` a mano, y quince documentos
quedaron normalizados, indexados y sin categoría con `doctor` en verde. Por eso `doctor`
tiene ahora su propia fila `clasificar`: un chequeo que no mira el paso siguiente da una
calma falsa.

**El prompt se arma en runtime** desde las descripciones de los dominios activos, así que
crear una categoría cambia cómo clasifica sin tocar código. Lo que el modelo devuelve se
valida: un dominio inventado se descarta, una fecha del futuro también, y **lo que pusiste
tú nunca se pisa**.

### La descripción es lo que clasifica

Sobre 170 documentos reales, el manual de la alarma quedaba sin dominio con 0,95 de
confianza — el modelo tenía razón: la descripción de "Hogar" hablaba solo de garantías y
gastos comunes. Ampliarla lo movió a `hogar` con 0,9. **Sin tocar una línea de código.**

Si algo cae donde no esperabas, la primera pregunta no es "¿qué modelo uso?" sino "¿qué
dice la descripción?".

### Las categorías que te faltan las encuentra solo

`dm domains propose` (o `/propose`) agrupa lo que no calzó en ningún dominio activo y
sugiere categorías nuevas, con ejemplos para que decidas mirando. **Propone; crear lo
decides tú**, y antes de crear avisa si se solapa con una que ya existe: crear libremente
termina en 40 dominios con la mitad repetidos.

## Preguntar

`dm ask "<pregunta>"` y, en el chat, cualquier texto suelto (o `/ask`).

Filtro estructurado primero —dominio y fechas—, y sobre ese subconjunto **full-text**
(preciso para un RUT o un número de póliza) y **semejanza** con vectores locales
(`nomic-embed-text`, 768d, rescata lo escrito con otras palabras). Se fusionan
normalizando cada lista contra su propio máximo.

**Se indexa por trozos, no por documento.** Una póliza de 80 mil caracteres promediada en
un vector no se parece a nada en particular. Y cada trozo se embebe solo, sin anteponerle
el título: si los ochenta empiezan con "póliza de auto BCI", ninguno destaca.

**Una pregunta no se busca con AND.** `/search poliza auto` pide las dos cosas; una
pregunta no — el párrafo que responde dice "deducible" y no dice "auto". Medido sobre una
póliza real: cero resultados con AND, ocho con la palabra sola.

**Pero el OR tampoco puede decidir el orden.** *"¿Cuánto es mi deducible en el seguro de
mi vehículo?"* no respondía, y no era el modelo: `seguro` está en el 16% de los trozos y
`vehiculo` en el 15%, contra el 4% de `deducible`. Rankear con todos los términos hacía
que los trozos que solo repetían el tema empataran con el único que traía la cifra, y ese
quedaba séptimo — fuera de lo que el modelo lee.

Ahora se busca con todos los términos y **se rankea solo con los que discriminan**: los
comunes suman recall pero no ordenan. El umbral es relativo al término más raro de la
propia pregunta, así que no hay que calibrarlo cuando el corpus crece.

### Ninguna cifra que no esté en lo que leyó

La verificación de cita comprueba que el documento citado exista. No comprueba que **el
número** venga de ahí, y ese hueco dejaba pasar el peor caso: cita válida, cifra
inventada — más creíble que una respuesta sin cita.

Pasó de verdad. A *"¿cuál es el deducible de mi seguro de auto?"* contestó **"5 UF"**, y
ninguno de los ocho pasajes recuperados contenía ese número. La misma pregunta sin la
palabra "auto" respondía bien (3 UF): "auto" hace que el OR traiga el anexo de asistencia
en ruta, saturado de "vehículo", y empuje fuera la tabla de coberturas.

Ahora **toda cifra de la respuesta tiene que aparecer en los pasajes leídos**, o la prosa
se descarta y quedan las fuentes. Dos detalles que lo hacen usable:

- **Normaliza la escritura chilena.** `UF 3,0` en el documento y `3 UF` en la respuesta
  son el mismo dato; `$89.990` son 89990. Sin esto se descartarían justo las respuestas
  correctas.
- **Comprueba la unidad, no solo el número.** Es lo que atrapa `$89.990` redactado como
  `89.990 UF`.

Es estricto a propósito: un "no lo tengo" de más se recupera —las fuentes están ahí—; un
número inventado con cita válida no lo delata nada.

**Las fuentes van una por memoria.** Recuperar por trozo es correcto —el modelo necesita
el párrafo—, pero mostrarlo por trozo hacía que la misma póliza apareciera tres veces.

## Los datos duros no se buscan, se consultan

Preguntar *"¿cuánto es mi deducible?"* a un índice de búsqueda es usar la herramienta
equivocada: la respuesta es un número exacto, no un ranking. Medido sobre la póliza real,
los ocho trozos recuperados puntuaban entre 1,62 y 1,77 — un 9% para decidir cuál
responde, porque todos hablan de seguros de auto y la pregunta también.

Así que ciertos campos se extraen **una vez, al guardar**, a una tabla:

```
$ dm ask "cuanto es mi deducible en el seguro de mi vehiculo?"
deducible por siniestro: UF 3
    Póliza de auto VHWD58 · vigente 2026-07-29 a 2029-07-29 · a853a71c
```

Sin ranking, sin modelo redactando, sin nada que verificar después.

**Se pregunta con tus palabras, no con las del registro.** Los alias de cada campo se
comparan por raíz: `paga`, `pago`, `pagos` y `pagar` son lo mismo, y `vence` llega a
`vencimiento`. Enumerar conjugaciones al definir un tipo sería pedirle a quien lo escribe
que se acuerde de conjugar.

**Qué se extrae es data, no código.** `dm facts types` lo muestra: un tipo declara sus
campos, de qué categoría intentarlos, y con qué palabras se pregunta por cada uno. Agregar
`poliza_salud` no es un deploy — es una fila, igual que una categoría.

### Cada valor se comprueba contra el documento

El modelo propone; el código verifica. Un campo que no aparece en el texto original se
descarta, comparando el valor normalizado contra todas las formas en que el documento
pudo escribirlo: `UF 3,0` respalda un `3`, `$886.568` respalda un `886568`, y `07/09/2026`
respalda un `2026-09-07`. Sin esa normalización se descartarían justo los valores buenos.

**Y bajo qué rótulo, no solo que exista.** Tu cartola trae dos filas parecidas:

```
MONTO FACTURADO A PAGAR (PERÍODO ANTERIOR)   $886.568     ← el mes pasado
MONTO TOTAL FACTURADO A PAGAR                $1.747.885   ← el correcto
```

Las dos cifras están en el documento y las dos pasaban el chequeo, así que la respuesta
era la del mes pasado con toda confianza. Ahora un campo declara junto a qué palabras debe
estar y junto a cuáles **no** — y esto último es lo indispensable, porque el rótulo del
señuelo contiene al del bueno: lo que los separa no es lo que tienen, es lo que sobra.

Y el extractor ya no ve "los primeros N caracteres" sino **la cabecera más las líneas que
traen un rótulo declarado**. El recorte estaba decidiendo la respuesta: el monto correcto
vivía en el carácter 6157 y el corte era 6000.

Y **sin el campo identidad no es de ese tipo**. Eso salió de medir: en el dominio
`seguros` había una póliza, una liquidación de siniestro y un certificado de cobertura, y
los tres se tipificaban como póliza aunque la descripción excluía los otros dos. Un modelo
de 3B lee esa exclusión y la ignora; un `if` no. Una póliza sin patente no es una póliza.

### Estado y período

Un tipo `estado` tiene **uno vigente** — la póliza nueva sucede a la vieja, que sigue
existiendo y sigue respondiendo qué cubría antes. Un tipo `periodo` **coexiste**: la
cartola de agosto no reemplaza a la de julio, porque la de julio sigue siendo la verdad
sobre julio.

Sin esa distinción el sistema habría marcado julio como superada, que es peor que no tener
el dato. Y la supersesión solo ocurre cuando las vigencias **no se solapan**: dos vigentes
a la vez no son una sucesión, son un conflicto, y entonces se muestran las dos.

**Lo vencido se dice antes del dato**, nunca después. Es la razón de ser de la fecha de
término: el riesgo no es olvidar un dato, es leer el viejo sin darte cuenta.

### Lo que no es un dato duro

Esa cartola trae **53 líneas de transacción**. Eso no es un campo, es una tabla, y
*"¿cuánto gasté en delivery?"* necesita sumar filas. Queda fuera por diseño: agregar
gastos por comercio es una app de finanzas. La línea es responder *"tienes que pagar
$886.568 antes del 7 de septiembre"* y parar ahí.

## Los tres carriles

| Entrada | Carril | Servicio |
|---|---|---|
| PDF con capa de texto, docx, xlsx, pptx, html, csv | `document` | markitdown |
| PDF escaneado, foto, escaneo | `vision` | RapidOCR |
| Nota de voz | `audio` | Whisper |
| .txt, .md | `text` | ninguno |

Siempre se intenta `document` primero —barato, determinista, reproducible— y se cae a
`vision` si el resultado viene pobre (menos de 100 caracteres). El carril usado queda en
la fila: reprocesar no tiene que adivinar qué pasó.

### Por qué OCR y no un modelo de visión

En documentos impresos el OCR **gana** justo donde importa: números de póliza, RUT,
montos. Cadenas que no se adivinan por contexto y donde los modelos chicos fallan. Además
es gratis y reproducible desde el blob.

El carril multimodal sigue disponible y es el correcto para **manuscrito**, que es lo que
el OCR no puede leer.

### Cambiar de motor sin tocar código

```bash
DM_VISION_BACKEND=rapidocr|anthropic|openai
DM_DOCS_URL=http://localhost:8081
DM_SPEECH_URL=http://localhost:8082/v1
DM_CLASSIFY_MODEL=qwen2.5:3b
DM_EMBED_MODEL=nomic-embed-text
```

Los tres carriles entran por un solo puerto (`Converter`) con tres ranuras.

## Tu nota y lo transcrito no se mezclan

`note` es lo que escribiste tú y **no se regenera nunca**; `normalized_text` es lo que
salió del archivo y se rehace cuando quieras. Cuando vivían en la misma columna, la
primera transcripción se comía la nota.

En una lista se muestra tu nota antes que el OCR: tus palabras se reconocen mejor que la
transcripción del papel.

## Qué busca y qué no

`dm search` busca en el título, tu nota y el texto extraído. Es full-text en español con
stemming, así que "póliza" encuentra "pólizas" — y a veces trae un primo lejano: buscando
`deducible`, el stemmer español reduce tanto *deducible* como *deducción* a `deduc`. No
es un bug; es el precio de que "vencimiento" encuentre "vence".

### Lo que quedó dudoso: `dm review`

Los carriles marcan lo que no pudieron leer bien. `dm review` (o `/review`) lo muestra
con **qué hacer con cada cosa**, distinguiendo el fallo transitorio —un servicio apagado,
que `dm reprocess --failed` arregla— del permanente, donde reintentar es un botón que no
hace nada. Lo declara el carril que falla, no una regex sobre el mensaje.

### Si algo no aparece, puede que aún no lo haya leído

Toda respuesta vacía dice cuántas cosas están en cola. Una búsqueda que responde "no lo
tengo" mientras un OCR corre está mintiendo, y la tasa de "no lo tengo" honestos es la
métrica que importa.

## El nombre del archivo casi nunca significa algo

`IMG_20260114_093312.jpg`, `scan0001.pdf`, `WhatsApp Document 2026-01-14.pdf`. Telegram
entrega las fotos **sin nombre**. Por eso el título lo pone el clasificador, y por eso el
original se devuelve con la extensión derivada de su media type detectado por magic
bytes: sin eso volvía como `a1b2c3d4.bin` y ningún visor lo abría.

## Configurar

`scripts/garage-init.sh` escribe en `.env` todo lo que hace falta para hablar
con el compose. **Ese archivo se reescribe entero en cada arranque**, así que tus
llaves van en **`.env.local`**, que está gitignoreado:

```bash
# .env.local
TELEGRAM_BOT_TOKEN=123456:ABC...
ANTHROPIC_API_KEY=sk-ant-...        # solo si usas DM_VISION_BACKEND=anthropic
DM_SPEECH_MODEL_NAME=small          # tiny | base | small | medium | large-v3
```

**Cualquier servicio es intercambiable por una variable.** Los contenedores de la
app resuelven sus dependencias por nombre de red, y cada una tiene su
`*_INTERNAL` para apuntarla a otra parte sin tocar código:

| Variable | Qué reemplaza |
|---|---|
| `DATABASE_URL_INTERNAL` | Postgres por uno gestionado |
| `S3_ENDPOINT_INTERNAL` | Garage por R2, B2 o S3 |
| `DM_CLASSIFY_URL_INTERNAL` · `DM_EMBED_URL_INTERNAL` | Ollama por una pasarela o un proveedor |
| `DM_SPEECH_URL_INTERNAL` | Whisper por cualquier servidor compatible |
| `DM_DOCUMENTS_URL_INTERNAL` · `DM_OCR_URL_INTERNAL` | los carriles por otros |
| `DM_VISION_BACKEND` | `ocr` · `anthropic` · `openai` · `none` |
| `DM_BACKUP_REPOSITORY` | Nextcloud por B2, R2 o S3 |

**El modelo de Whisper importa más que el motor.** En español `base` da 18,4% de
WER y `small` 9,7%. Con 18% se destrozan justo los nombres propios y los números
—lo único que uno guarda—, así que el compose usa `small`. Medido acá dictando un
teléfono de ocho dígitos: `tiny` se comió uno, `small` los transcribió todos.

Los servicios publican en `127.0.0.1`, no en `0.0.0.0`: procesan documentos
médicos y financieros y no tienen por qué ser alcanzables desde fuera del host.

## El respaldo

Cifrado en origen, off-site, y **por dueño**: no se respalda "el sistema", se respalda a
una persona.

```bash
npm run backup -- run                          # exporta lo tuyo y lo manda
npm run backup -- verify                       # lo restaura de verdad
npm run backup -- status                       # el destino, cuándo corrió, qué falta
npm run backup -- snapshots
npm run backup -- restore latest ./out
npm run backup -- forget                       # retención, y donde un purge se hace real
```

Con `dm` en el PATH es `dm backup run`, igual que todo lo demás.

### La dirección va en la base; la llave, no

El destino se configura una vez y queda **en la tabla `backup_config`, por dueño**:

```bash
# un Nextcloud por WebDAV
npm run backup -- set rclone:nc:deiz-memory \
  --webdav-url https://cloud.tu-dominio/remote.php/dav/files/<usuario>/ \
  --webdav-user <usuario>

# o cualquier cosa que restic alcance solo
npm run backup -- set b2:bucket:ruta
```

La URL y el usuario **no son secretos** y viven ahí junto al repositorio: son lo mismo que
el repositorio, y tenerlos en variables de entorno era una inconsistencia. Cada dueño
puede tener su propio Nextcloud sin tocar configuración del host.

Las **llaves** siguen fuera de la base, en `.env.local`, y son dos cosas distintas:

```bash
# .env.local
DM_BACKUP_PASSPHRASE=...            # descifra el archivo. La guardas TÚ
DM_BACKUP_WEBDAV_PASS=...           # abre el destino (contraseña de aplicación)
```

Con varios dueños, ambas aceptan sufijo: `DM_BACKUP_PASSPHRASE_<8 hex del id>`.

**Por qué la passphrase no puede ir en la tabla.** Cifrar es ceremonia cuando la llave
está al lado de la cerradura. Guardarla en la base significa que un host robado entrega
un respaldo off-site legible — que es exactamente lo que el off-site existe para
sobrevivir. La credencial del WebDAV es más benigna: si se filtra, alguien puede escribir
en tu carpeta, pero lo que hay ahí sigue cifrado.

`status` no puede mostrar una llave, así que dice si falta, **nombrando la variable**:

```
destino     rclone:nc:deiz-memory
transporte  webdav  https://cloud.dahub.casa/remote.php/dav/files/deiz-memory/ (deiz-memory)
último      2026-09-09 15:46 · ok
verificado  2026-09-09 15:46
secretos    FALTAN: DM_BACKUP_PASSPHRASE
```

La contraseña sale de **Ajustes → Seguridad → Crear nueva contraseña de aplicación**: es
revocable sin tocar tu cuenta. Y la URL es el endpoint WebDAV completo — si le pasas la
del navegador, `set` la rechaza ahí mismo en vez de fallar como un error de autenticación
opaco tres horas después.

### Qué se copia, y por qué el blob no basta

El blob es lo irreemplazable del archivo; la base es lo irreemplazable **tuyo**. Tu nota
no está en ningún blob, ni los dominios que creaste, ni las correcciones a un hecho, ni
las identidades vinculadas, ni el log de auditoría. Van en el mismo snapshot.

**Y lo produce el core, no un script.** La base sale como export lógico tabla por tabla
con `where owner_id`, y los blobs se enumeran desde `memories` —no del bucket— porque
`blobs` no tiene dueño: dedupear por contenido y particionar por dueño se excluyen, así
que la pertenencia solo se lee por el join con las memorias que lo referencian. Si ese
filtro viviera en bash sería el único lugar del sistema donde la regla dura 9 no la
sostiene el código.

Dos consecuencias que se ven en los tests: el respaldo de uno **no trae ni una fila** del
otro, y un archivo que dos dueños comparten **viaja en los dos**, porque cada respaldo
tiene que restaurar solo.

### `verify` restaura, no revisa metadatos

Un respaldo que no se restauró no existe:

1. `restic check` sobre la estructura del repositorio.
2. Restaura el último snapshot a un directorio temporal.
3. **Re-hashea cada blob** y comprueba que ninguna memoria referencie uno que no viajó.
   Lo primero sale gratis porque el nombre del archivo *es* su sha256; lo segundo es el
   modo de falla propio de un export filtrado: la fila queda y el archivo no.
4. **Carga el export** en una base desechable creada desde las migraciones y cuenta las
   filas ahí. Eso atrapa lo que un chequeo de formato no ve: los vectores y los `jsonb`,
   que son justo lo que un import ingenuo rompe.

```
✓ 15 blobs re-hasheados y con su referencia
✓ owners 1 · domains 8 · fact_types 2 · blobs 15 · memories 16 · memory_chunks 458 · facts 3 · channel_identities 2 · audit_log 6

✓ el respaldo restaura. Eso es lo único que lo hace existir.
```

### Llegar a un Nextcloud que no publica puertos

Si el destino está en una red privada —un Nextcloud casero detrás de Tailscale, sin un
solo puerto abierto a internet— el contenedor **se une al tailnet él mismo**:

```bash
# .env.local
TS_AUTHKEY=tskey-auth-...           # reusable Y efímera. Las dos cosas
TS_HOSTNAME=deiz-memory-backup
```

**Reusable y efímera, o falla en el segundo respaldo.** Una llave de un solo uso se
consume en la primera corrida y la siguiente muere con `invalid key`, que no se parece en
nada a lo que pasó. Efímera es lo que hace que el nodo desaparezca al terminar en vez de
dejar una máquina muerta en el tailnet por cada respaldo que tomaste.

Arranca `tailscaled` en modo userspace —sin `NET_ADMIN` ni `/dev/net/tun`— y apunta
restic y rclone a su proxy de salida. No depende del ruteo del host, y eso es lo que
importa: **en Docker Desktop sobre macOS un contenedor no alcanza la LAN del host ni al
host**, así que sin esto no hay URL que funcione. En un VPS Linux da igual, y con esto
las dos plataformas se comportan igual.

Un detalle que no es de red: **un respaldo en la misma casa que la máquina respaldada no
es off-site.** Protege contra un disco muerto, que es real, pero el riesgo que justifica
todo esto es el incendio y el robo, y esos se llevan las dos cosas juntas. El Pi de tu
casa es off-site de un VPS; no lo es de tu escritorio.

### Dos cosas que no promete

**No corre solo.** Es on-demand y nada más: no hay cron ni aviso, porque el sistema nunca
actúa por su cuenta. Lo que evita que se te olvide es que **`dm doctor` reporta la edad
del último respaldo**, y después de una semana deja de contar como verde:

```
· respaldo      configurado en rclone:nc:deiz-memory, nunca corrió
✓ respaldo      2026-09-09 (hoy) · verificado 2026-09-09
✗ respaldo      2026-08-02 (hace 38 días) · NUNCA verificado
```

Un respaldo viejo se ve idéntico a uno sano desde cualquier otro ángulo, así que la fecha
tiene que estar donde ya miras.

**`purge` borra del sistema, no del pasado.** Un blob purgado sigue en los snapshots
viejos hasta que caducan — es la contrapartida del versionado, porque lo que te salva de
un borrado accidental es lo mismo que retiene uno deliberado. `forget` es donde se
cierra.

## Tests

```bash
npm test                 # las tres capas
npm run test:unit        # sin Docker
npm run test:integration # core contra Postgres, Garage y los servicios reales
npm run test:cli         # levanta el binario, y el worker, como una persona
```

**No hay stack de pruebas aparte.** Se usan los mismos contenedores; lo único que se
aísla es lo que destruyen: la base `deiz_memory_test` y el bucket `deiz-memory-test`.

Ese aislamiento no es cosmético: `reset()` hace `truncate ... cascade` en cada test.
Apuntado a tu base, borra todo lo que has guardado — por eso vive en
`tests/helpers/env.ts` y no en una variable suelta. Los tests del CLI corren **sin
clasificador**: desde que la tubería clasifica sola, cada captura llamaba a Ollama de
verdad y veinte en paralelo contra un modelo que atiende de a uno reventaba el timeout.

## Estructura

```
src/core/         operaciones tipadas. No sabe que existe un CLI.
  ops/            capture · search · list · show · lifecycle · reprocess · domains
  normalize/      lanes.ts (el router, lógica pura) · run.ts
  classify/       prompt armado en runtime · validación de lo que devuelve
  recall/         chunk · index-chunks · retrieve · answer · grounding
  facts/          registry (los tipos son data) · extract · values · query
  channel/        el puerto del canal: capacidades declaradas (§7.1)
  router/         los verbos de §5. intent y actions son puros
  ports.ts        BlobStore · Clock · Db · Ingest · Converter · Classifier · Embedder
src/adapters/     cli · db/postgres · storage/s3 · normalize · classify · queue · chat
src/adapters/backup/  fs (el export como directorio) · restic (el transporte)
services/         los carriles, como contenedores
migrations/       SQL plano, aplicado en orden
scripts/          up · garage-init. Bash, no orquestador
```

El core devuelve datos y nunca texto formateado; toda operación recibe un actor; y las
confirmaciones son datos, no diálogos — el core devuelve `requires_confirmation` y quien
llama decide cómo pedirla. Eso es lo que permite que entre otro canal sin tocar `core/`.

La prosa vive en dos archivos y solo dos: `adapters/cli/format.ts` y
`adapters/chat/present.ts`.
