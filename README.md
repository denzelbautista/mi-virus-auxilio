# VIRUS! · El laboratorio

Adaptación independiente y jugable en español de VIRUS!, basada en `Virus.pdf`. Arte vectorial original, cartas planas con selección elevada y lanzamiento con perspectiva, fondo de Three.js y multijugador real mediante WebSocket.

![Vista de una partida con cuatro jugadores](docs/vista-previa.jpg)

## Abrir el juego

Requiere Node.js 22 o superior.

```sh
npm install
npm start
```

Abre http://localhost:3000. Escribe tu nombre y crea una sala. Elige entre 2 y 8 plazas al crear la sala y comparte el enlace o el código con hasta siete amigos. El anfitrión puede comenzar con al menos dos participantes. La práctica usa la cantidad de plazas seleccionada y añade hasta siete bots.

En una misma red, los demás entran desde `http://IP-DE-TU-COMPUTADORA:3000`. Un enlace de localhost solo sirve en la computadora que ejecuta el servidor: para invitar desde otra computadora, abre primero la dirección IP de la red y copia la invitación desde allí. Para jugadores en redes diferentes, aloja este servidor en un servicio público que admita Node.js, WebSocket y almacenamiento persistente, con HTTPS. No basta con subir los archivos HTML a un alojamiento estático.

## Jugar

- Primer clic: selecciona y eleva la carta. Segundo clic: juega un órgano o un guante, o permite elegir un destino. También puedes pulsar «Jugar carta».
- Los destinos válidos brillan en verde. Virus y medicinas permiten escoger cualquier cuerpo, incluido el propio.
- Trasplante: escoge dos órganos entre dos jugadores cualesquiera. Error médico: escoge un rival. Contagio: elige una distribución máxima de tus virus; se propone una válida automáticamente.
- «Cambiar cartas»: la carta seleccionada se conserva y queda marcada para cambiar. Puedes añadir otras cartas o desmarcarlas y luego confirmar. Es una acción completa de turno.
- Las cartas robadas se reponen automáticamente. No se permite pasar sin jugar o descartar.
- Cuatro órganos diferentes sanos, vacunados o inmunizados ganan. El multicolor cuenta como órgano independiente: puedes tener cinco y ganar con cuatro sanos.
- Haz clic en un órgano para inspeccionar sus virus y vacunas. La ayuda contiene todas las reglas, tratamientos y aclaraciones multicolor. Escape cancela la selección.

Mazo base de 68 cartas (2 a 4 participantes): 21 órganos (5 de cada color básico y 1 multicolor), 17 virus (4 de cada color básico y 1 multicolor), 20 medicinas (4 por color, incluido multicolor), y 10 tratamientos (1 trasplante, 3 ladrones, 2 contagios, 3 guantes y 1 error médico). Al agotarse el mazo, se voltea el descarte sin barajar.

Para 5 a 8 participantes, esta adaptación usa una variante con mazo ampliado. Se multiplica la cantidad original de cada combinación de tipo y color, y de cada tratamiento, por `participantes / 4` y se redondea a la carta más cercana. Los cuatro colores básicos conservan exactamente la misma cantidad entre sí. Cada copia tiene su propio identificador y el mismo diseño; los órganos multicolor siguen siendo un color independiente y no se pueden repetir en un cuerpo.

| Participantes al comenzar | Cartas totales |
|---|---|
| 2–4 | 68 |
| 5 | 84 |
| 6 | 107 |
| 7 | 121 |
| 8 | 136 |

A ocho, la distribución es exactamente el doble: 42 órganos, 34 virus, 40 medicinas y 20 tratamientos. El tamaño depende de quienes comienzan la partida, no de las plazas libres. El mazo queda fijo durante la partida, incluso si hay eliminaciones; una revancha recalcula el mazo para los participantes que queden. Se conservan manos de tres cartas y la victoria con cuatro órganos sanos. El reglamento comercial indica 2 a 6 jugadores; el ajuste del mazo y la opción de ocho son reglas de esta adaptación. Las pruebas de partidas completas verifican conservación y victorias; el equilibrio entre jugadores humanos puede afinarse con partidas reales.

![Mesa ampliada con ocho jugadores, ajustada a HD+](docs/mesa-adaptable-hd.png)

## Salas, privacidad y reconexión

El servidor es la autoridad sobre las jugadas. Cada sala tiene su propio estado, mazo, descarte, versión y temporizador. El cliente recibe solo su mano; los rivales se muestran con cartas ocultas. El servidor valida turno, pertenencia, revisión de mesa, destinos, tratamientos y capacidad antes de modificar el juego. Una sesión usa un token aleatorio que nunca se comparte en el enlace de invitación.

Al recargar o perder conexión, se retoma el mismo asiento desde esta pestaña. «Salir» de una partida online permite retomarla con «Reanudar sala» en el mismo navegador y pestaña durante cinco minutos. Cada turno humano dispone de 25 segundos para jugar o cambiar cartas. Al agotarse el tiempo, el jugador entra en piloto automático y la misma estrategia de los bots juega por él. Debajo del nombre propio se muestra la cuenta regresiva y, al activarse el piloto, los turnos restantes antes de la eliminación. Estos datos solo se envían al jugador afectado; los rivales no reciben el estado del piloto, su contador ni el plazo del turno. «Retomar control» permite volver a jugar. Una jugada manual válida o ese botón desactiva el piloto y reinicia el contador; una reconexión por sí sola no lo desactiva. Después de 15 turnos propios consecutivos en piloto automático, el jugador queda eliminado y todas sus cartas vuelven al mazo. La reposición por un guante cuenta como un turno automático cuando el piloto está activo. Los bots permanentes no acumulan este límite. Los jugadores desconectados también entran en piloto después de 25 segundos al llegarles el turno, mientras haya algún humano conectado. Al cumplir cinco minutos seguidos desconectado, queda eliminado: todas sus cartas, incluidos órganos, virus y medicinas sobre la mesa, se reintegran al mazo y este se baraja. La partida continúa con el siguiente jugador que corresponda, sin saltar a otro jugador por un cambio de índices. Si queda un solo jugador, gana por abandono aunque no tenga cuatro órganos sanos. Si todos son eliminados a la vez, la partida se cierra sin ganador. La reconexión antes del plazo cancela la eliminación. El plazo también libera asientos ausentes en el lobby y se conserva al reiniciar el servidor. El anfitrión pasa a un jugador que siga en la sala. Si no hay humanos conectados, los turnos se pausan, pero los plazos de ausencia siguen corriendo. Los bots no se añaden a partidas online ni quedan eliminados por desconexión.

El anfitrión inicia la primera partida. Al terminar, cualquier participante que siga en la sala puede solicitar una revancha. Quien la solicita confirma su plaza y abre una invitación de 90 segundos para los demás. Cada uno puede confirmar o rechazar; los bots aceptan automáticamente. Si todos responden antes, la revancha empieza con los confirmados conectados. Si quedan respuestas pendientes, se espera hasta el plazo original, sin prolongarlo por respuestas ni reconexiones. Al vencer, solo participan los confirmados que estén conectados; hacen falta al menos dos. Con menos de dos, se cancela la invitación y se conserva el resultado. Quienes no participan reciben un aviso y pueden abrir otra sala. El mazo se recalcula para los nuevos participantes y los contadores de piloto automático se reinician. Si abandona el lobby, el siguiente jugador pasa a ser anfitrión. Las partidas se guardan en `data/rooms.json` después de cada cambio, mediante escritura temporal y renombrado. Tras reiniciar el servidor, los jugadores pueden reconectarse a su partida. Las salas vacías del lobby caducan a los 30 minutos; las partidas sin humanos conectados, a las 24 horas. Si el archivo de estado está dañado, el servidor se detiene para evitar sobrescribirlo.

El sistema está diseñado para **un proceso de servidor** con múltiples salas. No ejecutes varias instancias contra el mismo archivo. Para escalar a varios servidores necesitarás almacenamiento compartido, coordinación de salas y afinidad de conexión; el motor de reglas puro permite esa evolución.

## Configuración

| Variable | Por defecto | Uso |
|---|---|---|
| `PORT` | `3000` | Puerto HTTP y WebSocket |
| `HOST` | `0.0.0.0` | Dirección de escucha |
| `MAX_PLAYERS` | `8` | Límite del servidor entre 2 y 8; cada nueva sala elige su capacidad |
| `MAX_ROOMS` | `500` | Límite de salas por proceso, no garantía de carga |
| `STATE_FILE` | `data/rooms.json` | Archivo persistente privado |
| `DISCONNECT_TIMEOUT_MS` | `300000` | Plazo de ausencia antes de la eliminación (5 minutos) |
| `TURN_TIMEOUT_MS` | `25000` | Tiempo de un turno humano antes del piloto automático |
| `AUTO_TURN_LIMIT` | `15` | Turnos propios en piloto antes de eliminar al jugador |
| `AUTO_DELAY_MS` | `1800` | Pausa entre acciones automáticas, en milisegundos |
| `REMATCH_TIMEOUT_MS` | `90000` | Tiempo para confirmar una revancha (1:30) |

Las salas conservan la capacidad con la que fueron creadas, incluidas las partidas guardadas de cuatro plazas. El selector de nuevas salas ofrece de 2 a `MAX_PLAYERS` plazas (4 preseleccionadas). Las mesas de 5 a 8 jugadores distribuyen hasta tres rivales al frente y dos en cada lateral; en pantallas estrechas, los rivales aparecen en una cuadrícula. Durante la partida, la mesa completa se ajusta al espacio disponible bajo el encabezado, sin desplazamiento de la página. Las cartas conservan sus proporciones y el ajuste se recalcula al cambiar el tamaño de la ventana o la orientación. Los detalles de órganos y las reglas siguen disponibles en sus ventanas habituales.

## Pruebas

```sh
npm test
```

Pruebas del motor: distribución y escalado del mazo hasta ocho, manos privadas, colores, inmunidad, curas, vacunas, extirpación, cinco tratamientos, contagio máximo, guante, turnos, descarte, reciclaje del mazo, victorias y 68 partidas generadas completas entre 4 y 8 participantes, con conservación de todas las cartas. Pruebas del servidor: ocho clientes simultáneos, capacidades por sala, límite de ocho, siete bots, orden completo de turnos, reinicio de partidas ampliadas, cuatro clientes en salas anteriores, una segunda partida independiente, sala llena, acciones inválidas, revisiones antiguas, acceso del anfitrión, sesión privada, reconexión, sustitución de conexión, recuperación tras reinicio y eliminación por ausencia, devolución íntegra de cartas, avance correcto de turnos y victoria por abandono. También se verifican el plazo fijo del turno, activación y recuperación del piloto, eliminación en el turno automático número 15, devolución de todas las cartas, revancha solicitada por un invitado, confirmaciones simultáneas, rechazo, falta de participantes, vencimiento con mazo recalculado y recuperación de una invitación después de reiniciar. Los tests acortan los plazos mediante las variables de configuración; en el juego normal son 25 segundos, 15 turnos automáticos, 90 segundos para la revancha y cinco minutos para desconexión. Se usan servidores temporales y un archivo separado; no se modifica la partida de desarrollo.

## Alojamiento

```sh
docker compose up --build -d
```

El volumen `virus-data` conserva las partidas. Coloca un proxy con HTTPS delante del puerto 3000 y habilita la actualización WebSocket. Mantén el encabezado `Host` del navegador al reenviar solicitudes: se comprueba que el origen coincida con él. Respalda el volumen y no publiques su contenido. Endpoint de estado: `/health`.

Este repositorio incluye la configuración de despliegue, pero no está publicado en Internet. La prueba local no equivale a una prueba de carga de 500 salas.

## Estructura

`shared/game.js`: reglas puras, acciones válidas y vista privada por jugador. `server/index.js`: salas, sesiones, WebSocket, bots y persistencia. `public/app.js`: interfaz y animaciones. `public/art.js`: ilustraciones y cartas SVG. `public/scene.js`: fondo de Three.js. `public/style.css`: diseño adaptable y movimiento reducido. `public/expanded.css`: salas y mesa ampliada hasta ocho, con distribución adaptable. `public/table.css`: mesa sin distorsión de perspectiva, manos laterales en columna, mano frontal en fila, órganos con virus y medicinas superpuestos y descarte apilado. `public/viewport.js` y `public/viewport.css`: ajuste proporcional de la mesa al espacio real del navegador, con separación de nombres y controles en pantallas pequeñas. `public/turn-cue.js` y `public/turn-cue.css`: flechas y resalte breve al cambiar el turno.

## Referencias

- Reglamento adjunto: `Virus.pdf`.
- [Aclaraciones oficiales de VIRUS!, Tranjis Games](https://tranjisgames.com/blog/nuestros-juegos-7/virus-preguntas-frecuentes-9), especialmente las interacciones multicolor.
- [UNO para PC, Ubisoft](https://www.ubisoft.com/en-gb/games/uno), además de las capturas adjuntas, como referencia de mesa, mano visible, selección y lanzamiento.

VIRUS! es de Tranjis Games. Esta es una adaptación independiente sin afiliación. Las ilustraciones son originales de este proyecto; no se reutilizan las ilustraciones comerciales del PDF o de las fotos.
