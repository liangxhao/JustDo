export type OutboundHeaderPolicyGroup = {
  baseUrlWhitelist: readonly string[];
  headerNames: readonly string[];
};

export type OutboundHeaderPolicyConfig = {
  enabled: boolean;
  groups: readonly OutboundHeaderPolicyGroup[];
};

/** Safe on-disk replacement for an invalid user policy. */
export const DEFAULT_OUTBOUND_HEADER_POLICY_CONFIG: OutboundHeaderPolicyConfig = Object.freeze({
  enabled: true,
  groups: Object.freeze([]),
});

/** Built-in mappings stay in code and are never written to config.json. */
export const PREDEFINED_OUTBOUND_HEADER_POLICY_CONFIG: OutboundHeaderPolicyConfig = Object.freeze({
  enabled: true,
  groups: Object.freeze([
    Object.freeze({
      baseUrlWhitelist: Object.freeze([]),
      headerNames: Object.freeze(['X-User-Account', 'X-Cookie']),
    }),
  ]),
});
