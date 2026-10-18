import { BUILTIN_CONNECTORS } from "../../connectors/builtin.js";
import type {
  ConnectorActionContext,
  ConnectorDefinition,
} from "../../engenty/connections-sdk/types.js";
import { line, ShareError, type ShareFile, type ShareTarget } from "../types.js";

/** Puts files into a folder of the connected account; answers with a link to open, if there is one. */
type Upload = (
  ctx: ConnectorActionContext,
  folder: string,
  files: ShareFile[],
  each: (file: ShareFile) => Promise<void>,
) => Promise<string | null>;

async function call(ctx: ConnectorActionContext, url: string, init: RequestInit = {}) {
  const res = await ctx.fetchImpl(url, {
    ...init,
    headers: { Authorization: `Bearer ${ctx.accessToken}`, ...init.headers },
  });
  if (!res.ok) {
    throw new Error(
      `${new URL(url).hostname} (${res.status}): ${(await res.text()).slice(0, 200)}`,
    );
  }
  return res;
}

const segments = (folder: string) =>
  folder
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);

// --- Google Drive -----------------------------------------------------------------
// With the scope `drive.file` the wizard sees only what it created itself: its folders are
// found again by name, and nothing else in the Drive is readable.

const DRIVE = "https://www.googleapis.com/drive/v3/files";
const DRIVE_FOLDER = "application/vnd.google-apps.folder";

async function driveFolder(ctx: ConnectorActionContext, name: string, parent: string | null) {
  const q = [
    `name = '${name.replace(/['\\]/g, "\\$&")}'`,
    `mimeType = '${DRIVE_FOLDER}'`,
    "trashed = false",
    `'${parent ?? "root"}' in parents`,
  ].join(" and ");
  const found = (await (
    await call(ctx, `${DRIVE}?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1`)
  ).json()) as { files?: { id: string }[] };
  if (found.files?.[0]) {
    return found.files[0].id;
  }
  const created = (await (
    await call(ctx, `${DRIVE}?fields=id`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        mimeType: DRIVE_FOLDER,
        ...(parent ? { parents: [parent] } : {}),
      }),
    })
  ).json()) as { id: string };
  return created.id;
}

const driveUpload: Upload = async (ctx, folder, files, each) => {
  let parent: string | null = null;
  for (const name of segments(folder)) {
    parent = await driveFolder(ctx, name, parent);
  }
  let link: string | null = parent ? `https://drive.google.com/drive/folders/${parent}` : null;
  for (const file of files) {
    await each(file);
    const boundary = `wz${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    const meta = JSON.stringify({ name: file.name, ...(parent ? { parents: [parent] } : {}) });
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${file.mime}\r\n\r\n`,
      ),
      Buffer.from(file.data),
      Buffer.from(`\r\n--${boundary}--`),
    ]);
    const made = (await (
      await call(
        ctx,
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink",
        {
          method: "POST",
          headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
          body: new Uint8Array(body),
        },
      )
    ).json()) as { webViewLink?: string };
    link ??= made.webViewLink ?? null;
  }
  return link;
};

// --- OneDrive -----------------------------------------------------------------------

const GRAPH = "https://graph.microsoft.com/v1.0/me/drive";

const oneDriveUpload: Upload = async (ctx, folder, files, each) => {
  const path = segments(folder).map(encodeURIComponent).join("/");
  let link: string | null = null;
  for (const file of files) {
    await each(file);
    const at = [path, encodeURIComponent(file.name)].filter(Boolean).join("/");
    const item = (await (
      await call(ctx, `${GRAPH}/root:/${at}:/content`, {
        method: "PUT",
        headers: { "Content-Type": file.mime },
        body: new Uint8Array(file.data),
      })
    ).json()) as { webUrl?: string };
    link ??= item.webUrl ?? null;
  }
  if (path) {
    const dir = await call(ctx, `${GRAPH}/root:/${path}`).then(
      (res) => res.json() as Promise<{ webUrl?: string }>,
      () => null,
    );
    link = dir?.webUrl ?? link;
  }
  return link;
};

const UPLOADS: Record<string, Upload> = {
  "google-drive": driveUpload,
  "microsoft-onedrive": oneDriveUpload,
};

/** The action whose provider rights an upload needs, per connector. */
const UPLOAD_ACTION: Record<string, string> = {
  "google-drive": "create_file",
  "microsoft-onedrive": "upload_file",
};

/** A connector that says itself how files are written into it (S3). */
function capabilityUpload(connector: ConnectorDefinition): Upload | null {
  const storage = connector.storage;
  if (!storage) {
    return null;
  }
  return async (ctx, folder, files, each) => {
    let link: string | null = null;
    for (const file of files) {
      await each(file);
      const entry = await storage.write(ctx, {
        folder_ref: segments(folder).join("/") || null,
        name: file.name,
        mime_type: file.mime,
        content_base64: Buffer.from(file.data).toString("base64"),
      });
      link ??= entry.web_url ?? null;
    }
    return link;
  };
}

/** The connectors files can be saved into: `storage:<id>` is a share target for each. */
export function storageConnectors(): ConnectorDefinition[] {
  return BUILTIN_CONNECTORS.filter((c) => UPLOADS[c.id] || c.storage);
}

/** The picked files, saved into a folder of the person's cloud storage. */
export function storageTarget(connector: ConnectorDefinition): ShareTarget | null {
  const upload = UPLOADS[connector.id] ?? capabilityUpload(connector);
  if (!upload) {
    return null;
  }
  const id = `storage:${connector.id}`;
  return {
    id,
    name: connector.name,
    description: line("shareStorageDescription"),
    icon: "folder",
    takes: "files",
    needsFiles: true,
    connection: () => ({
      id: `share:${id}`,
      target: { connectors: [connector.id] },
      actions: UPLOAD_ACTION[connector.id] ? [UPLOAD_ACTION[connector.id]] : ["files_write"],
      title: connector.name,
    }),
    fields: [
      {
        id: "folder",
        kind: "text",
        label: line("shareFolder"),
        placeholder: line("shareFolderPlaceholder"),
        help: line("shareFolderHelp"),
      },
    ],
    defaults: (scope) => ({ folder: scope.run.definition.title.replace(/\//g, "-") }),
    async send({ values, files }, ctx) {
      const account = await ctx.account();
      if (!account) {
        throw new ShareError(line("shareConnectFirst", { name: connector.name }));
      }
      const folder = (values.folder ?? "").trim();
      const link = await upload(account.ctx, folder, files, (file) =>
        ctx.emit(line("shareUploading", { name: file.name })),
      );
      const where = [connector.name, folder].filter(Boolean).join(" › ");
      return { summary: line("shareSavedFiles", { count: files.length, where }), url: link };
    },
  };
}
