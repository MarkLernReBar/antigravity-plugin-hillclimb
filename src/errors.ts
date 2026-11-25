export class HillClimbError extends Error {
  readonly code: string;
  readonly hint?: string;

  constructor(message: string, options?: { code?: string; hint?: string }) {
    super(message);
    this.name = "HillClimbError";
    this.code = options?.code ?? "hillclimb_error";
    this.hint = options?.hint;
  }
}
