/**
 * Whether the signed-in user may change things (create, edit, delete, test). Every write button on
 * the Alerts page sits behind this one helper. Today every signed-in standalone user is an admin,
 * so it is always true; the role work (issue #34) wires it to the session's role here and nowhere
 * else. The server refuses a write from anyone else regardless: this only hides the controls.
 */
export function useCanAdmin(): boolean {
  return true;
}
