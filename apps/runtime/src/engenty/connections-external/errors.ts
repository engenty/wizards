/**
 * Import-time rejection. Routes answer 422 for this and 502 for everything
 * else, so anything an admin can fix by choosing a different source, filling a
 * field, or picking another surface must be raised as this error.
 */
export class ImportValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportValidationError";
  }
}

/** The registry answered a request with an error status: 404 when it doesn't list the domain. */
export class RegistryRequestError extends Error {
  constructor(
    readonly status: number,
    url: string,
  ) {
    super(`registry request failed (${status}): ${url}`);
    this.name = "RegistryRequestError";
  }
}
