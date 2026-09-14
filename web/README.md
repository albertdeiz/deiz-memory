# La web

Administrar lo guardado (§15). **No captura**: para guardar algo, el chat.

```bash
npm run up             # levanta todo, la web incluida
open http://127.0.0.1:4318
dm pair --web          # el código para entrar
```

En desarrollo, con recarga en caliente:

```bash
dm api                      # o el contenedor `api`, da igual
npm --prefix web run dev
```

## Cómo está armada

```
src/shared/api/     client (lo único que habla HTTP) · types · keys
src/shared/ui/      primitivas y el QueryProvider
src/features/       session · memories · domains · facts · review
  <feature>/queries.ts   los hooks de React Query de esa feature
  <feature>/*.tsx        sus componentes
src/app/            el shell: layout, página, estilos
  entrar/           canjea el link de `dm pair --web`
  api/[...path]/    el proxy a `dm api`, resuelto en cada request
```

**Una sola capa habla HTTP.** Por encima de `shared/api/client` todo trata con datos y con
`ApiError`; nadie más importa `fetch`. Es el mismo trato que el core hace con sus puertos
y compra lo mismo: el día que cambie el transporte, cambia un archivo.

**Por feature y no por tipo de archivo.** Los hooks de memorias viven al lado de las
pantallas de memorias. Carpetas `components/` y `hooks/` globales obligan a abrir dos
lugares para entender una cosa.

**Las claves de React Query están enumeradas en un archivo.** Curar una memoria la mueve
de categoría, puede vaciar la bandeja de revisión y cambia lo que devuelve una búsqueda;
invalidar solo la fila editada es como una pantalla termina mostrando una categoría que ya
no contiene lo que lista.

## Lo que no hace, y es a propósito

**No captura.** Sin formulario de subida, sin arrastrar archivos. Capturar por chat cuesta
un gesto y §3.1 lo protege; una web que también capturara competiría con el único camino
que ya funciona.

**No redacta.** Las respuestas de `ask` vienen del core. La web tiene sus propias palabras
—un tercer lugar donde una frase puede contradecir a las otras dos, y eso es el costo
honesto de tener interfaz— pero no compone respuestas sobre tus datos.

**No enruta**, salvo `/entrar`. Una herramienta que una persona abre para arreglar algo no
necesita deep links; el detalle es un panel al lado de la lista, porque curar es comparar.

## Una trampa que costó dos intentos

Al entrar, la caché tiene que quedar coherente, y el reflejo —`clear()` y después
`refetchQueries`— **no puede funcionar**: `refetchQueries` busca queries recorriendo la
caché, y `clear()` acaba de vaciarla, así que encuentra cero y no hace nada. El login
funcionaba, la cookie quedaba puesta, y la pantalla seguía en el formulario hasta recargar
a mano.

Al entrar se **invalida**, que marca como stale lo que existe y vuelve a pedir lo que se
observa. Y no hay nada que limpiar, porque deslogueado no había nada cacheado: toda ruta
de datos responde 401. Al salir sí se limpia —la caché tiene fichas de alguien— y la
sesión se **escribe** en vez de pedirse: `{authenticated: false}` ya es cierto.

## La sesión

`dm pair --web` acuña un código de un solo uso y 15 minutos (§10) e imprime un link a
`/entrar?code=…`. Esa página lo canjea al llegar y se quita del medio — el sentido de un
link sobre un código que copiar es que cueste un clic. Escribirlo a mano sigue estando,
en la pantalla de inicio, pero es el respaldo.

El canje se dispara **una sola vez**: un código es de un solo uso, así que dispararlo dos
veces lo quema y verías un error por un login que sí funcionó. React corre los efectos
dos veces en desarrollo, que es justo como aparecería.

La web lo cambia por una cookie `httpOnly` que la página no puede leer. No hay registro,
ni contraseña, ni recuperación.

**"Salir" cierra todas las sesiones**, que es lo que "perdí el computador" necesita.

El token se guarda hasheado y la tabla queda **fuera del respaldo**: restaurar un snapshot
tiene que dejarte deslogueado, no devolverte sesiones revocadas.
