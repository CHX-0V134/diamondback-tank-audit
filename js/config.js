// Supabase connection (public anon key — safe to ship; all access is gated by RLS + email whitelist)
window.APP_CONFIG = {
  SUPABASE_URL: 'https://kvixnerqxegaehpmfidh.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt2aXhuZXJxeGVnYWVocG1maWRoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM3MzkzNTQsImV4cCI6MjA3OTMxNTM1NH0.uFc8N4rUAkLlItV6OafSmmp0RAeN7y2fgaRaAXrCA9o',
  // Cache-busting version for the service worker; bump on each deploy.
  APP_VERSION: '1.7.0'
};
