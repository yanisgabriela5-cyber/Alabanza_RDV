// Datos públicos del proyecto Supabase (la publishable key es pública por diseño;
// la seguridad la dan las reglas RLS de la base de datos).
// NUNCA poner aquí la secret key ni la service_role.
export const SUPABASE_URL = 'https://xkzdtxughatqjoumrfgi.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_USQw2RbfDXBQ9vtC8Qt9NA_-079SlOi';

// Notificaciones push: clave PÚBLICA VAPID (la privada va solo en Supabase → Edge Functions → Secrets).
// Se genera con:  npx web-push generate-vapid-keys
export const VAPID_PUBLIC_KEY = '';

export const APP_NOMBRE = 'Roca de Vida · Alabanza';

export const INSTRUMENTOS = {
  voz: 'Voz',
  piano: 'Piano / Teclado',
  guitarra: 'Guitarra acústica',
  guitarra_electrica: 'Guitarra eléctrica',
  bajo: 'Bajo',
  bateria: 'Batería',
  percusion: 'Percusión menor',
  otro: 'Otro',
};

// Pestañas de notas dentro de cada canción
export const NOTAS_TABS = { general: 'General', ...Object.fromEntries(Object.entries(INSTRUMENTOS).filter(([k]) => k !== 'otro')) };

export const REACCIONES = ['🙌', '🔥', '❤️', '🙏', '👍'];

// Roles para el equipo de cada día
// "Dirige" ya no es un rol aparte: es una marca (asignaciones.dirige) sobre una Voz.
export const ROLES = {
  voz: 'Voz',
  piano: 'Piano / Teclado',
  guitarra: 'Guitarra acústica',
  guitarra_electrica: 'Guitarra eléctrica',
  bajo: 'Bajo',
  bateria: 'Batería',
  percusion: 'Percusión menor',
  otro: 'Otro',
};
export const ROLES_CANTO = ['voz'];

export const ICON_INSTR = { general: '📄', voz: '🎤', coros: '🎤', piano: '🎹', guitarra: '🎸', guitarra_electrica: '🎸', bajo: '🎸', bateria: '🥁', percusion: '🪘', otro: '🎵' };
