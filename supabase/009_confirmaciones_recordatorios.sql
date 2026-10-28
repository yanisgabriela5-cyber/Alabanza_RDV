-- =====================================================================
-- APP ALABANZA · Actualización 009 · Confirmaciones y recordatorios
--   1. Nuevo estado "Por confirmar" (Puedo / Por confirmar / No puedo)
--   2. Grupo de mención @pendientes (sin responder + por confirmar del día)
--   3. Recordatorio manual (admin): a todos los pendientes o a una persona
--   4. Recordatorio automático: 7, 3 y 1 día antes, 9:00 am de Panamá
-- Los recordatorios se envían como mención en el chat del día, así usan
-- la notificación push que ya existe (no hay que tocar la Edge Function).
-- Requiere: 004, 007 y 008 ejecutados.
-- Supabase → SQL Editor → New query → pegar todo → Run
-- Se puede volver a ejecutar sin romper nada.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. ESTADO "por_confirmar"
-- ---------------------------------------------------------------------
alter table public.asignaciones drop constraint if exists asignaciones_estado_check;
alter table public.asignaciones add constraint asignaciones_estado_check
  check (estado in ('pendiente','por_confirmar','confirmado','rechazado'));

-- ---------------------------------------------------------------------
-- 2. MENCIONES: se agrega el grupo @pendientes
-- ---------------------------------------------------------------------
create or replace function public.extraer_menciones() returns trigger
language plpgsql security definer set search_path = public as $$
declare g text;
begin
  insert into menciones (mensaje_id, perfil_id)
  select new.id, m[1]::uuid
  from regexp_matches(new.texto, '@\[[^\]]+\]\(([0-9a-f-]{36})\)', 'g') as m
  where exists (select 1 from profiles p where p.id = m[1]::uuid and p.estado = 'aprobado')
  on conflict do nothing;

  for g in select (regexp_matches(new.texto, '@\[(todos|voces|musicos|admins|pendientes)\]\(grupo\)', 'g'))[1] loop
    insert into menciones (mensaje_id, perfil_id)
    select distinct new.id, a.perfil_id from asignaciones a
    where a.setlist_id = new.setlist_id
      and (g = 'todos' or (g = 'voces' and a.rol = 'voz') or (g = 'musicos' and a.rol <> 'voz')
           or (g = 'pendientes' and a.estado in ('pendiente','por_confirmar')))
    union
    select new.id, p.id from profiles p where g = 'admins' and p.rol = 'admin' and p.estado = 'aprobado'
    on conflict do nothing;
  end loop;

  delete from menciones where mensaje_id = new.id and perfil_id = new.autor_id;
  return new;
end $$;

-- ---------------------------------------------------------------------
-- 3. FUNCIÓN BASE: escribe el recordatorio en el chat del día
--    Devuelve cuántas personas lo reciben.
-- ---------------------------------------------------------------------
create or replace function public._recordar(p_setlist uuid, p_perfil uuid, p_autor uuid, p_auto boolean)
returns int language plpgsql security definer set search_path = public as $$
declare
  n int;
  nom text;
  pre text := case when p_auto then '🔔 Recordatorio automático: ' else '🔔 Recordatorio: ' end;
  pie text := ' Entra al día y marca ✅ Puedo, 🤔 Por confirmar o ❌ No puedo. ¡Gracias!';
begin
  select count(distinct perfil_id) into n from asignaciones
  where setlist_id = p_setlist and estado in ('pendiente','por_confirmar')
    and (p_perfil is null or perfil_id = p_perfil)
    and perfil_id <> p_autor;
  if n = 0 then return 0; end if;

  if p_perfil is null then
    insert into mensajes_evento (setlist_id, autor_id, texto)
    values (p_setlist, p_autor, pre || '@[pendientes](grupo) aún falta que confirmen si pueden servir este día.' || pie);
  else
    select regexp_replace(coalesce(nombre, 'integrante'), '[\[\]()@]', '', 'g') into nom from profiles where id = p_perfil;
    insert into mensajes_evento (setlist_id, autor_id, texto)
    values (p_setlist, p_autor, pre || '@[' || nom || '](' || p_perfil || ') aún falta que confirmes si puedes servir este día.' || pie);
  end if;
  return n;
end $$;
revoke all on function public._recordar(uuid, uuid, uuid, boolean) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 4. RECORDATORIO MANUAL (solo admins). p_perfil null = todos los pendientes
-- ---------------------------------------------------------------------
create or replace function public.recordar_pendientes(p_setlist uuid, p_perfil uuid default null)
returns int language plpgsql security definer set search_path = public as $$
begin
  if not public.es_admin() then raise exception 'Solo un administrador puede enviar recordatorios'; end if;
  return public._recordar(p_setlist, p_perfil, auth.uid(), false);
end $$;
revoke all on function public.recordar_pendientes(uuid, uuid) from public, anon;
grant execute on function public.recordar_pendientes(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 5. RECORDATORIO AUTOMÁTICO: días con gente sin confirmar a 7, 3 y 1 día
--    El mensaje sale a nombre de quien creó el día (o de un admin) que
--    no esté pendiente, para que su propia mención no lo excluya.
-- ---------------------------------------------------------------------
create or replace function public.recordatorios_automaticos()
returns int language plpgsql security definer set search_path = public as $$
declare
  r record;
  autor uuid;
  total int := 0;
  hoy date := (now() at time zone 'America/Panama')::date;
begin
  for r in
    select s.id, s.creado_por from setlists s
    where (s.fecha at time zone 'America/Panama')::date - hoy in (7, 3, 1)
      and exists (select 1 from asignaciones a where a.setlist_id = s.id and a.estado in ('pendiente','por_confirmar'))
  loop
    select p.id into autor from profiles p
    where p.estado = 'aprobado' and (p.id = r.creado_por or p.rol = 'admin')
      and not exists (select 1 from asignaciones a where a.setlist_id = r.id and a.perfil_id = p.id
                      and a.estado in ('pendiente','por_confirmar'))
    order by (p.id = r.creado_por) desc
    limit 1;
    if autor is null then autor := r.creado_por; end if;
    if autor is not null then total := total + public._recordar(r.id, null, autor, true); end if;
  end loop;
  return total;
end $$;
revoke all on function public.recordatorios_automaticos() from public, anon, authenticated;

-- Todos los días a las 9:00 am de Panamá (14:00 UTC)
select cron.schedule('recordar-confirmacion', '0 14 * * *', $$ select public.recordatorios_automaticos() $$);
