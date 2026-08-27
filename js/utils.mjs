export const $ = selector => document.querySelector(selector);

export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  })[character]);
}

export function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

export function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!bytes) return '';
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1).replace('.', ',')} GB`;
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} kB`;
}

export const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export async function jsonResponse(response) {
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(`Servern svarade inte korrekt (HTTP ${response.status})`);
  }
  if (!response.ok) throw new Error(data.error || data.message || `Serverfel ${response.status}`);
  return data;
}
