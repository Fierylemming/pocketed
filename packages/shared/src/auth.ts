// Password rules + recovery-key generation, shared by web and mobile.

export const PASSWORD_MIN = 8;

export function passwordError(p: string): string | null {
  if (p.length < PASSWORD_MIN) return "Password needs at least 8 characters.";
  if (p.includes(",")) return "Password can't contain a comma.";
  return null;
}

/** e.g. "a1b2-c3d4-e5f6" — written down once by the owner, used only for resets. */
export function genRecovery(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const hex = [...bytes]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return (hex.match(/.{4}/g) as string[]).join("-");
}
