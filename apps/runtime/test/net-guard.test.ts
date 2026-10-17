import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";

// Names resolve here, not on the network; a name can answer differently on each lookup.
const dns = vi.hoisted(() => ({ answers: new Map<string, string[]>(), calls: 0 }));
vi.mock("node:dns/promises", () => ({
  lookup: async (host: string) => {
    dns.calls++;
    const list = dns.answers.get(host);
    const address = list && (list.length > 1 ? list.shift()! : list[0]);
    if (!address) {
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    }
    return [{ address, family: address.includes(":") ? 6 : 4 }];
  },
}));

const { assertPublicUrl, isPublicAddress, safeFetch } = await import("../src/tools/net-guard");
const { assertPublicHttpHost } = await import("../src/engenty/shims/web-ingest");

describe("isPublicAddress", () => {
  it("refuses this server's networks and special ranges", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "169.254.169.254", // cloud metadata
      "172.30.5.10", // the browser's DevTools
      "192.168.1.1",
      "100.64.0.1",
      "0.0.0.0",
      "192.0.0.170",
      "198.18.0.1",
      "198.19.255.255",
      "224.0.0.1",
      "239.255.255.250",
      "240.0.0.1",
      "255.255.255.255",
      "::",
      "::1",
      "fd00::1",
      "fe80::1",
      "fe80::1%eth0",
      "ff02::1",
      "2001:db8::1",
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });

  it("refuses IPv6 addresses that stand for a private IPv4 address", () => {
    for (const ip of [
      "::ffff:169.254.169.254",
      "::ffff:a9fe:a9fe", // the same, as URL parsing writes it
      "[::ffff:a9fe:a9fe]",
      "0:0:0:0:0:ffff:ac1e:050a", // 172.30.5.10
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:0:a9fe:a9fe",
      "::a9fe:a9fe",
      "::127.0.0.1",
      "64:ff9b::a9fe:a9fe", // NAT64
      "64:ff9b::10.0.0.1",
      "64:ff9b:1::1",
      "2002:a9fe:a9fe::1", // 6to4
      "2002:7f00:1::",
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });

  it("allows public addresses", () => {
    for (const ip of [
      "8.8.8.8",
      "1.1.1.1",
      "93.184.215.14",
      "172.32.0.1",
      "198.20.0.1",
      "2606:4700:4700::1111",
      "2a00:1450:4001:80b::200e",
      "::ffff:8.8.8.8",
      "::ffff:808:808",
      "64:ff9b::808:808",
      "2002:808:808::1",
    ]) {
      expect(isPublicAddress(ip), ip).toBe(true);
    }
  });

  it("is not fooled by things that are not addresses", () => {
    expect(isPublicAddress("example.com")).toBe(false);
    expect(isPublicAddress("")).toBe(false);
  });
});

describe("assertPublicUrl", () => {
  it("refuses private hosts however they are written", async () => {
    for (const url of [
      "http://[::ffff:169.254.169.254]/latest/meta-data/",
      "http://[::ffff:a9fe:a9fe]/",
      "http://[0:0:0:0:0:ffff:ac1e:50a]:9222/json",
      "http://[64:ff9b::a9fe:a9fe]/",
      "http://172.30.5.10:9222/json/version",
      "http://0x7f.1/",
      "http://198.18.0.1/",
      "http://localhost:24368/",
    ]) {
      await expect(assertPublicUrl(url), url).rejects.toThrow(/Private addresses/);
    }
  });

  it("refuses a name with any private address", async () => {
    dns.answers.set("mapped.test", ["::ffff:10.0.0.1"]);
    await expect(assertPublicUrl("https://mapped.test/")).rejects.toThrow(/Private addresses/);
  });

  it("allows public hosts", async () => {
    dns.answers.set("public.test", ["93.184.215.14"]);
    await expect(assertPublicUrl("https://public.test/a")).resolves.toBeInstanceOf(URL);
    await expect(assertPublicUrl("http://8.8.8.8/")).resolves.toBeInstanceOf(URL);
  });

  it("refuses other schemes", async () => {
    await expect(assertPublicUrl("file:///etc/passwd")).rejects.toThrow(/http and https/);
  });
});

describe("safeFetch", () => {
  it("connects only to the address it checked, so a name cannot rebind to the server", async () => {
    const server = createServer((_req, res) => res.end("internal"));
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const { port } = server.address() as AddressInfo;
    try {
      // Public for the check, loopback a moment later for the connection.
      dns.answers.set("rebind.test", ["93.184.215.14", "127.0.0.1"]);
      const before = dns.calls;
      const err = await safeFetch(`http://rebind.test:${port}/`).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(String(err.cause?.message ?? err.message)).toMatch(/Private addresses/);
      expect(dns.calls - before).toBe(2);
    } finally {
      server.close();
    }
  });
});

describe("connector guard", () => {
  it("refuses NAT64 and 6to4 addresses the copied guard lets through", async () => {
    const lookup = async () => [{ address: "64:ff9b::a9fe:a9fe", family: 6 }];
    await expect(assertPublicHttpHost("https://nat64.test/", lookup)).rejects.toThrow(/not allowed/);
    await expect(assertPublicHttpHost("http://[2002:a9fe:a9fe::1]/")).rejects.toThrow(/not allowed/);
    await expect(
      assertPublicHttpHost("https://ok.test/", async () => [{ address: "8.8.8.8", family: 4 }]),
    ).resolves.toMatchObject({ addresses: ["8.8.8.8"] });
  });
});
