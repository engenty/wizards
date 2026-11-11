/** An event the host does not take, with the status the loopback answers it with. */
export class HostRefusal extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 422,
    message: string,
    /** A page's fields that were not accepted (status 422). */
    readonly fields?: unknown,
  ) {
    super(message);
    this.name = "HostRefusal";
  }
}
