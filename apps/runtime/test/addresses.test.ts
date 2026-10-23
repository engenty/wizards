import { describe, expect, it } from "vitest";
import { addressKind, addressUrl, organizationDomain } from "@engenty/wizards-shared/addresses";

describe("addresses on the web", () => {
  it("tells a profile, a blog and a website apart", () => {
    expect(addressKind("instagram.com/baeckerei.huber")).toBe("instagram");
    expect(addressKind("https://www.linkedin.com/company/stb-fuchs")).toBe("linkedin");
    expect(addressKind("https://twitter.com/neo")).toBe("x");
    expect(addressKind("blog.baeckerei-huber.at")).toBe("blog");
    expect(addressKind("baeckerei-huber.at")).toBe("website");
  });

  it("makes a full address, and refuses what is none", () => {
    expect(addressUrl("baeckerei-huber.at")).toBe("https://baeckerei-huber.at/");
    expect(addressUrl("Bäckerei Huber")).toBeNull();
    expect(addressUrl("huber")).toBeNull();
  });

  it("names an organization's e-mail domain, not free mail", () => {
    expect(organizationDomain("neo@baeckerei-huber.at")).toBe("baeckerei-huber.at");
    expect(organizationDomain("neo.huber@gmail.com")).toBeNull();
  });
});
