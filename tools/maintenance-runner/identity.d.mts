/** Types for `identity.mjs`. See the note at the top of `jobs.d.mts`. */

export interface RunnerIdentity {
  readonly deviceId: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly publicKeyBase64: string;
  readonly privateKeyBase64: string;
  readonly pairedAt: string;
}

export function stateRoot(): string;

/** Throws if the resolved path would fall inside `repoRoot`. */
export function identityPath(repoRoot?: string): string;

export function generateIdentityMaterial(): Promise<{
  readonly publicKeyBase64: string;
  readonly privateKeyBase64: string;
}>;

export function loadIdentity(repoRoot?: string): RunnerIdentity | null;

export function saveIdentity(identity: RunnerIdentity, repoRoot?: string): string;

export function signingKey(identity: RunnerIdentity): Promise<CryptoKey>;

export function signRequest(
  identity: RunnerIdentity,
  request: { method: string; path: string; body?: string },
): Promise<Record<string, string>>;
