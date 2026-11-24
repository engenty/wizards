# @engenty/chatviews

Views in a chat and in a wizard. MIT.

- `@engenty/chatviews/surface`: a surface, a flat list of components from the catalog with ids and a
  `root`, bound to data by JSON pointer (`{ "path": "/days" }`) or a calculation
  (`{ "calc": "demo / budget" }`); `validateSurface` checks one, `bound` reads a prop.
- `@engenty/chatviews/calc`: the calc language, parsed and worked out the same in the browser and
  on the server, never with `eval`.
- `@engenty/chatviews/shape`: the shapes of data a surface reads (the subset of JSON Schema a
  wizard's output takes).
- `@engenty/chatviews/numbers`: numbers as people type them.
