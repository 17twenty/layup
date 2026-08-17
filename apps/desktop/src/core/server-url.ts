/**
 * Turning what somebody typed into an address we can call.
 *
 * Shared by the screen that asks for it and the process that uses it: people
 * type "layup.example", and both sides must agree that this means
 * "https://layup.example" rather than one of them guessing.
 */
export function normaliseServerUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (trimmed === '') return '';
  // A scheme somebody typed is kept, so http://localhost:8787 still works.
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}
