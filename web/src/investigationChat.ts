const chatStorageKey = 'warroom.investigate.chat.v1';
function chatStorage() {
  try {
    return sessionStorage;
  } catch {
    return undefined;
  }
}
/** A reload keeps the budget identity; only Reset chat starts a new identity. */
export function newInvestigationChatID(storage: Storage | undefined = chatStorage()) {
  const id = crypto.randomUUID();
  try {
    storage?.setItem(chatStorageKey, id);
  } catch {}
  return id;
}
export function restoreInvestigationChatID(storage: Storage | undefined = chatStorage()) {
  try {
    const id = storage?.getItem(chatStorageKey);
    if (id && /^[A-Za-z0-9_-]{1,100}$/.test(id)) return id;
  } catch {}
  return newInvestigationChatID(storage);
}
