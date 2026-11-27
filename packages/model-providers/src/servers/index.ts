import { lmStudio } from "../lmstudio/server.js";
import { mlxSupported } from "../mlx/helper.js";
import { mlx } from "../mlx/server.js";
import { ollama } from "../ollama/server.js";
import { type LocalServer, SERVER_IDS, type ServerId } from "./server.js";

export {
  fits,
  type InstalledModel,
  type LocalServer,
  SERVER_IDS,
  type ServerId,
  type ServerOptions,
  type ServerState,
  type ServerTrouble,
} from "./server.js";

/** The servers, by id. */
export const SERVERS: Record<ServerId, LocalServer> = { ollama, lmstudio: lmStudio, mlx };

/** The servers this computer can run at all: MLX needs a Mac with Apple silicon and the helper. */
export function serversHere(): ServerId[] {
  return SERVER_IDS.filter((id) => id !== "mlx" || mlxSupported());
}
