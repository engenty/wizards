import { NotedError } from "../model-errors.js";
/** A store refused: a list is full, a path is not one, a row is there already. */
export class StoreError extends NotedError {}
