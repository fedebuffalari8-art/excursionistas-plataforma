# Conexión automática con Instagram — Excursionistas

Esto hace que la plataforma traiga los datos de Instagram **sola, para siempre**, sin que nadie tenga que pegar un token nunca más. Corre dentro del mismo Netlify que ya estás usando (no es una plataforma nueva).

Hay un solo paso técnico que no se puede evitar: conectar tu sitio de Netlify a un repositorio de GitHub, para que Netlify pueda ejecutar este código (las funciones) y no solo mostrar el HTML. Lo hacemos una vez y no se vuelve a tocar.

---

## Paso 1 — Crear el repositorio en GitHub

1. Entrá a `github.com` y creá una cuenta si no tenés (es gratis).
2. "New repository" → nombre, por ejemplo `excursionistas-plataforma` → "Create repository".
3. En el repo vacío, clickeá **"uploading an existing file"**.
4. Arrastrá **todo el contenido de esta carpeta** (`netlify.toml`, `package.json`, la carpeta `netlify/` completa, y también el archivo `excursionistas_demo.html` — pero renombralo a `index.html` antes de subirlo, así Netlify lo muestra como página principal).
5. "Commit changes".

## Paso 2 — Conectar TU SITIO de Netlify existente a ese repositorio

Esto es importante: no creamos un sitio nuevo, conectamos el que ya tenés (`taupe-choux-ee660f.netlify.app`) para que mantenga la misma dirección.

1. Entrá a tu panel de Netlify → el sitio "taupe-choux-ee660f".
2. **Site configuration** → **Build & deploy** → buscá la opción de **"Link repository"** / "Link site to Git".
3. Elegís GitHub, autorizás el acceso, y seleccionás el repositorio `excursionistas-plataforma` que creaste.
4. Build command: dejalo vacío o `echo "sin build"` (no hace falta compilar nada).
5. Publish directory: `.` (un punto, significa "la raíz").
6. Deploy.

A partir de ahora, cada vez que subas un cambio al repositorio de GitHub, Netlify va a actualizar el sitio solo.

## Paso 3 — Agregar las variables de entorno

En el panel de Netlify de tu sitio: **Site configuration** → **Environment variables** → "Add a variable", y agregás estas 3 (los mismos valores que ya tenés de developers.facebook.com):

| Variable | Valor |
|---|---|
| `META_APP_ID` | El App ID de tu app "Excursionistas" |
| `META_APP_SECRET` | El App Secret de la misma app |
| `ADMIN_SECRET` | Inventate cualquier texto largo y random |

Después de guardar las variables, hace falta un "redeploy" (Netlify tiene un botón para eso, o simplemente subís cualquier cambio chiquito al repo).

## Paso 4 — Agregar la nueva URL de redirección en Meta

En developers.facebook.com → tu app → Inicio de sesión con Facebook para empresas → Configurar, agregá a la lista de "URI de redireccionamiento de OAuth válidos" (sin borrar las que ya tenés):

```
https://taupe-choux-ee660f.netlify.app/.netlify/functions/ig-callback
```

(Si tu sitio tiene otro nombre, usá ese en su lugar.)

## Paso 5 — El último login manual de toda la vida

Visitá, una sola vez, reemplazando `TU_ADMIN_SECRET` por lo que pusiste en el Paso 3:

```
https://taupe-choux-ee660f.netlify.app/.netlify/functions/ig-login?key=TU_ADMIN_SECRET
```

Te va a pedir loguearte con Facebook y elegir la página del club, exactamente como las veces anteriores. La diferencia es que esta vez **el resultado lo guarda el servidor solo** — no hay ningún token para copiar ni pegar en ningún lado.

Cuando veas "✅ Conectado correctamente", listo. Abrí la plataforma y entrá a "Redes & Campañas" — debería decir "Conectado" y mostrar los datos reales.

---

## ¿Qué pasa después de esto?

- Todos los días a las 06:00 UTC, una función programada (`ig-daily.mjs`) corre sola: renueva el token si está por vencer, y guarda el número de seguidores del día — sin que nadie abra la plataforma.
- Cada vez que alguien entra a "Redes & Campañas", la plataforma le pregunta a `/.netlify/functions/ig-data` los datos más frescos.
- Si en algún momento el token se corta por algo fuera de lo normal (por ejemplo, alguien revocó el acceso desde Meta Business Suite), vas a ver "Sin conectar" en la plataforma, y la solución es repetir el Paso 5 una vez más.

## Seguridad

- Nunca compartas la URL de `/.netlify/functions/ig-login` con la clave incluida.
- El token nunca pasa por el navegador de nadie — vive únicamente en Netlify Blobs, del lado del servidor.
- No hace falta volver a tocar nada de esto durante meses, salvo que Meta cambie algo de su lado.
