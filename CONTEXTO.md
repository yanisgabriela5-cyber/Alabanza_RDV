# Contexto del proyecto · App Alabanza RDV

> Para retomar en una conversación nueva con Claude: pega este texto (o pide que lea `CONTEXTO.md` del repo `yanisgabriela5-cyber/Alabanza_RDV`) y di qué quieres hacer.

## Qué es
App web instalable (PWA, funciona en iPhone y Android) para el **Ministerio de Alabanza de Roca de Vida Panamá** (~30 integrantes: cantores, coros, batería, piano, guitarras, bajo).
Costo: **$0** (GitHub Pages + plan gratis de Supabase).

## Dónde está todo
| Qué | Dónde |
|---|---|
| App publicada | https://yanisgabriela5-cyber.github.io/Alabanza_RDV/ |
| Código | https://github.com/yanisgabriela5-cyber/Alabanza_RDV (rama `main`, GitHub Pages desde `main` / root) |
| Backend | Supabase, organización "Ministerio de alabanza RDV", proyecto **Alabanza RDV** (ref `xkzdtxughatqjoumrfgi`, región us-west-2) |
| URL Supabase | https://xkzdtxughatqjoumrfgi.supabase.co |
| Publishable key | En `js/config.js` (es pública por diseño). **La secret key nunca va en el código ni en el chat.** |
| Primer admin | yanisgabriela12@gmail.com |

## Tecnología
- HTML/CSS/JS puro, sin compilación. Archivos: `index.html`, `programa.html`, `css/styles.css`, `js/app.js` (toda la app), `js/programa.js` (programa del día), `js/acordes.js` (transposición), `js/cifrado.js` (grilla de compases), `js/config.js` (claves públicas, instrumentos, roles), `sw.js` (offline y push, va en la raíz), `manifest.webmanifest`, `icons/` (logo Roca de Vida).
- Supabase: login con correo/contraseña, base de datos Postgres con seguridad RLS, almacenamiento de imágenes (bucket `media`, 10 MB) y tiempo real.
- Librería: `@supabase/supabase-js@2.45.4` desde jsDelivr.
- Tema oscuro, dorado como color de acento.

## Base de datos (scripts en `supabase/`, se ejecutan en SQL Editor)
1. `schema.sql` ✅ ejecutado: profiles, publicaciones, comentarios, reacciones, canciones, notas_cancion, tonos_cantante, setlists, setlist_items, bucket `media`.
2. `002_agenda.sql` ⏳ **confirmar si se ejecutó**: tipos_evento, asignaciones, en_vivo, columnas `tipo_evento_id` y `ensayo_fecha` en setlists, `setlist_id` y tipo `programa` en publicaciones.
3. `003_partituras.sql` ⏳ **confirmar si se ejecutó**: tabla partituras + bucket `partituras`.
4. `004_voz_dirige_chat.sql` ⏳ **confirmar si se ejecutó**: Voz unificada, marca Dirige, chat por evento, cifrado por canción.
5. `007_menciones_push.sql` ⏳ **confirmar si se ejecutó**: menciones en el chat, indisponibilidad por fechas, historial de canciones, metrónomo, suscripciones push.
6. `008_push_avisos.sql` ⏳ **confirmar si se ejecutó**: disparadores de push (requiere la Edge Function `push` y el secreto `PUSH_SECRET`).

7. `009_confirmaciones_recordatorios.sql` ⏳ **ejecutar**: estado Por confirmar, grupo @pendientes, recordatorio manual (`recordar_pendientes`) y automático (cron `recordar-confirmacion`, 9:00 am, a 7/3/1 días).

No existen 005 ni 006. Todos se pueden volver a ejecutar sin borrar datos.

## Permisos
- **Registro abierto, con aprobación:** quien se registra queda *pendiente* hasta que un admin lo aprueba en la pestaña **Equipo**.
- **Miembros:** ven todo; comentan y reaccionan; editan notas por instrumento; guardan su propio tono; confirman si pueden servir.
- **Admins:** publican en el muro; gestionan canciones, agenda, equipo del día, tipos y horarios; aprueban usuarios; controlan el modo en vivo.
- Para crear un admin desde SQL:
  ```sql
  update public.profiles set rol='admin', estado='aprobado' where email='correo';
  ```

## Funciones actuales
1. **Muro:** comunicados, frases, imágenes y videos de YouTube o Drive. Publicaciones fijadas, comentarios y reacciones en tiempo real. Banners de "Te toca servir" y "En vivo ahora". Tarjeta "Programa" con el resumen de un día.
2. **Canciones:** vista 📝 Letra / 🎼 Cifrado (grilla de compases estilo iReal: secciones A/B/C, 4 compases por fila, se transpone). Si la canción no tiene cifrado guardado se genera automático desde la letra (1 acorde = 1 compás) y el admin lo ajusta con ✏️ (sintaxis `*A Verso` / `| C#m | B/D# | E |`, `%` repite). Letra con acordes (`[G]letra` o acordes sobre la línea), transposición, cifrado americano o latino, tamaño de letra, notas por instrumento y tono guardado por cantante.
3. **Agenda:**
   - Calendario mensual con tipos de día:
     - 📖 Estudio bíblico: miércoles 8:00 pm, ensayo 6:30 pm.
     - ⛪ Servicio dominical: domingo 10:30 am. El día de ensayo lo define el admin.
     - ⭐ Actividad especial.
     - 🎹 Ensayo.
   - **Generar mes:** crea automáticamente los días recurrentes.
   - **Planificación:** tabla del mes por rol, con conteo de participación.
   - **Equipo del día:** cantores (rol único **Voz**, con marca 👑 **Dirige** por día) e instrumentistas; cada uno marca ✅ Puedo / 🤔 Por confirmar / ❌ No puedo. El admin ve el resumen y envía recordatorios 🔔 (manuales o automáticos).
   - **Chat del día:** conversación en tiempo real dentro de cada evento.
   - **Publicar en el muro** y **compartir por WhatsApp.**
4. **Modo en vivo:** un admin inicia desde el día y, al cambiar de canción, a todos les cambia la pantalla en el tono asignado. Cada uno ve arriba la nota general y la de su instrumento. Se puede pasar a modo "Libre".
5. **Editor de acordes:** botonera con los acordes del tono y modo "Tocar acordes" (tocar palabra → tocar acorde), sin escribir corchetes.
6. **Partituras:** fotos/PDF/links por canción e instrumento (pensado para batería); filtro "Con partitura"; botón "Ver mi partitura" en la canción y en vivo.
7. **Sin internet:** copia local de todo lo consultado + botón "Descargar para usar sin internet" en Mi perfil. Sin señal solo lectura.
8. **Mis días:** pestaña con los días de cada uno, su rol, confirmación, repertorio con indicadores (nota, partitura, BPM), ▶ Preparar y guardar sin internet.
9. **Cifrado iReal:** símbolos { } [ ] Z N1 N2 S Q f % x r n <texto> T34; importar links irealb:// (`js/cifrado.js` → `leerIreal`); borrador desde audio (`js/audio-cifrado.js`, se procesa en el celular).
10. **Equipo:** integrantes por instrumento; aprobar, nombrar admin, desactivar.

## Pendientes / próximos pasos
- [ ] Confirmar que se ejecutaron los scripts 002, 003, 004, 007 y 008, y ejecutar 009.
- [ ] Subir al repo el código de la Edge Function `push` (sin secretos) para no depender solo de Supabase.
- [ ] Desactivar "Confirm email" en Supabase (Authentication → Sign In / Providers → Email) por el límite de correos.
- [ ] Configurar en Supabase → Authentication → URL Configuration: Site URL y Redirect URL = `https://yanisgabriela5-cyber.github.io/Alabanza_RDV/`
- [ ] Definir el día y la hora de ensayo del Servicio dominical en ⚙️ Tipos y horarios.
- [ ] Rotar la secret key de Supabase (quedó expuesta en el chat original).
- [ ] Probar el modo en vivo con dos celulares en un ensayo real.
- [ ] Invitar al equipo (mensaje de WhatsApp con el link e instrucciones para instalar).

## Instrumentos
Voz, Piano / Teclado, Guitarra acústica, Guitarra eléctrica, Bajo, Batería, Percusión menor, Otro. ("Voz principal" y "Coros" se unificaron en "Voz".)

## En progreso (base de datos lista, confirmar en la app)
- Notificaciones push.
- Menciones en el chat del día (@persona, @todos, @voces, @musicos, @admins).
- Indisponibilidad por fechas.
- Historial de canciones y metrónomo.

## Ideas no implementadas aún
- Adjuntar audio de referencia a las canciones.
