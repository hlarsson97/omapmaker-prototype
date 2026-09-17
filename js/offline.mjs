// Cache only the app shell. Account responses and map APIs are never cached here.
export async function prepareOffline() {
  if (!('serviceWorker' in navigator)) throw new Error('Offlineöppning stöds inte i den här webbläsaren');
  await navigator.serviceWorker.register('./sw.js');
  const registration = await Promise.race([navigator.serviceWorker.ready, new Promise((_, reject) => setTimeout(() => reject(new Error('Offlineförberedelsen blev inte klar. Kontrollera anslutningen och försök igen.')), 20000))]);
  return Boolean(registration.active);
}
if ('serviceWorker' in navigator) prepareOffline().catch(() => {});
