/** An explicit refusal: invalid input, an unsupported case, or a numerical precondition that does not hold. */
export class WaveBenchError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WaveBenchError";
    this.code = code;
  }
}

export function assertPositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new WaveBenchError("INVALID_ARGUMENT", `${name} must be finite and greater than zero (got ${value})`);
  }
}

export function assertFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new WaveBenchError("INVALID_ARGUMENT", `${name} must be finite (got ${value})`);
}

export function assertInteger(value: number, minimum: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new WaveBenchError("INVALID_ARGUMENT", `${name} must be an integer >= ${minimum} (got ${value})`);
  }
}
