# Desplegar VIRUS! en S3 + EC2, sin CloudFront

El código está preparado para un primer despliegue con un único proceso de juego. La prueba en Floci valida la separación, la espera y la recuperación. La puesta en marcha real requiere verificar DNS, certificado HTTPS, permisos del bucket y persistencia de la instancia.

## 1. Valores del ejemplo

Sustituye estos valores en todos los pasos:

| Valor | Ejemplo |
|---|---|
| Región | `us-east-1` |
| Bucket público, globalmente único y sin puntos | `virus-laboratorio-tunombre` |
| Dominio o subdominio del servidor | `juego.tudominio.com` |
| IP elástica de EC2 | `TU_IP_ELASTICA` |
| Perfil AWS real en tu Mac | `aws-real` |
| Sistema del servidor usado en esta guía | Ubuntu 24.04 LTS |

La entrada de jugadores será `https://virus-laboratorio-tunombre.s3.us-east-1.amazonaws.com/index.html`. API, WebSocket y administración usarán `https://juego.tudominio.com` y `wss://juego.tudominio.com`.

Esta guía usa el endpoint HTTPS de **objetos** de S3. No habilites "Static website hosting": su endpoint no admite HTTPS y no es el utilizado aquí. La URL debe incluir `/index.html`; no se configura un dominio propio para el frontend. [Endpoints de S3](https://docs.aws.amazon.com/AmazonS3/latest/userguide/WebsiteEndpoints.html), [nombres de bucket y HTTPS](https://docs.aws.amazon.com/AmazonS3/latest/userguide/VirtualHosting.html).

Para el servidor se necesita un nombre DNS que controles y que resuelva a EC2. Si todavía no dispones de ese nombre, resuélvelo antes de seguir la configuración de Caddy de esta guía. El navegador no podrá conectar una interfaz HTTPS a una API HTTP o un WebSocket `ws://` inseguros.

## 2. EC2: red y dirección estable

En la consola de EC2:

1. Asigna una Elastic IP y asóciala a tu instancia. Se mantiene al detener y volver a iniciar esa misma instancia.
2. En el proveedor de DNS de tu dominio crea un registro `A`: `juego.tudominio.com` → IP elástica. Puede ser cualquier proveedor DNS; no se requiere Route 53. Si existe un registro `AAAA`, debe apuntar a una IPv6 válida de esta instancia, o retirarse mientras utilizas solo IPv4.
3. La instancia debe estar en una subred pública con salida a Internet mediante un Internet Gateway.
4. En su Security Group permite las entradas de la siguiente tabla.

| Protocolo | Puerto | Origen |
|---|---|---|
| TCP / SSH | 22 | Tu IP pública `/32` |
| TCP / HTTP | 80 | `0.0.0.0/0` |
| TCP / HTTPS | 443 | `0.0.0.0/0` |

Los jugadores llegan directamente a EC2 desde sus navegadores; sus solicitudes no salen desde los servidores de S3. Por eso el puerto 443 debe admitir sus IP. Si sirves también IPv6, configura sus reglas equivalentes. Mantén 3000 sin publicar: la configuración adjunta lo utiliza solamente dentro de Docker. Si hay un firewall del sistema o una NACL personalizada, debe permitir el mismo tráfico y sus respuestas.

El disco raíz debe ser EBS y sobrevivir a la detención de la instancia. Confirma que tu laboratorio **detiene** la misma EC2 y no la termina o recrea cada cuatro horas. La IP y los volúmenes no garantizan persistencia si el laboratorio elimina recursos. [Elastic IP](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/elastic-ip-addresses-eip.html).

## 3. S3: crear y configurar el bucket

En S3 → Create bucket:

1. Tipo general purpose, región `us-east-1`, nombre único sin puntos.
2. Object Ownership: **Bucket owner enforced**, ACL deshabilitadas.
3. Cifrado SSE-S3; evita SSE-KMS para estos objetos anónimos públicos.
4. En Block Public Access conserva activados `BlockPublicAcls` e `IgnorePublicAcls`. Desactiva `BlockPublicPolicy` y `RestrictPublicBuckets` únicamente para este bucket público.
5. En Permissions → Bucket policy pega la política siguiente, reemplazando el nombre del bucket.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadPublicClient",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::virus-laboratorio-tunombre/*"
    }
  ]
}
```

La política permite leer objetos; no permite subirlos, borrarlos ni listar el bucket. Mantén el bucket dedicado a la interfaz. Si tu cuenta u organización fuerza Block Public Access, la configuración del bucket no podrá anularla: necesitarás que el administrador permita este uso. [Acceso público](https://docs.aws.amazon.com/AmazonS3/latest/userguide/granting-public-access.html), [bloqueo a nivel de cuenta y organización](https://docs.aws.amazon.com/AmazonS3/latest/userguide/access-control-block-public-access.html).

Deja "Static website hosting" desactivado. No hace falta CORS en el bucket: sus módulos y recursos se cargan desde el mismo origen; el servidor del juego aplica CORS para sus API de jugadores.

## 4. Preparar el cliente en tu Mac

Desde la carpeta del proyecto, con Node.js 22.13 o superior:

```sh
cd /Users/denzel/Personal/GPtin/Virus
npm ci
API_BASE_URL=https://juego.tudominio.com npm run build:client
```

El build configura automáticamente `wss://juego.tudominio.com` y el panel `https://juego.tudominio.com/admin`. Comprueba `dist/client/config.js`: no debe contener `localhost`, `3100` ni direcciones de Floci.

**Sube todo el contenido de `dist/client/` a la raíz del bucket.** La estructura resultante debe tener `index.html`, `app.js`, `config.js`, CSS, SVG, `shared/` y `vendor/` en la raíz correspondiente. No subas la carpeta contenedora `dist` o `client`.

Puedes hacerlo desde la consola con Upload → Add files / Add folder. Conserva `shared/` y `vendor/`. Para subir por AWS CLI, utiliza un perfil de AWS real y un endpoint explícito de AWS, no el perfil `floci`:

```sh
aws --profile aws-real \
  --region us-east-1 \
  --endpoint-url https://s3.us-east-1.amazonaws.com \
  s3 sync dist/client/ s3://virus-laboratorio-tunombre/ \
  --cache-control no-cache
```

No se incluye `--delete`, para no borrar objetos. El bucket debe estar dedicado a este cliente. La identidad de ese perfil necesita permisos para cargar los objetos y listar el bucket para `sync`; no escribas credenciales AWS dentro del cliente.

Los objetos HTML deben tener `Content-Type: text/html`; los JS, un tipo JavaScript válido como `text/javascript` o `application/javascript`; CSS, `text/css`. AWS CLI normalmente los detecta por extensión. Si has subido archivos mediante otra herramienta, revisa sus metadatos. El HTML debe abrirse en el navegador, no descargarse.

Nunca subas a este bucket `.env`, contraseñas, SQLite, `rooms.json`, claves, `data/`, `tmp/`, `node_modules/` ni el repositorio completo. El build excluye los archivos del panel; estos se sirven desde EC2.

## 5. Llevar el servidor a EC2

Sí, puedes usar el mismo repositorio. Para construir la imagen se necesitan `server/`, `shared/`, `public/`, `package.json`, `package-lock.json`, `Dockerfile`, `.dockerignore` y `deploy/`. Docker instala las dependencias; no necesitas instalar Node.js en EC2 ni copiar el `node_modules` del Mac.

Si usas `git clone`, primero asegúrate de que los cambios de esta sesión están incluidos en la versión remota que vas a clonar. Otra opción es copiar directamente la carpeta actual desde el Mac:

```sh
rsync -av \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude 'data/' \
  --exclude 'tmp/' \
  --exclude 'dist/' \
  --exclude '.env*' \
  --exclude '.aws/' \
  --exclude '.codex/' \
  --exclude '.agents/' \
  -e "ssh -i /ruta/a/TU_LLAVE.pem" \
  /Users/denzel/Personal/GPtin/Virus/ \
  ubuntu@TU_IP_ELASTICA:~/virus/
```

La barra final de la carpeta fuente copia su contenido a `~/virus/`. El usuario `ubuntu` corresponde a Ubuntu; Amazon Linux suele utilizar `ec2-user` y requiere sus propias instrucciones de instalación.

## 6. Instalar Docker en EC2

Conéctate por SSH. En Ubuntu 24.04, si Docker no está instalado, utiliza el repositorio oficial:

```sh
ssh -i /ruta/a/TU_LLAVE.pem ubuntu@TU_IP_ELASTICA
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
```

Crea `/etc/apt/sources.list.d/docker.sources`:

```sh
sudo tee /etc/apt/sources.list.d/docker.sources > /dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo docker compose version
```

Si ya tienes otra instalación de Docker, sigue la sección de compatibilidad y conflictos del proveedor antes de cambiar paquetes. [Instalación oficial de Docker en Ubuntu](https://docs.docker.com/engine/install/ubuntu/).

## 7. Configurar y arrancar en EC2

Dentro de `~/virus`:

```sh
cd ~/virus
cp deploy/production.env.example .env.production
chmod 600 .env.production
nano .env.production
```

Contenido mínimo, con tus valores reales:

```dotenv
GAME_DOMAIN=juego.tudominio.com
FRONTEND_ORIGINS=https://virus-laboratorio-tunombre.s3.us-east-1.amazonaws.com
```

`GAME_DOMAIN` es solo el nombre, sin `https://`, puerto ni ruta. `FRONTEND_ORIGINS` sí incluye `https://`, pero **no** `/index.html` ni barra final. No uses el endpoint `s3-website` ni `localhost`. Puedes dejar `ADMIN_PASSWORD` sin definir para que Node genere una contraseña privada, o definirla en este archivo con 12–256 caracteres. Las variables del build del cliente se configuran en el Mac, no en este archivo.

Valida y arranca:

```sh
sudo docker compose --env-file .env.production -f deploy/compose.aws.yaml config --quiet
sudo docker compose --env-file .env.production -f deploy/compose.aws.yaml up -d --build
sudo docker compose --env-file .env.production -f deploy/compose.aws.yaml ps
sudo docker compose --env-file .env.production -f deploy/compose.aws.yaml logs --tail=100 caddy virus
```

La configuración incluye Node sin puerto público, un único proceso de juego, Caddy en 80/443 y volúmenes persistentes para partidas y certificados. Caddy obtiene y renueva el certificado cuando DNS y los puertos son accesibles. Soporta WebSocket y conserva Host; sanea los encabezados de IP y protocolo que utiliza el servidor. `TRUST_PROXY=true` está limitado a esta configuración sin exposición directa de Node. No añadas un mapeo público de 3000. [HTTPS automático de Caddy](https://caddyserver.com/docs/automatic-https), [proxy y WebSocket](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).

Si no definiste contraseña de administrador, consúltala por SSH:

```sh
sudo docker compose --env-file .env.production -f deploy/compose.aws.yaml exec virus cat /app/data/admin-password.txt
```

Visita `https://juego.tudominio.com/admin`, inicia sesión y genera los accesos. Los datos nuevos son de producción: los códigos creados en Floci no se copian automáticamente.

## 8. Verificar el despliegue

1. Abre `https://juego.tudominio.com/health`. Debe responder JSON con `ok: true`, sin advertencias de certificado.
2. Abre `https://virus-laboratorio-tunombre.s3.us-east-1.amazonaws.com/index.html` en una ventana privada. Debe cargar la interfaz. Esa es la URL que debes compartir con jugadores.
3. Canjea un código nuevo, crea una sala y conecta otro navegador o dispositivo. Comprueba una partida y una jugada real.
4. Detén **la instancia de EC2** desde la consola. Recarga la URL de S3: debe seguir cargando y mostrar "El laboratorio está en espera" después de la comprobación.
5. Enciende la misma instancia. Docker y ambos servicios deben arrancar automáticamente. La interfaz de S3 reconecta cuando la API y WebSocket están listos.
6. Comprueba que accesos, historial y salas conservan sus datos. Los nuevos guardados pausan los plazos del juego durante la interrupción; las vigencias mantienen su fecha real.

No compartas la raíz `https://juego.tudominio.com/` como entrada principal: depende de EC2 y no puede mostrar la espera cuando la instancia está apagada. La entrada persistente es S3.

## 9. Reinicios, actualizaciones y respaldo

`restart: unless-stopped` y Docker habilitado al inicio permiten arrancar tras una detención/encendido de EC2. Si tú detienes los contenedores manualmente con `docker compose stop` o `down`, deberás levantarlos con `up -d` nuevamente. [Políticas de reinicio de Docker](https://docs.docker.com/engine/containers/start-containers-automatically/).

Para actualizar el servidor, copia los cambios y repite `up -d --build` con el mismo archivo y nombre de proyecto. Para actualizar la interfaz, repite el build con la dirección HTTPS real y vuelve a subir `dist/client/`. Conserva `.env.production` durante copias o actualizaciones.

Los datos se guardan en el volumen `virus-laboratorio-aws_virus-data`, sobre el disco de EC2. Los certificados viven en los otros volúmenes. **No ejecutes `docker compose down -v`** si necesitas conservarlos. Detener EC2 no elimina estos volúmenes si conserva su EBS.

Para una copia consistente del juego, detén solo el servicio y copia todo el directorio, incluyendo la clave de cifrado:

```sh
sudo docker compose --env-file .env.production -f deploy/compose.aws.yaml stop virus
sudo docker compose --env-file .env.production -f deploy/compose.aws.yaml cp virus:/app/data ./respaldo-virus
sudo docker compose --env-file .env.production -f deploy/compose.aws.yaml up -d virus
```

Usa una carpeta nueva para cada respaldo y guarda la copia fuera de la instancia, en almacenamiento privado. Si necesitas migrar datos existentes, detén el servicio, restaura el directorio completo en `/app/data`, conserva `access-code.key`, ajusta el propietario a `node:node` y vuelve a arrancar. Una copia de SQLite sin su clave no basta para recuperar los códigos consultables.

## Problemas frecuentes

| Síntoma | Qué revisar |
|---|---|
| S3 devuelve 403 | Nombre/región correctos, objetos presentes, política, bloqueos de cuenta/organización y cifrado SSE-S3 |
| HTML se descarga o JS no carga | Content-Type de los objetos y estructura de `shared/` / `vendor/` |
| Siempre muestra espera | `/health`, DNS, certificado, 443, configuración de `dist/client/config.js`, `FRONTEND_ORIGINS` exacto y WebSocket |
| Caddy no obtiene certificado | Registro A/AAAA, propagación, puertos 80/443, otros procesos ocupando esos puertos y reglas de la cuenta |
| Funciona la API pero no el juego | URL `wss://`, saludo WebSocket y origen permitido |
| Tras encender no arranca | `systemctl status docker`, `compose ps`, logs y si se detuvieron manualmente los contenedores |
| Desaparecieron los datos | Que sea la misma instancia, mismo EBS, mismo nombre de proyecto/volumen y que no se haya ejecutado `down -v` |

No se ha probado aquí una carga de producción ni se han creado recursos en AWS real.
