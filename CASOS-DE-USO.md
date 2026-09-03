# Casos de uso

Los dieciséis flujos que el sistema sabe hacer, derivados de las decisiones de
[CLAUDE.md](./CLAUDE.md). Cada uno con su mecanismo y las reglas duras (§13) que lo
gobiernan.

| ID | Caso de uso | Actor | Disparador | Resultado | Fase |
|---|---|---|---|---|---|
| UC-01 | [Capturar desde el chat](#uc-01--capturar-desde-el-chat) | Dueño | Manda un archivo, o escribe `/capture` | Memory con su blob y su texto | F0–F1 |
| UC-03 | [Aclarar y revisar](#uc-03--aclarar-y-revisar) | Bot → Dueño | Extracción de baja confianza | Memory verificada o en bandeja | F1–F2 |
| UC-04 | [Explorar y exportar](#uc-04--explorar-y-exportar) | Dueño | `/search` o listar categoría | Página de 5, o un PDF al chat | F0 |
| UC-05 | [Preguntar en lenguaje natural](#uc-05--preguntar-en-lenguaje-natural) | Dueño | Pregunta libre | Dato + cita, o "no lo tengo" | F3 |
| UC-06 | [Vigente, vencido o en conflicto](#uc-06--vigente-vencido-o-en-conflicto) | Dueño | Pregunta por un dato duro | Dato marcado según su vigencia | F6 |
| UC-07 | [Playbook de urgencia](#uc-07--playbook-de-urgencia) | Dueño | "Choqué el auto" | Respuesta pre-armada en menos de 2 s | F7 |
| UC-08 | [Nace una categoría](#uc-08--nace-una-categoría) | Dueño o bot | Se pide, o el bot detecta un patrón | Categoría activa, previa confirmación | F2 |
| UC-09 | [Reorganizar categorías](#uc-09--reorganizar-categorías) | Dueño | Renombrar, archivar o fusionar | Categorías al día, memorias intactas | F2 |
| UC-10 | [Crear espacio e invitar](#uc-10--crear-espacio-e-invitar) | Participante | `/invitar casa` | Persona adentro, sin cuenta ni clave | F5 |
| UC-11 | [Compartir una memoria](#uc-11--compartir-una-memoria) | Dueño de la memoria | Elige espacio y categoría | Fila en `memory_space` | F5 |
| UC-12 | [Retirar lo compartido](#uc-12--retirar-lo-compartido) | Dueño de la memoria | Deja de compartir, o sale | Relación borrada + aviso al espacio | F5 |
| UC-13 | [Categorías del espacio](#uc-13--categorías-del-espacio) | Participantes | Alguien o el bot propone | Aplicada, rechazada o caducada | F5 |
| UC-14 | [Corregir, ocultar, purgar](#uc-14--corregir-ocultar-purgar) | Dueño | El dato está mal o no debía estar | Corrección aditiva; purga auditada | F0+ |
| UC-15 | [Reprocesar](#uc-15--reprocesar) | Sistema | Mejora el carril, prompt o schema | Derivados regenerados desde el blob | F1+ |
| UC-16 | [Respaldo cifrado](#uc-16--respaldo-cifrado) | Sistema | Corre el backup programado | Respaldo off-site cifrado y probado | F0 |

**Cuatro caen en F0–F1** (UC-01, UC-04, UC-14, UC-16): son los que dan un sistema usable
antes de que exista un solo LLM en el pipeline.

---

## UC-01 · Capturar desde el chat
**Actor:** el dueño · **Disparador:** manda un archivo, o escribe `/capture` · **Fase:** F0–F1

```mermaid
flowchart LR
  M["Archivo<br/>foto · audio · PDF · doc<br/>o /capture texto"] --> Q["Cola de ingesta"]
  Q -.->|"guardado ✓ en menos de 1 s"| M
  Q --> A["markitdown<br/>PDF, docx, xlsx, html"]
  Q --> B["visión LLM<br/>foto o PDF escaneado"]
  Q --> C["Whisper<br/>nota de voz"]
  A --> R["Memory<br/>blob + texto normalizado"]
  B --> R
  C --> R
```

**Guardar es explícito, y solo en el chat.** Un archivo se guarda con mandarlo —sin
comando, sin categoría, que es §3.1—; un texto suelto se consulta, y para guardarlo hay
que escribir `/capture`. Invierte §5 a propósito: en una conversación lo que escribes es
casi siempre una pregunta, y adivinarlo con una heurística dejaba preguntas guardadas
como memorias. Si la consulta no encuentra nada, la respuesta ofrece guardar ese texto
tal cual, a un toque: no se pierde.

**El acuse no espera al trabajo pesado.** La cola responde de inmediato y la
normalización corre después, por el carril que corresponda (§8.1). Siempre se intenta
markitdown primero —barato y determinista— y solo cae a visión si el resultado viene
pobre. El carril usado queda registrado en la Memory para poder reprocesar (UC-15).

> Reglas: **4** máximo una pregunta por captura.

---

## UC-03 · Aclarar y revisar
**Actor:** el bot pregunta, tú respondes · **Disparador:** baja confianza · **Fase:** F1–F2

```mermaid
flowchart LR
  X["Extracción con su confianza"] --> C{"¿confía?"}
  C -->|sí| V["status = verified"]
  C -->|no| P["1 pregunta al chat<br/>y solo una"]
  C -->|no| B["Bandeja de revisión<br/>todo lo demás, después"]
  P --> R["Respondes"]
  R --> V
  B --> R2["Revisas a tu ritmo"]
```

**La captura nunca se bloquea con preguntas.** Si el sistema duda, guarda igual: hace
como máximo una pregunta en el momento y difiere el resto. Guardar de más es barato;
perder algo por fricción es caro.

> Reglas: **4** máximo una pregunta por captura.

---

## UC-04 · Explorar y exportar
**Actor:** el dueño · **Disparador:** `/search` o listar una categoría · **Fase:** F0

```mermaid
flowchart LR
  S["/search seguro<br/>o /salud"] --> R["5 resultados<br/>nunca un muro de texto"]
  R --> M["más"]
  M --> R
  R --> F["refinar<br/>solo los de 2025"]
  F --> R
  R --> E["exportar"]
  E --> D["PDF al chat"]
```

**El volumen no se resuelve con una web, se resuelve exportando.** Paginación y
refinamiento conversacional cubren el día a día; cuando de verdad hay que revisar muchas
cosas, la respuesta es un documento generado y enviado al chat (§6.1).

> Reglas: **9** filtro por dueño y membresía en toda consulta.

---

## UC-05 · Preguntar en lenguaje natural
**Actor:** el dueño · **Disparador:** pregunta libre · **Fase:** F3

```mermaid
flowchart LR
  P["¿qué me recetaron en marzo?"] --> F["Filtro estructurado<br/>categoría + fecha"]
  F --> S["Búsqueda semántica<br/>dentro de ese subconjunto"]
  S --> G{"¿hay memoria de respaldo?"}
  G -->|sí| A["Respuesta + cita<br/>memory_id · fecha · link al original"]
  G -->|no| N["no lo tengo<br/>jamás una inferencia"]
```

**Sin memoria de respaldo no hay respuesta.** El filtro estructurado va primero para que
la búsqueda semántica trabaje sobre poco y acierte más. Una inferencia plausible sobre
una receta médica es peor que un vacío.

> Reglas: **1** nunca un dato sin cita · **5** salud: devolver, no interpretar · **9** filtro.

---

## UC-06 · Vigente, vencido o en conflicto
**Actor:** el dueño · **Disparador:** pregunta por un dato duro · **Fase:** F6

```mermaid
flowchart LR
  Q["¿cuál es mi deducible?"] --> F["Facts de tipo póliza_auto"]
  F --> C{"¿cuántas vigentes hoy?"}
  C -->|1| A["El dato, directo, con su cita"]
  C -->|0| B["El dato, marcado vencido<br/>se avisa antes del dato"]
  C -->|2 o más| D["Se muestran ambas<br/>tienes dos vigentes: auto A y auto B"]
```

**El empate no se resuelve en silencio.** Una regla de "gana la más reciente" escondería
la segunda póliza sin que te enteres: dos autos son dos pólizas vigentes, no un
reemplazo. La vigencia decide cuando puede; el empate se muestra.

> Reglas: **2** conflicto a la vista · **3** vencido se dice antes del dato.

---

## UC-07 · Playbook de urgencia
**Actor:** el dueño, bajo presión · **Disparador:** "choqué el auto" · **Fase:** F7

```mermaid
flowchart LR
  F["Facts guardados<br/>póliza, teléfonos"] -->|antes| G["Generador"]
  G --> P["Playbook de choque, ya armado"]
  U["choqué el auto"] -->|durante| P
  P --> R["Teléfono · póliza · deducible · pasos<br/>en menos de 2 s"]
  X["búsqueda semántica en vivo · 8 s"] -.->|descartada| R
```

**El único caso donde el flujo del tiempo se invierte:** la respuesta se computa antes de
que la pregunta exista. Chocado en la calle no es momento para esperar ocho segundos a
una búsqueda probabilística. Se regenera cada vez que cambia la póliza que lo alimenta.

> Reglas: **1** nunca sin cita · **5** salud: no interpretar.

---

## UC-08 · Nace una categoría
**Actor:** el dueño o el bot · **Disparador:** se pide, o se detecta un patrón · **Fase:** F2

```mermaid
flowchart LR
  A["crea migración<br/>camino explícito"] --> O{"¿se solapa con una existente?"}
  B["3 memorias no calzan<br/>el bot propone"] --> O
  O -->|"¿o la guardo en documentos?"| C["Confirmas tú · siempre"]
  C --> D["Categoría activa<br/>su description ES el prompt"]
  N["el bot propone, nunca crea solo"] -.- C
```

**No tienes que anticipar tus propias categorías.** El camino emergente es el que hace
que esto valga la pena: el sistema las descubre de tus datos. Pero sin el freno de la
confirmación, en seis meses tienes cuarenta categorías con la mitad solapadas.

> Reglas: **7** nunca crear, renombrar, archivar ni fusionar sin confirmación.

---

## UC-09 · Reorganizar categorías
**Actor:** el dueño · **Disparador:** renombrar, archivar o fusionar · **Fase:** F2

```mermaid
flowchart LR
  R["renombrar vehículo"] --> R2["auto · 31 memorias<br/>el id es la identidad: ninguna se entera"]
  A["archivar papeles"] --> A2["active = false<br/>fuera del clasificador, memorias buscables"]
  F["fusionar A en B"] --> F2["todo en B, A archivada"]
  D["borrado duro"] -.-> D2["no existe<br/>dejaría memorias huérfanas, o se las llevaría"]
```

**Fusionar es la que vas a usar el 90% de las veces** — *"esto de 'papeles' en realidad
era 'documentos'"*.

> Reglas: **7** confirmación · **8** confirmar lo irreversible.

---

## UC-10 · Crear espacio e invitar
**Actor:** cualquier participante · **Disparador:** `/invitar casa` · **Fase:** F5

```mermaid
flowchart LR
  I["/invitar casa<br/>cualquier participante"] --> L["Link de un solo uso"]
  L --> O["Abre el bot<br/>la app que ya usa a diario"]
  O --> D["Adentro"]
  D --> N["sin cuenta · sin contraseña · sin app nueva<br/>la identidad es el user id del canal"]
```

**El mayor beneficio práctico de ser solo chat.** No hay cuentas ni contraseñas porque la
identidad ya existe. Es lo que hace que invitar a un familiar sea realista y no una pelea
de soporte.

> Reglas: **11** nadie tiene autoridad sobre memorias ajenas.

---

## UC-11 · Compartir una memoria
**Actor:** el dueño de la memoria · **Disparador:** elige espacio y categoría · **Fase:** F5

```mermaid
flowchart LR
  M["Póliza auto 2026<br/>owner_id = tú · no cambia nunca"] --> S{"¿es sensible?"}
  S -->|"sí: confirma nombrando a quién se le muestra"| REL["fila en memory_space"]
  S -->|no| REL
  REL --> C["Espacio · Casa"]
  REL --> P["Espacio · Papás"]
```

**Compartir es una relación, no una transferencia.** La misma memoria puede verse en
varios espacios sin duplicarse —los blobs son direccionables por contenido— y todo el
control queda en quien la capturó. El default siempre es privado: nada se comparte por
inercia.

> Reglas: **10** nombrar a quién se muestra · **11** sin autoridad ajena.

---

## UC-12 · Retirar lo compartido
**Actor:** el dueño de la memoria · **Disparador:** deja de compartir, o sale · **Fase:** F5

```mermaid
flowchart LR
  U["dejar de compartir 1"] --> U2["borra 1 fila"]
  U2 --> AV1["aviso nombrando<br/>X dejó de compartir Póliza auto 2026"]
  S["salir del espacio"] --> S2["borra todas tus filas"]
  S2 --> AV2["aviso agregado<br/>X salió de Casa. 14 memorias ya no están disponibles"]
  U2 --> OK["El original: intacto<br/>nunca dejó de ser tuyo"]
  S2 --> OK
```

**Nada desaparece en silencio.** Es la contracara de que tus memorias se vayan contigo. El
aviso nombra la memoria porque quien estaba en el espacio **ya tenía acceso**: ocultar el
título no protegería nada y volvería el aviso inútil.

Límite honesto: retirar no es borrar de la cabeza del otro. Quien ya lo vio, ya lo vio —
y ahora sabe que lo retiraste.

> Reglas: **12** todo retiro se avisa · **11** sin autoridad ajena.

---

## UC-13 · Categorías del espacio
**Actor:** todos los participantes · **Disparador:** alguien o el bot propone · **Fase:** F5

```mermaid
flowchart LR
  P["¿creo colegio en Casa?<br/>lo propone quien sea, o el bot"] --> U{"Unanimidad<br/>todos los participantes"}
  U -->|todos sí| A["Aplicada"]
  U -->|un solo no| R["Rechazada al instante"]
  U -->|7 días sin respuesta| C["Caducada"]
```

**Sin dueño del espacio, la estructura se decide entre todos.** Pero la unanimidad
necesita salida por tiempo o se vuelve parálisis: basta con que uno no lea el chat para
congelar el espacio para siempre. Las propuestas se ven con `/proposals`.

Solo se vota **cambiar** categorías. Usar las que ya existen es libre — si no, compartir
se vuelve insoportable.

> Reglas: **7** confirmación de todos los participantes.

---

## UC-14 · Corregir, ocultar, purgar
**Actor:** el dueño · **Disparador:** el dato está mal, o no debía estar · **Fase:** F0+

```mermaid
flowchart LR
  M["Memory guardada<br/>el blob es sagrado"] --> C["corregir<br/>= agregar una memoria nueva"]
  M --> H["ocultar<br/>hidden = true, sigue existiendo"]
  M --> P["purgar<br/>datos de otra persona, la foto equivocada"]
  C --> O["El original sigue ahí<br/>¿qué cubría mi póliza en marzo? sigue teniendo respuesta"]
  H --> O
  P --> L["Confirmación explícita + log de auditoría"]
```

**Append-only, con una excepción honesta.** Prometer "es imposible borrar" es una promesa
que se rompe el día que la necesitas.

> Reglas: **8** confirmar lo irreversible.

---

## UC-15 · Reprocesar
**Actor:** el sistema · **Disparador:** mejora el carril, el prompt o el schema · **Fase:** F1+

```mermaid
flowchart LR
  B["Blob original<br/>jamás se toca · lo único irrecuperable"] --> T["texto normalizado"]
  B --> C["categoría y título"]
  B --> F["datos tipados"]
  M["Mejora el prompt, el carril o el schema"] --> T
  M --> C
  M --> F
```

**Todo lo derivado es regenerable, y por eso el original es sagrado.** Es lo que te deja
mejorar la extracción sin miedo: se reprocesa el histórico completo desde los blobs, sin
pérdida.

---

## UC-16 · Respaldo cifrado
**Actor:** el sistema · **Disparador:** corre el backup programado · **Fase:** F0

```mermaid
flowchart LR
  subgraph SRV["Un solo host · self-hosted"]
    A["App"] --> G["Garage"]
    P["Postgres"]
  end
  G --> BK["Backup off-site<br/>cifrado con restic o age"]
  P --> BK
  BK --> RE["Restaurado al menos una vez<br/>uno que nunca se restauró no existe"]
  ATT["Quien entra al host"] -.->|"se lleva todo: cifrar blobs no lo detiene"| SRV
```

**Se cifra solo lo que sale del host.** Dentro del VPS, app, storage y claves conviven:
un cifrado cuya llave está al lado de la cerradura es ceremonia. El backup off-site es el
único lugar donde los datos duermen en infraestructura ajena, y ahí sí es obligatorio.

La passphrase del backup la guardas tú: se muestra una vez y no hay recuperación.

Antes que cualquier cifrado de blobs van: **cifrado de disco del host**, Postgres y Garage
sin puerto expuesto, secretos fuera del repo, y un backup restaurado.

**Y la incomodidad que ordena las prioridades:** el texto en claro ya sale de la caja por
diseño —al proveedor de LLM y por un chat que no es E2E—. Los controles que mueven la
aguja son un proveedor con retención cero y asumir conscientemente qué ve Telegram.

> Asume self-hosted, un dueño, un host. Si eso cambia, el cálculo se rehace (§14.2).
