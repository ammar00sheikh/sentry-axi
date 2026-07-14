import { describe, expect, it, vi } from "vitest";
import {
  createDeploy,
  createRelease,
  finalizeRelease,
  getReleaseCommits,
  getSuspectCommits,
  listDeploys,
  listReleases,
  validateVersion,
} from "../src/releases.js";
import type { SentryApi } from "../src/api.js";

/** A stand-in SentryApi: records the calls, returns a canned body. */
function fakeApi(body: unknown = []) {
  const request = vi.fn(async () => body);
  return {
    api: { org: "acme", project: "frontend", request } as unknown as SentryApi,
    request,
  };
}

describe("validateVersion", () => {
  it("accepts the opaque strings Sentry actually uses", () => {
    expect(validateVersion("4.2.1")).toBe("4.2.1");
    expect(validateVersion("  4.2.1  ")).toBe("4.2.1");
    expect(validateVersion("a1b2c3d4e5f6")).toBe("a1b2c3d4e5f6");
    expect(validateVersion("my-app@1.0.0+build.7")).toBe(
      "my-app@1.0.0+build.7",
    );
  });

  // A slash would be path-encoded into the URL and silently address a different
  // endpoint, so it is rejected up front rather than producing a baffling 404.
  it("rejects slashes and empty versions with a suggestion", () => {
    for (const bad of ["", "   ", "feature/branch", "a\\b"]) {
      const error = (() => {
        try {
          validateVersion(bad);
        } catch (e) {
          return e as { code: string; suggestions: string[] };
        }
      })();

      expect(error?.code).toBe("VALIDATION_ERROR");
      expect(error?.suggestions.length).toBeGreaterThan(0);
    }
  });
});

describe("listReleases", () => {
  it("paginates the org releases endpoint", async () => {
    const { api, request } = fakeApi([{ version: "4.2.0" }]);

    const releases = await listReleases(api, 20);

    expect(request).toHaveBeenCalledWith(
      "/organizations/acme/releases/",
      expect.objectContaining({ paginate: true, limit: 20 }),
    );
    expect(releases).toEqual([{ version: "4.2.0" }]);
  });
});

describe("createRelease", () => {
  // Sentry's release POST is an upsert, so re-creating an existing release
  // updates it rather than failing. That is what makes the command safe to
  // retry, which is the AXI contract for every mutation.
  it("POSTs the version and projects, and is safe to repeat", async () => {
    const { api, request } = fakeApi({ version: "4.2.1" });

    await createRelease(api, {
      version: "4.2.1",
      projects: ["frontend"],
      ref: "abc123",
    });

    expect(request).toHaveBeenCalledWith("/organizations/acme/releases/", {
      method: "POST",
      body: { version: "4.2.1", projects: ["frontend"], ref: "abc123" },
    });
  });

  it("validates the version before spending a request", async () => {
    const { api, request } = fakeApi();

    await expect(
      createRelease(api, { version: "feature/x", projects: ["frontend"] }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    expect(request).not.toHaveBeenCalled();
  });

  it("omits optional fields rather than sending undefined", async () => {
    const { api, request } = fakeApi({ version: "4.2.1" });

    await createRelease(api, { version: "4.2.1", projects: ["frontend"] });

    expect(request.mock.calls[0][1].body).toEqual({
      version: "4.2.1",
      projects: ["frontend"],
    });
  });
});

describe("finalizeRelease", () => {
  it("PUTs a dateReleased timestamp", async () => {
    const { api, request } = fakeApi({ version: "4.2.1" });

    await finalizeRelease(api, "4.2.1");

    const [path, options] = request.mock.calls[0];
    expect(path).toBe("/organizations/acme/releases/4.2.1/");
    expect(options.method).toBe("PUT");
    expect(typeof options.body.dateReleased).toBe("string");
  });

  it("URL-encodes a version with characters that need it", async () => {
    const { api, request } = fakeApi({ version: "app@1.0" });

    await finalizeRelease(api, "app@1.0");

    expect(request.mock.calls[0][0]).toBe(
      "/organizations/acme/releases/app%401.0/",
    );
  });
});

describe("createDeploy", () => {
  it("POSTs the environment to the release's deploys endpoint", async () => {
    const { api, request } = fakeApi({ environment: "production" });

    await createDeploy(api, "4.2.1", "production", "canary");

    const [path, options] = request.mock.calls[0];
    expect(path).toBe("/organizations/acme/releases/4.2.1/deploys/");
    expect(options.method).toBe("POST");
    expect(options.body.environment).toBe("production");
    expect(options.body.name).toBe("canary");
  });
});

describe("listDeploys / getReleaseCommits", () => {
  it("paginate their endpoints", async () => {
    const { api, request } = fakeApi([]);

    await listDeploys(api, "4.2.1");
    await getReleaseCommits(api, "4.2.1");

    expect(request.mock.calls[0][0]).toBe(
      "/organizations/acme/releases/4.2.1/deploys/",
    );
    expect(request.mock.calls[1][0]).toBe(
      "/organizations/acme/releases/4.2.1/commits/",
    );
  });
});

describe("getSuspectCommits", () => {
  // Sentry nests commits one level down, under each committer. Flattening it
  // wrong means the agent is told there are no suspect commits when there are -
  // and suspect commits are the highest-signal thing Sentry knows.
  it("flattens the committers -> commits nesting and keeps each author", async () => {
    const { api } = fakeApi({
      committers: [
        {
          author: { name: "Alice", email: "alice@acme.com" },
          commits: [
            { id: "abc1234567", message: "fix: guard user\n\nlong body" },
            { id: "def4567890", message: "refactor cards" },
          ],
        },
        {
          author: { name: "Bob", email: "bob@acme.com" },
          commits: [{ id: "aaa1111111", message: "add profile route" }],
        },
      ],
    });

    const suspects = await getSuspectCommits(api, "4509");

    expect(suspects).toHaveLength(3);
    expect(suspects[0].commit.id).toBe("abc1234567");
    expect(suspects[0].author?.email).toBe("alice@acme.com");
    expect(suspects[2].author?.email).toBe("bob@acme.com");
  });

  it("returns empty when Sentry has no committers for the issue", async () => {
    const { api } = fakeApi({ committers: [] });
    expect(await getSuspectCommits(api, "4509")).toEqual([]);
  });

  it("survives a response with no committers key at all", async () => {
    const { api } = fakeApi({});
    expect(await getSuspectCommits(api, "4509")).toEqual([]);
  });
});
