// Datos públicos del proyecto Supabase (la publishable key es pública por diseño;
// la seguridad la dan las reglas RLS de la base de datos).
// NUNCA poner aquí la secret key ni la service_role.
export const SUPABASE_URL = 'https://xkzdtxughatqjoumrfgi.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_USQw2RbfDXBQ9vtC8Qt9NA_-079SlOi';

export const APP_NOMBRE = 'Roca de Vida · Alabanza';

export const INSTRUMENTOS = {
  voz: 'Voz principal',
  coros: 'Coros',
  piano: 'Piano / Teclado',
  guitarra: 'Guitarra acústica',
  guitarra_electrica: 'Guitarra eléctrica',
  bajo: 'Bajo',
  bateria: 'Batería',
  otro: 'Otro',
};

// Pestañas de notas dentro de cada canción
export const NOTAS_TABS = { general: 'General', ...Object.fromEntries(Object.entries(INSTRUMENTOS).filter(([k]) => k !== 'otro')) };

export const REACCIONES = ['🙌', '🔥', '❤️', '🙏', '👍'];
