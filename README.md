# Roca de Vida · Alabanza

App web instalable (PWA) para el equipo de alabanza: muro, canciones con acordes y transposición, tonos por cantante y ensayos/setlists.

- **Frontend:** HTML/CSS/JS sin compilación, publicado en GitHub Pages.
- **Backend:** Supabase (login, base de datos, imágenes, tiempo real).

## Puesta en marcha
1. **Base de datos:** Supabase → SQL Editor → una query por archivo, en este orden → Run:
   1. `supabase/schema.sql`
   2. `supabase/002_agenda.sql`
   3. `supabase/003_partituras.sql`
   4. `supabase/004_voz_dirige_chat.sql`
   5. `supabase/007_menciones_push.sql`
   6. `supabase/008_push_avisos.sql` (antes, cambiar `CAMBIA_ESTE_SECRETO` por el valor de `PUSH_SECRET`; requiere la Edge Function `push` publicada)
   7. `supabase/009_confirmaciones_recordatorios.sql`

   No existen 005 ni 006. Todos se pueden volver a ejecutar sin borrar datos.
2. **GitHub Pages:** Settings → Pages → Source: *Deploy from a branch* → `main` / `(root)`.
3. **URLs en Supabase:** Authentication → URL Configuration
   - *Site URL:* la URL de GitHub Pages (ej. `https://usuario.github.io/app-banda/`)
   - *Redirect URLs:* la misma URL.
4. **Primer admin:** registrarse en la app y ejecutar en SQL Editor:
   ```sql
   update public.profiles set rol = 'admin', estado = 'aprobado' where email = 'tu-correo@ejemplo.com';
   ```
   Los demás se aprueban desde la pestaña **Equipo**.

## Permisos
| Acción | Pendiente | Miembro | Admin |
|---|---|---|---|
| Ver contenido | — | ✅ | ✅ |
| Comentar y reaccionar | — | ✅ | ✅ |
| Notas por instrumento | — | ✅ | ✅ |
| Guardar su propio tono | — | ✅ | ✅ |
| Confirmar si puede servir un día | — | ✅ | ✅ |
| Agenda, equipo del día, publicar programa | — | — | ✅ |
| Controlar el modo en vivo | — | — | ✅ |
| Publicar en el muro | — | — | ✅ |
| Crear/editar canciones y ensayos | — | — | ✅ |
| Aprobar usuarios y asignar admins | — | — | ✅ |

## Mis días
Pestaña 🙋 **Mis días**: cada integrante ve sus próximos días con su asignación, botones para confirmar, el repertorio en el tono del día (📝 nota para su instrumento, 📄 partitura, BPM), con quién sirve y **▶ Preparar** para recorrer las canciones. **⬇ Sin internet** guarda ese día en el celular.

## Cifrado (estilo iReal Pro)
En la canción → 🎼 Cifrado → ✏️ Ajustar:
- Símbolos: `{ }` repetición, `[ ]` doble barra, `Z` barra final, `N1`/`N2` casillas, `S` segno, `Q` coda, `f` calderón, `%` o `x` repite compás, `r` repite 2 compases, `n` N.C., `<texto>` indicaciones, `T34` cambio de compás.
- **📥 iReal Pro**: pega un link `irealb://` y se convierte (y se pasa al tono original si hace falta).
- **🎤 Desde audio**: borrador de acordes, tono y BPM detectados en el celular. Siempre hay que revisarlo.

## Letras con acordes
- **Botonera de acordes:** en el editor aparecen los acordes del tono; se tocan para insertarlos donde está el cursor.
- **Modo "Tocar acordes":** se toca la palabra y luego el acorde (‹ › lo mueve dentro de la palabra; tocar un acorde permite cambiarlo o quitarlo).
- Formato recomendado: acorde entre corchetes antes de la sílaba → `[G]Cuan grande es [D]Él`
- También acepta acordes en la línea de arriba (formato clásico copiado de internet).
- Una línea que termina en `:` (`Coro:`) se muestra como sección.

## Estructura
```
index.html, programa.html, manifest.webmanifest
sw.js            service worker (debe ir en la raíz)
css/styles.css
js/app.js        toda la app
js/programa.js   página pública del programa del día
js/acordes.js    transposición
js/cifrado.js    grilla de compases
js/config.js     claves públicas, instrumentos, roles
icons/
supabase/        scripts SQL numerados
```
Al cambiar archivos de la app, subir la versión de `CACHE` en `sw.js` para que los celulares bajen la nueva.

## Configuración
`js/config.js` contiene la URL, la **publishable key** de Supabase y la clave **pública** VAPID (públicas por diseño). Nunca poner en este repositorio la secret key, la service_role, la clave privada VAPID ni `PUSH_SECRET`: van solo en Supabase → Edge Functions → Secrets.

## Agenda y modo en vivo
- **Tipos y horarios** (⚙️ en Agenda): día, hora y ensayo predeterminado de cada tipo (Estudio bíblico, Servicio dominical, etc.).
- **Generar mes**: crea todos los días recurrentes del mes sin duplicar.
- **Planificación**: tabla del mes con el equipo por rol; toca una celda para asignar.
- **Confirmación**: cada integrante asignado marca ✅ Puedo / 🤔 Por confirmar / ❌ No puedo.
- **Recordatorios**: en el día, un admin ve cuántos faltan por responder y toca 🔔 Recordar (a todos o a una persona). Además sale un recordatorio automático 7, 3 y 1 día antes a las 9:00 am. Llegan como mención en el chat del día (@pendientes) con notificación push.
- **Publicar en el muro**: publica el resumen del día (se actualiza solo si cambia).
- **En vivo**: un admin inicia y cambia de canción; a todos les cambia la pantalla, en el tono asignado y con la nota de su instrumento.

## Partituras y uso sin internet
- **Partituras:** en cada canción, fotos (varias páginas) o PDF o link, etiquetadas por instrumento. Las sube cualquier integrante; borra quien la subió o un admin. Bucket `partituras` (15 MB).
- **Sin internet:** todo lo que se abre queda guardado en el celular (IndexedDB). En *Mi perfil → Descargar para usar sin internet* se baja todo el repertorio, la agenda próxima y las partituras. Sin señal se puede ver, no publicar.
