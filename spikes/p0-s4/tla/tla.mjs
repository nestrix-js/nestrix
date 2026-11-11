// Deliberately contains a top-level await. Only the spike's demo requires this.
export const value = await Promise.resolve(42);
