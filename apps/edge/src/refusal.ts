/** An event or a call the object does not take, with the status its answer carries. */
export class Refusal extends Error {
  constructor(
    readonly status: 400 | 401 | 404 | 409 | 422,
    message: string,
    /** The page's fields that were not accepted (422). */
    readonly fields?: unknown,
  ) {
    super(message);
    this.name = "Refusal";
  }
}
