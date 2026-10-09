# Roca de Vida · Alabanza

App web instalable (PWA) para el equipo de alabanza: muro, canciones con acordes y transposición, tonos por cantante y ensayos/setlists.

- **Frontend:** HTML/CSS/JS sin compilación, publicado en GitHub Pages.
- **Backend:** Supabase (login, base de datos, imágenes, tiempo real).

## Puesta en marcha
1. **Base de datos:** Supabase → SQL Editor → pegar `supabase/schema.sql` → Run.
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
| Publicar en el muro | — | — | ✅ |
| Crear/editar canciones y ensayos | — | — | ✅ |
| Aprobar usuarios y asignar admins | — | — | ✅ |

## Letras con acordes
- Formato recomendado: acorde entre corchetes antes de la sílaba → `[G]Cuan grande es [D]Él`
- También acepta acordes en la línea de arriba (formato clásico copiado de internet).
- Una línea que termina en `:` (`Coro:`) se muestra como sección.

## Configuración
`js/config.js` contiene la URL y la **publishable key** de Supabase (pública por diseño). Nunca poner la secret key en este repositorio.
