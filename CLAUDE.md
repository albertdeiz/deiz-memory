# deiz-memory

Memoria personal externa, accesible por chat. Le mandas cualquier cosa (foto, audio,
texto, PDF) y después le preguntas en lenguaje natural.

**Frase de una línea:** _un segundo cerebro con interfaz de conversación, optimizado
para devolverte con evidencia lo que guardaste, en el momento en que lo necesitas._

---

## 1. Problema real que resuelve

No es "no tengo dónde guardar cosas". Es:

1. **Costo de captura alto** → si guardar cuesta más de 5 segundos, no guardas. Termina
   todo en fotos del carrete, correos y cajones.
2. **Recuperación imposible bajo presión** → el dato existe (la póliza, la receta, el
   número de emergencia) pero encontrarlo requiere 10 minutos y calma. Justo lo que no
   tienes cuando lo necesitas.
3. **Datos que caducan sin avisar** → seguros, licencias, recetas, garantías. El riesgo
   acá no es solo olvidarlos: es **consultarlos y recibir el dato viejo** sin darte
   cuenta.

Todo lo que se diseñe acá se justifica contra uno de esos tres.

## 2. No-objetivos

- No es un gestor de archivos ni un Drive con chat encima.
- No es Notion, ni un note-taking app, ni un CRM.
- No reemplaza el documento original (siempre se guarda el original y se cita).
- **Solo chat.** No hay web, no hay app que instalar. La accesibilidad inmediata es el
  producto; cualquier paso extra mata la captura (§6.1).
- No se borra nada. El storage es un disco duro personal en la nube: append-only (§14.1).
- No da consejo médico, legal ni tributario. Devuelve **lo que tú guardaste**.
- **Sin recordatorios, notificaciones proactivas ni agenda.** El bot responde cuando le
  hablas; nunca inicia conversación.

## 3. Principios de diseño

Restricciones duras, no aspiraciones:

1. **Captura sin fricción.** Mandar algo al bot nunca requiere elegir categoría,
   etiqueta ni carpeta. Se manda y listo. Clasificar es problema del sistema.
2. **Nunca inventar.** Toda respuesta factual cita la memoria de origen (con fecha y
   link al archivo original). Si no está guardado, la respuesta correcta es
   _"no lo tengo"_, no una inferencia plausible.
3. **El tiempo es de primera clase.** Todo dato tiene fecha del hecho, fecha de captura
   y —cuando aplica— ventana de validez. Un dato vencido se responde marcado como
   vencido, o no se responde.
4. **Confirmación diferida.** Si el sistema duda, guarda igual y deja la duda en una
   bandeja de revisión. Nunca bloquea la captura con preguntas.
5. **Respuesta útil > respuesta completa.** El dato y su fuente, no un resumen de 400
   palabras.
6. **El original es sagrado.** El blob crudo nunca se borra ni se sobreescribe. Todo lo
   derivado (texto, clasificación, extracción) es regenerable desde él.
7. **Tus categorías son tuyas y son data.** Los dominios son filas editables, nunca un enum
   en el código. Agregar uno no puede requerir un deploy (§9).

## 4. Modelo de datos

Pocos objetos a propósito. Si algo no cabe acá, probablemente sea scope creep.

### `Memory` — la unidad de captura (inmutable)
Todo lo que entra genera exactamente una Memory. **Es el único objeto necesario para
el MVP.**

```
id
owner_id          la persona dueña. Permanente, nunca cambia. En TODA fila, desde F0
parent_id         para adjuntos de correo: hijo del email que los trajo
source            telegram | email | manual
captured_at       cuándo entró al sistema
occurred_at       cuándo pasó el hecho (≠ captured_at; se infiere después)
raw               blob original (foto, audio, pdf, texto)
normalized_text   texto extraído (ver §8.1)
domain_id         → tabla `domains` (§9). Nunca un enum en código
tags              etiquetas libres, para lo que cruza dominios
title             título corto autogenerado, para listar
confidence        qué tan segura fue la clasificación
status            raw | normalized | classified | needs_review | verified
hidden            oculta de resultados, pero jamás borrada (§14.1)
```

La compartición **no vive acá**: es una relación aparte (`memory_space`), porque una
memoria puede estar compartida en varios espacios a la vez, o en ninguno (§10).

### `Fact` — dato tipado extraído de una Memory *(fase tardía, no MVP)*
Cuando llegue el momento de responder "¿cuál es mi deducible?" con precisión, hace falta
un dato consultable por SQL y no por embeddings.

```
memory_id         de dónde salió (trazabilidad obligatoria)
type              póliza_auto | póliza_salud | receta | ...
payload           JSON tipado según schema por tipo
valid_from / valid_until
superseded_by     una póliza nueva invalida la anterior, no la borra
```

**Insight clave:** la supersesión es lo que separa esto de un basurero de notas. Cuando
llega la póliza nueva, la vieja no se elimina — se marca superada y deja de responder
por defecto, pero sigue disponible para "¿qué cubría el año pasado?". Sin esto, en seis
meses el bot te entrega datos caducos con total seguridad y dejas de confiar en él.

### `Entity` — personas, empresas, lugares *(fase tardía)*
Doctores, aseguradoras, clínicas, el mecánico. Permite _"todo lo del Dr. X"_ o
_"el teléfono de mi corredor"_.

### `Space` — relación de compartición, sin dueño
Un Space ("Casa", "Papás") **no es dueño de nada y no tiene administrador**: es el lugar
donde varias personas ponen a la vista memorias que siguen siendo suyas. Todos los
participantes son pares. Especificado en **§10**.

### `Domain` — categoría editable en runtime
No es un enum: es una fila que puedes crear, renombrar, archivar o fusionar desde el
chat. Especificado en **§9**.

### `Playbook` — respuesta pre-armada para urgencias *(fase tardía)*
_"Choqué el auto"_ no debería disparar una búsqueda semántica de 8 segundos. Se arma
por adelantado desde lo guardado: teléfono de la aseguradora, número de póliza,
deducible, pasos. Se regenera cuando cambia el documento de origen.

## 5. Los tres verbos del router

Todo mensaje entrante se enruta a uno de tres:

| Verbo | Ejemplo | Camino |
|---|---|---|
| **Capturar** | foto de una receta, "el mecánico es Juan +569..." | ingest → normalizar → clasificar → guardar |
| **Recordar** | "¿cuál es mi deducible?", "¿qué me recetaron en marzo?" | recuperación + citación |
| **Aclarar** | respuesta a una pregunta del bot, corrección de un dato | actualizar Memory + marcar verified |

La ambigüedad se resuelve siempre a favor de **capturar**: guardar de más es barato,
perder algo es caro.

## 6. Recuperación: dos modos, no uno

El error clásico es meter todo a un vector store y esperar que funcione. No funciona
para _"¿cuál es mi número de póliza?"_.

- **Modo contexto (semántico):** full-text + vectores sobre `normalized_text`. Es lo que
  hay en el MVP, y alcanza para la mayoría de las consultas.
- **Modo hecho (determinista):** consulta SQL sobre `Fact`, filtrando por tipo y
  vigencia. Preciso y verificable. Llega en fase tardía, solo para los datos duros que
  lo justifiquen.
- **Híbrido:** filtro estructurado primero (dominio + ventana temporal), búsqueda
  semántica después dentro de ese subconjunto. Reduce muchísimo el ruido.

Toda respuesta trae: el dato, la fecha del hecho, y un link al original.

### 6.1 Solo chat — y cómo se paga esa decisión

Nada de web ni de app propia: la única app que hace falta es la que ya usas todos los
días. Ese es el argumento central del producto y no se negocia.

El costo real: **el chat es pésimo para explorar 40 resultados.** No se resuelve con una
web, se resuelve dentro del chat:

- **Paginación con botones** — 5 resultados por vez, botón "más". Nunca un muro de texto.
- **Refinamiento conversacional** — "de esos, solo los de 2025" en vez de scroll.
- **Exportar bajo demanda** — _"mándame todo lo de salud en PDF"_. Cuando de verdad hay
  que revisar volumen, la respuesta es un documento generado y enviado al chat, no una
  pantalla que navegar.

## 7. Arquitectura

Monolito. Nada de microservicios para un sistema de un usuario.

```
Telegram ──┐
           ├──> Channel Adapter ──> Ingest Queue (ack inmediato)
Correo ────┘   (identidad + espacio)
                                      │
                          ┌───────────┴───────────┐
                          ▼                       ▼
                    Normalizer              (blob store)
              markitdown / visión / STT
                          │
                          ▼
         Clasificador (dominio + título + fecha del hecho)
            ▲ lee los dominios activos desde la DB
                          │
                  ┌───────┴────────┐
                  ▼                ▼
              Memories        Review Inbox (baja confianza)
                  │
                  ▼
            Postgres + pgvector ◄──── Retriever
```

**Puntos no negociables:**
- El adapter de canal está detrás de una interfaz. Telegram y correo hoy, WhatsApp
  después, sin tocar el core.
- **`owner_id` en todas las tablas desde F0**, aunque los espacios compartidos lleguen
  mucho después. Meter tenancy a posteriori es una migración brutal; meterla ahora es
  una columna.
- La ingesta es asíncrona. El usuario recibe "guardado ✓" en <1s; normalización y
  clasificación corren después. Nunca hacer esperar al usuario por un LLM.
- Todo lo derivado es re-ejecutable. Si mejora el prompt o el schema, se reprocesan los
  blobs originales sin pérdida.
- **El prompt del clasificador se construye en runtime** desde la tabla `domains`. No
  hay lista de dominios escrita en el código, en ningún lado.

### 7.1 El contrato del adapter de canal

**Telegram por ahora.** Pero el adapter no es "el archivo donde vive el bot": es la
frontera que decide si agregar WhatsApp más adelante cuesta un día o cuesta un rewrite.
Se diseña desde F0 (§16).

Lo que el adapter traduce:

| Hacia adentro | Hacia afuera |
|---|---|
| identidad del remitente → `user_id` interno | texto |
| mensaje entrante (texto / foto / audio / archivo) | opciones para elegir |
| respuesta a una opción ofrecida | archivo o imagen |
| límites y formatos propios del canal | resultados paginados |

**Lo importante no es enviar y recibir: es declarar capacidades.** El core nunca asume
que existen los botones inline de Telegram ni su límite de archivo. El adapter expone:

```
maxUploadBytes / maxDownloadBytes
supportsButtons        Telegram: sí. WhatsApp: listas interactivas, distintas
supportsRichFormatting
canInitiate            si el canal permite escribir sin que te hablen primero
```

Y el core degrada solo: sin botones, la paginación pasa a comandos numerados; con un
límite de archivo menor, el export se parte en varias entregas. Si el core asume las
capacidades de Telegram, el segundo canal es un rewrite disfrazado de adapter.

## 8. Stack propuesto

| Capa | Elección | Por qué |
|---|---|---|
| Canal | **Telegram Bot API** | gratis, sin aprobación, soporta fotos/audio/docs/PDF nativo. WhatsApp exige Meta Business API: costo por conversación y plantillas aprobadas |
| Runtime | TypeScript + Node | stack que ya dominas |
| Bot lib | grammY | mejor DX que telegraf hoy |
| DB | Postgres + pgvector | estructurado, full-text y vectores en un solo motor. Una DB, un backup |
| Cola | pg-boss | sin Redis extra al inicio |
| Blobs | **Garage** self-hosted (API S3), direccionable por contenido | el original es sagrado; ver §14.1 |
| Correo | buzón dedicado + polling IMAP | segunda vía de captura; ver §11 |
| LLM | Claude | structured outputs; modelo chico para routing y clasificación, grande para extracción |
| Documentos → texto | **markitdown** (Python: CLI al inicio, sidecar después) | PDF/docx/xlsx/html/csv → Markdown con estructura preservada. Ver §8.1 |
| Imágenes y escaneos | **OCR (RapidOCR/PP-OCR)**, con LLM multimodal como alternativa | markitdown **no hace OCR**; ver §8.1. En impresos el OCR lee mejor los dígitos que un modelo chico, y es gratis y reproducible |
| STT | Whisper en contenedor, API compatible con OpenAI | notas de voz. Mejor que el carril de audio de markitdown |
| Deploy | 1 VPS o Fly.io, single-tenant | datos médicos: no los repartas |

### 8.1 Normalización: markitdown + carriles

**markitdown** (Microsoft) es el conversor por defecto. Convierte PDF, docx, xlsx, pptx,
html, csv, json, epub y zip a Markdown **preservando la estructura** — tablas, títulos,
listas. Para pólizas, boletas y planillas es justo lo que se necesita, y ese Markdown
estructurado es mejor insumo que texto plano aplanado: una tabla de coberturas sigue
pareciendo una tabla.

**Advertencia que define el diseño: markitdown no es un motor de OCR.**

- **PDF** — usa pdfminer: extrae solo la capa de texto. Un PDF escaneado devuelve vacío.
- **Imágenes** — extrae EXIF y, si le pasas un cliente LLM, genera una *descripción* de
  la imagen. Una descripción no es una transcripción fiel. Para una receta manuscrita
  no sirve.
- **Audio** — su carril usa `speech_recognition` (Google Web Speech por defecto): flojo
  en español de Chile y manda el audio a Google. Usar Whisper en su lugar.

Por eso el Normalizer es un **router de carriles**, no una sola llamada:

| Entrada | Carril | Herramienta |
|---|---|---|
| PDF con capa de texto, docx, xlsx, pptx, html, csv | A — documento digital | **markitdown** |
| PDF escaneado (capa de texto < ~100 chars) | B — visual | LLM multimodal, página por página |
| Foto (receta, boleta, carnet, patente) | B — visual | LLM multimodal, prompt de transcripción fiel |
| Nota de voz | C — audio | Whisper |

**Regla de fallback:** siempre se intenta A primero — barato, determinista, reproducible.
Si el resultado es pobre (pocos caracteres, sin estructura), cae a B. El carril usado
queda registrado en la Memory, para poder reprocesar después sin adivinar qué pasó.

**Integración:** markitdown es Python, el core es TypeScript. Como la ingesta ya es
asíncrona, al principio basta invocarlo por CLI (`uvx markitdown`, con `markitdown[all]`);
el arranque de Python por archivo no se nota si nadie está esperando. Si empieza a
molestar, se pasa a un sidecar FastAPI con un `POST /convert` en el mismo compose.

## 9. Dominios — dinámicos por diseño

Un dominio **no es un enum en el código**: es una fila en la tabla `domains`, editable
en cualquier momento desde el chat. La lista de abajo es una semilla, no una lista
cerrada. El día que necesites guardar cosas de **migración**, se crea y listo — sin
tocar el repo y sin deploy.

### El registro `Domain`

```
id            estable e inmutable — la identidad real
slug          migracion        (para comandos: /migracion)
label         Migración        (para mostrar; renombrable sin romper nada)
description   "Visas, RUT, permanencia definitiva, apostillas, extranjería"
aliases       ["visa", "PDI", "extranjería"]
active        true | false
created_at
```

**`description` no es documentación: es el prompt.** El clasificador se arma en runtime
concatenando las descripciones de los dominios activos. Un dominio con descripción vaga
clasifica mal. Por eso al crear uno, el bot pide o propone una descripción de una línea:
es el único campo que de verdad mueve la precisión.

**El `id` es la identidad, nunca el nombre.** Renombrar "vehículo" a "auto" cambia un
`label`; ninguna Memory se entera.

### Operaciones desde el chat

| Operación | Qué hace |
|---|---|
| `/dominios` | lista los activos, con cuántas memorias tiene cada uno |
| **crear** | pide una descripción de una línea; queda activo de inmediato |
| **editar** | cambia label, descripción o aliases. No toca las memorias existentes |
| **archivar** | `active = false`. Deja de proponerse al clasificar; sus memorias siguen ahí y siguen siendo buscables |
| **fusionar** | mueve todas las memorias de A a B y archiva A |

**No hay borrado duro.** Eliminar un dominio con memorias adentro las dejaría huérfanas
o, peor, se las llevaría. Las dos operaciones honestas son **archivar** y **fusionar**;
en la práctica fusionar es la que vas a querer el 90% de las veces _("esto de 'papeles'
en realidad era 'documentos'")_.

### Cómo nace un dominio nuevo

Dos caminos, y el segundo es el que hace que esto valga la pena:

1. **Explícito** — se lo pides: _"crea el dominio migración"_.
2. **Emergente** — el clasificador junta varias memorias que no calzan bien en ningún
   dominio activo y **propone** uno: _"van 3 cosas que parecen trámites de extranjería
   y no calzan en ningún dominio. ¿Creo 'migración'?"_.

El punto del camino 2 es que no tienes que anticipar tus propias categorías. Hoy no sabes
qué vas a necesitar guardar en dos años; el sistema lo descubre de tus propios datos.

### Guardrail: la proliferación es el modo de falla

Crear categorías libremente y sin frenos termina en 40 dominios con la mitad solapados ("salud",
"médico", "doctores"). Tres frenos:

- **El bot propone, nunca crea solo.** Un dominio nuevo siempre pasa por tu confirmación.
- **Antes de crear, chequea solapamiento** contra las descripciones existentes:
  _"esto se parece mucho a 'documentos'. ¿Lo creo igual, o lo guardo ahí?"_.
- **Revisión ocasional** de dominios con muy pocas memorias o descripciones parecidas,
  con sugerencia de fusión.

Para lo que cruza dominios (un certificado de vacunas que sirve para salud **y** para
migración): **un dominio primario + `tags` libres**. Un solo primario mantiene
`/migracion` limpio y el clasificador simple.

### Semilla inicial (contexto Chile)

Editables, renombrables o archivables desde el día uno. En el MVP el dominio es **solo
una etiqueta** para filtrar y listar — no implica schema ni extracción tipada.

- **Salud** — consultas, recetas, exámenes, medicamentos, alergias, vacunas,
  Isapre/Fonasa, bonos y reembolsos
- **Seguros** — salud complementario, auto, hogar, vida: coberturas, deducibles,
  teléfonos 24/7, número de póliza
- **Vehículo** — patente, revisión técnica, permiso de circulación, SOAP, mantenciones
- **Documentos** — cédula, pasaporte, licencia de conducir
- **Finanzas** — suscripciones, pagos recurrentes, garantías de compras, boletas
- **Trabajo** — decisiones, contactos, compromisos
- **Hogar** — garantías de electrodomésticos, técnicos de confianza, medidas, contratos
- **Personas** — cumpleaños, tallas, preferencias, contactos de emergencia

Y dos que probablemente aparezcan solos con el tiempo, sin modelarlos en detalle ahora:
**tributario (SII)** — comprobantes, formularios, contribuciones, boletas de honorarios —
y **migración** — visas, RUT, permanencia definitiva, apostillas. Nacen como dominio
cuando llegue el tercer documento del tipo, por cualquiera de los dos caminos de arriba.

## 10. Espacios y compartición

### El principio: la memoria es tuya, el espacio es una vista

Un Space **no posee memorias**. Cada Memory tiene un `owner_id` permanente —la persona
que la capturó— y compartirla es crear una relación, no transferirla:

```
memory_space   (memory_id, space_id, shared_by, shared_at)
```

De ahí salen tres consecuencias, todas buenas:

- **Una memoria puede estar en varios espacios a la vez.** La póliza del auto puede verse
  en "Casa" y en "Papás" sin duplicarse ni copiarse: son dos filas.
- **Dejar de compartir es borrar una fila.** Revocación instantánea y sin ambigüedad.
- **Si te sales de un espacio, tus memorias se van contigo.** Se eliminan sus relaciones
  con ese espacio; los originales no se tocan porque nunca dejaron de ser tuyos.

No existe el concepto de "espacio personal". Tus memorias son tuyas por defecto y no
están compartidas con nadie hasta que lo digas.

### Nada desaparece en silencio

La contracara de "mis memorias se van conmigo" es que **al resto le desaparece
contenido**. Que datos se esfumen sin aviso es el peor tipo de falla, así que **todo
retiro se avisa**, siempre:

- **Al salir del espacio** — _"X salió de Casa. 14 memorias que había compartido ya no
  están disponibles."_ Agregado, sin listar qué eran.
- **Al dejar de compartir una memoria suelta** — se avisa **nombrándola**: _"X dejó de
  compartir 'Póliza auto 2026'."_ Retirar varias de una vez se agrupa en un solo aviso.

Nombrarla no es un descuido: quien estaba en el espacio **ya tenía acceso a esa memoria**,
así que el título no revela nada nuevo. Y si el aviso no dijera cuál es, sería inútil —
la persona que dependía de ese documento no sabría qué fue lo que perdió.

**El límite honesto que esto deja claro:** dejar de compartir es *retirar*, no *borrar de
la cabeza del otro*. Quien ya lo vio, ya lo vio, y ahora además sabe que lo retiraste.
Si algo no debe verlo nadie, la respuesta es no compartirlo — no compartirlo y arrepentirse.

### El registro `Space`

```
id
label         "Casa" | "Papás"
created_at
created_by    solo dato histórico; no otorga ningún privilegio
```

### Sin dueño y sin roles: todos son pares

Un espacio **no tiene administrador**. La propiedad existe solo a nivel de memoria, y
cada persona es dueña y responsable de las suyas. De ahí sale todo el gobierno del
espacio, sin necesidad de inventar jerarquías:

| Acción | Quién |
|---|---|
| invitar | cualquier participante |
| compartir y dejar de compartir | solo el dueño de esa memoria |
| cambiar las categorías del espacio | requiere el acuerdo de **todos** los participantes |
| salir | cada quien de sí mismo |
| **expulsar a otro** | **nadie** |

**Nadie puede expulsar a nadie, y no hace falta.** Es la consecuencia más interesante del
modelo: si alguien no debería seguir viendo tus cosas, no necesitas sacarlo del espacio
—necesitas dejar de compartir—, y eso está siempre enteramente en tus manos. El espacio
se queda vacío de tu contenido en el acto.

El costo aceptado: si entra alguien que no debía (un link filtrado), no hay botón para
echarlo. El remedio es que cada quien deje de compartir y el espacio se abandone. Para
un sistema entre personas que se conocen, es un intercambio razonable, y evita el
problema mucho peor de que alguien tenga poder sobre los datos de otro.

**Un espacio sin participantes se archiva solo.** No hay que "cerrarlo": muere cuando
sale el último.

### Categorías: dos niveles

Cada persona tiene sus propios `domains` (§9) — sus categorías privadas, sobre sus
memorias. Un espacio compartido tiene además **su propia lista de categorías**, para que
`/casa documentos` sea coherente sin importar cómo nombre cada uno las cosas en privado.

Al compartir algo, el bot sugiere el dominio del espacio; tu dominio privado no se toca.
Una memoria puede así estar en tu "papeles" y en el "documentos" de Casa a la vez.

#### Cambiar las categorías del espacio: por unanimidad

Como nadie manda (§10), **ningún cambio estructural se aplica sin el acuerdo de todos los
participantes**: crear, renombrar, fusionar o archivar una categoría del espacio. Lo
propone cualquiera —o el propio bot—, y solo se aplica cuando todos dijeron que sí.

- **Un solo rechazo la mata de inmediato.** No tiene sentido esperar al resto.
- **Las propuestas pendientes se ven con `/pendientes`** y caducan a los 7 días si alguien
  nunca respondió. Sin caducidad, un espacio de cuatro personas nunca cambia nada.
- Un espacio de una sola persona no es un caso especial: la unanimidad es contigo mismo.

**Lo que NO requiere unanimidad: usar las categorías que ya existen.** Al compartir algo
eliges su categoría y listo. Se vota la estructura compartida, nunca el día a día — si
no, compartir se vuelve insoportable.

#### Y sí, el bot también propone

El mecanismo de categorías emergentes de §9 aplica igual acá, pero mirando lo que
comparte **todo el grupo**: si entre varios acumulan cosas que no calzan en ninguna
categoría del espacio, el bot propone una — _"entre ustedes van 5 cosas del colegio.
¿Creo la categoría 'colegio' en Casa?"_ — y esa propuesta pasa por la misma unanimidad.

### Identidad e invitación — la ventaja del chat

**No hay cuentas, ni contraseñas, ni verificación de correo.** La identidad es el user id
del canal. El onboarding completo es:

`/invitar casa` → link de un solo uso → la otra persona abre el bot → adentro.

Tu mamá no crea una cuenta, no elige una contraseña, no instala nada. Es probablemente el
mayor beneficio práctico de ser solo chat.

### Búsqueda

Al preguntar se busca en **tus memorias + todo lo compartido en los espacios donde eres
miembro**, y la respuesta dice de dónde viene cada cosa. Obligarte a recordar dónde
guardaste algo sería reintroducir el problema que el sistema existe para eliminar.

### El modo de falla: filtrar algo sensible

Se mitiga por diseño, no por cuidado del usuario:

- **Nada se comparte por inercia.** El default siempre es privado; compartir es un acto
  explícito.
- Al compartir algo de un dominio sensible (salud, finanzas), el bot **confirma nombrando
  a quién se lo vas a mostrar**.
- Dejar de compartir es inmediato, y **siempre se avisa** al espacio (ver abajo).

## 11. Correo como vía de captura

Muchas de las cosas que vale la pena guardar **ya llegan por correo**: pólizas, boletas,
reservas, resultados de exámenes. Y llegan mejor descritas que una foto: remitente,
asunto, fecha y adjunto, todo estructurado y sin OCR de por medio.

### Cómo se modela

Un correo entrante genera un **Memory padre** (el mensaje: remitente, asunto, cuerpo) y
un **Memory hijo por adjunto**, unidos por `parent_id`. Así el PDF de la póliza es
buscable por sí mismo, pero conserva el contexto de quién lo mandó y cuándo.

El **remitente es la mejor señal de clasificación que vas a tener** — mejor que
cualquier OCR. Un correo de una aseguradora se clasifica bien antes de leer el cuerpo, y
más adelante alimenta directo la resolución de `Entity`.

### El agujero de seguridad, que es real

**Cualquiera que conozca la dirección puede inyectar memorias, y el remitente es
falsificable.** El correo entrante no está autenticado. Tres capas:

1. **Dirección secreta por persona** — parte local aleatoria y larga, no `memoria@`.
   Lo que entra por ahí queda a tu nombre, como cualquier otra captura; compartirlo es
   un paso aparte.
2. **Allowlist de remitentes** — tus propias direcciones. Como el flujo real es
   *reenviar*, el remitente del sobre eres tú, y la allowlist funciona bien.
3. **Cuarentena** — lo que no pasa la allowlist no se descarta ni se guarda como memoria:
   queda en una bandeja aparte que apruebas desde el chat.

### Implementación

Empezar con **un buzón dedicado y polling IMAP**: cero DNS, cero MX, cero endpoint
público expuesto, cero superficie de spam. La ingesta ya es asíncrona, así que unos
minutos de latencia no le importan a nadie. Si algún día molesta, se pasa a un webhook
de correo entrante (Cloudflare Email Routing → Worker, o Postmark inbound).

## 12. Roadmap

Pasos chicos y estables. Cada fase tiene que ser útil sola y quedar en verde antes de
pasar a la siguiente. Si una fase no se usa en la vida real, se arregla o se descarta —
no se acumula.

**F0 — Tubería tonta.** Sin LLM. El bot recibe texto, foto, audio y PDF; guarda el blob
original con su metadata y responde `guardado ✓ #id`. Búsqueda full-text sobre lo que
venga en texto. Un comando `/buscar`. Tres cosas que parecen prematuras y no lo son:
`owner_id` en todas las tablas, un **módulo único de acceso a blobs** (`put`/`get`, nadie
más habla con Garage — es lo que hace posible cambiar a R2 con una variable), y el adapter
de canal con capacidades declaradas (§7.1).
_Listo cuando:_ lo usas una semana y no vuelves a las notas del teléfono, y el backup
cifrado off-site corre solo y ya lo restauraste una vez.
> **Construido.** Core + CLI, Postgres y Garage, 55 tests. Ver [README](./README.md).
> Pendiente del criterio de listo: el backup off-site y la semana de uso real.

**F1 — Texto de todo.** Los tres carriles de §8.1: markitdown para documentos, visión
para fotos y escaneos, Whisper para audio. La búsqueda del F0 ahora alcanza el
**contenido**, no solo lo que escribiste tú.
_Listo cuando:_ mandas la foto de una boleta y la encuentras buscando por lo que dice.
> **Construido.** Router de carriles, cola pg-boss con `dm worker`, y `dm reprocess`
> para UC-15. 126 tests. La migración 003 parte `note` (lo tuyo, nunca se pisa) de
> `normalized_text` (lo derivado del blob, regenerable) — sin esa línea, la primera
> transcripción se comía la nota.
>
> **Los tres carriles son servicios**, no binarios en el host: `documents`
> (markitdown + rasterizado), `ocr` (RapidOCR) y `whisper`, cada uno en su
> contenedor y detrás del mismo puerto `Converter`. El motor de cada carril se
> cambia con una variable de entorno. Ver [README](./README.md).
>
> **Validado contra el corpus real** (173 memorias): 65 por markitdown sin un
> solo error, 61 por OCR, 38 sin carril (CAD, zips, video) y 8 de texto. Los
> únicos fallos fueron 2 HEIC —que el OCR no lee— y un fixture corrupto de 22
> bytes. La migración 003 rescató las 168 notas, ninguna perdida.
>
> **Una corrección a §8.1:** el carril B por defecto es OCR clásico, no un LLM
> multimodal. Para documentos impresos el OCR *gana* justo donde importa — números
> de póliza, RUT, montos: cadenas que no se adivinan por contexto y donde los
> modelos chicos fallan. Además es gratis y reproducible desde el blob. El carril
> multimodal sigue disponible (`DM_VISION_BACKEND=anthropic|openai`) y es el
> correcto para manuscrito, que es lo que el OCR no puede leer.

**F2 — Dominios y clasificación.** Tabla `domains` con su CRUD desde el chat (§9), y
clasificador que se arma en runtime desde ella: dominio, título corto y fecha del hecho.
El título generado no es un adorno: **el nombre del archivo casi nunca significa algo**
—`IMG_20260114_093312.jpg`, `scan0001.pdf`, `WhatsApp Document...`— así que hasta que
exista un título, media biblioteca no tiene cómo nombrarse.
Todavía sin schemas tipados. Comando `/<slug>` para listar.
_Listo cuando:_ creas un dominio nuevo desde el chat, mandas algo y cae ahí — y `/salud`
te lista tus consultas ordenadas por fecha real, no por fecha de captura.

**F3 — Preguntas en lenguaje natural.** Recuperación híbrida (filtro por dominio y fecha
+ semántica) con cita obligatoria a la fuente.
_Listo cuando:_ confías en la respuesta sin ir a abrir el PDF.

**F4 — Correo como segunda vía.** Buzón por persona, polling IMAP, allowlist y
cuarentena (§11). Padre + hijos por adjunto.
_Listo cuando:_ reenvías la póliza que te llegó por mail y queda guardada y clasificada
sin que hagas nada más.
_Puede adelantarse antes de F3 si la captura resulta ser el cuello de botella._

**F5 — Espacios compartidos.** Tabla `memory_space`, participantes, `/invitar` con link
de un solo uso, categorías del espacio por unanimidad, confirmación al compartir (§10).
El `owner_id` ya existe desde F0; acá se agrega la relación encima.
_Listo cuando:_ tu pareja comparte algo en "Casa" desde su teléfono, tú lo encuentras
desde el tuyo, y al salirse del espacio desaparece limpio.

**F6 — Facts tipados donde duele.** Solo dos o tres tipos de alto valor (póliza de auto,
póliza de salud, receta), con vigencia.
_Listo cuando:_ "¿cuál es mi deducible?" responde en un mensaje, y una póliza vencida
se identifica como vencida.

**F7 — Playbooks de urgencia.** Respuestas pre-armadas para choque, urgencia médica,
robo de documentos.
_Listo cuando:_ en una situación real de estrés lo abres primero a él.

## 13. Reglas duras para el agente

Invariantes del producto:

1. Nunca responder un dato factual sin `memory_id` de respaldo.
2. Si hay dos memorias en conflicto, mostrar ambas con fechas y decir que hay conflicto.
   Jamás elegir una en silencio.
3. Si el dato está vencido o superado, decirlo **antes** del dato.
4. Máximo **una** pregunta de aclaración por captura. El resto va a la bandeja.
5. Salud: devolver lo guardado, nunca interpretar ni recomendar.
6. Tributario: mostrar el comprobante guardado, nunca calcular ni interpretar normativa.
7. Nunca crear, renombrar, archivar ni fusionar una categoría sin confirmación
   explícita — y si es de un espacio compartido, sin la de **todos** sus participantes.
8. Confirmar antes de cualquier acción irreversible (marcar superado, fusionar, purgar).
9. Toda consulta va filtrada por: memorias propias + lo compartido en espacios donde el
   que pregunta es miembro. Sin excepción, sin "modo admin".
10. Compartir algo de un dominio sensible exige confirmación que **nombre a quién se le
    va a mostrar**.
11. Nadie tiene autoridad sobre memorias ajenas: ni para verlas, ni para dejar de
    compartirlas, ni para borrarlas. Los espacios no tienen administrador.
12. Todo retiro de contenido compartido se avisa al espacio. Nada desaparece en silencio.
13. Correo fuera de la allowlist va a cuarentena. Nunca directo a memorias.

## 14. Privacidad y seguridad

Esto guarda datos médicos y financieros. El modelo de amenaza, honesto:

- **Los chats de bot en Telegram NO son E2E.** Telegram puede leerlos. Hay que asumirlo
  conscientemente, o cambiar de canal más adelante.
- Cifrado en reposo de blobs y DB. Backups cifrados y **probados** (un backup no
  restaurado no existe).
- Secretos fuera del repo. Nada de PII en logs — redactar antes de escribir.
- **Aislamiento por dueño y por membresía.** Toda query lleva ese filtro. Es la
  superficie de fuga más peligrosa del sistema una vez que hay más de una persona: un
  `WHERE` olvidado no es un bug, es filtrar la ficha médica de alguien.
- **Correo entrante no está autenticado** y el remitente es falsificable: dirección
  secreta + allowlist + cuarentena (§11).
- **Nivel sensible:** ciertos datos (bancarios, diagnósticos, claves de acceso) exigen
  PIN antes de mostrarse. Protege el caso "me robaron el teléfono desbloqueado".
- Contraseñas: **no se guardan**. Eso vive en un gestor de contraseñas real; acá solo
  se recuerda dónde está.
- Proveedor de LLM: verificar retención cero / no entrenamiento antes de mandarle una
  receta médica.

### 14.1 Storage: el disco duro personal en la nube

**Append-only.** Nada se borra. Corregir es agregar; ocultar es `hidden = true`. La
memoria vieja sigue existiendo y sigue respondiendo preguntas del pasado
_("¿qué cubría mi póliza en marzo?")_.

Una excepción honesta: **sí existe `purgar`**, para el caso real de haber subido algo que
no debía estar ahí (datos de otra persona, la foto equivocada). Es explícito, pide
confirmación y queda registrado en un log de auditoría. Prometer "es imposible borrar"
es una promesa que se rompe el día que la necesitas.

**Blobs direccionables por contenido** (sha256): deduplicación gratis, y compartir una
memoria nunca mueve ni copia bytes.

**El prefijo del bucket es por dueño, no por espacio.** El dueño es permanente y el
espacio es una relación transitoria: si los blobs vivieran bajo un prefijo de espacio,
salirse de uno obligaría a mover archivos. Bajo prefijo de dueño, salirse es borrar
filas de una tabla.

**Backend: S3-compatible, siempre.** El código nunca habla con un proveedor concreto:
habla S3. Eso convierte la elección de dónde viven los bytes en una variable de entorno,
no en una decisión de arquitectura.

- **Nuestro stack: Garage self-hosted**, en el mismo host que el resto. Sin factura, sin
  una cuenta de terceros guardando fichas médicas, sin cuotas de API.
- **Extensible a Cloudflare R2** cuando convenga, cambiando endpoint y credenciales. Sin
  tocar código.

**Por qué Garage:** un solo binario en Rust, consumo de memoria mínimo, pensado
exactamente para self-hosting en uno o pocos nodos. Cabe al lado de Postgres en el mismo
VPS sin pelear por recursos, que es justo la forma del proyecto. No trae consola web —
la administración es por CLI (`garage bucket`, `garage key`), y para un sistema de un
dueño eso alcanza y sobra.

**No nos casa con nada.** Habla S3, así que Garage es una decisión de despliegue, no de
arquitectura: el día que quieras R2, cambian tres variables de entorno.

**El costo real del self-hosting es la durabilidad, y hay que pagarlo.** Un solo host es
un solo punto de falla, y acá el blob original es lo único irrecuperable: si se pierde,
no hay reproceso que valga. Backup cifrado y **off-site**, no negociable — y el destino
natural de ese backup es justamente R2 o B2. Entra primero como respaldo, no como
almacenamiento primario.

### 14.2 Cifrado: solo donde los bytes salen del host

La pregunta correcta no es "¿ciframos?" sino **qué protege cada cifrado**. Y en un
sistema self-hosted de un solo dueño, la respuesta recorta mucho el alcance.

**Cifrar cada blob no compra nada acá.** La app, Garage y la clave viven en el mismo VPS:
quien entra al host se lleva los datos **y** la clave. Un cifrado cuya llave está al lado
de la cerradura no es una defensa, es ceremonia — y costaría justo en las fases que
tienen que ser rápidas.

**Lo único que sí compra algo es cifrar lo que sale del host.** Concretamente, uno solo:

- **El backup off-site — F0, no negociable.** Es el único lugar donde tus datos duermen
  en infraestructura ajena. `restic` o `age` sobre el stream lo resuelve, es barato, y
  cubre la amenaza real. Su passphrase la guardas tú, se muestra una vez y no hay
  recuperación: si la pierdes, el respaldo es un ladrillo.

Lo que de verdad mueve la aguja en este sistema, y va antes que cualquier cifrado de
blobs: **cifrado de disco del host**, Postgres y Garage **sin puerto expuesto a
internet**, secretos fuera del repo, y un backup **restaurado al menos una vez** (uno que
nunca se restauró no existe).

#### La incomodidad que ordena las prioridades

El texto en claro **ya sale de la caja, por diseño**: cada documento se le manda al
proveedor de LLM para extraer, y cada respuesta pasa por un chat que no es E2E. Cifrar el
blob en reposo mientras ocurre eso es proteger la única copia que nunca se movía.

Los controles que realmente importan son otros dos, y ya están en §14: **un proveedor de
LLM con retención cero**, y aceptar conscientemente lo que Telegram ve.

#### Cuándo se reabre esto

Esta decisión asume **self-hosted, un dueño, un host**. Si eso cambia —storage de
terceros como fuente de verdad, o el sistema operado para gente que no eres tú— el
cálculo se invierte y hay que rehacerlo desde cero.

## 15. Métricas de éxito

De uso, no de sistema:

- **Time-to-capture** < 5s percibidos.
- **Capturas por semana** — si baja, la fricción subió.
- **Recall confiable a la primera** — % de preguntas respondidas con la cita correcta
  sin reintentar. Métrica estrella.
- **Consultas que igual terminaron en el documento original** — si es alto, el recall
  no está sirviendo, por más que haya respondido algo.
- **Tasa de "no lo tengo"** — sana si es honesta, alarmante si el dato sí estaba.
- **Capturas por correo vs por chat** — si el correo domina, la fricción del chat es más
  alta de lo que crees.
- **Miembros activos en espacios compartidos** — un espacio donde solo escribe una
  persona no es compartir, es ruido.

## 16. Canal: Telegram ahora, adapter desde el día uno

Como el bot **solo responde y nunca inicia conversación**, la ventana de 24h de la
Business API de WhatsApp no lo limita: siempre le hablas tú primero. Eso deja la
comparación en estos términos:

| | Telegram | WhatsApp |
|---|---|---|
| Costo | gratis | por conversación |
| Fricción de setup | nula | Meta Business API, verificación, plantillas |
| Archivos y audio | excelente, nativo | funciona, con más límites |
| **Que tu mamá ya lo tenga** | improbable | **prácticamente seguro** |

Esa última fila es la que decide. En Chile, WhatsApp es el canal por defecto; pedirle a
tus papás que instalen Telegram contradice de frente el principio de "ninguna app
nueva" (§2).

**Decisión: Telegram.** Es gratis, no bloquea nada y permite avanzar hoy. Pero el
adapter de canal se trata como **código de primera clase desde F0**, con capacidades
declaradas y no asumidas (§7.1).

Lo que fuerza la decisión de agregar WhatsApp es **F5**: si los espacios compartidos son
con gente que no usa Telegram, el adapter deja de ser una previsión y pasa a ser el
camino crítico. Vale la pena preguntarle a las dos o tres personas con las que
realmente vas a compartir qué usan, antes de llegar a F5.

## 17. Glosario

- **Memory** — captura cruda inmutable. La unidad del sistema.
- **Domain** — categoría editable en runtime; su `description` alimenta el clasificador.
- **Space** — relación de compartición entre personas. No es dueño de las memorias.
- **Cuarentena** — correo entrante que no pasó la allowlist; espera aprobación.
- **Purgar** — la única forma de borrar de verdad: explícita, confirmada y auditada.
- **Carril** — ruta de normalización según el tipo de entrada (§8.1).
- **Fact** — dato tipado extraído, con vigencia. Fase tardía.
- **Supersesión** — un dato reemplaza a otro sin borrarlo.
- **Playbook** — respuesta pre-armada para urgencias.
- **Bandeja de revisión** — cola de resultados de baja confianza esperando confirmación.
