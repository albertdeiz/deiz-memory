# deiz-memory

Memoria personal externa, accesible por chat. Le mandas un archivo (foto, audio, PDF,
documento) y después le preguntas en lenguaje natural.

**Frase de una línea:** _un segundo cerebro con interfaz de conversación, optimizado
para devolverte con evidencia lo que guardaste, en el momento en que lo necesitas._

Este documento describe **el sistema que existe**. Lo que se pensó y no se construyó no
está acá; vive en el historial de git, que es donde corresponde.

---

## 1. Problema real que resuelve

No es "no tengo dónde guardar cosas". Es:

1. **Costo de captura alto** → si guardar cuesta más de 5 segundos, no guardas. Termina
   todo en fotos del carrete, correos y cajones.
2. **Recuperación imposible bajo presión** → el dato existe (la póliza, la receta, el
   número de emergencia) pero encontrarlo requiere 10 minutos y calma. Justo lo que no
   tienes cuando lo necesitas.
3. **Datos que caducan sin avisar** → seguros, licencias, recetas, garantías. El riesgo
   no es solo olvidarlos: es **consultarlos y recibir el dato viejo** sin darte cuenta.

Todo lo que se diseñe acá se justifica contra uno de esos tres.

## 2. No-objetivos

- No es un gestor de archivos ni un Drive con chat encima.
- No es Notion, ni un note-taking app, ni un CRM.
- No reemplaza el documento original (siempre se guarda el original y se cita).
- **Solo chat.** No hay web, no hay app que instalar. La accesibilidad inmediata es el
  producto; cualquier paso extra mata la captura (§6.1).
- No se borra nada salvo `purge`, que es explícito y auditado (§14.1).
- No da consejo médico, legal ni tributario. Devuelve **lo que tú guardaste**.
- **Sin recordatorios, notificaciones proactivas ni agenda.** El bot responde cuando le
  hablas; nunca inicia conversación. Lo sostiene el tipo `Turn`, no la buena voluntad.

## 3. Principios de diseño

Restricciones duras, no aspiraciones:

1. **Captura sin fricción.** Mandar un archivo nunca requiere elegir categoría, etiqueta
   ni carpeta. Se manda y listo. Clasificar es problema del sistema.
2. **Nunca inventar.** Toda respuesta factual cita la memoria de origen, y **la cita se
   verifica en código**: sin ella, la prosa se descarta. Si no está guardado, la
   respuesta correcta es _"no lo tengo"_.
3. **El tiempo es de primera clase.** Todo dato tiene fecha de captura y fecha del hecho.
   Las listas por categoría ordenan por cuándo pasó, no por cuándo lo guardaste.
4. **Confirmación diferida.** Si el sistema duda, guarda igual y deja la duda en la
   bandeja de revisión (`dm review`, `/review`). Nunca bloquea la captura con preguntas.
5. **Respuesta útil > respuesta completa.** El dato y su fuente, no un resumen de 400
   palabras.
6. **El original es sagrado.** El blob crudo nunca se borra ni se sobreescribe. Todo lo
   derivado —texto, trozos, vectores, clasificación— es regenerable desde él.
7. **Tus categorías son tuyas y son data.** Los dominios son filas editables, nunca un
   enum en el código. Agregar uno no puede requerir un deploy (§9).

## 4. Modelo de datos

Dos objetos, y no hace falta un tercero.

### `Memory` — la unidad de captura

```
id
owner_id            la persona dueña. Permanente, en TODA tabla
source              telegram | cli | manual
captured_at         cuándo entró al sistema
occurred_at         cuándo pasó el hecho (lo pone el clasificador si falta)
blob_sha256         → tabla blobs. Null si es solo nota
note                lo que escribiste tú. NUNCA se regenera ni se pisa
normalized_text     lo extraído del archivo. Regenerable desde el blob
normalization_lane  qué carril lo leyó (§8.1), para poder reprocesar sin adivinar
domain_id           → tabla domains (§9). Nunca un enum en código
tags                etiquetas libres, para lo que cruza dominios
title               título corto autogenerado
domain_confidence   qué tan segura fue la clasificación
status              raw | normalized | needs_review | classified
hidden              oculta de resultados, pero no borrada
```

**`note` y `normalized_text` son columnas distintas a propósito.** Lo tuyo y lo derivado
del archivo no se mezclan: cuando llegaban juntos, la primera transcripción se comía la
nota.

### `Domain` — categoría editable en runtime

```
id            estable e inmutable — la identidad real
slug          salud            (para comandos: /salud)
label         Salud            (para mostrar; renombrable sin romper nada)
description   "consultas, recetas, exámenes, Isapre, bonos"
aliases       ["médico", "doctor"]
active        true | false
```

**`description` no es documentación: es el prompt** (§9).

### `Fact` — el dato duro, extraído una vez

Una búsqueda ordena documentos por parecido. Para *"¿cuánto es mi deducible?"* eso es
pedirle a la herramienta equivocada: la respuesta es un número exacto, no un ranking.

**Medido.** Los 80 trozos de una póliza de auto tratan, todos, de seguros de auto — y la
pregunta también. Los ocho que la recuperación traía puntuaban entre 1,62 y 1,77: un 9%
de diferencia para decidir cuál responde. El vector hacía bien su trabajo; el trabajo era
el equivocado.

```
memory_id       de dónde salió. Obligatorio: sin cita no hay respuesta (regla dura 1)
type_id         → fact_types
payload         los campos, tipados según el registro
identity        copia del campo que distingue dos instancias (la patente, la tarjeta)
valid_from
valid_until     lo que hace posible responder "vencido" en vez de responder mal
superseded_by   la póliza nueva no borra a la vieja: la supera
confidence
```

**Cada valor pasa por grounding antes de guardarse** — el mismo principio que verifica las
cifras de una respuesta (§6). Un campo que no aparece en el documento se descarta. Eso
convierte la extracción en algo verificable en vez de confiado al modelo.

**Y se comprueba bajo qué rótulo aparece, no solo que aparezca.** Una cartola trae
`MONTO FACTURADO A PAGAR (PERÍODO ANTERIOR) $886.568` y `MONTO TOTAL FACTURADO A PAGAR
$1.747.885`: las dos cifras están en el documento, las dos pasaban el chequeo, y la
respuesta era la del mes pasado. Por eso un campo puede declarar `near` y `notNear`, y
`notNear` es la mitad indispensable — el rótulo del señuelo **contiene** al del bueno, así
que lo que los separa no es lo que tienen sino lo que sobra. El contexto se corta en el
salto de línea, porque el rótulo de un valor es lo que está a su izquierda en su fila.

**Y un valor no se lleva su propio rótulo.** Sobre la póliza real el modelo devolvió
`numero` como `"póliza N°BP9344586"`: el número con su etiqueta pegada. Pasaba **todos**
los chequeos, porque es literalmente lo que dice el documento y eso es justo lo que
grounding exige — el dato correcto y el dato sucio son indistinguibles para una
verificación que solo pregunta "¿aparece?". El daño aparece después: otro documento
escribió la misma póliza como `BP-9344586` y dejaron de parecer la misma.

Pedirle al prompt "el valor, no el rótulo" es de las instrucciones que un modelo chico
cumple *casi* siempre. Así que se despoja en código, con el vocabulario que el campo ya
declara —su `label`, sus `aliases`, sus anclas— probando **la frase completa antes que
las palabras sueltas**: `número de póliza` se atasca en `de`, que es demasiado corto para
quitarlo sin riesgo, y bajar ese límite haría que un rótulo se comiera valores como
`DE-4471`. Si despojar se lleva todo, es que no había rótulo: se devuelve el original.

**Y el extractor no ve "los primeros N caracteres", ve las líneas que importan.** Ese
recorte decidía la respuesta por accidente: el monto correcto estaba en el carácter 6157 y
el corte era 6000. Ciento cincuenta y siete caracteres separaban una respuesta buena de
una mentira con formato. Ahora se le manda la cabecera **más cada línea que trae un rótulo
declarado**.

### `FactType` — el registro, también editable

Un tipo no es un enum, por la misma razón que un dominio no lo es (§3.7): agregar uno no
puede requerir un deploy.

```
slug            poliza_auto
kind            estado | periodo        ← ver abajo, no es un detalle
description     para qué documentos aplica; el modelo la lee
domain_slug     de qué categoría intentar extraer
fields          [{ name, kind, label, aliases[] }]
identity_field  cuál de los campos distingue dos instancias
active
```

El `kind` de cada campo es un conjunto cerrado y chico —`text · number · uf · money ·
date · phone`— porque hace dos trabajos: describe el campo en el prompt y **valida** lo
que vuelve.

`aliases` es lo que conecta una pregunta con un campo **sin preguntarle a un modelo**: si
una palabra de la pregunta calza con un alias, hay camino de hecho. Determinista, como
todo lo que decide algo acá. El calce es **por raíz y por prefijo** —`paga` y `pagar` son
lo mismo, `vence` llega a `vencimiento`— porque enumerar conjugaciones al definir un tipo
sería pedirle a quien lo escribe que se acuerde de conjugar.

#### Estado y período no son lo mismo, y confundirlos corrompe datos

Un tipo `estado` tiene **uno vigente**: la póliza nueva sucede a la vieja, que sigue
existiendo y sigue respondiendo *"¿qué cubría el año pasado?"*. Un tipo `periodo`
**coexiste**: la cartola de agosto no reemplaza a la de julio — la de julio sigue siendo
la verdad sobre julio, para siempre.

```
poliza_auto (estado)                tarjeta_credito (periodo)
────────────────────                ─────────────────────────
2023 ──────✕ superada               julio      ← sigue siendo verdad
2026 ──────● vigente                agosto     ← sigue siendo verdad
"¿cuál es mi deducible?"            "¿cuánto pagué en julio?"
 → una respuesta                     → la de julio, no la última
```

Sin esta distinción el sistema marcaría la cartola de julio como superada por la de
agosto, que es **peor que no tener el dato**. Por eso el `kind` va en el registro y no se
infiere.

**La supersesión distingue sucesión de conflicto.** En un tipo `estado`, mismo tipo y
misma identidad con vigencias que **no** se solapan: la posterior supera a la anterior. Si
**sí** se solapan, no es sucesión sino conflicto, y se muestran las dos (regla dura 3).
En un tipo `periodo` no hay supersesión, y punto.

#### Lo que NO es un Fact

Esa cartola trae **53 líneas de transacción**. Eso no es un `payload`: es una tabla, y
*"¿cuánto gasté en delivery?"* necesita sumar filas, no leer un campo.

Queda fuera **por diseño, no por fase**: agregar gastos por comercio es una app de
finanzas, y §2 dice que esto no es eso. La línea honesta es responder *"tienes que pagar
$886.568 antes del 7 de septiembre"* y no *"gastaste 12% más que el mes pasado"*.

### Las otras tablas

`owners` · `blobs` (direccionables por sha256) · `memory_chunks` (trozos con su vector) ·
`channel_identities` y `pairing_codes` (§10) · `chat_sessions` (el estado de la
conversación) · `audit_log` (qué se purgó).

## 5. Los verbos del router

| Verbo | Cuándo | Camino |
|---|---|---|
| **Capturar** | llega un archivo, o escribes `/capture` | ingest → normalizar → indexar → clasificar |
| **Recordar** | cualquier otro texto, o `/search` / `/ask` | recuperación + citación |
| **Acción** | un botón, o su palabra escrita | sobre la última lista mostrada |

**Guardar es explícito; escribir es preguntar.** Lo que uno escribe en una conversación
es, casi siempre, algo que le está preguntando a alguien. Adivinarlo con una heurística
—"¿empieza con *cuál*?"— acertaba a medias y dejaba preguntas convertidas en memorias,
que después hay que ocultar a mano.

El principio de §3.1 se sostiene donde importa: mandar un archivo sigue siendo un gesto,
sin comando ni categoría. Y no perder nada también: si la consulta no encuentra nada, la
respuesta ofrece guardar ese texto tal cual, a un toque.

## 6. Recuperación

**Dos modos, y el orden importa.**

**Modo hecho** — si una palabra de la pregunta calza con el alias de un campo de un
`FactType`, la respuesta sale de una consulta SQL sobre `facts`: exacta, con su vigencia y
con el `memory_id` que la respalda. No hay ranking que pueda fallar.

**Modo contexto** — todo lo demás, que es la mayoría: recuperación híbrida sobre los
trozos. Es lo correcto cuando no hay schema posible (*"¿qué me recetaron en marzo?"*).

El modo hecho se intenta primero y **cae al modo contexto sin ruido** si no hay un hecho
que responda. Nunca al revés: una búsqueda que ordena 458 trozos no puede ganarle a una
fila que dice el número.

### Modo contexto: la recuperación híbrida

- **Filtro estructurado primero** — dominio y ventana de fechas recortan el universo.
  Es lo que de verdad baja el ruido.
- **Full-text** sobre los trozos: preciso para lo que se escribe igual — un RUT, una
  patente, un número de póliza.
- **Semejanza** con vectores locales: rescata las preguntas escritas con otras palabras
  que las del documento.

Se fusionan normalizando cada lista contra su propio máximo, porque `ts_rank` y la
similitud coseno viven en escalas distintas. Un trozo que aparece en las dos sube.

**Se indexa por trozos, no por documento.** Una póliza de 80 mil caracteres promediada en
un vector no se parece a nada en particular. Y cada trozo se embebe solo, sin anteponerle
el título: si los ochenta empiezan con "póliza de auto BCI", los ochenta se parecen entre
sí y ninguno destaca.

**Una pregunta no se busca con AND.** `/search poliza auto` pide las dos cosas; una
pregunta no — el párrafo que responde dice "deducible" y no dice "auto". Medido sobre una
póliza real: cero resultados con AND, ocho con la palabra sola.

**Pero el OR tampoco puede decidir el orden.** Rankear con todos los términos le da
crédito completo a las palabras que solo dicen *de qué documento* hablamos, y esas están
en todas sus páginas. Medido: a "¿cuánto es mi deducible en el seguro de mi vehículo?",
`seguro` aparece en el 16% de los trozos y `vehiculo` en el 15%, contra el 4% de
`deducible` — así que el único trozo con la cifra quedaba **séptimo** y el modelo solo
leía los primeros. Sin cifra delante, no responder es lo correcto, y eso hacía.

Se busca con todos los términos y **se rankea solo con los raros**: los comunes suman
recall, que es para lo que sirven, pero dejan de ordenar. El umbral es relativo al
término más raro de la propia pregunta, para que funcione igual con 400 trozos que con 40.

**Ninguna cifra que no esté en lo que leyó.** La verificación de cita comprueba que el
documento citado exista; no que el número venga de ahí. Ese hueco dejaba pasar el peor
caso —cita válida, cifra inventada, más creíble que una respuesta sin cita—, y pasó de
verdad: "5 UF" con ninguno de los ocho pasajes conteniendo ese número. Ahora toda cifra
de la prosa tiene que aparecer en los pasajes leídos, normalizando la escritura chilena
(`UF 3,0` y `3 UF` son el mismo dato) y **comprobando también la unidad**, que es lo que
atrapa `$89.990` redactado como `89.990 UF`. Si no calza, se descarta la prosa y quedan
las fuentes.

Toda respuesta trae: el dato, su fecha, y el id para abrir el original.

### 6.1 Solo chat — y cómo se paga esa decisión

La única app que hace falta es la que ya usas todos los días. El costo real: **el chat es
pésimo para explorar 40 resultados.** No se resuelve con una web:

- **Paginación** — 5 por vez, botón `more`. Nunca un muro de texto.
- **Refinamiento conversacional** — "de esos, solo los de 2025" en vez de scroll.
- **Dos botones por resultado** — `datos` y `archivo`, en la misma fila. Bajar un
  documento no puede costar dos toques y una pantalla intermedia.

**Las acciones son un patrón, no una decisión por pantalla.** Todo listado que entrega el
bot —búsqueda, categoría, bandeja de revisión, fuentes de una respuesta— numera igual y
ofrece lo mismo, y registra sus ids por el mismo camino. Cuando cada uno armaba los
suyos, preguntar ofrecía solo `view` mientras buscar ofrecía `view` y `open`.

## 7. Arquitectura

Monolito. Nada de microservicios para un sistema de un usuario.

```
Telegram ──> Channel Adapter ──> Ingest Queue (ack inmediato)
             (identidad + capacidades)
                                      │
                          ┌───────────┴───────────┐
                          ▼                       ▼
                    Normalizer              (blob store)
              markitdown / OCR / Whisper
                          │
                          ▼
                  Trozos + vectores
                          │
                          ▼
              Clasificador (dominio, título, fecha)
                 ▲ lee los dominios activos desde la DB
                          │
                  ┌───────┴────────┐
                  ▼                ▼
              Memories        Bandeja de revisión
                  │
                  ▼
            Postgres + pgvector ◄──── Retriever
```

**Todo corre en contenedores, la app incluida.** `postgres` · `garage` ·
`documents` · `ocr` · `whisper` · `ollama` · `app-worker` · `app-bot` · `backup`.
Nada necesita Node en el host: la única dependencia para usar el sistema es
Docker.

El core sigue siendo **un módulo, no seis servicios**. Partirlo en microservicios
para un sistema de un dueño multiplicaría la superficie operativa sin comprar
nada; lo que sí compra algo es que el despliegue sea uniforme y que cada
dependencia se pueda reemplazar por una variable de entorno.

**Puntos no negociables:**
- El adapter de canal está detrás de una interfaz. Telegram hoy, otro después, sin tocar
  el core.
- **`owner_id` en todas las tablas.** Meter tenancy a posteriori es una migración brutal.
- La ingesta es asíncrona. El acuse llega en <1s; normalizar, indexar y clasificar corren
  después. Nunca hacer esperar al usuario por un modelo.
- Todo lo derivado es re-ejecutable desde el blob original.
- **El prompt del clasificador se construye en runtime** desde la tabla `domains`.
- **Un módulo único habla con el storage.** Cambiar de proveedor es una variable.
- **Cada servicio es intercambiable por una URL.** Las dependencias de los
  contenedores de la app se resuelven por nombre de red, y cada una tiene su
  variable `*_INTERNAL` para apuntarla a un servicio gestionado sin tocar código.

### 7.1 El contrato del adapter de canal

Lo importante no es enviar y recibir: es **declarar capacidades**. El core nunca asume
que existen los botones de Telegram ni su límite de archivo.

```ts
export interface Capabilities {
  maxUploadBytes: number;      // lo que el bot puede MANDAR
  maxDownloadBytes: number;    // lo que puede BAJAR (Telegram: 20 MB, y es un muro)
  supportsButtons: boolean;
  supportsRichFormatting: boolean;
  canInitiate: boolean;        // declarado; nadie lo lee, a propósito
}

/**
 * Un turno: llega un mensaje, se responde, se cierra. `reply()` deja de servir
 * cuando el handler retorna, y eso no es prolijidad — es §2 hecha tipo. Sin un
 * `send()` suelto en el puerto, el bot no tiene *cómo* iniciar conversación.
 */
export interface Turn {
  readonly incoming: Incoming;
  readonly caps: Capabilities;
  reply(r: Reply): Promise<void>;
}
```

**Cómo degrada.** Sin botones → la misma acción escrita: el botón lleva `more` y la
persona escribe `more`. El verbo es idéntico en los dos caminos; lo que cambia es **a qué
apunta**, y tiene que cambiar: el botón viaja con el id de la memoria (`view:a3f2c1d0`) y
lo escrito con el número de la lista (`view:2`). No son dos vocabularios que haya que
mantener sincronizados —es un verbo con dos formas de direccionar, la misma que el CLI ya
acepta cuando `dm show a3f2` resuelve por prefijo.

Cada forma existe porque la otra no sirve en su lugar. **El historial de un chat es
persistente y tocable:** alguien sube tres días después y aprieta el botón de una lista
vieja, y un índice relativo se resuelve contra la lista *actual* — no falla, abre otro
documento. Es el mismo fallo silencioso que §11 registra, y con el id adentro el botón
viejo sigue siendo correcto para siempre. Al revés, nadie va a teclear ocho hex en un
teléfono: por eso la rama sin botones se queda con el número, que es lo único que un
humano puede decir.

**El estado sigue donde estaba.** El cursor de `more`, el texto que ofrece `save` y la
operación que espera un `yes` viven en `chat_sessions`, no en el payload. Meter el id en
el botón le quita estado a tres acciones de ocho; las otras cinco lo necesitan igual, así
que la decisión nunca fue "con o sin estado" sino cuánto. `dm chat` declara
`supportsButtons: false`, así que cada corrida de los tests ejercita la rama degradada.

**Descarga sobre el límite → negativa honesta, y no se crea la memoria.** Una fila
apuntando a un blob que no existe es peor que no tener la fila.

## 8. Stack

| Capa | Elección | Por qué |
|---|---|---|
| Canal | Telegram Bot API + **grammY** | gratis, sin aprobación, soporta fotos/audio/docs/PDF nativo |
| Runtime | TypeScript + Node, en contenedor | nada corre en el host |
| Build | esbuild | los imports son relativos y sin extensión, así que `tsc` solo verifica tipos y el artefacto lo produce el bundler |
| DB | Postgres + pgvector | estructurado, full-text y vectores en un motor. Una DB, un backup |
| Cola | pg-boss | sin Redis extra |
| Blobs | **Garage** self-hosted (API S3), direccionable por contenido | §14.1 |
| Clasificar y redactar | **Ollama** local (`qwen2.5:3b`) | nada sale del host, no cuesta por documento |
| Embeddings | **Ollama** local (`nomic-embed-text`, 768d) | ídem |
| Documentos → texto | **markitdown** en su contenedor | PDF/docx/xlsx/html/csv → Markdown con estructura |
| Fotos y escaneos | **RapidOCR** (PP-OCR sobre ONNXRuntime) | §8.1 |
| Audio | **Whisper** en contenedor | notas de voz |
| Respaldo | **restic** sobre **rclone** | cifra en origen, versiona y deduplica; rclone es solo transporte (§14.3) |
| Red al destino | **Tailscale** en modo userspace | alcanza un destino que no publica puertos, sin depender del ruteo del host |

Los tres carriles son **servicios en contenedores**, detrás del mismo puerto `Converter`.
El motor de cada uno se cambia con una variable de entorno.

### 8.1 Normalización: un router de carriles

**markitdown no es un motor de OCR.** Con PDF usa pdfminer: extrae solo la capa de texto,
así que un PDF escaneado devuelve vacío. Por eso el Normalizer es un router:

| Entrada | Carril | Herramienta |
|---|---|---|
| PDF con capa de texto, docx, xlsx, pptx, html, csv | A — documento | markitdown |
| PDF escaneado (capa de texto < 100 chars) | B — visual | OCR, página por página |
| Foto (receta, boleta, carnet, patente) | B — visual | OCR |
| Nota de voz | C — audio | Whisper |

**Regla de fallback:** siempre se intenta A primero —barato, determinista, reproducible—
y se cae a B si el resultado viene pobre. El carril usado queda en la fila, para poder
reprocesar sin adivinar qué pasó.

**El carril B es OCR clásico, no un LLM multimodal.** En documentos impresos el OCR gana
justo donde importa —números de póliza, RUT, montos: cadenas que no se adivinan por
contexto y donde los modelos chicos fallan—, y es gratis y reproducible. El carril
multimodal sigue disponible (`DM_VISION_BACKEND=anthropic|openai`) y es el correcto para
manuscrito, que es lo que el OCR no puede leer.

**El HEIC del iPhone se transcodifica a JPEG** antes del OCR. TIFF sigue sin carril.

## 9. Dominios — dinámicos por diseño

Un dominio **no es un enum**: es una fila editable desde el chat.

**`description` es el prompt, y está medido.** Sobre 170 documentos reales, con la
descripción de "Hogar" hablando solo de garantías y gastos comunes, el manual de la
alarma quedó **sin dominio y con 0,95 de confianza** — el modelo tenía razón, no calzaba.
Ampliar la descripción lo movió a `hogar` con 0,9, **sin tocar una línea de código**. El
clasificador se arma en runtime concatenando las descripciones de los dominios activos.

**El `id` es la identidad, nunca el nombre.** Renombrar "vehículo" a "auto" cambia un
`label`; ninguna Memory se entera.

| Operación | Qué hace |
|---|---|
| `/domains` | lista los activos, con cuántas memorias tiene cada uno |
| `/create` | pide una descripción de una línea; avisa si se solapa con otra |
| `/describe`, `/rename` | no tocan las memorias existentes |
| `/archive` | deja de proponerse al clasificar; sus memorias siguen buscándose |
| `/merge` | mueve todas las memorias de A a B y archiva A |

**No hay borrado duro.** Borrar un dominio con memorias adentro las dejaría huérfanas.
Las dos operaciones honestas son archivar y fusionar.

**Cómo nace uno nuevo.** Explícito (`/create`), o **emergente**: `/propose` junta las
memorias que no calzan bien en ningún dominio activo y sugiere uno. El punto del segundo
camino es que no tienes que anticipar tus propias categorías.

**El guardrail: la proliferación es el modo de falla.** Crear libremente termina en 40
dominios con la mitad solapados. Tres frenos: **el bot propone, nunca crea solo**; antes
de crear **chequea solapamiento** contra las descripciones existentes; y lo que cruza
dominios va con **un dominio primario + tags libres**.

**Semilla (contexto Chile):** Salud · Seguros · Vehículo · Documentos · Finanzas ·
Trabajo · Hogar · Personas. Editables desde el día uno.

## 10. Identidad y emparejamiento

**No hay cuentas, ni contraseñas, ni verificación de correo.** La identidad es el user id
del canal, que **no es falsificable** — por eso no hace falta allowlist ni cuarentena.

```
dm pair --bot <usuario>   →   link de un solo uso, 15 minutos
```

La otra persona lo abre, Telegram manda `/start <code>`, y queda vinculada. Sin instalar
nada. Es probablemente el mayor beneficio práctico de ser solo chat.

**Y es una propiedad estructural, no una promesa:** `route()` exige un `Actor`. Sin
identidad vinculada no hay Actor, y sin Actor no existe el camino para llamar a nada. La
regla dura 9 deja de depender de que alguien se acuerde de un `WHERE`.

Un id desconocido recibe **una** línea seca y después silencio 10 minutos.

## 11. Comandos

**Uno solo por operación, en inglés, con el nombre del CLI.** Dos formas de decir lo
mismo es una que hay que mantener sincronizada con la otra para siempre.

### Chat

```
/capture <texto>     guarda eso como memoria    (un archivo se guarda solo)
/ask <pregunta>      responde citando la fuente
/search <algo>       lista lo que coincide, de a cinco
/pending             qué falta por leer
/review              lo que quedó dudoso
/domains             tus categorías · /<slug> para ver una
/facts               los datos duros extraídos, con su vigencia
/create <n>: <desc>  ·  /describe <n>: <d>  ·  /rename <n> <nuevo>
/archive <n>         ·  /merge <a> <b>      ·  /propose
/help

view:N   los datos      open:N  el archivo     hide:N  sacar de resultados
more     página siguiente   save  guardar lo que buscaste   yes / no

view:<id>  las tres numeradas aceptan también el id — es lo que llevan los botones
```

**El número es de la última lista que viste; el id no depende de ninguna.** El registro
cuelga de la forma del `Outcome`, en un solo lugar, para que una lista nueva quede
cubierta sin que nadie se acuerde: cuando numerar y registrar vivían en archivos
distintos, `/documentos` ofrecía botones sin registrar los ids y `view:2` abría el segundo
de la búsqueda anterior. Los botones ya no dependen de ese registro —viajan con el id
(§7.1)—, y el número escrito sí, que es exactamente donde hace falta.

### Terminal

```
dm init · dm doctor · dm serve · dm worker · dm chat "<msg>"
dm capture <archivo> | --text "..." | -        --title --occurred --wait
dm ls · dm search · dm ask · dm show · dm open · dm in <categoría>
dm domains [create|edit|archive|merge|propose] · dm classify · dm index
dm facts [--all] · dm facts types · dm facts extract [id]
dm review · dm reprocess [--failed|--pending|--all|--lane|--wait]
dm backup [status|set <repo>|run|verify|snapshots|restore|forget]
dm mirror [status|set <ruta>|plan|run]
dm pair · dm identities
dm hide · dm unhide · dm purge <id> --yes
```

Globales: `--json` y `--actor <id>`. Salidas: `0` ok · `1` error · `2` requiere
confirmación · `3` no encontrado · `4` prohibido · `5` prefijo ambiguo.

**Lo que NO está en el chat es deliberado:** `purge` (irreversible, vive en la terminal
con auditoría — el chat solo oculta) y la mantención (`classify`, `index`, `reprocess`,
`worker`, `serve`).

## 12. Estado y límites conocidos

Construido y en verde: captura, los tres carriles, canal de chat, bandeja de revisión,
dominios dinámicos con clasificación local, preguntas en lenguaje natural con cita
verificada, y **datos tipados** (§4) para dos tipos semilla — `poliza_auto` (estado) y
`tarjeta_credito` (período). Y el **backup cifrado off-site** (§14.3), que era el único
riesgo irreversible abierto, y el **espejo legible** (§14.4). **386 tests.**

**El sistema se vació entero el 3 de septiembre de 2026** para empezar a poblarlo de
cero. No hay corpus histórico.

Lo que falta, con nombre:

- **El backup existe, pero solo cuenta si lo corres.** Es **on-demand y nada más**: no
  hay cron ni aviso, porque §2 dice que el sistema nunca actúa por su cuenta y eso vale
  también acá. Lo que cierra el hueco no es un temporizador sino que **`dm doctor`
  reporte la edad del último respaldo**: un respaldo viejo se ve idéntico a uno sano
  desde cualquier otro ángulo, así que la fecha tiene que estar donde uno ya mira.
  Después de una semana deja de contar como verde.
- **La semana de uso real.** Usarlo sin construir nada y ver qué falta de verdad.
- **TIFF sigue sin carril**, y un bot de Telegram **no puede bajar más de 20 MB**.
- **El modelo de 3B a veces se queda corto** al redactar. `DM_CLASSIFY_MODEL` lo cambia.
- **`grounding` valida que la cifra esté en el texto, no que responda tu pregunta.** Si
  la recuperación trae la sección equivocada, puede darte un número real de otra cosa.
  Para los datos que importan, el modo hecho (§6) esquiva el problema entero; para el
  resto sigue vigente.
- **Solo dos tipos de hecho.** Todo lo demás se responde buscando.

## 13. Reglas duras

Invariantes del producto:

1. Nunca responder un dato factual sin `memory_id` de respaldo. **Verificado en código.**
2. Nunca afirmar una cifra que no esté en los pasajes leídos. **Verificado en código.**
3. Si hay dos memorias en conflicto, mostrar ambas con fechas y decir que hay conflicto.
   Jamás elegir una en silencio.
4. Máximo **una** pregunta de aclaración por captura. El resto va a la bandeja.
5. Salud: devolver lo guardado, nunca interpretar ni recomendar.
6. Tributario: mostrar el comprobante guardado, nunca calcular ni interpretar normativa.
7. Nunca crear, renombrar, archivar ni fusionar una categoría sin confirmación explícita.
8. Confirmar antes de cualquier acción irreversible (fusionar, purgar).
9. Toda consulta va filtrada por dueño. Sin excepción, sin "modo admin".
10. Si el dato está **vencido o superado, decirlo antes del dato**. Nunca después, y
    nunca callado. Es la razón de ser de `valid_until` (§1.3): el riesgo no es olvidar un
    dato, es consultarlo y recibir el viejo sin darte cuenta.

## 14. Privacidad y seguridad

Esto guarda datos médicos y financieros. El modelo de amenaza, honesto:

- **Los chats de bot en Telegram NO son E2E.** Telegram puede leerlos. Hay que asumirlo
  conscientemente.
- **La IA es local.** Clasificación, embeddings y redacción corren en Ollama en el mismo
  host: no hay proveedor al que verificarle la retención.
- Secretos fuera del repo. Nada de PII en logs — se loguean ids, tamaños y estados.
- **Contraseñas y códigos 2FA: no se guardan.** Eso vive en un gestor real; acá solo se
  recuerda dónde está.
- **Aislamiento por dueño.** Toda query lleva ese filtro (regla dura 9).

### 14.1 Storage: el disco duro personal en la nube

**Append-only.** Corregir es agregar; ocultar es `hidden = true`.

Una excepción honesta: **`purge` existe**, para el caso real de haber subido algo que no
debía estar ahí. Es explícito, pide confirmación nombrando lo afectado, y queda en el log
de auditoría. Prometer "es imposible borrar" es una promesa que se rompe el día que la
necesitas.

**Blobs direccionables por contenido** (sha256): deduplicación gratis.

**Y por eso `blobs` es la única tabla sin `owner_id`** — este documento decía lo
contrario y estaba equivocado. La clave es `blobs/<aa>/<bb>/<sha256>`, sin dueño adelante,
porque dedupear por contenido y particionar por dueño son objetivos que se excluyen: si
el prefijo fuera del dueño, dos personas con el mismo PDF guardarían dos copias.

Con un dueño la diferencia no se nota. Con varios importa en dos lugares y hay que
tenerlos a la vista: **el respaldo por dueño no puede espejar el bucket** (§14.3), tiene
que enumerar desde `memories`; y `purge` solo borra el blob cuando **nadie más** lo
referencia, cuenta que hoy cruza dueños a propósito. Lo segundo es correcto para el
almacenamiento y es, en rigor, un canal lateral mínimo: A puede inferir que alguien más
tiene su mismo archivo porque el blob sobrevivió. Con un dueño no existe; se anota acá
para que exista la decisión el día que haya dos.

**Backend S3-compatible, siempre.** El código nunca habla con un proveedor concreto:
habla S3. Garage self-hosted es una decisión de despliegue, no de arquitectura — el día
que quieras R2, cambian tres variables.

### 14.2 Cifrado: solo donde los bytes salen del host

**Cifrar cada blob no compra nada acá.** La app, Garage y la clave viven en el mismo VPS:
quien entra al host se lleva los datos **y** la clave. Un cifrado cuya llave está al lado
de la cerradura es ceremonia.

**Lo único que sí compra algo es cifrar lo que sale del host:** el backup off-site (§12).
Su passphrase la guardas tú, se muestra una vez, y si la pierdes el respaldo es un
ladrillo.

Lo que de verdad mueve la aguja, y va antes: cifrado de disco del host, Postgres y Garage
**sin puerto expuesto a internet**, y un backup **restaurado al menos una vez**.

**Esto asume self-hosted, un dueño, un host.** Si eso cambia, el cálculo se invierte.

### 14.3 El backup: el blob no basta

§12 decía que todo se regenera desde el blob. Es falso justo donde importa: **tu nota
no está en ningún blob** (§4), y tampoco los dominios que creaste, las correcciones a
un hecho, las identidades vinculadas ni el log de auditoría. El blob es lo
irreemplazable *del archivo*; la base es lo irreemplazable *tuyo*. Se copian las dos, y
en el mismo snapshot, para que restaurar no sea reconciliar dos fechas.

**Un repositorio por dueño, y eso decide todo lo demás.** No se respalda "el sistema":
se respalda a una persona. Meter dos dueños en un snapshot sería darle a cada uno los
datos del otro en el momento de restaurar, que es precisamente lo que la regla dura 9
existe para impedir — y una restauración no es un lugar donde uno quiera descubrir que la
regla solo valía para las consultas.

**Por eso no se espeja el bucket ni se vuelca la base entera.** Las dos cosas son
operaciones "de todo", y acá no hay un todo que respaldar:

- **La base** sale como export lógico filtrado por dueño, tabla por tabla, y **lo produce
  el core, no un script**: si el `where owner_id` viviera en bash sería el único lugar del
  sistema donde la regla dura 9 no la sostiene el código. Es una operación tipada más, con
  su `Actor`, como cualquier otra.
- **Los blobs** se enumeran desde `memories` —`join blobs`, `where m.owner_id = $1`— y se
  bajan por el puerto `BlobStore` que ya existe. `blobs` no tiene dueño (§14.1), así que
  la pertenencia solo se puede leer desde las memorias que lo referencian.

Esto además abarata lo que antes era caro: se prepara **lo de ese dueño**, no una copia
del corpus completo, y `rclone` deja de ser la fuente para quedarse solo donde sirve —de
transporte de restic hacia el destino.

**Y el volumen de Garage no se toca.** `garagemeta` es una LMDB viva y copiarla en
caliente es una moneda al aire; todo sale por la API, que es la que sabe contestar.

**El destino es `restic` sobre `rclone`.** restic cifra en origen —la passphrase la
guardas tú, y si la pierdes el respaldo es un ladrillo—, deduplica y versiona. rclone es
solo el transporte, y habla WebDAV con Nextcloud igual que S3 con B2 o R2: cambiar de
destino es cambiar un remoto, no un diseño.

**Dónde vive la configuración, y dónde no.** La línea no es entre "config" y "secreto":
es entre **una dirección y una llave**.

Una dirección es data —el repositorio, la URL del WebDAV, el usuario, cuándo corrió— y no
le sirve a nadie que la lea. Va en la tabla, por dueño, y `dm backup status` la muestra.
Que la URL y el usuario vivieran en variables de entorno era una inconsistencia:
son exactamente lo mismo que el repositorio, que sí estaba en la tabla.

Una llave sí sirve a quien la lea, y las dos que hay **no son la misma cosa**:

- **La credencial del transporte** abre el destino. Si se filtra, alguien puede escribir en
  tu carpeta — pero lo que hay ahí sigue cifrado.
- **La passphrase descifra el archivo.** Es lo único que no puede estar en este host,
  porque el argumento entero de §14.2 es que cifrar es ceremonia cuando la llave está al
  lado de la cerradura. En la base, un host robado entrega un respaldo off-site legible:
  justo lo que el off-site existe para sobrevivir.

Las dos se resuelven **por dueño desde el entorno** —`DM_BACKUP_PASSPHRASE_<id>`, con
fallback al nombre pelado— y el sistema no las escribe nunca. Lo único que se puede decir
de ellas es si faltan, y `dm backup status` lo dice **nombrando la variable**, porque
"falta un secreto" no es accionable.

**Vacío cuenta como ausente, y eso fue un bug.** `??` cae con `null` y `undefined` pero no
con `''`, y una variable declarada sin valor es el estado normal de un `.env.local` a
medio llenar: `status` informaba la passphrase como presente y restic la habría aceptado.
Un respaldo cifrado con nada, reportado como configurado.

**El transporte es data, no columnas.** `transport` más un `transport_config` jsonb, por la
misma razón que un dominio es una fila y no un enum (§3.7): una columna `webdav_url` sería
peso muerto el día que el destino sea B2, y agregar los campos de B2 sería una migración.
`none` cubre todo lo que restic alcanza solo —B2, S3, R2, una ruta— y ahí las credenciales
son las variables estándar de restic y pasan sin tocarse; `webdav` arma un remoto de
rclone. Por eso la variable se llama `DM_BACKUP_WEBDAV_PASS` y no algo genérico: solo los
transportes de rclone necesitan una credencial *nuestra*.

Y lo que el transporte necesita se valida **al guardar, no al correr**: un destino webdav
sin usuario, o con la URL del navegador en vez de la de `/remote.php/dav/`, se rechaza
ahí mismo. Ese error falla como un problema de autenticación opaco horas después.

**El formato es JSONL por tabla más un manifiesto.** Una tabla es un flujo de filas, y
una línea corrupta cuesta una fila en vez del archivo entero. El manifiesto se escribe
al final, así que su presencia *es* la señal de que el export terminó: uno interrumpido
no tiene manifiesto y no se puede leer como si estuviera completo.

**Las columnas se leen del catálogo, no se escriben a mano.** `select *` parece lo obvio
y está mal: `memories.search_tsv` es `generated always`, así que viajaría para nada y
después el restore la rechazaría al insertar — un respaldo que solo falla el día que lo
necesitas. Preguntarle a la base cuáles columnas son reales evita que una columna
generada agregada mañana vuelva a meter ese fallo.

**Dos tablas se quedan afuera a propósito:** `pairing_codes` (de un uso, 15 minutos) y
`chat_sessions` (el cursor de la última lista). Restaurar cualquiera de las dos sería
restaurar algo que ya no significa nada. Que la lista no se quede corta no depende de
que alguien se acuerde: un test recorre el esquema y falla si aparece una tabla que no
está ni respaldada ni excluida.

**Un archivo que dos dueños comparten viaja en los dos respaldos.** Es la contracara de
dedupear por contenido (§14.1): el blob es uno, pero cada respaldo tiene que poder
restaurar solo, sin depender de que el vecino conserve el suyo.

**Y `dm doctor` lo trata como un chequeo más**, no obligatorio —un respaldo sin
configurar no es un sistema roto— pero con tres estados distintos, porque colapsarlos
sería perder justo la información útil: sin configurar · configurado y nunca corrió ·
corrió tal día, y si se verificó o no.

**Se verifica restaurando, porque un backup que no se restauró no existe.** `verify` no
mira metadatos: restaura el último snapshot, **re-hashea los blobs**, comprueba que
ninguna memoria referencie un blob que no viajó, y **carga el export en una base
desechable** creada desde las migraciones, contando las filas ahí. Lo del hash es gratis
acá y no lo sería en otro sistema: el nombre del archivo *es* su sha256, así que el
corpus trae su propia verificación puesta. Y lo de cargar de verdad es lo que atrapa lo
que un chequeo de formato no ve — los vectores y los `jsonb`, que son justo lo que un
import ingenuo rompe.

**Lo que el backup no puede prometer.** `purge` borra del sistema, no del pasado: un
blob purgado sigue en los snapshots viejos hasta que caducan. Es la contrapartida
honesta del versionado —lo que te salva de un borrado accidental es lo mismo que
retiene uno deliberado—, y se cierra a propósito con `forget`, que aplica la retención
y poda de verdad. Decir otra cosa sería la promesa rota que §14.1 evita.

### 14.4 El espejo: los originales, legibles

Un respaldo bueno es ilegible. Los packs de restic están cifrados y deduplicados, y eso
es exactamente lo correcto para sobrevivir un desastre — y completamente inútil para lo
único que §6.1 admite que el chat no puede: **mirar cuatrocientos documentos**.

Por eso el espejo escribe los mismos originales con nombres que una persona lee:

```
Documentos/1994-11-29 · Cédula de Identidad.pdf
Finanzas/2026-08-07 · Estado de cuenta tarjeta de crédito Visa Infinite.pdf
Seguros/2026-07-29 · Póliza de Seguro de Vehículo.pdf
```

Dominio primero y después la fecha **del hecho**, no la de captura: una carpeta ordenada
por cuándo uno alcanzó a escanear algo es una carpeta que nadie puede leer (§3.3).

**No es que el producto se vuelva un Drive** (§2). El chat sigue siendo la única entrada;
esto es una exportación, y una exportación no es una interfaz. Lo que lo sostiene son
tres reglas, y la tercera es la que evita el único daño que un espejo puede hacer:

1. **Es derivado.** Se regenera entero desde la base y los blobs (§3.6).
2. **Es de una sola vía.** Lo que edites o borres allá vuelve en la próxima corrida. El
   sistema **nunca** lee de ahí, así que no hay dos fuentes de verdad — que es
   precisamente el problema que hundiría esto.
3. **Vive separado del repositorio.** Dos carpetas, nunca una. `dm mirror set` rechaza
   apuntarlo al mismo lugar que el repo: un `sync` sobre packs de restic los borra.

**Y usa `sync`, no `copy`, al revés que los blobs.** Los blobs son inmutables y solo se
agregan; el espejo es una proyección del estado actual, así que lo que purgaste tiene que
desaparecer. Es seguro *porque* es derivado: borrar de más cuesta una corrida más y nunca
un documento. `--max-delete` cubre el caso de un plan que vuelve vacío por un fallo aguas
arriba.

**Respeta `hidden`.** Una memoria oculta no aparece: una carpeta es el lugar más visible
que hay, y §4 dice que oculta significa fuera de los resultados.

**Lo que hay que decidir con los ojos abiertos:** el espejo **no está cifrado** — esa es
la gracia, si no no se vería. Son fichas médicas y financieras en claro en el disco del
destino, mientras que el repositorio de al lado sí está cifrado. Si ese disco no tiene
cifrado de disco, esa carpeta es el punto débil de todo el diseño de §14.2.

## 15. Métricas de éxito

De uso, no de sistema:

- **Time-to-capture** < 5s percibidos.
- **Capturas por semana** — si baja, la fricción subió.
- **Recall confiable a la primera** — % de preguntas respondidas con la cita correcta sin
  reintentar. Métrica estrella.
- **Consultas que igual terminaron en el documento original** — si es alto, el recall no
  está sirviendo.
- **Tasa de "no lo tengo"** — sana si es honesta, alarmante si el dato sí estaba.

## 16. Glosario

- **Memory** — captura inmutable. La unidad del sistema.
- **Domain** — categoría editable en runtime; su `description` alimenta el clasificador.
- **Fact** — dato tipado extraído de una memoria, con vigencia y cita. Se consulta, no se
  busca.
- **FactType** — el registro de qué extraer y de dónde. `estado` tiene uno vigente;
  `periodo` coexiste.
- **Supersesión** — un dato reemplaza a otro sin borrarlo. Solo en los tipos `estado`.
- **Carril** — ruta de normalización según el tipo de entrada (§8.1).
- **Trozo** (`memory_chunk`) — un párrafo con su vector. Lo que se cita.
- **Grounding** — que toda cifra de la respuesta esté en los pasajes leídos.
- **Purgar** — la única forma de borrar de verdad: explícita, confirmada y auditada.
- **Bandeja de revisión** — lo que quedó dudoso, esperando que decidas.
- **Espejo** — la copia legible de los originales (§14.4). Derivada, de una sola vía y
  sin cifrar; no es el respaldo y no puede reemplazarlo.
