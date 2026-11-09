export interface PathVerdict {
  detail: string;
}

const rules: [RegExp, string][] = [
  [/(?:^|\/)\.env(?:\.[^/]+)?$/i, "environment file"],
  [/\.pem$/i, "private key or certificate"],
  [/\.key$/i, "key file"],
  [/\.p12$/i, "key store"],
  [/(?:^|\/)auth\.json$/i, "credentials file"],
  [/(?:^|\/)wp-config\.php$/i, "WordPress config with credentials"],
  [/\.sql\.gz$/i, "database dump"],
  [/\.sql$/i, "database dump"],
  [/\.log$/i, "log file"],
  [/(?:^|\/)wp-content\/uploads\//i, "WordPress uploads"],
];

/** Safe to commit because it documents variable names with placeholder values. */
const exempt = /(?:^|\/)\.env\.example$/i;

export function sensitivePath(path: string): PathVerdict | null {
  if (exempt.test(path)) return null;
  for (const [pattern, detail] of rules) {
    if (pattern.test(path)) return { detail };
  }
  return null;
}

/** Lockfiles and bundles hold long hashes that would drown the entropy check in false alarms. */
export function skipsEntropy(path: string): boolean {
  return /(?:-lock\.json|\.lock|-lock\.ya?ml|\.min\.[cm]?js|\.map|\.svg)$/i.test(path);
}
