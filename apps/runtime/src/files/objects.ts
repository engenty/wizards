import { randomBytes } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AwsClient } from "aws4fetch";
import { env } from "../env.js";
import { currentTenant } from "../tenants/tenant.js";

/**
 * Where bytes live: assets of runs, and blobs by hash (files/blobs.ts) for workspace and space
 * files. Every key sits under its tenant's prefix, so one tenant's files are exported or deleted
 * as one folder. The data folder holds them unless an S3-compatible bucket (R2) is configured.
 */
interface ObjectStore {
  put(key: string, data: Uint8Array): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  has(key: string): Promise<boolean>;
  remove(key: string): Promise<void>;
  removePrefix(prefix: string): Promise<void>;
  /** Throws when the store can't be reached (health.ts). */
  probe(): Promise<void>;
}

function fileStore(root: string): ObjectStore {
  const at = (key: string) => join(root, key);
  return {
    async put(key, data) {
      const path = at(key);
      await mkdir(dirname(path), { recursive: true });
      // Two writers of the same key (the same blob, at the same moment) each need their own.
      const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
      await writeFile(tmp, data);
      await rename(tmp, path);
    },
    get: (key) => readFile(at(key)).catch(() => null),
    has: async (key) => existsSync(at(key)),
    remove: (key) => rm(at(key), { force: true }),
    removePrefix: (prefix) => rm(at(prefix), { recursive: true, force: true }),
    async probe() {
      await mkdir(root, { recursive: true });
      await access(root, constants.W_OK);
    },
  };
}

function s3Store(): ObjectStore {
  const aws = new AwsClient({
    accessKeyId: env.s3.accessKeyId,
    secretAccessKey: env.s3.secretAccessKey,
    region: env.s3.region,
    service: "s3",
  });
  const base = `${env.s3.endpoint}/${env.s3.bucket}`;
  const url = (key: string) => `${base}/${key.split("/").map(encodeURIComponent).join("/")}`;
  const check = (res: Response, what: string) => {
    if (!res.ok) {
      throw new Error(`Object store ${what} failed: ${res.status}`);
    }
  };
  return {
    async put(key, data) {
      check(await aws.fetch(url(key), { method: "PUT", body: data as BodyInit }), "put");
    },
    async get(key) {
      const res = await aws.fetch(url(key));
      if (res.status === 404) {
        return null;
      }
      check(res, "get");
      return Buffer.from(await res.arrayBuffer());
    },
    async has(key) {
      return (await aws.fetch(url(key), { method: "HEAD" })).ok;
    },
    async remove(key) {
      check(await aws.fetch(url(key), { method: "DELETE" }), "delete");
    },
    async removePrefix(prefix) {
      for (let token: string | null = ""; token !== null; ) {
        const list = new URL(base);
        list.searchParams.set("list-type", "2");
        list.searchParams.set("prefix", prefix);
        if (token) {
          list.searchParams.set("continuation-token", token);
        }
        const res = await aws.fetch(list.toString());
        check(res, "list");
        const xml = await res.text();
        const keys = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
        await Promise.all(keys.map((key) => aws.fetch(url(key), { method: "DELETE" })));
        token = xml.match(/<NextContinuationToken>([^<]+)</)?.[1] ?? null;
      }
    },
    async probe() {
      // A key nobody writes: any answer below 500 (a 404 too) says the bucket is there.
      const res = await aws.fetch(url("health/probe"), { method: "HEAD" });
      if (res.status >= 500) {
        throw new Error(`Object store answered ${res.status}`);
      }
    },
  };
}

const store: ObjectStore =
  env.s3.endpoint && env.s3.bucket ? s3Store() : fileStore(join(env.dataDir, "objects"));

const tenantKey = (key: string) => `t/${currentTenant()}/${key}`;

export const objects = {
  put: (key: string, data: Uint8Array) => store.put(tenantKey(key), data),
  get: (key: string) => store.get(tenantKey(key)),
  has: (key: string) => store.has(tenantKey(key)),
  remove: (key: string) => store.remove(tenantKey(key)),
  removePrefix: (prefix: string) => store.removePrefix(tenantKey(prefix)),
};

/** Whether the store answers (health.ts). */
export const probeObjects = () => store.probe();

/** Deletes every file of a tenant. */
export function removeTenantObjects(tenantId: string) {
  return store.removePrefix(`t/${tenantId}/`);
}
