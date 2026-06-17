export const AGENTS_UPDATED_EVENT = 'ghostbroker:agents-updated';

export function dispatchAgentsUpdated(): void {
  window.dispatchEvent(new CustomEvent(AGENTS_UPDATED_EVENT));
}
