# Prueba local de S3 + EC2

Esta prueba utiliza Floci, AWS CLI con `--profile floci` y un endpoint explícito `http://localhost:4566`. Los scripts no se conectan a AWS real. Requiere Docker, Floci, AWS CLI, Node.js compatible con el proyecto y `npm install` ejecutado.

## Recursos

- Bucket `virus-laboratorio-local`, con lectura pública únicamente de objetos estáticos.
- Instancia EC2 emulada etiquetada `virus-laboratorio-local`, AMI `ami-alpine`, tipo `t3.small`. Floci la ejecuta como un contenedor Docker; el script instala Node.js y copia el servidor.
- Red Docker `virus-laboratorio-local` y relay `virus-laboratorio-floci-relay`. El relay publica el juego en **127.0.0.1:3100**, con un destino DNS estable dentro de Docker. Permite acceder al contenedor desde macOS sin depender de su IP interna.
- Identificador de la instancia en `tmp/floci/state.json`, contraseña local del panel en `tmp/floci/admin-password.txt` y, tras verificar, código de prueba en `tmp/floci/demo-access.txt`. `tmp/` está excluido de Git.

Se reutiliza Floci si ya está iniciado. El script no detiene el emulador ni modifica otros buckets. Si encuentra un bucket con el mismo nombre sin la etiqueta de este proyecto, se detiene para no sobrescribirlo.

## Preparación

```sh
floci start --persist=/Users/denzel/.floci/data
npm run floci:up
```

Si el contenedor `floci` ya está ejecutándose, no es necesario repetir `floci start`. Confirma que su montaje persistente apunta al directorio previsto. `floci:up` puede repetirse: actualiza los archivos, reinicia el proceso de juego de forma ordenada y conserva `/app/data`.

Direcciones locales:

| Servicio | URL |
|---|---|
| Interfaz desde S3 | http://localhost:4566/virus-laboratorio-local/index.html |
| Salud de Node | http://localhost:3100/health |
| Administración | http://localhost:3100/admin |

La contraseña del panel es la generada por el servidor, copiada a `tmp/floci/admin-password.txt`. No se sube a S3. Para obtener un acceso de jugador puedes generarlo desde el panel o ejecutar la verificación, que guarda uno de prueba en `tmp/floci/demo-access.txt`.

## Apagado y encendido

```sh
npm run floci:stop
npm run floci:status
npm run floci:start
```

`stop` envía SIGTERM al juego para guardar y cerrar SQLite, llama a `ec2 stop-instances` y espera el estado `stopped`. `start` llama a `ec2 start-instances`, espera `running`, arranca el juego y espera una respuesta válida de `/health`. Esperar ambos estados evita una carrera con las operaciones asíncronas de Floci.

El bucket permanece accesible durante el apagado. La interfaz comprueba salud y WebSocket con tiempos límite y reintentos crecientes hasta 30 segundos. Al estar disponible el servidor, vuelve al juego sin recargar. El botón «Volver a comprobar» adelanta el siguiente intento. Conserva accesos y sesión; una respuesta explícita de acceso inválido sí elimina ese acceso.

Las partidas con el nuevo checkpoint pausan los plazos de juego durante la interrupción. El vencimiento de los códigos y de las salas administradas continúa usando la fecha real. No se promete recuperar una sala que fue eliminada, venció o perdió sus archivos privados.

## Verificación

```sh
npm test
npm run floci:verify
```

Las pruebas del proyecto incluyen orígenes permitidos y rechazados, preflight de acceso, administración restringida a su origen y cuatro horas de interrupción simuladas en el guardado. La verificación de Floci comprueba tipos MIME de JavaScript, recursos desde S3, CORS, canje de un acceso, dos jugadores, una jugada real, apagado completo de EC2, disponibilidad de S3 durante el apagado y recuperación de mano, asiento, descarte y acceso. Deja la instancia encendida y genera un acceso de prueba con siete días de vigencia. Puede crear registros y salas de prueba en la base local.

## Persistencia y alcance

`/Users/denzel/.floci/data` conserva el estado del emulador, incluidos bucket y objetos. El juego guarda SQLite, salas, clave de cifrado y contraseña en `/app/data` dentro del contenedor de la instancia. Ese directorio sobrevive a `stop/start`; no elimines ni termines el contenedor si quieres conservar esos datos. Para respaldarlo, detén el juego y copia `/app/data` con `docker cp` antes de eliminar recursos.

Floci emula el ciclo de EC2 mediante Docker. El arranque de Node lo hace el script local porque esta AMI de contenedor no usa systemd. En EC2 real se configurará Docker con reinicio automático o un servicio systemd. El relay es exclusivamente una adaptación local; en AWS se utilizarán la IP elástica y el proxy HTTPS.

Esta prueba usa HTTP/WS local. No certifica HTTPS/WSS, certificados, DNS, Elastic IP, permisos IAM reales, reglas de seguridad de VPC, rendimiento de la EC2 de prueba ni las restricciones particulares de la cuenta. Esos puntos se comprobarán durante el despliegue real. La política pública de S3 se configura, pero su cumplimiento depende del modo de autorización del emulador; también debe validarse en AWS.

Referencia del emulador: [Floci](https://github.com/floci-io/floci).
