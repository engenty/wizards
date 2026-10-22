import { prompt } from "../prompts.js";

/**
 * What engenty wizards is, on one page, in every turn of the studio assistant: the section
 * `primer` of prompts/goose.md.
 */
export const primer = (): string => prompt("goose", "primer");
