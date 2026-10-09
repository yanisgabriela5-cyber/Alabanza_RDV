# Roca de Vida · Alabanza

App web instalable (PWA) para el equipo de alabanza: muro, canciones con acordes y transposición, tonos por cantante y ensayos/setlists.

- **Frontend:** HTML/CSS/JS sin compilación, publicado en GitHub Pages.
- **Backend:** Supabase (login, base de datos, imágenes, tiempo real).

## Puesta en marcha
1. **Base de datos:** Supabase → SQL Editor → pegar `supabase/schema.sql` → Run. Luego, cada uno en su propia query y en orden: `supabase/002_agenda.sql` y `supabase/003_partituras.sql` → Run.
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

## Letras con acordes
- **Botonera de acordes:** en el editor aparecen los acordes del tono; se tocan para insertarlos donde está el cursor.
- **Modo "Tocar acordes":** se toca la palabra y luego el acorde (‹ › lo mueve dentro de la palabra; tocar un acorde permite cambiarlo o quitarlo).
- Formato recomendado: acorde entre corchetes antes de la sílaba → `[G]Cuan grande es [D]Él`
- También acepta acordes en la línea de arriba (formato clásico copiado de internet).
- Una línea que termina en `:` (`Coro:`) se muestra como sección.

## Configuración
`js/config.js` contiene la URL y la **publishable key** de Supabase (pública por diseño). Nunca poner la secret key en este repositorio.

## Agenda y modo en vivo
- **Tipos y horarios** (⚙️ en Agenda): día, hora y ensayo predeterminado de cada tipo (Estudio bíblico, Servicio dominical, etc.).
- **Generar mes**: crea todos los días recurrentes del mes sin duplicar.
- **Planificación**: tabla del mes con el equipo por rol; toca una celda para asignar.
- **Confirmación**: cada integrante asignado marca ✅ Puedo / ❌ No puedo.
- **Publicar en el muro**: publica el resumen del día (se actualiza solo si cambia).
- **En vivo**: un admin inicia y cambia de canción; a todos les cambia la pantalla, en el tono asignado y con la nota de su instrumento.

## Partituras y uso sin internet
- **Partituras:** en cada canción, fotos (varias páginas) o PDF o link, etiquetadas por instrumento. Las sube cualquier integrante; borra quien la subió o un admin. Bucket `partituras` (15 MB).
- **Sin internet:** todo lo que se abre queda guardado en el celular (IndexedDB). En *Mi perfil → Descargar para usar sin internet* se baja todo el repertorio, la agenda próxima y las partituras. Sin señal se puede ver, no publicar.
