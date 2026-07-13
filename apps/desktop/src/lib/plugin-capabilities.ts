const AI_CAPABILITY_KINDS = new Set(['llm.chat', 'image.generate']);

export function isAiCapability(kind: unknown): kind is 'llm.chat' | 'image.generate' {
  return typeof kind === 'string' && AI_CAPABILITY_KINDS.has(kind);
}

export function capabilityRequiresAdmin(kind: unknown, value: unknown): boolean {
  return isAiCapability(kind) ? false : value === true;
}

export function normalizeAiCapabilityAdmin<T extends { kind: unknown; requires_admin?: boolean }>(
  capability: T,
): T & { requires_admin: boolean } {
  return {
    ...capability,
    requires_admin: capabilityRequiresAdmin(capability.kind, capability.requires_admin),
  };
}
