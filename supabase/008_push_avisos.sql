-- =====================================================================
-- APP ALABANZA · Actualización 008 · Disparadores de notificaciones push
-- Requiere: 007_menciones_push.sql y la Edge Function "push" ya publicada.
-- ANTES DE EJECUTAR: cambia CAMBIA_ESTE_SECRETO (abajo) por el mismo valor
-- que pusiste en el secreto PUSH_SECRET de la Edge Function.
-- Se puede volver a ejecutar sin romper nada.
-- =====================================================================

create extension if not exists pg_net;
create extension if not exists pg_cron;

-- Secreto compartido con la Edge Function (se guarda cifrado en Vault)
do $$
begin
  if exists (select 1 from vault.secrets where name = 'push_secret') then
    perform vault.update_secret((select id from vault.secrets where name = 'push_secret'), 'CAMBIA_ESTE_SECRETO');
  else
    perform vault.create_secret('CAMBIA_ESTE_SECRETO', 'push_secret');
  end if;
end $$;

create or replace function public.llamar_push(cuerpo jsonb) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform net.http_post(
    url     := 'https://xkzdtxughatqjoumrfgi.supabase.co/functions/v1/push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-push-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'push_secret')),
    body    := cuerpo
  );
end $$;
revoke all on function public.llamar_push(jsonb) from public, anon, authenticated;

create or replace function public.avisar_push() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.llamar_push(jsonb_build_object(
    'type', tg_op, 'table', tg_table_name, 'record', to_jsonb(new),
    'old_record', case when tg_op = 'UPDATE' then to_jsonb(old) end));
  return new;
end $$;

drop trigger if exists trg_push_asig on public.asignaciones;
create trigger trg_push_asig after insert on public.asignaciones
  for each row execute function public.avisar_push();

drop trigger if exists trg_push_men on public.menciones;
create trigger trg_push_men after insert on public.menciones
  for each row execute function public.avisar_push();

drop trigger if exists trg_push_vivo on public.en_vivo;
create trigger trg_push_vivo after insert or update of activo on public.en_vivo
  for each row when (new.activo) execute function public.avisar_push();

drop trigger if exists trg_push_pub on public.publicaciones;
create trigger trg_push_pub after insert on public.publicaciones
  for each row execute function public.avisar_push();

-- Recordatorio diario: 5:00 pm de Panamá (22:00 UTC) avisa a quien sirve o ensaya mañana
select cron.schedule('push-recordatorio', '0 22 * * *', $$ select public.llamar_push('{"tipo":"recordatorio"}'::jsonb) $$);

-- Limpieza semanal del registro de enviados
select cron.schedule('push-limpieza', '0 8 * * 1', $$ delete from public.push_enviados where created_at < now() - interval '30 days' $$);
